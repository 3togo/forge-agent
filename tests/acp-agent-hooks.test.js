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
  test('ACP response timeouts surface without automatically resending a message', async () => {
    config.NO_INTERACTIVE = true;
    const error = Object.assign(new Error('Response timed out'), { acpBrowserRecoverable: true });
    const instance = agent({ executeTool: jest.fn() });
    instance.browser.waitForResponse.mockReset().mockRejectedValue(error);
    await expect(instance.run('hello')).rejects.toBe(error);
    expect(instance.browser.sendMessage).toHaveBeenCalledTimes(1);
  });
  test('non-retryable provider responses surface without a generic protocol nudge', async () => {
    const error = Object.assign(new Error('provider-native execution rejected'), { retryable: false });
    const instance = agent({ executeTool: jest.fn(), conversationalReplies: true });
    instance.browser.waitForResponse.mockReset().mockRejectedValue(error);
    await expect(instance.run('hello')).rejects.toBe(error);
    expect(instance.browser.sendMessage).toHaveBeenCalledTimes(1);
  });
  test.each(['Hello! How can I help?', '你好！有什么可以帮你？', 'Here is the answer.\nSecond paragraph.'])('ACP delivers a conversational reply without asking for tool formatting: %s', async reply => {
    const instance = agent({ executeTool: jest.fn(), conversationalReplies: true });
    instance.browser.waitForResponse.mockReset().mockResolvedValue(reply);
    expect(await instance.run('hi')).toBe(reply);
    expect(instance.browser.sendMessage).toHaveBeenCalledTimes(1);
    expect(instance.browser.waitForResponse).toHaveBeenCalledTimes(1);
  });
  test('ACP conversational mode still executes tool calls before completion', async () => {
    const hook = jest.fn().mockResolvedValue('ok');
    const instance = agent({ executeTool: hook, conversationalReplies: true });
    const result = await instance.run('write a file');
    expect(hook).toHaveBeenCalledTimes(1);
    expect(result).toContain('Done');
  });
  test('executes namespaced workspace requests and returns namespaced results', async () => {
    const hook = jest.fn().mockResolvedValue({ content: 'hello' });
    const instance = agent({ executeTool: hook, conversationalReplies: true });
    instance.browser.waitForResponse.mockReset()
      .mockResolvedValueOnce('<forge_request>{"protocol":"forge-workspace-v1","operation":"forge.workspace.read","arguments":{"path":"README.md"}}</forge_request>')
      .mockResolvedValueOnce('Read complete.');

    expect(await instance.run('read it')).toBe('Read complete.');
    expect(hook).toHaveBeenCalledWith('read_file', { path: 'README.md' });
    const feedback = instance.browser.sendMessage.mock.calls[1][0];
    expect(feedback).toContain('<forge_result>');
    expect(feedback).toContain('"operation":"forge.workspace.read"');
    expect(feedback).not.toContain('[TOOL RESULT:');
  });
  test('a project question returns the answer after reading a file without formatting retries', async () => {
    fs.writeFileSync(path.join(temp, 'README.md'), 'This project handles television schedules.');
    const hook = jest.fn(async () => fs.readFileSync(path.join(temp, 'README.md'), 'utf8'));
    const instance = agent({ executeTool: hook, conversationalReplies: true });
    const answer = 'This project handles television schedules.';
    instance.browser.waitForResponse.mockReset()
      .mockResolvedValueOnce('<tool_call>{"tool":"read_file","args":{"path":"README.md"}}</tool_call>')
      .mockResolvedValue(answer);
    expect(await instance.run('What does this project do?')).toBe(answer);
    expect(hook).toHaveBeenCalledWith('read_file', { path: 'README.md' });
    expect(instance.browser.sendMessage).toHaveBeenCalledTimes(2);
    expect(instance.browser.waitForResponse).toHaveBeenCalledTimes(2);
  });
  test('show_info answer becomes a normal ACP reply instead of TASK_COMPLETE', async () => {
    const answer = '我是元宝。I can use read_file to help with your project.';
    const instance = agent({ executeTool: jest.fn().mockResolvedValue({ displayed: true, content: answer }), conversationalReplies: true });
    instance.browser.waitForResponse.mockReset()
      .mockResolvedValueOnce('<tool_call>{"tool":"show_info","args":{"content":"answer"}}</tool_call>')
      .mockResolvedValueOnce('TASK_COMPLETE');
    expect(await instance.run('who are you?')).toBe(answer);
    expect(instance.browser.sendMessage.mock.calls[1][0]).toContain(answer);
    expect(instance.browser.sendMessage.mock.calls[1][0]).not.toContain('[object Object]');
    instance.browser.waitForResponse.mockReset().mockResolvedValueOnce('TASK_COMPLETE');
    expect(await instance.run('next task')).toBe('Task completed.');
  });
  test('ACP preserves a completion summary and removes the internal marker', async () => {
    const instance = agent({ executeTool: jest.fn(), conversationalReplies: true });
    instance.browser.waitForResponse.mockReset().mockResolvedValueOnce('TASK_COMPLETE\nFinished the checks.');
    expect(await instance.run('check')).toBe('Finished the checks.');
  });
  test('terminal mode retains its permission menu and default executor', async () => {
    await agent({}).run('write a file');
    expect(showPermissionMenu).toHaveBeenCalledTimes(1);
    expect(executeTool).toHaveBeenCalledTimes(1);
  });
});
