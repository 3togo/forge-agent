'use strict';

const fs   = require('fs');
const path = require('path');

const TOOL_CATEGORIES = {
  write_file: 'file_write', write_file_range: 'file_write',
  append_to_file: 'file_write', replace_in_file: 'file_write',
  patch_file: 'file_write', write_files: 'file_write',
  create_directory: 'file_write', move_file: 'file_write',
  copy_file: 'file_write', take_screenshot: 'file_write',
  delete_file: 'file_delete',
  run_command: 'shell_exec', start_process: 'shell_exec',
  stop_process: 'shell_exec', install_package: 'shell_exec',
  set_env_var: 'env_write', delete_env_var: 'env_write',
  write_clipboard: 'system_write',
};

const READ_ONLY_TOOLS = new Set([
  'read_file', 'list_directory', 'get_file_info',
  'search_in_files', 'workspace_search', 'search_codebase', 'find_files',
  'git_status', 'git_log', 'git_diff', 'git_branches', 'git_show', 'git_blame',
  'list_env_files', 'check_env_vars', 'read_env',
  'list_processes', 'read_process_logs', 'read_clipboard',
  'diff_files', 'run_tests', 'read_url',
  'show_info',
]);

const CATEGORY_LABELS = {
  file_write: 'write files', file_delete: 'delete files',
  shell_exec: 'run shell commands', env_write: 'modify .env files',
  system_write: 'write to clipboard',
};

function isReadOnly(toolName) { return READ_ONLY_TOOLS.has(toolName); }
function getCategory(toolName) { return TOOL_CATEGORIES[toolName] || 'other'; }

class PermissionStore {
  constructor(workingDir) {
    this.workingDir = workingDir;
    this.filePath = path.join(workingDir, '.forge-permissions.json');
    this._sessionAllowed = new Set();
    this._saved = this._load();
    
    // Add to .gitignore if exists
    try {
      const gitignorePath = path.join(workingDir, '.gitignore');
      if (fs.existsSync(gitignorePath)) {
        const content = fs.readFileSync(gitignorePath, 'utf8');
        if (!content.includes('.forge-permissions.json')) {
          fs.appendFileSync(gitignorePath, '\n.forge-permissions.json\n');
        }
      }
    } catch {}
  }

  _load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
        return { alwaysAllow: Array.isArray(parsed.alwaysAllow) ? parsed.alwaysAllow : [] };
      }
    } catch {}
    return { alwaysAllow: [] };
  }

  _save() {
    try { fs.writeFileSync(this.filePath, JSON.stringify(this._saved, null, 2), 'utf8'); }
    catch {}
  }

  isPreApproved(category) {
    return this._sessionAllowed.has(category) || this._saved.alwaysAllow.includes(category);
  }

  record(category, decision) {
    if (decision === 'session') {
      this._sessionAllowed.add(category);
    } else if (decision === 'saved') {
      this._sessionAllowed.add(category);
      if (!this._saved.alwaysAllow.includes(category)) {
        this._saved.alwaysAllow.push(category);
        this._save();
      }
    }
  }
}

module.exports = { PermissionStore, isReadOnly, getCategory, CATEGORY_LABELS };
