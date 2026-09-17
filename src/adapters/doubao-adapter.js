// src/adapters/doubao-adapter.js — Doubao (豆包) model adapter
'use strict';

const BaseAdapter = require('./base-adapter');
const logger      = require('../logger');

const DOUBAO_URL = 'https://www.doubao.com/chat';

class DoubaoAdapter extends BaseAdapter {
  constructor(page, config) {
    super(page, config);
    this._isFirstMessage = true;
    this._lastTextBefore = '';
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
      throw Object.assign(new Error(
        `Failed to send message to Doubao.\n` +
        `The composer did not become ready. The UI may have changed.\n` +
        `Detail: ${this._inputFailure || 'No editable composer found'}\n` +
        `Log in in the Doubao browser window if prompted, then retry.\n` +
        `Run: forge-agent --model=doubao --test-model`
      ), { acpBrowserRecoverable: true });
    }

    this._lastTextBefore = await this._getLastAssistantText() || '';

    await input.press('Enter');
    this._isFirstMessage = false;

    await this.page.waitForTimeout(500);
  }

  // ── Override: waitForResponse ───────────────────────────────────────────────
  //
  // Doubao uses a virtual list (.list_items > .v_list_row) where row count
  // stays constant (~10) as messages scroll. Content-based detection is
  // required instead of row-count-based detection.

  async waitForResponse() {
    const timeoutMs = this.config.RESPONSE_TIMEOUT || 600_000;
    const start     = Date.now();

    let lastText    = '';
    let stableCount = 0;

    while (Date.now() - start < timeoutMs) {
      await this.page.waitForTimeout(2000);

      const current = await this._getLastAssistantText();
      if (!current) continue;

      if (current.trim() === this._lastTextBefore.trim()) continue;

      if (current === lastText) {
        stableCount++;
        if (stableCount >= 2 && !await this._isGenerating()) {
          return this._cleanText(current);
        }
      } else {
        lastText    = current;
        stableCount = 0;
      }
    }

    const final = await this._getLastAssistantText();
    if (final && final.trim() !== this._lastTextBefore.trim()) {
      return this._cleanText(final);
    }

    throw Object.assign(new Error(
      `No response received from Doubao after ${timeoutMs / 1000}s.\n` +
      `The AI may still be processing. Try:\n` +
      `  - Increasing timeout: forge-agent --timeout=600 "task"\n` +
      `  - Testing the model: forge-agent --test-model`
    ), { acpBrowserRecoverable: true });
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

  async _isGenerating() {
    return await this.page.evaluate(() => {
      const stopSelectors = [
        'button[aria-label*="停止"]',
        'button[aria-label*="Stop" i]',
        '[class*="stop-btn"]',
        '[class*="stopBtn"]',
        '[class*="stop-gen"]',
      ];
      for (const sel of stopSelectors) {
        for (const el of document.querySelectorAll(sel)) {
          const s = window.getComputedStyle(el);
          if (el.getClientRects().length > 0 && s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0') return true;
        }
      }

      // Generic cursor/loading classes also occur in the composer and sidebar.
      // Only an explicit visible stop control indicates ongoing generation.
      return false;
    });
  }

  // ── Override: _cleanText ────────────────────────────────────────────────────

  _cleanText(text) {
    if (!text) return '';
    return text
      .replace(/<think>[\s\S]*?<\/think>\n?/gi, '')
      .replace(/^(Assistant|AI|Doubao|豆包):\s*/i, '')
      .replace(/^\d+(?:Copy|Run|Insert|Edit)\w*.*$/gm, '')
      .replace(/Copy code[\s\S]{0,50}$/gm, '')
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
    // Try selectors in priority order; a CSS union sorts matches by DOM order.
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
    return Boolean(await this._findComposer());
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
          // A large Tiptap insert can finish even though Playwright times out.
          // Verify before retrying so an accepted prompt is not inserted again.
          fillError = err;
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

        // Chromium preserves repeated spaces using non-breaking spaces in editable HTML.
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
   * Extract the most recent assistant message from Doubao's virtual list.
   *
   * Doubao DOM: .list_items > .v_list_row
   * Strips suggestion chips (.suggest-message-list-wrapper) and
   * message action bars (.message-action-bar) before extracting text.
   *
   * Also reconstructs code blocks from [data-streaming] pre code elements,
   * matching the format expected by Forge's parser.
   */
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
      // Prefer explicitly identified assistant messages when available.
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
