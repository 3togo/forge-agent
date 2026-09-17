'use strict';
const { chromium } = require('playwright');
const DoubaoAdapter = require('../src/adapters/doubao-adapter');

describe('Doubao composer with real Playwright locators', () => {
  let browser, page, adapter;
  beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
  afterAll(async () => { await browser?.close(); });
  beforeEach(async () => {
    page = await browser.newPage();
    adapter = new DoubaoAdapter(page, {});
  });
  afterEach(async () => { await page.close(); });
  test.each([
    '<textarea placeholder="发消息"></textarea>',
    '<div class="ProseMirror" contenteditable="true"></div>',
  ])('fills and verifies multiline text in %s', async html => {
    await page.setContent(html);
    const input = await adapter._prepareInput('first line\n\n   indented line\nsecond line', 2000);
    expect(input).not.toBeNull();
    expect(await input.evaluate(el => 'value' in el ? el.value : el.textContent)).toContain('second line');
  });
  test('ignores earlier wrappers, disabled inputs and unrelated textareas', async () => {
    await page.setContent('<div class="semi-input-textarea">wrapper</div><textarea disabled></textarea><textarea placeholder="search"></textarea><div class="ProseMirror" contenteditable="true"></div>');
    const input = await adapter._prepareInput('hello', 2000);
    expect(await input.getAttribute('class')).toBe('ProseMirror');
    expect(await page.locator('textarea').nth(1).inputValue()).toBe('');
  });
  test('readiness requires an editable input rather than just a visible wrapper', async () => {
    await page.setContent('<div class="semi-input-textarea">wrapper</div><textarea disabled></textarea>');
    expect(await adapter.isReady()).toBe(false);
  });
  test('verifies an accepted insert even when fill reports a timeout', async () => {
    await page.setContent('<div class="ProseMirror" contenteditable="true"></div>');
    const composer = await adapter._findComposer();
    const fill = composer.fill.bind(composer);
    jest.spyOn(composer, 'fill').mockImplementation(async text => {
      await fill(text);
      throw new Error('locator.fill: Timeout 2000ms exceeded.');
    });
    jest.spyOn(adapter, '_findComposer').mockResolvedValue(composer);
    expect(await adapter._prepareInput('accepted message', 2000)).toBe(composer);
    expect(composer.fill).toHaveBeenCalledTimes(1);
  });
  test('a failed first send keeps the system prompt for retry', async () => {
    jest.spyOn(adapter, '_prepareInput').mockResolvedValueOnce(null);
    await expect(adapter.sendMessage('hello')).rejects.toThrow('composer did not become ready');
    expect(adapter._isFirstMessage).toBe(true);
  });
  test.each(['<textarea placeholder="发消息"></textarea>', '<div class="ProseMirror" contenteditable="true"></div>'])('successful full prompt send with %s', async html => {
    await page.setContent(html + '<script>window.sent=false;document.querySelector("textarea, [contenteditable]").addEventListener("keydown",e=>{if(e.key==="Enter") window.sent=true})</script>');
    await adapter.sendMessage('hello');
    expect(await page.evaluate(() => window.sent)).toBe(true);
    expect(adapter._isFirstMessage).toBe(false);
  });
});
