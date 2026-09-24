'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const auth = require('../src/browser-auth');
const { CredentialStore, credentialFileForModel, normalizeModel } = require('../src/credential-store');

jest.mock('../src/browser-auth');

beforeEach(() => jest.clearAllMocks());

test('normalizes provider aliases and owns the credential path convention', () => {
  expect(normalizeModel('元宝')).toBe('yuanbao');
  expect(normalizeModel('deepseek-r1')).toBe('deepseek');
  expect(credentialFileForModel('豆包', '/state')).toBe(path.join('/state', 'acp-auth', 'doubao.json'));
});

test('is the single adapter over credential serialization operations', async () => {
  const context = {};
  const store = CredentialStore.forModel('yuanbao', { file: '/tmp/yuanbao-auth.json' });
  auth.isAuthValid.mockReturnValue(true);
  auth.getAuthAge.mockReturnValue(123);

  await store.restore(context);
  await store.save(context);

  expect(auth.restoreAuth).toHaveBeenCalledWith(context, '/tmp/yuanbao-auth.json', 'https://yuanbao.tencent.com/chat');
  expect(auth.saveAuth).toHaveBeenCalledWith(context, '/tmp/yuanbao-auth.json', 'https://yuanbao.tencent.com/chat');
  expect(store.isValid()).toBe(true);
  expect(store.age()).toBe(123);
});

test('backs up credentials privately and restores them after a failed relogin', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-credential-store-'));
  const file = path.join(directory, 'yuanbao.json');
  try {
    fs.writeFileSync(file, '{"account":"old"}', { mode: 0o600 });
    const store = CredentialStore.forModel('yuanbao', { file });
    const checkpoint = store.backup();
    expect(checkpoint).toEqual({ existed: true, file: `${file}.backup` });
    expect(fs.readFileSync(checkpoint.file, 'utf8')).toBe('{"account":"old"}');
    expect(fs.statSync(checkpoint.file).mode & 0o777).toBe(0o600);

    fs.writeFileSync(file, '{"account":"partial-new"}');
    store.restoreBackup(checkpoint);
    expect(fs.readFileSync(file, 'utf8')).toBe('{"account":"old"}');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('rollback removes a credential created when none existed before relogin', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-credential-store-'));
  const file = path.join(directory, 'yuanbao.json');
  try {
    const store = CredentialStore.forModel('yuanbao', { file });
    const checkpoint = store.backup();
    expect(checkpoint).toEqual({ existed: false, file: null });
    fs.writeFileSync(file, '{"account":"partial-new"}');
    store.restoreBackup(checkpoint);
    expect(fs.existsSync(file)).toBe(false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
