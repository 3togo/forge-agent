'use strict';

const config = require('../src/config');
const {
  PROTOCOL,
  buildForgeExecutionContract,
  usesForgeExecutionContract,
} = require('../src/forge-execution-contract');
const { buildSystemPrompt } = require('../src/prompt');

describe('shared Forge web-provider execution contract', () => {
  test.each(['yuanbao', 'doubao', 'deepseek'])('%s uses the shared contract', model => {
    expect(usesForgeExecutionContract(model)).toBe(true);
  });

  test('keeps unrelated adapters on their existing protocol', () => {
    expect(usesForgeExecutionContract('gemini')).toBe(false);
  });

  test('renders provider-specific safety language over one protocol', () => {
    const prompt = buildForgeExecutionContract({ provider: 'Doubao (豆包)', workingDir: '/host/project' });
    expect(prompt).toContain(PROTOCOL);
    expect(prompt).toContain('Doubao (豆包)-native bash');
    expect(prompt).toContain('/host/project');
  });

  test.each(['yuanbao', 'doubao', 'deepseek'])('prompt routing selects the contract for %s', model => {
    const previous = { ...config };
    try {
      config.MODEL = model;
      config.WORKING_DIR = '/host/project';
      expect(buildSystemPrompt()).toContain('<forge_request>');
    } finally {
      for (const key of Object.keys(config)) if (!(key in previous)) delete config[key];
      Object.assign(config, previous);
    }
  });
});
