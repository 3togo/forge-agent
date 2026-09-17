'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const root = path.resolve(__dirname, '..');
const quote = value => "'" + value.replace(/'/g, "'\\''") + "'";

async function ensureSetup({ install = false } = {}) {
  const interactive = Boolean(process.stdin.isTTY);
  const run = (command, args, hint) => {
    const result = spawnSync(command, args, {
      cwd: root, stdio: ['ignore', process.stderr, process.stderr],
      env: { ...process.env, SKIP_PLAYWRIGHT_INSTALL: '1' },
    });
    if (result.error || result.status !== 0) {
      throw new Error(`Setup failed: ${result.error?.message || `exit ${result.status}`}\nRun manually: ${hint}`);
    }
  };
  const offer = async (description, hint, action) => {
    process.stderr.write(`Missing ${description}.\nInstall with: ${hint}\n`);
    let accepted = install;
    if (!accepted && interactive) {
      const readline = require('readline');
      const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
      accepted = await new Promise(resolve => {
        rl.once('close', () => resolve(false));
        rl.question('Install now? [y/N] ', answer => { resolve(/^y(es)?$/i.test(answer.trim())); rl.close(); });
      });
    }
    if (!accepted) throw new Error('Complete setup and run Forge ACP again. You can also run forge-agent-acp --setup.');
    action();
  };
  const missing = Object.keys(require('../package.json').dependencies).filter(name => {
    try { require.resolve(name); return false; } catch (err) {
      if (err.code !== 'MODULE_NOT_FOUND') throw err;
      return true;
    }
  });
  if (missing.length) {
    const hint = `cd ${quote(root)} && npm install --omit=dev`;
    await offer(`packages: ${missing.join(', ')}`, hint,
      () => run('npm', ['install', '--omit=dev'], hint));
    for (const name of missing) require.resolve(name);
  }
  // A protocol handshake must not download browsers or consume client input.
  if (interactive || install) {
    const { chromium } = require('playwright');
    if (!fs.existsSync(chromium.executablePath())) {
      const cli = path.join(path.dirname(require.resolve('playwright/package.json')), 'cli.js');
      const hint = `cd ${quote(root)} && npx playwright install chromium`;
      await offer('Playwright Chromium browser', hint,
        () => run(process.execPath, [cli, 'install', 'chromium'], hint));
      if (!fs.existsSync(chromium.executablePath())) throw new Error(`Chromium is still missing. Run: ${hint}`);
    }
  }
}
module.exports = { ensureSetup };
