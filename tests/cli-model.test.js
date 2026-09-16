'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// Run the real CLI through parsing, config application, and its startup banner.
// Stop at agent.init so these checks never open the user's browser or send a task.
describe('CLI model selection at browser startup', () => {
  let tempDir, preload;
  const root = path.resolve(__dirname, '..');

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-cli-model-'));
    preload = path.join(tempDir, 'capture-startup.cjs');
    fs.writeFileSync(preload, `
const Module = require('module');
const originalLoad = Module._load;
const entry = ${JSON.stringify(path.join(root, 'src/index.js'))};
Module._load = function(request, parent, isMain) {
  if (request === './agent' && parent.filename === entry) {
    return class {
      async init() {
        const config = require(${JSON.stringify(path.join(root, 'src/config.js'))});
        const { getModelUrl, getAdapter } = require(${JSON.stringify(path.join(root, 'src/adapter-factory.js'))});
        console.log('STARTUP=' + JSON.stringify({
          model: config.MODEL,
          url: getModelUrl(config.MODEL),
          adapter: getAdapter(config.MODEL, {}, config).constructor.name,
        }));
        process.exit(0);
      }
    };
  }
  return originalLoad.apply(this, arguments);
};
`);
  });

  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  test.each([
    ['equals', ['--interactive', '--model=doubao']],
    ['separate value', ['--interactive', '--model', 'doubao']],
    ['short flag', ['-i', '-m', 'doubao']],
    ['uppercase', ['--interactive', '--model=DOUBAO']],
    ...(process.platform === 'linux' ? [['smart startup wrapper', ['--interactive', '--model=doubao'], true]] : []),
  ])('selects Doubao with %s syntax', (_name, args, wrapper = false) => {
    const executable = wrapper ? 'bash' : process.execPath;
    const launchArgs = wrapper ? [path.join(root, 'smart-start.sh'), ...args]
      : ['--require', preload, path.join(root, 'src/index.js'), ...args];
    const result = spawnSync(executable, launchArgs, {
      cwd: root,
      encoding: 'utf8',
      timeout: 10000,
      env: {
        ...process.env, NODE_ENV: 'test', HOME: tempDir, NO_COLOR: '1',
        FORGE_AGENT_BIN: path.join(root, 'src/index.js'),
        NODE_OPTIONS: `--require=${JSON.stringify(preload)}`,
      },
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    const output = result.stdout.replace(/\x1b\[[0-9;]*m/g, '');
    expect(output).toMatch(/Model\s+: doubao/);
    const startup = JSON.parse(output.split('\n').find(line => line.startsWith('STARTUP=')).slice('STARTUP='.length));
    expect(startup).toEqual({ model: 'doubao', url: 'https://www.doubao.com/chat', adapter: 'DoubaoAdapter' });
  });
});
