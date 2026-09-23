'use strict';
const fs = require('fs');
const path = require('path');
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Read-only loopback viewer: token-protected, with no browser control endpoint.
async function serveMonitor(file) {
  const http = require('http');
  const token = require('crypto').randomBytes(24).toString('hex');
  const route = '/' + token;
  const server = http.createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (req.url !== route || !['GET', 'HEAD'].includes(req.method)) {
      res.writeHead(404); res.end('Not found'); return;
    }
    fs.readFile(file, (err, html) => {
      if (err) { res.writeHead(503); res.end('Monitor is not available yet. Refresh to retry.'); return; }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(req.method === 'HEAD' ? undefined : html);
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return { server, url: `http://127.0.0.1:${server.address().port}${route}` };
}
class BrowserMonitor {
  constructor(directory, model) {
    this.directory = directory;
    this.file = path.join(directory, 'index.html');
    this.model = model;
    this.events = [];
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.record('status', 'Starting browser');
  }
  async serve() {
    const { server, url } = await serveMonitor(this.file);
    this.server = server;
    this.server.unref();
    this.url = url;
    return url;
  }
  record(type, text) {
    const event = { time: new Date().toISOString(), type, text: String(text ?? '') };
    try {
      fs.appendFileSync(path.join(this.directory, 'events.jsonl'), JSON.stringify(event) + '\n', { mode: 0o600 });
      this.events.push(event);
      this.events = this.events.slice(-30);
      this.render();
    } catch (err) { process.stderr.write(`Browser monitor: ${err.message}\n`); }
  }
  render() {
    const { parseResponse } = require('./parser');
    let answer = null;
    for (const event of [...this.events].reverse()) {
      if (event.type !== 'output') continue;
      const parsed = parseResponse(event.text);
      const text = parsed.type === 'tool_call'
        ? (parsed.name === 'show_info' ? parsed.args?.content : '')
        : event.text.replace(/\bTASK_COMPLETE\b/g, '').trim();
      if (typeof text === 'string' && text.trim()) { answer = { ...event, text }; break; }
    }
    const html = `<!doctype html><meta charset="utf-8">${this.stopped ? '' : '<meta http-equiv="refresh" content="3">'}
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Forge browser monitor</title><style>body{font:16px system-ui;max-width:1000px;margin:24px auto;padding:0 20px;background:#171a21;color:#eee}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#252a35;padding:16px;line-height:1.6}img{max-width:100%}small{color:#aab}details{margin:16px 0}summary{cursor:pointer;padding:12px;background:#252a35}.notice{padding:16px;border:1px solid #b99b60;border-radius:8px;color:#f3dba5}</style>
<h1>${escape(this.model)} browser monitor</h1>
${this.stopped ? '<p class="notice"><strong>Stopped — saved session</strong><br>This session is closed. The answer below is saved history, not a live feed. For a new AionUI chat, use the monitor link shown in that chat.</p>' : '<p>Live · Updates every 3 seconds</p>'}
<h2>Latest answer</h2>
${answer ? `<p><small>${escape(answer.time)}</small></p><pre id="latest-answer">${escape(answer.text)}</pre>` : '<p>No answer received yet. Check the screenshot or recent events below.</p>'}
<details><summary>Browser screenshot${this.stopped ? ' (last saved frame)' : ''}</summary>
${this.screenshot ? `<img alt="Latest browser screenshot" src="data:image/png;base64,${this.screenshot}">` : '<p>Waiting for first screenshot…</p>'}</details>
<h2>Recent browser events</h2><p>Newest first. Expand an event to see its full input or output. Full history is saved in events.jsonl.</p>
${[...this.events].reverse().map(e => `<details><summary>${escape(e.type)} · <small>${escape(e.time)}</small></summary><pre>${escape(e.text)}</pre></details>`).join('')}`;
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, html, { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
  start(page) {
    this.page = page;
    this.timer = setInterval(() => this.capture(), 2000);
    this.timer.unref();
    this.capture();
  }
  async capture() {
    if (this.capturing || this.stopped) return;
    this.capturing = true;
    try {
      const buffer = await this.page.screenshot({ timeout: 1500 });
      this.screenshot = buffer.toString('base64');
      this.render();
    } catch { /* Navigation and shutdown can interrupt screenshots. */ }
    finally { this.capturing = false; }
  }
  stop() {
    clearInterval(this.timer);
    this.server?.close();
    this.stopped = true;
    this.record('status', 'Browser closed');
  }
}
module.exports = { BrowserMonitor, serveMonitor };
if (require.main === module) {
  const file = path.resolve(process.argv[2] || '');
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    console.error('Usage: node src/browser-monitor.js /path/to/monitor/index.html');
    process.exitCode = 1;
  } else {
    serveMonitor(file).then(({ url }) => console.log(url)).catch(err => {
      console.error(err.message); process.exitCode = 1;
    });
  }
}
