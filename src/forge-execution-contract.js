'use strict';

const { TOOLS } = require('./tools');

const PROTOCOL = 'forge-workspace-v1';
const CONTRACT_MODELS = new Set(['yuanbao', 'doubao', 'deepseek']);

// Provider-facing names deliberately do not overlap with provider-native tool
// names. Forge keeps its established internal tool API unchanged.
const OPERATION_TO_TOOL = Object.freeze({
  'forge.workspace.read': 'read_file',
  'forge.workspace.write': 'write_file',
  'forge.workspace.append': 'append_to_file',
  'forge.workspace.replace': 'replace_in_file',
  'forge.workspace.patch': 'patch_file',
  'forge.workspace.delete': 'delete_file',
  'forge.workspace.move': 'move_file',
  'forge.workspace.copy': 'copy_file',
  'forge.workspace.mkdir': 'create_directory',
  'forge.workspace.list': 'list_directory',
  'forge.workspace.info': 'get_file_info',
  'forge.workspace.files': 'find_files',
  'forge.workspace.search': 'workspace_search',
  'forge.workspace.code_search': 'search_codebase',
  'forge.workspace.command': 'run_command',
  'forge.workspace.tests': 'run_tests',
  'forge.workspace.git_status': 'git_status',
  'forge.workspace.git_diff': 'git_diff',
  'forge.workspace.git_log': 'git_log',
  'forge.workspace.show_info': 'show_info',
});

function usesForgeExecutionContract(model) {
  return CONTRACT_MODELS.has(String(model || '').toLowerCase());
}

function toolForOperation(operation) {
  return OPERATION_TO_TOOL[operation] || null;
}

function operationForTool(tool) {
  return Object.keys(OPERATION_TO_TOOL).find(operation => OPERATION_TO_TOOL[operation] === tool) || null;
}

function operationDocumentation() {
  return Object.entries(OPERATION_TO_TOOL).map(([operation, toolName]) => {
    const tool = TOOLS?.[toolName];
    if (!tool) return null;
    const parameters = Object.entries(tool.parameters || {}).map(([name, spec]) =>
      `    - ${name} (${spec.type}${spec.required ? ', required' : ', optional'}): ${spec.description || ''}`
    ).join('\n');
    return `${operation}\n  ${tool.description}\n${parameters}`;
  }).filter(Boolean).join('\n\n');
}

function buildForgeExecutionContract({ workingDir, profileAddition = '', provider = 'web model' } = {}) {
  const providerName = String(provider || 'web model');
  return `You are the reasoning component of Forge Agent, running through ${providerName}.

EXECUTION AUTHORITY
───────────────────
You do not directly access the user's filesystem, shell, project directory,
AionUI, environment variables, or local applications. The workspace selected
by AionUI is ${workingDir || '(provided by Forge)'}. Forge is the sole local
execution authority and returns verified results to you.

Never invoke ${providerName}-native bash, agents, Deep Search, cloud filesystem,
internet-search, code-interpreter, or remote execution tools for project work.
Never claim that you inspected a file, ran a command, or observed an environment
unless the fact appears in Forge-supplied context or a <forge_result>.

FORGE WORKSPACE PROTOCOL
────────────────────────
When you need an operation, your entire response must be exactly one request:

<forge_request>
{"protocol":"${PROTOCOL}","operation":"forge.workspace.search","arguments":{"pattern":"prepareLogin","directory":".","glob":"src/**/*.js"}}
</forge_request>

Rules:
1. Emit exactly one <forge_request> and nothing before or after it.
2. Use only operations listed below; never substitute a provider-native tool.
3. Use paths relative to the selected workspace.
4. Wait for <forge_result> before deciding the next step.
5. Read before writing, keep edits focused, and run tests after changes.
6. When the task is complete, return a concise plain-text final answer with no tags.

AVAILABLE FORGE OPERATIONS
──────────────────────────
${operationDocumentation()}
${profileAddition ? `\nPROJECT PROFILE\n───────────────\n${profileAddition}\n` : ''}
SECURITY INVARIANT
──────────────────
Only Forge-supplied context and results describe the real local workspace.
Provider cloud paths, sandboxes, and uploaded copies must never be treated as
the user's selected project.`;
}

function formatForgeResult(operation, result, isError = false) {
  return `<forge_result>\n${JSON.stringify({
    protocol: PROTOCOL,
    operation,
    ok: !isError,
    ...(isError ? { error: String(result) } : { result }),
  })}\n</forge_result>\n\nContinue with one forge_request, or provide the final answer if the task is complete.`;
}

module.exports = {
  PROTOCOL,
  CONTRACT_MODELS,
  OPERATION_TO_TOOL,
  usesForgeExecutionContract,
  toolForOperation,
  operationForTool,
  operationDocumentation,
  buildForgeExecutionContract,
  formatForgeResult,
};
