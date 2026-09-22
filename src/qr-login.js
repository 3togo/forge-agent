// src/qr-login.js — QR code login for browser-based model adapters
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const logger = require('./logger');

const QR_IMAGE_DIR = path.join(os.homedir(), '.deepseek-agent', 'qr-login');

function getVenvPython() { return path.join(os.homedir(), 'venv', 'bin', 'python'); }
function getVenvQr() { return path.join(os.homedir(), 'venv', 'bin', 'qr'); }

const QR_SELECTORS = [
  'img[class*="qr"]',
  'img[class*="scan"]',
  'img[class*="code"]',
  'img[alt*="qr"]',
  'img[alt*="scan"]',
  'img[alt*="二维码"]',
  '[class*="qrcode"] img',
  '[class*="qr-code"] img',
  '[class*="qr_container"] img',
  '[class*="scan-code"] img',
  '[class*="login-qr"] img',
  '[class*="login-scan"] img',
  'canvas[class*="qr"]',
  'canvas[class*="scan"]',
  'canvas[class*="code"]',
  '[class*="qr-img"]',
  '[class*="qr-image"]',
];

const QR_TAB_SELECTORS = [
  'text=扫码登录',
  'text=二维码登录',
  'text=扫码',
  '[class*="qr-tab"]',
  '[class*="scan-tab"]',
  '[class*="qr-login-tab"]',
  '[class*="qr_login_tab"]',
];

function findPython() {
  const venv = getVenvPython();
  if (fs.existsSync(venv)) return venv;
  for (const candidate of ['python3', 'python']) {
    try {
      const result = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
      if (result && result.status === 0) return candidate;
    } catch {}
  }
  return null;
}

function findQrTool() {
  const venv = getVenvQr();
  if (fs.existsSync(venv)) return venv;
  try {
    const result = spawnSync('which', ['qr'], { encoding: 'utf8' });
    if (result && result.status === 0 && result.stdout.trim()) return result.stdout.trim();
  } catch {}
  return null;
}

class QrLoginManager {
  constructor(page, model, options = {}) {
    this.page = page;
    this.model = model;
    this.timeout = options.timeout || 180000;
    this.pollInterval = options.pollInterval || 2000;
    this.qrRefreshCheckInterval = options.qrRefreshCheckInterval || 5000;
    this.lastQrHash = null;
    this.qrImagePath = null;
    this.pythonBin = options.pythonBin || findPython();
    this.qrBin = options.qrBin || findQrTool();
  }

  async tryQrLogin(onQrReady) {
    await this._clickQrTab();
    await this.page.waitForTimeout(2000);

    const qrElement = await this._detectQrElement();
    if (!qrElement) {
      logger.dim('No QR code element found on login page');
      return false;
    }

    const displayed = await this._displayQrCode(qrElement, onQrReady);
    if (!displayed) return false;

    const loggedIn = await this._waitForLoginWithRefresh(qrElement, onQrReady);
    this._cleanup();
    return loggedIn;
  }

  async _clickQrTab() {
    for (const selector of QR_TAB_SELECTORS) {
      try {
        const element = await this.page.$(selector);
        if (element && await element.isVisible()) {
          await element.click();
          await this.page.waitForTimeout(1000);
          logger.dim('Clicked QR login tab');
          return;
        }
      } catch {}
    }
  }

  async _detectQrElement() {
    for (const selector of QR_SELECTORS) {
      try {
        const element = await this.page.$(selector);
        if (element && await element.isVisible()) {
          const box = await element.boundingBox();
          if (box && box.width > 50 && box.height > 50) {
            logger.dim(`Found QR code element: ${selector} (${Math.round(box.width)}x${Math.round(box.height)})`);
            return element;
          }
        }
      } catch {}
    }
    return null;
  }

  async _displayQrCode(qrElement, onQrReady) {
    let screenshot;
    try {
      screenshot = await qrElement.screenshot();
    } catch (err) {
      logger.warn(`QR screenshot failed: ${err.message}`);
      return false;
    }

    this.lastQrHash = this._hashBuffer(screenshot);

    fs.mkdirSync(QR_IMAGE_DIR, { recursive: true, mode: 0o700 });
    this.qrImagePath = path.join(QR_IMAGE_DIR, `${this.model}-qr-${Date.now()}.png`);
    fs.writeFileSync(this.qrImagePath, screenshot, { mode: 0o600 });

    let qrUrl = null;
    try {
      qrUrl = await this._decodeQrUrl(screenshot);
    } catch (err) {
      logger.dim(`QR decode skipped: ${err.message}`);
    }

    if (qrUrl) {
      this._displayQrInTerminal(qrUrl);
    } else {
      this._openQrImage();
    }

    if (onQrReady) {
      try { await onQrReady({ imagePath: this.qrImagePath, qrUrl }); }
      catch (err) { logger.dim(`onQrReady callback error: ${err.message}`); }
    }

    return true;
  }

  async _decodeQrUrl(screenshot) {
    if (!this.pythonBin) return null;

    const tempIn = path.join(QR_IMAGE_DIR, `_decode-${Date.now()}.png`);
    fs.mkdirSync(QR_IMAGE_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(tempIn, screenshot, { mode: 0o600 });

    try {
      const script = `
from pyzbar.pyzbar import decode
from PIL import Image
import json, sys
results = decode(Image.open(sys.argv[1]))
if results:
    print(results[0].data.decode('utf-8'))
`;
      const result = spawnSync(this.pythonBin, ['-c', script, tempIn], {
        encoding: 'utf8',
        timeout: 10000,
      });
      if (result.status === 0 && result.stdout.trim()) {
        return result.stdout.trim();
      }
      return null;
    } finally {
      try { fs.unlinkSync(tempIn); } catch {}
    }
  }

  _displayQrInTerminal(qrUrl) {
    if (this.qrBin) {
      const result = spawnSync(this.qrBin, [qrUrl], {
        encoding: 'utf8',
        timeout: 10000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      if (result.status === 0 && result.stdout) {
        logger.info('');
        logger.info('╔══════════════════════════════════════════════╗');
        logger.info('║  📱  SCAN QR CODE TO LOGIN                    ║');
        logger.info('║                                              ║');
        logger.info(`║  Model: ${this.model.padEnd(38)}║`);
        logger.info('║  Scan the QR code below with your phone     ║');
        logger.info('╚══════════════════════════════════════════════╝');
        console.log(result.stdout);
        logger.info('');
        return;
      }
    }

    let qrcode;
    try { qrcode = require('qrcode-terminal'); } catch {
      logger.info(`QR URL: ${qrUrl}`);
      logger.info('Install qrcode-terminal or ~/venv/bin/qr for terminal QR display.');
      return;
    }

    logger.info('');
    logger.info('╔══════════════════════════════════════════════╗');
    logger.info('║  📱  SCAN QR CODE TO LOGIN                    ║');
    logger.info('║                                              ║');
    logger.info(`║  Model: ${this.model.padEnd(38)}║`);
    logger.info('║  Scan the QR code below with your phone     ║');
    logger.info('╚══════════════════════════════════════════════╝');
    qrcode.generate(qrUrl, { small: true }, (output) => {
      console.log(output);
    });
    logger.info('');
  }

  _openQrImage() {
    const openCommands = {
      linux: ['xdg-open'],
      darwin: ['open'],
      win32: ['cmd', '/c', 'start'],
    };
    const [cmd, ...args] = openCommands[process.platform] || [];
    if (cmd) {
      try {
        spawnSync(cmd, [...args, this.qrImagePath], { detached: true, stdio: 'ignore' });
        logger.info(`QR code image opened: ${this.qrImagePath}`);
      } catch {
        logger.info(`QR code image saved: ${this.qrImagePath}`);
      }
    } else {
      logger.info(`QR code image saved: ${this.qrImagePath}`);
    }
  }

  async _waitForLoginWithRefresh(qrElement, onQrReady) {
    const until = Date.now() + this.timeout;
    let lastRefreshCheck = Date.now();

    while (Date.now() < until) {
      if (await this._isLoginSuccess()) return true;

      if (Date.now() - lastRefreshCheck >= this.qrRefreshCheckInterval) {
        lastRefreshCheck = Date.now();
        try {
          const currentScreenshot = await qrElement.screenshot();
          const currentHash = this._hashBuffer(currentScreenshot);

          if (this.lastQrHash && currentHash !== this.lastQrHash) {
            logger.dim('QR code refreshed — updating display');
            this.lastQrHash = currentHash;
            fs.writeFileSync(this.qrImagePath, currentScreenshot, { mode: 0o600 });

            let qrUrl = null;
            try { qrUrl = await this._decodeQrUrl(currentScreenshot); } catch {}

            if (qrUrl) {
              this._displayQrInTerminal(qrUrl);
            }

            if (onQrReady) {
              try { await onQrReady({ imagePath: this.qrImagePath, qrUrl, refreshed: true }); }
              catch (err) { logger.dim(`onQrReady callback error: ${err.message}`); }
            }
          }
        } catch {
          if (await this._isLoginSuccess()) return true;
        }
      }

      await new Promise(resolve => setTimeout(resolve, this.pollInterval));
    }

    logger.warn('QR login timed out');
    return false;
  }

  _hashBuffer(buffer) {
    return crypto.createHash('md5').update(buffer).digest('hex');
  }

  async _isLoginSuccess() {
    const inputSelectors = ['textarea', 'div[contenteditable="true"]', '.ProseMirror'];
    for (const sel of inputSelectors) {
      try {
        const el = await this.page.$(sel);
        if (el && await el.isVisible()) return true;
      } catch {}
    }
    return false;
  }

  _cleanup() {
    if (this.qrImagePath) {
      try { fs.unlinkSync(this.qrImagePath); } catch {}
      this.qrImagePath = null;
    }
  }
}

module.exports = { QrLoginManager, QR_IMAGE_DIR, QR_SELECTORS, QR_TAB_SELECTORS, findPython, findQrTool };
