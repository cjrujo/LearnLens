import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { generateText, providerRequest } from '../lib/provider.mjs';
const SECRET = 'private-fixture-key-and-source-never-show';
const REQUEST_ID = 'req_0123456789abcdef0123456789abcdef';
async function upstream(t, payload, type = 'application/json', status = 200) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const parts = []; for await (const part of req) parts.push(part);
    calls.push({ path: req.url, body: JSON.parse(Buffer.concat(parts).toString() || '{}') });
    res.writeHead(typeof status === 'function' ? status(req) : status, { 'Content-Type': type, 'X-Request-Id': REQUEST_ID });
    res.end(typeof payload === 'function' ? payload(req) : payload);
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
      assert.ok(!error.message.includes(SECRET));
      assertTransport(error.diagnostics, 'responses', payload, type);
      assert.equal(error.diagnostics.maxOutputTokens, 10000);
      assert.equal(error.diagnostics.category, 'provider_protocol');
      return true;
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

function assertTransport(diagnostics, api, payload, type = 'application/json') {
  assert.equal(diagnostics.version, 1);
  assert.equal(diagnostics.endpoint, api === 'chat' ? '/chat/completions' : '/responses');
  assert.equal(diagnostics.upstreamStatus, 200);
  assert.equal(diagnostics.contentType, type);
  assert.equal(diagnostics.responseBytes, Buffer.byteLength(payload));
  assert.equal(diagnostics.providerRequestId, REQUEST_ID);
  assert.ok(Number.isSafeInteger(diagnostics.elapsedMs) && diagnostics.elapsedMs >= 0);
  assert.equal(diagnostics.automaticRetry, false);
  assert.equal(diagnostics.responseBodyOmitted, true);
  assert.ok(!JSON.stringify(diagnostics).includes(SECRET));
}
function textEnvelope(api, output, usage) {
  return api === 'responses'
    ? { status: 'completed', output_text: output, usage }
    : { choices: [{ finish_reason: 'stop', message: { content: output } }], usage };
}
function tokenUsage(api, output, reasoning) {
  return api === 'responses'
    ? { output_tokens: output, output_tokens_details: { reasoning_tokens: reasoning } }
    : { completion_tokens: output, completion_tokens_details: { reasoning_tokens: reasoning } };
}

test('both text endpoints preserve exact text, safe successful metadata and unchanged request budgets/thinking', async t => {
  for (const api of ['responses', 'chat']) {
    const text = `  ${SECRET}\n中文\r\n🙂  `;
    const payload = JSON.stringify({ ...textEnvelope(api, text, tokenUsage(api, 123, 45)), model: SECRET, max_output_tokens: SECRET, [SECRET]: SECRET });
    const { provider, calls } = await upstream(t, payload);
    const result = await generateText(provider, { model: 'test', api, reasoningEffort: 'high' }, { ...prompt, maxTokens: 6000 });
    assert.equal(result.text, text); assert.equal(result.api, api);
    assertTransport(result.diagnostics, api, payload);
    assert.equal(result.diagnostics.maxOutputTokens, 6000);
    assert.equal(result.diagnostics.completionStatus, api === 'responses' ? 'completed' : 'stop');
    assert.equal(result.diagnostics.outputCharacters, text.length);
    assert.equal(result.diagnostics.outputTokens, 123);
    assert.equal(result.diagnostics.reasoningTokens, 45);
    assert.deepEqual(Object.keys(result.diagnostics).sort(), ['version', 'endpoint', 'automaticRetry', 'responseBodyOmitted', 'upstreamStatus', 'contentType', 'providerRequestId', 'responseBytes', 'elapsedMs', 'maxOutputTokens', 'completionStatus', 'outputCharacters', 'outputTokens', 'reasoningTokens'].sort());
    assert.equal(calls.length, 1); assert.equal(calls[0].body.stream, false);
    assert.equal(calls[0].body[api === 'responses' ? 'max_output_tokens' : 'max_completion_tokens'], 6000);
    assert.equal(api === 'responses' ? calls[0].body.reasoning.effort : calls[0].body.reasoning_effort, 'high');
  }
});

test('usage metadata accepts only bounded integer numbers from known endpoint fields', async t => {
  for (const api of ['responses', 'chat']) {
    for (const bad of [SECRET, '12', -1, 0.5, 1_000_000_001, Number.MAX_SAFE_INTEGER + 1, null, true, [], { value: 12, [SECRET]: SECRET }]) {
      const usage = { ...tokenUsage(api, bad, bad), outputTokens: 77, reasoningTokens: 88, total_tokens: 99, [SECRET]: SECRET };
      const payload = JSON.stringify(textEnvelope(api, 'answer', usage));
      const { provider, calls } = await upstream(t, payload);
      const { diagnostics } = await generateText(provider, { model: 'test', api }, prompt);
      assert.equal(diagnostics.outputTokens, undefined); assert.equal(diagnostics.reasoningTokens, undefined);
      assert.equal(diagnostics.maxOutputTokens, 10000);
      assertTransport(diagnostics, api, payload); assert.equal(calls.length, 1);
    }
    for (const count of [0, 1_000_000_000]) {
      const { provider } = await upstream(t, JSON.stringify(textEnvelope(api, 'answer', tokenUsage(api, count, count))));
      const { diagnostics } = await generateText(provider, { model: 'test', api }, prompt);
      assert.equal(diagnostics.outputTokens, count); assert.equal(diagnostics.reasoningTokens, count);
    }
    const payload = JSON.stringify(textEnvelope(api, 'answer', tokenUsage(api, 1, 1))).replaceAll(':1', ':1e999');
    const { provider } = await upstream(t, payload);
    const { diagnostics } = await generateText(provider, { model: 'test', api }, prompt);
    assert.equal(diagnostics.outputTokens, undefined); assert.equal(diagnostics.reasoningTokens, undefined);
  }
});

test('legacy missing/null status, convenience text and array text remain compatible', async t => {
  for (const [api, envelope, expected] of [
    ['responses', { output_text: '  exact\n' }, '  exact\n'],
    ['responses', { status: null, output_text: 'legacy' }, 'legacy'],
    ['responses', { output: [{ type: 'message', content: [{ type: 'output_text', text: 'a' }, { type: 'output_text', text: ' b ' }] }] }, 'a\n b '],
    ['chat', { choices: [{ message: { content: 'legacy' } }] }, 'legacy'],
    ['chat', { choices: [{ finish_reason: null, message: { content: [{ type: 'text', text: ' a ' }, { type: 'text', text: 'b' }] } }] }, ' a \nb'],
  ]) {
    const { provider } = await upstream(t, JSON.stringify(envelope));
    const result = await generateText(provider, { model: 'test', api }, prompt);
    assert.equal(result.text, expected); assert.equal(result.diagnostics.completionStatus, 'unknown');
  }
});

test('Responses local status/envelope failures retain metadata without auto fallback or secret leakage', async t => {
  const cases = [
    ...['incomplete', 'failed', 'cancelled', 'queued', 'in_progress', SECRET, 'toString'].map(status => [{ status, output_text: 'partial', incomplete_details: { reason: SECRET } }, status === SECRET || status === 'toString' ? 'unknown' : status, 7]),
    ...['incomplete', 'failed', SECRET].map(status => [{ status: 'completed', output_text: 'partial', output: [{ type: 'message', status, content: [{ type: 'output_text', text: SECRET }] }] }, status === SECRET ? 'unknown' : status, 7]),
    [{ choices: [{ message: { content: SECRET } }] }, 'unknown', 0],
    [{ status: 'completed', output_text: ' \n ' }, 'completed', 3],
    [{ status: 'completed', output_text: 'partial', output: [{ type: 'message', content: [{ type: 'refusal', refusal: SECRET }] }] }, 'content_filter', 7],
    [{ status: 'completed', output_text: 'partial', output: [{ type: 'function_call', arguments: SECRET }] }, 'tool_calls', 7],
  ];
  for (const [envelope, status, characters] of cases) {
    const payload = JSON.stringify({ ...envelope, usage: tokenUsage('responses', 25, 10), [SECRET]: SECRET });
    const { provider, calls } = await upstream(t, payload);
    await assert.rejects(generateText(provider, { model: 'test', api: 'auto' }, { ...prompt, maxTokens: 6000 }), error => {
      assert.equal(error.status, 502); assert.equal(error.providerStatus, undefined);
      assertTransport(error.diagnostics, 'responses', payload);
      assert.equal(error.diagnostics.category, 'provider_protocol');
      assert.equal(error.diagnostics.maxOutputTokens, 6000);
      assert.equal(error.diagnostics.completionStatus, status);
      assert.equal(error.diagnostics.outputCharacters, characters);
      assert.equal(error.diagnostics.outputTokens, 25); assert.equal(error.diagnostics.reasoningTokens, 10);
      assert.ok(!JSON.stringify(error).includes(SECRET)); assert.ok(!error.message.includes(SECRET));
      return true;
    });
    assert.deepEqual(calls.map(call => call.path), ['/v1/responses']);
  }
});

test('Chat rejects truncation, filter, refusal, tool requests and unknown reasons with safe metadata', async t => {
  const cases = [
    ...['length', 'content_filter', 'tool_calls', 'function_call', SECRET, 'toString'].map(reason => [{ choices: [{ finish_reason: reason, message: { content: 'partial' } }] }, reason === 'function_call' ? 'tool_calls' : [SECRET, 'toString'].includes(reason) ? 'unknown' : reason, 7]),
    [{ choices: [{ finish_reason: 'stop', message: { content: 'partial', refusal: SECRET } }] }, 'content_filter', 7],
    [{ choices: [{ message: { content: 'partial', tool_calls: [{ arguments: SECRET }] } }] }, 'tool_calls', 7],
    [{ choices: [{ message: { content: 'partial', function_call: { arguments: SECRET } } }] }, 'tool_calls', 7],
    [{ output_text: SECRET }, 'unknown', 0],
    [{ choices: [{ finish_reason: 'stop', message: { content: '' } }] }, 'stop', 0],
  ];
  for (const [envelope, status, characters] of cases) {
    const payload = JSON.stringify({ ...envelope, usage: tokenUsage('chat', 30, 5), [SECRET]: SECRET });
    const { provider, calls } = await upstream(t, payload);
    await assert.rejects(generateText(provider, { model: 'test', api: 'chat' }, prompt), error => {
      assertTransport(error.diagnostics, 'chat', payload);
      assert.equal(error.diagnostics.category, 'provider_protocol'); assert.equal(error.providerStatus, undefined);
      assert.equal(error.diagnostics.completionStatus, status); assert.equal(error.diagnostics.outputCharacters, characters);
      assert.equal(error.diagnostics.outputTokens, 30); assert.equal(error.diagnostics.reasoningTokens, 5);
      assert.ok(!error.message.includes(SECRET)); return true;
    });
    assert.deepEqual(calls.map(call => call.path), ['/v1/chat/completions']);
  }
});

test('SSE completion metadata includes known usage and retains local failure diagnostics', async t => {
  for (const api of ['responses', 'chat']) for (const incomplete of [false, true]) {
    const frame = api === 'responses'
      ? { type: incomplete ? 'response.incomplete' : 'response.completed', response: textEnvelope(api, 'exact ', tokenUsage(api, 12, 3)) }
      : { choices: [{ index: 0, delta: { content: 'exact ' }, finish_reason: incomplete ? 'length' : 'stop' }], usage: tokenUsage(api, 12, 3) };
    const payload = `data: ${JSON.stringify(frame)}\n\ndata: [DONE]\n\n`;
    const { provider, calls } = await upstream(t, payload, 'text/event-stream');
    const check = diagnostics => {
      assertTransport(diagnostics, api, payload, 'text/event-stream');
      assert.equal(diagnostics.completionStatus, api === 'responses' ? incomplete ? 'incomplete' : 'completed' : incomplete ? 'length' : 'stop');
      assert.equal(diagnostics.outputCharacters, 6); assert.equal(diagnostics.outputTokens, 12); assert.equal(diagnostics.reasoningTokens, 3);
    };
    if (incomplete) await assert.rejects(generateText(provider, { model: 'test', api }, prompt), error => { check(error.diagnostics); return true; });
    else { const result = await generateText(provider, { model: 'test', api }, prompt); assert.equal(result.text, 'exact '); check(result.diagnostics); }
    assert.equal(calls.length, 1);
  }
});

test('SSE cannot hide explicit noncompleted status or streamed refusal/tool requests', async t => {
  for (const [api, frame, status] of [
    ['responses', { type: 'response.completed', response: { status: 'failed', output_text: 'partial' } }, 'failed'],
    ['responses', { type: 'response.completed', response: { status: SECRET, output_text: 'partial' } }, 'unknown'],
    ['chat', { choices: [{ delta: { content: 'partial', refusal: SECRET }, finish_reason: 'stop' }] }, 'content_filter'],
    ['chat', { choices: [{ delta: { content: 'partial', tool_calls: [{ arguments: SECRET }] }, finish_reason: 'stop' }] }, 'tool_calls'],
  ]) {
    const payload = `data: ${JSON.stringify(frame)}\n\ndata: [DONE]\n\n`;
    const { provider, calls } = await upstream(t, payload, 'text/event-stream');
    await assert.rejects(generateText(provider, { model: 'test', api: api === 'responses' ? 'auto' : api }, prompt), error => {
      assertTransport(error.diagnostics, api, payload, 'text/event-stream');
      assert.equal(error.diagnostics.completionStatus, status);
      assert.ok(!error.message.includes(SECRET)); return true;
    });
    assert.equal(calls.length, 1);
  }
});

test('HTTP 200 error envelopes keep transport metadata without replay', async t => {
  const payload = JSON.stringify({ error: { message: SECRET, code: SECRET } });
  const { provider, calls } = await upstream(t, payload);
  await assert.rejects(generateText(provider, { model: 'test', api: 'auto' }, prompt), error => {
    assertTransport(error.diagnostics, 'responses', payload);
    assert.equal(error.diagnostics.category, 'provider_protocol');
    assert.equal(error.diagnostics.maxOutputTokens, 10000);
    assert.ok(!error.message.includes(SECRET)); return true;
  });
  assert.equal(calls.length, 1);
});

test('automatic endpoint fallback remains limited to HTTP 404/405/501', async t => {
  for (const status of [400, 401, 403, 404, 405, 429, 500, 501, 503]) {
    const chatPayload = JSON.stringify(textEnvelope('chat', 'fallback answer', tokenUsage('chat', 3, 0)));
    const { provider, calls } = await upstream(t, req => req.url.endsWith('/responses') ? JSON.stringify({ error: { message: SECRET } }) : chatPayload,
      'application/json', req => req.url.endsWith('/responses') ? status : 200);
    if ([404, 405, 501].includes(status)) {
      const result = await generateText(provider, { model: 'test', api: 'auto' }, prompt);
      assert.equal(result.api, 'chat'); assert.equal(result.text, 'fallback answer');
      assertTransport(result.diagnostics, 'chat', chatPayload);
      assert.deepEqual(calls.map(call => call.path), ['/v1/responses', '/v1/chat/completions']);
    } else {
      await assert.rejects(generateText(provider, { model: 'test', api: 'auto' }, prompt), error => { assert.equal(error.providerStatus, status); return true; });
      assert.deepEqual(calls.map(call => call.path), ['/v1/responses']);
    }
  }
});
