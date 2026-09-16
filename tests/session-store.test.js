// tests/session-store.test.js — Session store unit tests
'use strict';

const fs       = require('fs');
const path     = require('path');
const os       = require('os');
const crypto   = require('crypto');
const SessionStore = require('../src/session-store');

const TEST_DIR = path.join(os.tmpdir(), 'forge-session-test-' + Date.now());

beforeAll(() => {
  fs.mkdirSync(TEST_DIR, { recursive: true });
});

afterAll(() => {
  try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
});

describe('SessionStore', () => {
  test('create initializes a new session', () => {
    const store = SessionStore.create('test-1', '/tmp');
    const data = store.load();
    expect(data).not.toBeNull();
    expect(data.sessionId).toBe('test-1');
    expect(data.cwd).toBe('/tmp');
    expect(data.status).toBe('idle');
    expect(data.lastPromptHash).toBeNull();
    expect(data.lastOutput).toBeNull();
  });

  test('save and load round-trips correctly', () => {
    const store = SessionStore.create('test-2', '/tmp');
    store.save({
      version        : 1,
      sessionId      : 'test-2',
      cwd            : '/tmp',
      status         : 'running',
      lastPromptHash : 'abc123',
      lastOutput     : 'some output',
      createdAt      : new Date().toISOString(),
    });
    const data = store.load();
    expect(data.status).toBe('running');
    expect(data.lastPromptHash).toBe('abc123');
    expect(data.lastOutput).toBe('some output');
  });

  test('isIdempotentReplay returns cached output for same prompt', () => {
    const store = SessionStore.create('test-3', '/tmp');
    const prompt = 'hello world';
    const hash = crypto.createHash('sha256').update(prompt).digest('hex');

    store.save({
      version        : 1,
      sessionId      : 'test-3',
      cwd            : '/tmp',
      status         : 'idle',
      lastPromptHash : hash,
      lastOutput     : 'cached result',
      createdAt      : new Date().toISOString(),
    });

    const result = store.isIdempotentReplay(prompt);
    expect(result).toBe('cached result');
  });

  test('isIdempotentReplay returns null for different prompt', () => {
    const store = SessionStore.create('test-4', '/tmp');
    const hash = crypto.createHash('sha256').update('first prompt').digest('hex');

    store.save({
      version        : 1,
      sessionId      : 'test-4',
      cwd            : '/tmp',
      status         : 'idle',
      lastPromptHash : hash,
      lastOutput     : 'cached result',
      createdAt      : new Date().toISOString(),
    });

    const result = store.isIdempotentReplay('different prompt');
    expect(result).toBeNull();
  });

  test('isIdempotentReplay returns null when status is running', () => {
    const store = SessionStore.create('test-5', '/tmp');
    const prompt = 'hello';
    const hash = crypto.createHash('sha256').update(prompt).digest('hex');

    store.save({
      version        : 1,
      sessionId      : 'test-5',
      cwd            : '/tmp',
      status         : 'running',
      lastPromptHash : hash,
      lastOutput     : 'cached result',
      createdAt      : new Date().toISOString(),
    });

    const result = store.isIdempotentReplay(prompt);
    expect(result).toBeNull();
  });

  test('recordPrompt updates hash and status', () => {
    const store = SessionStore.create('test-6', '/tmp');
    store.recordPrompt('my task');
    const data = store.load();
    expect(data.status).toBe('running');
    expect(data.lastPromptHash).toBeDefined();
  });

  test('recordOutput sets status to idle', () => {
    const store = SessionStore.create('test-7', '/tmp');
    store.recordPrompt('my task');
    store.recordOutput('task result');
    const data = store.load();
    expect(data.status).toBe('idle');
    expect(data.lastOutput).toBe('task result');
  });

  test('markInterrupted sets status', () => {
    const store = SessionStore.create('test-8', '/tmp');
    store.recordPrompt('my task');
    store.markInterrupted();
    const data = store.load();
    expect(data.status).toBe('interrupted');
  });

  test('load returns null for non-existent session', () => {
    const store = new SessionStore('nonexistent-' + Date.now());
    expect(store.load()).toBeNull();
  });

  test('load throws on invalid version', () => {
    const store = SessionStore.create('test-9', '/tmp');
    store.save({
      version   : 99,
      sessionId : 'test-9',
      cwd       : '/tmp',
      status    : 'idle',
    });
    expect(() => store.load()).toThrow('Invalid session version');
  });

  test('load throws on invalid status', () => {
    const store = SessionStore.create('test-10', '/tmp');
    store.save({
      version   : 1,
      sessionId : 'test-10',
      cwd       : '/tmp',
      status    : 'bogus',
    });
    expect(() => store.load()).toThrow('Invalid session status');
  });

  test('acquire and release lock', () => {
    const store = SessionStore.create('test-11', '/tmp');
    expect(store.acquire()).toBe(true);
    store.release();
  });

  test('acquire fails when lock is held', () => {
    const store1 = SessionStore.create('test-12', '/tmp');
    const store2 = new SessionStore('test-12');
    expect(store1.acquire()).toBe(true);
    expect(() => store2.acquire()).toThrow('SESSION_BUSY');
    store1.release();
  });
});
