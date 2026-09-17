'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, spawnSync } = require('child_process');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

function findAionUi() {
  const dirs = [...(process.env.PATH || '').split(path.delimiter).filter(Boolean), '/usr/bin', '/usr/local/bin'];
  for (const dir of dirs) for (const name of ['AionUi', 'aionui', 'aion-ui']) {
    const file = path.join(dir, name);
    try { fs.accessSync(file, fs.constants.X_OK); return file; } catch {}
  }
  for (const dir of [path.join(os.homedir(), 'Applications'), path.join(os.homedir(), 'Downloads'), '/opt']) {
    try {
      for (const name of fs.readdirSync(dir).filter(name => /aion.*\.appimage$/i.test(name))) {
        const file = path.join(dir, name);
        try { fs.accessSync(file, fs.constants.X_OK); return file; } catch {}
      }
    } catch {}
  }
}

function releaseDownload(metadata, arch = process.arch) {
  const cpu = { x64: 'amd64', arm64: 'arm64' }[arch];
  if (!cpu) throw new Error(`Automatic AionUi installation does not support ${arch}. Visit https://www.aionui.com/`);
  const version = metadata.match(/^version:\s*['"]?(\d+\.\d+\.\d+(?:-[\w.-]+)?)['"]?\s*$/m)?.[1];
  if (!version) throw new Error('The official AionUi release metadata has no valid version.');
  const filename = `AionUi-${version}-linux-${cpu}.deb`;
  return { filename, url: `https://static.aionui.com/releases/${version}/${filename}` };
}

async function installAionUi() {
  const available = spawnSync('apt', ['--version'], { stdio: 'ignore' });
  if (available.error || available.status !== 0) throw new Error('Automatic AionUi installation requires apt (Debian/Ubuntu). Visit https://www.aionui.com/');
  const metadata = await fetch('https://www.aionui.com/releases/latest.yml', { signal: AbortSignal.timeout(30000) });
  if (!metadata.ok) throw new Error(`AionUi release lookup failed: HTTP ${metadata.status}`);
  const { filename, url } = releaseDownload(await metadata.text());
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-aionui-'));
  const file = path.join(temp, filename);
  try {
    process.stderr.write(`Downloading ${filename} from the official AionUi server…\n`);
    const response = await fetch(url, { signal: AbortSignal.timeout(600000) });
    if (!response.ok || !response.body) throw new Error(`AionUi download failed: HTTP ${response.status}`);
    const source = Readable.fromWeb(response.body);
    const total = Number(response.headers.get('content-length'));
    let downloaded = 0, reported = 0;
    source.on('data', chunk => {
      downloaded += chunk.length;
      if (total > 0) {
        const progress = Math.floor(downloaded / total * 10) * 10;
        if (progress > reported) {
          reported = progress;
          process.stderr.write(`AionUi download: ${progress}%\n`);
        }
      }
    });
    await pipeline(source, fs.createWriteStream(file, { flags: 'wx' }));
    if (!downloaded || (total > 0 && downloaded !== total)) throw new Error('AionUi download was incomplete. Run forge-agent-acp again to retry.');
    process.stderr.write('Download complete. Installing AionUi (sudo may ask for your password)…\n');
    const isRoot = process.getuid?.() === 0;
    const result = spawnSync(isRoot ? 'apt' : 'sudo', isRoot ? ['install', '-y', file] : ['apt', 'install', '-y', file], {
      stdio: [process.stdin, process.stderr, process.stderr],
    });
    if (result.error || result.status !== 0) throw new Error(`AionUi installation failed: ${result.error?.message || `exit ${result.status}`}. Run forge-agent-acp again to retry.`);
    const command = findAionUi();
    if (!command) throw new Error('The installer completed, but the AionUi executable was not found. Check your desktop applications menu.');
    process.stderr.write(`AionUi installed. Open it from your desktop applications menu or run: ${command}\n`);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function aionUiProcesses() {
  const processes = spawnSync('ps', ['-u', String(process.getuid()), '-o', 'pid=,stat=,comm='], { encoding: 'utf8' });
  if (processes.error || processes.status !== 0) {
    throw new Error('Could not check whether AionUi is running.');
  }
  return processes.stdout.split('\n').flatMap(line => {
    const match = line.trim().match(/^(\d+)\s+(\S+)\s+(\S+)$/);
    return match && !match[2].startsWith('Z') && /^aionui(?:$|-)/i.test(match[3])
      ? [Number(match[1])] : [];
  });
}

async function stopAionUi() {
  const original = new Set(aionUiProcesses());
  if (!original.size) return;
  process.stderr.write('Stopping the old AionUi process before restarting it (active chats will disconnect)…\n');
  const signal = (pids, name) => {
    for (const pid of pids) {
      try { process.kill(pid, name); }
      catch (err) { if (err.code !== 'ESRCH') throw err; }
    }
  };
  signal(original, 'SIGTERM');
  const remaining = () => aionUiProcesses().filter(pid => original.has(pid));
  let pending = remaining();
  const deadline = Date.now() + 8000;
  while (pending.length && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 200));
    pending = remaining();
  }
  if (pending.length) {
    process.stderr.write('AionUi did not stop gracefully; terminating the old process.\n');
    signal(pending, 'SIGKILL');
    const deadline = Date.now() + 2000;
    while (remaining().length && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    if (remaining().length) throw new Error('The old AionUi process could not be stopped.');
  }
}

async function startAionUi(command = findAionUi()) {
  if (!process.stdin.isTTY || !command) return;
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    process.stderr.write('Cannot open AionUi without a desktop display. Run this command from your desktop terminal.\n');
    return;
  }
  try { await stopAionUi(); }
  catch (err) {
    process.stderr.write(`Cannot restart AionUi: ${err.message}\n`);
    return;
  }
  const logDir = path.join(os.homedir(), '.local', 'state', 'forge-agent');
  fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
  const logPath = path.join(logDir, 'aionui.log');
  const log = fs.openSync(logPath, 'a', 0o600);
  let child;
  try {
    child = spawn(command, [], { detached: true, stdio: ['ignore', log, log] });
  } finally { fs.closeSync(log); }
  await new Promise(resolve => {
    const timer = setTimeout(() => {
      child.unref();
      process.stderr.write(`AionUi launched. Configure Forge ACP in its Settings. Startup log: ${logPath}\n`);
      resolve();
    }, 1200);
    child.once('error', err => {
      clearTimeout(timer);
      process.stderr.write(`Could not start AionUi: ${err.message}. Startup log: ${logPath}\n`);
      resolve();
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      process.stderr.write(`AionUi launcher exited (${signal || code}). If no window opened, check ${logPath}\n`);
      resolve();
    });
  });
}

async function ensureAionUi() {
  // Client launches must never prompt, download, or write to protocol stdout.
  if (!process.stdin.isTTY || findAionUi()) return;
  process.stderr.write('AionUi was not detected. Forge ACP needs an ACP client for graphical chat.\n');
  const rl = require('readline').createInterface({ input: process.stdin, output: process.stderr });
  const accepted = await new Promise(resolve => {
    rl.once('close', () => resolve(false));
    rl.question('Download and install AionUi from its official website using sudo apt? [y/N] ', answer => {
      resolve(/^y(es)?$/i.test(answer.trim())); rl.close();
    });
  });
  if (accepted) await installAionUi();
  else process.stderr.write('Installation skipped. If AionUi is installed elsewhere, open that copy. Download: https://www.aionui.com/\n');
}
module.exports = { ensureAionUi, findAionUi, releaseDownload, installAionUi, startAionUi, stopAionUi };
