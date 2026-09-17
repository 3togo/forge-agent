'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

describe('ACP setup without installed packages', () => {
  let root;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-setup-'));
    fs.mkdirSync(path.join(root, 'src'));
    fs.copyFileSync(path.resolve(__dirname, '../src/acp-setup.js'), path.join(root, 'src/acp-setup.js'));
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ dependencies: { 'forge-missing-test-package': '1.0.0' } }));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
  const run = install => spawnSync(process.execPath, ['-e',
    `require(${JSON.stringify(path.join(root, 'src/acp-setup.js'))}).ensureSetup({install:${install}}).catch(e=>{console.error(e.message);process.exitCode=1})`,
  ], { encoding: 'utf8', input: '{"jsonrpc":"2.0"}\n', env: { ...process.env, PATH: '' }, timeout: 5000 });
  test('noninteractive startup gives install instructions without consuming protocol input or printing to stdout', () => {
    const result = run(false);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('forge-missing-test-package');
    expect(result.stderr).toContain('npm install --omit=dev');
    expect(result.stderr).not.toContain('Install now?');
  });
  test('explicit setup reports missing npm with a manual recovery command', () => {
    const result = run(true);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Setup failed:');
    expect(result.stderr).toContain('Run manually:');
  });
});
