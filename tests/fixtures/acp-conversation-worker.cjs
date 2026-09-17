// Exercise the real agent loop and production worker with a deterministic provider.
const config = require('../../src/config');
Object.assign(config, { MEMORY_ENABLED: false, PLANNING_MODE: false, DISABLE_SPONSOR_NUDGE: true });
const browserPath = require.resolve('../../src/browser');
class ProviderBrowser {
  constructor() { this.adapter = { isReady: async () => true }; this.sent = 0; }
  async launch() {}
  async newChat() {}
  async close() {}
  async sendMessage() { if (++this.sent > 1) throw new Error('Unexpected formatting correction sent to provider'); }
  async waitForResponse() { return '你好！有什么可以帮你？'; }
}
require.cache[browserPath] = { id: browserPath, filename: browserPath, loaded: true, exports: ProviderBrowser };
const Agent = require('../../src/agent');
Agent.prototype._recordHistory = () => {};
require('../../src/acp-worker').main();
