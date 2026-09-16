'use strict';
jest.mock('../src/browser', () => jest.fn());
jest.mock('../src/permission-menu', () => ({ showPermissionMenu: jest.fn().mockResolvedValue('once') }));
jest.mock('../src/tools', () => ({ executeTool: jest.fn().mockResolvedValue('CLI tool result'), getToolDescriptions: () => 'write_file', cache: { stats: () => ({}) } }));
const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('../src/config');
const logger = require('../src/logger');
const Browser = require('../src/browser');
const Agent = require('../src/agent');
const { executeTool } = require('../src/tools');
const { showPermissionMenu } = require('../src/permission-menu');

describe('real agent loop ACP execution hook', () => {
  let temp, original;
  beforeEach(() => {
    original = { ...config };
    temp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-agent-hook-'));
    Object.assign(config, { WORKING_DIR: temp, MEMORY_ENABLED: false, PLANNING_MODE: false, DEBUG: false, DISABLE_SPONSOR_NUDGE: true });
    for (const key of Object.keys(logger)) if (typeof logger[key] === 'function') jest.spyOn(logger, key).mockImplementation(() => {});
    logger.getTUI.mockReturnValue({ noColor: true });
    Browser.mockImplementation(() => ({
      sendMessage: jest.fn().mockResolvedValue(),
      waitForResponse: jest.fn().mockResolvedValueOnce('<tool_call>{"tool":"write_file","args":{"path":"proof.txt","content":"hello"}}</tool_call>').mockResolvedValue('TASK_COMPLETE\nDone'),
    }));
    executeTool.mockClear(); showPermissionMenu.mockClear();
  });
  afterEach(() => { jest.restoreAllMocks(); Object.assign(config, original); fs.rmSync(temp, { recursive: true, force: true }); });
  function agent(options) {
    const instance = new Agent(options);
    instance._recordHistory = jest.fn();
    return instance;
  }
  test('uses the ACP hook instead of terminal permission fallback', async () => {
    const hook = jest.fn().mockResolvedValue('ACP tool result');
    await agent({ executeTool: hook }).run('write a file');
    expect(hook).toHaveBeenCalledWith('write_file', { path: 'proof.txt', content: 'hello' });
    expect(showPermissionMenu).not.toHaveBeenCalled();
    expect(executeTool).not.toHaveBeenCalled();
  });
  test('decline stops the real loop without retrying or executing', async () => {
    const error = Object.assign(new Error('declined'), { acpDenied: true });
    const hook = jest.fn().mockRejectedValue(error);
    await expect(agent({ executeTool: hook }).run('write a file')).rejects.toBe(error);
    expect(hook).toHaveBeenCalledTimes(1);
    expect(executeTool).not.toHaveBeenCalled();
  });
  test('terminal mode retains its permission menu and default executor', async () => {
    await agent({}).run('write a file');
    expect(showPermissionMenu).toHaveBeenCalledTimes(1);
    expect(executeTool).toHaveBeenCalledTimes(1);
  });
});
