'use strict';
jest.mock('../src/browser');
jest.mock('../src/browser-auth', () => ({ saveAuth: jest.fn().mockResolvedValue() }));
const Browser = require('../src/browser');
const config = require('../src/config');
const { login } = require('../src/browser-login');
const { saveAuth } = require('../src/browser-auth');
let browser;
beforeEach(() => {
  jest.clearAllMocks();
  browser = { page: { isClosed: () => false, waitForTimeout: jest.fn().mockResolvedValue() },
    adapter: { isReady: jest.fn().mockResolvedValue(true) }, context: {}, close: jest.fn().mockResolvedValue() };
  browser.launch = jest.fn(async () => browser._checkLoginAndAttemptQr());
  Browser.mockImplementation(() => browser);
});
test('login uses a separate headed profile, validates readiness and saves auth', async () => {
  const previous = { ...config };
  browser.launch.mockImplementation(async () => {
    expect(config.HEADLESS).toBe(false);
    expect(config.SESSION_DIR).toMatch(/login-profiles\/yuanbao$/);
    await browser._checkLoginAndAttemptQr();
  });
  const file = await login('元宝');
  expect(file).toMatch(/acp-auth\/yuanbao.json$/);
  expect(saveAuth).toHaveBeenCalledWith(browser.context, file, 'https://yuanbao.tencent.com/chat');
  expect(browser.close).toHaveBeenCalled();
  expect(config).toEqual(previous);
});
test('timeout does not save credentials and closes browser', async () => {
  await expect(login('yuanbao', { timeout: 0 })).rejects.toThrow('timed out');
  expect(saveAuth).not.toHaveBeenCalled();
  expect(browser.close).toHaveBeenCalled();
});
test('closing login window fails without saving', async () => {
  browser.page.isClosed = () => true;
  await expect(login('yuanbao')).rejects.toThrow('closed');
  expect(saveAuth).not.toHaveBeenCalled();
});

test('polls readiness instead of treating a saved auth file as proof of login', async () => {
  browser.adapter.isReady.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  await login('yuanbao');
  expect(browser.adapter.isReady).toHaveBeenCalledTimes(2);
  expect(browser.page.waitForTimeout).toHaveBeenCalledWith(1000);
  expect(saveAuth).toHaveBeenCalledTimes(1);
});

test('launch failure closes the browser and restores configuration', async () => {
  const previous = { ...config };
  browser.launch.mockRejectedValue(new Error('launch failed'));
  await expect(login('yuanbao')).rejects.toThrow('launch failed');
  expect(saveAuth).not.toHaveBeenCalled();
  expect(browser.close).toHaveBeenCalledTimes(1);
  expect(config).toEqual(previous);
});

test('credential persistence failure propagates and still closes the browser', async () => {
  const previous = { ...config };
  saveAuth.mockRejectedValueOnce(new Error('disk full'));
  await expect(login('yuanbao')).rejects.toThrow('disk full');
  expect(browser.close).toHaveBeenCalledTimes(1);
  expect(config).toEqual(previous);
});
