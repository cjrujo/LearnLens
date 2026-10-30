import test from 'node:test';
import assert from 'node:assert/strict';
import { configured, mockProvider, startApp, addProvider, setRoles, ok, rejected, lessonInput, KEY, EMPTY_ROLES } from './helpers.mjs';
import { starterPrimary, recommendationCatalog } from '../lib/setup.mjs';

const OPTIONS = { timeout: 15000 };
function advice(call, overrides = {}) {
  const text = call.json.input?.[0]?.content?.[0]?.text || call.json.messages.at(-1).content;
  const { candidates } = JSON.parse(text);
  const pick = model => candidates.find(c => c.model === model)?.candidateId ?? null;
  return JSON.stringify({ summary: 'A modest setup; verify endpoint compatibility.', roles: {
    primary: { candidateId: pick('manual-primary'), reason: 'Already chosen for lessons.', caveat: 'Check screenshot accuracy.' },
    transcription: { candidateId: pick('listed-transcribe'), reason: 'Likely transcription model.', caveat: 'Requires /audio/transcriptions.' },
    speech: { candidateId: pick('listed-speech'), reason: 'Likely speech model.', caveat: 'Check voice support.' },
  }, warnings: ['Availability is not verification.'], ...overrides });
}
async function discover(client, provider) { ok(await client.request(`/api/providers/${provider.id}/discover`, { method: 'POST', json: {} })); }
async function recommend(client, extra = {}) { return client.request('/api/roles/recommend', { method: 'POST', json: { consent: true, ...extra } }); }

test('thinking effort is optional and mapped correctly for Responses and Chat; invalid values reject atomically', OPTIONS, async t => {
  const { client, mock, roles } = await configured(t);
  for (const api of ['responses', 'chat']) for (const effort of ['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
    const requested = { ...roles.primary, api, reasoningEffort: effort };
    ok(await client.request('/api/roles', { method: 'PUT', json: { ...roles, primary: requested } }));
    ok(await client.request('/api/lessons', { method: 'POST', json: lessonInput() }));
    const wire = mock.calls.at(-1).json;
    if (api === 'responses') { assert.deepEqual(wire.reasoning, effort === 'default' ? undefined : { effort }); assert.equal(wire.reasoning_effort, undefined); }
    else { assert.equal(wire.reasoning_effort, effort === 'default' ? undefined : effort); assert.equal(wire.reasoning, undefined); assert.equal(wire.max_completion_tokens, 10000); }
  }
  const before = ok(await client.request('/api/state')).roles;
  for (const bad of ['auto', 'infinite', 3, null]) rejected(await client.request('/api/roles', { method: 'PUT', json: { ...roles, primary: { ...roles.primary, reasoningEffort: bad } } }));
  assert.deepEqual(ok(await client.request('/api/state')).roles, before);
});

test('unsupported reasoning effort produces one error without silent downgrade or endpoint retry', OPTIONS, async t => {
  const { client, mock, roles } = await configured(t, { api: 'auto', mock: { responsesStatus: 400 } });
  await setRoles(client, { ...roles, primary: { ...roles.primary, reasoningEffort: 'high' } });
  const response = await client.request('/api/lessons', { method: 'POST', json: lessonInput() });
  assert.equal(response.status, 502); assert.match(response.json.error, /thinking level/);
  assert.equal(mock.calls.length, 1); assert.deepEqual(mock.calls[0].json.reasoning, { effort: 'high' });
});

test('recommendations require consent, use the primary draft and return reviewable selections without saving or verifying them', OPTIONS, async t => {
  const { client, mock, provider, roles } = await configured(t, { mock: { models: [{ id: 'listed-speech' }, { id: 'listed-transcribe' }], outputText: advice } });
  await discover(client, provider); mock.calls.length = 0;
  rejected(await recommend(client, { consent: false })); assert.equal(mock.calls.length, 0);
  const primary = { ...roles.primary, api: 'responses', reasoningEffort: 'low' };
  const result = ok(await recommend(client, { primary }));
  assert.equal(result.suggestions.length, 3);
  assert.equal(result.suggestions.find(s => s.role === 'speech').selection.model, 'listed-speech');
  assert.equal(result.suggestions.find(s => s.role === 'primary').selection.reasoningEffort, 'low');
  assert.equal(mock.calls.length, 1); assert.deepEqual(mock.calls[0].json.reasoning, { effort: 'low' });
  const body = JSON.stringify(mock.calls[0].json);
  for (const privateValue of [KEY, mock.baseUrl, provider.id]) assert.ok(!body.includes(privateValue), 'Advisor payload must exclude keys, endpoints and internal provider IDs');
  const after = ok(await client.request('/api/state'));
  assert.deepEqual(after.roles, roles); assert.deepEqual(after.providers[0].checks, {});
  assert.match(result.warnings.join(' '), /not capability tests/);
});

test('advisor sees other provider catalogs only with all scope; invented candidates fail without changing roles', OPTIONS, async t => {
  const { client, mock, roles } = await configured(t, { mock: { outputText: advice } });
  const otherMock = await mockProvider(t, { models: [{ id: 'other-secret-model-name' }] });
  const other = await addProvider(client, otherMock, { name: 'Another provider' }); await discover(client, other);
  ok(await recommend(client)); assert.ok(!JSON.stringify(mock.calls.at(-1).json).includes('other-secret-model-name'));
  ok(await recommend(client, { scope: 'all' })); assert.ok(JSON.stringify(mock.calls.at(-1).json).includes('other-secret-model-name'));
  mock.config.outputText = call => { const result = JSON.parse(advice(call)); result.roles.speech.candidateId = 'invented'; return JSON.stringify(result); };
  assert.equal((await recommend(client)).status, 502);
  assert.deepEqual(ok(await client.request('/api/state')).roles, roles);
  mock.config.outputText = '{malformed'; assert.equal((await recommend(client)).status, 502);
});

test('bootstrap uses catalog presence or matching sample checks, and recommendation catalogs have a size bound', () => {
  const provider = { id: 'p', name: 'Test', models: [{ id: 'unknown' }], checks: {} };
  assert.equal(starterPrimary([provider]), null);
  provider.models.push({ id: 'gpt-5.4-mini' }); assert.equal(starterPrimary([provider]).role.model, 'gpt-5.4-mini');
  provider.models.pop(); provider.checks.unknown = { text: { status: 'verified', api: 'chat' }, vision: { status: 'verified', api: 'chat' } };
  assert.equal(starterPrimary([provider]).role.model, 'unknown');
  provider.models = Array.from({ length: 601 }, (_, i) => ({ id: 'm' + i }));
  assert.throws(() => recommendationCatalog([provider], EMPTY_ROLES, { providerId: 'p', model: 'm0' }, 'all', null), /maximum 600/);
});

test('provider edits keep IDs and role assignments, reset stale metadata and never forward a saved key to a new URL', OPTIONS, async t => {
  const { client, mock, provider, roles } = await configured(t);
  await discover(client, provider);
  const path = '/api/providers/' + provider.id;
  ok(await client.request(path, { method: 'PUT', json: { name: 'Renamed', baseUrl: mock.baseUrl, apiKey: '' } }));
  let state = ok(await client.request('/api/state'));
  assert.equal(state.providers[0].hasKey, true); assert.equal(state.providers[0].models.length, 1);
  rejected(await client.request(path, { method: 'PUT', json: { name: 'New host', baseUrl: 'https://example.com/v1', apiKey: '' } }));
  state = ok(await client.request('/api/state')); assert.equal(state.providers[0].baseUrl, mock.baseUrl);
  ok(await client.request(path, { method: 'PUT', json: { name: 'New host', baseUrl: 'https://example.com/v1', apiKey: 'explicit-new-key' } }));
  state = ok(await client.request('/api/state'));
  assert.equal(state.providers[0].id, provider.id); assert.equal(state.providers[0].hasKey, true); assert.deepEqual(state.providers[0].models, []); assert.deepEqual(state.providers[0].checks, {}); assert.deepEqual(state.roles, roles);
  assert.equal(mock.calls.length, 1, 'Editing does not call a provider.');
});

test('Kokoro is disabled unless operator-configured; browser cannot inject its own private endpoint', OPTIONS, async t => {
  const { client, mock, roles } = await configured(t);
  rejected(await client.request('/api/roles', { method: 'PUT', json: { ...roles, speech: { engine: 'kokoro', baseUrl: 'http://127.0.0.1:7777' } } }));
  assert.equal(ok(await client.request('/api/state')).speechServices.kokoro.available, false);
  assert.equal(mock.calls.length, 0);
});

test('configured Kokoro probes and generation use only the managed speech endpoint and preserve offline audio', OPTIONS, async t => {
  const primaryMock = await mockProvider(t), kokoroMock = await mockProvider(t);
  const app = await startApp(t, { kokoroBaseUrl: kokoroMock.baseUrl, kokoroApiKey: 'operator-secret' }); const client = await app.client();
  const primaryProvider = await addProvider(client, primaryMock);
  const roles = { ...EMPTY_ROLES, primary: { providerId: primaryProvider.id, model: 'primary', api: 'chat' }, speech: { engine: 'kokoro', model: 'kokoro', api: 'auto', voice: 'af_heart' } };
  await setRoles(client, roles);
  rejected(await client.request('/api/speech/kokoro/probe', { method: 'POST', json: {} })); assert.equal(kokoroMock.calls.length, 0);
  const probe = ok(await client.request('/api/speech/kokoro/probe', { method: 'POST', json: { consent: true, voice: 'af_heart' } })); assert.equal(probe.check.status, 'verified');
  const result = ok(await client.request('/api/lessons', { method: 'POST', json: lessonInput({ includeAudio: true }) })); assert.match(result.html, /data:audio\/wav;base64/);
  assert.ok(kokoroMock.calls.every(call => call.path.endsWith('/audio/speech') && call.json.model === 'kokoro' && call.json.voice === 'af_heart'));
  assert.ok(primaryMock.calls.every(call => !call.path.includes('audio/speech')));
  const state = ok(await client.request('/api/state')); assert.equal(state.speechServices.kokoro.checks.af_heart.status, 'verified');
  assert.ok(!JSON.stringify(state).includes('operator-secret')); assert.ok(!JSON.stringify(state).includes(kokoroMock.baseUrl));
  kokoroMock.config.speechStatus = 500;
  const degraded = ok(await client.request('/api/lessons', { method: 'POST', json: lessonInput({ includeAudio: true }) }));
  assert.match(degraded.warnings.join(' '), /Audio could not/); assert.doesNotMatch(degraded.html, /data:audio/);
  assert.ok(primaryMock.calls.every(call => !call.path.includes('audio/speech')), 'No silent fallback to cloud speech');
  ok(await client.request('/api/logout', { method: 'POST', json: {} }));
  assert.deepEqual(ok(await client.request('/api/state')).speechServices.kokoro.checks, {});
});
