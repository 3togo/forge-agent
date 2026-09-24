'use strict';

const { chromium } = require('playwright');
const { applyYuanbaoEngine } = require('../src/yuanbao-web-options');

let browser;
let page;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});

afterAll(async () => {
  await browser?.close();
});

beforeEach(async () => {
  page = await browser.newPage();
  await page.setContent(`
    <button aria-label="Switch model" onclick="document.querySelector('#outer').hidden=false">Expert</button>
    <div id="outer" role="menu" hidden>
      <button role="menuitem" aria-label="Select model" onclick="document.querySelector('#models').hidden=false">Models</button>
    </div>
    <div id="models" role="menu" hidden>
      <button role="menuitemradio" aria-checked="true" onclick="selectEngine(this)">Hy4 preview</button>
      <button role="menuitemradio" aria-checked="false" onclick="selectEngine(this)">Hy3 Recommended for daily use</button>
      <button role="menuitemradio" aria-checked="false" onclick="selectEngine(this)">DeepSeek Suitable for deep thinking</button>
    </div>
    <script>
      function selectEngine(target) {
        document.querySelectorAll('[role=menuitemradio]').forEach(item => item.setAttribute('aria-checked', String(item === target)));
      }
    </script>
  `);
});

afterEach(async () => {
  await page?.close();
});

test.each([
  ['hy3', 'Hy3 Recommended for daily use'],
  ['deepseek', 'DeepSeek Suitable for deep thinking'],
])('maps tray engine %s onto the provider model menu', async (engine, label) => {
  await expect(applyYuanbaoEngine(page, engine)).resolves.toBe(true);
  await expect(page.getByRole('menuitemradio', { name: label }).getAttribute('aria-checked')).resolves.toBe('true');
});

test('rejects provider-native capabilities instead of clicking an arbitrary option', async () => {
  await expect(applyYuanbaoEngine(page, 'deep-research')).rejects.toThrow('Unsupported Yuanbao engine');
});
