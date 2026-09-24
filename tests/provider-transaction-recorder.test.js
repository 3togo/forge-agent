'use strict';

const { EventEmitter } = require('events');
const {
  ProviderTransactionRecorder,
  sanitizeUrl,
  sanitizePostData,
} = require('../src/provider-transaction-recorder');

test('redacts credential-like URL and JSON fields while retaining debug context', () => {
  expect(sanitizeUrl('https://yuanbao.tencent.com/api?sessionId=abc&conversation=42#secret'))
    .toContain('sessionId=%5BREDACTED%5D');
  expect(sanitizeUrl('https://yuanbao.tencent.com/api?sessionId=abc&conversation=42#secret'))
    .toContain('conversation=42');
  expect(sanitizePostData(JSON.stringify({ prompt: 'hello', accessToken: 'abc', nested: { cookie: 'x' } })))
    .toBe('{"prompt":"hello","accessToken":"[REDACTED]","nested":{"cookie":"[REDACTED]"}}');
});

test('correlates provider requests with the active logical call and ignores static assets', () => {
  const page = new EventEmitter();
  const events = [];
  const recorder = new ProviderTransactionRecorder(event => events.push(event), () => 'call-7');
  recorder.start(page);

  const request = {
    resourceType: () => 'fetch', method: () => 'POST',
    url: () => 'https://yuanbao.tencent.com/api/chat?token=unsafe',
    postData: () => JSON.stringify({ prompt: 'debug me', authorization: 'unsafe' }),
  };
  page.emit('request', request);
  page.emit('response', { request: () => request, status: () => 200 });
  page.emit('request', { resourceType: () => 'image' });

  expect(events).toHaveLength(2);
  expect(events[0]).toMatchObject({ kind: 'http.request', providerCallId: 'call-7', method: 'POST' });
  expect(events[0].url).not.toContain('unsafe');
  expect(events[0].requestBody).toContain('debug me');
  expect(events[0].requestBody).not.toContain('unsafe');
  expect(events[1]).toMatchObject({ kind: 'http.response', status: 200, id: events[0].id });

  recorder.stop();
  page.emit('pageerror', new Error('after stop'));
  expect(events).toHaveLength(2);
});
