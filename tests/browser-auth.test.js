'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { saveAuth, restoreAuth } = require('../src/browser-auth');
describe('shared login across isolated profiles', () => {
  let root, file;
  const cookie = { name: 'login', value: 'test-token', domain: '.doubao.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' };
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-auth-')); file = path.join(root, 'auth/doubao.json'); });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
  test('saves login from one context and restores it in a different context', async () => {
    const state = { cookies: [cookie], origins: [{ origin: 'https://www.doubao.com', localStorage: [{ name: 'auth', value: 'token' }] }] };
    await saveAuth({ storageState: async () => state }, file, 'https://www.doubao.com/chat');
    const next = { addCookies: jest.fn(), addInitScript: jest.fn() };
    await restoreAuth(next, file, 'https://www.doubao.com/chat');
    expect(next.addCookies).toHaveBeenCalledWith([cookie]);
    expect(next.addInitScript.mock.calls[0][1]).toEqual(state.origins);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    if (process.platform !== 'win32') expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect(fs.readdirSync(path.dirname(file))).toEqual(['doubao.json']);
  });
  test('does not share unrelated domains or expired cookies', async () => {
    await saveAuth({ storageState: async () => ({ cookies: [cookie, { ...cookie, domain: 'evil.com' }, { ...cookie, expires: 1 }], origins: [{ origin: 'https://evil.com', localStorage: [] }] }) }, file, 'https://www.doubao.com/chat');
    const saved = JSON.parse(fs.readFileSync(file));
    expect(saved.cookies).toEqual([cookie]); expect(saved.origins).toEqual([]);
  });
  test('empty snapshots do not erase a previously saved login', async () => {
    await saveAuth({ storageState: async () => ({ cookies: [cookie] }) }, file, 'https://www.doubao.com/chat');
    await saveAuth({ storageState: async () => ({ cookies: [], origins: [] }) }, file, 'https://www.doubao.com/chat');
    expect(JSON.parse(fs.readFileSync(file)).cookies).toEqual([cookie]);
  });
  test('first-time users without saved login continue normally', async () => {
    const next = { addCookies: jest.fn(), addInitScript: jest.fn() };
    await restoreAuth(next, file, 'https://www.doubao.com/chat');
    expect(next.addCookies).not.toHaveBeenCalled();
  });
});

test('real isolated browser contexts retain cookies and local storage without reseeding on every navigation', async () => {
  const { chromium } = require('playwright');
  const http = require('http');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-auth-browser-'));
  const server = http.createServer((req, res) => { res.end('<html><body>Login fixture</body></html>'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let first, second;
  try {
    first = await chromium.launchPersistentContext(path.join(root, 'first'), { headless: true });
    const page = await first.newPage(); await page.goto(origin);
    await first.addCookies([{ name: 'session', value: 'fixture-login', url: origin }]);
    await page.evaluate(() => localStorage.setItem('login-state', 'fixture-token'));
    const file = path.join(root, 'auth.json'); await saveAuth(first, file, origin);
    // Keep the first browser open: sharing login must not share its locked profile.
    second = await chromium.launchPersistentContext(path.join(root, 'second'), { headless: true });
    await restoreAuth(second, file, origin);
    const next = await second.newPage(); await next.goto(origin);
    expect(await next.evaluate(() => localStorage.getItem('login-state'))).toBe('fixture-token');
    expect((await second.cookies(origin)).find(c => c.name === 'session').value).toBe('fixture-login');
    await next.evaluate(() => localStorage.setItem('login-state', 'refreshed-token'));
    await next.reload();
    expect(await next.evaluate(() => localStorage.getItem('login-state'))).toBe('refreshed-token');
  } finally {
    await second?.close(); await first?.close();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
