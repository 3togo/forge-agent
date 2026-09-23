'use strict';
const path = require('path');
const os = require('os');
const config = require('./config');
const Browser = require('./browser');
const { getModelUrl } = require('./adapter-factory');
const { saveAuth } = require('./browser-auth');

async function login(model, { timeout = 180000 } = {}) {
  model = ({ '元宝': 'yuanbao', '豆包': 'doubao', google: 'gemini', bard: 'gemini', r1: 'deepseek', 'deepseek-r1': 'deepseek' })[model] || model;
  getModelUrl(model);
  const base = path.join(os.homedir(), '.deepseek-agent');
  const file = path.join(base, 'acp-auth', `${model}.json`);
  const previous = { ...config };
  Object.assign(config, { MODEL: model, HEADLESS: false, BROWSER_MINIMIZED: false,
    SESSION_DIR: path.join(base, 'login-profiles', model), ACP_AUTH_FILE: file });
  const browser = new Browser();
  browser._checkLoginAndAttemptQr = async () => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (browser.page.isClosed()) throw new Error('Login browser was closed before login completed.');
      if (await browser.adapter.isReady()) return;
      await browser.page.waitForTimeout(1000);
    }
    throw new Error('Login timed out. Run the login command again.');
  };
  try {
    await browser.launch();
    await saveAuth(browser.context, file, getModelUrl(model));
    return file;
  } finally {
    await browser.close();
    for (const key of Object.keys(config)) if (!(key in previous)) delete config[key];
    Object.assign(config, previous);
  }
}
module.exports = { login };
