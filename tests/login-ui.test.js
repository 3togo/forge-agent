'use strict';

const { LoginUI, duration } = require('../src/login-ui');

function output(tty = false) {
  return { isTTY: tty, text: '', write(value) { this.text += value; } };
}

test('renders a guided Yuanbao login and explicit credential destination', () => {
  const stream = output(false);
  const ui = new LoginUI(stream);
  ui.start({ provider: 'Yuanbao (元宝)', credentialFile: '/state/yuanbao.json', timeout: 180000 });
  ui.browserOpened(true);
  ui.waiting(150000);
  ui.verified();
  ui.saved('/state/yuanbao.json');

  expect(stream.text).toContain('Yuanbao (元宝) login');
  expect(stream.text).toContain('Choose WeChat, Phone, or QQ');
  expect(stream.text).toContain('Credential destination: /state/yuanbao.json');
  expect(stream.text).toContain('Yuanbao confirmed the new authenticated session');
  expect(stream.text).toContain('Credentials saved for Forge Agent');
});

test('renders an existing credential refresh compactly', () => {
  const stream = output(false);
  const ui = new LoginUI(stream);
  ui.checkingExisting({ provider: 'Yuanbao (元宝)' });
  ui.refreshed('/state/yuanbao.json');
  expect(stream.text).toBe(
    'Checking saved Yuanbao (元宝) login…\n' +
    '✓ Yuanbao login is valid; credentials refreshed.\n  /state/yuanbao.json\n\n'
  );
});

test('explains that force relogin preserves the current credential until success', () => {
  const stream = output(false);
  const ui = new LoginUI(stream);
  ui.forcingRelogin({
    provider: 'Yuanbao (元宝)', credentialFile: '/state/yuanbao.json',
    backupFile: '/state/yuanbao.json.backup',
  });
  expect(stream.text).toContain('Forcing a fresh Yuanbao (元宝) login');
  expect(stream.text).toContain('Previous credential backup: /state/yuanbao.json.backup');
  expect(stream.text).toContain('Credential destination: /state/yuanbao.json');
});

test('reports automatic credential restoration after failed relogin', () => {
  const stream = output(false);
  const ui = new LoginUI(stream);
  ui.reloginReverted({ credentialFile: '/state/yuanbao.json' });
  expect(stream.text).toContain('restored the previous credential');
  expect(stream.text).toContain('/state/yuanbao.json');
});

test('formats login time as minutes and seconds', () => {
  expect(duration(180000)).toBe('3:00');
  expect(duration(61000)).toBe('1:01');
});

test('shows the extracted QR image path for headless scanning', () => {
  const stream = output(false);
  const ui = new LoginUI(stream);
  ui.preparingQr({ provider: 'Yuanbao (元宝)', timeout: 180000 });
  ui.qrReady({ imagePath: '/state/yuanbao-qr.png' });
  expect(stream.text).toContain('Preparing headless Yuanbao');
  expect(stream.text).toContain('Scan the QR code with WeChat');
  expect(stream.text).toContain('/state/yuanbao-qr.png');
  expect(stream.text).toContain('Keep this command running');
});
