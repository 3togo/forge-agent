'use strict';
jest.mock('child_process', () => ({ spawnSync: jest.fn(), execSync: jest.fn() }));
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const realExecSync = jest.requireActual('child_process').execSync;
const {
  findAionUiDb, isAionUiRunning, getForgeAcpCommand,
  registerAcpAgents, unregisterAcpAgents, listRegisteredAgents, registerApiProviders,
  register, unregister, list, MODEL_META,
  getIconPath,
} = require('../src/aionui-register');

const SCHEMA_AGENT_METADATA = `CREATE TABLE agent_metadata (id TEXT PRIMARY KEY, agent_id TEXT UNIQUE NOT NULL, name TEXT, description TEXT, backend TEXT, agent_type TEXT, agent_source TEXT, enabled INTEGER, command TEXT, args TEXT, env TEXT, icon TEXT, name_i18n TEXT, description_i18n TEXT, agent_source_info TEXT, native_skills_dirs TEXT, behavior_policy TEXT, yolo_id TEXT, agent_capabilities TEXT, auth_methods TEXT, config_options TEXT, available_modes TEXT, available_models TEXT, available_commands TEXT, sort_order INTEGER, command_override TEXT, env_override TEXT, created_at INTEGER, updated_at INTEGER, skill_delivery TEXT, user_id TEXT);`;

describe('findAionUiDb', () => {
  let temp, home;
  beforeEach(() => {
    temp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-reg-test-'));
    home = jest.spyOn(os, 'homedir').mockReturnValue(temp);
  });
  afterEach(() => {
    home.mockRestore();
    fs.rmSync(temp, { recursive: true, force: true });
  });
  test('returns override path when it exists', () => {
    const f = path.join(temp, 'custom.db');
    fs.writeFileSync(f, '');
    expect(findAionUiDb(f)).toBe(f);
  });
  test('returns null when no database exists', () => {
    expect(findAionUiDb()).toBeNull();
  });
  test('finds default AionUi path', () => {
    const dbDir = path.join(temp, '.config', 'AionUi', 'aionui');
    fs.mkdirSync(dbDir, { recursive: true });
    const dbPath = path.join(dbDir, 'aionui-backend.db');
    fs.writeFileSync(dbPath, '');
    expect(findAionUiDb()).toBe(dbPath);
  });
  test('finds lowercase alternative path', () => {
    const dbDir = path.join(temp, '.config', 'aionui', 'aionui');
    fs.mkdirSync(dbDir, { recursive: true });
    const dbPath = path.join(dbDir, 'aionui-backend.db');
    fs.writeFileSync(dbPath, '');
    expect(findAionUiDb()).toBe(dbPath);
  });
});

describe('isAionUiRunning', () => {
  beforeEach(() => spawnSync.mockReset());
  test('detects running aionui process', () => {
    spawnSync.mockReturnValue({ status: 0, stdout: 'bash\naionui\naionui-helper\n', stderr: '' });
    expect(isAionUiRunning()).toBe(true);
  });
  test('detects when aionui is not running', () => {
    spawnSync.mockReturnValue({ status: 0, stdout: 'bash\nnode\n', stderr: '' });
    expect(isAionUiRunning()).toBe(false);
  });
  test('returns false on ps failure', () => {
    spawnSync.mockReturnValue({ status: 1, stdout: '', stderr: 'error' });
    expect(isAionUiRunning()).toBe(false);
  });
});

describe('registerAcpAgents', () => {
  let temp, dbPath, output;
  beforeEach(() => {
    temp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-reg-acp-'));
    dbPath = path.join(temp, 'test.db');
    output = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    spawnSync.mockReset();
    realExecSync(`sqlite3 "${dbPath}" "${SCHEMA_AGENT_METADATA}"`);
  });
  afterEach(() => {
    output.mockRestore();
    fs.rmSync(temp, { recursive: true, force: true });
  });
  test('registers all supported models as ACP agents', () => {
    let idCounter = 0;
    spawnSync.mockImplementation((cmd, args) => {
      if (cmd === 'node') return { status: 0, stdout: `id${idCounter++}`, stderr: '' };
      if (cmd === 'sqlite3') {
        realExecSync(`sqlite3 "${dbPath}" "${args[1].replace(/"/g, '\\"')}"`);
        return { status: 0, stdout: '', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    });
    const results = registerAcpAgents(dbPath, ['deepseek', 'doubao', 'gemini']);
    expect(results).toHaveLength(3);
    expect(results.every(r => r.status === 'registered')).toBe(true);
    expect(results[0]).toHaveProperty('agentId', 'forge-deepseek');
    expect(results[1]).toHaveProperty('agentId', 'forge-doubao');
    expect(results[2]).toHaveProperty('agentId', 'forge-gemini');
    const count = realExecSync(`sqlite3 "${dbPath}" "SELECT COUNT(*) FROM agent_metadata;"`, { encoding: 'utf8' }).trim();
    expect(Number(count)).toBe(3);
  });
  test('skips unknown models', () => {
    const results = registerAcpAgents(dbPath, ['unknown-model']);
    expect(results[0].status).toBe('skipped');
    expect(results[0].reason).toBe('unknown model');
  });
  test('reports sqlite3 errors', () => {
    spawnSync.mockImplementation((cmd) => {
      if (cmd === 'node') return { status: 0, stdout: 'abc123', stderr: '' };
      if (cmd === 'sqlite3') return { status: 1, stdout: '', stderr: 'no such table' };
      return { status: 0, stdout: '', stderr: '' };
    });
    const results = registerAcpAgents(dbPath, ['deepseek']);
    expect(results[0].status).toBe('error');
    expect(results[0].reason).toContain('no such table');
  });
});

describe('unregisterAcpAgents', () => {
  let temp, dbPath, output;
  beforeEach(() => {
    temp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-unreg-'));
    dbPath = path.join(temp, 'test.db');
    output = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    spawnSync.mockReset();
  });
  afterEach(() => {
    output.mockRestore();
    fs.rmSync(temp, { recursive: true, force: true });
  });
  test('unregisters agents by agent_id', () => {
    spawnSync.mockImplementation((cmd) => {
      if (cmd === 'sqlite3') return { status: 0, stdout: '', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    });
    const results = unregisterAcpAgents(dbPath, ['deepseek', 'doubao']);
    expect(results).toHaveLength(2);
    expect(results.every(r => r.status === 'unregistered')).toBe(true);
    expect(results[0]).toHaveProperty('agentId', 'forge-deepseek');
  });
  test('reports errors on sqlite3 failure', () => {
    spawnSync.mockImplementation((cmd) => {
      if (cmd === 'sqlite3') return { status: 1, stdout: '', stderr: 'disk error' };
      return { status: 0, stdout: '', stderr: '' };
    });
    const results = unregisterAcpAgents(dbPath, ['deepseek']);
    expect(results[0].status).toBe('error');
    expect(results[0].reason).toContain('disk error');
  });
});

describe('listRegisteredAgents', () => {
  let temp, dbPath, output;
  beforeEach(() => {
    temp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-list-'));
    dbPath = path.join(temp, 'test.db');
    output = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    spawnSync.mockReset();
  });
  afterEach(() => {
    output.mockRestore();
    fs.rmSync(temp, { recursive: true, force: true });
  });
  test('returns parsed JSON from sqlite3', () => {
    const fakeRows = [
      { agent_id: 'forge-deepseek', name: 'DeepSeek (Forge)', command: '/path/to/acp', args: '--model=deepseek', enabled: 1 },
    ];
    spawnSync.mockImplementation((cmd) => {
      if (cmd === 'sqlite3') return { status: 0, stdout: JSON.stringify(fakeRows), stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    });
    const agents = listRegisteredAgents(dbPath);
    expect(agents).toEqual(fakeRows);
  });
  test('returns empty array on sqlite3 failure', () => {
    spawnSync.mockImplementation((cmd) => {
      if (cmd === 'sqlite3') return { status: 1, stdout: '', stderr: 'error' };
      return { status: 0, stdout: '', stderr: '' };
    });
    expect(listRegisteredAgents(dbPath)).toEqual([]);
  });
  test('returns empty array on invalid JSON', () => {
    spawnSync.mockImplementation((cmd) => {
      if (cmd === 'sqlite3') return { status: 0, stdout: 'not json', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    });
    expect(listRegisteredAgents(dbPath)).toEqual([]);
  });
});

describe('registerApiProviders', () => {
  let temp, dbPath, output;
  beforeEach(() => {
    temp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-api-'));
    dbPath = path.join(temp, 'test.db');
    output = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    spawnSync.mockReset();
  });
  afterEach(() => {
    output.mockRestore();
    fs.rmSync(temp, { recursive: true, force: true });
  });
  test('registers providers with API keys', () => {
    spawnSync.mockImplementation((cmd) => {
      if (cmd === 'node') return { status: 0, stdout: 'fakehex123', stderr: '' };
      if (cmd === 'sqlite3') return { status: 0, stdout: '', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    });
    const results = registerApiProviders(dbPath, ['deepseek', 'doubao'], {
      deepseek: 'sk-deepseek-key',
      doubao: 'sk-doubao-key',
    });
    expect(results).toHaveLength(2);
    expect(results.every(r => r.status === 'registered')).toBe(true);
    expect(results[0]).toHaveProperty('base_url', 'https://api.deepseek.com/v1');
    expect(results[1]).toHaveProperty('base_url', 'https://ark.cn-beijing.volces.com/api/v3');
  });
  test('skips models without API key', () => {
    spawnSync.mockImplementation((cmd) => {
      if (cmd === 'node') return { status: 0, stdout: 'fakehex', stderr: '' };
      if (cmd === 'sqlite3') return { status: 0, stdout: '', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    });
    const results = registerApiProviders(dbPath, ['deepseek', 'doubao'], {
      deepseek: 'sk-key',
    });
    expect(results[0].status).toBe('registered');
    expect(results[1].status).toBe('skipped');
    expect(results[1].reason).toBe('no API key provided');
  });
  test('skips models without API meta (gemini)', () => {
    spawnSync.mockImplementation((cmd) => {
      if (cmd === 'node') return { status: 0, stdout: 'fakehex', stderr: '' };
      if (cmd === 'sqlite3') return { status: 0, stdout: '', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    });
    const results = registerApiProviders(dbPath, ['gemini'], { gemini: 'key' });
    expect(results[0].status).toBe('skipped');
    expect(results[0].reason).toBe('no API meta');
  });
  test('reports sqlite3 errors', () => {
    spawnSync.mockImplementation((cmd) => {
      if (cmd === 'node') return { status: 0, stdout: 'fakehex', stderr: '' };
      if (cmd === 'sqlite3') return { status: 1, stdout: '', stderr: 'no such table' };
      return { status: 0, stdout: '', stderr: '' };
    });
    const results = registerApiProviders(dbPath, ['deepseek'], { deepseek: 'key' });
    expect(results[0].status).toBe('error');
  });
});

describe('register (high-level)', () => {
  let temp, home, output;
  beforeEach(() => {
    temp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-reg-hl-'));
    home = jest.spyOn(os, 'homedir').mockReturnValue(temp);
    output = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    spawnSync.mockReset();
  });
  afterEach(() => {
    home.mockRestore(); output.mockRestore();
    fs.rmSync(temp, { recursive: true, force: true });
  });
  test('fails when database not found', async () => {
    const result = await register();
    expect(result.success).toBe(false);
    expect(result.reason).toBe('no database');
  });
  test('registers ACP agents by default', async () => {
    const dbDir = path.join(temp, '.config', 'AionUi', 'aionui');
    fs.mkdirSync(dbDir, { recursive: true });
    const dbPath = path.join(dbDir, 'aionui-backend.db');
    fs.writeFileSync(dbPath, '');
    spawnSync.mockImplementation((cmd) => {
      if (cmd === 'ps') return { status: 0, stdout: 'bash\n', stderr: '' };
      if (cmd === 'node') return { status: 0, stdout: 'fakehex', stderr: '' };
      if (cmd === 'sqlite3') return { status: 0, stdout: '', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    });
    const result = await register({ models: ['deepseek'] });
    expect(result.success).toBe(true);
    expect(result.results[0].status).toBe('registered');
  });
  test('registers API providers with --api mode', async () => {
    const dbDir = path.join(temp, '.config', 'AionUi', 'aionui');
    fs.mkdirSync(dbDir, { recursive: true });
    const dbPath = path.join(dbDir, 'aionui-backend.db');
    fs.writeFileSync(dbPath, '');
    spawnSync.mockImplementation((cmd) => {
      if (cmd === 'ps') return { status: 0, stdout: 'bash\n', stderr: '' };
      if (cmd === 'node') return { status: 0, stdout: 'fakehex', stderr: '' };
      if (cmd === 'sqlite3') return { status: 0, stdout: '', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    });
    const result = await register({ api: true, models: ['deepseek'], apiKeys: { deepseek: 'sk-test' } });
    expect(result.success).toBe(true);
    expect(result.results[0].status).toBe('registered');
  });
  test('warns when AionUi is running', async () => {
    const dbDir = path.join(temp, '.config', 'AionUi', 'aionui');
    fs.mkdirSync(dbDir, { recursive: true });
    const dbPath = path.join(dbDir, 'aionui-backend.db');
    fs.writeFileSync(dbPath, '');
    spawnSync.mockImplementation((cmd) => {
      if (cmd === 'ps') return { status: 0, stdout: 'bash\naionui\n', stderr: '' };
      if (cmd === 'node') return { status: 0, stdout: 'fakehex', stderr: '' };
      if (cmd === 'sqlite3') return { status: 0, stdout: '', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    });
    await register({ models: ['deepseek'] });
    expect(output.mock.calls.flat().join('')).toContain('Warning: AionUi is running');
  });
});

describe('unregister (high-level)', () => {
  let temp, home, output;
  beforeEach(() => {
    temp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-unreg-hl-'));
    home = jest.spyOn(os, 'homedir').mockReturnValue(temp);
    output = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    spawnSync.mockReset();
  });
  afterEach(() => {
    home.mockRestore(); output.mockRestore();
    fs.rmSync(temp, { recursive: true, force: true });
  });
  test('fails when database not found', async () => {
    const result = await unregister();
    expect(result.success).toBe(false);
  });
  test('unregisters specified models', async () => {
    const dbDir = path.join(temp, '.config', 'AionUi', 'aionui');
    fs.mkdirSync(dbDir, { recursive: true });
    const dbPath = path.join(dbDir, 'aionui-backend.db');
    fs.writeFileSync(dbPath, '');
    spawnSync.mockImplementation((cmd) => {
      if (cmd === 'sqlite3') return { status: 0, stdout: '', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    });
    const result = await unregister({ models: ['deepseek', 'doubao'] });
    expect(result.success).toBe(true);
    expect(result.results).toHaveLength(2);
    expect(result.results.every(r => r.status === 'unregistered')).toBe(true);
  });
});

describe('list (high-level)', () => {
  let temp, home, output;
  beforeEach(() => {
    temp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-list-hl-'));
    home = jest.spyOn(os, 'homedir').mockReturnValue(temp);
    output = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    spawnSync.mockReset();
  });
  afterEach(() => {
    home.mockRestore(); output.mockRestore();
    fs.rmSync(temp, { recursive: true, force: true });
  });
  test('returns empty when no database', () => {
    expect(list()).toEqual([]);
  });
  test('lists registered agents', () => {
    const dbDir = path.join(temp, '.config', 'AionUi', 'aionui');
    fs.mkdirSync(dbDir, { recursive: true });
    const dbPath = path.join(dbDir, 'aionui-backend.db');
    fs.writeFileSync(dbPath, '');
    const fakeRows = [
      { agent_id: 'forge-deepseek', name: 'DeepSeek (Forge)', command: '/path', args: '--model=deepseek', enabled: 1 },
    ];
    spawnSync.mockImplementation((cmd) => {
      if (cmd === 'sqlite3') return { status: 0, stdout: JSON.stringify(fakeRows), stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    });
    const agents = list();
    expect(agents).toEqual(fakeRows);
    expect(output.mock.calls.flat().join('')).toContain('DeepSeek (Forge)');
  });
});

describe('idempotency', () => {
  let temp, dbPath, output;
  beforeEach(() => {
    temp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-idem-'));
    dbPath = path.join(temp, 'test.db');
    output = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    spawnSync.mockReset();
    realExecSync(`sqlite3 "${dbPath}" "${SCHEMA_AGENT_METADATA}"`);
  });
  afterEach(() => {
    output.mockRestore();
    fs.rmSync(temp, { recursive: true, force: true });
  });
  test('registering twice does not create duplicates', () => {
    let callCount = 0;
    spawnSync.mockImplementation((cmd, args) => {
      if (cmd === 'node') return { status: 0, stdout: `hex${callCount++}`, stderr: '' };
      if (cmd === 'sqlite3') {
        realExecSync(`sqlite3 "${dbPath}" "${args[1].replace(/"/g, '\\"')}"`);
        return { status: 0, stdout: '', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    });
    registerAcpAgents(dbPath, ['deepseek']);
    registerAcpAgents(dbPath, ['deepseek']);
    const count = realExecSync(`sqlite3 "${dbPath}" "SELECT COUNT(*) FROM agent_metadata WHERE agent_id='forge-deepseek';"`, { encoding: 'utf8' }).trim();
    expect(Number(count)).toBe(1);
  });
});

describe('getIconPath', () => {
  test('returns the official product icon for a supported model', () => {
    expect(getIconPath('deepseek')).toBe('https://fe-static.deepseek.com/chat/favicon.svg');
  });
  test('returns an emoji fallback for an unsupported model', () => {
    expect(getIconPath('unknown')).toBe('emoji:❓');
  });
});

describe('MODEL_META icon paths', () => {
  test('uses the official product icons', () => {
    expect(Object.fromEntries(Object.entries(MODEL_META).map(([model, meta]) => [model, meta.icon]))).toEqual({
      deepseek: 'https://fe-static.deepseek.com/chat/favicon.svg',
      doubao: 'https://lf-flow-web-cdn.doubao.com/obj/flow-doubao/favicon/new-doubao/128x128.png',
      gemini: 'https://www.gstatic.com/lamda/images/gemini_sparkle_4g_512_lt_f94943af3be039176192d.png',
      yuanbao: 'https://static.yuanbao.tencent.com/m/yuanbao-web/favicon_new@32.png',
    });
  });
});
