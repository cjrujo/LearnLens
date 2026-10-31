// Real native Kokoro + managed FFmpeg + full audio-plan API. Synthetic teaching
// text only, no cloud provider, operator .env, microphone or learner material.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { startNativeApplication } from '../deploy/native-start.mjs';
import { browserClient, ok } from './helpers.mjs';
process.env.LEARNLENS_MEDIA_OFFLINE = '1';
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, options) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('Full-audio native test forbids non-loopback networking.');
  return originalFetch(input, options);
};
const lesson = { title: 'Animals', subject: 'English', level: 'Primary', language: 'English', summary: 'Read and listen.', objectives: ['Listen carefully.'],
  sections: [{ type: 'quiz', title: 'Practice', body: 'A bird can fly.', items: [], question: 'Which animal can fly?', answer: 'A bird.', translation: '鸟会飞。', source: 'Synthetic test content' }], audio: [], warnings: ['Hand-authored test lesson, not a cloud-generated teaching assessment.'] };
let app;
try {
  app = await startNativeApplication({ env: { PATH: process.env.PATH, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, SYSTEMROOT: process.env.SYSTEMROOT,
    TEMP: process.env.TEMP, TMP: process.env.TMP, PORT: '0', LEARNLENS_SPEECH_OFFLINE: '1', LEARNLENS_SPEECH_CACHE: process.env.LEARNLENS_SPEECH_CACHE } });
  const client = await browserClient(app.origin);
  const state = ok(await client.request('/api/state'));
  assert.equal(state.roles.speech.engine, 'kokoro'); assert.deepEqual(state.providers, []);
  ok(await client.request('/api/audio/preflight', { method: 'POST', json: {}, timeout: 120000 }));
  const id = randomUUID(), root = '/api/audio/plans/' + id;
  ok(await client.request('/api/audio/plans', { method: 'POST', json: { id, lesson, expectedSources: ['source'], expectedSetupRevision: state.setupRevision } }));
  ok(await client.request(root + '/sources', { method: 'POST', json: { source: { key: 'source', text: 'Cat.\nDog.\nBird.\nFish.\nHorse.\nSheep.\nGoat.\nDuck.\nLion.\nTiger.', source: 'Synthetic original word list', extraction: 'text', coverage: 'complete', warnings: [] } } }));
  const plan = ok(await client.request(root + '/seal', { method: 'POST', json: {} }));
  assert.ok(plan.clips.length > 8);
  for (const [index, clip] of plan.clips.entries()) {
    const response = ok(await client.request(root + '/clips/' + clip.id, { method: 'POST', json: { consent: true, expectedSetupRevision: state.setupRevision, attemptId: randomUUID() }, timeout: 120000 }));
    assert.equal(response.clip.status, 'complete'); assert.equal(response.summary.completedClips, index + 1);
    console.log(`Native audio ${index + 1}/${plan.clips.length}`);
  }
  const exported = ok(await client.request(root + '/export', { timeout: 120000 }));
  assert.equal(exported.audioSummary.status, 'complete'); assert.equal(exported.audioSummary.completedClips, plan.clips.length);
  assert.ok(exported.audioSummary.bytes > 10000); assert.ok(exported.audioSummary.bytes < 4 * 1024 * 1024);
  assert.match(exported.html, /data:audio\/mpeg;base64,/); assert.doesNotMatch(exported.html, /data:audio\/wav;base64,/);
  assert.doesNotMatch(exported.html, /(?:src|href)="https?:/); assert.match(exported.html, /Synthetic original word list/);
  const first = plan.clips[0]; const reused = ok(await client.request(root + '/clips/' + first.id, { method: 'POST', json: { consent: true, expectedSetupRevision: state.setupRevision, attemptId: randomUUID() }, timeout: 120000 }));
  assert.equal(reused.clip.attempts, 1, 'Successful clip is reused, not resynthesized');
  await mkdir('artifacts', { recursive: true }); await writeFile('artifacts/native-full-audio-lesson.html', exported.html);
  await writeFile('artifacts/native-full-audio-summary.json', JSON.stringify({ ...exported.audioSummary, voice: state.roles.speech.voice, cloudCalls: 0, pronunciation: 'NOT_TESTED', decoder: 'Full FFmpeg MP3 decode per clip', htmlBytes: Buffer.byteLength(exported.html) }, null, 2));
  ok(await client.request('/api/logout', { method: 'POST', json: {} }));
  const missing = await client.request(root); assert.equal(missing.status, 404);
  console.log(`PASS: ${plan.clips.length} real native source/generated word/sentence clips, ${exported.audioSummary.bytes} MP3 bytes; cache reuse, private cleanup, single-file export. No cloud calls. Playback and pronunciation require separate evidence.`);
} finally { await app?.stop(); globalThis.fetch = originalFetch; }
