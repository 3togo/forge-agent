'use strict';

const { chromium } = require('playwright');
const { CredentialStore, normalizeModel } = require('./credential-store');
const { getAdapter, getModelDisplayName, getModelUrl, SUPPORTED_MODELS } = require('./adapter-factory');

const LOGIN_STATES = Object.freeze({
  CHECKING: 'checking',
  LOGGED_IN: 'logged-in',
  LOGIN_REQUIRED: 'login-required',
  ERROR: 'error',
});

async function probeProviderLogin(model, options = {}) {
  model = normalizeModel(model);
  if (!SUPPORTED_MODELS.includes(model)) throw new Error(`Unsupported model: ${model}`);
  const provider = getModelDisplayName(model);
  const store = options.credentialStore || CredentialStore.forModel(model);
  if (!store.isValid()) {
    return {
      model,
      state: LOGIN_STATES.LOGIN_REQUIRED,
      detail: `No usable saved ${provider} login`,
      credentialFile: store.file,
    };
  }

  const browserType = options.browserType || chromium;
  let browser;
  try {
    browser = await browserType.launch({ headless: true });
    const context = await browser.newContext();
    await store.restore(context);
    const page = await context.newPage();
    await page.goto(getModelUrl(model), {
      waitUntil: 'domcontentloaded',
      timeout: options.timeout || 30_000,
    });
    await page.waitForTimeout(options.settleDelay ?? 1500);
    const adapter = getAdapter(model, page, { LOGIN_QUIET: true, HEALTH_CHECK_TIMEOUT: 5000 });
    const ready = await adapter.isReady();
    return {
      model,
      state: ready ? LOGIN_STATES.LOGGED_IN : LOGIN_STATES.LOGIN_REQUIRED,
      detail: ready ? `${provider} confirmed the saved session` : `${provider} requested authentication`,
      credentialFile: store.file,
    };
  } catch (error) {
    return {
      model,
      state: LOGIN_STATES.ERROR,
      detail: String(error.message || error).split('\n')[0],
      credentialFile: store.file,
    };
  } finally {
    try { await browser?.close(); } catch {}
  }
}

module.exports = { LOGIN_STATES, probeProviderLogin };
