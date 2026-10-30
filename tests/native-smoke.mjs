// Real native Kokoro test. Run setup:speech once first; this run requires a valid
// local cache, disables worker networking and uses ONLY a loopback lesson fixture.
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { startNativeApplication } from '../deploy/native-start.mjs';
import { browserClient, ok, lessonInput, lessonSpec } from './helpers.mjs';
let app, fixture;
try {
  fixture = http.createServer(async (request, response) => {
    for await (const _chunk of request) { /* no cloud requests or credentials */ }
    const lesson = lessonSpec({ title: 'Native Kokoro offline test', summary: 'Hand-authored demonstration lesson with real native Kokoro speech. No cloud model was used.', audio: [{ text: 'Welcome to LearnLens. This speech was generated locally, without Docker.', translation: '' }], warnings: ['Demonstration lesson text, not real AI lesson generation.'] });
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(lesson) } }] }));
  });
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  // Intentionally do NOT load the operator .env or its credentials.
  app = await startNativeApplication({ env: { PATH: process.env.PATH, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, SYSTEMROOT: process.env.SYSTEMROOT, TEMP: process.env.TEMP, TMP: process.env.TMP, PORT: '0', LEARNLENS_SPEECH_OFFLINE: '1', LEARNLENS_SPEECH_CACHE: process.env.LEARNLENS_SPEECH_CACHE } });
  const client = await browserClient(app.origin);
  let state = ok(await client.request('/api/state'));
  assert.equal(state.speechServices.kokoro.bundled, true); assert.deepEqual(state.speechServices.kokoro.languages, ['en']);
  assert.equal(state.roles.speech.voice, 'af_heart'); assert.deepEqual(state.providers, []);
  const probe = ok(await client.request('/api/speech/kokoro/probe', { method: 'POST', json: { consent: true }, timeout: 120000 }));
  assert.equal(probe.check.status, 'verified');
  const { provider } = ok(await client.request('/api/providers', { method: 'POST', json: { name: 'Offline lesson fixture (not AI)', baseUrl: `http://127.0.0.1:${fixture.address().port}/v1`, apiKey: '' } }));
  ok(await client.request('/api/roles', { method: 'PUT', json: { primary: { providerId: provider.id, model: 'fixture', api: 'chat' }, speech: state.roles.speech, transcription: null } }));
  const lesson = ok(await client.request('/api/lessons', { method: 'POST', json: lessonInput({ includeAudio: true }), timeout: 120000 }));
  const encoded = /data:audio\/wav;base64,([A-Za-z0-9+/=]+)/.exec(lesson.html)?.[1];
  assert.ok(encoded, 'Actual native speech must be embedded in the API-generated lesson');
  const audio = Buffer.from(encoded, 'base64');
  assert.equal(audio.toString('ascii', 0, 4), 'RIFF'); assert.equal(audio.readUInt32LE(24), 24000);
  assert.ok(audio.length > 48000, 'At least one second of real speech');
  let energy = 0; for (let i = 44; i < audio.length; i += 2) energy += Math.abs(audio.readInt16LE(i));
  assert.ok(energy / ((audio.length - 44) / 2) > 10, 'Speech is not silent');
  assert.doesNotMatch(lesson.html, /(?:src|href)="https?:/);
  ok(await client.request('/api/logout', { method: 'POST', json: {} }));
  state = ok(await client.request('/api/state')); assert.equal(state.roles.speech.engine, 'kokoro'); assert.deepEqual(state.providers, []);
  await mkdir('artifacts', { recursive: true });
  await writeFile('artifacts/native-offline-lesson.html', lesson.html); await writeFile('artifacts/native-speech.wav', audio);
  console.log(`PASS: native cache-only startup, English speech preselected, consented probe, full lesson API with real WAV (${audio.length} bytes), export embedding, logout default restored. No Docker/Python/cloud provider.`);
} finally {
  await app?.stop();
  if (fixture) await new Promise(resolve => { fixture.close(resolve); fixture.closeAllConnections(); });
}
