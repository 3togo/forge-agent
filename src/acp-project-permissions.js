'use strict';
const fs = require('fs');
const path = require('path');
const { createHash, randomUUID } = require('crypto');

function permissionFile(directory, workspace) {
  return path.join(directory, `${createHash('sha256').update(workspace).digest('hex')}.json`);
}
function hasProjectWrites(directory, workspace) {
  try {
    const record = JSON.parse(fs.readFileSync(permissionFile(directory, workspace), 'utf8'));
    return record.workspace === workspace && record.allowFileWrites === true;
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return false;
    throw error;
  }
}
function saveProjectWrites(directory, workspace) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = permissionFile(directory, workspace);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify({ workspace, allowFileWrites: true }), { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
module.exports = { hasProjectWrites, saveProjectWrites };
