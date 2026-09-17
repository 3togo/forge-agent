'use strict';
jest.mock('child_process', () => ({ spawnSync: jest.fn(), spawn: jest.fn() }));
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { releaseDownload, installAionUi, ensureAionUi, startAionUi, stopAionUi } = require('../src/aionui-setup');

test('selects official Linux packages for both supported architectures', () => {
  expect(releaseDownload('version: 2.2.2\n', 'x64').url).toBe('https://static.aionui.com/releases/2.2.2/AionUi-2.2.2-linux-amd64.deb');
  expect(releaseDownload("version: '2.2.2'\n", 'arm64').filename).toBe('AionUi-2.2.2-linux-arm64.deb');
  expect(() => releaseDownload('version: ../../bad', 'x64')).toThrow('valid version');
  expect(() => releaseDownload('version: 2.2.2', 'ia32')).toThrow('does not support');
});

describe('installer', () => {
  let temp, oldPath, oldFetch, output;
  beforeEach(() => {
    temp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-aion-test-'));
    oldPath = process.env.PATH; process.env.PATH = temp;
    oldFetch = global.fetch;
    global.fetch = jest.fn()
      .mockResolvedValueOnce(new Response('version: 2.2.2\n'))
      .mockResolvedValueOnce(new Response('fake package'));
    output = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    spawnSync.mockReset();
  });
  afterEach(() => {
    process.env.PATH = oldPath; global.fetch = oldFetch; output.mockRestore();
    fs.rmSync(temp, { recursive: true, force: true });
  });
  test('downloads then invokes apt with terminal stderr and cleans temporary files', async () => {
    let packagePath;
    spawnSync.mockImplementation((cmd, args, options) => {
      if (args.includes('--version')) return { status: 0 };
      packagePath = args.at(-1);
      expect(fs.readFileSync(packagePath, 'utf8')).toBe('fake package');
      expect(options.stdio).toEqual([process.stdin, process.stderr, process.stderr]);
      expect(['apt', 'sudo']).toContain(cmd);
      fs.writeFileSync(path.join(temp, 'AionUi'), '#!/bin/sh\n', { mode: 0o755 });
      return { status: 0 };
    });
    await installAionUi();
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(fs.existsSync(packagePath)).toBe(false);
    expect(output.mock.calls.flat().join('')).toContain('AionUi installed.');
  });
  test('download failure never runs package installation', async () => {
    spawnSync.mockReturnValue({ status: 0 });
    global.fetch.mockReset().mockResolvedValueOnce(new Response('version: 2.2.2\n')).mockResolvedValueOnce(new Response('', { status: 404 }));
    await expect(installAionUi()).rejects.toThrow('HTTP 404');
    expect(spawnSync).toHaveBeenCalledTimes(1);
  });
  test('failed apt installation reports failure instead of success', async () => {
    spawnSync.mockReturnValueOnce({ status: 0 }).mockReturnValueOnce({ status: 1 });
    await expect(installAionUi()).rejects.toThrow('installation failed');
    expect(output.mock.calls.flat().join('')).not.toContain('AionUi installed.');
  });
  test('protocol startup never prompts or fetches installers', async () => {
    const tty = process.stdin.isTTY; process.stdin.isTTY = false;
    try { await ensureAionUi(); } finally { process.stdin.isTTY = tty; }
    expect(global.fetch).not.toHaveBeenCalled();
    expect(output).not.toHaveBeenCalled();
  });
});

describe('automatic GUI launch', () => {
  let temp, tty, display, wayland, output, home, kill;
  beforeEach(() => {
    temp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-aion-launch-'));
    home = jest.spyOn(os, 'homedir').mockReturnValue(temp);
    tty = process.stdin.isTTY; process.stdin.isTTY = true;
    display = process.env.DISPLAY; process.env.DISPLAY = ':0';
    wayland = process.env.WAYLAND_DISPLAY;
    output = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    spawn.mockReset(); spawnSync.mockReset();
    kill = jest.spyOn(process, 'kill').mockImplementation(() => true);
    spawnSync.mockReturnValue({ status: 0, stdout: '100 S bash\n101 S node\n' });
  });
  afterEach(() => {
    process.stdin.isTTY = tty;
    if (display === undefined) delete process.env.DISPLAY; else process.env.DISPLAY = display;
    if (wayland === undefined) delete process.env.WAYLAND_DISPLAY; else process.env.WAYLAND_DISPLAY = wayland;
    home.mockRestore(); output.mockRestore(); kill.mockRestore(); jest.useRealTimers();
    fs.rmSync(temp, { recursive: true, force: true });
  });
  test('stops the old AionUi before launching a fresh instance', async () => {
    jest.useFakeTimers();
    spawnSync.mockReturnValueOnce({ status: 0, stdout: '100 S bash\n200 S AionUi\n201 S aionui-helper\n202 Z AionUi\n' });
    const child = new (require('events').EventEmitter)(); child.unref = jest.fn();
    spawn.mockReturnValue(child);
    const started = startAionUi('/usr/bin/AionUi');
    await jest.advanceTimersByTimeAsync(1200); await started;
    expect(kill.mock.calls).toEqual([[200, 'SIGTERM'], [201, 'SIGTERM']]);
    expect(kill.mock.invocationCallOrder[1]).toBeLessThan(spawn.mock.invocationCallOrder[0]);
    expect(spawn).toHaveBeenCalledTimes(1);
  });
  test('forces a hung old process to stop after the grace period', async () => {
    jest.useFakeTimers();
    spawnSync.mockReturnValue({ status: 0, stdout: '200 S AionUi\n' });
    kill.mockImplementation((pid, signal) => {
      if (signal === 'SIGKILL') spawnSync.mockReturnValue({ status: 0, stdout: '' });
      return true;
    });
    const stopped = stopAionUi();
    await jest.advanceTimersByTimeAsync(8200); await stopped;
    expect(kill.mock.calls).toEqual([[200, 'SIGTERM'], [200, 'SIGKILL']]);
  });
  test('does not launch when stopping the old process fails', async () => {
    spawnSync.mockReturnValue({ status: 0, stdout: '200 S AionUi\n' });
    kill.mockImplementation(() => { throw Object.assign(new Error('Permission denied'), { code: 'EPERM' }); });
    await startAionUi('/usr/bin/AionUi');
    expect(spawn).not.toHaveBeenCalled();
    expect(output.mock.calls.flat().join('')).toContain('Cannot restart AionUi');
  });
  test('headless terminals get actionable guidance', async () => {
    delete process.env.DISPLAY; delete process.env.WAYLAND_DISPLAY;
    await startAionUi('/usr/bin/AionUi');
    expect(spawn).not.toHaveBeenCalled();
    expect(output.mock.calls.flat().join('')).toContain('desktop display');
  });
  test('GUI survives the terminal and its output goes to a log', async () => {
    jest.useFakeTimers();
    const child = new (require('events').EventEmitter)(); child.unref = jest.fn();
    spawn.mockReturnValue(child);
    const started = startAionUi('/usr/bin/AionUi');
    await jest.advanceTimersByTimeAsync(1200); await started;
    expect(spawn).toHaveBeenCalledWith('/usr/bin/AionUi', [], expect.objectContaining({ detached: true }));
    expect(spawn.mock.calls[0][2].stdio[0]).toBe('ignore');
    expect(child.unref).toHaveBeenCalled();
    expect(fs.existsSync(path.join(temp, '.local/state/forge-agent/aionui.log'))).toBe(true);
  });
  test('reports launch errors without claiming success', async () => {
    const child = new (require('events').EventEmitter)();
    spawn.mockReturnValue(child);
    const started = startAionUi('/missing/AionUi');
    await Promise.resolve();
    child.emit('error', new Error('ENOENT')); await started;
    expect(output.mock.calls.flat().join('')).toContain('Could not start AionUi');
    expect(output.mock.calls.flat().join('')).not.toContain('AionUi launched');
  });
  test('ACP client startup never opens a GUI', async () => {
    process.stdin.isTTY = false;
    await startAionUi('/usr/bin/AionUi');
    expect(spawnSync).not.toHaveBeenCalled(); expect(spawn).not.toHaveBeenCalled();
  });
});
