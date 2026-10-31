import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { providerRequest, generateText } from '../lib/provider.mjs';
import { startApp, addProvider, setRoles, EMPTY_ROLES, KEY, WAV, lessonInput } from './helpers.mjs';

const SOURCE = 'PRIVATE-SOURCE-DO-NOT-INCLUDE-IN-DIAGNOSTICS';
const REQUEST_ID = 'req_0123456789abcdef0123456789abcdef';
async function failingProvider(t, { status = 500, payload = JSON.stringify({ error: { code: 'convert_request_failed', message: `${KEY} ${SOURCE}` } }), type = 'application/json', requestId = REQUEST_ID } = {}) {
  const calls = [];
  const server = http.createServer(async (req, res) => { for await (const _ of req) {} calls.push(req.url); res.writeHead(status, { 'Content-Type': type, 'X-Request-Id': requestId }); res.end(payload); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: KEY, calls };
}

test('HTTP 500 retains safe endpoint, timing, status, known code and provider request ID without retry', async t => {
  const provider = await failingProvider(t);
  await assert.rejects(generateText(provider, { model: 'fixture', api: 'auto' }, { instructions: 'Test', text: SOURCE }), error => {
    assert.equal(error.diagnostics?.upstreamStatus, 500);
    assert.equal(error.diagnostics.endpoint, '/responses');
    assert.equal(error.diagnostics.providerCode, 'convert_request_failed');
    assert.equal(error.diagnostics.providerRequestId, REQUEST_ID);
    assert.equal(error.diagnostics.category, 'provider_http');
    assert.equal(error.diagnostics.automaticRetry, false);
    assert.ok(Number.isInteger(error.diagnostics.elapsedMs));
    assert.doesNotMatch(JSON.stringify(error.diagnostics), new RegExp(`${KEY}|${SOURCE}`));
    return true;
  });
  assert.deepEqual(provider.calls, ['/v1/responses']);
});

test('provider diagnostics omit arbitrary bodies, codes, content types, unsafe IDs and excessive bodies', async t => {
  for (const options of [
    { payload: JSON.stringify({ error: { code: SOURCE, message: KEY } }), requestId: KEY },
    { payload: `<html>${SOURCE} ${KEY}</html>`, type: 'text/html' },
    { payload: SOURCE.repeat(10000), type: 'text/plain' },
    { status: 200, payload: 'invalid ' + SOURCE, type: 'application/' + SOURCE },
  ]) {
    const provider = await failingProvider(t, options);
    await assert.rejects(providerRequest(provider, '/audio/transcriptions', { body: { model: 'fixture' } }), error => {
      assert.ok(error.diagnostics, 'Even unreadable/oversized errors need metadata');
      assert.doesNotMatch(JSON.stringify(error.diagnostics), new RegExp(`${KEY}|${SOURCE}`));
      return true;
    });
    assert.equal(provider.calls.length, 1);
  }
});

test('error-body deadline preserves the original HTTP failure and filters key-shaped IDs', async t => {
  const provider = await failingProvider(t);
  provider.apiKey = '0123456789abcdef0123456789abcdef';
  await assert.rejects(providerRequest(provider, '/models'), error => { assert.equal(error.diagnostics.providerRequestId, undefined); return true; });
  const stalled = http.createServer((req, res) => { res.writeHead(500, { 'Content-Type': 'application/json' }); res.flushHeaders(); });
  await new Promise(resolve => stalled.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { stalled.close(resolve); stalled.closeAllConnections(); }));
  const started = Date.now();
  await assert.rejects(providerRequest({ baseUrl: `http://127.0.0.1:${stalled.address().port}` }, '/responses'), error => { assert.equal(error.providerStatus, 500); assert.equal(error.diagnostics.category, 'provider_http'); return true; });
  assert.ok(Date.now() - started < 5000, 'Debug collection must not wait the full provider timeout');
});

test('API distinguishes transcription, source preparation and final lesson failures with request correlation', async t => {
  const upstream = await failingProvider(t), app = await startApp(t), client = await app.client();
  const provider = await addProvider(client, upstream);
  const role = { providerId: provider.id, model: 'fixture-model', api: 'chat' };
  await setRoles(client, { ...EMPTY_ROLES, primary: role, transcription: role });
  for (const [route, body, stage, endpoint] of [
    ['/api/transcribe', { consent: true, dataUrl: `data:audio/wav;base64,${WAV.toString('base64')}` }, 'transcription', '/audio/transcriptions'],
    ['/api/materials/summarize', { consent: true, text: SOURCE.repeat(100), images: [] }, 'source_preparation', '/chat/completions'],
    ['/api/lessons', lessonInput({ text: SOURCE }), 'lesson_generation', '/chat/completions'],
  ]) {
    const result = await client.request(route, { method: 'POST', json: body });
    assert.equal(result.status, 502);
    assert.equal(result.json.diagnostics?.stage, stage);
    assert.equal(result.json.diagnostics.upstreamStatus, 500);
    assert.equal(result.json.diagnostics.endpoint, endpoint);
    assert.equal(result.json.diagnostics.model, 'fixture-model');
    assert.match(result.json.requestId || '', /^[a-f0-9-]{36}$/);
    assert.doesNotMatch(result.text, new RegExp(`${KEY}|${SOURCE}`));
  }
  assert.equal(upstream.calls.length, 3, 'One request per user-authorized operation, no replay/fallback on 500');
});
