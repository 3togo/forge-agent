'use strict';
const { chromium } = require('playwright');
const Yuanbao = require('../src/adapters/yuanbao-adapter');

describe('Yuanbao response DOM extraction', () => {
  let browser, page, adapter;
  beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
  afterAll(async () => { await browser?.close(); });
  beforeEach(async () => { page = await browser.newPage(); adapter = new Yuanbao(page, {}); });
  afterEach(async () => { await page.close(); });

  test('excludes processing status from provider reply without stripping matching answer text', async () => {
    await page.setContent(`<div class="agent-chat__list__item--ai">
      <div class="hyc-component-deep-search-agent__think__header">
        <div class="hyc-component-deep-search-agent__think__header__title"><span>已处理</span></div>
      </div>
      <div class="markdown-body"><p>FORGE_LIVE_OK_0_0</p><p>已处理 is part of this answer.</p></div>
    </div>`);
    const text = await adapter._getLastAssistantText();
    expect(text.startsWith('FORGE_LIVE_OK_0_0')).toBe(true);
    expect(text).toContain('已处理 is part of this answer.');
  });

  test('selects the latest assistant reply and preserves code, excluding user and editor text', async () => {
    await page.setContent(`<div data-message-role="assistant"><p>old</p></div>
      <div data-message-role="user">user text</div>
      <div data-message-role="assistant"><p>new</p><pre><code class="language-js">const n = 1;</code></pre></div>
      <div contenteditable="true">draft</div>`);
    expect(await adapter._getLastAssistantText()).toBe('new\n\n```js\nconst n = 1;\n```');
  });
});
