#!/usr/bin/env node
'use strict';

const path = require('path');
const { spawn } = require('child_process');

let electron;
try {
  electron = require('electron');
} catch {
  console.error('Forge Agents Tray requires Electron. Reinstall without --omit=optional, or run: npm install electron');
  process.exit(1);
}

const entry = path.join(__dirname, 'yuanbao-tray', 'main.js');
const child = spawn(electron, [entry], { detached: false, stdio: 'inherit' });
child.once('error', error => {
  console.error(`Could not start Forge Agents Tray: ${error.message}`);
  process.exitCode = 1;
});
child.once('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
