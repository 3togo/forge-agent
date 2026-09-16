// src/session-store.js — Atomic session persistence with idempotent replay detection
'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const crypto = require('crypto');

const DEFAULT_STORE_DIR = path.join(os.homedir(), '.forge-agent', 'sessions');

class SessionStore {
  constructor(sessionId, storeDir) {
    this.sessionId = sessionId;
    this.storeDir  = storeDir || DEFAULT_STORE_DIR;
    this.filePath  = path.join(this.storeDir, `${sessionId}.json`);
    this._lockPath = path.join(this.storeDir, `${sessionId}.lock`);
    this._lockFd   = null;
  }

  static create(sessionId, cwd, storeDir) {
    const store = new SessionStore(sessionId, storeDir);
    store._ensureDir();
    store.save({
      version        : 1,
      sessionId      : sessionId,
      cwd            : cwd,
      status         : 'idle',
      lastPromptHash : null,
      lastOutput     : null,
      piSessionFile  : null,
      createdAt      : new Date().toISOString(),
    });
    return store;
  }

  acquire() {
    this._ensureDir();
    try {
      this._lockFd = fs.openSync(this._lockPath, 'wx');
      return true;
    } catch (err) {
      if (err.code === 'EEXIST') {
        const stale = this._isLockStale();
        if (stale) {
          fs.unlinkSync(this._lockPath);
          this._lockFd = fs.openSync(this._lockPath, 'wx');
          return true;
        }
        throw new Error('SESSION_BUSY');
      }
      throw err;
    }
  }

  release() {
    if (this._lockFd !== null) {
      try { fs.closeSync(this._lockFd); } catch {}
      try { fs.unlinkSync(this._lockPath); } catch {}
      this._lockFd = null;
    }
  }

  _isLockStale() {
    try {
      const stat = fs.statSync(this._lockPath);
      const ageMs = Date.now() - stat.mtimeMs;
      return ageMs > 5 * 60 * 1000;
    } catch {
      return true;
    }
  }

  load() {
    try {
      const data = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(data);

      if (parsed.version !== 1) throw new Error('Invalid session version');
      if (!parsed.sessionId || !parsed.cwd || !parsed.status) {
        throw new Error('Missing required session fields');
      }
      if (!['idle', 'running', 'interrupted'].includes(parsed.status)) {
        throw new Error('Invalid session status');
      }

      return parsed;
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  save(data) {
    this._ensureDir();
    const tmpPath = this.filePath + '.tmp';

    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), { mode: 0o600 });

    try { fs.fsyncSync(fs.openSync(tmpPath, 'r')); } catch {}

    fs.renameSync(tmpPath, this.filePath);

    try {
      const dirFd = fs.openSync(this.storeDir, 'r');
      try { fs.fsyncSync(dirFd); } catch {}
      fs.closeSync(dirFd);
    } catch {}
  }

  isIdempotentReplay(prompt) {
    const session = this.load();
    if (!session || session.status !== 'idle') return null;

    const promptHash = crypto.createHash('sha256').update(prompt).digest('hex');
    if (session.lastPromptHash === promptHash && session.lastOutput) {
      return session.lastOutput;
    }

    return null;
  }

  recordPrompt(prompt) {
    const session = this.load();
    if (!session) return;
    session.lastPromptHash = crypto.createHash('sha256').update(prompt).digest('hex');
    session.status = 'running';
    this.save(session);
  }

  recordOutput(output) {
    const session = this.load();
    if (!session) return;
    session.lastOutput = output;
    session.status = 'idle';
    this.save(session);
  }

  markInterrupted() {
    const session = this.load();
    if (!session) return;
    session.status = 'interrupted';
    this.save(session);
  }

  _ensureDir() {
    fs.mkdirSync(this.storeDir, { recursive: true });
  }
}

module.exports = SessionStore;
