'use strict';
const fs = require('fs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function identity(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return { pid, ppid: Number(fields[1]), start: fields[19], state: fields[0] };
  } catch { return null; }
}
function descendants(pid) {
  if (process.platform !== 'linux') return [];
  const all = fs.readdirSync('/proc').filter(n => /^\d+$/.test(n)).map(n => identity(Number(n))).filter(Boolean);
  const ids = new Set([pid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of all) if (ids.has(p.ppid) && !ids.has(p.pid)) { ids.add(p.pid); changed = true; }
  }
  return all.filter(p => ids.has(p.pid));
}
function signalOwned(p, signal) {
  const now = identity(p.pid);
  if (!now || now.start !== p.start || now.state === 'Z') return;
  try { process.kill(p.pid, signal); } catch (err) { if (err.code !== 'ESRCH') throw err; }
}
async function stopWorker(worker, previouslyOwned = []) {
  if (!worker?.pid) return;
  const stillOwned = () => {
    const now = identity(worker.pid);
    return now && (!worker.acpIdentity || now.start === worker.acpIdentity.start);
  };
  const owned = previouslyOwned.concat(stillOwned() ? descendants(worker.pid) : []);
  // First let the worker close its Playwright context gracefully.
  try { worker.kill('SIGTERM'); } catch {}
  for (let i = 0; i < 20 && worker.exitCode === null && !worker.signalCode; i++) await delay(100);
  // Include descendants started while the graceful handler was being scheduled.
  const latest = stillOwned() ? descendants(worker.pid) : [];
  const known = new Map(owned.concat(latest).map(p => [`${p.pid}:${p.start}`, p]));
  for (const p of [...known.values()].reverse()) signalOwned(p, 'SIGTERM');
  if (process.platform !== 'linux') {
    try { process.kill(-worker.pid, 'SIGTERM'); } catch {}
  }
  await delay(150);
  for (const p of [...known.values()].reverse()) signalOwned(p, 'SIGKILL');
  if (worker.exitCode === null && !worker.signalCode) {
    try { worker.kill('SIGKILL'); } catch {}
  }
}
module.exports = { stopWorker, identity, descendants };
