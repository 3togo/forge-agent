'use strict';

const { randomUUID } = require('crypto');

const CAPTURED_RESOURCE_TYPES = new Set(['document', 'xhr', 'fetch', 'websocket', 'eventsource']);
const SECRET_KEY = /authorization|cookie|token|secret|session|credential|password|ticket|signature|(?:^|[-_])sig(?:$|[-_])/i;

function truncate(value, limit = 4000) {
  const text = String(value ?? '');
  return text.length <= limit ? text : `${text.slice(0, limit)}…[${text.length - limit} more characters]`;
}

function redactValue(value) {
  if (Array.isArray(value)) return value.map(redactValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    SECRET_KEY.test(key) ? '[REDACTED]' : redactValue(item),
  ]));
}

function sanitizeUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    for (const key of [...url.searchParams.keys()]) {
      if (SECRET_KEY.test(key)) url.searchParams.set(key, '[REDACTED]');
    }
    url.hash = '';
    return truncate(url.toString(), 2000);
  } catch {
    return truncate(rawUrl, 2000);
  }
}

function sanitizePostData(data) {
  if (!data) return undefined;
  try { return truncate(JSON.stringify(redactValue(JSON.parse(data)))); }
  catch { return truncate(data); }
}

/**
 * Observes the provider page without controlling it. Network activity is sent
 * to a dedicated diagnostic stream and never enters the model reply stream.
 */
class ProviderTransactionRecorder {
  constructor(record, getCallId = () => null) {
    this.record = record;
    this.getCallId = getCallId;
    this.requests = new WeakMap();
    this.listeners = [];
  }

  start(page) {
    if (!page || typeof page.on !== 'function') return;
    this.page = page;
    this._listen('request', request => this._requestStarted(request));
    this._listen('response', response => this._requestFinished(response));
    this._listen('requestfailed', request => this._requestFailed(request));
    this._listen('pageerror', error => this._record({ kind: 'page.error', error: truncate(error?.message || error) }));
    this._listen('console', message => {
      const type = message.type?.();
      if (type === 'error' || type === 'warning') {
        this._record({ kind: `console.${type}`, text: truncate(message.text?.() || '') });
      }
    });
  }

  stop() {
    if (this.page && typeof this.page.removeListener === 'function') {
      for (const [event, handler] of this.listeners) this.page.removeListener(event, handler);
    }
    this.listeners = [];
    this.page = null;
  }

  _listen(event, handler) {
    this.page.on(event, handler);
    this.listeners.push([event, handler]);
  }

  _shouldCapture(request) {
    try { return CAPTURED_RESOURCE_TYPES.has(request.resourceType()); }
    catch { return true; }
  }

  _requestStarted(request) {
    if (!this._shouldCapture(request)) return;
    const transaction = {
      id: randomUUID(),
      startedAt: Date.now(),
      method: request.method?.() || 'GET',
      resourceType: request.resourceType?.() || 'unknown',
      url: sanitizeUrl(request.url?.() || ''),
    };
    this.requests.set(request, transaction);
    this._record({
      kind: 'http.request',
      ...transaction,
      startedAt: undefined,
      requestBody: sanitizePostData(request.postData?.()),
    });
  }

  _requestFinished(response) {
    const request = response.request?.();
    const transaction = request && this.requests.get(request);
    if (!transaction) return;
    this._record({
      kind: 'http.response',
      id: transaction.id,
      method: transaction.method,
      resourceType: transaction.resourceType,
      url: transaction.url,
      status: response.status?.(),
      durationMs: Date.now() - transaction.startedAt,
    });
  }

  _requestFailed(request) {
    const transaction = this.requests.get(request);
    if (!transaction) return;
    this._record({
      kind: 'http.failed',
      id: transaction.id,
      method: transaction.method,
      resourceType: transaction.resourceType,
      url: transaction.url,
      durationMs: Date.now() - transaction.startedAt,
      error: truncate(request.failure?.()?.errorText || 'Request failed'),
    });
  }

  _record(event) {
    this.record({
      time: new Date().toISOString(),
      providerCallId: this.getCallId() || null,
      ...Object.fromEntries(Object.entries(event).filter(([, value]) => value !== undefined)),
    });
  }
}

module.exports = {
  ProviderTransactionRecorder,
  sanitizeUrl,
  sanitizePostData,
};
