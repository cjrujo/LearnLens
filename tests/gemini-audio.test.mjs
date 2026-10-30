import test from 'node:test';
import assert from 'node:assert/strict';
import { geminiAudioTarget, transcribeAudio } from '../lib/provider.mjs';
import { parseRecommendations, recommendationPrompt } from '../lib/setup.mjs';
import { KEY, WAV, TRANSCRIPT, EMPTY_ROLES, startApp, mockProvider, addProvider, setRoles, ok, noSecrets, rejected } from './helpers.mjs';

const OPTIONS = { timeout: 30_000, concurrency: false };
const audio = { mime: 'audio/wav', buffer: WAV };
const complete = parts => ({ candidates: [{ finishReason: 'STOP', content: { role: 'model', parts } }] });
const input = { dataUrl: 'data:audio/wav;base64,' + WAV.toString('base64'), consent: true };
async function setup(t) {
  const mock = await mockProvider(t), app = await startApp(t), client = await app.client();
  const provider = await addProvider(client, mock);
  const roles = { ...EMPTY_ROLES, transcription: { providerId: provider.id, model: 'gemini-audio-fixture', api: 'gemini' } };
  await setRoles(client, roles);
  return { mock, client, provider, roles };
}
const transcribe = (client, extra = {}) => client.request('/api/transcribe', { method: 'POST', json: { ...input, ...extra } });

test('Gemini target preserves provider origin/prefix, normalizes model and chooses only documented authentication', () => {
  for (const [base, expected] of [
    ['', '/v1beta'], ['/v1', '/v1beta'], ['/v1/', '/v1beta'], ['/v1beta', '/v1beta'],
    ['/custom/v1', '/custom/v1beta'], ['/custom/v1beta', '/custom/v1beta'],
    ['/v1beta/openai', '/v1beta'], ['/custom/v1beta/openai', '/custom/v1beta'],
  ]) {
    const original = { baseUrl: 'https://gateway.example' + base, apiKey: KEY, publicOnly: true };
    const target = geminiAudioTarget(original, 'models/gemini-audio-fixture');
    assert.equal(target.provider.baseUrl, 'https://gateway.example' + expected);
    assert.equal(target.provider.apiKey, KEY); assert.equal(target.provider.publicOnly, true);
    assert.equal(target.model, 'gemini-audio-fixture');
    assert.equal(target.path, '/models/gemini-audio-fixture:generateContent');
    assert.equal(target.authHeader, 'Authorization');
    assert.equal(original.baseUrl, 'https://gateway.example' + base, 'Never mutate primary/discovery base');
  }
  assert.equal(geminiAudioTarget({ baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai' }, 'gemini-test').authHeader, 'x-goog-api-key');
  for (const host of ['generativelanguage.googleapis.com.evil.example', 'proxy.example']) assert.equal(geminiAudioTarget({ baseUrl: 'https://' + host + '/v1' }, 'gemini-test').authHeader, 'Authorization');
  for (const model of ['..', '.', '../models/evil', 'models/../evil', 'a/b', 'a%2fb', 'a?key=secret', 'a#secret', 'a:streamGenerateContent', 'a\nheader']) assert.throws(() => geminiAudioTarget({ baseUrl: 'https://gateway.example/v1' }, model));
  for (const baseUrl of ['https://gateway.example/proxy', 'https://gateway.example/v2', 'https://gateway.example/v1?key=secret', 'https://name:secret@gateway.example/v1']) assert.throws(() => geminiAudioTarget({ baseUrl }, 'gemini-test'));
});

test('Gemini audio uses one consented native JSON request; scopes verification and rejects stale consent', OPTIONS, async t => {
  const { mock, client, roles } = await setup(t);
  assert.equal(mock.calls.length, 0, 'Saving native mode makes no paid/discovery requests');
  for (const consent of [undefined, false, 1, 'true']) rejected(await transcribe(client, { consent }));
  assert.equal(mock.calls.length, 0);
  const before = ok(await client.request('/api/state'));
  mock.config.geminiResponse = complete([{ text: 'private reasoning', thought: true }, { text: 'Hello ' }, { text: '世界', thought: false, thoughtSignature: 'opaque' }]);
  assert.deepEqual(ok(await transcribe(client, { expectedSetupRevision: before.setupRevision })), { text: 'Hello 世界' });
  assert.equal(mock.calls.length, 1);
  const call = mock.calls[0];
  assert.equal(call.path, '/custom/v1beta/models/gemini-audio-fixture:generateContent');
  assert.equal(call.method, 'POST'); assert.equal(call.headers.authorization, 'Bearer ' + KEY);
  assert.equal(call.headers['x-goog-api-key'], undefined);
  assert.match(call.headers['content-type'], /application\/json/);
  assert.deepEqual(call.json.contents, [{ role: 'user', parts: [{ text: 'Transcribe this audio segment.' }, { inlineData: { mimeType: 'audio/wav', data: WAV.toString('base64') } }] }]);
  assert.match(call.json.systemInstruction.parts[0].text, /untrusted source material/);
  assert.deepEqual(call.json.generationConfig, { candidateCount: 1, maxOutputTokens: 8192 });
  assert.equal(call.json.stream, undefined); assert.equal(call.json.model, undefined);
  const state = ok(await client.request('/api/state')); noSecrets(state);
  assert.equal(state.providers[0].baseUrl, mock.baseUrl);
  assert.equal(state.providers[0].checks['gemini-audio-fixture'].transcription.api, 'gemini');
  assert.equal(state.providers[0].checks['gemini-audio-fixture'].transcription.status, 'verified');
  await setRoles(client, { ...roles, transcription: { ...roles.transcription, api: 'auto' } });
  rejected(await transcribe(client, { expectedSetupRevision: state.setupRevision }));
  assert.equal(mock.calls.length, 1, 'Changing protocol invalidates previously consented setup');
  assert.equal(ok(await transcribe(client)).text, TRANSCRIPT);
  assert.equal(mock.calls.length, 2); assert.equal(mock.calls[1].path, '/custom/v1/audio/transcriptions');
  // Match a real managed three-minute 16 kHz mono segment, not just a tiny fixture.
  await setRoles(client, roles); delete mock.config.geminiResponse;
  const segment = Buffer.alloc(44 + 180 * 16000 * 2); WAV.copy(segment);
  segment.writeUInt32LE(segment.length - 8, 4); segment.writeUInt32LE(16000, 24);
  segment.writeUInt32LE(32000, 28); segment.writeUInt32LE(segment.length - 44, 40);
  assert.equal(ok(await transcribe(client, { dataUrl: 'data:audio/wav;base64,' + segment.toString('base64') })).text, TRANSCRIPT);
  assert.equal(mock.calls.length, 3);
  assert.deepEqual(Buffer.from(mock.calls[2].json.contents[0].parts[1].inlineData.data, 'base64'), segment);
  assert.ok(mock.calls[2].raw.length < 12 * 1024 * 1024);
});

test('Gemini native is transcription-only and rejects unsafe models before requests', OPTIONS, async t => {
  const { mock, client, provider, roles } = await setup(t);
  for (const name of ['primary', 'speech']) rejected(await client.request('/api/roles', { method: 'PUT', json: { ...roles, [name]: roles.transcription } }));
  for (const model of ['../x', 'a/b', 'a?x=1', 'a#x']) rejected(await client.request('/api/roles', { method: 'PUT', json: { ...roles, transcription: { ...roles.transcription, model } } }));
  const normalized = ok(await client.request('/api/roles', { method: 'PUT', json: { ...roles, transcription: { ...roles.transcription, model: 'models/gemini-audio-fixture' } } }));
  assert.deepEqual(normalized.roles, roles);
  await addProvider(client, mock, { name: 'Ambiguous base', baseUrl: mock.url + '/other' });
  const providers = ok(await client.request('/api/state')).providers;
  rejected(await client.request('/api/roles', { method: 'PUT', json: { ...roles, transcription: { ...roles.transcription, providerId: providers.find(p => p.id !== provider.id).id } } }));
  assert.equal(mock.calls.length, 0);
});

test('Gemini HTTP failures and invalid native responses stop after one call with safe protocol diagnostics', OPTIONS, async t => {
  const { mock, client } = await setup(t);
  const privateText = 'PRIVATE_AUDIO_CONTENT_MUST_NOT_APPEAR';
  for (const status of [400, 404, 405, 429, 500, 501]) {
    mock.config.geminiStatus = status;
    mock.config.geminiResponse = { error: { code: 'convert_request_failed', message: privateText + KEY } };
    const before = mock.calls.length, result = await transcribe(client);
    assert.equal(result.status, 502); assert.equal(mock.calls.length, before + 1, 'No protocol fallback, including 404/405/501');
    assert.equal(result.json.diagnostics.apiMode, 'gemini.generateContent');
    assert.equal(result.json.diagnostics.endpoint, '/models/{model}:generateContent');
    assert.equal(result.json.diagnostics.upstreamStatus, status);
    assert.equal(result.json.diagnostics.providerCode, 'convert_request_failed');
    assert.equal(result.json.diagnostics.automaticRetry, false);
    noSecrets(result.text, [KEY, privateText, WAV.toString('base64')]);
  }
  mock.config.geminiStatus = 200;
  const candidate = complete([{ text: privateText }]).candidates[0];
  const invalid = [null, [], {}, { text: privateText }, { candidates: [] }, { candidates: [null] },
    { promptFeedback: { blockReason: 'SAFETY', blockReasonMessage: privateText } },
    { candidates: [{ ...candidate, finishReason: 'MAX_TOKENS' }] },
    { candidates: [{ ...candidate, finishReason: 'SAFETY' }] },
    { candidates: [{ ...candidate, finishReason: undefined }] },
    { candidates: [candidate, candidate] },
    complete([{ text: privateText, thought: true }]), complete([{ text: ' ' }]),
    complete([{ text: '[NO_SPEECH]' }]), complete([{ text: 'x'.repeat(40_001) }]),
    complete([{ text: privateText, functionCall: { name: 'unexpected' } }]),
    complete([{ text: 123 }]), complete([null]), complete([{ text: privateText, thought: 'false' }]),
    { candidates: [{ ...candidate, content: { parts: 'invalid' } }] },
  ];
  for (const response of invalid) {
    mock.config.geminiResponse = response;
    const before = mock.calls.length, result = await transcribe(client);
    assert.equal(result.status, 502, JSON.stringify(response).slice(0, 100));
    assert.equal(mock.calls.length, before + 1);
    assert.equal(result.json.diagnostics.category, 'provider_protocol');
    assert.equal(result.json.diagnostics.upstreamStatus, 200);
    assert.equal(result.json.diagnostics.endpoint, '/models/{model}:generateContent');
    assert.equal(result.json.diagnostics.responseBodyOmitted, true);
    noSecrets(result.text, [KEY, privateText, WAV.toString('base64')]);
  }
  assert.equal(ok(await client.request('/api/state')).providers[0].checks['gemini-audio-fixture'], undefined, 'Failures never verify a capability');
});

test('Google native requests use the API-key header, never Bearer or query credentials', OPTIONS, async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify(complete([{ text: 'Local fixture only.' }])), { headers: { 'content-type': 'application/json' } });
  });
  const provider = { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', apiKey: KEY };
  assert.equal(await transcribeAudio(provider, { api: 'gemini', model: 'gemini-fixture' }, audio), 'Local fixture only.');
  assert.equal(calls.length, 1); assert.equal(calls[0].url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-fixture:generateContent');
  assert.equal(calls[0].options.headers['x-goog-api-key'], KEY);
  assert.equal(calls[0].options.headers.Authorization, undefined);
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].url.includes(KEY), false);
});

test('Gemini format/size and hosted private-address checks reject without network or retry', OPTIONS, async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('No fetch expected'); });
  const provider = { baseUrl: 'https://example.com/v1', apiKey: KEY }, role = { api: 'gemini', model: 'gemini-fixture' };
  for (const bad of [{ mime: 'audio/webm', buffer: WAV }, { mime: 'audio/wav', buffer: Buffer.concat([WAV, Buffer.alloc(8 * 1024 * 1024 + 1 - WAV.length)]) }, { mime: 'audio/wav', buffer: Buffer.from('not audio') }]) await assert.rejects(transcribeAudio(provider, role, bad), /prepared WAV/);
  await assert.rejects(transcribeAudio({ ...provider, baseUrl: 'https://127.0.0.1/v1', publicOnly: true }, role, audio), /private or local network/);
  assert.equal(calls, 0);
});

test('model recommendations explicitly review native STT mode, preserve prior mode and reject unknown protocols', () => {
  const candidates = [{ candidateId: 'c0', providerId: 'p', providerName: 'Fixture', model: 'gemini-test', checks: {} }];
  const item = { candidateId: null, reason: 'No change', caveat: '' };
  const value = { summary: 'Fixture advice', roles: { primary: item, speech: item, transcription: { ...item, candidateId: 'c0', api: 'gemini' } }, warnings: [] };
  const parse = (current = EMPTY_ROLES) => parseRecommendations(JSON.stringify(value), candidates, current, null, null);
  assert.equal(parse().suggestions.find(s => s.role === 'transcription').selection.api, 'gemini');
  delete value.roles.transcription.api;
  assert.equal(parse({ ...EMPTY_ROLES, transcription: { providerId: 'p', model: 'gemini-test', api: 'gemini' } }).suggestions.find(s => s.role === 'transcription').selection.api, 'gemini');
  assert.equal(parse().suggestions.find(s => s.role === 'transcription').selection.api, 'auto', 'No model-name inference');
  value.roles.transcription.api = 'realtime'; assert.throws(() => parse(), /invalid recommendations/);
  assert.match(recommendationPrompt(candidates).instructions, /inline WAV audio/);
});
