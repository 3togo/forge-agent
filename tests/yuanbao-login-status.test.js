'use strict';

const { LOGIN_STATES, probeYuanbaoLogin } = require('../src/yuanbao-login-status');

function browserFixture({ ready = true, launchError = null } = {}) {
  const page = {
    goto: jest.fn().mockResolvedValue(),
    waitForTimeout: jest.fn().mockResolvedValue(),
    locator: jest.fn(() => ({
      count: jest.fn().mockResolvedValue(ready ? 1 : 0),
      nth: jest.fn(() => ({ isEditable: jest.fn().mockResolvedValue(ready) })),
    })),
    evaluate: jest.fn().mockResolvedValue(ready),
    $: jest.fn().mockResolvedValue(null),
    keyboard: { press: jest.fn().mockResolvedValue() },
  };
  const context = { newPage: jest.fn().mockResolvedValue(page) };
  const browser = {
    newContext: jest.fn().mockResolvedValue(context),
    close: jest.fn().mockResolvedValue(),
  };
  return {
    page,
    browser,
    browserType: {
      launch: launchError ? jest.fn().mockRejectedValue(launchError) : jest.fn().mockResolvedValue(browser),
    },
  };
}

test('reports login required without launching Chromium when credentials are absent', async () => {
  const fixture = browserFixture();
  const store = { file: '/state/yuanbao.json', isValid: () => false };
  const result = await probeYuanbaoLogin({ credentialStore: store, browserType: fixture.browserType });
  expect(result.state).toBe(LOGIN_STATES.LOGIN_REQUIRED);
  expect(fixture.browserType.launch).not.toHaveBeenCalled();
});

test('confirms a saved login against the live Yuanbao composer', async () => {
  const fixture = browserFixture({ ready: true });
  const store = { file: '/state/yuanbao.json', isValid: () => true, restore: jest.fn().mockResolvedValue() };
  const result = await probeYuanbaoLogin({
    credentialStore: store, browserType: fixture.browserType, settleDelay: 0,
  });
  expect(result.state).toBe(LOGIN_STATES.LOGGED_IN);
  expect(store.restore).toHaveBeenCalled();
  expect(fixture.browser.close).toHaveBeenCalled();
});

test('keeps connectivity errors distinct from an expired login', async () => {
  const fixture = browserFixture({ launchError: new Error('browser unavailable') });
  const store = { file: '/state/yuanbao.json', isValid: () => true };
  const result = await probeYuanbaoLogin({ credentialStore: store, browserType: fixture.browserType });
  expect(result).toEqual(expect.objectContaining({
    state: LOGIN_STATES.ERROR,
    detail: 'browser unavailable',
  }));
});
