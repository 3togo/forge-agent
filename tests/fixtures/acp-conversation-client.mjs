import { ClientSideConnection, ndJsonStream } from '@agentclientprotocol/sdk';
import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const child = spawn(process.execPath, [fileURLToPath(new URL('./acp-wire-server.cjs', import.meta.url)), 'conversation'], {
  stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, HOME: process.argv[2] },
});
let errors = '';
child.stderr.on('data', chunk => { errors += chunk; });
const updates = [];
const conn = new ClientSideConnection(() => ({
  async sessionUpdate(event) { updates.push(event.update); },
  async requestPermission() { throw new Error('A greeting should not execute tools'); },
}), ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)));
try {
  await conn.initialize({ protocolVersion: 1, clientCapabilities: {} });
  const session = await conn.newSession({ cwd: process.argv[2], mcpServers: [] });
  const result = await conn.prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text: 'hi' }] });
  assert.equal(result.stopReason, 'end_turn');
  const replies = updates.filter(u => u.sessionUpdate === 'agent_message_chunk' && u.content.text === '你好！有什么可以帮你？');
  assert.equal(replies.length, 1, errors);
  assert.ok(!updates.some(u => u.sessionUpdate === 'tool_call'));
  console.log('CONVERSATION_DELIVERED_ONCE');
} finally {
  child.stdin.end();
  await new Promise(resolve => child.on('exit', resolve));
}
