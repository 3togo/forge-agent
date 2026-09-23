'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const AcpServer = require('../src/acp-server');
describe('ACP reconnect with stale client session IDs', () => {
  let root, options, first, second, updates;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-reconnect-'));
    options = { model: 'doubao', sessionStateDir: path.join(root, 'state'), workerFile: path.join(__dirname, 'fixtures/acp-worker.cjs') };
    updates = [];
    const connection = { sessionUpdate: async e => updates.push(e.update), requestPermission: jest.fn() };
    first = new AcpServer(connection, options); first.initialize();
    second = new AcpServer(connection, options); second.initialize();
  });
  afterEach(async () => { await first.close(); await second.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const prompt = sessionId => ({ sessionId, prompt: [{ type: 'text', text: 'cwd' }] });
  test('a known session reconnects to its original workspace and reports lost context once', async () => {
    const { sessionId } = await first.newSession({ cwd: root });
    await first.close();
    expect(await second.prompt(prompt(sessionId))).toEqual({ stopReason: 'end_turn' });
    expect(updates.some(u => u.content?.text === root)).toBe(true);
    await second.prompt(prompt(sessionId));
    expect(updates.filter(u => u.content?.text.includes('Conversation context has reset'))).toHaveLength(1);
  });
  test('concurrent conversations in the same project get distinct browser profiles', async () => {
    const a = (await first.newSession({ cwd: root })).sessionId;
    const b = (await second.newSession({ cwd: root })).sessionId;
    await Promise.all([
      first.prompt({ sessionId: a, prompt: [{ type: 'text', text: 'profile' }] }),
      second.prompt({ sessionId: b, prompt: [{ type: 'text', text: 'profile' }] }),
    ]);
    const profiles = updates.filter(u => u.content?.text.startsWith(path.join(os.homedir(), '.deepseek-agent', 'acp-profiles') + path.sep)).map(u => u.content.text);
    expect(profiles).toHaveLength(2);
    expect(profiles[0]).not.toBe(profiles[1]);
    expect(profiles.some(p => p.endsWith(a))).toBe(true);
    expect(profiles.some(p => p.endsWith(b))).toBe(true);
  });
  test('a restored conversation reuses its own profile instead of a shared profile', async () => {
    const { sessionId } = await first.newSession({ cwd: root });
    const request = { sessionId, prompt: [{ type: 'text', text: 'profile' }] };
    await first.prompt(request); await first.close(); await second.prompt(request);
    const profiles = updates.filter(u => u.content?.text.startsWith(path.join(os.homedir(), '.deepseek-agent', 'acp-profiles') + path.sep)).map(u => u.content.text);
    expect(profiles).toHaveLength(2);
    expect(profiles[0]).toBe(profiles[1]);
  });
  test('two conversations on one connection retain independent workers and profiles', async () => {
    const a = (await first.newSession({ cwd: root })).sessionId;
    const b = (await first.newSession({ cwd: root })).sessionId;
    const request = sessionId => ({ sessionId, prompt: [{ type: 'text', text: 'profile' }] });
    await first.prompt(request(a));
    await first.prompt(request(b));
    await first.prompt(request(a));
    const profiles = updates.filter(u => u.content?.text.startsWith(path.join(os.homedir(), '.deepseek-agent', 'acp-profiles') + path.sep)).map(u => u.content.text);
    expect(profiles).toHaveLength(3);
    expect(profiles[0]).toBe(profiles[2]);
    expect(profiles[0]).not.toBe(profiles[1]);
    expect(first.sessions.get(a).worker.pid).not.toBe(first.sessions.get(b).worker.pid);
  });
  test('an explicit profile override is respected', async () => {
    first.options.sessionDir = path.join(root, 'custom-profile');
    const { sessionId } = await first.newSession({ cwd: root });
    await first.prompt({ sessionId, prompt: [{ type: 'text', text: 'profile' }] });
    expect(updates.some(u => u.content?.text === first.options.sessionDir)).toBe(true);
  });
  test('unknown IDs are rejected rather than adopting the process working directory', async () => {
    await expect(second.prompt(prompt('00000000-0000-0000-0000-000000000000'))).rejects.toThrow('Start a new chat');
    await expect(second.prompt(prompt('../record'))).rejects.toThrow('stale session ID');
    expect(second.sessions.size).toBe(0);
  });
  test('closed connections cannot resurrect a persisted session', async () => {
    const { sessionId } = await first.newSession({ cwd: root });
    await second.close();
    await expect(second.prompt(prompt(sessionId))).rejects.toThrow('closed');
  });
  test('wrong-model and malformed records cannot restore sessions', async () => {
    const { sessionId } = await first.newSession({ cwd: root });
    second.options = { ...options, model: 'gemini' };
    await expect(second.prompt(prompt(sessionId))).rejects.toThrow('cannot be restored');
    second.options = options;
    fs.writeFileSync(path.join(options.sessionStateDir, `${sessionId}.json`), '{invalid');
    await expect(second.prompt(prompt(sessionId))).rejects.toThrow('cannot be restored');
  });
  test('missing workspaces do not restore', async () => {
    const workspace = path.join(root, 'project'); fs.mkdirSync(workspace);
    const { sessionId } = await first.newSession({ cwd: workspace });
    fs.rmdirSync(workspace);
    await expect(second.prompt(prompt(sessionId))).rejects.toThrow('cannot be restored');
  });
});
