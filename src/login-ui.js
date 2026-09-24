'use strict';

function duration(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

class LoginUI {
  constructor(output = process.stdout) {
    this.output = output;
    this.tty = Boolean(output.isTTY);
    this.lastSecond = null;
  }

  checkingExisting({ provider }) {
    this.output.write(`Checking saved ${provider} login…\n`);
  }

  forcingRelogin({ provider, credentialFile, backupFile }) {
    this.output.write(`Forcing a fresh ${provider} login.\n` +
      (backupFile ? `Previous credential backup: ${backupFile}\n` : 'No previous credential exists to back up.\n') +
      `Credential destination: ${credentialFile}\n`);
  }

  reloginReverted({ credentialFile }) {
    this.output.write(`Relogin did not complete; restored the previous credential:\n  ${credentialFile}\n`);
  }

  existingLoginRequired() {
    this.output.write('Saved login needs renewal; opening the interactive login window.\n');
  }

  refreshed(file) {
    this.output.write(`✓ Yuanbao login is valid; credentials refreshed.\n  ${file}\n\n`);
  }

  preparingQr({ provider, timeout }) {
    this.output.write(`Preparing headless ${provider} QR login (${duration(timeout)} timeout)…\n`);
  }

  qrReady({ imagePath, refreshed = false }) {
    this.output.write(`${refreshed ? '↻ QR code refreshed' : '● Scan the QR code'} with WeChat:\n` +
      `  ${imagePath}\nKeep this command running until confirmation.\n`);
  }

  qrUnavailable() {
    this.output.write('QR extraction is unavailable; opening the guided browser login instead.\n');
  }

  start({ provider, credentialFile, timeout, existingCredential = false }) {
    this.output.write(`\n` +
      `╭─ ${provider} login ${'─'.repeat(48)}\n` +
      `│ A dedicated browser window will open.\n` +
      `│\n` +
      `│  1. Choose WeChat, Phone, or QQ in the Yuanbao login panel.\n` +
      `│  2. Finish authentication in that window.\n` +
      `│  3. Keep it open; Forge will verify and close it automatically.\n` +
      `│\n` +
      `│ Credential destination: ${credentialFile}\n` +
      `│ Timeout: ${duration(timeout)}\n` +
      `╰${'─'.repeat(66)}\n\n`);
  }

  browserOpened(loginPanelOpened) {
    this.output.write(loginPanelOpened
      ? '● Yuanbao login panel is ready in the browser.\n'
      : '● Browser opened. Select “Log In” if the login panel is not visible.\n');
  }

  waiting(remainingMs) {
    const second = Math.max(0, Math.ceil(remainingMs / 1000));
    if (second === this.lastSecond) return;
    this.lastSecond = second;
    const line = `Waiting for Yuanbao to confirm login… ${duration(remainingMs)} remaining`;
    if (this.tty) this.output.write(`\r${line.padEnd(78)}`);
    else if (second % 15 === 0) this.output.write(`${line}\n`);
  }

  verified({ reused = false } = {}) {
    if (this.tty) this.output.write(`\r${' '.repeat(78)}\r`);
    this.output.write(reused
      ? '✓ Existing Yuanbao login is valid; credentials will be refreshed.\n'
      : '✓ Yuanbao confirmed the new authenticated session.\n');
  }

  saved(file) {
    this.output.write(`✓ Credentials saved for Forge Agent:\n  ${file}\n\n` +
      'Start a new AionUI chat to use this login.\n\n');
  }
}

module.exports = { LoginUI, duration };
