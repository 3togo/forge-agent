'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { hasProjectWrites, saveProjectWrites } = require('../src/acp-project-permissions');

describe('project write grants', () => {
  let directory;
  beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-grants-')); });
  afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));
  test('persists only the selected workspace with private permissions', () => {
    expect(hasProjectWrites(directory, '/project/a')).toBe(false);
    saveProjectWrites(directory, '/project/a');
    expect(hasProjectWrites(directory, '/project/a')).toBe(true);
    expect(hasProjectWrites(directory, '/project/b')).toBe(false);
    const file = path.join(directory, fs.readdirSync(directory)[0]);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    fs.unlinkSync(file);
    expect(hasProjectWrites(directory, '/project/a')).toBe(false);
  });
  test('malformed and mismatched records never grant permission', () => {
    saveProjectWrites(directory, '/project/a');
    const file = path.join(directory, fs.readdirSync(directory)[0]);
    fs.writeFileSync(file, 'invalid');
    expect(hasProjectWrites(directory, '/project/a')).toBe(false);
    fs.writeFileSync(file, JSON.stringify({ workspace: '/project/b', allowFileWrites: true }));
    expect(hasProjectWrites(directory, '/project/a')).toBe(false);
  });
});
