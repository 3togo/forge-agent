// tests/doubao-adapter.test.js — Doubao adapter unit tests
'use strict';

const DoubaoAdapter = require('../src/adapters/doubao-adapter');
const BaseAdapter   = require('../src/adapters/base-adapter');
const { AgentError, Errors } = require('../src/errors');
const { getAdapter, getModelUrl, getModelDisplayName, SUPPORTED_MODELS } = require('../src/adapter-factory');

jest.mock('../src/retry', () => ({
  withSendRetry: jest.fn((fn) => fn()),
  withResponseRetry: jest.fn((fn) => fn()),
  withRetry: jest.fn((fn) => fn()),
  withBrowserRetry: jest.fn((fn) => fn()),
  withNetworkRetry: jest.fn((fn) => fn()),
}));

function createMockPage(overrides = {}) {
  return {
    waitForSelector: jest.fn(),
    $: jest.fn().mockResolvedValue(null),
    $$: jest.fn().mockResolvedValue([]),
    goto: jest.fn().mockResolvedValue(null),
    waitForTimeout: jest.fn().mockResolvedValue(null),
    keyboard: { press: jest.fn(), type: jest.fn() },
    evaluate: jest.fn().mockResolvedValue(null),
    screenshot: jest.fn().mockResolvedValue(null),
    url: jest.fn().mockReturnValue('https://www.doubao.com/chat'),
    isClosed: jest.fn().mockReturnValue(false),
    locator: jest.fn().mockReturnValue({
      count: jest.fn().mockResolvedValue(0),
      nth: jest.fn().mockReturnValue({
        isEditable: jest.fn().mockResolvedValue(false),
        fill: jest.fn().mockResolvedValue(undefined),
        evaluate: jest.fn().mockResolvedValue(''),
        press: jest.fn().mockResolvedValue(undefined),
        click: jest.fn().mockResolvedValue(undefined),
        type: jest.fn().mockResolvedValue(undefined),
      }),
    }),
    ...overrides,
  };
}

const mockConfig = {
  STABLE_DELAY: 1500,
  RESPONSE_TIMEOUT: 60000,
  GENERATION_POLL: 400,
  SEND_DELAY: 600,
  BROWSER_TIMEOUT: 30000,
};

describe('DoubaoAdapter', () => {
  let adapter;
  let mockPage;

  beforeEach(() => {
    mockPage = createMockPage();
    adapter = new DoubaoAdapter(mockPage, mockConfig);
    jest.clearAllMocks();
  });

  test('extends BaseAdapter', () => {
    expect(adapter).toBeInstanceOf(BaseAdapter);
  });

  test('returns correct selector lists', () => {
    expect(adapter._getInputSelectors().length).toBeGreaterThanOrEqual(4);
    expect(adapter._getSendSelectors().length).toBeGreaterThanOrEqual(3);
    expect(adapter._getStopSelectors().length).toBeGreaterThanOrEqual(3);
    expect(adapter._getNewChatSelectors().length).toBeGreaterThanOrEqual(3);
    expect(adapter._getResponseSelectors().length).toBeGreaterThanOrEqual(3);
  });

  test('includes Doubao-specific input selectors', () => {
    const inputs = adapter._getInputSelectors();
    expect(inputs.some(s => s.includes('发消息'))).toBe(true);
    expect(inputs.some(s => s.includes('semi-input-textarea'))).toBe(true);
  });

  test('includes Chinese new-chat selectors', () => {
    const newChat = adapter._getNewChatSelectors();
    expect(newChat.some(s => s.includes('新对话'))).toBe(true);
  });

  test('getModelUrl returns correct URL', () => {
    expect(adapter.getModelUrl()).toBe('https://www.doubao.com/chat');
  });

  // ── Improvement 1: Modal/overlay dismissal ──────────────────────────────────

  describe('_dismissOverlays (borrowed from ChatGPTAdapter)', () => {
    test('clicks dismiss buttons when visible', async () => {
      const mockButton = {
        isVisible: jest.fn().mockResolvedValue(true),
        click: jest.fn().mockResolvedValue(undefined),
      };
      mockPage.$ = jest.fn().mockResolvedValue(mockButton);

      await adapter._dismissOverlays();

      expect(mockButton.click).toHaveBeenCalled();
    });

    test('presses Escape for non-button overlays', async () => {
      const mockDialog = {
        isVisible: jest.fn().mockResolvedValue(true),
      };
      mockPage.$ = jest.fn((sel) => {
        if (sel === '[role="dialog"]') return Promise.resolve(mockDialog);
        return Promise.resolve(null);
      });

      await adapter._dismissOverlays();

      expect(mockPage.keyboard.press).toHaveBeenCalledWith('Escape');
    });

    test('does nothing when no overlays present', async () => {
      mockPage.$ = jest.fn().mockResolvedValue(null);

      await adapter._dismissOverlays();

      expect(mockPage.keyboard.press).not.toHaveBeenCalled();
    });

    test('handles errors gracefully', async () => {
      mockPage.$ = jest.fn().mockRejectedValue(new Error('selector error'));

      await expect(adapter._dismissOverlays()).resolves.toBeUndefined();
    });

    test('isReady calls _dismissOverlays before checking composer', async () => {
      const spy = jest.spyOn(adapter, '_dismissOverlays').mockResolvedValue();
      jest.spyOn(adapter, '_findComposer').mockResolvedValue(null);

      await adapter.isReady();

      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });
  });

  // ── Improvement 2: Message count detection ──────────────────────────────────

  describe('_getMessageCount (borrowed from DeepSeekAdapter)', () => {
    test('returns count from data-message-role selector', async () => {
      mockPage.evaluate = jest.fn().mockResolvedValue(5);

      const count = await adapter._getMessageCount();

      expect(count).toBe(5);
    });

    test('returns 0 when no messages found', async () => {
      mockPage.evaluate = jest.fn().mockResolvedValue(0);

      const count = await adapter._getMessageCount();

      expect(count).toBe(0);
    });

    test('evaluate is called with a function', async () => {
      mockPage.evaluate = jest.fn().mockResolvedValue(3);

      await adapter._getMessageCount();

      expect(mockPage.evaluate).toHaveBeenCalledWith(expect.any(Function));
    });
  });

  // ── Improvement 3: Structured error types ───────────────────────────────────

  describe('structured errors (borrowed from DeepSeekAdapter)', () => {
    test('sendMessage throws AgentError from Errors.inputNotFound when composer not found', async () => {
      jest.spyOn(adapter, '_prepareInput').mockResolvedValue(null);

      await expect(adapter.sendMessage('test')).rejects.toMatchObject({
        name: 'AgentError',
        acpBrowserRecoverable: true,
        retryable: false,
      });
    });

    test('sendMessage error includes helpful message with detail', async () => {
      adapter._inputFailure = 'No visible composer';
      jest.spyOn(adapter, '_prepareInput').mockResolvedValue(null);

      try {
        await adapter.sendMessage('test');
        fail('Should have thrown');
      } catch (err) {
        expect(err.message).toContain('No visible composer');
        expect(err.message).toContain('forge-agent --model=doubao --test-model');
      }
    });

    test('waitForResponse throws Errors.responseTimeout on no response', async () => {
      const fastAdapter = new DoubaoAdapter(mockPage, {
        ...mockConfig,
        RESPONSE_TIMEOUT: 100,
        APPEAR_TIMEOUT: 50,
        GENERATION_POLL: 10,
        STABLE_DELAY: 10,
      });
      jest.spyOn(fastAdapter, '_getLastAssistantText').mockResolvedValue(null);
      jest.spyOn(fastAdapter, '_isGenerating').mockResolvedValue(false);
      jest.spyOn(fastAdapter, '_getMessageCount').mockResolvedValue(0);

      await expect(fastAdapter.waitForResponse()).rejects.toMatchObject({
        name: 'AgentError',
        retryable: true,
      });
    });

    test('waitForResponse throws Errors.emptyResponse when cleaned text is empty', async () => {
      const fastAdapter = new DoubaoAdapter(mockPage, {
        ...mockConfig,
        RESPONSE_TIMEOUT: 100,
        APPEAR_TIMEOUT: 50,
        GENERATION_POLL: 10,
        STABLE_DELAY: 10,
      });
      fastAdapter._lastTextBefore = '';
      jest.spyOn(fastAdapter, '_getLastAssistantText').mockResolvedValue('different text');
      jest.spyOn(fastAdapter, '_isGenerating').mockResolvedValue(false);
      jest.spyOn(fastAdapter, '_getMessageCount').mockResolvedValue(1);
      jest.spyOn(fastAdapter, '_cleanText').mockReturnValue('');

      await expect(fastAdapter.waitForResponse()).rejects.toMatchObject({
        name: 'AgentError',
        retryable: true,
      });
    });
  });

  // ── Improvement 4: Enhanced text cleaning ───────────────────────────────────

  describe('_cleanText (enhanced with BaseAdapter patterns)', () => {
    test('strips think tags', () => {
      const input = '<' + 'think' + '>reasoning<' + '/think' + '>\nAnswer';
      expect(adapter._cleanText(input)).toBe('Answer');
    });

    test('strips Thinking... headers (new from BaseAdapter)', () => {
      const result = adapter._cleanText('Thinking...\nsome reasoning\n\nActual answer');
      expect(result).toBe('Actual answer');
    });

    test('strips model prefixes', () => {
      expect(adapter._cleanText('Assistant: hello')).toBe('hello');
      expect(adapter._cleanText('AI: hello')).toBe('hello');
      expect(adapter._cleanText('Doubao: hello')).toBe('hello');
      expect(adapter._cleanText('豆包: hello')).toBe('hello');
    });

    test('strips copy button artifacts', () => {
      expect(adapter._cleanText('some code\n1Copy')).toBe('some code');
      expect(adapter._cleanText('code\nCopy code')).toBe('code');
    });

    test('strips Doubao promotion text', () => {
      expect(adapter._cleanText('answer\n下载豆包电脑版')).toBe('answer');
      expect(adapter._cleanText('answer\n下载豆包电脑版了解更多')).toBe('answer');
    });

    test('strips page indicators (new from BaseAdapter)', () => {
      expect(adapter._cleanText('answer\n1 / 3')).toBe('answer');
      expect(adapter._cleanText('answer\n12 / 50')).toBe('answer');
    });

    test('collapses multiple blank lines', () => {
      expect(adapter._cleanText('line 1\n\n\n\nline 2')).toBe('line 1\n\nline 2');
    });

    test('handles null and undefined', () => {
      expect(adapter._cleanText(null)).toBe('');
      expect(adapter._cleanText(undefined)).toBe('');
    });

    test('returns empty string for whitespace-only input', () => {
      expect(adapter._cleanText('   \n  \n  ')).toBe('');
    });
  });

  // ── Improvement 5: Input fallback chain ─────────────────────────────────────

  describe('_prepareInput keyboard fallback (borrowed from BaseAdapter _typeText)', () => {
    test('falls back to keyboard input when fill() fails', async () => {
      const mockComposer = {
        fill: jest.fn().mockRejectedValue(new Error('fill failed')),
        click: jest.fn().mockResolvedValue(undefined),
        type: jest.fn().mockResolvedValue(undefined),
        evaluate: jest.fn().mockResolvedValue('test text'),
        press: jest.fn().mockResolvedValue(undefined),
      };

      mockPage.locator = jest.fn().mockReturnValue({
        count: jest.fn().mockResolvedValue(1),
        nth: jest.fn().mockReturnValue({
          isEditable: jest.fn().mockResolvedValue(true),
          ...mockComposer,
        }),
      });

      adapter._isFirstMessage = false;

      const result = await adapter._prepareInput('test text', 5000);

      expect(mockComposer.fill).toHaveBeenCalled();
      expect(mockComposer.click).toHaveBeenCalled();
      expect(mockComposer.type).toHaveBeenCalledWith('test text', { delay: 0 });
      expect(mockPage.keyboard.press).toHaveBeenCalledWith('Control+a');
      expect(mockPage.keyboard.press).toHaveBeenCalledWith('Backspace');
    });

    test('returns composer when fill() succeeds and text matches', async () => {
      const mockComposer = {
        fill: jest.fn().mockResolvedValue(undefined),
        click: jest.fn(),
        type: jest.fn(),
        evaluate: jest.fn().mockResolvedValue('hello'),
        press: jest.fn(),
      };

      mockPage.locator = jest.fn().mockReturnValue({
        count: jest.fn().mockResolvedValue(1),
        nth: jest.fn().mockReturnValue({
          isEditable: jest.fn().mockResolvedValue(true),
          ...mockComposer,
        }),
      });

      adapter._isFirstMessage = false;

      const result = await adapter._prepareInput('hello', 5000);

      expect(result).toBeDefined();
      expect(mockComposer.fill).toHaveBeenCalledWith('hello', expect.any(Object));
    });

    test('returns null when no composer found within timeout', async () => {
      mockPage.locator = jest.fn().mockReturnValue({
        count: jest.fn().mockResolvedValue(0),
        nth: jest.fn(),
      });

      const result = await adapter._prepareInput('hello', 100);

      expect(result).toBeNull();
    });

    test('throws when page is closed', async () => {
      mockPage.isClosed = jest.fn().mockReturnValue(true);

      await expect(adapter._prepareInput('hello', 5000)).rejects.toThrow('closed');
    });
  });

  // ── Improvement 6: testSelectors override ───────────────────────────────────

  describe('testSelectors (Doubao-specific diagnostics)', () => {
    test('includes proseMirror field in results', async () => {
      const baseResult = {
        model: 'DoubaoAdapter',
        url: 'https://www.doubao.com/chat',
        input: false,
        send: false,
        response: false,
        newChat: false,
        errors: [],
        ready: false,
      };

      jest.spyOn(BaseAdapter.prototype, 'testSelectors').mockResolvedValue(baseResult);
      mockPage.$ = jest.fn().mockResolvedValue(null);

      const result = await adapter.testSelectors();

      expect(result).toHaveProperty('proseMirror');
      expect(result).toHaveProperty('chineseUI');
    });

    test('detects ProseMirror editor when present', async () => {
      const baseResult = {
        model: 'DoubaoAdapter',
        url: 'https://www.doubao.com/chat',
        input: true,
        send: true,
        response: false,
        newChat: false,
        errors: [],
        ready: true,
      };

      jest.spyOn(BaseAdapter.prototype, 'testSelectors').mockResolvedValue(baseResult);
      const mockPM = { isVisible: jest.fn().mockResolvedValue(true) };
      mockPage.$ = jest.fn((sel) => {
        if (sel.includes('ProseMirror')) return Promise.resolve(mockPM);
        return Promise.resolve(null);
      });

      const result = await adapter.testSelectors();

      expect(result.proseMirror).toBe(true);
    });

    test('reports error when ProseMirror not found', async () => {
      const baseResult = {
        model: 'DoubaoAdapter',
        url: 'https://www.doubao.com/chat',
        input: false,
        send: false,
        response: false,
        newChat: false,
        errors: [],
        ready: false,
      };

      jest.spyOn(BaseAdapter.prototype, 'testSelectors').mockResolvedValue(baseResult);
      mockPage.$ = jest.fn().mockResolvedValue(null);

      const result = await adapter.testSelectors();

      expect(result.proseMirror).toBe(false);
      expect(result.errors.some(e => e.includes('ProseMirror'))).toBe(true);
    });

    test('detects Chinese UI when 新对话 button present', async () => {
      const baseResult = {
        model: 'DoubaoAdapter',
        url: 'https://www.doubao.com/chat',
        input: true,
        send: true,
        response: false,
        newChat: true,
        errors: [],
        ready: true,
      };

      jest.spyOn(BaseAdapter.prototype, 'testSelectors').mockResolvedValue(baseResult);
      mockPage.$ = jest.fn().mockResolvedValue({ isVisible: jest.fn().mockResolvedValue(true) });

      const result = await adapter.testSelectors();

      expect(result.chineseUI).toBe(true);
    });

    test('ready is true when proseMirror is true even if base ready is false', async () => {
      const baseResult = {
        model: 'DoubaoAdapter',
        url: 'https://www.doubao.com/chat',
        input: false,
        send: false,
        response: false,
        newChat: false,
        errors: [],
        ready: false,
      };

      jest.spyOn(BaseAdapter.prototype, 'testSelectors').mockResolvedValue(baseResult);
      mockPage.$ = jest.fn((sel) => {
        if (sel.includes('ProseMirror')) return Promise.resolve({ isVisible: jest.fn().mockResolvedValue(true) });
        return Promise.resolve(null);
      });

      const result = await adapter.testSelectors();

      expect(result.ready).toBe(true);
    });
  });

  // ── Adapter factory integration ─────────────────────────────────────────────

  describe('adapter factory integration', () => {
    test('getAdapter returns DoubaoAdapter instance', () => {
      expect(getAdapter('doubao', mockPage, mockConfig)).toBeInstanceOf(DoubaoAdapter);
    });

    test('handles Chinese alias 豆包', () => {
      expect(getAdapter('豆包', mockPage, mockConfig)).toBeInstanceOf(DoubaoAdapter);
    });

    test('getModelUrl returns correct URL', () => {
      expect(getModelUrl('doubao')).toBe('https://www.doubao.com/chat');
    });

    test('getModelDisplayName returns human string', () => {
      expect(getModelDisplayName('doubao')).toBe('Doubao (豆包)');
    });
  });
});
