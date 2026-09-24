'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');

describe('--login CLI argument', () => {
  test('--help output contains login options and AUTHENTICATION section', () => {
    const result = spawnSync(process.execPath, [path.join(root, 'src/index.js'), '--help'], {
      encoding: 'utf8',
      timeout: 10000,
      env: { ...process.env, NODE_ENV: 'test' },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('--login');
    expect(result.stdout).toContain('--force-relogin');
    expect(result.stdout).toContain('AUTHENTICATION');
  });

  test('--force-relogin requires --login', () => {
    const result = spawnSync(process.execPath, [path.join(root, 'src/index.js'), '--force-relogin'], {
      encoding: 'utf8',
      timeout: 10000,
      env: { ...process.env, NODE_ENV: 'test' },
    });
    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain('--force-relogin must be used with --login');
  });


});

describe('BROWSER_MINIMIZED config default', () => {
  test('default is false', () => {
    const config = require('../src/config');
    expect(config.DEFAULTS.BROWSER_MINIMIZED).toBe(false);
  });
});

describe('browser.js launch with BROWSER_MINIMIZED', () => {
  test('adds --start-minimized arg when BROWSER_MINIMIZED is true', () => {
    const mockPage = {
      goto: jest.fn().mockResolvedValue(undefined),
      waitForTimeout: jest.fn().mockResolvedValue(undefined),
      addInitScript: jest.fn().mockResolvedValue(undefined),
      $: jest.fn(),
    };
    const mockContext = {
      pages: jest.fn().mockReturnValue([mockPage]),
      newPage: jest.fn().mockResolvedValue(mockPage),
      close: jest.fn().mockResolvedValue(undefined),
    };

    jest.resetModules();
    jest.doMock('playwright', () => ({
      chromium: {
        launchPersistentContext: jest.fn().mockResolvedValue(mockContext),
      },
    }));
    jest.doMock('../src/config', () => ({
      MODEL: 'deepseek',
      SESSION_DIR: '/tmp/test-session',
      HEADLESS: false,
      BROWSER_MINIMIZED: true,
      ACP_AUTH_FILE: null,
      RESPONSE_TIMEOUT: 5000,
      BROWSER_TIMEOUT: 30000,
    }));
    jest.doMock('../src/logger', () => ({
      info: jest.fn(), success: jest.fn(), warn: jest.fn(),
      error: jest.fn(), dim: jest.fn(), thinking: jest.fn(), clearLine: jest.fn(),
    }));
    jest.doMock('../src/adapter-factory', () => ({
      getAdapter: jest.fn().mockReturnValue({
        isReady: jest.fn().mockResolvedValue(true),
        sendMessage: jest.fn(), waitForResponse: jest.fn(), newChat: jest.fn(),
      }),
      getModelUrl: jest.fn().mockReturnValue('https://chat.deepseek.com'),
    }));
    jest.doMock('../src/health', () => ({
      runHealthCheck: jest.fn().mockResolvedValue({ checks: [], passed: 6, warned: 0, failed: 0, healthy: true }),
    }));

    const DeepSeekBrowser = require('../src/browser');
    const { chromium } = require('playwright');
    const browser = new DeepSeekBrowser();

    return browser.launch().then(() => {
      const callArgs = chromium.launchPersistentContext.mock.calls[0][1];
      expect(callArgs.args).toContain('--start-minimized');
    });
  });

  test('does not add --start-minimized when BROWSER_MINIMIZED is false', () => {
    const mockPage = {
      goto: jest.fn().mockResolvedValue(undefined),
      waitForTimeout: jest.fn().mockResolvedValue(undefined),
      addInitScript: jest.fn().mockResolvedValue(undefined),
      $: jest.fn(),
    };
    const mockContext = {
      pages: jest.fn().mockReturnValue([mockPage]),
      newPage: jest.fn().mockResolvedValue(mockPage),
      close: jest.fn().mockResolvedValue(undefined),
    };

    jest.resetModules();
    jest.doMock('playwright', () => ({
      chromium: {
        launchPersistentContext: jest.fn().mockResolvedValue(mockContext),
      },
    }));
    jest.doMock('../src/config', () => ({
      MODEL: 'deepseek',
      SESSION_DIR: '/tmp/test-session',
      HEADLESS: false,
      BROWSER_MINIMIZED: false,
      ACP_AUTH_FILE: null,
      RESPONSE_TIMEOUT: 5000,
      BROWSER_TIMEOUT: 30000,
    }));
    jest.doMock('../src/logger', () => ({
      info: jest.fn(), success: jest.fn(), warn: jest.fn(),
      error: jest.fn(), dim: jest.fn(), thinking: jest.fn(), clearLine: jest.fn(),
    }));
    jest.doMock('../src/adapter-factory', () => ({
      getAdapter: jest.fn().mockReturnValue({
        isReady: jest.fn().mockResolvedValue(true),
        sendMessage: jest.fn(), waitForResponse: jest.fn(), newChat: jest.fn(),
      }),
      getModelUrl: jest.fn().mockReturnValue('https://chat.deepseek.com'),
    }));
    jest.doMock('../src/health', () => ({
      runHealthCheck: jest.fn().mockResolvedValue({ checks: [], passed: 6, warned: 0, failed: 0, healthy: true }),
    }));

    const DeepSeekBrowser = require('../src/browser');
    const { chromium } = require('playwright');
    const browser = new DeepSeekBrowser();

    return browser.launch().then(() => {
      const callArgs = chromium.launchPersistentContext.mock.calls[0][1];
      expect(callArgs.args).not.toContain('--start-minimized');
    });
  });
});
