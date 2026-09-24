'use strict';

const { LOGIN_STATES, probeProviderLogin } = require('../src/provider-login-status');

function browserFixture({ ready = true, evaluateValue = false } = {}) {
  const editable = { isEditable: jest.fn().mockResolvedValue(ready), isVisible: jest.fn().mockResolvedValue(ready) };
  const page = {
    goto: jest.fn().mockResolvedValue(), waitForTimeout: jest.fn().mockResolvedValue(),
    locator: jest.fn(() => ({ count: jest.fn().mockResolvedValue(ready ? 1 : 0), nth: jest.fn(() => editable) })),
    evaluate: jest.fn().mockResolvedValue(evaluateValue), $: jest.fn().mockResolvedValue(ready ? editable : null),
    keyboard: { press: jest.fn().mockResolvedValue() },
  };
  const browser = {
    newContext: jest.fn().mockResolvedValue({ newPage: jest.fn().mockResolvedValue(page) }),
    close: jest.fn().mockResolvedValue(),
  };
  return { page, browser, browserType: { launch: jest.fn().mockResolvedValue(browser) } };
}

test.each([
  ['yuanbao', 'https://yuanbao.tencent.com/chat', true],
  ['doubao', 'https://www.doubao.com/chat', false],
  ['deepseek', 'https://chat.deepseek.com', false],
])('probes saved %s credentials against its provider page', async (model, url, evaluateValue) => {
  const fixture = browserFixture({ evaluateValue });
  const store = { file: `/state/${model}.json`, isValid: () => true, restore: jest.fn().mockResolvedValue() };
  const result = await probeProviderLogin(model, {
    credentialStore: store, browserType: fixture.browserType, settleDelay: 0,
  });
  expect(result.state).toBe(LOGIN_STATES.LOGGED_IN);
  expect(result.model).toBe(model);
  expect(fixture.page.goto).toHaveBeenCalledWith(url, expect.any(Object));
  expect(fixture.browser.close).toHaveBeenCalled();
});
