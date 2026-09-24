'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');
const { normalizeModel } = require('./credential-store');

const TRAY_MODELS = Object.freeze(['deepseek', 'doubao', 'yuanbao']);
const DEFAULT_PREFERENCES = Object.freeze({ version: 1, activeModel: 'deepseek' });

function normalizePreferences(value = {}) {
  const activeModel = normalizeModel(value.activeModel);
  return {
    version: DEFAULT_PREFERENCES.version,
    activeModel: TRAY_MODELS.includes(activeModel) ? activeModel : DEFAULT_PREFERENCES.activeModel,
  };
}

class ForgeTrayPreferences {
  constructor(options = {}) {
    const baseDirectory = options.baseDirectory || path.join(os.homedir(), '.deepseek-agent');
    this.file = path.resolve(options.file || path.join(baseDirectory, 'forge-tray.json'));
  }

  load() {
    try { return normalizePreferences(JSON.parse(fs.readFileSync(this.file, 'utf8'))); }
    catch (error) {
      if (error.code === 'ENOENT' || error instanceof SyntaxError) return { ...DEFAULT_PREFERENCES };
      throw error;
    }
  }

  exists() { return fs.existsSync(this.file); }

  save(value) {
    const preferences = normalizePreferences(value);
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, `${JSON.stringify(preferences, null, 2)}\n`, {
        encoding: 'utf8', mode: 0o600, flag: 'wx',
      });
      fs.renameSync(temporary, this.file);
      fs.chmodSync(this.file, 0o600);
    } finally {
      try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return preferences;
  }

  setActiveModel(model) {
    model = normalizeModel(model);
    if (!TRAY_MODELS.includes(model)) throw new Error(`Unsupported tray model: ${model}`);
    return this.save({ ...this.load(), activeModel: model });
  }
}

module.exports = { DEFAULT_PREFERENCES, TRAY_MODELS, ForgeTrayPreferences, normalizePreferences };
