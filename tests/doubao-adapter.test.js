// tests/doubao-adapter.test.js — Doubao adapter unit tests
'use strict';

const DoubaoAdapter = require('../src/adapters/doubao-adapter');
const BaseAdapter   = require('../src/adapters/base-adapter');
const { getAdapter, getModelUrl, getModelDisplayName, SUPPORTED_MODELS } = require('../src/adapter-factory');

const mockPage = {
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
    first: {
      fill: jest.fn().mockResolvedValue(undefined),
      evaluate: jest.fn().mockResolvedValue('test'),
      press: jest.fn().mockResolvedValue(undefined),
    },
  }),
};

const mockConfig = {
  STABLE_DELAY: 1500,
  RESPONSE_TIMEOUT: 60000,
  GENERATION_POLL: 400,
  SEND_DELAY: 600,
  BROWSER_TIMEOUT: 30000,
};

describe('DoubaoAdapter', () => {
  let adapter;

  beforeEach(() => {
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

  test('_cleanText strips thinking blocks', () => {
    expect(adapter._cleanText('<tool_call>todowrite