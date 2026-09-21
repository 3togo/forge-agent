// src/adapters/doubao-adapter.js — Doubao (豆包) model adapter
'use strict';

const BaseAdapter = require('./base-adapter');
const logger      = require('../logger');
const { Errors }  = require('../errors');
const { withSendRetry, withResponseRetry } = require('../retry');
const { ThinkingTracker, formatThinkingForLog } = require('../thinking');

const DOUBAO_URL = 'https://www.doubao.com/chat';

class DoubaoAdapter extends BaseAdapter {
  constructor(page, config) {
    super(page, config);
    this._isFirstMessage = true;
    this._lastTextBefore = '';
    this._ensureThinkingTracker();
    this.selectors = {
      chatInput: [
        'textarea[placeholder*="发消息"]',
        'textarea[placeholder*="消息"]',
        '.semi-input-textarea',
        '[contenteditable="true"]',
        'textarea',
      ],
      sendButton: [
        'button[aria-label*="发送" i]',
        'button[aria-label*="Send" i]',
        '[class*="send-btn"]',
        '[class*="sendBtn"]',
        '[class*="send-button"]',
        'button[type="submit"]',
      ],
      stopButton: [
        'button[aria-label*="停止" i]',
        'button[aria-label*="Stop" i]',
        '[class*="stop-btn"]',
        '[class*="stopBtn"]',
        '[class*="stop-gen"]',
      ],
      newChat: [
        'text=新对话',
        'button:has-text("新对话")',
        '[class*="new-chat"]',
        '[class*="newChat"]',
      ],
      messageContainer: [
        '.list_items',
        '.semi-chat-content',
        '[class*="message-content"]',
        '[class*="reply"]',
        '.markdown-body',
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

  // ── Abstract method implementations ─────────────────────────────────────────

  _getInputSelectors()  { return this.selectors.chatInput; }
  _getSendSelectors()   { return this.selectors.sendButton; }
  _getStopSelectors()   { return this.selectors.stopButton; }
  _getNewChatSelectors(){ return this.selectors.newChat; }
  _getResponseSelectors(){ return this.selectors.messageContainer; }
  getModelUrl()         { return DOUBAO_URL; }

  // ── Override: sendMessage ───────────────────────────────────────────────────
  //
  // Doubao uses a ProseMirror contenteditable editor. The base class _typeText
  // handles contenteditable via execCommand('insertText'), but Doubao's
  // animated composer replacement requires fill()-based input and text
  // verification before sending.

  async sendMessage(text) {
    await withSendRetry(async () => {
      let fullText = text;

      if (this._isFirstMessage) {
        const { buildSystemPrompt } = require('../system-prompt');
        const systemPrompt = buildSystemPrompt({
          projectContext: this._projectContext || '',
          profile       : this.config.ACTIVE_PROFILE || 'default',
          planMode      : this.config.PLANNING_MODE   || false,
          workingDir    : this.config.WORKING_DIR     || process.cwd(),
        });
        fullText = systemPrompt + '\n\n════════════════════════════════\nUSER TASK:\n' + text;
      }

      const input = await this._prepareInput(fullText);
      if (!input) {
        throw Object.assign(Errors.inputNotFound(), {
          acpBrowserRecoverable: true,
          retryable: false,
          message: `Failed to send message to Doubao.\n` +
            `The composer did not become ready. The UI may have changed.\n` +
            `Detail: ${this._inputFailure || 'No editable composer found'}\n` +
            `Log in in the Doubao browser window if prompted, then retry.\n` +
            `Run: forge-agent --model=doubao --test-model`,
        });
      }

      this._lastTextBefore = await this._getLastAssistantText() || '';

      // Poll for send button before falling back to Enter
      const sendDelayMs = this.config.SEND_DELAY || 600;
      const startPoll = Date.now();
      let clicked = false;
      while (Date.now() - startPoll < sendDelayMs) {
        clicked = await this._clickSendButton();
        if (clicked) break;
        await this.page.waitForTimeout(50);
      }

      if (!clicked) {
        await input.press('Enter');
      }

      this._isFirstMessage = false;
      await this.page.waitForTimeout(500);
    }, 'send message to Doubao');
  }

  // ── Override: waitForResponse ───────────────────────────────────────────────
  //
  // Doubao uses a virtual list (.list_items > .v_list_row) where row count
  // stays constant (~10) as messages scroll. Content-based detection is
  // required instead of row-count-based detection.
  //
  // Two-phase approach borrowed from DeepSeek:
  //   Phase 1: wait for content to change from the pre-send baseline
  //   Phase 2: wait for text to stabilise + generation to stop

  async waitForResponse() {
    return withResponseRetry(async () => {
      const timeout     = this.config.RESPONSE_TIMEOUT === 0
        ? 24 * 60 * 60 * 1000
        : this.config.RESPONSE_TIMEOUT || 600_000;
      const stableDelay = this.config.STABLE_DELAY || 1500;
      const pollMs      = this.config.GENERATION_POLL || 2000;
      const start       = Date.now();

      this._ensureThinkingTracker();
      if (typeof this.thinkingTracker.reset === 'function') {
        this.thinkingTracker.reset();
      }

      // ── Phase 1: wait for content to change from baseline ────────────────
      let appeared = false;
      const appearTimeout = this.config.APPEAR_TIMEOUT || 120_000;
      const initialCount = await this._getMessageCount();

      while (Date.now() - start < appearTimeout) {
        const current = await this._getLastAssistantText();
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
        const current = await this._getLastAssistantText();
        if (!current) continue;
        if (current.trim() === this._lastTextBefore.trim()) continue;

        if (typeof this.thinkingTracker.update === 'function') {
          this.thinkingTracker.update(current);
        }

        if (current !== lastText) {
          lastText    = current;
          stableStart = null;
        } else if (current.length > 0) {
          if (!stableStart) stableStart = Date.now();
          else if (Date.now() - stableStart >= stableDelay) {
            if (!await this._isGenerating()) break;
            stableStart = null;
          }
        }

        const now = Date.now();
        if (now - lastIndicatorUpdate > 1_000) {
          const elapsedMs = now - start;
          logger.thinking(elapsedMs, current.length);
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

      const final = await this._getLastAssistantText();
      if (!final || final.trim() === this._lastTextBefore.trim()) {
        const err = Errors.responseTimeout(timeout);
        err.retryable = true;
        throw err;
      }

      const cleaned = this._cleanText(final);

      if (!cleaned || cleaned.trim().length === 0) {
        const err = Errors.emptyResponse();
        err.retryable = true;
        throw err;
      }

      return cleaned;
    }, 'wait for Doubao response');
  }

  // ── Override: newChat ───────────────────────────────────────────────────────

  async newChat() {
    try {
      await this.page.goto(DOUBAO_URL, {
        waitUntil   : 'domcontentloaded',
        timeout     : this.config.BROWSER_TIMEOUT || 90_000,
      });
      await this.page.waitForTimeout(2000);
      this._isFirstMessage = true;
      logger.dim('Navigated to Doubao home (new chat)');
    } catch (err) {
      logger.warn(`Navigation failed: ${err.message} — trying sidebar button`);
      for (const sel of this.selectors.newChat) {
        try {
          const el = await this.page.$(sel);
          if (el && await el.isVisible()) {
            await el.click();
            await this.page.waitForTimeout(1000);
            this._isFirstMessage = true;
            return;
          }
        } catch {}
      }
    }
  }

  // ── Override: _isGenerating ─────────────────────────────────────────────────
  //
  // Checks for explicit stop controls first, then scoped loading indicators
  // within the message area (not the composer or sidebar).

  async _isGenerating() {
    return await this.page.evaluate(() => {
      const visible = el => {
        const s = window.getComputedStyle(el);
        return el.getClientRects().length > 0 && s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
      };

      // Phase 1: explicit stop button — strongest signal
      const stopSelectors = [
        'button[aria-label*="停止"]',
        'button[aria-label*="Stop" i]',
        '[class*="stop-btn"]',
        '[class*="stopBtn"]',
        '[class*="stop-gen"]',
      ];
      for (const sel of stopSelectors) {
        for (const el of document.querySelectorAll(sel)) {
          if (visible(el)) return true;
        }
      }

      // Phase 2: scoped loading indicators within the chat message area only.
      // Avoid composer/sidebar by scoping to .list_items or message containers.
      const messageRoots = document.querySelectorAll(
        '.list_items, .semi-chat-content, [class*="message-content"], [class*="reply"]'
      );
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
      for (const root of messageRoots) {
        for (const sel of loaderSelectors) {
          for (const el of root.querySelectorAll(sel)) {
            if (visible(el)) return true;
          }
        }
      }

      return false;
    });
  }

  // ── Override: _cleanText ────────────────────────────────────────────────────

  _cleanText(text) {
    if (!text) return '';
    return text
      .replace(/<think>[\s\S]*?<\/think>\n?/gi, '')
      .replace(/^Thinking\.{0,3}\n[\s\S]*?\n\n/m, '')
      .replace(/^(Assistant|AI|Doubao|豆包):\s*/i, '')
      .replace(/^\d+(?:Copy|Run|Insert|Edit)\w*.*$/gm, '')
      .replace(/Copy code[\s\S]{0,50}$/gm, '')
      .replace(/下载豆包电脑版[^\n]*/g, '')
      .replace(/\d+ \/ \d+[\s\n]*$/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  // ── Doubao-specific helpers ─────────────────────────────────────────────────

  /**
   * Prepare the input field with text, verifying the content was accepted.
   * Doubao animates/replaces the landing-page composer, so we use fill()
   * instead of click()+type(), and verify the text was correctly written
   * before allowing Enter to be pressed.
   */
  async _findComposer() {
    for (const selector of ['.ProseMirror[contenteditable="true"]', ...this.selectors.chatInput]) {
      const candidates = this.page.locator(`${selector}:visible:is(textarea, input, [contenteditable="true"]):not([disabled]):not([readonly])`);
      const count = await candidates.count();
      for (let i = 0; i < count; i++) {
        const candidate = candidates.nth(i);
        if (await candidate.isEditable()) return candidate;
      }
    }
    return null;
  }

  async isReady() {
    await this._dismissOverlays();
    return Boolean(await this._findComposer());
  }

  async _dismissOverlays() {
    const overlaySelectors = [
      '[role="dialog"]',
      '.semi-modal-content',
      '[class*="modal-overlay"]',
      '[class*="popup"]',
      'button:has-text("知道了")',
      'button:has-text("关闭")',
      'button:has-text("不再提示")',
      'button:has-text("取消")',
    ];

    for (const sel of overlaySelectors) {
      try {
        const el = await this.page.$(sel);
        if (el && await el.isVisible()) {
          if (sel.includes('button')) {
            await el.click();
          } else {
            await this.page.keyboard.press('Escape');
          }
          await this.page.waitForTimeout(300);
        }
      } catch {}
    }
  }

  async _prepareInput(text, timeout = 30_000) {
    this._inputFailure = null;
    const deadline = Date.now() + timeout;

    while (Date.now() < deadline) {
      if (this.page.isClosed?.()) {
        throw new Error('Doubao chat tab was closed before sending');
      }

      try {
        const composer = await this._findComposer();
        if (!composer) {
          this._inputFailure = 'No visible, editable Doubao composer found';
          await this.page.waitForTimeout(200);
          continue;
        }
        const remaining = Math.max(1000, deadline - Date.now());
        let fillError;
        try {
          await composer.fill(text, { timeout: Math.min(15000, remaining) });
        } catch (err) {
          fillError = err;
          try {
            await composer.click({ timeout: 2000 });
            await this.page.keyboard.press('Control+a');
            await this.page.waitForTimeout(100);
            await this.page.keyboard.press('Backspace');
            await this.page.waitForTimeout(100);
            await composer.type(text, { delay: 0 });
            await this.page.waitForTimeout(300);
          } catch (kbErr) {
            fillError = kbErr;
          }
        }
        await this.page.waitForTimeout(300);

        const current = composer;
        const value = await current.evaluate(el => {
          if ('value' in el) return el.value;
          if (!el.isContentEditable) return el.innerText;
          const read = n =>
            n.nodeType === Node.TEXT_NODE ? n.textContent :
            n.nodeName === 'BR' ? (
              n.classList.contains('ProseMirror-trailingBreak') ||
              (n.parentNode.childNodes.length === 1 && /^(DIV|P)$/.test(n.parentNode.nodeName)) ? '' : '\n'
            ) :
            [...n.childNodes].map(read).join('');
          return [...el.childNodes].map(read).join('\n');
        }, { timeout: 1000 });

        const normalize = value => value.replace(/\r\n/g, '\n').replace(/\u00a0/g, ' ');
        if (normalize(value) === normalize(text)) {
          return current;
        }
        this._inputFailure = fillError ? String(fillError.message).split('\n')[0] :
          `Composer text verification failed (expected ${text.length} characters, read ${value.length})`;
      } catch (err) {
        this._inputFailure = String(err.message).split('\n')[0];
      }

      await this.page.waitForTimeout(100);
    }

    try {
      const status = await this.page.evaluate(() => ({
        title: document.title,
        path: location.pathname,
        editors: document.querySelectorAll('textarea, [contenteditable="true"]').length,
        dialogs: document.querySelectorAll('[role="dialog"]').length,
      }));
      this._inputFailure += `; page=${status.title}, path=${status.path}, editors=${status.editors}, dialogs=${status.dialogs}`;
    } catch {}
    return null;
  }

  /**
   * Poll for the send button and click it if available.
   * Returns true if the button was clicked, false otherwise.
   */
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

  /**
   * Extract the most recent assistant message from Doubao's virtual list.
   *
   * Doubao DOM: .list_items > .v_list_row
   * Strips suggestion chips (.suggest-message-list-wrapper) and
   * message action bars (.message-action-bar) before extracting text.
   *
   * Also reconstructs code blocks from [data-streaming] pre code elements,
   * matching the format expected by Forge's parser.
   */
  async _getMessageCount() {
    return await this.page.evaluate(() => {
      const candidates = [
        '[data-message-role="assistant"]',
        '[data-role="assistant"]',
        '[data-testid*="assistant-message"]',
        '.list_items .v_list_row',
      ];
      for (const sel of candidates) {
        const els = document.querySelectorAll(sel);
        if (els.length > 0) return els.length;
      }
      return document.querySelectorAll('[class*="message"]').length;
    });
  }

  async testSelectors() {
    const results = await super.testSelectors();

    results.proseMirror = false;
    results.chineseUI = false;
    results.errors = results.errors || [];

    try {
      const pm = await this.page.$('.ProseMirror[contenteditable="true"]');
      results.proseMirror = !!pm;
      if (!pm) results.errors.push('ProseMirror editor not found');
    } catch (e) {
      results.errors.push('ProseMirror check error: ' + e.message);
    }

    try {
      const newChat = await this.page.$('text=新对话');
      results.chineseUI = !!newChat;
    } catch {
      results.chineseUI = false;
    }

    results.ready = results.ready || results.proseMirror;
    return results;
  }

  async _getLastAssistantText() {
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

      const visible = el => {
        const style = getComputedStyle(el);
        return el.getClientRects().length > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const inEditor = el => el.closest('[contenteditable="true"], textarea');
      let rows = [...document.querySelectorAll('[data-message-role="assistant"], [data-role="assistant"], [data-testid*="assistant-message"]')].filter(visible);
      if (!rows.length) rows = [...document.querySelectorAll('.list_items .v_list_row')].filter(visible);
      if (!rows.length) rows = [...document.querySelectorAll('.flow-markdown-body, .markdown-body, [class*="message-content"], [class*="reply"]')]
        .filter(el => visible(el) && !inEditor(el) && !el.closest('[data-message-role="user"], [data-role="user"]'));
      if (!rows.length) return null;

      let lastRow = null;
      for (let i = rows.length - 1; i >= 0; i--) {
        const text = rows[i].textContent?.trim();
        if (text && !rows[i].closest('[data-message-role="user"], [data-role="user"]')) {
          lastRow = rows[i];
          break;
        }
      }
      if (!lastRow) return null;

      const clone = lastRow.cloneNode(true);

      clone.querySelectorAll('[class*="suggest-message-list-wrapper"]').forEach(el => el.remove());
      clone.querySelectorAll('[class*="message-action-bar"]').forEach(el => el.remove());

      return getFullText(clone) || clone.textContent?.trim() || null;
    });
  }
}

module.exports = DoubaoAdapter;
