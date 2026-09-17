'use strict';
const { chromium } = require('playwright');
const DoubaoAdapter = require('../src/adapters/doubao-adapter');
describe('Doubao response detection', () => {
  let browser, page, adapter;
  beforeAll(async () => { browser = await chromium.launch(); });
  afterAll(async () => { await browser?.close(); });
  beforeEach(async () => { page = await browser.newPage(); adapter = new DoubaoAdapter(page, {}); });
  afterEach(async () => { await page.close(); });
  test.each([
    '<div class="list_items"><div class="v_list_row">Hi</div></div>',
    '<div data-message-role="assistant">Hi</div>',
    '<div class="flow-markdown-body">Hi</div>',
    '<div class="markdown-body">Hi</div>',
  ])('reads short replies from supported message layouts', async html => {
    await page.setContent(html);
    expect(await adapter._getLastAssistantText()).toBe('Hi');
  });
  test('ignores editor and user content and preserves code blocks', async () => {
    await page.setContent('<div contenteditable="true"><div class="markdown-body">editor</div></div><div data-message-role="user"><div class="markdown-body">user</div></div><div data-message-role="assistant"><p>Answer</p><pre><code class="language-js">const x = 1;</code></pre></div>');
    expect(await adapter._getLastAssistantText()).toContain('```js\nconst x = 1;\n```');
  });
  test('unrelated loading and cursor classes do not block a finished answer', async () => {
    await page.setContent('<div class="cursor-pointer">sidebar</div><div class="loading">unrelated</div>');
    expect(await adapter._isGenerating()).toBe(false);
    await page.setContent('<button aria-label="停止生成">Stop</button>');
    expect(await adapter._isGenerating()).toBe(true);
  });
  test('hidden assistant nodes and trailing user messages do not replace the reply', async () => {
    await page.setContent('<div data-message-role="assistant">Visible reply</div><div data-message-role="assistant" style="display:none">Hidden reply</div><div data-message-role="user">Latest user prompt</div>');
    expect(await adapter._getLastAssistantText()).toBe('Visible reply');
  });
  test('legacy response rows exclude suggestion chips and action labels', async () => {
    await page.setContent('<div class="list_items"><div class="v_list_row"><p>Reply</p><div class="suggest-message-list-wrapper">Suggested followup</div><div class="message-action-bar">Copy</div></div></div>');
    expect(await adapter._getLastAssistantText()).toBe('Reply');
  });
  test('user-only messages and composer content are not assistant responses', async () => {
    await page.setContent('<div data-message-role="user"><div class="markdown-body">User prompt</div></div><div contenteditable="true"><div class="reply">Draft</div></div>');
    expect(await adapter._getLastAssistantText()).toBeNull();
  });
  test('a visible stop control is detected even when an earlier match is hidden', async () => {
    await page.setContent('<button aria-label="停止" style="display:none">Hidden</button><button aria-label="停止">Stop</button>');
    expect(await adapter._isGenerating()).toBe(true);
  });
  test('completed reply returns while unrelated cursor styling remains', async () => {
    await page.setContent('<div class="cursor-pointer">sidebar</div><div data-message-role="assistant">Completed answer</div>');
    const wait = page.waitForTimeout.bind(page);
    jest.spyOn(page, 'waitForTimeout').mockImplementation(() => wait(10));
    expect(await adapter.waitForResponse()).toBe('Completed answer');
  });
});
