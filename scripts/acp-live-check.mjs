// Opt-in smoke test against the real provider. Never runs as part of npm test.
import { ClientSideConnection, ndJsonStream } from '@agentclientprotocol/sdk';
import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const model = process.argv.find(arg => arg.startsWith('--model='))?.slice(8) || 'doubao';
const { getModelUrl, SUPPORTED_MODELS } = require('../src/adapter-factory');
assert(SUPPORTED_MODELS.includes(model), `Unsupported model: ${model}`);
const authFile = path.join(os.homedir(), '.deepseek-agent', 'acp-auth', `${model}.json`);
const { isAuthValid } = require('../src/browser-auth');
assert(isAuthValid(authFile), `Saved login required. Run: forge-agent --login --model=${model}`);
// Verify saved credentials on the actual website in an isolated background profile
// before starting the ACP smoke test. Never launch interactive login from this test.
const config = require('../src/config');
const Browser = require('../src/browser');
const preflightDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-auth-preflight-'));
Object.assign(config, { MODEL: model, HEADLESS: true, SESSION_DIR: preflightDir, ACP_AUTH_FILE: authFile });
const browser = new Browser();
browser._checkLoginAndAttemptQr = async () => {
  assert(await browser.adapter.isReady(), `Login expired. Run: forge-agent --login --model=${model}`);
};
try {
  await browser.launch();
  console.log(`PASS: saved ${model} credentials restored into a fresh headless browser at ${getModelUrl(model)}`);
} finally {
  await browser.close();
  fs.rmSync(preflightDir, { recursive: true, force: true });
}
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-live-check-'));
const child = spawn(process.execPath, ['src/acp-entry.js', `--model=${model}`], {
  cwd: root, stdio: ['pipe', 'pipe', 'inherit'],
  env: { ...process.env, FORGE_ACP_HEADED: '0' },
});
const exited = new Promise(resolve => child.once('exit', resolve));
let messages = [];
const monitorUrls = new Map();
const viaShowInfo = process.argv.includes('--show-info');
const connection = new ClientSideConnection(() => ({
  async sessionUpdate(event) {
    if (event.update.sessionUpdate === 'agent_message_chunk') {
      const text = event.update.content?.text || '';
      messages.push(text);
      const url = text.match(/\[Open browser monitor\]\((http:\/\/127\.0\.0\.1:[0-9]+\/[a-f0-9]+)\)/)?.[1];
      if (url) monitorUrls.set(event.sessionId, url);
    }
  },
  async requestPermission() { return { outcome: { outcome: 'cancelled' } }; },
}), ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)));
const timer = setTimeout(() => child.kill('SIGTERM'), 300000);
try {
  await connection.initialize({ protocolVersion: 1, clientCapabilities: {} });
  for (let sessionIndex = 0; sessionIndex < 2; sessionIndex++) {
    const session = await connection.newSession({ cwd: workspace, mcpServers: [] });
    for (let turn = 0; turn < (sessionIndex === 0 ? 2 : 1); turn++) {
      const marker = `FORGE_LIVE_OK_${sessionIndex}_${turn}`;
      messages = [];
      const result = await connection.prompt({ sessionId: session.sessionId, prompt: [{
        type: 'text', text: viaShowInfo
          ? `Protocol diagnostic. Your next response must be exactly this text (the local Forge runner interprets it; do not invoke built-in tools):\n<tool_call>\n{"tool":"show_info","args":{"content":"${marker}"}}\n</tool_call>\nAfter receiving the tool result, reply exactly TASK_COMPLETE. No commentary or other tools.`
          : `Diagnostic only: reply with ${marker}. Do not read, write, or execute anything.`,
      }] });
      assert.equal(result.stopReason, 'end_turn');
      assert.equal(messages.filter(text => text.trim() === marker).length, 1,
        `Expected exactly one provider reply: ${marker}`);
      const monitorUrl = monitorUrls.get(session.sessionId);
      assert(monitorUrl, 'ACP did not report a monitor URL');
      const response = await fetch(monitorUrl);
      assert.equal(response.status, 200);
      assert((await response.text()).includes(marker), 'HTTP monitor did not show the reply');
      const monitorDir = path.join(os.homedir(), '.deepseek-agent', 'acp-profiles', model, session.sessionId, 'monitor');
      const events = fs.readFileSync(path.join(monitorDir, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
      if (viaShowInfo) {
        assert(events.some(e => e.type === 'output' && e.text.includes('show_info') && e.text.includes(marker)), 'Provider did not exercise show_info');
        assert(events.some(e => e.type === 'output' && e.text.trim() === 'TASK_COMPLETE'), 'Provider did not finish through TASK_COMPLETE');
        assert(!messages.some(text => text.trim() === 'TASK_COMPLETE'), 'Internal completion marker leaked into chat');
      }
      assert(events.some(e => e.type === 'input' && e.text.includes(marker)), 'Monitor did not record browser input');
      assert(events.some(e => e.type === 'output' && e.text.includes(marker)), 'Monitor did not record provider output');
      assert(fs.readFileSync(path.join(monitorDir, 'index.html'), 'utf8').includes('data:image/png;base64,'), 'Monitor screenshot is missing');
      assert.equal(fs.statSync(path.join(monitorDir, 'index.html')).mode & 0o777, 0o600);
      console.log(`MONITOR: ${path.join(monitorDir, 'index.html')}`);
      console.log(`PASS: session ${sessionIndex + 1}, turn ${turn + 1}: ${marker}`);
    }
  }
} finally {
  clearTimeout(timer);
  child.stdin.end();
  await exited;
  fs.rmSync(workspace, { recursive: true, force: true });
}
