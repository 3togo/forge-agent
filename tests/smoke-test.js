#!/usr/bin/env node
'use strict';
// Smoke test: end-to-end verification of --login and ACP model inference
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const NODE = process.execPath;
const INDEX = path.join(root, 'src/index.js');
const ENTRY = path.join(root, 'src/acp-entry.js');

let pass = 0, fail = 0;
const results = [];

function test(name, fn) {
  try {
    fn();
    pass++;
    results.push(`  PASS  ${name}`);
  } catch (err) {
    fail++;
    results.push(`  FAIL  ${name}: ${err.message}`);
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    pass++;
    results.push(`  PASS  ${name}`);
  } catch (err) {
    fail++;
    results.push(`  FAIL  ${name}: ${err.message}`);
  }
}

function makeTempHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-smoke-'));
  return dir;
}

// ── 1. --help includes --login ──────────────────────────────────────────────
test('--help output contains --login', () => {
  const r = spawnSync(NODE, [INDEX, '--help'], { encoding: 'utf8', timeout: 10000 });
  if (r.status !== 0) throw new Error(`exit ${r.status}: ${r.stderr}`);
  if (!r.stdout.includes('--login')) throw new Error('--login not in help');
  if (!r.stdout.includes('AUTHENTICATION')) throw new Error('AUTHENTICATION section not in help');
});

// ── 2. --login with valid auth file exits 0 ────────────────────────────────
test('--login with valid auth exits 0 and says "Already logged in"', () => {
  const home = makeTempHome();
  try {
    const authDir = path.join(home, '.deepseek-agent', 'acp-auth');
    fs.mkdirSync(authDir, { recursive: true });
    const futureExpiry = Math.floor(Date.now() / 1000) + 86400;
    fs.writeFileSync(path.join(authDir, 'yuanbao.json'), JSON.stringify({
      cookies: [{ name: 'session', value: 'abc', domain: 'yuanbao.tencent.com', expires: futureExpiry }],
      origins: [],
    }));

    const r = spawnSync(NODE, [INDEX, '--login', '--model=yuanbao'], {
      encoding: 'utf8', timeout: 10000,
      env: { ...process.env, HOME: home },
    });
    if (r.status !== 0) throw new Error(`exit ${r.status}: ${r.stderr}`);
    if (!r.stdout.includes('Already logged in')) throw new Error('did not say "Already logged in"');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

// ── 3. --login without auth file does not say "Already logged in" ──────────
test('--login without auth file does not say "Already logged in"', () => {
  const home = makeTempHome();
  try {
    const r = spawnSync(NODE, [INDEX, '--login', '--model=yuanbao'], {
      encoding: 'utf8', timeout: 15000,
      env: { ...process.env, HOME: home },
    });
    if (r.stdout.includes('Already logged in')) throw new Error('should not say "Already logged in" without auth');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

// ── 4. --login with expired auth does not say "Already logged in" ──────────
test('--login with expired auth does not say "Already logged in"', () => {
  const home = makeTempHome();
  try {
    const authDir = path.join(home, '.deepseek-agent', 'acp-auth');
    fs.mkdirSync(authDir, { recursive: true });
    const pastExpiry = Math.floor(Date.now() / 1000) - 86400;
    fs.writeFileSync(path.join(authDir, 'yuanbao.json'), JSON.stringify({
      cookies: [{ name: 'session', value: 'abc', domain: 'yuanbao.tencent.com', expires: pastExpiry }],
      origins: [],
    }));

    const r = spawnSync(NODE, [INDEX, '--login', '--model=yuanbao'], {
      encoding: 'utf8', timeout: 15000,
      env: { ...process.env, HOME: home },
    });
    if (r.stdout.includes('Already logged in')) throw new Error('should not say "Already logged in" with expired auth');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

// ── 5. ACP entry infers model from AionUi conversation ─────────────────────
test('ACP entry infers yuanbao from AIONUI_CONVERSATION_ID', () => {
  const home = makeTempHome();
  try {
    const dbDir = path.join(home, '.config', 'AionUi', 'aionui');
    fs.mkdirSync(dbDir, { recursive: true });
    const dbPath = path.join(dbDir, 'aionui-backend.db');
    const convId = 'smoke-conv-1';
    spawnSync('sqlite3', [dbPath, `CREATE TABLE conversations (id TEXT PRIMARY KEY, extra TEXT);`]);
    spawnSync('sqlite3', [dbPath, `INSERT INTO conversations VALUES ('${convId}', '{"agent_id":"forge-yuanbao"}');`]);

    const input = [
      { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } },
      { jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd: root, mcpServers: [] } },
    ].map(x => JSON.stringify(x)).join('\n') + '\n';

    const r = spawnSync(NODE, [ENTRY, '--acp'], {
      input, encoding: 'utf8', timeout: 5000,
      env: { ...process.env, HOME: home, AIONUI_CONVERSATION_ID: convId },
    });
    if (!r.stderr.includes('inferred model=yuanbao')) throw new Error('did not infer yuanbao');
    if (!r.stderr.includes('entry: model=yuanbao')) throw new Error('model not set to yuanbao');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

// ── 6. ACP entry does NOT infer when --model is explicit ───────────────────
test('ACP entry does not infer model when --model=yuanbao is explicit', () => {
  const home = makeTempHome();
  try {
    const dbDir = path.join(home, '.config', 'AionUi', 'aionui');
    fs.mkdirSync(dbDir, { recursive: true });
    const dbPath = path.join(dbDir, 'aionui-backend.db');
    const convId = 'smoke-conv-2';
    spawnSync('sqlite3', [dbPath, `CREATE TABLE conversations (id TEXT PRIMARY KEY, extra TEXT);`]);
    spawnSync('sqlite3', [dbPath, `INSERT INTO conversations VALUES ('${convId}', '{"agent_id":"forge-deepseek"}');`]);

    const input = [
      { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } },
      { jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd: root, mcpServers: [] } },
    ].map(x => JSON.stringify(x)).join('\n') + '\n';

    const r = spawnSync(NODE, [ENTRY, '--acp', '--model=yuanbao'], {
      input, encoding: 'utf8', timeout: 5000,
      env: { ...process.env, HOME: home, AIONUI_CONVERSATION_ID: convId },
    });
    if (r.stderr.includes('inferred model')) throw new Error('should not infer when --model is explicit');
    if (!r.stderr.includes('entry: model=yuanbao')) throw new Error('model not yuanbao');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

// ── 7. ACP entry infers for each model ─────────────────────────────────────
for (const model of ['deepseek', 'doubao', 'gemini', 'yuanbao']) {
  test(`ACP entry infers ${model} from conversation`, () => {
    const home = makeTempHome();
    try {
      const dbDir = path.join(home, '.config', 'AionUi', 'aionui');
      fs.mkdirSync(dbDir, { recursive: true });
      const dbPath = path.join(dbDir, 'aionui-backend.db');
      const convId = `smoke-${model}`;
      spawnSync('sqlite3', [dbPath, `CREATE TABLE conversations (id TEXT PRIMARY KEY, extra TEXT);`]);
      spawnSync('sqlite3', [dbPath, `INSERT INTO conversations VALUES ('${convId}', '{"agent_id":"forge-${model}"}');`]);

      const input = [
        { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } },
        { jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd: root, mcpServers: [] } },
      ].map(x => JSON.stringify(x)).join('\n') + '\n';

      const r = spawnSync(NODE, [ENTRY, '--acp'], {
        input, encoding: 'utf8', timeout: 5000,
        env: { ...process.env, HOME: home, AIONUI_CONVERSATION_ID: convId },
      });
      if (!r.stderr.includes(`inferred model=${model}`)) throw new Error(`did not infer ${model}`);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });
}

// ── 8. ACP entry falls back to deepseek when conversation not found ────────
test('ACP entry falls back to deepseek when conversation not found', () => {
  const home = makeTempHome();
  try {
    const dbDir = path.join(home, '.config', 'AionUi', 'aionui');
    fs.mkdirSync(dbDir, { recursive: true });
    const dbPath = path.join(dbDir, 'aionui-backend.db');
    spawnSync('sqlite3', [dbPath, `CREATE TABLE conversations (id TEXT PRIMARY KEY, extra TEXT);`]);

    const input = [
      { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } },
      { jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd: root, mcpServers: [] } },
    ].map(x => JSON.stringify(x)).join('\n') + '\n';

    const r = spawnSync(NODE, [ENTRY, '--acp'], {
      input, encoding: 'utf8', timeout: 5000,
      env: { ...process.env, HOME: home, AIONUI_CONVERSATION_ID: 'nonexistent' },
    });
    if (r.stderr.includes('inferred model')) throw new Error('should not infer when conversation not found');
    if (!r.stderr.includes('entry: model=deepseek')) throw new Error('should default to deepseek');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

// ── 9. ACP entry rejects unsupported model ─────────────────────────────────
test('ACP entry rejects unsupported model', () => {
  const r = spawnSync(NODE, [ENTRY, '--acp', '--model=unknown'], { encoding: 'utf8', timeout: 5000 });
  if (r.status === 0) throw new Error('should not accept unknown model');
  if (!r.stderr.includes('Unsupported model')) throw new Error('should say "Unsupported model"');
});

// ── 10. forge-agent-acp bash script exists and is executable ───────────────
test('forge-agent-acp bash script exists and is executable', () => {
  const scriptPath = path.join(root, 'forge-agent-acp');
  if (!fs.existsSync(scriptPath)) throw new Error('forge-agent-acp not found');
  const stat = fs.statSync(scriptPath);
  if (!(stat.mode & 0o111)) throw new Error('forge-agent-acp is not executable');
});

// ── 11. AionUi DB has yuanbao agent registered ─────────────────────────────
test('AionUi DB has forge-yuanbao agent registered', () => {
  const dbPath = path.join(os.homedir(), '.config', 'AionUi', 'aionui', 'aionui-backend.db');
  if (!fs.existsSync(dbPath)) throw new Error('AionUi DB not found');
  const r = spawnSync('sqlite3', [dbPath, "SELECT agent_id, args FROM agent_metadata WHERE agent_id='forge-yuanbao';"], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`sqlite3 failed: ${r.stderr}`);
  if (!r.stdout.includes('forge-yuanbao')) throw new Error('forge-yuanbao not registered');
  if (!r.stdout.includes('--model=yuanbao')) throw new Error('args does not include --model=yuanbao');
});

// ── 12. Auth file path for yuanbao is correct ──────────────────────────────
test('Auth file path for yuanbao exists or is creatable', () => {
  const authDir = path.join(os.homedir(), '.deepseek-agent', 'acp-auth');
  const authFile = path.join(authDir, 'yuanbao.json');
  // Directory should exist (created by previous sessions or register)
  if (!fs.existsSync(authDir)) {
    fs.mkdirSync(authDir, { recursive: true });
  }
  // If auth file exists, it should be valid JSON
  if (fs.existsSync(authFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(authFile, 'utf8'));
      if (!data.cookies) throw new Error('auth file missing cookies field');
    } catch (err) {
      throw new Error(`auth file is corrupt: ${err.message}`);
    }
  }
});

// ── Print results ──────────────────────────────────────────────────────────
console.log('\n── Forge Agent Smoke Test ──────────────────────────────────────────\n');
for (const line of results) console.log(line);
console.log(`\n  ${pass} passed, ${fail} failed, ${pass + fail} total`);
console.log('\n────────────────────────────────────────────────────────────────────\n');
process.exit(fail > 0 ? 1 : 0);
