// src/adapters/deepseek-adapter.js — DeepSeek model adapter
'use strict';

const BaseAdapter = require('./base-adapter');
const logger      = require('../logger');
const { Errors }  = require('../errors');
const { withSendRetry, withResponseRetry } = require('../retry');
const { ThinkingTracker, formatThinkingForLog } = require('../thinking');
const { ProviderWebPreferences } = require('../provider-web-preferences');
const { applyProviderMode } = require('../provider-web-options');

/**
 * Adapter for chat.deepseek.com
 */
class DeepSeekAdapter extends BaseAdapter {
  constructor(page, config) {
    super(page, config);
    this._lastTextBefore = '';
    this._ensureThinkingTracker();
    this.selectors = {
      chatInput: [
        '#chat-input',
        'textarea[placeholder]',
        'textarea',
        '[contenteditable="true"][role="textbox"]',
        '[contenteditable="true"]',
      ],
      sendButton: [
        'button[aria-label*="Send" i]',
        'button[aria-label*="send" i]',
        '[data-testid="send-button"]',
        'button[type="submit"]',
        '[class*="send-btn"]',
        '[class*="sendBtn"]',
        '[class*="send-button"]',
      ],
      stopButton: [
        'button[aria-label*="Stop" i]',
        '[aria-label*="stop generating" i]',
        '[data-testid="stop-button"]',
        '[class*="stop-btn"]',
        '[class*="stopBtn"]',
      ],
      newChat: [
        'button[aria-label*="New chat" i]',
        'button[aria-label*="New conversation" i]',
        'a[href="/"][aria-label]',
        '[data-testid="new-chat"]',
        '[class*="new-chat"]',
        '[class*="newChat"]',
      ],
      messageContainer: [
        '[class*="chat-content"]',
        '[class*="message-list"]',
        '[class*="conversation"]',
        'main',
      ],
    };
  }

  // ── ThinkingTracker safety ─────────────────────────────────────────────────

  _ensureThinkingTracker() {
    if (this.thinkingTracker && typeof this.thinkingTracker.reset === 'function') return;
    try {
      const { ThinkingTracker } = require('../thinking');
      this.thinkingTracker = new ThinkingTracker();
    } catch {
      this.thinkingTracker = {
        reset: () => {},
        update: () => {},
        get isThinking()     { return false; },
        get hasThinking()    { return false; },
        get thinkingContent(){ return ''; },
        get responseContent(){ return ''; },
      };
    }
  }

  // ── Core methods ───────────────────────────────────────────────────────────

  async sendMessage(text) {
    await withSendRetry(async () => {
      await this._applyProviderPreferences();
      const { el, isTextarea } = await this._findInput();

      await el.click({ force: true });
      await this.page.waitForTimeout(200);

      await this.page.keyboard.press('Control+a');
      await this.page.waitForTimeout(100);

      if (isTextarea) {
        await el.fill(text);
      } else {
        await this.page.evaluate((element, content) => {
          element.focus();
          document.execCommand('selectAll', false, null);
          document.execCommand('delete',    false, null);
          document.execCommand('insertText', false, content);
          element.dispatchEvent(new InputEvent('input', { bubbles: true, data: content }));
        }, el, text);
      }

      this._lastTextBefore = await this._extractLastMessage() || '';

      const sendDelayMs = this.config.SEND_DELAY || 1_500;
      const startPoll = Date.now();
      let clicked = false;
      while (Date.now() - startPoll < sendDelayMs) {
        clicked = await this._clickSendButton();
        if (clicked) break;
        await this.page.waitForTimeout(50);
      }

      if (!clicked) {
        await this.page.keyboard.press('Enter');
      }

      await this.page.waitForTimeout(500);
    }, 'send message to DeepSeek');
  }

  async waitForResponse() {
    return withResponseRetry(async () => {
      const timeout     = this.config.RESPONSE_TIMEOUT === 0
        ? 24 * 60 * 60 * 1000
        : this.config.RESPONSE_TIMEOUT || 600_000;
      const stableDelay = this.config.STABLE_DELAY || 1500;
      const pollMs      = this.config.GENERATION_POLL || 800;
      const start       = Date.now();

      this._ensureThinkingTracker();
      if (typeof this.thinkingTracker.reset === 'function') {
        this.thinkingTracker.reset();
      }

      // ── Phase 1: wait for a new message to appear ────────────────────────
      const initialCount = await this._getMessageCount();
      let appeared = false;

      while (Date.now() - start < (this.config.APPEAR_TIMEOUT || 120_000)) {
        const current = await this._extractLastMessage();
        const count = await this._getMessageCount();
        if ((current && current.trim() !== this._lastTextBefore.trim()) || count > initialCount) {
          appeared = true;
          break;
        }
        await this.page.waitForTimeout(pollMs);
      }

      if (!appeared) logger.warn('Response may have been delayed — continuing to wait...');

      // ── Phase 2: wait for text to stabilise ──────────────────────────────
      let lastText    = '';
      let stableStart = null;
      let lastIndicatorUpdate = 0;

      while (Date.now() - start < timeout) {
        const text = await this._extractLastMessage();
        if (!text || text.trim() === this._lastTextBefore.trim()) {
          await this.page.waitForTimeout(pollMs);
          continue;
        }

        if (typeof this.thinkingTracker.update === 'function') {
          this.thinkingTracker.update(text);
        }

        if (text !== lastText) {
          lastText    = text;
          stableStart = null;
        } else if (text.length > 0) {
          if (!stableStart) stableStart = Date.now();
          else if (Date.now() - stableStart >= stableDelay) {
            if (!await this._isGenerating()) break;
            stableStart = null;
          }
        }

        const now = Date.now();
        if (now - lastIndicatorUpdate > 1_000) {
          const elapsedMs = now - start;
          logger.thinking(elapsedMs, text.length);
          if (Math.round(elapsedMs / 1000) === 30) {
            logger.clearThinking();
            logger.dim('  Response is taking a while — this is normal for complex tasks or slow connections.');
          }
          lastIndicatorUpdate = now;
        }

        await this.page.waitForTimeout(pollMs);
      }

      logger.clearThinking();

      const hasThinking = this.thinkingTracker.hasThinking || false;
      if (hasThinking) {
        const thinkingContent = this.thinkingTracker.thinkingContent;
        if (this.config.DEBUG && thinkingContent) {
          logger.dim(formatThinkingForLog(thinkingContent));
        }
      }

      const final = await this._extractLastMessage();
      if (!final || final.trim() === this._lastTextBefore.trim()) {
        const err = Errors.responseTimeout(timeout);
        err.retryable = true;
        throw err;
      }

      if (await this._hasProviderNativeExecution(final)) {
        const err = new Error(
          'DeepSeek attempted provider-native execution. Forge stopped the turn; ' +
          'no result outside the selected local workspace was accepted.'
        );
        err.retryable = false;
        err.providerNativeTool = true;
        throw err;
      }

      const cleaned = this._cleanText(final);

      if (!cleaned || cleaned.trim().length === 0) {
        const err = new Error('Empty response from DeepSeek');
        err.retryable = true;
        throw err;
      }

      return cleaned;
    }, 'wait for DeepSeek response');
  }

  async newChat() {
    // Navigate directly to root URL — most reliable way to get a fresh chat.
    // Trying to click the "New Chat" button is fragile because DeepSeek
    // frequently changes its DOM selectors.
    try {
      await this.page.goto(
        this.config.DEEPSEEK_URL || 'https://chat.deepseek.com',
        { waitUntil: 'domcontentloaded', timeout: this.config.BROWSER_TIMEOUT || 90_000 }
      );
      await this.page.waitForTimeout(2_000);
      logger.dim('Navigated to DeepSeek home (new chat)');
    } catch (err) {
      // Fallback: try sidebar button
      logger.warn(`Navigation failed: ${err.message} — trying sidebar button`);
      for (const sel of this.selectors.newChat) {
        try {
          const el = await this.page.$(sel);
          if (el && await el.isVisible()) {
            await el.click();
            await this.page.waitForTimeout(1_000);
            logger.dim('Started new chat session via button');
            return;
          }
        } catch {}
      }
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  async _applyProviderPreferences() {
    try {
      if (typeof this.page.locator !== 'function') return;
      const store = new ProviderWebPreferences();
      if (!store.exists()) return;
      const mode = store.load().modes.deepseek;
      if (this._providerPreferenceSignature === mode) return;
      if (await applyProviderMode(this.page, 'deepseek', mode)) this._providerPreferenceSignature = mode;
    } catch (error) {
      logger.warn(`Could not apply DeepSeek mode preference: ${error.message}`);
    }
  }

  _getInputSelectors() { return this.selectors.chatInput; }
  _getSendSelectors() { return this.selectors.sendButton; }
  _getStopSelectors() { return this.selectors.stopButton; }
  _getNewChatSelectors() { return this.selectors.newChat; }
  _getResponseSelectors() { return this.selectors.messageContainer; }
  getModelUrl() { return this.config.DEEPSEEK_URL || 'https://chat.deepseek.com'; }

  getQrTabSelectors() {
    return [
      'text=扫码登录',
      'text=二维码登录',
      '[class*="qr-tab"]',
      '[class*="scan-tab"]',
      '[class*="qr-login-tab"]',
      'div[class*="tab"]:has-text("扫码")',
    ];
  }

  getQrLoginSelectors() {
    return [
      'img[class*="qr"]',
      '[class*="qrcode"] img',
      '[class*="qr-code"] img',
      '[class*="qr_container"] img',
      'canvas[class*="qr"]',
      'img[alt*="qr"]',
      'img[alt*="二维码"]',
      '[class*="login-qr"] img',
    ];
  }

  async isLoginSuccess() {
    for (const sel of this.selectors.chatInput) {
      try {
        const el = await this.page.$(sel);
        if (el && await el.isVisible()) return true;
      } catch {}
    }
    return false;
  }

  async isReady() {
    if (!await this.isLoginSuccess()) return false;
    return !await this.page.evaluate(() => {
      const visible = el => {
        const style = getComputedStyle(el);
        return el.getClientRects().length > 0 && style.display !== 'none' &&
          style.visibility !== 'hidden' && style.opacity !== '0';
      };
      const loginText = /请登录|登录后|扫码登录|二维码登录|\bLog in\b|\bSign in\b/i;
      return [...document.querySelectorAll('[role="dialog"], [class*="login-modal"], [class*="login-dialog"]')]
        .some(el => visible(el) && loginText.test(el.textContent || ''));
    });
  }

  async prepareLogin() {
    const triggers = [
      'button:has-text("登录")', 'button:has-text("Log in")',
      '[class*="login-button"]', '[class*="login-btn"]', '[data-testid*="login"]',
    ];
    for (const selector of triggers) {
      try {
        const trigger = this.page.locator(selector).first();
        if (await trigger.isVisible()) {
          await trigger.click({ timeout: 3000 });
          await this.page.waitForTimeout(500);
          return true;
        }
      } catch {}
    }
    return false;
  }

  async _findInput() {
    for (const sel of this.selectors.chatInput) {
      try {
        const el = await this.page.waitForSelector(sel, {
          timeout: this.config.HEALTH_CHECK_TIMEOUT || 45_000,
          state: 'visible',
        });
        if (!el) continue;
        const tagName           = await el.evaluate(e => e.tagName.toLowerCase());
        const isContentEditable = await el.evaluate(e => e.isContentEditable);
        return { el, isTextarea: tagName === 'textarea' && !isContentEditable };
      } catch {}
    }
    throw Errors.inputNotFound ? Errors.inputNotFound() : new Error('Chat input not found');
  }

  async _clickSendButton() {
    for (const sel of this.selectors.sendButton) {
      try {
        const el = await this.page.$(sel);
        if (el && await el.isVisible() && await el.isEnabled()) {
          await el.click();
          return true;
        }
      } catch {}
    }
    return false;
  }

  async _getMessageCount() {
    return await this.page.evaluate(() => {
      const candidates = [
        '[class*="assistant"][class*="message"]',
        '[data-role="assistant"]',
        '[class*="markdown-content"]',
        '.ds-markdown',
        '[class*="chat-message"]',
        '[class*="message-bubble"]',
      ];
      for (const sel of candidates) {
        const els = document.querySelectorAll(sel);
        if (els.length > 0) return els.length;
      }
      return document.querySelectorAll('[class*="message"]').length;
    });
  }

  /**
   * Extract the last AI message from the page.
   *
   * CRITICAL: getFullText() reconstructs fenced code blocks from DOM elements.
   * When DeepSeek renders a tool_call response it creates:
   *   <pre><code class="language-tool_call">{"name": ...}</code></pre>
   * getFullText() converts this back to:
   *   ```tool_call\n{"name": ...}\n```
   * which is exactly what the parser's Strategy 1 expects.
   * Without this reconstruction the parser never sees the tool call.
   */
  async _extractLastMessage() {
    return await this.page.evaluate(() => {
      function getFullText(el) {
        if (!el) return '';
        let result = '';

        function walk(node) {
          if (node.nodeType === Node.TEXT_NODE) {
            result += node.textContent;
            return;
          }
          if (node.nodeType !== Node.ELEMENT_NODE) return;
          const tag = node.tagName.toLowerCase();

          if (tag === 'pre') {
            const codeEl = node.querySelector('code');
            if (codeEl) {
              const cls  = codeEl.className || '';
              const lang = (cls.match(/language-(\S+)/) || [])[1] || '';
              const body = codeEl.textContent || '';
              result += '\n```' + lang + '\n' + body + '\n```\n';
            } else {
              result += '\n```\n' + node.textContent + '\n```\n';
            }
            return;
          }

          if (tag === 'code') {
            const parentTag = node.parentElement && node.parentElement.tagName
              ? node.parentElement.tagName.toLowerCase() : '';
            if (parentTag !== 'pre') {
              result += '`' + node.textContent + '`';
            }
            return;
          }

          for (const child of node.childNodes) walk(child);

          if (['p','div','li','br','h1','h2','h3','h4','h5','h6'].includes(tag)) {
            result += '\n';
          }
        }

        walk(el);
        return result.trim();
      }

      const directSelectors = [
        '.ds-markdown',
        '[class*="assistant"] [class*="markdown"]',
        '[class*="assistant"] [class*="content"]',
        '[data-role="assistant"] [class*="content"]',
        '[class*="ai-message"] [class*="content"]',
        '[class*="bot-message"] [class*="content"]',
        '[class*="response-content"]',
        '[class*="message-content"]:last-child',
      ];

      for (const sel of directSelectors) {
        const els = document.querySelectorAll(sel);
        if (els.length > 0) {
          const t = getFullText(els[els.length - 1]);
          if (t.length > 10) return t;
        }
      }

      const markdownEls = document.querySelectorAll(
        '[class*="markdown"], [class*="prose"], [class*="rendered"]'
      );
      if (markdownEls.length > 0) {
        const t = getFullText(markdownEls[markdownEls.length - 1]);
        if (t.length > 10) return t;
      }

      const allBlocks = Array.from(
        document.querySelectorAll('[class*="message"], [class*="chat-item"], [class*="turn"]')
      );
      const candidates = allBlocks.filter(el => {
        const cls = el.className || '';
        return (
          !cls.toLowerCase().includes('input') &&
          !cls.toLowerCase().includes('user') &&
          !el.querySelector('textarea, input[type="text"]') &&
          (el.innerText || '').length > 20
        );
      });

      if (candidates.length > 0) {
        return getFullText(candidates[candidates.length - 1]);
      }

      return '';
    });
  }

  _cleanText(text) {
    if (!text) return '';
    // Strip <think> blocks always — unconditional
    return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  }

  async _isGenerating() {
    return await this.page.evaluate(() => {
      const stopSelectors = [
        'button[aria-label*="Stop" i]',
        '[class*="stop-gen"]',
        '[class*="stopGen"]',
        '[class*="generating"]',
      ];
      for (const sel of stopSelectors) {
        const el = document.querySelector(sel);
        if (el) {
          const s = window.getComputedStyle(el);
          if (s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0') return true;
        }
      }

      const loaderSelectors = [
        '[class*="typing"]',
        '[class*="loading"]',
        '[class*="spinner"]',
        '[class*="blink"]',
        '[class*="cursor"]',
        '[class*="pulsing"]',
        'svg[class*="loading"]',
        'svg[class*="spinner"]',
      ];
      for (const sel of loaderSelectors) {
        const el = document.querySelector(sel);
        if (el) {
          const s = window.getComputedStyle(el);
          if (s.display !== 'none' && s.visibility !== 'hidden') return true;
        }
      }

      return false;
    });
  }
}

module.exports = DeepSeekAdapter;
