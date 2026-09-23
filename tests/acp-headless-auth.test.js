'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');

const root = path.resolve(__dirname, '..');

describe('ACP worker: login separation and headless mode', () => {
  function runWorkerWithEnv(env, ready = true) {
    const workerSrc = fs.readFileSync(path.join(root, 'src/acp-worker.js'), 'utf8');
    const events = [];
    const config = {};
    const agent = {
      browser: { adapter: { isReady: jest.fn().mockResolvedValue(ready) }, context: {} },
      shutdown: jest.fn().mockResolvedValue(),
      run: jest.fn().mockResolvedValue('reply'),
    };
    agent.init = jest.fn(async () => agent.browser._checkLoginAndAttemptQr());
    const stderrLines = [];
    const handlers = {};
    const proc = {
      env: {
        FORGE_ACP_MODEL: 'yuanbao',
        FORGE_ACP_WORKSPACE: '/tmp',
        FORGE_ACP_SESSION_DIR: '/tmp/profile',
        ...env,
      },
      connected: true,
      stdout: {},
      stderr: { write: chunk => stderrLines.push(chunk.toString()) },
      send: event => events.push(event),
      on: (name, handler) => { handlers[name] = handler; },
      exit: jest.fn(),
    };

    const workerPath = path.resolve(root, 'src/acp-worker.js');
    const realRequire = createRequire(workerPath);
    const mockRequire = name => {
      if (name === './browser-monitor') return { BrowserMonitor: class { record() {} } };
      if (name === './agent') return function () { return agent; };
      if (name === './config') return config;
      if (name === './tools') return { executeTool: jest.fn() };
      if (name === './permission-store') return { isReadOnly: () => true };
      return realRequire(name);
    };

    const workerModule = { exports: {} };
    vm.runInNewContext(workerSrc, {
      require: mockRequire, module: workerModule, process: proc, setTimeout,
    }, { filename: workerPath });

    workerModule.exports.main();

    return { stderrLines, events, handlers, agent, config };
  }

  test('missing login ends the turn with a separate command and never attempts QR login', async () => {
    const { events, handlers } = runWorkerWithEnv({}, false);
    handlers.message({ type: 'prompt', text: 'hello' });
    await new Promise(resolve => setImmediate(resolve));
    expect(events.some(e => e.text?.includes('forge-agent --login --model=yuanbao'))).toBe(true);
    expect(events.some(e => e.text?.includes('Attempting QR'))).toBe(false);
    expect(events.some(e => e.type === 'done')).toBe(true);
  });

  test('failed authentication closes startup browser and a retry initializes afresh', async () => {
    const { events, handlers, agent } = runWorkerWithEnv({}, false);
    handlers.message({ type: 'prompt', text: 'first' });
    await new Promise(resolve => setImmediate(resolve));
    expect(agent.run).not.toHaveBeenCalled();
    expect(agent.shutdown).toHaveBeenCalledTimes(1);
    agent.browser.adapter.isReady.mockResolvedValue(true);
    handlers.message({ type: 'prompt', text: 'retry after login' });
    await new Promise(resolve => setImmediate(resolve));
    expect(agent.init).toHaveBeenCalledTimes(2);
    expect(agent.run).toHaveBeenCalledWith('retry after login');
    expect(events.filter(e => e.type === 'done')).toHaveLength(2);
  });

  test('a visible browser requires an explicit diagnostic override', () => {
    const { config } = runWorkerWithEnv({ FORGE_ACP_HEADED: '1' });
    expect(config.HEADLESS).toBe(false);
  });

  test('HEADLESS=true when auth file exists and is valid', () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-headless-'));
    try {
      const authDir = path.join(tempHome, '.deepseek-agent', 'acp-auth');
      fs.mkdirSync(authDir, { recursive: true });
      const authFile = path.join(authDir, 'yuanbao.json');
      const futureExpiry = Math.floor(Date.now() / 1000) + 86400;
      fs.writeFileSync(authFile, JSON.stringify({
        cookies: [{ name: 'session', value: 'abc', domain: 'yuanbao.tencent.com', expires: futureExpiry }],
        origins: [],
      }));

      const { stderrLines } = runWorkerWithEnv({
        FORGE_ACP_AUTH_FILE: authFile,
      });

      const log = stderrLines.join('');
      expect(log).toContain('hasValidAuth=true');
      expect(log).toContain('headlessMode=true');
      expect(log).toContain('config.HEADLESS=true');
    } finally { fs.rmSync(tempHome, { recursive: true, force: true }); }
  });

  test('HEADLESS=true when auth file does not exist', () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-headless-'));
    try {
      const authFile = path.join(tempHome, 'nonexistent.json');

      const { stderrLines } = runWorkerWithEnv({
        FORGE_ACP_AUTH_FILE: authFile,
      });

      const log = stderrLines.join('');
      expect(log).toContain('hasValidAuth=false');
      expect(log).toContain('headlessMode=true');
      expect(log).toContain('config.HEADLESS=true');
    } finally { fs.rmSync(tempHome, { recursive: true, force: true }); }
  });

  test('HEADLESS=true when auth file has expired cookies', () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-headless-'));
    try {
      const authDir = path.join(tempHome, '.deepseek-agent', 'acp-auth');
      fs.mkdirSync(authDir, { recursive: true });
      const authFile = path.join(authDir, 'yuanbao.json');
      const pastExpiry = Math.floor(Date.now() / 1000) - 86400;
      fs.writeFileSync(authFile, JSON.stringify({
        cookies: [{ name: 'session', value: 'abc', domain: 'yuanbao.tencent.com', expires: pastExpiry }],
        origins: [],
      }));

      const { stderrLines } = runWorkerWithEnv({
        FORGE_ACP_AUTH_FILE: authFile,
      });

      const log = stderrLines.join('');
      expect(log).toContain('hasValidAuth=false');
      expect(log).toContain('headlessMode=true');
    } finally { fs.rmSync(tempHome, { recursive: true, force: true }); }
  });

  test('HEADLESS=true when FORGE_ACP_AUTH_FILE is empty string', () => {
    const { stderrLines } = runWorkerWithEnv({
      FORGE_ACP_AUTH_FILE: '',
    });

    const log = stderrLines.join('');
    expect(log).toContain('hasValidAuth=false');
    expect(log).toContain('headlessMode=true');
  });

  test('HEADLESS=true when FORGE_ACP_AUTH_FILE is not set', () => {
    const { stderrLines } = runWorkerWithEnv({});

    const log = stderrLines.join('');
    expect(log).toContain('hasValidAuth=false');
    expect(log).toContain('headlessMode=true');
  });

  test('does not prompt for interactive login without saved auth', () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-headless-'));
    try {
      const authFile = path.join(tempHome, 'nonexistent.json');

      const { events, handlers } = runWorkerWithEnv({
        FORGE_ACP_AUTH_FILE: authFile,
      });

      // Trigger a prompt to start waitForInput
      handlers.message({ type: 'prompt', text: 'hello' });

      // Interactive login must never be requested inside ACP.
      return new Promise(resolve => {
        setImmediate(() => {
          const noLoginMsg = events.find(e =>
            e.type === 'message' && e.text?.includes('No saved login')
          );
          expect(noLoginMsg).toBeUndefined();
          resolve();
        });
      });
    } finally { fs.rmSync(tempHome, { recursive: true, force: true }); }
  });

  test('does not send "No saved login" message when headless (valid auth)', () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-headless-'));
    try {
      const authDir = path.join(tempHome, '.deepseek-agent', 'acp-auth');
      fs.mkdirSync(authDir, { recursive: true });
      const authFile = path.join(authDir, 'yuanbao.json');
      const futureExpiry = Math.floor(Date.now() / 1000) + 86400;
      fs.writeFileSync(authFile, JSON.stringify({
        cookies: [{ name: 'session', value: 'abc', domain: 'yuanbao.tencent.com', expires: futureExpiry }],
        origins: [],
      }));

      const { events, handlers } = runWorkerWithEnv({
        FORGE_ACP_AUTH_FILE: authFile,
      });

      handlers.message({ type: 'prompt', text: 'hello' });

      return new Promise(resolve => {
        setImmediate(() => {
          const noLoginMsg = events.find(e =>
            e.type === 'message' && e.text?.includes('No saved login')
          );
          expect(noLoginMsg).toBeUndefined();
          resolve();
        });
      });
    } finally { fs.rmSync(tempHome, { recursive: true, force: true }); }
  });
});
