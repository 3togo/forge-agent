'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { YuanbaoPreferences, normalizePreferences } = require('../src/yuanbao-preferences');

test('normalizes unknown or malformed tray preferences', () => {
  expect(normalizePreferences()).toEqual({ version: 1, engine: 'hy4' });
  expect(normalizePreferences({ version: 99, engine: 'hy3' })).toEqual({ version: 1, engine: 'hy3' });
  expect(normalizePreferences({ engine: 'native-tools' })).toEqual({ version: 1, engine: 'hy4' });
});

test('persists the Yuanbao engine in a private atomic settings file', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-yuanbao-preferences-'));
  try {
    const store = new YuanbaoPreferences({ baseDirectory: directory });
    expect(store.load()).toEqual({ version: 1, engine: 'hy4' });
    expect(store.setEngine('deepseek')).toEqual({ version: 1, engine: 'deepseek' });
    expect(store.load()).toEqual({ version: 1, engine: 'deepseek' });
    expect(fs.statSync(store.file).mode & 0o777).toBe(0o600);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('rejects webpage capabilities that are not supported by Forge', () => {
  const store = new YuanbaoPreferences({ file: path.join(os.tmpdir(), 'unused-yuanbao-tray.json') });
  expect(() => store.setEngine('deep-research')).toThrow('Unsupported Yuanbao engine');
});
