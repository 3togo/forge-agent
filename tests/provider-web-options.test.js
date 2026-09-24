'use strict';

const { chromium } = require('playwright');
const { applyProviderMode } = require('../src/provider-web-options');

let browser;
beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
afterAll(async () => { await browser?.close(); });

test.each([
  ['deepseek', 'DeepThink'],
  ['doubao', '深度思考'],
])('applies safe %s reasoning mode without enabling remote tools', async (model, label) => {
  const page = await browser.newPage();
  try {
    await page.setContent(`<button aria-pressed="false" onclick="this.setAttribute('aria-pressed', this.getAttribute('aria-pressed') !== 'true')">${label}</button>`);
    expect(await applyProviderMode(page, model, 'thinking')).toBe(true);
    expect(await page.getByRole('button', { name: label }).getAttribute('aria-pressed')).toBe('true');
    expect(await applyProviderMode(page, model, 'default')).toBe(true);
    expect(await page.getByRole('button', { name: label }).getAttribute('aria-pressed')).toBe('false');
  } finally {
    await page.close();
  }
});

test('ignores unsupported provider-native modes', async () => {
  await expect(applyProviderMode({}, 'deepseek', 'web-search')).rejects.toThrow('Unsupported provider mode');
});
