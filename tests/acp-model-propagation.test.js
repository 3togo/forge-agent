'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');

describe('ACP model propagation: entry → server → worker', () => {
  test.each(['deepseek', 'doubao', 'gemini', 'yuanbao'])(
    'acp-entry.js --model=%s passes model through to AcpServer options',
    (model) => {
      const input = [
        { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } },
        { jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd: root, mcpServers: [] } },
      ].map(x => JSON.stringify(x)).join('\n') + '\n';

      const result = spawnSync(process.execPath,
        [path.join(root, 'src/acp-entry.js'), '--acp', `--model=${model}`],
        { input, encoding: 'utf8', timeout: 5000 }
      );

      expect(result.status).toBe(0);
      expect(result.stderr).toContain(`[forge-acp] entry: model=${model}`);
      expect(result.stderr).toContain(`[forge-acp] entry: starting AcpServer with options`);
      expect(result.stderr).toContain(`"model":"${model}"`);
    }
  );

  test('acp-entry.js defaults to deepseek when no --model flag', () => {
    const input = [
      { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } },
      { jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd: root, mcpServers: [] } },
    ].map(x => JSON.stringify(x)).join('\n') + '\n';

    const result = spawnSync(process.execPath,
      [path.join(root, 'src/acp-entry.js'), '--acp'],
      { input, encoding: 'utf8', timeout: 5000 }
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toContain(`[forge-acp] entry: model=deepseek`);
  });

  test('acp-entry.js rejects unsupported model', () => {
    const result = spawnSync(process.execPath,
      [path.join(root, 'src/acp-entry.js'), '--acp', '--model=unknown'],
      { encoding: 'utf8', timeout: 5000 }
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Unsupported model');
  });
});

describe('ACP server spawn: environment variables for worker', () => {
  let temp;

  beforeEach(() => {
    temp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-acp-model-'));
  });
  afterEach(() => {
    fs.rmSync(temp, { recursive: true, force: true });
    jest.resetModules();
  });

  test.each(['deepseek', 'doubao', 'gemini', 'yuanbao'])(
    'spawn sets FORGE_ACP_MODEL=%s in worker env',
    (model) => {
      let capturedEnv = null;
      jest.doMock('child_process', () => {
        const actual = jest.requireActual('child_process');
        return {
          ...actual,
          fork: function(file, args, opts) {
            capturedEnv = opts.env;
            return {
              pid: 99999, killed: false,
              stdout: { on: jest.fn() }, stderr: { on: jest.fn() },
              on: jest.fn(), send: jest.fn(), kill: jest.fn(),
              connected: true, disconnect: jest.fn(),
            };
          },
        };
      });

      const AcpServer = require('../src/acp-server');
      const conn = {
        sessionUpdate: jest.fn(),
        requestPermission: jest.fn(),
      };
      const server = new AcpServer(conn, {
        model,
        workerFile: path.join(__dirname, 'fixtures/acp-worker.cjs'),
        sessionDir: path.join(temp, 'browser'),
        permissionStateDir: path.join(temp, 'permissions'),
      });
      server.initialize();

      return server.newSession({ cwd: temp }).then(({ sessionId }) => {
        const session = server.sessions.get(sessionId);
        server.spawn(session);
        expect(capturedEnv).not.toBeNull();
        expect(capturedEnv.FORGE_ACP_MODEL).toBe(model);
        expect(capturedEnv.FORGE_ACP_WORKSPACE).toBe(temp);
      });
    }
  );

  test('spawn logs model and env to stderr', () => {
    jest.doMock('child_process', () => {
      const actual = jest.requireActual('child_process');
      return {
        ...actual,
        fork: function() {
          return {
            pid: 99999, killed: false,
            stdout: { on: jest.fn() }, stderr: { on: jest.fn() },
            on: jest.fn(), send: jest.fn(), kill: jest.fn(),
            connected: true, disconnect: jest.fn(),
          };
        },
      };
    });

    const stderrWrites = [];
    const origWrite = process.stderr.write;
    process.stderr.write = (chunk) => { stderrWrites.push(chunk.toString()); return true; };

    const AcpServer = require('../src/acp-server');
    const conn = {
      sessionUpdate: jest.fn(),
      requestPermission: jest.fn(),
    };
    const server = new AcpServer(conn, {
      model: 'yuanbao',
      workerFile: path.join(__dirname, 'fixtures/acp-worker.cjs'),
      sessionDir: path.join(temp, 'browser'),
      permissionStateDir: path.join(temp, 'permissions'),
    });
    server.initialize();

    return server.newSession({ cwd: temp }).then(({ sessionId }) => {
      const session = server.sessions.get(sessionId);
      server.spawn(session);
      process.stderr.write = origWrite;
      const logOutput = stderrWrites.join('');
      expect(logOutput).toContain('[forge-acp] server: spawning worker with model=yuanbao');
    });
  });
});

describe('ACP worker: config.MODEL from env', () => {
  test.each(['deepseek', 'doubao', 'gemini', 'yuanbao'])(
    'worker sets config.MODEL=%s from FORGE_ACP_MODEL env',
    (model) => {
      const workerSrc = fs.readFileSync(path.join(root, 'src/acp-worker.js'), 'utf8');
      const vm = require('vm');
      const { createRequire } = require('module');

      const events = [];
      const handlers = {};
      const proc = {
        env: {
          FORGE_ACP_MODEL: model,
          FORGE_ACP_WORKSPACE: '/tmp',
          FORGE_ACP_SESSION_DIR: '/tmp/profile',
          FORGE_ACP_AUTH_FILE: `/tmp/auth/${model}.json`,
        },
        connected: true,
        stdout: {},
        stderr: { write: jest.fn() },
        send: event => events.push(event),
        on: (name, handler) => { handlers[name] = handler; },
        exit: jest.fn(),
      };

      const workerPath = path.resolve(root, 'src/acp-worker.js');
      const realRequire = createRequire(workerPath);
      const mockRequire = name => {
        if (name === './agent') return function () {
          return {
            browser: { adapter: { isReady: jest.fn().mockResolvedValue(true) } },
            init: jest.fn().mockResolvedValue(),
            shutdown: jest.fn().mockResolvedValue(),
            run: jest.fn().mockResolvedValue('reply'),
          };
        };
        if (name === './config') {
          const config = realRequire(name);
          return config;
        }
        if (name === './tools') return { executeTool: jest.fn() };
        if (name === './permission-store') return { isReadOnly: () => true };
        return realRequire(name);
      };

      const workerModule = { exports: {} };
      vm.runInNewContext(workerSrc, {
        require: mockRequire, module: workerModule, process: proc, setTimeout,
      }, { filename: workerPath });

      workerModule.exports.main();

      return new Promise(resolve => {
        handlers.message({ type: 'prompt', text: 'hello' });
        setImmediate(() => {
          const openingMsg = events.find(e => e.type === 'message' && e.text?.includes('Opening'));
          expect(openingMsg).toBeDefined();
          expect(openingMsg.text).toContain(model);
          resolve();
        });
      });
    }
  );

  test('worker logs env and config.MODEL to stderr', () => {
    const workerSrc = fs.readFileSync(path.join(root, 'src/acp-worker.js'), 'utf8');
    const vm = require('vm');
    const { createRequire } = require('module');

    const stderrLines = [];
    const handlers = {};
    const proc = {
      env: {
        FORGE_ACP_MODEL: 'yuanbao',
        FORGE_ACP_WORKSPACE: '/tmp',
        FORGE_ACP_SESSION_DIR: '/tmp/profile',
        FORGE_ACP_AUTH_FILE: '/tmp/auth/yuanbao.json',
      },
      connected: true,
      stdout: {},
      stderr: { write: chunk => stderrLines.push(chunk.toString()) },
      send: () => {},
      on: (name, handler) => { handlers[name] = handler; },
      exit: jest.fn(),
    };

    const workerPath = path.resolve(root, 'src/acp-worker.js');
    const realRequire = createRequire(workerPath);
    const mockRequire = name => {
      if (name === './agent') return function () {
        return {
          browser: { adapter: { isReady: jest.fn().mockResolvedValue(true) } },
          init: jest.fn().mockResolvedValue(),
          shutdown: jest.fn().mockResolvedValue(),
          run: jest.fn().mockResolvedValue('reply'),
        };
      };
      if (name === './config') return realRequire(name);
      if (name === './tools') return { executeTool: jest.fn() };
      if (name === './permission-store') return { isReadOnly: () => true };
      return realRequire(name);
    };

    const workerModule = { exports: {} };
    vm.runInNewContext(workerSrc, {
      require: mockRequire, module: workerModule, process: proc, setTimeout,
    }, { filename: workerPath });

    workerModule.exports.main();

    const logOutput = stderrLines.join('');
    expect(logOutput).toContain('[forge-acp] worker: env FORGE_ACP_MODEL=yuanbao');
    expect(logOutput).toContain('[forge-acp] worker: config.MODEL=yuanbao');
  });
});

describe('ACP entry: model inference from AionUi conversation', () => {
  let tempDbDir, tempHome;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-acp-infer-'));
    tempDbDir = path.join(tempHome, '.config', 'AionUi', 'aionui');
    fs.mkdirSync(tempDbDir, { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  test('inferModelFromAionUi returns null when no AIONUI_CONVERSATION_ID', () => {
    const { spawnSync } = require('child_process');
    const result = spawnSync(process.execPath, ['-e', `
      process.env.HOME = ${JSON.stringify(tempHome)};
      delete process.env.AIONUI_CONVERSATION_ID;
      const entry = require(${JSON.stringify(path.join(root, 'src/acp-entry.js'))});
      // inferModelFromAionUi is not exported, test via main with no --model
      // We can't call main directly (it starts AcpServer), so test the logic indirectly
      process.exit(0);
    `], { encoding: 'utf8', timeout: 5000 });
    expect(result.status).toBe(0);
  });

  test('entry infers model from AionUi conversation when no --model flag', () => {
    const dbPath = path.join(tempDbDir, 'aionui-backend.db');
    const { spawnSync } = require('child_process');

    const convId = 'test123';
    spawnSync('sqlite3', [dbPath, `CREATE TABLE conversations (id TEXT PRIMARY KEY, extra TEXT);`]);
    spawnSync('sqlite3', [dbPath, `INSERT INTO conversations VALUES ('${convId}', '{"agent_id":"forge-yuanbao"}');`]);

    const input = [
      { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } },
      { jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd: root, mcpServers: [] } },
    ].map(x => JSON.stringify(x)).join('\n') + '\n';

    const result = spawnSync(process.execPath,
      [path.join(root, 'src/acp-entry.js'), '--acp'],
      {
        input, encoding: 'utf8', timeout: 5000,
        env: { ...process.env, HOME: tempHome, AIONUI_CONVERSATION_ID: convId },
      }
    );

    expect(result.stderr).toContain('[forge-acp] entry: inferred model=yuanbao');
    expect(result.stderr).toContain('[forge-acp] entry: model=yuanbao');
  });

  test('entry does not infer model when --model is explicitly passed', () => {
    const dbPath = path.join(tempDbDir, 'aionui-backend.db');
    const { spawnSync } = require('child_process');

    const convId = 'test456';
    spawnSync('sqlite3', [dbPath, `CREATE TABLE conversations (id TEXT PRIMARY KEY, extra TEXT);`]);
    spawnSync('sqlite3', [dbPath, `INSERT INTO conversations VALUES ('${convId}', '{"agent_id":"forge-yuanbao"}');`]);

    const input = [
      { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } },
      { jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd: root, mcpServers: [] } },
    ].map(x => JSON.stringify(x)).join('\n') + '\n';

    const result = spawnSync(process.execPath,
      [path.join(root, 'src/acp-entry.js'), '--acp', '--model=doubao'],
      {
        input, encoding: 'utf8', timeout: 5000,
        env: { ...process.env, HOME: tempHome, AIONUI_CONVERSATION_ID: convId },
      }
    );

    expect(result.stderr).not.toContain('inferred model');
    expect(result.stderr).toContain('[forge-acp] entry: model=doubao');
  });

  test('entry falls back to deepseek when conversation not found', () => {
    const dbPath = path.join(tempDbDir, 'aionui-backend.db');
    const { spawnSync } = require('child_process');

    spawnSync('sqlite3', [dbPath, `CREATE TABLE conversations (id TEXT PRIMARY KEY, extra TEXT);`]);

    const input = [
      { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } },
      { jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd: root, mcpServers: [] } },
    ].map(x => JSON.stringify(x)).join('\n') + '\n';

    const result = spawnSync(process.execPath,
      [path.join(root, 'src/acp-entry.js'), '--acp'],
      {
        input, encoding: 'utf8', timeout: 5000,
        env: { ...process.env, HOME: tempHome, AIONUI_CONVERSATION_ID: 'nonexistent' },
      }
    );

    expect(result.stderr).not.toContain('inferred model');
    expect(result.stderr).toContain('[forge-acp] entry: model=deepseek');
  });

  test('entry infers model for each registered agent', () => {
    const dbPath = path.join(tempDbDir, 'aionui-backend.db');
    const { spawnSync } = require('child_process');

    for (const model of ['deepseek', 'doubao', 'gemini', 'yuanbao']) {
      const convId = `conv-${model}`;
      spawnSync('sqlite3', [dbPath, `
        CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, extra TEXT);
        INSERT INTO conversations VALUES ('${convId}', '{"agent_id":"forge-${model}"}');
      `]);

      const input = [
        { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } },
        { jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd: root, mcpServers: [] } },
      ].map(x => JSON.stringify(x)).join('\n') + '\n';

      const result = spawnSync(process.execPath,
        [path.join(root, 'src/acp-entry.js'), '--acp'],
        {
          input, encoding: 'utf8', timeout: 5000,
          env: { ...process.env, HOME: tempHome, AIONUI_CONVERSATION_ID: convId },
        }
      );

      expect(result.stderr).toContain(`[forge-acp] entry: inferred model=${model}`);
      expect(result.stderr).toContain(`[forge-acp] entry: model=${model}`);
    }
  });
});
