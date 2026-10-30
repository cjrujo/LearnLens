import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { generateText, providerRequest } from '../lib/provider.mjs';
const SECRET = 'private-fixture-key-and-source-never-show';
async function upstream(t, payload, type = 'application/json', status = 200) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const parts = []; for await (const part of req) parts.push(part);
    calls.push({ path: req.url, body: JSON.parse(Buffer.concat(parts).toString() || '{}') });
    res.writeHead(status, { 'Content-Type': type }); res.end(payload);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return { provider: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: SECRET }, calls };
}
const prompt = { instructions: 'Return a brief answer.', text: SECRET };

test('wire diagnostics distinguish HTML, empty, malformed and wrong JSON shapes without exposing bodies', async t => {
  for (const [payload, type, expected] of [
    [`<!doctype html><title>${SECRET}</title>`, 'text/html', /HTML.*API/i],
    ['', 'application/json', /empty/i],
    [`{"secret":"${SECRET}",`, 'application/json', /malformed|truncated/i],
    [JSON.stringify([SECRET]), 'application/json', /array/i],
    [JSON.stringify(SECRET), 'application/json', /string/i],
  ]) {
    const { provider, calls } = await upstream(t, payload, type);
    await assert.rejects(generateText(provider, { model: 'test', api: 'auto' }, prompt), error => {
      assert.match(error.message, expected); assert.match(error.message, /\/responses/); assert.match(error.message, /HTTP 200/);
      assert.ok(!error.message.includes(SECRET)); return true;
    });
    assert.equal(calls.length, 1, 'Malformed success must not cause another billable endpoint request');
  }
});

test('text requests explicitly disable streaming and tolerate UTF-8 BOM or mislabeled JSON', async t => {
  for (const api of ['chat', 'responses']) {
    const object = api === 'chat' ? { choices: [{ message: { content: 'Hello' } }] } : { output_text: 'Hello' };
    const { provider, calls } = await upstream(t, '\uFEFF' + JSON.stringify(object), 'text/plain');
    assert.equal((await generateText(provider, { model: 'test', api }, prompt)).text, 'Hello');
    assert.equal(calls[0].body.stream, false);
  }
});

test('bounded Chat SSE is accepted when a gateway ignores stream:false', async t => {
  const frames = [
    { choices: [{ index: 0, delta: { role: 'assistant', content: 'Hello ' }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { content: 'world' }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  ];
  const { provider, calls } = await upstream(t, frames.map(frame => 'data: ' + JSON.stringify(frame) + '\r\n\r\n').join('') + 'data: [DONE]\r\n\r\n', 'text/event-stream');
  assert.equal((await generateText(provider, { model: 'test', api: 'chat' }, prompt)).text, 'Hello world');
  assert.equal(calls.length, 1); assert.equal(calls[0].body.stream, false);
});

test('Responses SSE uses the completed response and never duplicates output deltas', async t => {
  const final = { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Hello' }] }] };
  const { provider } = await upstream(t, `event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'Hello' })}\n\nevent: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: final })}\n\n`, 'text/event-stream');
  assert.equal((await generateText(provider, { model: 'test', api: 'responses' }, prompt)).text, 'Hello');
});

test('incomplete or errored SSE never becomes a successful partial answer', async t => {
  for (const [payload, api, expected] of [
    ['data: {"choices":[{"index":0,"delta":{"content":"Hello"}}]}\n\n', 'chat', /ended|incomplete/i],
    ['data: {"type":"response.output_text.delta","delta":"Hello"}\n\n', 'responses', /ended|incomplete/i],
    [`data: {"error":{"message":"${SECRET}","code":"insufficient_quota"}}\n\n`, 'chat', /quota/i],
    ['data: {broken-json}\n\n', 'responses', /malformed/i],
    ['data: {"type":7,"choices":{}}\n\n', 'chat', /malformed.*choices/i],
    ['data: {"choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n', 'chat', /truncated/i],
  ]) {
    const { provider } = await upstream(t, payload, 'text/event-stream');
    await assert.rejects(generateText(provider, { model: 'test', api }, prompt), error => { assert.match(error.message, expected); assert.ok(!error.message.includes(SECRET)); return true; });
  }
});

test('HTTP 200 error envelopes and protocol mismatches provide safe guidance', async t => {
  const { provider } = await upstream(t, JSON.stringify({ error: { message: SECRET, code: 'invalid_api_key' } }));
  await assert.rejects(providerRequest(provider, '/models'), error => { assert.match(error.message, /authorization|API key/i); assert.ok(!error.message.includes(SECRET)); return true; });
  const wrong = await upstream(t, JSON.stringify({ choices: [{ message: { content: 'hello' } }] }));
  await assert.rejects(generateText(wrong.provider, { model: 'test', api: 'responses' }, prompt), /Chat Completions/);
});
