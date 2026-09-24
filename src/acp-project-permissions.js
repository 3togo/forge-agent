'use strict';
const fs = require('fs');
const path = require('path');
const { createHash, randomUUID } = require('crypto');

function permissionFile(directory, workspace) {
  return path.join(directory, `${createHash('sha256').update(workspace).digest('hex')}.json`);
}
function readRecord(directory, workspace) {
  try {
    const record = JSON.parse(fs.readFileSync(permissionFile(directory, workspace), 'utf8'));
    return record.workspace === workspace ? record : null;
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}
function hasProjectPermission(directory, workspace, permission) {
  const record = readRecord(directory, workspace);
  return record?.[permission] === true;
}
function saveProjectPermission(directory, workspace, permission) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = permissionFile(directory, workspace);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const record = { ...(readRecord(directory, workspace) || {}), workspace, [permission]: true };
    fs.writeFileSync(temporary, JSON.stringify(record), { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
function hasProjectWrites(directory, workspace) {
  return hasProjectPermission(directory, workspace, 'allowFileWrites');
}
function saveProjectWrites(directory, workspace) {
  return saveProjectPermission(directory, workspace, 'allowFileWrites');
}
module.exports = { hasProjectPermission, saveProjectPermission, hasProjectWrites, saveProjectWrites };
