'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { ForgeTrayPreferences, normalizePreferences } = require('../src/forge-tray-preferences');

test('normalizes tray agent selection', () => {
  expect(normalizePreferences()).toEqual({ version: 1, activeModel: 'deepseek' });
  expect(normalizePreferences({ activeModel: '豆包' })).toEqual({ version: 1, activeModel: 'doubao' });
  expect(normalizePreferences({ activeModel: 'gemini' })).toEqual({ version: 1, activeModel: 'deepseek' });
});

test('persists the active Forge agent privately', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-tray-preferences-'));
  try {
    const store = new ForgeTrayPreferences({ baseDirectory: directory });
    expect(store.setActiveModel('yuanbao')).toEqual({ version: 1, activeModel: 'yuanbao' });
    expect(store.load().activeModel).toBe('yuanbao');
    expect(fs.statSync(store.file).mode & 0o777).toBe(0o600);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
