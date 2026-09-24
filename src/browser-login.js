'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const config = require('./config');
const Browser = require('./browser');
const { getModelUrl, getModelDisplayName } = require('./adapter-factory');
const { CredentialStore, normalizeModel } = require('./credential-store');
const { LoginUI } = require('./login-ui');
const { QrLoginManager } = require('./qr-login');

async function login(model, {
  timeout = 180000,
  credentialStore,
  ui = new LoginUI(),
  headlessQr = true,
  QrLogin = QrLoginManager,
  forceRelogin = false,
} = {}) {
  model = normalizeModel(model);
  getModelUrl(model);
  const base = path.join(os.homedir(), '.deepseek-agent');
  const store = credentialStore || CredentialStore.forModel(model, { baseDirectory: base });
  const existingCredential = !forceRelogin && typeof store.isValid === 'function' && store.isValid();
  const provider = getModelDisplayName(model);
  const previous = { ...config };
  const profileRoot = path.join(base, 'login-profiles');
  let credentialBackup = null;
  let reloginSucceeded = false;
  let temporarySessionDirectory = null;
  let sessionDirectory = path.join(profileRoot, model);
  if (forceRelogin) {
    credentialBackup = store.backup?.() || null;
    fs.mkdirSync(profileRoot, { recursive: true, mode: 0o700 });
    temporarySessionDirectory = fs.mkdtempSync(path.join(profileRoot, `${model}-relogin-`));
    sessionDirectory = temporarySessionDirectory;
    ui.forcingRelogin?.({ provider, credentialFile: store.file, backupFile: credentialBackup?.file });
  }

  async function verifyExistingLogin() {
    ui.checkingExisting({ provider, credentialFile: store.file });
    Object.assign(config, {
      MODEL: model, HEADLESS: true, BROWSER_MINIMIZED: false,
      SESSION_DIR: sessionDirectory, ACP_AUTH_FILE: null, LOGIN_QUIET: true,
    });
    const browser = new Browser({ credentialStore: store, quiet: true });
    browser._checkLoginAndAttemptQr = async () => {
      if (browser.page.isClosed()) throw new Error('Login verification browser closed unexpectedly.');
      if (await browser.adapter.isReady()) return;
      const error = new Error('Saved login requires renewal.');
      error.loginRequired = true;
      throw error;
    };
    try {
      await browser.launch();
      await store.save(browser.context);
      ui.refreshed(store.file);
      return true;
    } catch (error) {
      if (!error.loginRequired) throw error;
      ui.existingLoginRequired();
      return false;
    } finally {
      await browser.close();
    }
  }

  async function interactiveLogin() {
    ui.start({ provider, credentialFile: store.file, timeout, existingCredential: false });
    Object.assign(config, {
      MODEL: model, HEADLESS: false, BROWSER_MINIMIZED: false,
      SESSION_DIR: sessionDirectory, ACP_AUTH_FILE: null, LOGIN_QUIET: false,
    });
    const browser = new Browser();
    browser._checkLoginAndAttemptQr = async () => {
      const deadline = Date.now() + timeout;
      let loginPanelOpened = false;
      while (Date.now() < deadline) {
        if (browser.page.isClosed()) throw new Error('Login browser was closed before login completed.');
        if (await browser.adapter.isReady()) {
          ui.verified({ reused: false });
          return;
        }
        if (!loginPanelOpened) {
          loginPanelOpened = Boolean(await browser.adapter.prepareLogin?.());
          ui.browserOpened(loginPanelOpened);
        }
        ui.waiting(deadline - Date.now());
        await browser.page.waitForTimeout(1000);
      }
      throw new Error('Login timed out. Run the login command again.');
    };
    try {
      await browser.launch();
      await store.save(browser.context);
      ui.saved(store.file);
    } finally {
      await browser.close();
    }
  }

  async function headlessQrLogin() {
    ui.preparingQr({ provider, timeout });
    Object.assign(config, {
      MODEL: model, HEADLESS: true, BROWSER_MINIMIZED: false,
      SESSION_DIR: sessionDirectory, ACP_AUTH_FILE: null, LOGIN_QUIET: true,
    });
    const browser = new Browser({ quiet: true });
    let manager;
    browser._checkLoginAndAttemptQr = async () => {
      if (browser.page.isClosed()) throw new Error('Headless QR login browser closed unexpectedly.');
      if (await browser.adapter.isReady()) return;
      await browser.adapter.prepareLogin?.();
      manager = new QrLogin(browser.page, model, {
        timeout,
        isLoginSuccess: () => browser.adapter.isReady(),
      });
      const authenticated = await manager.tryQrLogin(details => ui.qrReady(details));
      if (authenticated) return;
      const error = new Error(manager.lastFailure === 'timeout'
        ? 'QR login timed out. Run the login command again for a fresh code.'
        : `${provider} QR code could not be extracted.`);
      error.qrUnavailable = manager.lastFailure !== 'timeout';
      throw error;
    };
    try {
      await browser.launch();
      await store.save(browser.context);
      ui.saved(store.file);
      return true;
    } catch (error) {
      if (!error.qrUnavailable) throw error;
      ui.qrUnavailable();
      return false;
    } finally {
      manager?._cleanup();
      await browser.close();
    }
  }

  try {
    if (existingCredential && await verifyExistingLogin()) return store.file;
    if (headlessQr && ['yuanbao', 'doubao', 'deepseek'].includes(model) && await headlessQrLogin()) {
      reloginSucceeded = true;
      return store.file;
    }
    await interactiveLogin();
    reloginSucceeded = true;
    return store.file;
  } finally {
    for (const key of Object.keys(config)) if (!(key in previous)) delete config[key];
    Object.assign(config, previous);
    if (forceRelogin && !reloginSucceeded && credentialBackup && store.restoreBackup) {
      store.restoreBackup(credentialBackup);
      ui.reloginReverted?.({ credentialFile: store.file, backupFile: credentialBackup.file });
    }
    if (temporarySessionDirectory) {
      fs.rmSync(temporarySessionDirectory, { recursive: true, force: true });
    }
  }
}
module.exports = { login };
