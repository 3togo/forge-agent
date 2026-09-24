'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { ProviderWebPreferences, normalizePreferences } = require('../src/provider-web-preferences');

test('normalizes provider reasoning modes independently', () => {
  expect(normalizePreferences({ modes: { deepseek: 'thinking', doubao: 'remote-agent' } })).toEqual({
    version: 1, modes: { deepseek: 'thinking', doubao: 'default' },
  });
});

test('persists safe web modes in a private file', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-provider-options-'));
  try {
    const store = new ProviderWebPreferences({ baseDirectory: directory });
    store.setMode('doubao', 'thinking');
    expect(store.load().modes).toEqual({ deepseek: 'default', doubao: 'thinking' });
    expect(fs.statSync(store.file).mode & 0o777).toBe(0o600);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
