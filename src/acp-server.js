// src/acp-server.js — ACP (Agent Communication Protocol) stdio server
'use strict';

const readline = require('readline');
const logger   = require('./logger');

const PROTOCOL_VERSION = '0.12.1';

class AcpServer {
  constructor(agent) {
    this.agent    = agent;
    this.sessions = new Map();
    this._rl      = null;
    this._started = false;
  }

  start() {
    if (this._started) return;
    this._started = true;

    this._rl = readline.createInterface({
      input  : process.stdin,
      output : process.stdout,
      crlfDelay: Infinity,
    });

    this._rl.on('line', (line) => {
      this._handleLine(line).catch(err => {
        this._send({ jsonrpc: '2.0', error: { code: -32603, message: err.message } });
      });
    });

    this._rl.on('close', () => {
      this._shutdown();
    });

    process.stdout.write = this._passthroughWrite();
  }

  _passthroughWrite() {
    const original = process.stdout.write.bind(process.stdout);
    return (chunk, ...args) => {
      const lines = String(chunk).split('\n').filter(l => l.trim());
      for (const line of lines) {
        if (line.startsWith('{') && line.includes('"jsonrpc"')) continue;
        this._send({ jsonrpc: '2.0', method: 'Message', params: { content: line, role: 'log' } });
      }
      return original(chunk, ...args);
    };
  }

  _send(msg) {
    process.stdout.write(JSON.stringify(msg) + '\n');
  }

  _sendResult(id, result) {
    this._send({ jsonrpc: '2.0', id, result });
  }

  _sendError(id, code, message) {
    this._send({ jsonrpc: '2.0', id, error: { code, message } });
  }

  _sendNotification(method, params) {
    this._send({ jsonrpc: '2.0', method, params });
  }

  async _handleLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }

    const { id, method, params } = msg;

    switch (method) {
      case 'initialize':
        this._sendResult(id, {
          protocolVersion: PROTOCOL_VERSION,
          agentInfo: {
            name   : 'forge-agent',
            version: require('../package.json').version,
          },
          capabilities: {
            streaming   : true,
            toolApproval: true,
            sessionLoad : true,
          },
        });
        break;

      case 'new_session':
        await this._newSession(id, params);
        break;

      case 'load_session':
        await this._loadSession(id, params);
        break;

      case 'prompt':
        await this._handlePrompt(id, params);
        break;

      case 'cancel':
        this._sendNotification('cancelled', { sessionId: params?.sessionId });
        break;

      default:
        if (id) this._sendError(id, -32601, `Unknown method: ${method}`);
    }
  }

  async _newSession(id, params) {
    const sessionId = `session-${Date.now()}`;
    const cwd = params?.cwd || process.cwd();

    this.sessions.set(sessionId, {
      id: sessionId,
      cwd,
      status: 'idle',
      lastPrompt  : null,
      lastOutput  : null,
    });

    this._sendResult(id, { sessionId, status: 'idle' });
  }

  async _loadSession(id, params) {
    const sessionId = params?.sessionId;
    if (!sessionId || !this.sessions.has(sessionId)) {
      this._sendError(id, -32602, `Session not found: ${sessionId}`);
      return;
    }

    const session = this.sessions.get(sessionId);
    this._sendResult(id, { sessionId, status: session.status });
  }

  async _handlePrompt(id, params) {
    const sessionId = params?.sessionId;
    const text      = params?.text;

    if (!sessionId || !this.sessions.has(sessionId)) {
      this._sendError(id, -32602, `Session not found: ${sessionId}`);
      return;
    }

    const session = this.sessions.get(sessionId);
    if (session.status === 'running') {
      this._sendError(id, -32602, 'Session is busy');
      return;
    }

    session.status     = 'running';
    session.lastPrompt = text;

    this._sendResult(id, { sessionId, status: 'running' });

    try {
      if (!this.agent.browser.page) {
        await this.agent.init();
      }

      const result = await this.agent.run(text);

      session.status     = 'idle';
      session.lastOutput = result;

      this._sendNotification('Message', {
        sessionId,
        content: result || 'Task completed.',
        role   : 'assistant',
      });

      this._sendNotification('session/end', { sessionId, status: 'idle' });
    } catch (err) {
      session.status = 'interrupted';
      this._sendNotification('Error', {
        sessionId,
        message: err.message,
      });
      this._sendNotification('session/end', { sessionId, status: 'interrupted' });
    }
  }

  sendToolCallStart(toolName, args) {
    this._sendNotification('ToolCallStart', { tool: toolName, arguments: args });
  }

  sendToolCallProgress(toolName, result) {
    this._sendNotification('ToolCallProgress', { tool: toolName, result });
  }

  sendToolCallEnd(toolName) {
    this._sendNotification('ToolCallEnd', { tool: toolName });
  }

  requestPermission(toolName, args) {
    return new Promise(resolve => {
      const reqId = `perm-${Date.now()}`;
      this._sendNotification('PermissionRequest', { id: reqId, tool: toolName, arguments: args });

      const handler = (line) => {
        try {
          const msg = JSON.parse(line);
          if (msg?.method === 'PermissionResponse' && msg?.params?.id === reqId) {
            this._rl.removeListener('line', handler);
            resolve(msg.params.allow === true);
          }
        } catch {}
      };

      this._rl.on('line', handler);
    });
  }

  _shutdown() {
    this._started = false;
    for (const [, session] of this.sessions) {
      if (session.status === 'running') {
        session.status = 'interrupted';
      }
    }
    this.sessions.clear();
  }
}

module.exports = AcpServer;
