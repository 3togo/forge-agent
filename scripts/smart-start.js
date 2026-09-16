'use strict';

// Linux /proc inspection keeps recovery scoped to the browser profile and owner.
// Chromium itself handles stale lock files; never delete profile data or locks.
const fs = require('fs');
const os = require('os');
const path = require('path');

function readProcess(pid) {
  try {
    const dir = `/proc/${pid}`;
    const stat = fs.readFileSync(`${dir}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    let executable = '';
    try { executable = fs.readlinkSync(`${dir}/exe`); }
    catch (err) { if (err.code !== 'ENOENT' && err.code !== 'EACCES') throw err; }
    return {
      pid, state: fields[0], ppid: Number(fields[1]), start: fields[19],
      executable,
      uid: fs.statSync(dir).uid,
      argv: fs.readFileSync(`${dir}/cmdline`, 'utf8').split('\0').filter(Boolean),
    };
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ESRCH') return null;
    throw err; // Unreadable processes are not evidence that the profile is free.
  }
}

function sameProcess(a, b) {
  return !!a && !!b && a.pid === b.pid && a.start === b.start && a.uid === b.uid;
}

function live(p) { return p && !['Z', 'X'].includes(p.state); }

function ownsProfile(p, sessionDir) {
  if (!live(p) || !/^(chrome|chromium|chromium-browser)$/.test(path.basename(p.executable || p.argv[0] || ''))) return false;
  // Chromium may rewrite /proc/cmdline as a single process-title string.
  const flat = p.argv.length === 1 ? p.argv[0] : null;
  if (p.argv.some(arg => arg.startsWith('--type=')) || (flat && / --type=/.test(flat))) return false;
  const arg = p.argv.find(arg => arg.startsWith('--user-data-dir='));
  const index = p.argv.indexOf('--user-data-dir');
  const value = flat ? / --user-data-dir=(.*?)(?= --|$)/.exec(flat)?.[1]
    : arg ? arg.slice('--user-data-dir='.length) : index >= 0 ? p.argv[index + 1] : null;
  if (!value) return false;
  // Forge passes an absolute path. Resolve symlinks for aliases of the same profile.
  try { return fs.realpathSync(value) === fs.realpathSync(sessionDir); }
  catch { return value === sessionDir; }
}

function isForge(p, entry) {
  if (!live(p) || !/^node(?:js)?$/.test(path.basename(p.argv[0] || ''))) return false;
  try { return fs.realpathSync(p.argv[1]) === entry; }
  catch { return false; }
}

async function stopProcess(original, io) {
  const signal = name => {
    const current = io.read(original.pid);
    if (!live(current) || !sameProcess(original, current)) return false;
    io.kill(original.pid, name);
    return true;
  };
  if (!signal('SIGTERM')) return;
  // A suspended job cannot run its SIGTERM handler until resumed.
  if (['T', 't'].includes(original.state)) signal('SIGCONT');
  for (let i = 0; i < 30; i++) {
    await io.sleep(100);
    const current = io.read(original.pid);
    if (!live(current) || !sameProcess(original, current)) return;
  }
  // Background terminal I/O can suspend the shutdown handler again.
  io.log(`Process ${original.pid} did not exit after SIGTERM; stopping it.`);
  signal('SIGKILL');
  for (let i = 0; i < 20; i++) {
    await io.sleep(100);
    const current = io.read(original.pid);
    if (!live(current) || !sameProcess(original, current)) return;
  }
  throw new Error(`Process ${original.pid} has not exited; startup aborted.`);
}

async function recover({ mode, entry, sessionDir, uid, hostname }, io) {
  const lock = io.lock();
  if (lock) {
    const match = /^(.*)-(\d+)$/.exec(lock);
    if (!match || match[1] !== hostname) {
      throw new Error(`Session lock belongs to another host or is unrecognized: ${lock}. Close its browser first.`);
    }
    const holder = io.read(Number(match[2]));
    if (live(holder) && !ownsProfile(holder, sessionDir)) {
      throw new Error(`Cannot verify the session lock owner (PID ${holder.pid}); startup aborted.`);
    }
  }
  const browsers = io.list().filter(p => ownsProfile(p, sessionDir));
  // Validate every owner before stopping anything.
  const owners = browsers.map(browser => {
    const owner = io.read(browser.ppid);
    if (browser.uid !== uid || owner?.uid !== uid || !isForge(owner, entry)) {
      throw new Error(`Browser PID ${browser.pid} uses this session but is not owned by the selected Forge Agent. Close it manually.`);
    }
    if (mode === 'check' || (mode !== 'restart' && !['T', 't'].includes(owner.state))) {
      const suspended = ['T', 't'].includes(owner.state);
      const advice = mode === 'check' && suspended ? 'Run without --check to recover this suspended session.' : 'Use its terminal, or pass --restart to stop it.';
      throw new Error(`Forge Agent PID ${owner.pid} is ${suspended ? 'suspended' : 'active'} and owns browser PID ${browser.pid}. ${advice}`);
    }
    return { browser, owner };
  });
  for (const { browser, owner } of owners) {
    io.log(`Recovering Forge Agent PID ${owner.pid}, browser PID ${browser.pid}...`);
    await stopProcess(owner, io);
    await stopProcess(browser, io);
  }
  if (io.list().some(p => ownsProfile(p, sessionDir))) {
    throw new Error('The browser session became busy during recovery; retry startup.');
  }
  io.log('Session is available. Saved browser data is preserved.');
}

async function main() {
  if (process.platform !== 'linux') throw new Error('Smart startup currently supports Linux only.');
  const [mode, binary] = process.argv.slice(2);
  if (!['check', 'recover', 'restart'].includes(mode) || !binary) throw new Error('Use smart-start.sh.');
  const entry = fs.realpathSync(binary);
  // Use the selected installation's config, including current-project overrides.
  const config = require(path.join(path.dirname(entry), 'config.js'));
  const sessionDir = path.resolve(config.SESSION_DIR);
  console.log(`Forge Agent: ${entry}\nSession: ${sessionDir}`);
  await recover({ mode, entry, sessionDir, uid: process.getuid(), hostname: os.hostname() }, {
    read: readProcess,
    list: () => fs.readdirSync('/proc').filter(name => /^\d+$/.test(name)).map(Number).map(readProcess).filter(Boolean),
    lock: () => {
      try { return fs.readlinkSync(path.join(sessionDir, 'SingletonLock')); }
      catch (err) { if (err.code === 'ENOENT') return null; throw err; }
    },
    kill: (pid, signal) => {
      try { process.kill(pid, signal); }
      catch (err) { if (err.code !== 'ESRCH') throw err; }
    },
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    log: console.log,
  });
}

if (require.main === module) main().catch(err => {
  console.error(`Smart startup: ${err.message}`);
  process.exitCode = 1;
});

module.exports = { recover, stopProcess, ownsProfile, readProcess };
