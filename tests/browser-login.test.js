'use strict';
const fs = require('fs');
jest.mock('../src/browser');
jest.mock('../src/browser-auth', () => ({
  saveAuth: jest.fn().mockResolvedValue(),
  isAuthValid: jest.fn().mockReturnValue(false),
}));
const Browser = require('../src/browser');
const config = require('../src/config');
const { login } = require('../src/browser-login');
const { saveAuth } = require('../src/browser-auth');
let browser;
let ui;
const testLogin = (model, options = {}) => login(model, { headlessQr: false, ui, ...options });
beforeEach(() => {
  jest.clearAllMocks();
  ui = {
    start: jest.fn(), browserOpened: jest.fn(), waiting: jest.fn(),
    verified: jest.fn(), saved: jest.fn(), checkingExisting: jest.fn(),
    existingLoginRequired: jest.fn(), refreshed: jest.fn(),
    preparingQr: jest.fn(), qrReady: jest.fn(), qrUnavailable: jest.fn(),
    forcingRelogin: jest.fn(), reloginReverted: jest.fn(),
  };
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
  const file = await testLogin('元宝');
  expect(file).toMatch(/acp-auth\/yuanbao.json$/);
  expect(saveAuth).toHaveBeenCalledWith(browser.context, file, 'https://yuanbao.tencent.com/chat');
  expect(browser.close).toHaveBeenCalled();
  expect(ui.start).toHaveBeenCalledWith(expect.objectContaining({
    provider: 'Yuanbao (元宝)', credentialFile: file, timeout: 180000,
    existingCredential: false,
  }));
  expect(ui.verified).toHaveBeenCalledWith({ reused: false });
  expect(ui.saved).toHaveBeenCalledWith(file);
  expect(config).toEqual(previous);
});
test('timeout does not save credentials and closes browser', async () => {
  await expect(testLogin('yuanbao', { timeout: 0 })).rejects.toThrow('timed out');
  expect(saveAuth).not.toHaveBeenCalled();
  expect(browser.close).toHaveBeenCalled();
});
test('closing login window fails without saving', async () => {
  browser.page.isClosed = () => true;
  await expect(testLogin('yuanbao')).rejects.toThrow('closed');
  expect(saveAuth).not.toHaveBeenCalled();
});

test('polls readiness instead of treating a saved auth file as proof of login', async () => {
  browser.adapter.isReady.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  browser.adapter.prepareLogin = jest.fn().mockResolvedValue(true);
  await testLogin('yuanbao');
  expect(browser.adapter.isReady).toHaveBeenCalledTimes(2);
  expect(browser.page.waitForTimeout).toHaveBeenCalledWith(1000);
  expect(browser.adapter.prepareLogin).toHaveBeenCalledTimes(1);
  expect(ui.browserOpened).toHaveBeenCalledWith(true);
  expect(ui.waiting).toHaveBeenCalled();
  expect(saveAuth).toHaveBeenCalledTimes(1);
});

test('labels an existing valid session instead of making an immediate close look like failed login', async () => {
  const credentialStore = {
    file: '/tmp/yuanbao.json', isValid: () => true,
    save: jest.fn().mockResolvedValue(),
  };
  await testLogin('yuanbao', { credentialStore });
  expect(ui.checkingExisting).toHaveBeenCalledWith(expect.objectContaining({
    provider: 'Yuanbao (元宝)', credentialFile: '/tmp/yuanbao.json',
  }));
  expect(ui.start).not.toHaveBeenCalled();
  expect(ui.refreshed).toHaveBeenCalledWith('/tmp/yuanbao.json');
});

test('falls back from quiet verification to guided login when saved credentials expired', async () => {
  const credentialStore = {
    file: '/tmp/yuanbao.json', isValid: () => true,
    restore: jest.fn().mockResolvedValue(), save: jest.fn().mockResolvedValue(),
  };
  browser.adapter.isReady.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  browser.adapter.prepareLogin = jest.fn().mockResolvedValue(true);
  await testLogin('yuanbao', { credentialStore });
  expect(ui.existingLoginRequired).toHaveBeenCalledTimes(1);
  expect(ui.start).toHaveBeenCalledTimes(1);
  expect(ui.verified).toHaveBeenCalledWith({ reused: false });
  expect(browser.close).toHaveBeenCalledTimes(2);
});

test('extracts Yuanbao QR in a headless session and saves credentials after scan', async () => {
  const qrDetails = { imagePath: '/tmp/yuanbao-qr.png', qrUrl: null };
  class FakeQrLogin {
    constructor(_page, model, options) {
      expect(model).toBe('yuanbao');
      expect(options.isLoginSuccess).toEqual(expect.any(Function));
    }
    async tryQrLogin(onReady) { await onReady(qrDetails); return true; }
    _cleanup() {}
  }
  browser.adapter.isReady.mockResolvedValue(false);
  browser.adapter.prepareLogin = jest.fn().mockResolvedValue(true);
  browser.launch.mockImplementation(async () => {
    expect(config.HEADLESS).toBe(true);
    await browser._checkLoginAndAttemptQr();
  });

  await login('yuanbao', { ui, QrLogin: FakeQrLogin });

  expect(ui.preparingQr).toHaveBeenCalledWith(expect.objectContaining({ provider: 'Yuanbao (元宝)' }));
  expect(ui.qrReady).toHaveBeenCalledWith(qrDetails);
  expect(ui.start).not.toHaveBeenCalled();
  expect(saveAuth).toHaveBeenCalledTimes(1);
});

test.each([
  ['doubao', 'Doubao (豆包)'],
  ['deepseek', 'DeepSeek'],
])('extracts %s QR in a headless session', async (model, provider) => {
  class FakeQrLogin {
    constructor(_page, receivedModel) { expect(receivedModel).toBe(model); }
    async tryQrLogin() { return true; }
    _cleanup() {}
  }
  browser.adapter.isReady.mockResolvedValue(false);
  browser.adapter.prepareLogin = jest.fn().mockResolvedValue(true);
  browser.launch.mockImplementation(async () => browser._checkLoginAndAttemptQr());

  await login(model, { ui, QrLogin: FakeQrLogin });

  expect(ui.preparingQr).toHaveBeenCalledWith(expect.objectContaining({ provider }));
  expect(saveAuth).toHaveBeenCalledTimes(1);
});

test('force relogin bypasses valid credentials and uses a disposable fresh profile', async () => {
  const temporaryProfile = '/tmp/yuanbao-relogin-test-profile';
  const mkdtemp = jest.spyOn(fs, 'mkdtempSync').mockReturnValue(temporaryProfile);
  const remove = jest.spyOn(fs, 'rmSync').mockImplementation(() => {});
  const credentialStore = {
    file: '/tmp/existing-yuanbao.json', isValid: () => true,
    save: jest.fn().mockResolvedValue(), backup: jest.fn().mockReturnValue({
      existed: true, file: '/tmp/existing-yuanbao.json.backup',
    }),
    restoreBackup: jest.fn(),
  };
  class FakeQrLogin {
    async tryQrLogin() { return true; }
    _cleanup() {}
  }
  browser.adapter.isReady.mockResolvedValue(false);
  browser.adapter.prepareLogin = jest.fn().mockResolvedValue(true);
  browser.launch.mockImplementation(async () => {
    expect(config.HEADLESS).toBe(true);
    expect(config.SESSION_DIR).toBe(temporaryProfile);
    await browser._checkLoginAndAttemptQr();
  });

  try {
    await login('yuanbao', { ui, credentialStore, QrLogin: FakeQrLogin, forceRelogin: true });
    expect(ui.forcingRelogin).toHaveBeenCalledWith({
      provider: 'Yuanbao (元宝)', credentialFile: '/tmp/existing-yuanbao.json',
      backupFile: '/tmp/existing-yuanbao.json.backup',
    });
    expect(ui.checkingExisting).not.toHaveBeenCalled();
    expect(credentialStore.save).toHaveBeenCalledWith(browser.context);
    expect(credentialStore.backup).toHaveBeenCalledTimes(1);
    expect(credentialStore.restoreBackup).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledWith(temporaryProfile, { recursive: true, force: true });
  } finally {
    mkdtemp.mockRestore();
    remove.mockRestore();
  }
});

test('force relogin restores the credential backup when authentication fails', async () => {
  const checkpoint = { existed: true, file: '/tmp/yuanbao.json.backup' };
  const credentialStore = {
    file: '/tmp/yuanbao.json', isValid: () => true,
    backup: jest.fn().mockReturnValue(checkpoint),
    restoreBackup: jest.fn(), save: jest.fn(),
  };
  const mkdtemp = jest.spyOn(fs, 'mkdtempSync').mockReturnValue('/tmp/yuanbao-failed-profile');
  const remove = jest.spyOn(fs, 'rmSync').mockImplementation(() => {});
  browser.launch.mockRejectedValue(new Error('login failed'));
  try {
    await expect(login('yuanbao', {
      ui, credentialStore, forceRelogin: true, headlessQr: false,
    })).rejects.toThrow('login failed');
    expect(credentialStore.restoreBackup).toHaveBeenCalledWith(checkpoint);
    expect(ui.reloginReverted).toHaveBeenCalledWith({
      credentialFile: '/tmp/yuanbao.json', backupFile: '/tmp/yuanbao.json.backup',
    });
  } finally {
    mkdtemp.mockRestore();
    remove.mockRestore();
  }
});

test('launch failure closes the browser and restores configuration', async () => {
  const previous = { ...config };
  browser.launch.mockRejectedValue(new Error('launch failed'));
  await expect(testLogin('yuanbao')).rejects.toThrow('launch failed');
  expect(saveAuth).not.toHaveBeenCalled();
  expect(browser.close).toHaveBeenCalledTimes(1);
  expect(config).toEqual(previous);
});

test('credential persistence failure propagates and still closes the browser', async () => {
  const previous = { ...config };
  saveAuth.mockRejectedValueOnce(new Error('disk full'));
  await expect(testLogin('yuanbao')).rejects.toThrow('disk full');
  expect(browser.close).toHaveBeenCalledTimes(1);
  expect(config).toEqual(previous);
});
