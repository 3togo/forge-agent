'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { SUPPORTED_MODELS, getModelDisplayName } = require('./adapter-factory');

const FORGE_ACP_PATH = path.join(__dirname, '..', 'forge-agent-acp');
const ICONS_SRC_DIR = path.join(__dirname, '..', 'assets', 'icons');

function getAionUiCustomAssetsDir() {
  return path.join(os.homedir(), '.config', 'AionUi', 'aionui', 'custom-assets', 'logos', 'forge');
}

function getAionUiAssetsBaseUrl() {
  return '/api/assets/logos/forge';
}

function installIcons() {
  const destDir = getAionUiCustomAssetsDir();
  const results = [];
  try {
    fs.mkdirSync(destDir, { recursive: true });
    for (const model of SUPPORTED_MODELS) {
      const srcPath = path.join(ICONS_SRC_DIR, `${model}.svg`);
      if (!fs.existsSync(srcPath)) {
        results.push({ model, status: 'skipped', reason: 'no source SVG' });
        continue;
      }
      const destPath = path.join(destDir, `${model}.svg`);
      fs.copyFileSync(srcPath, destPath);
      results.push({ model, status: 'installed', path: destPath });
    }
  } catch (err) {
    results.push({ model: 'all', status: 'error', reason: err.message });
  }
  return results;
}

function getIconPath(model) {
  const destDir = getAionUiCustomAssetsDir();
  const destPath = path.join(destDir, `${model}.svg`);
  if (fs.existsSync(destPath)) {
    return `${getAionUiAssetsBaseUrl()}/${model}.svg`;
  }
  const meta = MODEL_META[model];
  return meta ? meta.icon : `emoji:❓`;
}

function getAionUiDbPath() {
  return path.join(os.homedir(), '.config', 'AionUi', 'aionui', 'aionui-backend.db');
}

const MODEL_META = {
  deepseek: { name: 'DeepSeek (Forge)', icon: '/api/assets/logos/forge/deepseek.svg', description: 'DeepSeek via Forge browser adapter' },
  doubao: { name: 'Doubao (Forge)', icon: '/api/assets/logos/forge/doubao.svg', description: 'Doubao (豆包) via Forge browser adapter' },
  gemini: { name: 'Gemini (Forge)', icon: '/api/assets/logos/forge/gemini.svg', description: 'Gemini via Forge browser adapter' },
  yuanbao: { name: 'Yuanbao (Forge)', icon: '/api/assets/logos/forge/yuanbao.svg', description: 'Yuanbao (元宝) via Forge browser adapter' },
};

function findAionUiDb(override) {
  if (override && fs.existsSync(override)) return override;
  const dbPath = getAionUiDbPath();
  if (fs.existsSync(dbPath)) return dbPath;
  const alt = path.join(os.homedir(), '.config', 'aionui', 'aionui', 'aionui-backend.db');
  if (fs.existsSync(alt)) return alt;
  return null;
}

function isAionUiRunning() {
  const result = spawnSync('ps', ['-u', String(process.getuid()), '-o', 'comm='], { encoding: 'utf8' });
  if (result.error || result.status !== 0) return false;
  return result.stdout.split('\n').some(c => /^aionui(?:$|-)/i.test(c.trim()));
}

function getForgeAcpCommand() {
  if (fs.existsSync(FORGE_ACP_PATH) && fs.accessSync(FORGE_ACP_PATH, fs.constants.X_OK) === undefined) {
    return FORGE_ACP_PATH;
  }
  const npmGlobal = spawnSync('npm', ['root', '-g'], { encoding: 'utf8' });
  if (npmGlobal.status === 0) {
    const globalPath = path.join(npmGlobal.stdout.trim(), 'forge-agent', 'forge-agent-acp');
    if (fs.existsSync(globalPath)) return globalPath;
  }
  return process.argv[1] || 'forge-agent-acp';
}

function registerAcpAgents(dbPath, models) {
  const command = getForgeAcpCommand();
  const now = Date.now();
  const results = [];

  installIcons();

  for (const model of models) {
    const meta = MODEL_META[model];
    if (!meta) { results.push({ model, status: 'skipped', reason: 'unknown model' }); continue; }

    const iconPath = getIconPath(model);

    const agentId = `forge-${model}`;
    const args = `--model=${model}`;
    const id = spawnSync('node', ['-e', 'console.log(require("crypto").randomBytes(16).toString("hex"))'], { encoding: 'utf8' }).stdout.trim();

    const sql = `INSERT INTO agent_metadata (id, agent_id, user_id, icon, name, name_i18n, description, description_i18n, backend, agent_type, agent_source, agent_source_info, enabled, command, args, env, native_skills_dirs, behavior_policy, yolo_id, agent_capabilities, auth_methods, config_options, available_modes, available_models, available_commands, sort_order, command_override, env_override, created_at, updated_at, skill_delivery) VALUES ('${id}', '${agentId}', NULL, '${iconPath}', '${meta.name}', '{}', '${meta.description}', '{}', 'acp', 'acp', 'custom', NULL, 1, '${command}', '${args}', '[]', '[]', NULL, NULL, '[]', '[]', '[]', '[]', '[]', '[]', 1000, NULL, NULL, ${now}, ${now}, 'bundled') ON CONFLICT(agent_id) DO UPDATE SET name='${meta.name}', description='${meta.description}', icon='${iconPath}', command='${command}', args='${args}', enabled=1, updated_at=${now};`;

    const result = spawnSync('sqlite3', [dbPath, sql], { encoding: 'utf8' });
    if (result.error || result.status !== 0) {
      results.push({ model, status: 'error', reason: result.stderr || result.error?.message || 'sqlite3 failed' });
    } else {
      results.push({ model, status: 'registered', agentId, command, args });
    }
  }
  return results;
}

function unregisterAcpAgents(dbPath, models) {
  const results = [];
  for (const model of models) {
    const agentId = `forge-${model}`;
    const sql = `DELETE FROM agent_metadata WHERE agent_id='${agentId}';`;
    const result = spawnSync('sqlite3', [dbPath, sql], { encoding: 'utf8' });
    if (result.error || result.status !== 0) {
      results.push({ model, status: 'error', reason: result.stderr || result.error?.message });
    } else {
      results.push({ model, status: 'unregistered', agentId });
    }
  }
  return results;
}

function listRegisteredAgents(dbPath) {
  const sql = `SELECT agent_id, name, command, args, enabled FROM agent_metadata WHERE agent_source='custom' AND agent_id LIKE 'forge-%';`;
  const result = spawnSync('sqlite3', [dbPath, '-json', sql], { encoding: 'utf8' });
  if (result.error || result.status !== 0) return [];
  try { return JSON.parse(result.stdout || '[]'); } catch { return []; }
}

function registerApiProviders(dbPath, models, apiKeys) {
  const now = Date.now();
  const results = [];
  const API_META = {
    deepseek: { platform: 'deepseek', name: 'DeepSeek', base_url: 'https://api.deepseek.com/v1', models: '["deepseek-chat","deepseek-reasoner"]' },
    doubao: { platform: 'doubao', name: 'Doubao (豆包)', base_url: 'https://ark.cn-beijing.volces.com/api/v3', models: '["doubao-pro-32k","doubao-pro-128k"]' },
    yuanbao: { platform: 'yuanbao', name: 'Yuanbao (元宝)', base_url: 'https://api.hunyuan.cloud.tencent.com/v1', models: '["hunyuan-pro","hunyuan-standard","hunyuan-lite"]' },
  };

  for (const model of models) {
    const meta = API_META[model];
    if (!meta) { results.push({ model, status: 'skipped', reason: 'no API meta' }); continue; }
    const apiKey = apiKeys[model];
    if (!apiKey) { results.push({ model, status: 'skipped', reason: 'no API key provided' }); continue; }

    const id = spawnSync('node', ['-e', 'console.log(require("crypto").randomBytes(16).toString("hex"))'], { encoding: 'utf8' }).stdout.trim();
    const providerId = `forge-api-${model}`;

    const sql = `INSERT INTO providers (id, user_id, platform, name, base_url, api_key_encrypted, models, enabled, capabilities, context_limit, is_full_url, model_settings, created_at, updated_at) VALUES ('${id}', 'system_default_user', '${meta.platform}', '${meta.name}', '${meta.base_url}', '${apiKey}', '${meta.models}', 1, '[]', NULL, 0, '{}', ${now}, ${now});`;

    const result = spawnSync('sqlite3', [dbPath, sql], { encoding: 'utf8' });
    if (result.error || result.status !== 0) {
      results.push({ model, status: 'error', reason: result.stderr || result.error?.message });
    } else {
      results.push({ model, status: 'registered', providerId, base_url: meta.base_url });
    }
  }
  return results;
}

async function register(options = {}) {
  const dbPath = findAionUiDb(options.dbPath);
  if (!dbPath) {
    process.stderr.write('AionUi database not found. Install AionUi first: https://www.aionui.com/\n');
    return { success: false, reason: 'no database' };
  }

  if (isAionUiRunning()) {
    process.stderr.write('Warning: AionUi is running. Close it before registering agents to avoid database conflicts.\n');
  }

  const models = options.models || SUPPORTED_MODELS;
  const mode = options.api ? 'api' : 'acp';

  process.stderr.write(`Registering ${models.join(', ')} as ${mode} agents in AionUi...\n`);

  if (mode === 'acp') {
    const iconResults = installIcons();
    for (const r of iconResults) {
      if (r.status === 'installed') {
        process.stderr.write(`  ✓ icon: ${r.model} → ${r.path}\n`);
      } else if (r.status === 'error') {
        process.stderr.write(`  ✗ icon: ${r.reason}\n`);
      }
    }
  }

  let results;
  if (mode === 'acp') {
    results = registerAcpAgents(dbPath, models);
  } else {
    results = registerApiProviders(dbPath, models, options.apiKeys || {});
  }

  for (const r of results) {
    if (r.status === 'registered') {
      process.stderr.write(`  ✓ ${r.model}: ${r.command || r.base_url} ${r.args || ''}\n`);
    } else if (r.status === 'error') {
      process.stderr.write(`  ✗ ${r.model}: ${r.reason}\n`);
    } else {
      process.stderr.write(`  - ${r.model}: ${r.reason}\n`);
    }
  }

  if (mode === 'acp') {
    process.stderr.write('\nRestart AionUi to see the new agents in Settings → Agent Management.\n');
  }

  return { success: results.every(r => r.status !== 'error'), results };
}

async function unregister(options = {}) {
  const dbPath = findAionUiDb(options.dbPath);
  if (!dbPath) {
    process.stderr.write('AionUi database not found.\n');
    return { success: false };
  }

  const models = options.models || SUPPORTED_MODELS;
  process.stderr.write(`Removing Forge agents for ${models.join(', ')} from AionUi...\n`);

  const results = unregisterAcpAgents(dbPath, models);
  for (const r of results) {
    if (r.status === 'unregistered') process.stderr.write(`  ✓ ${r.model}: removed\n`);
    else process.stderr.write(`  ✗ ${r.model}: ${r.reason}\n`);
  }

  process.stderr.write('\nRestart AionUi to see the changes.\n');
  return { success: results.every(r => r.status !== 'error'), results };
}

function list(options = {}) {
  const dbPath = findAionUiDb(options.dbPath);
  if (!dbPath) { process.stderr.write('AionUi database not found.\n'); return []; }
  const agents = listRegisteredAgents(dbPath);
  if (agents.length === 0) {
    process.stderr.write('No Forge agents registered in AionUi.\n');
  } else {
    process.stderr.write('Registered Forge agents:\n');
    for (const a of agents) {
      process.stderr.write(`  ${a.enabled ? '✓' : '✗'} ${a.agent_id}: ${a.name} (${a.command} ${a.args})\n`);
    }
  }
  return agents;
}

module.exports = {
  register, unregister, list,
  findAionUiDb, isAionUiRunning, getForgeAcpCommand,
  registerAcpAgents, unregisterAcpAgents, listRegisteredAgents, registerApiProviders,
  MODEL_META, getAionUiDbPath, FORGE_ACP_PATH,
  installIcons, getIconPath, getAionUiCustomAssetsDir, getAionUiAssetsBaseUrl,
};
