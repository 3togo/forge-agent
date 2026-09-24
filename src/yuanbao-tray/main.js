'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { app, dialog, Menu, nativeImage, Notification, shell, Tray } = require('electron');
const { getModelDisplayName, getModelUrl } = require('../adapter-factory');
const { ForgeTrayPreferences, TRAY_MODELS } = require('../forge-tray-preferences');
const { ENGINES, YuanbaoPreferences } = require('../yuanbao-preferences');
const { MODES, ProviderWebPreferences } = require('../provider-web-preferences');
const { LOGIN_STATES, probeProviderLogin } = require('../provider-login-status');
const { CredentialStore } = require('../credential-store');

const APP_NAME = 'Forge Agents';
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const LOGIN_ENTRY = path.join(PROJECT_ROOT, 'src', 'index.js');
const LOG_DIRECTORY = path.join(os.homedir(), '.deepseek-agent', 'logs');
const REFRESH_INTERVAL = 5 * 60 * 1000;

let tray;
let refreshPromise = null;
let loginProcess = null;
const preferences = new ForgeTrayPreferences();
const yuanbaoPreferences = new YuanbaoPreferences();
const providerWebPreferences = new ProviderWebPreferences();
const statuses = Object.fromEntries(TRAY_MODELS.map(model => [model, {
  model, state: LOGIN_STATES.CHECKING, detail: `Checking ${getModelDisplayName(model)} login…`,
}]));

function stateLabel(value) {
  return {
    [LOGIN_STATES.CHECKING]: 'Checking…',
    [LOGIN_STATES.LOGGED_IN]: 'Logged in',
    [LOGIN_STATES.LOGIN_REQUIRED]: 'Login required',
    [LOGIN_STATES.ERROR]: 'Unavailable',
  }[value] || 'Unknown';
}

function stateColor(value) {
  return {
    [LOGIN_STATES.LOGGED_IN]: '#22c55e',
    [LOGIN_STATES.LOGIN_REQUIRED]: '#ef4444',
    [LOGIN_STATES.ERROR]: '#f59e0b',
    [LOGIN_STATES.CHECKING]: '#94a3b8',
  }[value] || '#94a3b8';
}

function trayIcon(value) {
  const color = stateColor(value);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
    <rect x="2" y="2" width="28" height="28" rx="8" fill="#0053e0"/>
    <path d="M8 10h16v3H12v3h10v3H12v5H8z" fill="white"/>
    <circle cx="25" cy="25" r="5" fill="${color}" stroke="white" stroke-width="2"/>
  </svg>`;
  return nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`);
}

function notify(title, body) {
  if (Notification.isSupported()) new Notification({ title, body }).show();
}

function activeModel() { return preferences.load().activeModel; }
function loginLog(model) { return path.join(LOG_DIRECTORY, `${model}-tray-login.log`); }

function credentialInfo(model) {
  try { return CredentialStore.forModel(model).info(); }
  catch { return null; }
}

function protectionLabel(info) {
  if (!info?.exists && !info?.backupExists) return 'No saved session';
  if (info.protected) return info.exists ? 'Storage: owner-only' : 'Rollback backup: owner-only';
  const fileMode = info.mode?.toString(8) || 'unknown';
  const backupMode = info.backupMode?.toString(8) || 'none';
  const directoryMode = info.directoryMode?.toString(8) || 'unknown';
  return `Storage warning: file ${fileMode}, backup ${backupMode}, folder ${directoryMode}`;
}

async function confirmSignOut(model) {
  const provider = getModelDisplayName(model);
  const store = CredentialStore.forModel(model);
  const info = store.info();
  if (!info.exists && !info.backupExists) {
    notify(APP_NAME, `No saved ${provider} session was found.`);
    return;
  }
  const result = await dialog.showMessageBox({
    type: 'warning', title: `Remove ${provider} session?`,
    message: `Sign out ${provider} from Forge Agent?`,
    detail: 'This removes the saved browser session and its backup from this computer. It does not delete the provider account or revoke other devices.',
    buttons: ['Cancel', 'Remove saved session'], defaultId: 0, cancelId: 0,
  });
  if (result.response !== 1) return;
  try {
    store.clear();
    statuses[model] = {
      model, state: LOGIN_STATES.LOGIN_REQUIRED, detail: `No saved ${provider} login`,
    };
    updateTray();
    notify(APP_NAME, `${provider} saved session removed.`);
  } catch (error) {
    notify(`${provider} sign out failed`, String(error.message || error));
  }
}

function secureCredentialStorage({ quiet = false } = {}) {
  try {
    for (const model of TRAY_MODELS) CredentialStore.forModel(model).secure();
    updateTray();
    if (!quiet) notify(APP_NAME, 'Credential files are restricted to your operating-system user.');
  } catch (error) {
    notify('Could not protect credential storage', String(error.message || error));
  }
}

function providerMenu(model, selectedModel) {
  const provider = getModelDisplayName(model);
  const status = statuses[model];
  const storedCredential = credentialInfo(model);
  const providerItems = [
      {
        label: 'Use as active agent', type: 'radio', checked: selectedModel === model,
        click: () => { preferences.setActiveModel(model); updateTray(); },
      },
      { label: status.detail, enabled: false },
      { label: protectionLabel(storedCredential), enabled: false },
  ];
  if (model !== 'yuanbao') {
    const selectedMode = providerWebPreferences.load().modes[model];
    providerItems.push({
      label: 'Reasoning mode',
      submenu: Object.values(MODES).map(mode => ({
        label: mode.label, type: 'radio', checked: selectedMode === mode.id,
        click: () => {
          providerWebPreferences.setMode(model, mode.id);
          updateTray();
          notify(APP_NAME, `${mode.label} will be applied to the next ${provider} message.`);
        },
      })),
    });
  }
  providerItems.push(
      { type: 'separator' },
      { label: `Open ${provider}`, click: () => shell.openExternal(getModelUrl(model)) },
      { label: 'Refresh login status', enabled: !refreshPromise, click: () => refreshStatus(model) },
      {
        label: loginProcess ? 'Login in progress…' : 'Log in / refresh session',
        enabled: !loginProcess, click: () => startLogin(model, false),
      },
      {
        label: 'Force login with another account…', enabled: !loginProcess,
        click: () => confirmForcedLogin(model),
      },
      {
        label: 'Show login log', enabled: fs.existsSync(loginLog(model)),
        click: () => shell.showItemInFolder(loginLog(model)),
      },
      {
        label: 'Open credential folder', enabled: Boolean(storedCredential?.exists),
        click: () => shell.showItemInFolder(storedCredential.file),
      },
      {
        label: 'Sign out and remove saved session…',
        enabled: Boolean(storedCredential?.exists || storedCredential?.backupExists),
        click: () => confirmSignOut(model),
      },
  );
  return {
    label: `${provider}: ${stateLabel(status.state)}`,
    submenu: providerItems,
  };
}

function updateTray() {
  if (!tray) return;
  const selectedModel = activeModel();
  const selectedStatus = statuses[selectedModel];
  const provider = getModelDisplayName(selectedModel);
  const yuanbao = yuanbaoPreferences.load();
  tray.setImage(trayIcon(selectedStatus.state));
  tray.setToolTip(`${APP_NAME}: ${provider} · ${stateLabel(selectedStatus.state)}`);
  tray.setTitle('Forge');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `Active: ${provider}`, enabled: false },
    { label: selectedStatus.detail, enabled: false },
    { type: 'separator' },
    { label: 'Agents', submenu: TRAY_MODELS.map(model => providerMenu(model, selectedModel)) },
    {
      label: 'Yuanbao engine',
      submenu: Object.values(ENGINES).map(engine => ({
        label: engine.label, type: 'radio', checked: yuanbao.engine === engine.id,
        click: () => {
          yuanbaoPreferences.setEngine(engine.id);
          updateTray();
          notify(APP_NAME, `${engine.label} will be used for the next Yuanbao message.`);
        },
      })),
    },
    { type: 'separator' },
    {
      label: 'Credentials & Sessions',
      submenu: [
        ...TRAY_MODELS.map(model => ({
          label: `${getModelDisplayName(model)}: ${protectionLabel(credentialInfo(model))}`,
          enabled: false,
        })),
        { type: 'separator' },
        { label: 'Repair owner-only permissions', click: secureCredentialStorage },
        {
          label: 'Open credential folder',
          click: () => {
            const location = CredentialStore.forModel(activeModel()).file;
            fs.mkdirSync(path.dirname(location), { recursive: true, mode: 0o700 });
            shell.openPath(path.dirname(location));
          },
        },
      ],
    },
    { label: 'Refresh all login statuses', enabled: !refreshPromise, click: () => refreshStatus() },
    { label: 'Quit', role: 'quit' },
  ]));
}

async function refreshStatus(model) {
  if (refreshPromise) return refreshPromise;
  const models = model ? [model] : TRAY_MODELS;
  for (const item of models) statuses[item] = {
    model: item, state: LOGIN_STATES.CHECKING, detail: `Checking ${getModelDisplayName(item)} login…`,
  };
  updateTray();
  refreshPromise = Promise.all(models.map(async item => {
    statuses[item] = await probeProviderLogin(item);
  })).finally(() => {
    refreshPromise = null;
    updateTray();
  });
  return refreshPromise;
}

function nodeExecutable() {
  return process.env.FORGE_NODE_BINARY || process.env.npm_node_execpath || 'node';
}

async function confirmForcedLogin(model) {
  const provider = getModelDisplayName(model);
  const result = await dialog.showMessageBox({
    type: 'warning', title: `Replace ${provider} login?`,
    message: `Sign in with another ${provider} account?`,
    detail: 'Forge will preserve the current credential and restore it if the new login fails.',
    buttons: ['Cancel', 'Continue'], defaultId: 0, cancelId: 0,
  });
  if (result.response === 1) startLogin(model, true);
}

function startLogin(model, forceRelogin) {
  if (loginProcess) return;
  const provider = getModelDisplayName(model);
  const logFile = loginLog(model);
  fs.mkdirSync(path.dirname(logFile), { recursive: true, mode: 0o700 });
  const output = fs.openSync(logFile, 'a', 0o600);
  const args = [LOGIN_ENTRY, '--login', `--model=${model}`];
  if (forceRelogin) args.push('--force-relogin');
  loginProcess = spawn(nodeExecutable(), args, {
    cwd: PROJECT_ROOT, env: process.env, stdio: ['ignore', output, output],
  });
  statuses[model] = { model, state: LOGIN_STATES.CHECKING, detail: `${provider} login is in progress…` };
  updateTray();
  let spawnFailed = false;
  const closeOutput = () => { try { fs.closeSync(output); } catch {} };
  loginProcess.once('error', error => {
    spawnFailed = true;
    closeOutput();
    loginProcess = null;
    statuses[model] = { model, state: LOGIN_STATES.ERROR, detail: error.message };
    updateTray();
    notify(`${provider} login failed`, error.message);
  });
  loginProcess.once('exit', code => {
    closeOutput();
    if (spawnFailed) return;
    loginProcess = null;
    if (code === 0) notify(APP_NAME, `${provider} login completed.`);
    else notify(`${provider} login failed`, `Login exited with code ${code}. See the login log for details.`);
    refreshStatus(model);
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  process.once('SIGINT', () => app.quit());
  process.once('SIGTERM', () => app.quit());
  app.setName(APP_NAME);
  app.on('second-instance', () => refreshStatus());
  app.whenReady().then(() => {
    if (!preferences.exists()) preferences.save(preferences.load());
    if (!yuanbaoPreferences.exists()) yuanbaoPreferences.save(yuanbaoPreferences.load());
    if (!providerWebPreferences.exists()) providerWebPreferences.save(providerWebPreferences.load());
    secureCredentialStorage({ quiet: true });
    tray = new Tray(trayIcon(LOGIN_STATES.CHECKING));
    updateTray();
    refreshStatus();
    const timer = setInterval(refreshStatus, REFRESH_INTERVAL);
    timer.unref?.();
    const smokeDuration = Number(process.env.FORGE_TRAY_SMOKE_MS || 0);
    if (smokeDuration > 0) setTimeout(() => app.quit(), smokeDuration).unref?.();
  });
  app.on('window-all-closed', () => {});
  app.on('before-quit', () => {
    if (loginProcess && !loginProcess.killed) loginProcess.kill('SIGTERM');
  });
}
