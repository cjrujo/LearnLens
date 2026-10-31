import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns/promises';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { AppError, DEFAULT_PRIMARY_TIMEOUT_SECONDS, primaryTimeoutSeconds, generateText, providerRequest, discoverModels } from '../lib/provider.mjs';

const SECRET = 'private-key-and-lesson-fixture';
const REQUEST_ID = 'req_0123456789abcdef0123456789abcdef';
const prompt = { instructions: 'Fixture instructions', text: SECRET, maxTokens: 6000 };
const envelope = api => api === 'chat' ? { choices: [{ finish_reason: 'stop', message: { content: ' complete ' } }] } : { status: 'completed', output_text: ' complete ' };
const headers = { 'Content-Type': 'application/json', 'X-Request-Id': REQUEST_ID };
async function upstream(t, handler) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    calls.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
    handler(req, res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return { provider: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: SECRET }, calls };
}
function deadlineSpy(t, acceleratedMs) {
  const original = AbortSignal.timeout.bind(AbortSignal);
  const budgets = [];
  t.mock.method(AbortSignal, 'timeout', ms => { budgets.push(ms); return original(acceleratedMs ?? ms); });
  return budgets;
}
function safeFailure(error, timeout, phase, status) {
  assert.equal(error.status, 504);
  assert.equal(error.diagnostics.timeoutMs, timeout);
  assert.equal(error.diagnostics.timeoutPhase, phase);
  assert.equal(error.diagnostics.upstreamStatus, status);
  assert.equal(error.diagnostics.category, 'timeout');
  assert.equal(error.diagnostics.automaticRetry, false);
  assert.equal(error.diagnostics.responseBodyOmitted, true);
  assert.ok(Number.isSafeInteger(error.diagnostics.elapsedMs));
  assert.match(error.message, new RegExp(`${timeout / 1000}-second wait limit`));
  assert.match(error.message, /No automatic retry.*may still incur charges/);
  assert.ok(!JSON.stringify(error).includes(SECRET));
  assert.ok(!error.message.includes(SECRET));
  if (status) {
    assert.equal(error.diagnostics.providerRequestId, REQUEST_ID);
    assert.equal(error.diagnostics.contentType, 'application/json');
  }
  return true;
}

test('primary deadline defaults to 300 seconds; only integer 30..600 is accepted before network', async t => {
  assert.equal(DEFAULT_PRIMARY_TIMEOUT_SECONDS, 300);
  assert.equal(primaryTimeoutSeconds(), 300);
  assert.equal(primaryTimeoutSeconds(undefined), 300);
  for (const value of [30, 31, 300, 301, 600]) assert.equal(primaryTimeoutSeconds(value), value);
  let calls = 0;
  const forbidden = () => { calls++; throw new Error('No transport allowed'); };
  t.mock.method(globalThis, 'fetch', forbidden);
  t.mock.method(http, 'request', forbidden);
  t.mock.method(https, 'request', forbidden);
  for (const value of [null, '300', '', true, false, 29, 601, 0, -1, 30.5, NaN, Infinity, [], {}, SECRET]) {
    assert.throws(() => primaryTimeoutSeconds(value), error => error instanceof AppError && error.status === 400 && !error.message.includes(SECRET));
    for (const api of ['auto', 'responses', 'chat']) {
      await assert.rejects(generateText({ baseUrl: 'http://127.0.0.1:1/v1' }, { model: 'fixture', api, timeoutSeconds: value }, prompt), error => error.status === 400);
    }
  }
  for (const timeout of [null, '600000', 0, -1, 0.5, 600001, NaN, Infinity, SECRET]) {
    await assert.rejects(providerRequest({ baseUrl: 'http://127.0.0.1:1' }, '/models', { timeout }), error => error.status === 400);
  }
  assert.equal(calls, 0);
});

test('both primary routes use default/custom budgets without leaking configuration or changing thinking/tokens', async t => {
  const budgets = deadlineSpy(t);
  const originalFetch = globalThis.fetch;
  const fetchSpy = t.mock.method(globalThis, 'fetch', (...args) => originalFetch(...args));
  const originalRequest = http.request;
  const nativeSpy = t.mock.method(http, 'request', function (...args) { return originalRequest.apply(this, args); });
  const { provider, calls } = await upstream(t, (req, res) => { res.writeHead(200, headers); res.end(JSON.stringify(envelope(req.url.endsWith('/responses') ? 'responses' : 'chat'))); });
  for (const api of ['responses', 'chat']) for (const seconds of [undefined, 30, 300, 301, 600]) {
    const fetchBefore = fetchSpy.mock.callCount(), nativeBefore = nativeSpy.mock.callCount();
    const result = await generateText(provider, { model: 'fixture', api, reasoningEffort: 'high', ...(seconds === undefined ? {} : { timeoutSeconds: seconds }) }, prompt);
    const timeout = (seconds ?? 300) * 1000;
    assert.equal(result.text, ' complete ');
    assert.equal(result.diagnostics.timeoutMs, timeout);
    assert.equal(result.diagnostics.timeoutPhase, undefined);
    assert.equal(budgets.at(-1), timeout, 'Regression: the former 100-second text deadline is not acceptable');
    assert.equal(fetchSpy.mock.callCount() - fetchBefore, timeout <= 300000 ? 1 : 0);
    assert.equal(nativeSpy.mock.callCount() - nativeBefore, timeout > 300000 ? 1 : 0, 'Above 300 seconds bypass the built-in Undici ceiling');
    const call = calls.at(-1), body = JSON.parse(call.body);
    assert.equal(call.headers.authorization, `Bearer ${SECRET}`);
    assert.equal(call.headers['content-type'], 'application/json');
    assert.equal(call.headers.accept, 'application/json');
    if (timeout > 300000) assert.equal(call.headers['accept-encoding'], 'identity');
    assert.equal(body.stream, false);
    assert.equal(body.model, 'fixture');
    assert.equal(body[api === 'responses' ? 'max_output_tokens' : 'max_completion_tokens'], 6000);
    assert.equal(api === 'responses' ? body.reasoning.effort : body.reasoning_effort, 'high');
    assert.deepEqual(Object.keys(body).sort(), (api === 'responses' ? ['model', 'instructions', 'stream', 'max_output_tokens', 'reasoning', 'input'] : ['model', 'stream', 'max_completion_tokens', 'reasoning_effort', 'messages']).sort());
    assert.ok(!/timeout/i.test(call.body));
    assert.ok(!Object.keys(call.headers).some(key => /timeout/i.test(key)));
  }
  assert.equal(calls.length, 10);
});

test('speech/transcription default stays 100 seconds and discovery stays 20 seconds on fetch', async t => {
  const budgets = deadlineSpy(t);
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify(url.endsWith('/models') ? { data: [{ id: 'fixture' }] } : { text: 'fixture' }), { headers });
  });
  const provider = { baseUrl: 'https://provider.invalid/v1', apiKey: SECRET };
  await providerRequest(provider, '/audio/transcriptions', { body: { model: 'fixture' } });
  await providerRequest(provider, '/audio/speech', { binary: true, body: { model: 'fixture' } });
  await discoverModels(provider);
  assert.deepEqual(budgets, [100000, 100000, 20000]);
  assert.equal(calls.length, 3);
});

test('Auto fallback creates independent equal-budget attempts only for 404/405/501', async t => {
  const budgets = deadlineSpy(t);
  for (const seconds of [30, 600]) for (const status of [404, 405, 501]) {
    const { provider, calls } = await upstream(t, (req, res) => {
      res.writeHead(req.url.endsWith('/responses') ? status : 200, headers);
      res.end(JSON.stringify(req.url.endsWith('/responses') ? { error: { message: SECRET } } : envelope('chat')));
    });
    const before = budgets.length;
    const result = await generateText(provider, { model: 'fixture', api: 'auto', timeoutSeconds: seconds }, prompt);
    assert.equal(result.api, 'chat');
    assert.deepEqual(budgets.slice(before), [seconds * 1000, seconds * 1000]);
    assert.deepEqual(calls.map(call => call.url), ['/v1/responses', '/v1/chat/completions']);
  }
});

test('real short deadline before headers is 504, safe and one call', async t => {
  const { provider, calls } = await upstream(t, () => {});
  await assert.rejects(providerRequest(provider, '/responses', { timeout: 120, body: { text: SECRET } }), error => safeFailure(error, 120, 'response_headers'));
  assert.equal(calls.length, 1);
});

test('one real deadline includes delayed headers and continuously arriving partial body', async t => {
  const { provider, calls } = await upstream(t, (_req, res) => {
    const timer = setTimeout(() => {
      res.writeHead(200, headers);
      res.write('{"output_text":"');
      const chunks = setInterval(() => res.write('partial '), 15);
      res.once('close', () => clearInterval(chunks));
    }, 70);
    res.once('close', () => clearTimeout(timer));
  });
  await assert.rejects(providerRequest(provider, '/responses', { timeout: 180, body: { text: SECRET } }), error => {
    safeFailure(error, 180, 'response_body', 200);
    assert.ok(error.diagnostics.elapsedMs < 1500, 'Chunks must not reset the full deadline');
    return true;
  });
  assert.equal(calls.length, 1);
});

// Accelerate only the application deadline, never the native HTTP adapter. This
// exercises real sockets/abort/body errors without claiming a 305-second soak.
test('primary default and >300-second native deadlines abort headers/body, never accept partial JSON/SSE or retry', async t => {
  const budgets = deadlineSpy(t, 140);
  for (const seconds of [undefined, 600]) for (const mode of ['headers', 'empty-body', 'partial-json', 'complete-json-open-body', 'partial-sse']) {
    const { provider, calls } = await upstream(t, (_req, res) => {
      if (mode === 'headers') return;
      res.writeHead(200, mode === 'partial-sse' ? { ...headers, 'Content-Type': 'text/event-stream' } : headers);
      res.flushHeaders();
      if (mode === 'partial-json') res.write('{"output_text":"' + SECRET);
      if (mode === 'complete-json-open-body') res.write(JSON.stringify(envelope('responses')));
      if (mode === 'partial-sse') res.write('data: {"type":"response.output_text.delta","delta":"partial"}\n\n');
    });
    await assert.rejects(generateText(provider, { model: 'fixture', api: 'auto', timeoutSeconds: seconds }, prompt), error => {
      if (mode === 'partial-sse') {
        assert.equal(error.status, 504); assert.equal(error.diagnostics.timeoutPhase, 'response_body');
        assert.equal(error.diagnostics.contentType, 'text/event-stream');
      } else safeFailure(error, (seconds ?? 300) * 1000, mode === 'headers' ? 'response_headers' : 'response_body', mode === 'headers' ? undefined : 200);
      assert.equal(error.diagnostics.maxOutputTokens, 6000);
      assert.equal(error.diagnostics.completionStatus, 'unknown');
      return true;
    });
    assert.equal(budgets.at(-1), (seconds ?? 300) * 1000);
    assert.equal(calls.length, 1);
  }
});

test('HTTP 500 plus stalled error body retains HTTP failure after the existing 2-second cap on both transports', async t => {
  for (const timeout of [5000, 600000]) {
    const { provider, calls } = await upstream(t, (_req, res) => { res.writeHead(500, headers); res.flushHeaders(); res.write('{"error":"' + SECRET); });
    const started = Date.now();
    await assert.rejects(providerRequest(provider, '/responses', { timeout }), error => {
      assert.equal(error.status, 502); assert.equal(error.providerStatus, 500);
      assert.equal(error.diagnostics.category, 'provider_http');
      assert.equal(error.diagnostics.timeoutMs, timeout);
      assert.equal(error.diagnostics.timeoutPhase, undefined);
      assert.equal(error.diagnostics.providerRequestId, REQUEST_ID);
      assert.ok(!JSON.stringify(error).includes(SECRET));
      return true;
    });
    assert.ok(Date.now() - started >= 1800);
    assert.ok(Date.now() - started < 5000);
    assert.equal(calls.length, 1);
  }
});

test('a shorter deadline while collecting an explicit HTTP error still preserves that HTTP status', async t => {
  const { provider } = await upstream(t, (_req, res) => { res.writeHead(500, headers); res.flushHeaders(); });
  await assert.rejects(providerRequest(provider, '/responses', { timeout: 100 }), error => {
    assert.equal(error.providerStatus, 500); assert.equal(error.status, 502);
    assert.equal(error.diagnostics.category, 'provider_http'); assert.equal(error.diagnostics.timeoutPhase, undefined);
    return true;
  });
});

test('unrelated transport AbortError/TimeoutError is not mislabeled as our deadline', async t => {
  for (const name of ['AbortError', 'TimeoutError']) {
    t.mock.method(globalThis, 'fetch', async () => { throw new DOMException(SECRET, name); });
    await assert.rejects(providerRequest({ baseUrl: 'https://provider.invalid' }, '/responses'), error => {
      assert.equal(error.status, 502); assert.equal(error.diagnostics.category, 'connection');
      assert.equal(error.diagnostics.timeoutPhase, undefined); assert.ok(!error.message.includes(SECRET)); return true;
    });
  }
});

test('native path refuses redirects, oversized bodies and unexpected compression without fetch fallback', async t => {
  let fetchCalls = 0;
  t.mock.method(globalThis, 'fetch', () => { fetchCalls++; throw new Error('No fallback allowed'); });
  for (const mode of ['redirect', 'oversize-length', 'oversize-chunks', 'compression', 'reset']) {
    const { provider, calls } = await upstream(t, (_req, res) => {
      if (mode === 'redirect') { res.writeHead(302, { Location: '/must-not-follow' }); res.end(); }
      if (mode === 'oversize-length') { res.writeHead(200, { ...headers, 'Content-Length': 4 * 1024 * 1024 }); res.end(); }
      if (mode === 'oversize-chunks') { res.writeHead(200, headers); res.end('x'.repeat(3 * 1024 * 1024 + 1)); }
      if (mode === 'compression') { res.writeHead(200, { ...headers, 'Content-Encoding': 'gzip' }); res.end(JSON.stringify(envelope('responses'))); }
      if (mode === 'reset') { res.writeHead(200, headers); res.write('{"output_text":"'); setImmediate(() => res.destroy()); }
    });
    await assert.rejects(generateText(provider, { model: 'fixture', api: 'auto', timeoutSeconds: 600 }, prompt), error => {
      assert.equal(error.status, 502); assert.equal(error.diagnostics.timeoutPhase, undefined);
      assert.notEqual(error.diagnostics.category, 'timeout'); return true;
    });
    assert.equal(calls.length, 1);
  }
  assert.equal(fetchCalls, 0);
});

test('native HTTP 101 upgrade fails promptly and closes the upgraded socket instead of reserving a job forever', { timeout: 3000 }, async t => {
  let socket;
  const { provider, calls } = await upstream(t, (req, res) => {
    socket = req.socket;
    res.writeHead(101, { Connection: 'Upgrade', Upgrade: 'synthetic-fixture' }); res.flushHeaders();
  });
  const started = Date.now();
  let watchdog;
  try {
    await assert.rejects(Promise.race([
      generateText(provider, { model: 'fixture', api: 'auto', timeoutSeconds: 600 }, prompt),
      new Promise((_, reject) => { watchdog = setTimeout(() => reject(new Error('Upgrade request did not settle')), 1000); }),
    ]), error => {
      assert.equal(error.status, 502); assert.match(error.message, /unsupported HTTP protocol upgrade/);
      assert.equal(error.diagnostics.automaticRetry, false); assert.equal(error.diagnostics.timeoutMs, 600000);
      assert.equal(error.diagnostics.timeoutPhase, undefined); return true;
    });
    assert.ok(Date.now() - started < 1000);
    assert.equal(calls.length, 1);
    if (!socket.destroyed) await new Promise(resolve => { socket.once('close', resolve); socket.resume(); });
    assert.equal(socket.destroyed, true);
  } finally { clearTimeout(watchdog); socket?.destroy(); }
});

test('native deadline settles even if a transport never emits response or error', { timeout: 2000 }, async t => {
  deadlineSpy(t, 30);
  let calls = 0, watchdog;
  t.mock.method(http, 'request', () => {
    calls++;
    const req = new EventEmitter(); req.end = () => {}; return req;
  });
  try {
    await assert.rejects(Promise.race([
      generateText({ baseUrl: 'http://127.0.0.1:1' }, { model: 'fixture', api: 'auto', timeoutSeconds: 600 }, prompt),
      new Promise((_, reject) => { watchdog = setTimeout(() => reject(new Error('Deadline did not settle')), 500); }),
    ]), error => safeFailure(error, 600000, 'response_headers'));
    assert.equal(calls, 1);
  } finally { clearTimeout(watchdog); }
});

test('native transport supports null-body statuses without invalid Response construction', async t => {
  for (const status of [204, 205]) {
    const { provider } = await upstream(t, (_req, res) => { res.writeHead(status); res.end(); });
    await assert.rejects(providerRequest(provider, '/responses', { timeout: 600000 }), error => {
      assert.equal(error.diagnostics.upstreamStatus, status); assert.match(error.message, /body was empty/); return true;
    });
  }
});

test('native long-deadline security preserves HTTPS, credentials and public-only boundaries before transport', async t => {
  let calls = 0;
  const forbidden = () => { calls++; throw new Error('No transport allowed'); };
  t.mock.method(globalThis, 'fetch', forbidden); t.mock.method(http, 'request', forbidden); t.mock.method(https, 'request', forbidden);
  for (const provider of [
    { baseUrl: 'http://remote.invalid/v1' }, { baseUrl: 'ftp://127.0.0.1/v1' },
    { baseUrl: 'https://user:pass@remote.invalid/v1' },
    { baseUrl: 'http://127.0.0.1/v1', publicOnly: true },
    { baseUrl: 'https://127.0.0.1/v1', publicOnly: true },
    { baseUrl: 'https://[::1]/v1', publicOnly: true },
  ]) await assert.rejects(providerRequest(provider, '/responses', { timeout: 600000 }), error => error.status === 400);
  assert.equal(calls, 0);
});

test('hosted DNS validation is deadline-bounded and never connects after a late lookup', async t => {
  let requestCalls = 0;
  t.mock.method(https, 'request', () => { requestCalls++; throw new Error('No connection after deadline'); });
  t.mock.method(dns, 'lookup', () => new Promise(resolve => setTimeout(() => resolve([{ address: '93.184.216.34', family: 4 }]), 80)));
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await assert.rejects(providerRequest({ baseUrl: 'https://provider.invalid', publicOnly: true }, '/responses', { timeout: 20 }), error => safeFailure(error, 20, 'response_headers'));
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(requestCalls, 0);
});

test('native HTTPS uses known auth headers, default certificate validation and pinned public DNS; synthetic socket only', async t => {
  const { provider: loopback, calls } = await upstream(t, (_req, res) => { res.writeHead(200, headers); res.end('{"data":[]}'); });
  const originalRequest = http.request;
  let dnsCalls = 0, requestCalls = 0;
  t.mock.method(dns, 'lookup', async () => { dnsCalls++; return [{ address: '93.184.216.34', family: 4 }]; });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  t.mock.method(globalThis, 'fetch', () => { throw new Error('No fetch fallback'); });
  t.mock.method(https, 'request', (url, options, callback) => {
    requestCalls++;
    assert.equal(url.protocol, 'https:'); assert.equal(url.hostname, 'provider.invalid');
    assert.equal(options.rejectUnauthorized, undefined, 'TLS verification must not be disabled');
    assert.equal(options.agent, false); assert.equal(options.timeout, 0);
    assert.equal(options.headers['Accept-Encoding'], 'identity');
    if (options.lookup) {
      options.lookup('provider.invalid', {}, (error, address, family) => { assert.equal(error, null); assert.equal(address, '93.184.216.34'); assert.equal(family, 4); });
      options.lookup('provider.invalid', { all: true }, (error, addresses) => { assert.equal(error, null); assert.deepEqual(addresses, [{ address: '93.184.216.34', family: 4 }]); });
    }
    // Only this test bridge connects, exclusively to the synthetic loopback.
    return originalRequest(loopback.baseUrl + '/models', { ...options, lookup: undefined }, callback);
  });
  for (const publicOnly of [false, true]) for (const authHeader of ['Authorization', 'x-goog-api-key']) {
    await providerRequest({ baseUrl: 'https://provider.invalid/v1', apiKey: SECRET, publicOnly }, '/models', { timeout: 600000, authHeader });
    assert.equal(calls.at(-1).headers[authHeader.toLowerCase()], authHeader === 'Authorization' ? `Bearer ${SECRET}` : SECRET);
    assert.equal(calls.at(-1).headers[authHeader === 'Authorization' ? 'x-goog-api-key' : 'authorization'], undefined);
  }
  assert.equal(dnsCalls, 2); assert.equal(requestCalls, 4);
  await assert.rejects(providerRequest({ baseUrl: 'https://provider.invalid', apiKey: SECRET }, '/models', { timeout: 600000, authHeader: SECRET }), /Unsupported provider authentication/);
  assert.equal(requestCalls, 4);
  // Mixed public/private answers must reject as a whole, never pick the public one.
  t.mock.method(dns, 'lookup', async () => [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }]);
  syncBuiltinESMExports();
  await assert.rejects(providerRequest({ baseUrl: 'https://provider.invalid', publicOnly: true }, '/models', { timeout: 600000 }), /private or local network/);
  assert.equal(requestCalls, 4);
});
