'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { BrowserMonitor } = require('../src/browser-monitor');
let directory;
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));
test('monitor retains exact I/O, escapes HTML, and captures without browser interaction', async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-monitor-'));
  const monitor = new BrowserMonitor(directory, 'yuanbao');
  monitor.record('input', '<script>alert("x")</script>');
  const page = { screenshot: jest.fn().mockResolvedValue(Buffer.from('image')) };
  monitor.page = page;
  await monitor.capture();
  monitor.record('output', 'reply');
  monitor.stop();
  const html = fs.readFileSync(monitor.file, 'utf8');
  expect(html).toContain('&lt;script&gt;');
  expect(html).not.toContain('<script>');
  expect(html).toContain('data:image/png;base64,');
  expect(html).toContain('Stopped');
  expect(html).not.toContain('http-equiv="refresh"');
  const events = fs.readFileSync(path.join(directory, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  expect(events[1].text).toBe('<script>alert("x")</script>');
  expect(fs.statSync(monitor.file).mode & 0o777).toBe(0o600);
});

test('overlapping captures are skipped and screenshot errors allow a later capture', async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-monitor-'));
  const monitor = new BrowserMonitor(directory, 'yuanbao');
  let rejectCapture;
  monitor.page = { screenshot: jest.fn().mockImplementationOnce(() => new Promise((resolve, reject) => { rejectCapture = reject; })).mockResolvedValue(Buffer.from('later')) };
  const first = monitor.capture();
  await monitor.capture();
  expect(monitor.page.screenshot).toHaveBeenCalledTimes(1);
  rejectCapture(new Error('navigation'));
  await first;
  await monitor.capture();
  expect(monitor.page.screenshot).toHaveBeenCalledTimes(2);
  expect(fs.readFileSync(monitor.file, 'utf8')).toContain(Buffer.from('later').toString('base64'));
  monitor.stop();
  await monitor.capture();
  expect(monitor.page.screenshot).toHaveBeenCalledTimes(2);
});

test('display is bounded while the event log retains all input and output', () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-monitor-'));
  const monitor = new BrowserMonitor(directory, 'yuanbao');
  for (let i = 0; i < 40; i++) monitor.record('output', `reply-${i}`);
  expect(monitor.events).toHaveLength(30);
  expect(monitor.events[0].text).toBe('reply-10');
  expect(fs.readFileSync(path.join(directory, 'events.jsonl'), 'utf8').trim().split('\n')).toHaveLength(41);
  monitor.stop();
});

test('loopback viewer serves only its token URL and closes with the monitor', async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-monitor-'));
  const monitor = new BrowserMonitor(directory, 'yuanbao');
  const url = await monitor.serve();
  try {
    expect(monitor.server.address().address).toBe('127.0.0.1');
    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toContain('yuanbao browser monitor');
    expect((await fetch(new URL('/', url))).status).toBe(404);
    expect((await fetch(url, { method: 'POST' })).status).toBe(404);
    monitor.record('output', 'a new answer');
    expect(await (await fetch(url)).text()).toContain('a new answer');
  } finally { monitor.stop(); }
  expect(monitor.server.listening).toBe(false);
});

test('saved preview surfaces show_info answer above collapsed screenshots and raw prompts', () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-monitor-'));
  const monitor = new BrowserMonitor(directory, 'yuanbao');
  monitor.record('input', 'very long raw system prompt');
  monitor.record('output', '```tool_call\n{"name":"show_info","args":{"content":"Hello <reader>"}}\n```');
  monitor.record('output', 'TASK_COMPLETE');
  monitor.stop();
  const html = fs.readFileSync(monitor.file, 'utf8');
  expect(html).toContain('id="latest-answer">Hello &lt;reader&gt;');
  expect(html.indexOf('id="latest-answer"')).toBeLessThan(html.indexOf('Browser screenshot'));
  expect(html).toContain('Stopped — saved session');
  expect(html).toContain('<details><summary>input');
});
