'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');

const ENGINES = Object.freeze({
  hy4: Object.freeze({ id: 'hy4', label: 'Hy4 preview' }),
  hy3: Object.freeze({ id: 'hy3', label: 'Hy3' }),
  deepseek: Object.freeze({ id: 'deepseek', label: 'DeepSeek' }),
});

const DEFAULT_PREFERENCES = Object.freeze({
  version: 1,
  engine: 'hy4',
});

function normalizePreferences(value = {}) {
  const engine = typeof value.engine === 'string' && ENGINES[value.engine]
    ? value.engine
    : DEFAULT_PREFERENCES.engine;
  return { version: DEFAULT_PREFERENCES.version, engine };
}

class YuanbaoPreferences {
  constructor(options = {}) {
    const baseDirectory = options.baseDirectory || path.join(os.homedir(), '.deepseek-agent');
    this.file = path.resolve(options.file || path.join(baseDirectory, 'yuanbao-tray.json'));
  }

  load() {
    try {
      return normalizePreferences(JSON.parse(fs.readFileSync(this.file, 'utf8')));
    } catch (error) {
      if (error.code === 'ENOENT' || error instanceof SyntaxError) {
        return { ...DEFAULT_PREFERENCES };
      }
      throw error;
    }
  }

  exists() {
    return fs.existsSync(this.file);
  }

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

  setEngine(engine) {
    if (!ENGINES[engine]) throw new Error(`Unsupported Yuanbao engine: ${engine}`);
    return this.save({ ...this.load(), engine });
  }
}

module.exports = {
  DEFAULT_PREFERENCES,
  ENGINES,
  YuanbaoPreferences,
  normalizePreferences,
};
