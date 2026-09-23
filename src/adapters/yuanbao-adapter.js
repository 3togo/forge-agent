// src/adapters/yuanbao-adapter.js — Tencent Yuanbao (腾讯元宝) model adapter
'use strict';

const BaseAdapter = require('./base-adapter');
const logger      = require('../logger');
const { Errors }  = require('../errors');
const { withSendRetry, withResponseRetry } = require('../retry');
const { ThinkingTracker, formatThinkingForLog } = require('../thinking');

const YUANBAO_URL = 'https://yuanbao.tencent.com/chat';

class YuanbaoAdapter extends BaseAdapter {
  constructor(page, config) {
    super(page, config);
    this._isFirstMessage = true;
    this._lastTextBefore = '';
    this._ensureThinkingTracker();
    this.selectors = {
      chatInput: [
        '.ql-editor[contenteditable="true"]',
        '[contenteditable="true"][role="textbox"]',
        '[contenteditable="true"]',
        'textarea[placeholder*="输入"]',
        'textarea[placeholder*="消息"]',
        'textarea',
      ],
      sendButton: [
        'button[aria-label*="发送" i]',
        'button[aria-label*="Send" i]',
        '[class*="send-btn"]',
        '[class*="sendBtn"]',
        '[class*="send-button"]',
        '[data-testid*="send"]',
        'button[type="submit"]',
      ],
      stopButton: [
        'button[aria-label*="停止" i]',
        'button[aria-label*="Stop" i]',
        '[class*="stop-btn"]',
        '[class*="stopBtn"]',
        '[class*="stop-gen"]',
        '[class*="stopGen"]',
      ],
      newChat: [
        '[aria-label="新建对话"]',
        '[data-desc="new-chat"]',
        'button:has-text("新建对话")',
        'text=新建对话',
        '[class*="new-chat"]',
        '[class*="newChat"]',
      ],
      messageContainer: [
        '.yb-layout__content',
        '[class*="chat-content"]',
        '[class*="message-list"]',
        '[class*="conversation"]',
        '[class*="message-content"]',
        '.markdown-body',
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

  // ── Abstract method implementations ─────────────────────────────────────────

  _getInputSelectors()  { return this.selectors.chatInput; }
  _getSendSelectors()   { return this.selectors.sendButton; }
  _getStopSelectors()   { return this.selectors.stopButton; }
  _getNewChatSelectors(){ return this.selectors.newChat; }
  _getResponseSelectors(){ return this.selectors.messageContainer; }
  getModelUrl()         { return YUANBAO_URL; }

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
      'canvas[class*="qr"]',
      'img[alt*="qr"]',
      'img[alt*="二维码"]',
      '[class*="login-qr"] img',
      '[class*="scan-code"] img',
    ];
  }

  async isLoginSuccess() {
    return Boolean(await this._findComposer());
  }

  // ── Override: sendMessage ───────────────────────────────────────────────────
  //
  // Yuanbao uses a Quill contenteditable editor. The base class _typeText
  // handles contenteditable via execCommand('insertText'), but Yuanbao's
  // Quill editor requires fill()-based input and text verification before
  // sending, similar to Doubao's ProseMirror approach.

  async sendMessage(text) {
    process.stderr.write(`[forge-acp] yuanbao.sendMessage: starting, text="${text?.slice(0, 80)}", isFirst=${this._isFirstMessage}\n`);
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
        process.stderr.write(`[forge-acp] yuanbao.sendMessage: input not found, failure=${this._inputFailure}\n`);
        throw Object.assign(Errors.inputNotFound(), {
          acpBrowserRecoverable: true,
          retryable: false,
          message: `Failed to send message to Yuanbao.\n` +
            `The composer did not become ready. The UI may have changed.\n` +
            `Detail: ${this._inputFailure || 'No editable composer found'}\n` +
            `Log in in the Yuanbao browser window if prompted, then retry.\n` +
            `Run: forge-agent --model=yuanbao --test-model`,
        });
      }

      this._lastTextBefore = await this._getLastAssistantText() || '';

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
      process.stderr.write(`[forge-acp] yuanbao.sendMessage: completed, clicked=${clicked}\n`);
    }, 'send message to Yuanbao');
  }

  // ── Override: waitForResponse ───────────────────────────────────────────────
  //
  // Yuanbao uses a standard DOM list for messages (not a virtual list like
  // Doubao). Two-phase approach borrowed from DeepSeek/Doubao:
  //   Phase 1: wait for content to change from the pre-send baseline
  //   Phase 2: wait for text to stabilise + generation to stop

  async waitForResponse() {
    process.stderr.write(`[forge-acp] yuanbao.waitForResponse: starting\n`);
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
    }, 'wait for Yuanbao response');
  }

  // ── Override: newChat ───────────────────────────────────────────────────────

  async newChat() {
    try {
      await this.page.goto(YUANBAO_URL, {
        waitUntil   : 'domcontentloaded',
        timeout     : this.config.BROWSER_TIMEOUT || 90_000,
      });
      await this.page.waitForTimeout(2000);
      this._isFirstMessage = true;
      logger.dim('Navigated to Yuanbao home (new chat)');
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
        '[class*="stopGen"]',
      ];
      for (const sel of stopSelectors) {
        for (const el of document.querySelectorAll(sel)) {
          if (visible(el)) return true;
        }
      }

      // Phase 2: scoped loading indicators within the chat message area only.
      const messageRoots = document.querySelectorAll(
        '.yb-layout__content, [class*="chat-content"], [class*="message-content"], [class*="reply"]'
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
      .replace(/^(Assistant|AI|Yuanbao|元宝|腾讯元宝):\s*/i, '')
      .replace(/^\d+(?:Copy|Run|Insert|Edit)\w*.*$/gm, '')
      .replace(/Copy code[\s\S]{0,50}$/gm, '')
      .replace(/前往下载中心[^\n]*/g, '')
      .replace(/内容由AI生成[^\n]*/g, '')
      .replace(/\d+ \/ \d+[\s\n]*$/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  // ── Yuanbao-specific helpers ─────────────────────────────────────────────────

  async _findComposer() {
    for (const selector of ['.ql-editor[contenteditable="true"]', ...this.selectors.chatInput]) {
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
    // Readiness checks must not dismiss the login dialog while the user signs in.
    const composer = await this._findComposer();
    const hasComposer = Boolean(composer);

    // Yuanbao shows a composer even when not logged in.
    // Check for login dialog or "Not logged in" text to detect actual login state.
    const isLoggedIn = await this.page.evaluate(() => {
      const body = document.body?.textContent || '';
      if (body.includes('Not logged in')) return false;
      // Check for login dialog overlay
      const loginDialog = document.querySelector('.t-dialog__position, [class*="login-dialog"], [class*="login-modal"]');
      if (loginDialog && loginDialog.getClientRects().length > 0 && getComputedStyle(loginDialog).visibility !== 'hidden') return false;
      // Check for visible login prompt text
      const loginTexts = ['请登录', '登录后', 'Log In', 'Sign in'];
      for (const t of loginTexts) {
        if (body.includes(t)) {
          // Make sure it's not just a button label — check if there's a dialog
          const dialog = document.querySelector('[class*="dialog"], [class*="modal"], [class*="portal"]');
          if (dialog) return false;
        }
      }
      return true;
    });

    const ready = hasComposer && isLoggedIn;
    process.stderr.write(`[forge-acp] yuanbao.isReady: ${ready} (composer=${hasComposer}, loggedIn=${isLoggedIn})\n`);
    return ready;
  }

  async _dismissOverlays() {
    const overlaySelectors = [
      '[role="dialog"]',
      '[class*="modal-overlay"]',
      '[class*="popup"]',
      'button:has-text("知道了")',
      'button:has-text("关闭")',
      'button:has-text("不再提示")',
      'button:has-text("取消")',
      'button:has-text("确定")',
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
        throw new Error('Yuanbao chat tab was closed before sending');
      }

      try {
        const composer = await this._findComposer();
        if (!composer) {
          this._inputFailure = 'No visible, editable Yuanbao composer found';
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
              n.classList.contains('ql-editor-trailingBreak') ||
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
        '.agent-chat__list__item--ai',
        '.agent-chat__bubble--ai',
        '[data-message-role="assistant"]',
        '[data-role="assistant"]',
        '[data-testid*="assistant-message"]',
        '.yb-layout__content [class*="message"]',
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

  async testSelectors() {
    const results = await super.testSelectors();

    results.quillEditor = false;
    results.chineseUI = false;
    results.errors = results.errors || [];

    try {
      const ql = await this.page.$('.ql-editor[contenteditable="true"]');
      results.quillEditor = !!ql;
      if (!ql) results.errors.push('Quill editor not found');
    } catch (e) {
      results.errors.push('Quill editor check error: ' + e.message);
    }

    try {
      const newChat = await this.page.$('[aria-label="新建对话"]');
      results.chineseUI = !!newChat;
    } catch {
      results.chineseUI = false;
    }

    results.ready = results.ready || results.quillEditor;
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
      let rows = [...document.querySelectorAll(
        '.agent-chat__list__item--ai, .agent-chat__bubble--ai, ' +
        '[data-message-role="assistant"], [data-role="assistant"], [data-testid*="assistant-message"]'
      )].filter(visible);
      if (!rows.length) rows = [...document.querySelectorAll(
        '.agent-chat__speech-text--box, ' +
        '.yb-layout__content [class*="message"], [class*="chat-message"], [class*="message-bubble"]'
      )].filter(el => visible(el) && !inEditor(el) && !el.closest('[data-message-role="user"], [data-role="user"], .agent-chat__list__item--human'));
      if (!rows.length) rows = [...document.querySelectorAll(
        '.markdown-body, [class*="message-content"], [class*="reply"]'
      )].filter(el => visible(el) && !inEditor(el) && !el.closest('[data-message-role="user"], [data-role="user"], .agent-chat__list__item--human'));
      if (!rows.length) return null;

      let lastRow = null;
      for (let i = rows.length - 1; i >= 0; i--) {
        const text = rows[i].textContent?.trim();
        if (text && !rows[i].closest('[data-message-role="user"], [data-role="user"], .agent-chat__list__item--human')) {
          lastRow = rows[i];
          break;
        }
      }
      if (!lastRow) return null;

      const clone = lastRow.cloneNode(true);

      // Yuanbao's processing label belongs to the UI, not the model response.
      clone.querySelectorAll('.hyc-component-deep-search-agent__think__header').forEach(el => el.remove());

      clone.querySelectorAll('[class*="suggest-message-list-wrapper"]').forEach(el => el.remove());
      clone.querySelectorAll('[class*="message-action-bar"]').forEach(el => el.remove());
      clone.querySelectorAll('[class*="action-bar"]').forEach(el => el.remove());
      clone.querySelectorAll('[class*="DirectAnswerButton"]').forEach(el => el.remove());
      clone.querySelectorAll('[class*="agent-chat__list__indicator"]').forEach(el => el.remove());

      return getFullText(clone) || clone.textContent?.trim() || null;
    });
  }
}

module.exports = YuanbaoAdapter;
