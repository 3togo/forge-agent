// Exercise the production worker and tools without contacting an AI website.
const agentPath = require.resolve('../../src/agent');
class FakeAgent {
  constructor(options) { this.options = options; this.browser = { adapter: { isReady: async () => true } }; }
  async init() {}
  async shutdown() {}
  async run(text) {
    if (text === 'write') {
      await this.options.executeTool('write_file', { path: 'proof.txt', content: 'ACP verified\n' });
      return 'Written';
    }
    if (text === 'command') return await this.options.executeTool('run_command', { command: 'sleep 30', timeout: 60000 });
    if (text === 'list') return await this.options.executeTool('run_command', { command: 'printf listed' });
    if (text === 'test') return await this.options.executeTool('run_tests', {});
    if (text === 'escape') return await this.options.executeTool('write_file', { path: '../outside.txt', content: 'bad' });
    if (text === 'profile') return process.env.FORGE_ACP_SESSION_DIR;
    if (text === 'cwd') return process.cwd();
    return text;
  }
}
require.cache[agentPath] = { id: agentPath, filename: agentPath, loaded: true, exports: FakeAgent };
require('../../src/acp-worker').main();
