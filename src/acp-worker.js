'use strict';
// Internal IPC worker. stdin is never used for terminal prompts.
function main() {
  const fs = require('fs');
  const path = require('path');
  const { randomUUID } = require('crypto');
  const send = event => { if (process.connected) process.send(event); };
  process.stdout.write = process.stderr.write.bind(process.stderr);
  const config = require('./config');
  Object.assign(config, {
    MODEL: process.env.FORGE_ACP_MODEL,
    WORKING_DIR: process.env.FORGE_ACP_WORKSPACE,
    SESSION_DIR: process.env.FORGE_ACP_SESSION_DIR,
    HEADLESS: false, NO_TUI: true, NO_INTERACTIVE: true, STRICT_SANDBOX: true,
    OUTPUT_FILE: null, DISABLE_SPONSOR_NUDGE: true,
  });
  const { executeTool } = require('./tools');
  const { isReadOnly } = require('./permission-store');
  const approvals = new Map();
  let agent, stopping = false, busy = false;

  function content(text) { return { type: 'content', content: { type: 'text', text: String(text) } }; }
  function update(value) { send({ type: 'update', update: value }); }
  function toolKind(name) {
    if (/command|process|install|test/.test(name)) return 'execute';
    if (/delete/.test(name)) return 'delete';
    if (/write|replace|append|patch|create/.test(name)) return 'edit';
    if (/search|find|list/.test(name)) return 'search';
    return isReadOnly(name) ? 'read' : 'other';
  }
  function safeFile(file) {
    if (typeof file !== 'string') return null;
    const target = path.resolve(config.WORKING_DIR, file);
    // Resolve existing ancestors as well, so missing files beneath symlinks cannot escape.
    let ancestor = target;
    while (true) {
      try { fs.lstatSync(ancestor); break; }
      catch (err) {
        if (err.code !== 'ENOENT' || path.dirname(ancestor) === ancestor) throw err;
        ancestor = path.dirname(ancestor);
      }
    }
    const real = path.resolve(fs.realpathSync(ancestor), path.relative(ancestor, target));
    const relative = path.relative(config.WORKING_DIR, real);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Path is outside the selected workspace.');
    return target;
  }
  async function runTool(name, args) {
    const id = randomUUID();
    const kind = toolKind(name);
    const toolCall = { toolCallId: id, title: `${name}: ${args.path || args.command || ''}`.slice(0, 300), kind, rawInput: args, status: 'pending' };
    update({ sessionUpdate: 'tool_call', ...toolCall });
    let target, before;
    try {
      // Inspect path parameters before reading a diff or invoking a tool.
      for (const key of ['path', 'filePath', 'directory', 'cwd', 'source', 'destination']) {
        if (args[key]) safeFile(args[key]);
      }
      if (Array.isArray(args.files)) for (const file of args.files) if (file.path) safeFile(file.path);
      target = args.path ? safeFile(args.path) : null;
      if (target && kind === 'edit') {
        try { if (fs.statSync(target).size <= 128000) before = fs.readFileSync(target, 'utf8'); } catch (err) { if (err.code === 'ENOENT') before = null; }
      }
      // Tests execute code, despite being classified as read-only by the terminal CLI.
      if (!isReadOnly(name) || kind === 'execute') {
        const allow = await new Promise(resolve => {
          approvals.set(id, resolve);
          send({ type: 'permission', id, toolCall });
        });
        if (!allow || stopping) {
          update({ sessionUpdate: 'tool_call_update', toolCallId: id, status: 'failed', content: [content('Declined; tool was not executed.')] });
          // End the turn rather than prompting the model to seek a workaround.
          const err = new Error('Tool permission declined.');
          err.acpDenied = true;
          throw err;
        }
      }
      if (stopping) throw new Error('Session cancelled.');
      update({ sessionUpdate: 'tool_call_update', toolCallId: id, status: 'in_progress' });
      const result = await executeTool(name, args);
      const output = [content(typeof result === 'string' ? result : JSON.stringify(result))];
      if (target && kind === 'edit' && before !== undefined) {
        try { if (fs.statSync(target).size <= 128000) output.push({ type: 'diff', path: target, oldText: before, newText: fs.readFileSync(target, 'utf8') }); } catch {}
      }
      update({ sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed', content: output });
      return result;
    } catch (err) {
      if (!err.acpDenied) update({ sessionUpdate: 'tool_call_update', toolCallId: id, status: 'failed', content: [content(err.message)] });
      throw err;
    }
  }

  async function waitForInput() {
    const until = Date.now() + 180000;
    while (!stopping && Date.now() < until) {
      if (await agent.browser.adapter.isReady()) return;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    throw new Error('Browser input is not ready. Log in in the browser and start a new chat.');
  }

  async function prompt(text) {
    if (busy || stopping) return;
    busy = true;
    try {
      if (!agent) {
        const Agent = require('./agent');
        agent = new Agent({ executeTool: runTool });
        agent.browser._waitForEnter = waitForInput;
        agent.browser._printLoginBanner = () => send({ type: 'message', text: 'Please log in in the browser window. No terminal input is needed.\n' });
        send({ type: 'message', text: `Opening ${config.MODEL}. Log in in the browser window if prompted; this GUI profile has its own saved login.\n` });
        await agent.init();
        await waitForInput();
      }
      const result = await agent.run(text);
      if (result) send({ type: 'message', text: String(result) });
      send({ type: 'done', stopReason: 'end_turn' });
    } catch (err) {
      if (err.acpDenied) {
        send({ type: 'message', text: 'Permission declined. The turn stopped without executing that tool.\n' });
        send({ type: 'done', stopReason: 'end_turn' });
      } else send({ type: 'error', message: err.message });
    } finally { busy = false; }
  }

  async function shutdown() {
    if (stopping) return;
    stopping = true;
    for (const resolve of approvals.values()) resolve(false);
    approvals.clear();
    try { await agent?.shutdown(); } finally { process.exit(0); }
  }
  process.on('message', event => {
    if (event.type === 'prompt') prompt(event.text);
    if (event.type === 'permission') {
      const resolve = approvals.get(event.id);
      approvals.delete(event.id);
      resolve?.(event.allow === true);
    }
  });
  process.on('disconnect', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
if (require.main === module) main();
module.exports = { main };
