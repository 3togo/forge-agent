'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');

test('a browser error ends the turn, keeps the browser alive, and permits a retry', async () => {
  const handlers = {};
  const events = [];
  const browser = { adapter: { isReady: jest.fn().mockResolvedValue(true) } };
  const agent = {
    browser, init: jest.fn().mockResolvedValue(), shutdown: jest.fn().mockResolvedValue(),
    run: jest.fn().mockRejectedValueOnce(Object.assign(new Error('Composer unavailable'), { acpBrowserRecoverable: true })).mockResolvedValueOnce('Reply'),
  };
  const config = {};
  const workerPath = path.resolve(__dirname, '../src/acp-worker.js');
  const realRequire = createRequire(workerPath);
  const mockRequire = name => {
    if (name === './agent') return function (options) {
      expect(options.conversationalReplies).toBe(true);
      return agent;
    };
    if (name === './config') return config;
    if (name === './tools') return { executeTool: jest.fn() };
    if (name === './permission-store') return { isReadOnly: () => true };
    return realRequire(name);
  };
  const workerModule = { exports: {} };
  const proc = {
    env: { FORGE_ACP_MODEL: 'doubao', FORGE_ACP_WORKSPACE: '/tmp', FORGE_ACP_SESSION_DIR: '/tmp/profile' },
    connected: true, stdout: {}, stderr: { write: jest.fn() },
    send: event => events.push(event), on: (name, handler) => { handlers[name] = handler; }, exit: jest.fn(),
  };
  vm.runInNewContext(fs.readFileSync(workerPath, 'utf8'), {
    require: mockRequire, module: workerModule, process: proc, setTimeout,
  }, { filename: workerPath });
  workerModule.exports.main();
  async function turn(text, expectedDone) {
    handlers.message({ type: 'prompt', text });
    for (let i = 0; i < 50 && events.filter(e => e.type === 'done').length < expectedDone; i++) {
      await new Promise(resolve => setImmediate(resolve));
    }
    expect(events.filter(e => e.type === 'done')).toHaveLength(expectedDone);
  }
  await turn('hello', 1);
  expect(events.some(e => e.type === 'error')).toBe(false);
  expect(events.some(e => e.text?.includes('browser is staying open'))).toBe(true);
  expect(agent.shutdown).not.toHaveBeenCalled();
  await turn('retry', 2);
  expect(agent.init).toHaveBeenCalledTimes(1);
  expect(agent.run).toHaveBeenCalledTimes(2);
  expect(events.some(e => e.text === 'Reply')).toBe(true);
  await handlers.SIGTERM();
  expect(agent.shutdown).toHaveBeenCalledTimes(1);
  expect(proc.exit).toHaveBeenCalledWith(0);
});
