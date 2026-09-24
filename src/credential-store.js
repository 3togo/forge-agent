'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { randomUUID } = require('crypto');
const { getModelUrl } = require('./adapter-factory');
const auth = require('./browser-auth');

const MODEL_ALIASES = {
  '元宝': 'yuanbao',
  '豆包': 'doubao',
  google: 'gemini',
  bard: 'gemini',
  r1: 'deepseek',
  'deepseek-r1': 'deepseek',
};

function normalizeModel(model) {
  const value = String(model || 'deepseek').toLowerCase().trim();
  return MODEL_ALIASES[value] || value;
}

function credentialFileForModel(model, baseDirectory = path.join(os.homedir(), '.deepseek-agent')) {
  return path.join(baseDirectory, 'acp-auth', `${normalizeModel(model)}.json`);
}

function atomicCopy(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    fs.copyFileSync(source, temporary, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, destination);
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

/**
 * The only application boundary allowed to load or save browser credentials.
 * Login orchestration and browser automation depend on this object instead of
 * knowing the storage format themselves.
 */
class CredentialStore {
  constructor({ file, modelUrl }) {
    if (!file) throw new Error('CredentialStore requires a file');
    if (!modelUrl) throw new Error('CredentialStore requires a model URL');
    this.file = path.resolve(file);
    this.modelUrl = modelUrl;
  }

  static forModel(model, options = {}) {
    const normalized = normalizeModel(model);
    return new CredentialStore({
      file: options.file || credentialFileForModel(normalized, options.baseDirectory),
      modelUrl: options.modelUrl || getModelUrl(normalized),
    });
  }

  async restore(context) {
    return auth.restoreAuth(context, this.file, this.modelUrl);
  }

  async save(context) {
    return auth.saveAuth(context, this.file, this.modelUrl);
  }

  backup() {
    if (!fs.existsSync(this.file)) return { existed: false, file: null };
    const backupFile = `${this.file}.backup`;
    atomicCopy(this.file, backupFile);
    return { existed: true, file: backupFile };
  }

  restoreBackup(checkpoint) {
    if (!checkpoint?.existed) {
      try { fs.unlinkSync(this.file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      return;
    }
    atomicCopy(checkpoint.file, this.file);
  }

  isValid() {
    return auth.isAuthValid(this.file);
  }

  age() {
    return auth.getAuthAge(this.file);
  }
}

module.exports = { CredentialStore, credentialFileForModel, normalizeModel };
