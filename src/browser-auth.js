'use strict';
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

function scopedState(state, modelUrl) {
  const host = new URL(modelUrl).hostname;
  const matches = domain => host === domain.replace(/^\./, '') || host.endsWith('.' + domain.replace(/^\./, ''));
  return {
    cookies: (state.cookies || []).filter(c => matches(c.domain) && (c.expires === -1 || c.expires > Date.now() / 1000)),
    origins: (state.origins || []).filter(o => new URL(o.origin).hostname === host),
  };
}
async function restoreAuth(context, file, modelUrl) {
  let state;
  try { state = scopedState(JSON.parse(fs.readFileSync(file, 'utf8')), modelUrl); }
  catch (err) { if (err.code === 'ENOENT') return; throw err; }
  if (state.cookies.length) await context.addCookies(state.cookies);
  await context.addInitScript(origins => {
    const saved = origins.find(o => o.origin === location.origin);
    // Seed once, so later navigations cannot overwrite refreshed login state.
    if (!saved || sessionStorage.getItem('__forge_auth_seeded')) return;
    for (const { name, value } of saved.localStorage || []) {
      if (localStorage.getItem(name) === null) localStorage.setItem(name, value);
    }
    sessionStorage.setItem('__forge_auth_seeded', '1');
  }, state.origins);
}
async function saveAuth(context, file, modelUrl) {
  const state = scopedState(await context.storageState(), modelUrl);
  if (!state.cookies.length && !state.origins.some(o => o.localStorage?.length)) return;
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(directory, 0o700);
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(state), { mode: 0o600, flag: 'wx' });
    fs.renameSync(temp, file);
    if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
  } finally { try { fs.unlinkSync(temp); } catch (err) { if (err.code !== 'ENOENT') throw err; } }
}
function isAuthValid(file) {
  if (!file || !fs.existsSync(file)) return false;
  try {
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    const hasCookies = Array.isArray(state.cookies) && state.cookies.length > 0;
    const hasOrigins = Array.isArray(state.origins) && state.origins.some(o => o.localStorage?.length > 0);
    if (!hasCookies && !hasOrigins) return false;
    const hasValidCookie = (state.cookies || []).some(c => c.expires === -1 || c.expires > Date.now() / 1000);
    return hasValidCookie || hasOrigins;
  } catch {
    return false;
  }
}

function getAuthAge(file) {
  if (!file || !fs.existsSync(file)) return Infinity;
  try {
    const stats = fs.statSync(file);
    return Date.now() - stats.mtimeMs;
  } catch {
    return Infinity;
  }
}

module.exports = { scopedState, restoreAuth, saveAuth, isAuthValid, getAuthAge };
