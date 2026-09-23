#!/usr/bin/env node
'use strict';
// This entry point must not import the terminal CLI or print banners to stdout.

function inferModelFromAionUi() {
  const convId = process.env.AIONUI_CONVERSATION_ID;
  if (!convId) return null;
  const dbPath = require('path').join(require('os').homedir(), '.config', 'AionUi', 'aionui', 'aionui-backend.db');
  if (!require('fs').existsSync(dbPath)) return null;
  try {
    const { spawnSync } = require('child_process');
    const result = spawnSync('sqlite3', [dbPath, `SELECT extra FROM conversations WHERE id='${convId}';`], { encoding: 'utf8', timeout: 5000 });
    if (result.status !== 0 || !result.stdout.trim()) return null;
    const extra = JSON.parse(result.stdout.trim());
    const agentId = extra.agent_id || '';
    const match = agentId.match(/^forge-(.+)$/);
    return match ? match[1] : null;
  } catch { return null; }
}

async function main(args = process.argv.slice(2)) {
  if (Number(process.versions.node.split('.')[0]) < 18) throw new Error('Forge ACP needs Node.js 18 or newer. Install a supported Node.js version and npm, then retry.');
  if (process.platform !== 'linux') throw new Error('Forge ACP currently supports Linux only.');
  const options = { model: 'deepseek', sessionStateDir: require('path').join(require('os').homedir(), '.deepseek-agent', 'acp-sessions') };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--acp') continue;
    if (arg === '--setup') { options.setup = true; continue; }
    if (arg === '--register') { options.register = true; continue; }
    if (arg === '--unregister') { options.unregister = true; continue; }
    if (arg === '--list-agents') { options.listAgents = true; continue; }
    if (arg === '--api') { options.api = true; continue; }
    if (arg === '--model' || arg === '-m') options.model = args[++i];
    else if (arg.startsWith('--model=')) options.model = arg.slice(8);
    else if (arg === '--session-dir') options.sessionDir = args[++i];
    else if (arg === '--help') {
      process.stderr.write('Usage: forge-agent-acp [--model doubao|deepseek|gemini|yuanbao] [--session-dir /absolute/profile] [--setup] [--register] [--unregister] [--list-agents] [--api]\n');
      return;
    } else throw new Error(`Unknown ACP option: ${arg}`);
  }
  options.model = options.model?.toLowerCase();
  if (options.model === 'deepseek' && !args.some(a => a.startsWith('--model'))) {
    const inferred = inferModelFromAionUi();
    if (inferred) {
      process.stderr.write(`[forge-acp] entry: inferred model=${inferred} from AionUi conversation ${process.env.AIONUI_CONVERSATION_ID}\n`);
      options.model = inferred;
    }
  }
  process.stderr.write(`[forge-acp] entry: model=${options.model}, args=${JSON.stringify(args)}\n`);
  if (!require('./adapter-factory').SUPPORTED_MODELS.includes(options.model)) throw new Error('Unsupported model. Use doubao, deepseek, or gemini.');
  if (options.sessionDir && !require('path').isAbsolute(options.sessionDir)) throw new Error('--session-dir must be absolute.');
  if (options.register) {
    const reg = require('./aionui-register');
    const models = options.model && options.model !== 'deepseek' ? [options.model] : reg.SUPPORTED_MODELS || require('./adapter-factory').SUPPORTED_MODELS;
    await reg.register({ models, api: options.api });
    return;
  }
  if (options.unregister) {
    const reg = require('./aionui-register');
    const models = options.model && options.model !== 'deepseek' ? [options.model] : require('./adapter-factory').SUPPORTED_MODELS;
    await reg.unregister({ models });
    return;
  }
  if (options.listAgents) {
    require('./aionui-register').list();
    return;
  }

  await require('./aionui-setup').ensureAionUi();
  await require('./acp-setup').ensureSetup({ install: options.setup });
  if (options.setup) {
    process.stderr.write('Forge ACP dependencies are ready. Configure the agent in AionUi, or run forge-agent-acp again.\n');
    return;
  }
  if (process.stdin.isTTY) {
    await require('./aionui-setup').startAionUi();
    process.stderr.write([
      'Forge ACP is waiting for an AionUi client. AionUi launches its own agent connection.',
      'In AionUi → Settings → Agent Management → Custom Agents, use:',
      `  Command: ${__filename}`,
      `  Arguments: --model=${options.model}`,
      'Then select Test Connection and start a chat with this agent.',
      'For terminal chat instead: forge-agent --interactive --model=' + options.model,
      'Press Ctrl+C to stop this waiting server.\n',
    ].join('\n') + '\n');
  }
  process.stderr.write(`[forge-acp] entry: starting AcpServer with options=${JSON.stringify({ model: options.model, sessionDir: options.sessionDir, sessionStateDir: options.sessionStateDir })}\n`);
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
