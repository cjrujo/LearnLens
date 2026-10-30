// Execute inside a running container started with --network none and HOST=127.0.0.1.
import assert from 'node:assert/strict';
import { generateSpeech } from '../lib/provider.mjs';
import { renderLesson } from '../lib/render.mjs';
import { demoLesson } from '../lib/lesson.mjs';
const origin = `http://127.0.0.1:${process.env.PORT || 3210}`;
let page;
for (let attempt = 0; attempt < 150; attempt++) {
  try { page = await fetch(origin + '/', { signal: AbortSignal.timeout(2000) }); if (page.ok) break; } catch { /* startup */ }
  await new Promise(resolve => setTimeout(resolve, 2000));
}
assert.ok(page?.ok, 'Packaged application becomes ready without external networking');
const cookie = page.headers.get('set-cookie').split(';')[0];
const token = /name="learnlens-token" content="([^"]+)"/.exec(await page.text())[1];
const headers = { Cookie: cookie, 'X-LearnLens-Token': token, 'Content-Type': 'application/json' };
const state = await (await fetch(origin + '/api/state', { headers })).json();
assert.equal(state.speechServices.kokoro.available, true);
assert.equal(state.speechServices.kokoro.bundled, true);
assert.equal(state.roles.speech.engine, 'kokoro', 'Speech is selected without learner setup');
assert.equal(state.roles.speech.voice, 'af_heart');
assert.deepEqual(state.providers, [], 'No cloud provider or API key configured');
const probe = await fetch(origin + '/api/speech/kokoro/probe', { method: 'POST', headers, body: JSON.stringify({ consent: true }) });
const result = await probe.json();
assert.equal(result.check?.status, 'verified', JSON.stringify(result));
const speech = await generateSpeech({ baseUrl: 'http://127.0.0.1:8880/v1' }, state.roles.speech, 'Welcome to LearnLens. You can listen to this lesson offline.');
assert.ok(speech.bytes > 1000, 'Real speech audio produced');
assert.match(speech.dataUrl, /^data:audio\/mpeg;base64,/);
const html = renderLesson(demoLesson, { audio: [{ text: 'Welcome to LearnLens.', translation: '', dataUrl: speech.dataUrl }] });
assert.ok(html.includes(speech.dataUrl), 'Actual synthesized audio is embedded');
assert.doesNotMatch(html, /(?:src|href)="https?:/);
console.log(`PASS: bundled app starts with no network; speech preselected; real Kokoro MP3 synthesis (${speech.bytes} bytes); audio embedded in standalone HTML.`);
