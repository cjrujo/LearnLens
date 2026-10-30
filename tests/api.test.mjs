import test from 'node:test';
import assert from 'node:assert/strict';
import {
  KEY, EMPTY_ROLES, PNG, PNG_URL, WAV, TRANSCRIPT,
  lessonSpec, lessonInput, sizedPng, request, startApp, mockProvider,
  ok, rejected, noSecrets, addProvider, setRoles, configured,
  assertProviderCall, validLesson, validCheck, multipartParts,
} from './helpers.mjs';

// Keep tests sequential: each gets fresh app/session state and ephemeral loopback providers.
const OPTIONS = { timeout: 30_000, concurrency: false };
const generate = (client, input = lessonInput()) => client.request('/api/lessons', { method: 'POST', json: input });
const state = async (client) => ok(await client.request('/api/state'), 'Read state');
const providerPath = (provider, action = '') => `/api/providers/${encodeURIComponent(provider.id)}${action}`;
const role = (provider, model, api = 'auto', extra = {}) => ({ providerId: provider.id, model, api, ...extra });
const noEmbeddedAudio = (html) => assert.doesNotMatch(html, /data:audio\/[^;,]+;base64,[A-Za-z0-9+/]/i);

// 1
test('browser sessions and createApp instances start empty, isolate providers, and redact keys', OPTIONS, async (t) => {
  const mock = await mockProvider(t);
  const app = await startApp(t);
  const alice = await app.client();
  const bob = await app.client();
  assert.notEqual(alice.cookie, bob.cookie, 'Independent browsers must receive different sessions.');
  for (const client of [alice, bob]) {
    const initial = await state(client);
    assert.deepEqual(initial.providers, []);
    assert.deepEqual(initial.roles, EMPTY_ROLES);
    assert.equal(initial.locked, false, 'The default local app is unlocked.');
  }

  const provider = await addProvider(alice, mock);
  const selected = { ...EMPTY_ROLES, primary: role(provider, 'private-manual-model', 'chat') };
  await setRoles(alice, selected);
  const ownState = await state(alice);
  assert.equal(ownState.providers.length, 1);
  assert.equal(ownState.providers[0].hasKey, true);
  noSecrets(ownState);
  assert.deepEqual((await state(bob)).providers, []);
  assert.deepEqual((await state(bob)).roles, EMPTY_ROLES);

  // Knowing another browser's provider ID must not permit use or deletion (IDOR).
  mock.calls.length = 0;
  for (const action of ['/discover', '/probe']) {
    const json = action === '/probe'
      ? { model: 'private-manual-model', kind: 'text', api: 'chat', consent: true } : {};
    rejected(await bob.request(providerPath(provider, action), { method: 'POST', json }), `Other session ${action}`);
  }
  rejected(await bob.request(providerPath(provider), { method: 'DELETE' }), 'Other session deletion');
  rejected(await bob.request('/api/roles', { method: 'PUT', json: selected }), 'Other session role selection');
  assert.equal(mock.calls.length, 0, 'Cross-session actions must not reach the provider.');
  assert.equal((await state(alice)).providers.length, 1);
  assert.deepEqual((await state(alice)).roles, selected);

  const otherApp = await startApp(t);
  const otherBrowser = await otherApp.client();
  assert.deepEqual((await state(otherBrowser)).providers, [], 'Factories must not share provider storage either.');
});

// 2
test('provider URLs are canonicalized; explicit listing preserves prefix/auth and never probes models', OPTIONS, async (t) => {
  const mock = await mockProvider(t, { models: [{ id: 'text-only-model' }, { id: 'another-manual-choice' }] });
  const app = await startApp(t);
  const client = await app.client();
  const provider = await addProvider(client, mock, { baseUrl: `${mock.baseUrl}///` });
  assert.equal(provider.baseUrl, mock.baseUrl, 'Strip trailing slashes without appending another /v1.');
  assert.equal(provider.hasKey, true);
  const listing = ok(await client.request(providerPath(provider, '/discover'), { method: 'POST', json: {} }));
  assert.deepEqual(listing.models.map((model) => model.id).sort(), ['another-manual-choice', 'text-only-model']);
  assert.ok(mock.calls.length >= 1);
  for (const call of mock.calls) assertProviderCall(call, mock, '/models');
  const saved = (await state(client)).providers.find((entry) => entry.id === provider.id);
  assert.deepEqual(saved.models.map((model) => model.id).sort(), listing.models.map((model) => model.id).sort());
  for (const checks of Object.values(saved.checks ?? {})) {
    for (const check of Object.values(checks)) {
      assert.notEqual(check.status, 'verified', '/models cannot verify endpoint or image capabilities.');
    }
  }
  noSecrets(saved);
});

// 3
test('empty/unsupported model listing still permits manual roles; deletion clears all references', OPTIONS, async (t) => {
  for (const modelsStatus of [200, 404]) {
    const mock = await mockProvider(t, { modelsStatus, models: [] });
    const app = await startApp(t);
    const client = await app.client();
    const provider = await addProvider(client, mock);
    const discovery = await client.request(providerPath(provider, '/discover'), { method: 'POST', json: {} });
    if (discovery.status >= 200 && discovery.status < 300) {
      assert.deepEqual(ok(discovery).models, []);
    } else {
      assert.equal(modelsStatus, 404, 'An empty successful listing is not a provider failure.');
      rejected(discovery, 'Unsupported /models', false);
    }
    const roles = {
      primary: role(provider, 'not-in-any-model-list', 'responses'),
      transcription: role(provider, 'manual-asr'),
      speech: role(provider, 'manual-tts', 'auto', { voice: 'fixture-voice' }),
    };
    await setRoles(client, roles);
    assert.deepEqual((await state(client)).roles, roles);
    for (const call of mock.calls) assertProviderCall(call, mock, '/models');
    assert.equal(ok(await client.request(providerPath(provider), { method: 'DELETE' })).ok, true);
    const afterDelete = await state(client);
    assert.deepEqual(afterDelete.providers, []);
    assert.deepEqual(afterDelete.roles, EMPTY_ROLES);
  }
});

// 4
test('explicit chat uses the fake provider and renders a complete LessonSpec with hostile fields escaped', OPTIONS, async (t) => {
  const attack = '</script><script>globalThis.__learnlensPwned=1</script><img src=x onerror=alert(1)>';
  const hostile = `Unsafe title ${attack} & "quoted"`;
  const spec = lessonSpec({
    title: hostile, summary: hostile, objectives: [hostile], warnings: [hostile],
    audio: [{ text: hostile, translation: hostile }],
  });
  spec.sections = spec.sections.map((section) => ({
    ...section, title: hostile, body: hostile, items: [hostile], question: hostile,
    answer: hostile, translation: hostile, source: `Provided notes ${hostile}`,
  }));
  const { client, mock, roles } = await configured(t, { api: 'chat', mock: { lesson: spec } });
  const input = lessonInput({ text: 'Unique source marker: 517693. Teach the notes, not a canned lesson.' });
  const result = validLesson(await generate(client, input));
  assert.equal(result.lesson.title, hostile, 'The mock model result, not a local placeholder, supplies the lesson.');
  assert.equal(mock.calls.length, 1);
  assertProviderCall(mock.calls[0], mock, '/chat/completions');
  assert.equal(mock.calls[0].json.model, roles.primary.model);
  assert.ok(JSON.stringify(mock.calls[0].json).includes(input.text), 'Forward the actual user material.');
  assert.ok(!JSON.stringify(mock.calls[0].json).includes('data:image/'), 'A text-only request must not acquire a probe image.');
  assert.ok(result.html.includes('Unsafe title'));
  assert.ok(!result.html.includes(attack));
  assert.doesNotMatch(result.html, /<script>globalThis\.__learnlensPwned|<img\s+src=x|<[^>]+\sonerror\s*=/i);
  assert.match(result.html, /&lt;\/script&gt;|&#(?:0*60|x0*3c);\/script|\\u003c\/script/i,
    'An adversarial closing script tag must be represented as text, never raw markup.');
  assert.match(result.html, /Provided notes/, 'Render source labels from the provided LessonSpec.');
  assert.match(result.html, /<details\b|<button\b|aria-expanded\s*=/i, 'Answers/hints need a reveal control.');
  noSecrets(result, [KEY, client.token, client.cookie]);
  noEmbeddedAudio(result.html);

  // Raw HTML and JSON scalars/arrays are not LessonSpecs; never treat them as executable output.
  for (const outputText of [`<html><script>globalThis.__learnlensPwned=1</script></html>`, '"not a LessonSpec"', '[]']) {
    mock.config.outputText = outputText;
    const invalid = await generate(client);
    rejected(invalid, 'Invalid provider LessonSpec', false);
    assert.equal(invalid.json?.html, undefined);
  }
});

// 5
test('auto tries Responses first; explicit Responses also uses its native wire shape without chat fallback', OPTIONS, async (t) => {
  const { client, mock, roles } = await configured(t, { api: 'auto' });
  for (const api of ['auto', 'responses']) {
    await setRoles(client, { ...roles, primary: { ...roles.primary, api } });
    mock.calls.length = 0;
    const result = validLesson(await generate(client));
    assert.equal(result.lesson.title, mock.config.lesson.title);
    assert.equal(mock.calls.length, 1, `${api} should not also call Chat after successful Responses.`);
    assertProviderCall(mock.calls[0], mock, '/responses');
    assert.equal(mock.calls[0].json.model, roles.primary.model);
  }
  mock.config.responsesStatus = 404;
  mock.calls.length = 0;
  rejected(await generate(client), 'Explicit Responses endpoint failure', false);
  assert.equal(mock.calls.length, 1, 'Only auto mode may switch protocol on an unsupported endpoint.');
  assertProviderCall(mock.calls[0], mock, '/responses');
});

// 6
test('auto falls back from Responses to Chat exactly for 404, 405 and 501', OPTIONS, async (t) => {
  const { client, mock } = await configured(t, { api: 'auto' });
  for (const status of [404, 405, 501]) {
    mock.config.responsesStatus = status;
    mock.calls.length = 0;
    validLesson(await generate(client));
    assert.deepEqual(mock.calls.map((call) => call.path), [
      `${mock.config.basePath}/responses`, `${mock.config.basePath}/chat/completions`,
    ], `Unexpected fallback order for HTTP ${status}`);
    assertProviderCall(mock.calls[0], mock, '/responses');
    assertProviderCall(mock.calls[1], mock, '/chat/completions');
  }
});

// 7
test('auto never falls back on authentication, rate-limit or upstream server errors (401/429/500)', OPTIONS, async (t) => {
  const { client, mock } = await configured(t, { api: 'auto' });
  for (const status of [401, 429, 500]) {
    mock.config.responsesStatus = status;
    mock.calls.length = 0;
    const response = await generate(client);
    rejected(response, `Upstream HTTP ${status}`, false);
    assert.ok(mock.calls.length >= 1, 'The fake Responses endpoint must actually be called.');
    for (const call of mock.calls) assertProviderCall(call, mock, '/responses');
    noSecrets(response.json);
  }
});

// 8
test('demo is a complete, clearly labelled local example with quizzes, no provider call and no generated audio', OPTIONS, async (t) => {
  const { client, mock } = await configured(t);
  const demo = validLesson(await client.request('/api/demo'));
  assert.ok(demo.lesson.sections.some((section) => section.type === 'quiz'));
  assert.match(JSON.stringify(demo), /hand[- ](?:authored|written)|demo|sample|example|示例|手工|人工/i);
  assert.match(demo.html, /<details\b|<button\b|aria-expanded\s*=/i);
  assert.equal(mock.calls.length, 0);
  noEmbeddedAudio(demo.html);
  noSecrets(demo, [KEY, client.token, client.cookie]);
});

// 9
test('text generation really calls the model; optional audio uses only the selected speech provider and embeds bytes', OPTIONS, async (t) => {
  const { client, mock, roles } = await configured(t);
  const speech = await mockProvider(t, { basePath: '/speech-proxy/v1' });
  const speechKey = 'separate-speech-provider-secret';
  const speechProvider = await addProvider(client, speech, { apiKey: speechKey, name: 'Separate speech provider' });
  const speechRole = role(speechProvider, 'manual-speech-model', 'auto', { voice: 'fixture-voice' });
  await setRoles(client, { ...roles, speech: speechRole });
  speech.calls.length = 0;

  const textOnly = validLesson(await generate(client, lessonInput({ includeAudio: false })));
  assert.equal(textOnly.lesson.title, mock.config.lesson.title);
  noEmbeddedAudio(textOnly.html);
  assert.equal(speech.calls.length, 0, 'Configuring speech must not make it mandatory or billable by itself.');
  const withAudio = validLesson(await generate(client, lessonInput({ includeAudio: true })));
  assert.equal(mock.calls.length, 2, 'Both generations must use the chosen text provider.');
  for (const call of mock.calls) assertProviderCall(call, mock, '/chat/completions');
  assert.equal(speech.calls.length, withAudio.lesson.audio.length);
  assert.ok(speech.calls.length > 0 && speech.calls.length <= 8);
  for (const [index, call] of speech.calls.entries()) {
    assertProviderCall(call, speech, '/audio/speech', speechKey);
    assert.equal(call.json.model, speechRole.model);
    assert.equal(call.json.voice, speechRole.voice);
    assert.equal(call.json.input, withAudio.lesson.audio[index].text);
  }
  assert.match(withAudio.html, /<audio\b/i);
  assert.match(withAudio.html, /data:audio\//i);
  assert.ok(withAudio.html.includes(WAV.toString('base64')), 'Embed actual bytes returned by the mock, not a remote audio URL.');
  assert.match(withAudio.html, /playbackRate/, 'Exported audio should support playback speed changes.');
  assert.match(withAudio.html, /0?\.75/);
  assert.match(withAudio.html, /0?\.5/);
  noSecrets(withAudio, [KEY, speechKey, client.token, client.cookie]);
});

// 10
test('missing speech selection rejects before billing; failing speech keeps the text lesson with warnings', OPTIONS, async (t) => {
  const { client, mock, provider, roles } = await configured(t);
  rejected(await generate(client, lessonInput({ includeAudio: true })), 'Select a speech role before requesting audio');
  assert.equal(mock.calls.length, 0, 'Do not incur generation charges for an invalid requested audio configuration.');

  await setRoles(client, { ...roles, speech: role(provider, 'failing-speech', 'auto', { voice: 'fixture-voice' }) });
  mock.config.speechStatus = 500;
  mock.calls.length = 0;
  const failedSpeech = validLesson(await generate(client, lessonInput({ includeAudio: true })));
  assert.equal(failedSpeech.lesson.title, mock.config.lesson.title);
  assert.ok(failedSpeech.warnings.length > 0, 'A speech failure must not silently claim successful audio.');
  noEmbeddedAudio(failedSpeech.html);
  const speechCalls = mock.calls.filter((call) => call.path.endsWith('/audio/speech'));
  assert.ok(speechCalls.length >= 1 && speechCalls.length <= 8);
  for (const call of speechCalls) assertProviderCall(call, mock, '/audio/speech');
});

// 11
test('transcription uploads decoded audio as multipart with selected model/key and records a real verification', OPTIONS, async (t) => {
  const { client, mock, provider, roles } = await configured(t);
  await setRoles(client, { ...roles, transcription: role(provider, 'manual-transcription-model') });
  const input = { dataUrl: `data:audio/wav;base64,${WAV.toString('base64')}`, name: 'voice-note.wav' };
  const result = ok(await client.request('/api/transcribe', { method: 'POST', json: input }));
  assert.equal(result.text, TRANSCRIPT);
  assert.equal(mock.calls.length, 1);
  const call = mock.calls[0];
  assertProviderCall(call, mock, '/audio/transcriptions');
  const parts = multipartParts(call);
  assert.equal(parts.get('model')?.body.toString('utf8'), 'manual-transcription-model');
  assert.equal(parts.get('file')?.filename, 'recording.wav', 'Use an anonymous filename with the verified MIME extension.');
  assert.deepEqual(parts.get('file')?.body, WAV, 'Send decoded bytes rather than the literal data URL.');
  assert.match(parts.get('file')?.headers ?? '', /content-type:\s*audio\/wav/i);
  const saved = (await state(client)).providers.find((entry) => entry.id === provider.id);
  validCheck(saved.checks?.['manual-transcription-model']?.transcription, 'verified');

  mock.calls.length = 0;
  rejected(await client.request('/api/transcribe', {
    method: 'POST', json: { name: 'not-audio.txt', dataUrl: 'data:text/plain;base64,aGVsbG8=' },
  }), 'Invalid transcription MIME');
  assert.equal(mock.calls.length, 0);
});

// 12
test('all paid probe kinds require literal consent:true; an explicit text probe carries no synthetic image', OPTIONS, async (t) => {
  const { client, mock, provider } = await configured(t, { mock: { outputText: 'OK' } });
  for (const kind of ['text', 'vision', 'speech']) {
    for (const consent of [undefined, false, 'true', 1, null]) {
      rejected(await client.request(providerPath(provider, '/probe'), {
        method: 'POST', json: { model: 'listed-text-only', kind, api: 'chat', consent },
      }), `${kind} probe with consent=${String(consent)}`);
      assert.equal(mock.calls.length, 0, 'Refused consent must prevent upstream requests, not just discard the result.');
    }
  }
  const probe = ok(await client.request(providerPath(provider, '/probe'), {
    method: 'POST', json: { model: 'listed-text-only', kind: 'text', api: 'chat', consent: true },
  }));
  validCheck(probe.check, 'verified');
  assert.equal(mock.calls.length, 1);
  assertProviderCall(mock.calls[0], mock, '/chat/completions');
  assert.equal(mock.calls[0].json.model, 'listed-text-only');
  const payload = JSON.stringify(mock.calls[0].json);
  assert.doesNotMatch(payload, /data:image\/|"image_url"|"input_image"/i);
  const saved = (await state(client)).providers.find((entry) => entry.id === provider.id);
  validCheck(saved.checks?.['listed-text-only']?.text, 'verified');
});

// 13
test('unsupported MIME, malformed or mismatched image data and more than five images fail before inference', OPTIONS, async (t) => {
  const { client, mock } = await configured(t);
  const cases = [
    ['GIF MIME', [{ name: 'x.gif', dataUrl: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///w==' }]],
    ['active SVG MIME', [{ name: 'x.svg', dataUrl: `data:image/svg+xml;base64,${Buffer.from('<svg onload="alert(1)"/>').toString('base64')}` }]],
    ['bad base64', [{ name: 'x.png', dataUrl: 'data:image/png;base64,@@@not-base64!!!' }]],
    ['not an image', [{ name: 'x.png', dataUrl: `data:image/png;base64,${Buffer.from('not really a PNG').toString('base64')}` }]],
    ['empty image', [{ name: 'x.png', dataUrl: 'data:image/png;base64,' }]],
    ['truncated signature', [{ name: 'x.png', dataUrl: `data:image/png;base64,${PNG.subarray(0, 4).toString('base64')}` }]],
    ['wrong encoding', [{ name: 'x.png', dataUrl: 'data:image/png,not-base64' }]],
    ['MIME/content mismatch', [{ name: 'x.jpg', dataUrl: PNG_URL.replace('image/png', 'image/jpeg') }]],
    ['non-string dataUrl', [{ name: 'x.png', dataUrl: 123 }]],
    ['six images', Array.from({ length: 6 }, (_, index) => ({ name: `${index}.png`, dataUrl: PNG_URL }))],
  ];
  for (const [label, images] of cases) {
    rejected(await generate(client, lessonInput({ images })), label);
    assert.equal(mock.calls.length, 0, `${label} must be rejected before sending data to a provider.`);
  }
});

// 14
test('valid images are sent only on explicit generation and warn when vision remains unverified', OPTIONS, async (t) => {
  const { client, mock } = await configured(t, { api: 'auto' });
  assert.equal(mock.calls.length, 0);
  const input = lessonInput({ images: [{ name: 'provided-notes.png', dataUrl: PNG_URL }] });
  const result = validLesson(await generate(client, input));
  assert.equal(mock.calls.length, 1);
  assertProviderCall(mock.calls[0], mock, '/responses');
  const payload = JSON.stringify(mock.calls[0].json);
  assert.ok(payload.includes(PNG_URL), 'Forward the submitted image to the selected model.');
  assert.ok(payload.includes(input.text));
  assert.ok(result.warnings.length > 0, 'An untested vision role needs a warning, not a fabricated capability claim.');
  assert.match(result.warnings.join(' '), /vision|image|视觉|图像|图片/i);
});

// 15
test('text, per-image, combined-image and total-body size limits reject before provider contact', OPTIONS, async (t) => {
  const { client, mock } = await configured(t);
  const MiB = 1024 * 1024;
  const cases = [
    ['40,000-character text limit', () => lessonInput({ text: 'x'.repeat(40_001) })],
    ['4 MiB per-image limit', () => lessonInput({ images: [{
      name: 'large.png', dataUrl: `data:image/png;base64,${sizedPng(4 * MiB + 1).toString('base64')}`,
    }] })],
    ['8 MiB combined decoded-image limit', () => {
      const dataUrl = `data:image/png;base64,${sizedPng(3 * MiB).toString('base64')}`;
      return lessonInput({ images: [1, 2, 3].map((index) => ({ name: `${index}.png`, dataUrl })) });
    }],
  ];
  for (const [label, input] of cases) {
    rejected(await generate(client, input()), label);
    assert.equal(mock.calls.length, 0, label);
  }
  rejected(await client.request('/api/lessons', {
    method: 'POST', raw: `{"text":"${'x'.repeat(13 * MiB)}"}`,
    headers: { 'content-type': 'application/json' },
  }), '13 MiB total HTTP body limit');
  assert.equal(mock.calls.length, 0);
});

// 16
test('invalid roles reject atomically; manual IDs and explicitly clearing primary remain supported', OPTIONS, async (t) => {
  const { client, mock, roles } = await configured(t);
  const badPrimaries = [
    { ...roles.primary, providerId: 'not-a-provider-in-this-session' },
    { ...roles.primary, model: '' },
    { ...roles.primary, model: 42 },
    { ...roles.primary, api: 'made-up-protocol' },
    { ...roles.primary, providerId: '' },
    'not-a-role-object',
  ];
  for (const primary of badPrimaries) {
    rejected(await client.request('/api/roles', { method: 'PUT', json: { ...roles, primary } }), 'Invalid primary role');
    assert.deepEqual((await state(client)).roles, roles, 'Reject invalid updates without partially changing saved roles.');
  }
  rejected(await client.request('/api/roles', {
    method: 'PUT', json: { ...roles, speech: { ...roles.primary, providerId: 'foreign-provider' } },
  }), 'Invalid optional role provider');
  assert.deepEqual((await state(client)).roles, roles);
  await setRoles(client, { ...EMPTY_ROLES });
  rejected(await generate(client), 'Generation without primary');
  assert.equal(mock.calls.length, 0);
});

// 17
test('API requires the matching browser cookie/CSRF pair, rejects foreign origins and non-JSON mutations', OPTIONS, async (t) => {
  const mock = await mockProvider(t);
  const app = await startApp(t);
  const alice = await app.client();
  const bob = await app.client();
  const providerBody = { name: 'Should not save', baseUrl: mock.baseUrl, apiKey: KEY };
  for (const [label, credentials] of [
    ['no CSRF token', { cookie: alice.cookie }],
    ['wrong token', { cookie: alice.cookie, token: 'wrong-token' }],
    ['no session cookie', { token: alice.token }],
    ['token from another browser', { cookie: alice.cookie, token: bob.token }],
  ]) {
    rejected(await request(`${app.url}/api/state`, credentials), label);
    rejected(await request(`${app.url}/api/providers`, { ...credentials, method: 'POST', json: providerBody }), label);
  }
  rejected(await request(`${app.url}/api/state?token=${encodeURIComponent(alice.token)}`, { cookie: alice.cookie }),
    'A query parameter must not replace the CSRF header');
  for (const origin of ['https://attacker.invalid', 'null']) {
    rejected(await alice.request('/api/state', { headers: { origin } }), `Foreign origin ${origin}`);
    rejected(await alice.request('/api/providers', {
      method: 'POST', json: providerBody, headers: { origin },
    }), `Foreign mutation origin ${origin}`);
  }
  for (const type of ['text/plain', 'application/x-www-form-urlencoded']) {
    rejected(await alice.request('/api/providers', {
      method: 'POST', raw: JSON.stringify(providerBody), headers: { 'content-type': type },
    }), `CSRF-prone content type ${type}`);
  }
  rejected(await alice.request('/api/providers', {
    method: 'POST', raw: '{"name":', headers: { 'content-type': 'application/json' },
  }), 'Malformed JSON');
  assert.deepEqual((await state(alice)).providers, []);
  assert.equal(mock.calls.length, 0);
});

// 18
test('unsafe provider URLs and remote providers without keys reject; a loopback provider may omit its key', OPTIONS, async (t) => {
  const mock = await mockProvider(t);
  const app = await startApp(t);
  const client = await app.client();
  const credentialsUrl = new URL(mock.baseUrl);
  credentialsUrl.username = 'embedded-user';
  credentialsUrl.password = 'embedded-password';
  const cases = [
    ['remote HTTP', 'http://remote.example.invalid/custom/v1', KEY],
    ['localhost suffix trick', 'http://localhost.attacker.invalid/v1', KEY],
    ['loopback suffix trick', 'http://127.0.0.1.attacker.invalid/v1', KEY],
    ['embedded credentials', credentialsUrl.href, KEY],
    ['unsupported FTP scheme', 'ftp://127.0.0.1/v1', KEY],
    ['local file URL', 'file:///tmp/provider', KEY],
    ['invalid URL', 'not a URL', KEY],
    ['remote HTTPS without API key', 'https://provider.example.invalid/v1', ''],
  ];
  for (const [label, baseUrl, apiKey] of cases) {
    rejected(await client.request('/api/providers', {
      method: 'POST', json: { name: label, baseUrl, apiKey },
    }), label);
  }
  assert.deepEqual((await state(client)).providers, []);
  assert.equal(mock.calls.length, 0);
  const local = await addProvider(client, mock, { apiKey: '' });
  assert.equal(local.hasKey, false);
  assert.equal(local.baseUrl, mock.baseUrl);
  noSecrets(await state(client));
});

// 19
test('optional password gate isolates login per browser; logout clears secrets and invalidates the old session', OPTIONS, async (t) => {
  const password = 'fixture-access-password-at-least-16-characters';
  const mock = await mockProvider(t);
  const app = await startApp(t, { accessPassword: password, publicOrigin: undefined });
  const alice = await app.client();
  const bob = await app.client();
  assert.equal((await state(alice)).locked, true);
  assert.equal((await state(bob)).locked, true);
  rejected(await alice.request('/api/providers', {
    method: 'POST', json: { name: 'Locked', baseUrl: mock.baseUrl, apiKey: KEY },
  }), 'Locked provider mutation');
  rejected(await generate(alice), 'Locked generation');
  rejected(await alice.request('/api/login', { method: 'POST', json: { password }, token: null }), 'Login without CSRF token');
  rejected(await alice.request('/api/login', { method: 'POST', json: { password: 'incorrect-password' } }), 'Wrong password');
  assert.equal((await state(alice)).locked, true);
  assert.equal(mock.calls.length, 0);

  rejected(await alice.request('/api/login', { method: 'POST', json: { password } }), 'Failed login imposes a cooldown');
  await new Promise(resolve => setTimeout(resolve, 2100));
  ok(await alice.request('/api/login', { method: 'POST', json: { password } }), 'Login');
  await alice.refresh(); // Accommodate session/CSRF rotation on successful authentication.
  assert.equal((await state(alice)).locked, false);
  const provider = await addProvider(alice, mock);
  assert.equal((await state(alice)).providers.length, 1);
  assert.equal((await state(bob)).locked, true, 'One browser logging in must not globally unlock the server.');
  noSecrets(await state(alice), [KEY, password]);

  ok(await bob.request('/api/login', { method: 'POST', json: { password } }), 'Second browser login');
  await bob.refresh();
  assert.equal((await state(bob)).locked, false);
  assert.deepEqual((await state(bob)).providers, [], 'Even authenticated browsers own independent provider/key stores.');
  rejected(await bob.request(providerPath(provider, '/discover'), { method: 'POST', json: {} }), 'Cross-session provider use');

  const oldCredentials = { cookie: alice.cookie, token: alice.token };
  ok(await alice.request('/api/logout', { method: 'POST', json: {} }), 'Logout');
  await alice.refresh();
  const afterLogout = await state(alice);
  assert.equal(afterLogout.locked, true);
  assert.deepEqual(afterLogout.providers, [], 'Logout must discard this browser’s credentials.');
  assert.deepEqual(afterLogout.roles, EMPTY_ROLES);
  const replay = await request(`${app.url}/api/state`, oldCredentials);
  if (replay.status >= 400) {
    rejected(replay, 'Invalidated session replay');
  } else {
    const replayState = ok(replay, 'Logged-out session replay');
    assert.equal(replayState.locked, true, 'A logged-out cookie/token pair must not remain authenticated.');
    assert.deepEqual(replayState.providers, []);
  }
  assert.equal((await state(bob)).locked, false, 'Logging out one browser must not log out another.');
});
