// ACP v1 transport. Browser/model work runs in an isolated process.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { randomUUID } = require('crypto');
const { fork } = require('child_process');
const { stopWorker, descendants, identity } = require('./acp-process');
const { hasProjectWrites, saveProjectWrites } = require('./acp-project-permissions');

class AcpServer {
  constructor(connection, options = {}) {
    this.connection = connection;
    this.options = options;
    this.sessions = new Map();
    this.owner = null;
    this.initialized = false;
    this.closed = false;
  }

  initialize() {
    this.initialized = true;
    return {
      protocolVersion: 1,
      agentInfo: { name: 'forge-agent', title: 'Forge Browser Agent', version: require('../package.json').version },
      agentCapabilities: { loadSession: false, promptCapabilities: { image: false, audio: false, embeddedContext: false } },
      authMethods: [],
    };
  }

  async newSession({ cwd, mcpServers = [] }) {
    if (!this.initialized || this.closed) throw new Error('Initialize the connection first.');
    if (!path.isAbsolute(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error('cwd must be an existing absolute directory.');
    if (mcpServers.length) throw new Error('MCP servers are not supported.');
    const sessionId = randomUUID();
    const workspace = fs.realpathSync(cwd);
    if (this.options.sessionStateDir) {
      fs.mkdirSync(this.options.sessionStateDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(this.options.sessionStateDir, `${sessionId}.json`),
        JSON.stringify({ cwd: workspace, model: this.options.model || 'doubao' }), { mode: 0o600, flag: 'wx' });
    }
    this.sessions.set(sessionId, { id: sessionId, cwd: workspace, busy: false, cancelled: false, worker: null });
    return { sessionId };
  }

  restoreSession(sessionId) {
    if (!this.options.sessionStateDir || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(sessionId)) return null;
    try {
      const record = JSON.parse(fs.readFileSync(path.join(this.options.sessionStateDir, `${sessionId}.json`), 'utf8'));
      if (record.model !== (this.options.model || 'doubao') || !path.isAbsolute(record.cwd) ||
          !fs.statSync(record.cwd).isDirectory() || fs.realpathSync(record.cwd) !== record.cwd) return null;
      const session = { id: sessionId, cwd: record.cwd, busy: false, cancelled: false, worker: null, restarted: true };
      this.sessions.set(sessionId, session);
      return session;
    } catch { return null; }
  }

  update(session, update) {
    return this.connection.sessionUpdate({ sessionId: session.id, update });
  }

  message(session, text) {
    return this.update(session, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
  }

  async prompt({ sessionId, prompt }) {
    if (!this.initialized || this.closed) throw new Error('The agent connection is closed or not initialized. Start a new chat in AionUi.');
    const session = this.sessions.get(sessionId) || this.restoreSession(sessionId);
    if (!session) throw new Error('This session belongs to an earlier agent process and cannot be restored. Start a new chat in AionUi; retrying this chat keeps the stale session ID.');
    if (session.busy) throw new Error('This session already has an active prompt.');
    if (session.cancelled) throw new Error('This session was interrupted. Start a new chat.');
    if (this.options.sessionDir && this.owner && this.owner !== sessionId) throw new Error('Another conversation owns this connection’s explicit browser profile. Use a new agent connection.');
    if (!prompt.length || prompt.some(b => !['text', 'resource_link'].includes(b.type))) throw new Error('Only text and resource links are supported.');
    const text = prompt.map(b => b.type === 'text' ? b.text : `${b.name || 'Resource'}: ${b.uri}`).join('\n');
    if (text.trimStart().startsWith('/')) throw new Error('Terminal slash commands are not supported in ACP mode.');
    if (this.options.sessionDir) this.owner = sessionId;
    session.busy = true;
    try {
      if (session.restarted) {
        await this.message(session, 'Forge reconnected to this workspace after an agent restart. Earlier actions were not replayed. Conversation context has reset; include any details needed to continue.\n');
        session.restarted = false;
      }
      if (!session.worker) this.spawn(session);
      const result = await new Promise((resolve, reject) => {
        session.pending = { resolve, reject };
        session.worker.send({ type: 'prompt', text });
      });
      return { stopReason: session.cancelled ? 'cancelled' : result.stopReason || 'end_turn' };
    } catch (err) {
      if (session.cancelled) return { stopReason: 'cancelled' };
      await this.message(session, `Forge Agent stopped: ${err.message}\nStart a new chat after resolving the error.\n`);
      await this.stop(session);
      throw err;
    } finally {
      session.pending = null;
      session.busy = false;
    }
  }

  spawn(session) {
    const model = this.options.model || 'doubao';
    const sessionDir = this.options.sessionDir || path.join(os.homedir(), '.deepseek-agent', 'acp-profiles', model, session.id);
    const authFile = this.options.sessionDir ? '' : path.join(os.homedir(), '.deepseek-agent', 'acp-auth', `${model}.json`);
    process.stderr.write(`[forge-acp] server: spawning worker with model=${model}, sessionDir=${sessionDir}, authFile=${authFile}, workspace=${session.cwd}\n`);
    const worker = fork(this.options.workerFile || path.join(__dirname, 'acp-worker.js'), [], {
      cwd: session.cwd, detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: { ...process.env, FORGE_ACP_MODEL: model,
        FORGE_ACP_SESSION_DIR: sessionDir,
        FORGE_ACP_AUTH_FILE: authFile,
        FORGE_ACP_WORKSPACE: session.cwd },
    });
    session.worker = worker;
    worker.acpIdentity = identity(worker.pid);
    session.owned = new Map();
    session.monitor = setInterval(() => {
      if (identity(worker.pid)?.start !== worker.acpIdentity?.start) return;
      for (const p of descendants(worker.pid)) session.owned.set(`${p.pid}:${p.start}`, p);
    }, 500);
    session.monitor.unref();
    // Even accidental worker stdout must never contaminate the protocol stream.
    worker.stdout.on('data', chunk => process.stderr.write(chunk));
    worker.stderr.on('data', chunk => process.stderr.write(chunk));
    session.queue = Promise.resolve();
    worker.on('message', event => {
      session.queue = session.queue.then(() => this.event(session, event)).catch(err => session.pending?.reject(err));
    });
    worker.on('error', err => session.pending?.reject(err));
    worker.on('exit', () => {
      // Drain messages already delivered before reporting an unexpected exit.
      session.queue.then(() => {
        session.pending?.reject(new Error('Agent worker exited. No actions were replayed.'));
        return this.stop(session);
      }).catch(err => process.stderr.write(`Worker cleanup: ${err.message}\n`));
    });
  }

  async event(session, event) {
    if (session.cancelled || this.closed) return;
    if (event.type === 'update') await this.update(session, event.update);
    else if (event.type === 'message') await this.message(session, event.text);
    else if (event.type === 'permission') {
      const directory = this.options.permissionStateDir || path.join(os.homedir(), '.deepseek-agent', 'acp-permissions');
      const projectWrite = event.projectWrite === true;
      if (projectWrite && (session.allowFileWrites || hasProjectWrites(directory, session.cwd))) {
        if (session.worker?.connected) session.worker.send({ type: 'permission', id: event.id, allow: true });
        return;
      }
      // Do not block the event queue on UI input: cancellation must remain responsive.
      this.connection.requestPermission({
        sessionId: session.id, toolCall: event.toolCall,
        options: [{ optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
          ...(projectWrite ? [
            { optionId: 'project-chat', name: 'Allow project file writes for this chat', kind: 'allow_always' },
            { optionId: 'project-always', name: 'Allow always: file writes in this project', kind: 'allow_always' },
          ] : []),
          { optionId: 'deny', name: 'Decline', kind: 'reject_once' }],
      }).then(reply => {
        if (session.cancelled || this.closed || !session.worker?.connected) return;
        const selected = reply.outcome?.outcome === 'selected' ? reply.outcome.optionId : null;
        if (projectWrite && selected === 'project-always') saveProjectWrites(directory, session.cwd);
        if (projectWrite && ['project-chat', 'project-always'].includes(selected)) session.allowFileWrites = true;
        session.worker.send({ type: 'permission', id: event.id,
          allow: selected === 'allow' || (projectWrite && ['project-chat', 'project-always'].includes(selected)) });
      }).catch(() => {
        if (!session.cancelled && session.worker?.connected) session.worker.send({ type: 'permission', id: event.id, allow: false });
      });
    } else if (event.type === 'done') session.pending?.resolve(event);
    else if (event.type === 'error') session.pending?.reject(new Error(event.message));
  }

  async stop(session) {
    if (session.stopping) return session.stopping;
    session.cancelled = true;
    clearInterval(session.monitor);
    session.stopping = stopWorker(session.worker, [...(session.owned?.values() || [])]).finally(() => {
      session.pending?.resolve({ stopReason: 'cancelled' });
      if (this.owner === session.id) this.owner = null;
    });
    return session.stopping;
  }

  async cancel({ sessionId }) {
    const session = this.sessions.get(sessionId);
    if (session?.busy) await this.stop(session);
  }

  async close() {
    this.closed = true;
    await Promise.all([...this.sessions.values()].map(s => this.stop(s)));
  }
}
module.exports = AcpServer;
