'use strict';
const vm = require('vm');
const Yuanbao = require('../src/adapters/yuanbao-adapter');

test('readiness preserves the visible login dialog and rejects unauthenticated composer', async () => {
  const dialog = { getClientRects: () => [{}] };
  const page = {
    evaluate: jest.fn(fn => vm.runInNewContext(`(${fn.toString()})()`, {
      document: { body: { textContent: '' }, querySelector: () => dialog },
      getComputedStyle: () => ({ visibility: 'visible' }),
    })),
  };
  const adapter = new Yuanbao(page, {});
  adapter._findComposer = jest.fn().mockResolvedValue({});
  adapter._dismissOverlays = jest.fn();
  expect(await adapter.isReady()).toBe(false);
  expect(adapter._dismissOverlays).not.toHaveBeenCalled();
});
