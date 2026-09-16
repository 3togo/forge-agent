#!/usr/bin/env node
// test-merge.js — 验证 DuoBaoAgent → forge-agent-omar 合并的所有组件
'use strict';

const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const crypto = require('crypto');

let passed = 0;
let failed = 0;

function ok(name) {
  passed++;
  console.log('  \x1b[32m✓\x1b[0m ' + name);
}

function fail(name, err) {
  failed++;
  console.log('  \x1b[31m✗\x1b[0m ' + name + ': ' + err.message);
}

function section(title) {
  console.log('\n\x1b[1m' + title + '\x1b[0m');
}

// ─── 1. 豆包适配器 ───────────────────────────────────────────────────────────

section('1. Doubao Adapter');

try {
  const DoubaoAdapter = require('./src/adapters/doubao-adapter');
  const BaseAdapter   = require('./src/adapters/base-adapter');

  const mockPage = { isClosed: () => false };
  const mockConfig = {};
  const adapter = new DoubaoAdapter(mockPage, mockConfig);

  if (adapter instanceof BaseAdapter) ok('继承 BaseAdapter');
  else fail('继承 BaseAdapter', new Error('not instance of BaseAdapter'));

  if (adapter._getInputSelectors().length >= 4) ok('输入选择器 >= 4');
  else fail('输入选择器 >= 4', new Error('got ' + adapter._getInputSelectors().length));

  if (adapter._getSendSelectors().length >= 3) ok('发送选择器 >= 3');
  else fail('发送选择器 >= 3', new Error('got ' + adapter._getSendSelectors().length));

  if (adapter._getStopSelectors().length >= 3) ok('停止选择器 >= 3');
  else fail('停止选择器 >= 3', new Error('got ' + adapter._getStopSelectors().length));

  if (adapter._getNewChatSelectors().length >= 3) ok('新对话选择器 >= 3');
  else fail('新对话选择器 >= 3', new Error('got ' + adapter._getNewChatSelectors().length));

  if (adapter._getResponseSelectors().length >= 3) ok('响应选择器 >= 3');
  else fail('响应选择器 >= 3', new Error('got ' + adapter._getResponseSelectors().length));

  if (adapter.getModelUrl() === 'https://www.doubao.com/chat') ok('getModelUrl 正确');
  else fail('getModelUrl 正确', new Error('got ' + adapter.getModelUrl()));

  const inputs = adapter._getInputSelectors();
  if (inputs.some(s => s.includes('发消息'))) ok('包含中文输入选择器');
  else fail('包含中文输入选择器', new Error('not found'));

  const newChat = adapter._getNewChatSelectors();
  if (newChat.some(s => s.includes('新对话'))) ok('包含中文新对话选择器');
  else fail('包含中文新对话选择器', new Error('not found'));

  const cleaned = adapter._cleanText('Assistant: hello');
  if (cleaned === 'hello') ok('_cleanText 去除前缀');
  else fail('_cleanText 去除前缀', new Error('got "' + cleaned + '"'));

  const cleaned2 = adapter._cleanText('Doubao: test output');
  if (cleaned2 === 'test output') ok('_cleanText 去除 Doubao 前缀');
  else fail('_cleanText 去除 Doubao 前缀', new Error('got "' + cleaned2 + '"'));

} catch (err) {
  fail('Doubao Adapter 加载', err);
}

// ─── 2. 适配器工厂 ───────────────────────────────────────────────────────────

section('2. Adapter Factory');

try {
  const { getAdapter, getModelUrl, getModelDisplayName, SUPPORTED_MODELS } = require('./src/adapter-factory');
  const DoubaoAdapter = require('./src/adapters/doubao-adapter');

  const mockPage = { isClosed: () => false };
  const mockConfig = {};

  if (SUPPORTED_MODELS.includes('doubao')) ok('SUPPORTED_MODELS 包含 doubao');
  else fail('SUPPORTED_MODELS 包含 doubao', new Error('not found'));

  if (SUPPORTED_MODELS.length === 3) ok('SUPPORTED_MODELS 有 3 个模型');
  else fail('SUPPORTED_MODELS 有 3 个模型', new Error('got ' + SUPPORTED_MODELS.length));

  const d = getAdapter('doubao', mockPage, mockConfig);
  if (d instanceof DoubaoAdapter) ok('getAdapter("doubao") 返回 DoubaoAdapter');
  else fail('getAdapter("doubao")', new Error('got ' + d.constructor.name));

  const d2 = getAdapter('豆包', mockPage, mockConfig);
  if (d2 instanceof DoubaoAdapter) ok('getAdapter("豆包") 返回 DoubaoAdapter');
  else fail('getAdapter("豆包")', new Error('got ' + d2.constructor.name));

  if (getModelUrl('doubao') === 'https://www.doubao.com/chat') ok('getModelUrl("doubao") 正确');
  else fail('getModelUrl("doubao")', new Error('got ' + getModelUrl('doubao')));

  if (getModelDisplayName('doubao') === 'Doubao (豆包)') ok('getModelDisplayName("doubao") 正确');
  else fail('getModelDisplayName("doubao")', new Error('got ' + getModelDisplayName('doubao')));

} catch (err) {
  fail('Adapter Factory 加载', err);
}

// ─── 3. ACP 服务器 ───────────────────────────────────────────────────────────

section('3. ACP Server');

try {
  const AcpServer = require('./src/acp-server');

  const mockAgent = { browser: { page: null }, init: () => Promise.resolve(), run: () => Promise.resolve('done') };
  const acp = new AcpServer(mockAgent);

  if (typeof acp.start === 'function') ok('AcpServer.start 方法存在');
  else fail('AcpServer.start', new Error('not a function'));

  if (typeof acp.sendToolCallStart === 'function') ok('sendToolCallStart 方法存在');
  else fail('sendToolCallStart', new Error('not a function'));

  if (typeof acp.sendToolCallProgress === 'function') ok('sendToolCallProgress 方法存在');
  else fail('sendToolCallProgress', new Error('not a function'));

  if (typeof acp.sendToolCallEnd === 'function') ok('sendToolCallEnd 方法存在');
  else fail('sendToolCallEnd', new Error('not a function'));

  if (typeof acp.requestPermission === 'function') ok('requestPermission 方法存在');
  else fail('requestPermission', new Error('not a function'));

  if (acp.sessions instanceof Map) ok('sessions 是 Map');
  else fail('sessions 是 Map', new Error('got ' + acp.sessions.constructor.name));

} catch (err) {
  fail('ACP Server 加载', err);
}

// ─── 4. 会话存储 ─────────────────────────────────────────────────────────────

section('4. Session Store');

const TEST_STORE_DIR = path.join(os.tmpdir(), 'forge-merge-test-' + Date.now());

try {
  const SessionStore = require('./src/session-store');

  const store = SessionStore.create('merge-test-1', '/tmp', TEST_STORE_DIR);

  const data = store.load();
  if (data !== null) ok('create + load 成功');
  else fail('create + load', new Error('load returned null'));

  if (data.status === 'idle') ok('初始状态为 idle');
  else fail('初始状态为 idle', new Error('got ' + data.status));

  // 幂等重传：不同 prompt 应返回 null
  const replay1 = store.isIdempotentReplay('some prompt');
  if (replay1 === null) ok('不同 prompt 的幂等检测返回 null');
  else fail('不同 prompt 的幂等检测', new Error('got ' + replay1));

  // 记录 prompt
  store.recordPrompt('my task');
  const data2 = store.load();
  if (data2.status === 'running') ok('recordPrompt 后状态为 running');
  else fail('recordPrompt 后状态', new Error('got ' + data2.status));

  if (data2.lastPromptHash !== null) ok('recordPrompt 设置了 hash');
  else fail('recordPrompt 设置 hash', new Error('hash is null'));

  // 记录输出
  store.recordOutput('task completed');
  const data3 = store.load();
  if (data3.status === 'idle') ok('recordOutput 后状态为 idle');
  else fail('recordOutput 后状态', new Error('got ' + data3.status));

  if (data3.lastOutput === 'task completed') ok('recordOutput 保存了输出');
  else fail('recordOutput 保存输出', new Error('got ' + data3.lastOutput));

  // 幂等重传：相同 prompt + idle 状态应返回缓存输出
  const replay2 = store.isIdempotentReplay('my task');
  if (replay2 === 'task completed') ok('相同 prompt 的幂等检测返回缓存输出');
  else fail('相同 prompt 的幂等检测', new Error('got ' + replay2));

  // 标记中断
  store.recordPrompt('another task');
  store.markInterrupted();
  const data4 = store.load();
  if (data4.status === 'interrupted') ok('markInterrupted 设置了状态');
  else fail('markInterrupted', new Error('got ' + data4.status));

  // 中断状态下幂等检测应返回 null
  const replay3 = store.isIdempotentReplay('another task');
  if (replay3 === null) ok('interrupted 状态下幂等检测返回 null');
  else fail('interrupted 状态下幂等检测', new Error('got ' + replay3));

  // 文件锁
  const store2 = SessionStore.create('merge-test-2', '/tmp', TEST_STORE_DIR);
  if (store2.acquire() === true) ok('acquire 锁成功');
  else fail('acquire 锁', new Error('returned false'));

  const store3 = new SessionStore('merge-test-2', TEST_STORE_DIR);
  let lockError = null;
  try {
    store3.acquire();
  } catch (e) {
    lockError = e;
  }
  if (lockError && lockError.message === 'SESSION_BUSY') ok('重复 acquire 抛出 SESSION_BUSY');
  else fail('重复 acquire', new Error('expected SESSION_BUSY, got ' + (lockError ? lockError.message : 'no error')));

  store2.release();
  ok('release 锁成功');

  // 原子写入验证：确认 .tmp 文件不存在
  const tmpFile = store.filePath + '.tmp';
  if (!fs.existsSync(tmpFile)) ok('原子写入：无残留 .tmp 文件');
  else fail('原子写入', new Error('.tmp file exists'));

  // 清理
  try { fs.unlinkSync(store.filePath); } catch {}
  try { fs.unlinkSync(store2.filePath); } catch {}

} catch (err) {
  fail('Session Store 加载', err);
}

// ─── 5. CLI --acp 参数 ───────────────────────────────────────────────────────

section('5. CLI --acp Flag');

try {
  const src = fs.readFileSync(path.join(__dirname, 'src/index.js'), 'utf8');

  if (src.includes('--acp')) ok('index.js 包含 --acp 参数');
  else fail('index.js 包含 --acp', new Error('not found'));

  if (src.includes('AcpServer')) ok('index.js 引用 AcpServer');
  else fail('index.js 引用 AcpServer', new Error('not found'));

  if (src.includes("require('./acp-server')")) ok('index.js require acp-server');
  else fail('index.js require acp-server', new Error('not found'));

} catch (err) {
  fail('CLI --acp 参数', err);
}

// ─── 6. 文件存在性 ───────────────────────────────────────────────────────────

section('6. File Existence');

const expectedFiles = [
  'src/adapters/doubao-adapter.js',
  'src/acp-server.js',
  'src/session-store.js',
  'tests/doubao-adapter.test.js',
  'tests/session-store.test.js',
];

for (const f of expectedFiles) {
  if (fs.existsSync(path.join(__dirname, f))) ok(f);
  else fail(f, new Error('file not found'));
}

// ─── 结果 ─────────────────────────────────────────────────────────────────────

console.log('\n' + '═'.repeat(50));
console.log('  结果: ' + passed + ' 通过, ' + failed + ' 失败');
console.log('═'.repeat(50));

process.exit(failed > 0 ? 1 : 0);
