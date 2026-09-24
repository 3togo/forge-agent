'use strict';
const vm = require('vm');
const Yuanbao = require('../src/adapters/yuanbao-adapter');

test('readiness preserves the visible login dialog and rejects unauthenticated composer', async () => {
  const dialog = { className: 'login-dialog', textContent: '请登录', getClientRects: () => [{}] };
  const page = {
    evaluate: jest.fn(fn => vm.runInNewContext(`(${fn.toString()})()`, {
      document: { body: { textContent: '请登录' }, querySelectorAll: () => [dialog] },
      getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    })),
  };
  const adapter = new Yuanbao(page, {});
  adapter._findComposer = jest.fn().mockResolvedValue({});
  adapter._dismissOverlays = jest.fn();
  expect(await adapter.isReady()).toBe(false);
  expect(adapter._dismissOverlays).not.toHaveBeenCalled();
});

test('readiness accepts restored login behind a generic Yuanbao promotion dialog', async () => {
  const promotion = {
    className: 't-dialog__position t-dialog--center',
    textContent: 'AI Image Generation — Join Now',
    getClientRects: () => [{}],
  };
  const page = {
    evaluate: jest.fn(fn => vm.runInNewContext(`(${fn.toString()})()`, {
      document: { body: { textContent: 'New Chat Recent' }, querySelectorAll: () => [promotion] },
      getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    })),
  };
  const adapter = new Yuanbao(page, {});
  adapter._findComposer = jest.fn().mockResolvedValue({});
  adapter._dismissOverlays = jest.fn().mockResolvedValue();
  expect(await adapter.isReady()).toBe(true);
  expect(adapter._dismissOverlays).toHaveBeenCalledTimes(1);
});

test('dedicated login flow opens Yuanbao login panel from its real login button', async () => {
  const trigger = { isVisible: jest.fn().mockResolvedValue(true), click: jest.fn().mockResolvedValue() };
  const absentPanel = { count: jest.fn().mockResolvedValue(0) };
  const page = {
    locator: jest.fn(selector => selector.startsWith('.hyc-login__dialog')
      ? absentPanel
      : { first: () => trigger }),
    waitForTimeout: jest.fn().mockResolvedValue(),
  };
  const adapter = new Yuanbao(page, {});
  expect(await adapter.prepareLogin()).toBe(true);
  expect(trigger.click).toHaveBeenCalledWith({ timeout: 3000 });
});
