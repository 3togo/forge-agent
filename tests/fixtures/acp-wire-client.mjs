import { ClientSideConnection, ndJsonStream } from '@agentclientprotocol/sdk';
import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const child = spawn(process.execPath, [fileURLToPath(new URL('./acp-wire-server.cjs', import.meta.url))], { stdio: ['pipe', 'pipe', 'inherit'] });
let permissions = 0;
const updates = [];
const conn = new ClientSideConnection(() => ({
  async sessionUpdate(event) { updates.push(event.update); },
  async requestPermission() { permissions++; return { outcome: { outcome: 'selected', optionId: 'allow' } }; },
}), ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)));
try {
  const init = await conn.initialize({ protocolVersion: 1, clientCapabilities: {} });
  assert.equal(init.protocolVersion, 1);
  const session = await conn.newSession({ cwd: process.argv[2], mcpServers: [] });
  const result = await conn.prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text: 'write' }] });
  assert.equal(result.stopReason, 'end_turn');
  assert.equal(permissions, 1);
  assert.ok(updates.some(u => u.sessionUpdate === 'tool_call'));
  assert.ok(updates.some(u => u.sessionUpdate === 'tool_call_update' && u.status === 'completed' && u.content.some(c => c.type === 'diff')));
  assert.ok(updates.some(u => u.sessionUpdate === 'agent_message_chunk' && u.content.text === 'Written'));
  console.log('SDK_ROUND_TRIP_OK');
} finally {
  child.stdin.end();
  await new Promise(resolve => child.on('exit', resolve));
}
