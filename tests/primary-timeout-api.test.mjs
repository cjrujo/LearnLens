import test from 'node:test';
import assert from 'node:assert/strict';
import { configured, setRoles, ok, rejected, lessonInput, lessonSpec, PNG_URL, WAV, KEY } from './helpers.mjs';
import { starterPrimary } from '../lib/setup.mjs';

const OPTIONS = { timeout: 15000 };
function deadlines(t) {
  const original = AbortSignal.timeout.bind(AbortSignal), values = [];
  t.mock.method(AbortSignal, 'timeout', ms => { values.push(ms); return original(ms); });
  return values;
}
const revision = async client => ok(await client.request('/api/state')).setupRevision;
const input = (extra = {}) => ({ text: 'Synthetic source sentence. '.repeat(150), images: [], goal: 'Explain accurately.', source: 'Fixture', consent: true, ...extra });

test('primary wait settings round-trip, reject invalid/non-primary values atomically, and never dispatch inference', OPTIONS, async t => {
  const { client, mock, roles } = await configured(t);
  for (const timeoutSeconds of [30, 300, 450, 600]) {
    const next = { ...roles, primary: { ...roles.primary, reasoningEffort: 'xhigh', timeoutSeconds } };
    await setRoles(client, next);
    assert.deepEqual(ok(await client.request('/api/state')).roles, next);
  }
  const before = ok(await client.request('/api/state'));
  for (const timeoutSeconds of [null, '300', '', 29, 601, 0, -1, 30.1, true, {}, []]) {
    rejected(await client.request('/api/roles', { method: 'PUT', json: { ...roles, primary: { ...roles.primary, timeoutSeconds } } }));
  }
  for (const name of ['transcription', 'speech']) {
    rejected(await client.request('/api/roles', { method: 'PUT', json: { ...roles, [name]: { providerId: roles.primary.providerId, model: 'audio-fixture', api: 'auto', timeoutSeconds: 600 } } }));
  }
  rejected(await client.request('/api/roles', { method: 'PUT', token: 'wrong-token', json: roles }));
  const after = ok(await client.request('/api/state'));
  assert.deepEqual(after.roles, before.roles); assert.equal(after.setupRevision, before.setupRevision);
  assert.equal(mock.calls.length, 0);
});

test('all primary material/teaching routes honor default or selected wait and preserve thinking and effective token budgets', OPTIONS, async t => {
  const { client, mock, roles } = await configured(t);
  const budgets = deadlines(t);
  for (const api of ['responses', 'chat']) for (const timeoutSeconds of [undefined, 30, 600]) {
    const primary = { ...roles.primary, api, reasoningEffort: 'low', ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }) };
    await setRoles(client, { ...roles, primary });
    const expectedSetupRevision = await revision(client), before = budgets.length, callBefore = mock.calls.length;
    mock.config.outputText = JSON.stringify({ notes: 'Accepted study notes.', warnings: [] });
    ok(await client.request('/api/materials/summarize', { method: 'POST', json: input({ expectedSetupRevision }) }));
    mock.config.outputText = JSON.stringify({ text: 'Original English words.', coverage: 'complete', warnings: [] });
    ok(await client.request('/api/audio/extract', { method: 'POST', json: { image: { dataUrl: PNG_URL }, consent: true, expectedSetupRevision } }));
    mock.config.outputText = JSON.stringify(lessonSpec());
    ok(await client.request('/api/lessons', { method: 'POST', json: lessonInput({ expectedSetupRevision }) }));
    assert.deepEqual(budgets.slice(before), Array(3).fill((timeoutSeconds ?? 300) * 1000));
    const calls = mock.calls.slice(callBefore);
    assert.equal(calls.length, 3);
    assert.deepEqual(calls.map(call => call.json[api === 'responses' ? 'max_output_tokens' : 'max_completion_tokens']), [2000, 10000, 10000]);
    for (const call of calls) {
      assert.equal(api === 'responses' ? call.json.reasoning.effort : call.json.reasoning_effort, 'low');
      assert.equal(call.json.timeoutSeconds, undefined); assert.equal(call.json.timeout, undefined);
    }
  }
});

test('primary wait changes invalidate old consent revisions; local short text never starts a provider timer', OPTIONS, async t => {
  const { client, mock, roles } = await configured(t);
  const oldRevision = await revision(client), budgets = deadlines(t);
  await setRoles(client, { ...roles, primary: { ...roles.primary, timeoutSeconds: 600 } });
  for (const [path, body] of [
    ['/api/materials/summarize', input()],
    ['/api/audio/extract', { image: { dataUrl: PNG_URL }, consent: true }],
    ['/api/lessons', lessonInput()],
  ]) {
    assert.equal((await client.request(path, { method: 'POST', json: { ...body, expectedSetupRevision: oldRevision } })).status, 409);
    rejected(await client.request(path, { method: 'POST', json: { ...body, consent: false, expectedSetupRevision: await revision(client) } }));
  }
  const text = 'Exact original source '.padEnd(2110, 'x');
  const result = ok(await client.request('/api/materials/summarize', { method: 'POST', json: input({ text, expectedSetupRevision: await revision(client) }) }));
  assert.equal(result.text, text); assert.equal(result.preparationMode, 'verbatim');
  assert.deepEqual(budgets, []); assert.equal(mock.calls.length, 0);
});

test('timeout metadata crosses the API boundary safely; a saved wait change alone permits only an explicit new request', OPTIONS, async t => {
  const { client, mock, roles } = await configured(t, { api: 'auto' });
  await setRoles(client, { ...roles, primary: { ...roles.primary, reasoningEffort: 'low', timeoutSeconds: 450 } });
  const original = AbortSignal.timeout.bind(AbortSignal); let controller;
  t.mock.method(AbortSignal, 'timeout', ms => ms === 450000 ? (controller = new AbortController()).signal : original(ms));
  mock.config.beforeResponse = () => { controller.abort(new DOMException('Synthetic elapsed deadline', 'TimeoutError')); return new Promise(() => {}); };
  const response = await client.request('/api/materials/summarize', { method: 'POST', json: input({ expectedSetupRevision: await revision(client) }) });
  assert.equal(response.status, 504);
  const d = response.json.diagnostics;
  assert.equal(d.timeoutMs, 450000); assert.equal(d.timeoutPhase, 'response_headers');
  assert.equal(d.stage, 'source_preparation'); assert.equal(d.category, 'timeout'); assert.equal(d.automaticRetry, false);
  assert.equal(d.thinking, 'low'); assert.equal(d.maxOutputTokens, 2000); assert.equal(d.upstreamStatus, undefined);
  assert.ok(!JSON.stringify(response.json).includes(KEY)); assert.ok(!JSON.stringify(response.json).includes(input().text));
  assert.equal(mock.calls.length, 1);
  const previousRevision = await revision(client);
  await setRoles(client, { ...roles, primary: { ...roles.primary, reasoningEffort: 'low', timeoutSeconds: 600 } });
  assert.equal(mock.calls.length, 1, 'Saving settings must not retry the failed request');
  assert.equal((await client.request('/api/materials/summarize', { method: 'POST', json: input({ expectedSetupRevision: previousRevision }) })).status, 409);
  mock.config.beforeResponse = undefined;
  mock.config.outputText = JSON.stringify({ notes: 'Complete notes.', warnings: [] });
  ok(await client.request('/api/materials/summarize', { method: 'POST', json: input({ expectedSetupRevision: await revision(client) }) }));
  assert.equal(mock.calls.length, 2);
});

test('probes use draft wait settings and record timeout-scoped checks without changing saved roles', OPTIONS, async t => {
  const { client, mock, provider, roles } = await configured(t);
  mock.config.models = [{ id: roles.primary.model }];
  ok(await client.request(`/api/providers/${provider.id}/discover`, { method: 'POST', json: {} }));
  mock.calls.length = 0;
  const budgets = deadlines(t), primary = { ...roles.primary, timeoutSeconds: 600, reasoningEffort: 'xhigh' };
  mock.config.outputText = 'green';
  for (const kind of ['text', 'vision']) {
    const result = ok(await client.request(`/api/providers/${provider.id}/probe`, { method: 'POST', json: { ...primary, kind, consent: true } }));
    assert.equal(result.check.status, 'verified'); assert.equal(result.check.timeoutSeconds, 600); assert.equal(result.check.reasoningEffort, 'xhigh');
  }
  assert.deepEqual(budgets, [600000, 600000]);
  let state = ok(await client.request('/api/state'));
  assert.deepEqual(state.roles, roles); assert.equal(state.starter.role.timeoutSeconds, 600);
  state.providers[0].checks[primary.model].vision.timeoutSeconds = 30;
  assert.equal(starterPrimary(state.providers), null, 'Mismatched wait-limit checks are not a verified starter pair');
  rejected(await client.request(`/api/providers/${provider.id}/probe`, { method: 'POST', json: { ...primary, timeoutSeconds: 601, kind: 'text', consent: true } }));
  assert.equal(mock.calls.length, 2);
});

test('advisor uses the primary draft wait and preserves it even for a new model; model output cannot override it', OPTIONS, async t => {
  const { client, mock, provider, roles } = await configured(t, { mock: { models: [{ id: 'alternate-model' }] } });
  ok(await client.request(`/api/providers/${provider.id}/discover`, { method: 'POST', json: {} }));
  await setRoles(client, { ...roles, primary: { ...roles.primary, timeoutSeconds: 600, reasoningEffort: 'xhigh' } });
  const before = ok(await client.request('/api/state')).roles, budgets = deadlines(t);
  mock.config.outputText = call => {
    const { candidates } = JSON.parse(call.json.messages.at(-1).content);
    return JSON.stringify({ summary: 'Synthetic advice only.', roles: {
      primary: { candidateId: candidates.find(c => c.model === 'alternate-model').candidateId, timeoutSeconds: 12000, reason: 'Review another fixture model.', caveat: 'Not verified.' },
      transcription: { candidateId: null, reason: 'No compatible fixture.', caveat: '' },
      speech: { candidateId: null, reason: 'No compatible fixture.', caveat: '' },
    }, warnings: [] });
  };
  const result = ok(await client.request('/api/roles/recommend', { method: 'POST', json: { primary: { ...before.primary, timeoutSeconds: 450 }, consent: true } }));
  assert.deepEqual(budgets, [450000]);
  assert.equal(result.advisor.timeoutSeconds, 450);
  assert.equal(result.suggestions.find(s => s.role === 'primary').selection.timeoutSeconds, 450);
  assert.equal(result.suggestions.find(s => s.role === 'primary').selection.model, 'alternate-model');
  assert.equal(mock.calls.at(-1).json.reasoning_effort, 'xhigh');
  assert.deepEqual(ok(await client.request('/api/state')).roles, before);
});

test('unexpected native HTTP upgrade releases the session job for a subsequent consented request', OPTIONS, async t => {
  const { client, mock, roles } = await configured(t);
  await setRoles(client, { ...roles, primary: { ...roles.primary, timeoutSeconds: 600 } });
  const originalHandler = mock.server.listeners('request')[0];
  mock.server.removeAllListeners('request');
  let upgraded = false, socket;
  mock.server.on('request', async (req, res) => {
    if (upgraded) return originalHandler(req, res);
    upgraded = true; socket = req.socket;
    for await (const _chunk of req) { /* drain synthetic input */ }
    res.writeHead(101, { Connection: 'Upgrade', Upgrade: 'synthetic-fixture' }); res.flushHeaders();
  });
  try {
    const failure = await client.request('/api/lessons', { method: 'POST', json: lessonInput(), timeout: 1500 });
    assert.equal(failure.status, 502); assert.match(failure.json.error, /unsupported HTTP protocol upgrade/);
    assert.equal(failure.json.diagnostics.automaticRetry, false);
    assert.equal(mock.calls.length, 0, 'No fallback/replay after an upgrade');
    ok(await client.request('/api/lessons', { method: 'POST', json: lessonInput() }));
    assert.equal(mock.calls.length, 1, 'The failed request no longer blocks this session');
  } finally { socket?.destroy(); }
});

test('long primary wait never changes discovery, transcription or legacy speech deadlines', OPTIONS, async t => {
  const { client, mock, provider, roles } = await configured(t);
  await setRoles(client, { primary: { ...roles.primary, timeoutSeconds: 600 },
    transcription: { providerId: provider.id, model: 'synthetic-asr', api: 'auto' },
    speech: { providerId: provider.id, model: 'synthetic-tts', api: 'auto', voice: 'alloy' } });
  const budgets = deadlines(t);
  ok(await client.request(`/api/providers/${provider.id}/discover`, { method: 'POST', json: {} }));
  ok(await client.request('/api/transcribe', { method: 'POST', json: { dataUrl: `data:audio/wav;base64,${WAV.toString('base64')}`, consent: true } }));
  ok(await client.request('/api/lessons', { method: 'POST', json: lessonInput({ includeAudio: true }) }));
  assert.deepEqual(budgets, [20000, 100000, 600000, 100000, 100000]);
  assert.equal(mock.calls.length, 5);
});
