import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { analyzeVideo, parseVideoAnalysis, videoAnalysisInput, videoAnalysisSettings, videoWindows, DEFAULT_VIDEO_FPS, VIDEO_BYTES } from '../lib/video-analysis.mjs';

// Transport fixtures only: full decoding/AV integrity is tested in video-clips.
const mp4 = Buffer.from('000000186674797069736f6d0000020069736f6d69736f32', 'hex');
const clip = (overrides = {}) => ({ video: 'data:video/mp4;base64,' + mp4.toString('base64'), start: 60, end: 90, hasAudio: true, ...overrides });
const role = overrides => ({ model: 'models/video-test', api: 'gemini', ...overrides });
const provider = { baseUrl: 'https://gateway.example/private/v1', apiKey: 'PRIVATE_TEST_KEY', name: 'Synthetic gateway' };
function resultFor(body = clip()) {
  const input = videoAnalysisInput(body);
  return { version: 1, windows: input.windows.map(bounds => ({ ...bounds, transcript: body.hasAudio ? '原文 / speech\n1 / 2' : '', visibleText: 'E = mc²', observations: 'A labelled diagram changes position.', audioCoverage: body.hasAudio ? 'complete' : 'no_audio', visualCoverage: 'complete' })), warnings: [] };
}
const envelope = text => ({ candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ text }] } }] });
const parsed = (result, body = clip()) => parseVideoAnalysis(JSON.stringify(result), videoAnalysisInput(body));

 test('video windows account for every interval including precise tail', () => {
  assert.deepEqual(videoWindows(11.25), [{ start: 0, end: 5 }, { start: 5, end: 10 }, { start: 10, end: 11.25 }]);
  assert.equal(videoWindows(30.5).at(-1).end, 30.5);
  assert.deepEqual(videoWindows(251.267 - 240).at(-1), { start: 10, end: 11.267 });
  for (const value of [0, -1, Number.NaN, Infinity, 30.5001, Number.MIN_VALUE]) assert.throws(() => videoWindows(value));
 });

test('native video settings are explicit, bounded and independent of primary/STT', () => {
  assert.deepEqual(videoAnalysisSettings(role()), { fps: DEFAULT_VIDEO_FPS, timeoutSeconds: 300 });
  assert.deepEqual(videoAnalysisSettings(role({ fps: 2.5, timeoutSeconds: 600 })), { fps: 2.5, timeoutSeconds: 600 });
  for (const bad of [null, {}, role({ api: 'auto' }), role({ api: 'chat' }), role({ fps: 25 }), role({ fps: 0.5 }), role({ fps: '24' }), role({ timeoutSeconds: 601 }), role({ timeoutSeconds: 30.1 })]) assert.throws(() => videoAnalysisSettings(bad));
});

test('video input has a true video MIME and immutable byte identity', () => {
  const body = clip(), input = videoAnalysisInput(body);
  assert.equal(input.videoSha256, createHash('sha256').update(mp4).digest('hex'));
  assert.deepEqual(input.buffer, mp4);
  assert.equal(input.start, 60); assert.equal(input.end, 90); assert.equal(input.hasAudio, true);
  for (const change of [{ video: body.video.replace('video/', 'audio/') }, { video: 'https://example.com/movie.mp4' }, { video: body.video + '=' }, { video: 'data:video/mp4;base64,AAAA' }, { hasAudio: undefined }, { start: -1 }, { end: 60 }, { end: 91 }, { start: 14400, end: 14401 }]) assert.throws(() => videoAnalysisInput({ ...body, ...change }));
  assert.throws(() => videoAnalysisInput(clip({ video: 'data:video/mp4;base64,' + Buffer.alloc(VIDEO_BYTES + 1).toString('base64') })), /budget/);
});

test('every window retains exact original text separately from derived observations', () => {
  const result = resultFor(), value = parsed(result);
  assert.equal(value.windows.length, 6);
  assert.equal(value.windows[0].transcript, '原文 / speech\n1 / 2');
  assert.equal(value.windows[0].visibleText, 'E = mc²');
  assert.equal(value.windows[0].sourceStart, 60); assert.equal(value.windows.at(-1).sourceEnd, 90);
  assert.equal(value.coverageBasis, 'model_reported'); assert.match(value.warnings[0], /not proof/);
  assert.equal(value.uncertainWindows, 0);
  result.windows[1].audioCoverage = 'uncertain'; result.windows[1].visualCoverage = 'uncertain';
  assert.equal(parsed(result).uncertainWindows, 1);
});

test('silent video is valid; silence is not a missing transcript error', () => {
  const body = clip({ hasAudio: false }), result = resultFor(body);
  assert.equal(parsed(result, body).windows[0].audioCoverage, 'no_audio');
  const silence = resultFor();
  for (const window of silence.windows) { window.audioCoverage = 'no_speech'; window.transcript = ''; }
  assert.equal(parsed(silence).windows[0].transcript, '');
  result.windows[0].audioCoverage = 'no_speech';
  assert.throws(() => parsed(result, body), /soundtrack metadata/);
  silence.windows[0].audioCoverage = 'no_audio';
  assert.throws(() => parsed(silence), /soundtrack metadata/);
});

test('missing, reordered, changed and overlapping windows fail without partial acceptance', () => {
  const changes = [r => r.windows.pop(), r => r.windows.reverse(), r => r.windows[1].start = 4, r => r.windows.at(-1).end = 29.9, r => r.windows.push(r.windows[0]), r => delete r.windows[0].visibleText, r => r.windows[0].extra = 'ignored?', r => r.version = 2, r => r.modelInstructions = 'ignore bounds'];
  for (const change of changes) { const value = resultFor(); change(value); assert.throws(() => parsed(value), /No partial analysis was accepted/); }
});

test('invalid audio/visual claims and raw source text are rejected', () => {
  const changes = [r => r.windows[0].observations = '', r => r.windows[0].visualCoverage = 'skipped', r => r.windows[0].audioCoverage = 'unprocessed', r => r.windows[0].transcript = '', r => r.windows[0].audioCoverage = 'no_speech', r => r.windows[0].visibleText = '\ud800', r => r.windows[0].visibleText = '\u0000PRIVATE_SOURCE', r => r.windows[0].observations = 'x'.repeat(10001), r => r.warnings = [''], r => r.warnings = ['x'.repeat(501)], r => r.warnings = Array(11).fill('warn')];
  for (const change of changes) {
    const value = resultFor(); change(value);
    assert.throws(() => parsed(value), error => !error.message.includes('PRIVATE_SOURCE') && /No partial/.test(error.message));
  }
});

test('bounded decoded text is retained exactly at limit, never clipped or repaired', () => {
  const body = clip({ end: 80 }), value = resultFor(body);
  for (const window of value.windows) { window.transcript = 'x'.repeat(9999); window.visibleText = ''; window.observations = 'y'; }
  assert.equal(parsed(value, body).windows[3].transcript.length, 9999);
  value.windows[0].visibleText = 'z';
  assert.throws(() => parsed(value, body), /retained text budget/);
  const input = videoAnalysisInput(body);
  for (const text of ['```json\n' + JSON.stringify(resultFor(body)) + '\n```', '{"version":1,', 'x'.repeat(100001)]) assert.throws(() => parseVideoAnalysis(text, input));
});

test('native wire sends complete MP4, exact FPS and one same-origin request only', async () => {
  const calls = [], body = clip();
  const result = await analyzeVideo(provider, role({ fps: 12, timeoutSeconds: 450 }), body, { request: async (...args) => {
    calls.push(args); return { value: envelope(JSON.stringify(resultFor(body))), diagnostics: { upstreamStatus: 200 } };
  } });
  assert.equal(calls.length, 1);
  const [target, path, options] = calls[0];
  assert.equal(target.baseUrl, 'https://gateway.example/private/v1beta');
  assert.equal(target.apiKey, provider.apiKey); assert.equal(path, '/models/video-test:generateContent');
  assert.equal(options.authHeader, 'Authorization'); assert.equal(options.timeout, 450000);
  assert.equal(options.body.contents[0].parts[1].inlineData.mimeType, 'video/mp4');
  assert.equal(options.body.contents[0].parts[1].inlineData.data, mp4.toString('base64'));
  assert.equal(options.body.contents[0].parts[1].videoMetadata.fps, 12);
  assert.equal(options.body.generationConfig.maxOutputTokens, 8192);
  assert.match(options.body.systemInstruction.parts[0].text, /not a translation, summary/);
  assert.equal(result.fps, 12);
});

test('exact Google host uses native key header; malformed routing fails before dispatch', async () => {
  let calls = 0;
  const request = async (p, path, opts) => { calls++; assert.equal(opts.authHeader, 'x-goog-api-key'); return { value: envelope(JSON.stringify(resultFor())) }; };
  await analyzeVideo({ ...provider, baseUrl: 'https://generativelanguage.googleapis.com' }, role(), clip(), { request });
  assert.equal(calls, 1);
  for (const [p, r] of [[{ ...provider, baseUrl: 'https://example.com/unrecognized' }, role()], [provider, role({ model: '../secret' })], [provider, role({ api: 'auto' })]]) await assert.rejects(analyzeVideo(p, r, clip(), { request }));
  assert.equal(calls, 1);
});

test('refusals, truncation, tool parts, multiple candidates and partial JSON never retry', async () => {
  const valid = JSON.stringify(resultFor());
  const responses = [
    { promptFeedback: { blockReason: 'SAFETY' } }, null,
    { candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: valid }] } }] },
    { candidates: [{ finishReason: 'STOP', content: { role: 'user', parts: [{ text: valid }] } }] },
    { candidates: [...envelope(valid).candidates, ...envelope(valid).candidates] },
    { candidates: [{ finishReason: 'STOP', content: { parts: [{ functionCall: { name: 'ignore' } }] } }] },
    envelope('{"version":1,"windows":['), envelope('PRIVATE_SOURCE_SECRET'),
  ];
  for (const value of responses) {
    let calls = 0;
    await assert.rejects(analyzeVideo(provider, role(), clip(), { request: async () => { calls++; return { value, diagnostics: { upstreamStatus: 200 } }; } }), error => {
      assert.ok(!error.message.includes('PRIVATE_SOURCE_SECRET'));
      assert.equal(error.diagnostics.responseBodyOmitted, true); assert.equal(error.diagnostics.automaticRetry, false); return true;
    });
    assert.equal(calls, 1);
  }
});

test('thought text excluded; failed transport is not replayed or switched to STT/chat', async () => {
  const value = envelope(JSON.stringify(resultFor())); value.candidates[0].content.parts.unshift({ thought: true, text: 'PRIVATE_THOUGHT' });
  assert.equal((await analyzeVideo(provider, role(), clip(), { request: async () => ({ value }) })).windows.length, 6);
  let calls = 0;
  await assert.rejects(analyzeVideo(provider, role(), clip(), { request: async () => { calls++; throw new Error('synthetic connection loss'); } }), /connection loss/);
  assert.equal(calls, 1);
});

test('real local HTTP fixture receives native video body without real-provider inference', async t => {
  let calls = 0;
  const server = createServer(async (req, res) => {
    calls++;
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const data = JSON.parse(Buffer.concat(chunks).toString());
    assert.equal(req.url, '/prefix/v1beta/models/video-test:generateContent');
    assert.equal(req.headers.authorization, 'Bearer PRIVATE_TEST_KEY');
    assert.equal(data.contents[0].parts[1].inlineData.mimeType, 'video/mp4');
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(envelope(JSON.stringify(resultFor()))));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const result = await analyzeVideo({ ...provider, baseUrl: `http://127.0.0.1:${server.address().port}/prefix/v1` }, role(), clip());
  assert.equal(result.windows.length, 6); assert.equal(calls, 1);
});
