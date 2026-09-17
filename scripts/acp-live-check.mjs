// Opt-in smoke test against the real provider. Never runs as part of npm test.
import { ClientSideConnection, ndJsonStream } from '@agentclientprotocol/sdk';
import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-live-check-'));
const child = spawn(process.execPath, ['src/acp-entry.js', '--model=doubao'], {
  cwd: root, stdio: ['pipe', 'pipe', 'inherit'],
});
const exited = new Promise(resolve => child.once('exit', resolve));
let messages = [];
const connection = new ClientSideConnection(() => ({
  async sessionUpdate(event) {
    if (event.update.sessionUpdate === 'agent_message_chunk') {
      messages.push(event.update.content?.text || '');
    }
  },
  async requestPermission() { return { outcome: { outcome: 'cancelled' } }; },
}), ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)));
const timer = setTimeout(() => child.kill('SIGTERM'), 180000);
try {
  await connection.initialize({ protocolVersion: 1, clientCapabilities: {} });
  for (let sessionIndex = 0; sessionIndex < 2; sessionIndex++) {
    const session = await connection.newSession({ cwd: workspace, mcpServers: [] });
    for (let turn = 0; turn < (sessionIndex === 0 ? 2 : 1); turn++) {
      const marker = `FORGE_LIVE_OK_${sessionIndex}_${turn}`;
      messages = [];
      const result = await connection.prompt({ sessionId: session.sessionId, prompt: [{
        type: 'text', text: `Diagnostic only: reply with ${marker}. Do not read, write, or execute anything.`,
      }] });
      assert.equal(result.stopReason, 'end_turn');
      assert.equal(messages.filter(text => text.trim() === marker).length, 1,
        `Expected exactly one provider reply: ${marker}`);
      console.log(`PASS: session ${sessionIndex + 1}, turn ${turn + 1}: ${marker}`);
    }
  }
} finally {
  clearTimeout(timer);
  child.stdin.end();
  await exited;
  fs.rmSync(workspace, { recursive: true, force: true });
}
