'use strict';
jest.mock('child_process', () => ({ spawnSync: jest.fn() }));
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { QrLoginManager, QR_SELECTORS, QR_TAB_SELECTORS, findPython, findQrTool } = require('../src/qr-login');
const { isAuthValid, getAuthAge } = require('../src/browser-auth');

describe('findPython', () => {
  let existsSpy;
  beforeEach(() => { spawnSync.mockReset(); existsSpy = jest.spyOn(fs, 'existsSync'); });
  afterEach(() => { existsSpy.mockRestore(); });
  test('returns venv python when it exists', () => {
    existsSpy.mockImplementation(p => p.includes('venv/bin/python'));
    expect(findPython()).toContain('venv/bin/python');
  });
  test('falls back to system python3', () => {
    existsSpy.mockReturnValue(false);
    spawnSync.mockImplementation((cmd) => {
      if (cmd === 'python3') return { status: 0, stdout: 'Python 3.10', stderr: '' };
      return { status: 1, stdout: '', stderr: '' };
    });
    expect(findPython()).toBe('python3');
  });
  test('returns null when no python found', () => {
    existsSpy.mockReturnValue(false);
    spawnSync.mockReturnValue({ status: 1, stdout: '', stderr: '' });
    expect(findPython()).toBeNull();
  });
  test('returns null when spawnSync returns undefined', () => {
    existsSpy.mockReturnValue(false);
    spawnSync.mockReturnValue(undefined);
    expect(findPython()).toBeNull();
  });
});

describe('findQrTool', () => {
  let existsSpy;
  beforeEach(() => { spawnSync.mockReset(); existsSpy = jest.spyOn(fs, 'existsSync'); });
  afterEach(() => { existsSpy.mockRestore(); });
  test('returns venv qr when it exists', () => {
    existsSpy.mockImplementation(p => p.includes('venv/bin/qr'));
    expect(findQrTool()).toContain('venv/bin/qr');
  });
  test('falls back to system qr via which', () => {
    existsSpy.mockReturnValue(false);
    spawnSync.mockImplementation((cmd, args) => {
      if (cmd === 'which' && args[0] === 'qr') return { status: 0, stdout: '/usr/bin/qr\n', stderr: '' };
      return { status: 1, stdout: '', stderr: '' };
    });
    expect(findQrTool()).toBe('/usr/bin/qr');
  });
  test('returns null when no qr tool found', () => {
    existsSpy.mockReturnValue(false);
    spawnSync.mockReturnValue({ status: 1, stdout: '', stderr: '' });
    expect(findQrTool()).toBeNull();
  });
});

describe('QrLoginManager', () => {
  let page, manager, output;

  beforeEach(() => {
    page = {
      $: jest.fn(),
      waitForTimeout: jest.fn().mockResolvedValue(),
      url: jest.fn().mockReturnValue('https://chat.deepseek.com'),
    };
    manager = new QrLoginManager(page, 'deepseek', {
      timeout: 5000, pollInterval: 100, qrRefreshCheckInterval: 200,
      pythonBin: '/fake/python', qrBin: '/fake/qr',
    });
    output = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    spawnSync.mockReset();
  });
  afterEach(() => {
    output.mockRestore();
    manager._cleanup();
  });

  describe('_clickQrTab', () => {
    test('clicks visible QR tab element', async () => {
      const element = { click: jest.fn(), isVisible: jest.fn().mockResolvedValue(true) };
      page.$.mockResolvedValue(element);
      await manager._clickQrTab();
      expect(element.click).toHaveBeenCalled();
    });
    test('does nothing when no QR tab found', async () => {
      page.$.mockResolvedValue(null);
      await manager._clickQrTab();
      expect(page.$).toHaveBeenCalled();
    });
    test('skips non-visible elements', async () => {
      const element = { click: jest.fn(), isVisible: jest.fn().mockResolvedValue(false) };
      page.$.mockResolvedValue(element);
      await manager._clickQrTab();
      expect(element.click).not.toHaveBeenCalled();
    });
  });

  describe('_detectQrElement', () => {
    test('finds visible QR element with sufficient size', async () => {
      const element = { isVisible: jest.fn().mockResolvedValue(true), boundingBox: jest.fn().mockResolvedValue({ width: 200, height: 200 }) };
      page.$.mockResolvedValue(element);
      const result = await manager._detectQrElement();
      expect(result).toBe(element);
    });
    test('skips elements smaller than 50px', async () => {
      const element = { isVisible: jest.fn().mockResolvedValue(true), boundingBox: jest.fn().mockResolvedValue({ width: 30, height: 30 }) };
      page.$.mockResolvedValue(element);
      const result = await manager._detectQrElement();
      expect(result).toBeNull();
    });
    test('returns null when no element found', async () => {
      page.$.mockResolvedValue(null);
      const result = await manager._detectQrElement();
      expect(result).toBeNull();
    });
  });

  describe('_decodeQrUrl', () => {
    test('returns null when no python available', async () => {
      manager.pythonBin = null;
      const result = await manager._decodeQrUrl(Buffer.from('fake'));
      expect(result).toBeNull();
    });
    test('decodes QR URL via pyzbar', async () => {
      const mkdirSpy = jest.spyOn(fs, 'mkdirSync').mockImplementation(() => {});
      const writeSpy = jest.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
      const unlinkSpy = jest.spyOn(fs, 'unlinkSync').mockImplementation(() => {});
      spawnSync.mockImplementation((cmd, args) => {
        if (cmd === '/fake/python' && args[0] === '-c') return { status: 0, stdout: 'https://login.example.com/qr?token=abc\n', stderr: '' };
        return { status: 1, stdout: '', stderr: '' };
      });
      const result = await manager._decodeQrUrl(Buffer.from('fake-png'));
      expect(result).toBe('https://login.example.com/qr?token=abc');
      mkdirSpy.mockRestore(); writeSpy.mockRestore(); unlinkSpy.mockRestore();
    });
    test('returns null on pyzbar failure', async () => {
      const mkdirSpy = jest.spyOn(fs, 'mkdirSync').mockImplementation(() => {});
      const writeSpy = jest.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
      const unlinkSpy = jest.spyOn(fs, 'unlinkSync').mockImplementation(() => {});
      spawnSync.mockReturnValue({ status: 1, stdout: '', stderr: 'error' });
      const result = await manager._decodeQrUrl(Buffer.from('fake-png'));
      expect(result).toBeNull();
      mkdirSpy.mockRestore(); writeSpy.mockRestore(); unlinkSpy.mockRestore();
    });
  });

  describe('_displayQrInTerminal', () => {
    test('uses qr tool when available', () => {
      spawnSync.mockImplementation((cmd, args) => {
        if (cmd === '/fake/qr') return { status: 0, stdout: '█████████\n█ QR █\n█████████\n', stderr: '' };
        return { status: 1, stdout: '', stderr: '' };
      });
      manager._displayQrInTerminal('https://example.com/login');
      expect(spawnSync).toHaveBeenCalledWith('/fake/qr', ['https://example.com/login'], expect.any(Object));
    });
    test('falls back to logging URL when no qr tool', () => {
      manager.qrBin = null;
      const stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
      manager._displayQrInTerminal('https://example.com/login');
      const allOutput = output.mock.calls.flat().join('') + stdoutSpy.mock.calls.flat().join('');
      expect(allOutput).toContain('https://example.com/login');
      stdoutSpy.mockRestore();
    });
  });

  describe('_isLoginSuccess', () => {
    test('returns true when input element is visible', async () => {
      const el = { isVisible: jest.fn().mockResolvedValue(true) };
      page.$.mockResolvedValue(el);
      expect(await manager._isLoginSuccess()).toBe(true);
    });
    test('returns false when no input element found', async () => {
      page.$.mockResolvedValue(null);
      expect(await manager._isLoginSuccess()).toBe(false);
    });
  });

  describe('_hashBuffer', () => {
    test('produces consistent hash for same input', () => {
      const buf = Buffer.from('test');
      expect(manager._hashBuffer(buf)).toBe(manager._hashBuffer(buf));
    });
    test('produces different hash for different input', () => {
      expect(manager._hashBuffer(Buffer.from('a'))).not.toBe(manager._hashBuffer(Buffer.from('b')));
    });
  });

  describe('tryQrLogin', () => {
    test('returns false when no QR element found', async () => {
      page.$.mockResolvedValue(null);
      const result = await manager.tryQrLogin();
      expect(result).toBe(false);
    });
    test('returns false when QR screenshot fails', async () => {
      const qrElement = {
        isVisible: jest.fn().mockResolvedValue(true),
        boundingBox: jest.fn().mockResolvedValue({ width: 200, height: 200 }),
        screenshot: jest.fn().mockRejectedValue(new Error('page closed')),
      };
      page.$.mockResolvedValue(qrElement);
      const result = await manager.tryQrLogin();
      expect(result).toBe(false);
    });
  });
});

describe('isAuthValid', () => {
  let temp;
  beforeEach(() => { temp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-auth-')); });
  afterEach(() => { fs.rmSync(temp, { recursive: true, force: true }); });

  test('returns false for non-existent file', () => {
    expect(isAuthValid(path.join(temp, 'nonexistent.json'))).toBe(false);
  });
  test('returns false for empty auth state', () => {
    const f = path.join(temp, 'auth.json');
    fs.writeFileSync(f, JSON.stringify({ cookies: [], origins: [] }));
    expect(isAuthValid(f)).toBe(false);
  });
  test('returns true for valid cookies', () => {
    const f = path.join(temp, 'auth.json');
    fs.writeFileSync(f, JSON.stringify({
      cookies: [{ name: 'session', value: 'abc', domain: '.deepseek.com', expires: -1 }],
      origins: [],
    }));
    expect(isAuthValid(f)).toBe(true);
  });
  test('returns true for valid localStorage', () => {
    const f = path.join(temp, 'auth.json');
    fs.writeFileSync(f, JSON.stringify({
      cookies: [],
      origins: [{ origin: 'https://chat.deepseek.com', localStorage: [{ name: 'token', value: 'xyz' }] }],
    }));
    expect(isAuthValid(f)).toBe(true);
  });
  test('returns false for expired cookies only', () => {
    const f = path.join(temp, 'auth.json');
    fs.writeFileSync(f, JSON.stringify({
      cookies: [{ name: 'session', value: 'abc', domain: '.deepseek.com', expires: 1 }],
      origins: [],
    }));
    expect(isAuthValid(f)).toBe(false);
  });
  test('returns false for invalid JSON', () => {
    const f = path.join(temp, 'auth.json');
    fs.writeFileSync(f, 'not json');
    expect(isAuthValid(f)).toBe(false);
  });
});

describe('getAuthAge', () => {
  let temp;
  beforeEach(() => { temp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-age-')); });
  afterEach(() => { fs.rmSync(temp, { recursive: true, force: true }); });

  test('returns Infinity for non-existent file', () => {
    expect(getAuthAge(path.join(temp, 'nonexistent.json'))).toBe(Infinity);
  });
  test('returns age in milliseconds', () => {
    const f = path.join(temp, 'auth.json');
    fs.writeFileSync(f, '{}');
    const age = getAuthAge(f);
    expect(age).toBeLessThan(5000);
  });
});

describe('QR_SELECTORS and QR_TAB_SELECTORS', () => {
  test('QR_SELECTORS includes img and canvas patterns', () => {
    expect(QR_SELECTORS.some(s => s.startsWith('img['))).toBe(true);
    expect(QR_SELECTORS.some(s => s.startsWith('canvas['))).toBe(true);
    expect(QR_SELECTORS.some(s => s.includes('qrcode'))).toBe(true);
  });
  test('QR_TAB_SELECTORS includes Chinese text patterns', () => {
    expect(QR_TAB_SELECTORS.some(s => s.includes('扫码'))).toBe(true);
    expect(QR_TAB_SELECTORS.some(s => s.includes('二维码'))).toBe(true);
  });
});
