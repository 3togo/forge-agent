'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');

const MODES = Object.freeze({
  default: Object.freeze({ id: 'default', label: 'Provider default' }),
  thinking: Object.freeze({ id: 'thinking', label: 'Deep thinking' }),
});
const MODELS = new Set(['deepseek', 'doubao']);
const DEFAULT_PREFERENCES = Object.freeze({ version: 1, modes: Object.freeze({ deepseek: 'default', doubao: 'default' }) });

function normalizePreferences(value = {}) {
  const modes = {};
  for (const model of MODELS) {
    const mode = value.modes?.[model];
    modes[model] = MODES[mode] ? mode : DEFAULT_PREFERENCES.modes[model];
  }
  return { version: 1, modes };
}

class ProviderWebPreferences {
  constructor(options = {}) {
    const baseDirectory = options.baseDirectory || path.join(os.homedir(), '.deepseek-agent');
    this.file = path.resolve(options.file || path.join(baseDirectory, 'provider-web-options.json'));
  }
  load() {
    try { return normalizePreferences(JSON.parse(fs.readFileSync(this.file, 'utf8'))); }
    catch (error) {
      if (error.code === 'ENOENT' || error instanceof SyntaxError) return normalizePreferences();
      throw error;
    }
  }
  exists() { return fs.existsSync(this.file); }
  save(value) {
    const preferences = normalizePreferences(value);
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, `${JSON.stringify(preferences, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, this.file);
      fs.chmodSync(this.file, 0o600);
    } finally {
      try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return preferences;
  }
  setMode(model, mode) {
    if (!MODELS.has(model)) throw new Error(`Unsupported provider mode model: ${model}`);
    if (!MODES[mode]) throw new Error(`Unsupported provider mode: ${mode}`);
    const current = this.load();
    return this.save({ ...current, modes: { ...current.modes, [model]: mode } });
  }
}

module.exports = { DEFAULT_PREFERENCES, MODES, ProviderWebPreferences, normalizePreferences };
