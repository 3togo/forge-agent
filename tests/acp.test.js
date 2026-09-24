'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const AcpServer = require('../src/acp-server');
const { descendants, identity } = require('../src/acp-process');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const root = path.resolve(__dirname, '..');

async function until(check) {
  for (let i = 0; i < 100; i++) { if (check()) return; await delay(50); }
  throw new Error('Timed out waiting for event');
}

describe('ACP wire handshake', () => {
  test('official SDK client completes a prompt, approval, tool diff and final message', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-acp-wire-'));
    try {
      const result = spawnSync(process.execPath, [path.join(__dirname, 'fixtures/acp-wire-client.mjs'), temp], { encoding: 'utf8', timeout: 10000 });
      expect(result.stderr.replace(/\[forge-acp\].*\n/g, '')).toBe('');
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('SDK_ROUND_TRIP_OK');
      expect(fs.readFileSync(path.join(temp, 'proof.txt'), 'utf8')).toBe('ACP verified\n');
    } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  });
  test('real agent loop delivers a plain Chinese provider reply through SDK before ending the turn', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-acp-conversation-'));
    try {
      const result = spawnSync(process.execPath, [path.join(__dirname, 'fixtures/acp-conversation-client.mjs'), temp], { encoding: 'utf8', timeout: 10000 });
      expect(result.stderr.replace(/\[forge-acp\].*\n/g, '')).toBe('');
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('CONVERSATION_DELIVERED_ONCE');
    } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  });
  test.each(['src/acp-entry.js', 'src/index.js'])('%s emits only ACP JSON', entry => {
    const input = [
      { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } },
      { jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd: root, mcpServers: [] } },
    ].map(x => JSON.stringify(x)).join('\n') + '\n';
    const result = spawnSync(process.execPath, [path.join(root, entry), '--acp', '--model=doubao'], { input, encoding: 'utf8', timeout: 5000 });
    expect(result.status).toBe(0);
    const messages = result.stdout.trim().split('\n').map(line => JSON.parse(line));
    expect(messages).toHaveLength(2);
    expect(messages.find(x => x.id === 0).result).toMatchObject({ protocolVersion: 1, agentCapabilities: { loadSession: false } });
    expect(messages.find(x => x.id === 1).result.sessionId).toBeTruthy();
  });
});

describe('ACP worker lifecycle', () => {
  let temp, server, conn, sid, updates;
  beforeEach(async () => {
    temp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-acp-test-'));
    updates = [];
    conn = {
      sessionUpdate: jest.fn(async event => updates.push(event.update)),
      requestPermission: jest.fn(async () => ({ outcome: { outcome: 'selected', optionId: 'allow' } })),
    };
    server = new AcpServer(conn, { model: 'doubao', workerFile: path.join(__dirname, 'fixtures/acp-worker.cjs'), sessionDir: path.join(temp, 'browser'), permissionStateDir: path.join(temp, 'permissions') });
    server.initialize();
    sid = (await server.newSession({ cwd: temp, mcpServers: [] })).sessionId;
  });
  afterEach(async () => { await server.close(); fs.rmSync(temp, { recursive: true, force: true }); });
  const prompt = (sessionId, text) => ({ sessionId, prompt: [{ type: 'text', text }] });

  test('binds the worker to the selected workspace and returns end_turn', async () => {
    expect(await server.prompt(prompt(sid, 'cwd'))).toEqual({ stopReason: 'end_turn' });
    expect(updates.some(x => x.content?.text === temp)).toBe(true);
  });
  test('allows absolute Unix paths but still rejects actual terminal slash commands', async () => {
    const absolutePath = '/home/polin/gitee/j_bin/bin';
    expect(await server.prompt(prompt(sid, absolutePath))).toEqual({ stopReason: 'end_turn' });
    expect(updates.some(x => x.content?.text === absolutePath)).toBe(true);
    await expect(server.prompt(prompt(sid, '/help'))).rejects.toThrow('Terminal slash commands');
    await expect(server.prompt(prompt(sid, '/model yuanbao'))).rejects.toThrow('Terminal slash commands');
  });
  test('chat approval skips later writes but expires in a new chat', async () => {
    conn.requestPermission.mockResolvedValue({ outcome: { outcome: 'selected', optionId: 'project-chat' } });
    await server.prompt(prompt(sid, 'write'));
    await server.prompt(prompt(sid, 'write'));
    expect(conn.requestPermission).toHaveBeenCalledTimes(1);
    expect(conn.requestPermission.mock.calls[0][0].options.map(o => o.optionId)).toEqual(['allow', 'project-chat', 'project-always', 'deny']);
    await server.close();
    server = new AcpServer(conn, { workerFile: path.join(__dirname, 'fixtures/acp-worker.cjs'), permissionStateDir: path.join(temp, 'permissions') });
    server.initialize(); sid = (await server.newSession({ cwd: temp })).sessionId;
    await server.prompt(prompt(sid, 'write'));
    expect(conn.requestPermission).toHaveBeenCalledTimes(2);
  });
  test('file-write approval persists for this project, but excludes shell commands and other projects', async () => {
    conn.requestPermission.mockResolvedValue({ outcome: { outcome: 'selected', optionId: 'project-always' } });
    await server.prompt(prompt(sid, 'write'));
    const directory = path.join(temp, 'permissions');
    const record = path.join(directory, fs.readdirSync(directory)[0]);
    expect(fs.statSync(record).mode & 0o777).toBe(0o600);
    await server.close();
    server = new AcpServer(conn, { workerFile: path.join(__dirname, 'fixtures/acp-worker.cjs'), permissionStateDir: directory });
    server.initialize(); sid = (await server.newSession({ cwd: temp })).sessionId;
    conn.requestPermission.mockClear();
    await server.prompt(prompt(sid, 'write'));
    expect(conn.requestPermission).not.toHaveBeenCalled();
    conn.requestPermission.mockResolvedValue({ outcome: { outcome: 'selected', optionId: 'deny' } });
    await server.prompt(prompt(sid, 'test'));
    expect(conn.requestPermission).toHaveBeenCalledTimes(1);
    expect(conn.requestPermission.mock.calls[0][0].options.map(o => o.optionId)).toEqual(['allow', 'project-chat', 'project-always', 'deny']);
    expect(updates.some(u => u.content?.text?.includes('Permission declined'))).toBe(true);
    const other = path.join(temp, 'other'); fs.mkdirSync(other);
    const next = (await server.newSession({ cwd: other })).sessionId;
    conn.requestPermission.mockResolvedValue({ outcome: { outcome: 'cancelled' } });
    await server.prompt(prompt(next, 'write'));
    expect(conn.requestPermission).toHaveBeenCalledTimes(2);
    expect(fs.existsSync(path.join(other, 'proof.txt'))).toBe(false);
  });
  test('shell approval can cover this chat or persist for this project', async () => {
    conn.requestPermission.mockResolvedValue({ outcome: { outcome: 'selected', optionId: 'project-chat' } });
    await server.prompt(prompt(sid, 'list'));
    await server.prompt(prompt(sid, 'list'));
    expect(conn.requestPermission).toHaveBeenCalledTimes(1);
    expect(conn.requestPermission.mock.calls[0][0].options.map(o => o.name)).toEqual([
      'Allow once', 'Allow shell commands for this chat',
      'Allow always: shell commands in this project', 'Decline',
    ]);

    await server.close();
    server = new AcpServer(conn, { workerFile: path.join(__dirname, 'fixtures/acp-worker.cjs'), permissionStateDir: path.join(temp, 'permissions') });
    server.initialize(); sid = (await server.newSession({ cwd: temp })).sessionId;
    conn.requestPermission.mockResolvedValue({ outcome: { outcome: 'selected', optionId: 'project-always' } });
    await server.prompt(prompt(sid, 'list'));
    await server.close();

    server = new AcpServer(conn, { workerFile: path.join(__dirname, 'fixtures/acp-worker.cjs'), permissionStateDir: path.join(temp, 'permissions') });
    server.initialize(); sid = (await server.newSession({ cwd: temp })).sessionId;
    conn.requestPermission.mockClear();
    await server.prompt(prompt(sid, 'list'));
    expect(conn.requestPermission).not.toHaveBeenCalled();
  });
  test('project approval still rejects paths outside the workspace', async () => {
    conn.requestPermission.mockResolvedValue({ outcome: { outcome: 'selected', optionId: 'project-chat' } });
    await server.prompt(prompt(sid, 'write'));
    await expect(server.prompt(prompt(sid, 'escape'))).rejects.toThrow('outside');
    expect(conn.requestPermission).toHaveBeenCalledTimes(1);
  });
  test('approved write reports a diff and preserves output', async () => {
    expect(await server.prompt(prompt(sid, 'write'))).toEqual({ stopReason: 'end_turn' });
    expect(conn.requestPermission).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(path.join(temp, 'proof.txt'), 'utf8')).toBe('ACP verified\n');
    expect(updates.some(x => x.content?.some?.(c => c.type === 'diff' && c.oldText === null && c.newText === 'ACP verified\n'))).toBe(true);
  });
  test.each(['deny', 'cancelled', 'unexpected'])('permission %s never writes', async choice => {
    conn.requestPermission.mockResolvedValue({ outcome: choice === 'cancelled' ? { outcome: choice } : { outcome: 'selected', optionId: choice } });
    await server.prompt(prompt(sid, 'write'));
    expect(fs.existsSync(path.join(temp, 'proof.txt'))).toBe(false);
    expect(updates.some(x => x.status === 'failed')).toBe(true);
  });
  test('tests require approval despite terminal read-only classification', async () => {
    conn.requestPermission.mockResolvedValue({ outcome: { outcome: 'selected', optionId: 'deny' } });
    await server.prompt(prompt(sid, 'test'));
    expect(conn.requestPermission).toHaveBeenCalledTimes(1);
  });
  test('outside-workspace paths fail before permission or writing', async () => {
    await expect(server.prompt(prompt(sid, 'escape'))).rejects.toThrow(/outside/);
    expect(conn.requestPermission).not.toHaveBeenCalled();
  });
  test.each([false, true])('rejects an escaping symlink (target exists: %s)', async exists => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-acp-outside-'));
    const target = path.join(outside, 'target.txt');
    try {
      if (exists) fs.writeFileSync(target, 'unchanged');
      fs.symlinkSync(target, path.join(temp, 'proof.txt'));
      await expect(server.prompt(prompt(sid, 'write'))).rejects.toThrow();
      expect(conn.requestPermission).not.toHaveBeenCalled();
      if (exists) expect(fs.readFileSync(target, 'utf8')).toBe('unchanged');
      else expect(fs.existsSync(target)).toBe(false);
    } finally { fs.rmSync(outside, { recursive: true, force: true }); }
  });
  test('cancel while approval is pending completes without waiting for the client', async () => {
    let approve;
    conn.requestPermission.mockImplementation(() => new Promise(resolve => { approve = resolve; }));
    const turn = server.prompt(prompt(sid, 'write'));
    await until(() => approve);
    await server.cancel({ sessionId: sid });
    expect(await turn).toEqual({ stopReason: 'cancelled' });
    approve({ outcome: { outcome: 'selected', optionId: 'allow' } });
    await delay(50);
    expect(fs.existsSync(path.join(temp, 'proof.txt'))).toBe(false);
    await expect(server.prompt(prompt(sid, 'write'))).rejects.toThrow(/interrupted/);
  });
  test('cancel interrupts a synchronous shell tool and its children', async () => {
    const turn = server.prompt(prompt(sid, 'command'));
    await until(() => updates.some(x => x.status === 'in_progress'));
    const worker = server.sessions.get(sid).worker;
    await until(() => descendants(worker.pid).length > 1);
    const owned = descendants(worker.pid);
    await server.cancel({ sessionId: sid });
    expect(await turn).toEqual({ stopReason: 'cancelled' });
    await until(() => owned.every(p => { const now = identity(p.pid); return !now || now.start !== p.start || now.state === 'Z'; }));
  });
  test('disconnect stops a pending prompt', async () => {
    conn.requestPermission.mockImplementation(() => new Promise(() => {}));
    const turn = server.prompt(prompt(sid, 'write'));
    await until(() => conn.requestPermission.mock.calls.length);
    await server.close();
    expect(await turn).toEqual({ stopReason: 'cancelled' });
  });
  test('rejects concurrent prompts and a second owner of an explicit profile', async () => {
    server.options.sessionDir = temp;
    conn.requestPermission.mockImplementation(() => new Promise(() => {}));
    const turn = server.prompt(prompt(sid, 'write'));
    await until(() => conn.requestPermission.mock.calls.length);
    await expect(server.prompt(prompt(sid, 'cwd'))).rejects.toThrow(/active prompt/);
    const next = (await server.newSession({ cwd: temp })).sessionId;
    await expect(server.prompt(prompt(next, 'cwd'))).rejects.toThrow(/owns/);
    await server.cancel({ sessionId: sid });
    await turn;
    expect(await server.prompt(prompt(next, 'cwd'))).toEqual({ stopReason: 'end_turn' });
  });
  test('rejects unsupported inputs, MCP and relative workspaces', async () => {
    await expect(server.newSession({ cwd: '.' })).rejects.toThrow(/absolute/);
    await expect(server.newSession({ cwd: temp, mcpServers: [{}] })).rejects.toThrow(/MCP/);
    await expect(server.prompt({ sessionId: sid, prompt: [{ type: 'image', data: '' }] })).rejects.toThrow(/Only text/);
  });
});
