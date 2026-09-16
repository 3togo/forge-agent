'use strict';

const { recover, stopProcess, ownsProfile, readProcess } = require('../scripts/smart-start');
const fs = require('fs');
const os = require('os');
const path = require('path');

const entry = fs.realpathSync(path.join(__dirname, '../src/index.js'));
const sessionDir = '/tmp/forge-smart-start-test-profile';
let processes, io, options;

beforeEach(() => {
  processes = new Map([
    [101, { pid: 101, ppid: 1, state: 'T', start: '100', uid: 1000, argv: ['/usr/bin/node', entry, '--interactive'] }],
    [102, { pid: 102, ppid: 101, state: 'S', start: '101', uid: 1000, argv: ['/opt/chrome', `--user-data-dir=${sessionDir}`] }],
  ]);
  options = { mode: 'recover', entry, sessionDir, uid: 1000, hostname: 'test-host' };
  io = {
    read: pid => processes.get(pid) || null,
    list: () => [...processes.values()],
    lock: () => 'test-host-102',
    sleep: jest.fn().mockResolvedValue(),
    log: jest.fn(),
    kill: jest.fn((pid, signal) => { if (signal === 'SIGKILL') processes.delete(pid); }),
  };
});

test('recovers a suspended agent even when graceful shutdown remains stuck', async () => {
  await recover(options, io);
  expect(io.kill.mock.calls).toEqual([
    [101, 'SIGTERM'], [101, 'SIGCONT'], [101, 'SIGKILL'],
    [102, 'SIGTERM'], [102, 'SIGKILL'],
  ]);
  expect(processes.size).toBe(0);
});

test('does not force kill when SIGTERM closes the agent and browser', async () => {
  io.kill.mockImplementation(() => processes.clear());
  await recover(options, io);
  expect(io.kill.mock.calls).toEqual([[101, 'SIGTERM']]);
});

test('refuses to interrupt an active agent by default', async () => {
  processes.get(101).state = 'S';
  await expect(recover(options, io)).rejects.toThrow(/active.*--restart/);
  expect(io.kill).not.toHaveBeenCalled();
});

test('explicit restart can stop an active agent', async () => {
  processes.get(101).state = 'S';
  await recover({ ...options, mode: 'restart' }, io);
  expect(io.kill).toHaveBeenCalledWith(101, 'SIGTERM');
  expect(io.kill).not.toHaveBeenCalledWith(101, 'SIGCONT');
});

test('check never signals a suspended owner', async () => {
  await expect(recover({ ...options, mode: 'check' }, io)).rejects.toThrow(/suspended/);
  expect(io.kill).not.toHaveBeenCalled();
});

test.each(['another-host-102', 'unrecognized'])('refuses foreign or malformed lock %s', async lock => {
  io.lock = () => lock;
  await expect(recover(options, io)).rejects.toThrow(/another host or is unrecognized/);
  expect(io.kill).not.toHaveBeenCalled();
});

test('refuses a lock whose PID is now an unrelated process', async () => {
  processes.get(102).argv = ['/usr/bin/bash'];
  await expect(recover(options, io)).rejects.toThrow(/Cannot verify/);
  expect(io.kill).not.toHaveBeenCalled();
});

test('does not kill a browser belonging to a different application', async () => {
  processes.get(101).argv = ['/usr/bin/node', __filename];
  await expect(recover({ ...options, mode: 'restart' }, io)).rejects.toThrow(/not owned/);
  expect(io.kill).not.toHaveBeenCalled();
});

test('does not signal another user', async () => {
  processes.get(101).uid = 2000;
  await expect(recover(options, io)).rejects.toThrow(/not owned/);
  expect(io.kill).not.toHaveBeenCalled();
});

test('stale locks are left for Chromium to handle', async () => {
  processes.clear();
  await expect(recover(options, io)).resolves.toBeUndefined();
  expect(io.kill).not.toHaveBeenCalled();
});

test('does not kill a reused PID during recovery', async () => {
  const original = processes.get(101);
  io.sleep.mockImplementation(async () => {
    processes.set(101, { ...original, start: '999', state: 'S' });
  });
  await stopProcess(original, io);
  expect(io.kill.mock.calls).toEqual([[101, 'SIGTERM'], [101, 'SIGCONT']]);
  expect(processes.get(101).start).toBe('999');
});

test('recognizes only the browser using the exact profile', () => {
  const browser = processes.get(102);
  expect(ownsProfile(browser, sessionDir)).toBe(true);
  expect(ownsProfile(browser, sessionDir + '-other')).toBe(false);
  expect(ownsProfile({ ...browser, argv: [...browser.argv, '--type=renderer'] }, sessionDir)).toBe(false);
});

test('reads the actual current Linux process identity', () => {
  if (os.platform() !== 'linux') return;
  const current = readProcess(process.pid);
  expect(current.pid).toBe(process.pid);
  expect(current.ppid).toBe(process.ppid);
  expect(current.uid).toBe(process.getuid());
  expect(current.start).toMatch(/^\d+$/);
});

test('recognizes Chromium that rewrites its command line as a process title', () => {
  const browser = processes.get(102);
  const profile = '/tmp/profile with spaces';
  const flat = { ...browser, executable: '/opt/chrome', argv: [`/opt/chrome --no-sandbox --user-data-dir=${profile} --remote-debugging-pipe about:blank`] };
  expect(ownsProfile(flat, profile)).toBe(true);
  expect(ownsProfile(flat, profile + '-other')).toBe(false);
  expect(ownsProfile({ ...flat, executable: '/usr/bin/bash' }, profile)).toBe(false);
  expect(ownsProfile({ ...flat, argv: [flat.argv[0] + ' --type=renderer'] }, profile)).toBe(false);
});

describe('shell launcher', () => {
  let tempDir, binary;
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge startup '));
    binary = path.join(tempDir, 'forge-agent');
    fs.writeFileSync(binary, `#!${process.execPath}\nconsole.log('ARGS=' + JSON.stringify(process.argv.slice(2))); process.exit(Number(process.env.SMART_TEST_EXIT || 0));\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(tempDir, 'config.js'), `module.exports = { SESSION_DIR: ${JSON.stringify(path.join(tempDir, 'profile'))} };\n`);
  });
  afterEach(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  function run(args, env = {}) {
    return require('child_process').spawnSync('bash', [path.join(__dirname, '../smart-start.sh'), ...args], {
      encoding: 'utf8', env: { ...process.env, FORGE_AGENT_BIN: binary, ...env },
    });
  }

  test('defaults to interactive mode with an executable path containing spaces', () => {
    if (os.platform() !== 'linux') return;
    const result = run([]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('ARGS=["--interactive"]');
  });

  test('preserves task arguments and the agent exit status', () => {
    if (os.platform() !== 'linux') return;
    const result = run(['task with spaces', '--debug'], { SMART_TEST_EXIT: '7' });
    expect(result.status).toBe(7);
    expect(result.stdout).toContain('ARGS=["task with spaces","--debug"]');
  });

  test('check inspects a free session without launching the agent', () => {
    if (os.platform() !== 'linux') return;
    const result = run(['--check']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Session is available');
    expect(result.stdout).not.toContain('ARGS=');
  });
});
