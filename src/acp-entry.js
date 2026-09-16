#!/usr/bin/env node
'use strict';
// This entry point must not import the terminal CLI or print banners to stdout.
async function main(args = process.argv.slice(2)) {
  if (process.platform !== 'linux') throw new Error('Forge ACP currently supports Linux only.');
  const options = { model: 'doubao' };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--acp') continue;
    if (arg === '--model' || arg === '-m') options.model = args[++i];
    else if (arg.startsWith('--model=')) options.model = arg.slice(8);
    else if (arg === '--session-dir') options.sessionDir = args[++i];
    else if (arg === '--help') {
      process.stderr.write('Usage: forge-agent-acp [--model doubao|deepseek|gemini] [--session-dir /absolute/profile]\n');
      return;
    } else throw new Error(`Unknown ACP option: ${arg}`);
  }
  options.model = options.model?.toLowerCase();
  if (!require('./adapter-factory').SUPPORTED_MODELS.includes(options.model)) throw new Error('Unsupported model. Use doubao, deepseek, or gemini.');
  if (options.sessionDir && !require('path').isAbsolute(options.sessionDir)) throw new Error('--session-dir must be absolute.');
  if (process.stdin.isTTY) {
    process.stderr.write([
      'Forge ACP is waiting for an AionUi client. This command does not open a GUI.',
      'In AionUi → Settings → Agent Management → Custom Agents, use:',
      `  Command: ${__filename}`,
      `  Arguments: --model=${options.model}`,
      'Then select Test Connection and start a chat with this agent.',
      'For terminal chat instead: forge-agent --interactive --model=' + options.model,
      'Press Ctrl+C to stop this waiting server.\n',
    ].join('\n') + '\n');
  }
  const { AgentSideConnection, ndJsonStream } = await import('@agentclientprotocol/sdk');
  const { Readable, Writable } = require('stream');
  const AcpServer = require('./acp-server');
  let server;
  const connection = new AgentSideConnection(conn => (server = new AcpServer(conn, options)),
    ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
  const shutdown = async () => { await server.close(); process.exit(0); };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  await connection.closed;
  await server.close();
  process.removeListener('SIGTERM', shutdown);
  process.removeListener('SIGINT', shutdown);
}
if (require.main === module) main().catch(err => { console.error(err.message); process.exitCode = 1; });
module.exports = { main };
