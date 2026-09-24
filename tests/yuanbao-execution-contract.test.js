'use strict';

const {
  PROTOCOL,
  toolForOperation,
  operationForTool,
  buildYuanbaoExecutionContract,
  formatForgeResult,
} = require('../src/yuanbao-execution-contract');

describe('Yuanbao execution contract', () => {
  test('uses namespaced operations and denies provider-native execution', () => {
    const prompt = buildYuanbaoExecutionContract({ workingDir: '/host/project' });
    expect(prompt).toContain(PROTOCOL);
    expect(prompt).toContain('forge.workspace.search');
    expect(prompt).toContain('/host/project');
    expect(prompt).toContain('Never invoke Yuanbao-native bash');
    expect(prompt).not.toContain('<tool_call>');
    expect(prompt).not.toContain('You have direct access');
  });

  test('maps public operations to existing internal tools in both directions', () => {
    expect(toolForOperation('forge.workspace.read')).toBe('read_file');
    expect(operationForTool('read_file')).toBe('forge.workspace.read');
    expect(toolForOperation('forge.native.bash')).toBeNull();
  });

  test('formats machine-readable results', () => {
    const result = formatForgeResult('forge.workspace.read', { content: 'ok' }, false);
    expect(result).toContain('<forge_result>');
    expect(result).toContain('"protocol":"forge-workspace-v1"');
    expect(result).toContain('"ok":true');
  });
});
