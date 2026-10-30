import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createNativeSpeechServer, pcmWav } from '../deploy/native-http.mjs';
import { nativeSpeechEnvironment, launchNativeSpeech } from '../deploy/native-runtime.mjs';
import { ensureAsset, validAsset, MODEL_REVISION } from '../deploy/native-assets.mjs';
import { generateComplete } from '../deploy/native-engine.mjs';
import { startNativeApplication } from '../deploy/native-start.mjs';
import { deploymentConfig } from '../server.mjs';
import { startApp, mockProvider, ok, request } from './helpers.mjs';
const token = 'local-test-token-for-speech-isolation-only';
const clip = () => ({ audio: new Float32Array([0, 0.1, -0.1, 0]), sampling_rate: 24000 });
async function temporary(t) { const path = await mkdtemp(join(tmpdir(), 'learnlens-native-')); t.after(() => rm(path, { recursive: true, force: true })); return path; }
async function fixture(t, generate = async () => clip(), maxJobs = 8) {
  const server = createNativeSpeechServer({ token, voices: ['af_heart'], generate, maxJobs });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}/v1/audio/speech`;
  const body = { model: 'kokoro', voice: 'af_heart', response_format: 'wav', input: 'Hello.' };
  const send = async (payload = body, headers = {}) => {
    const result = await request(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, ...headers }, json: payload });
    return new Response(result.bytes, { status: result.status, headers: result.headers });
  };
  return { send, body };
}

test('native PCM encoder produces bounded, clamped mono WAV', () => {
  const wav = pcmWav(new Float32Array([-2, 0, 2, NaN]));
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF'); assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.readUInt32LE(24), 24000); assert.equal(wav.readInt16LE(44), -32768); assert.equal(wav.readInt16LE(48), 32767);
  assert.equal(wav.readInt16LE(50), 0); assert.equal(wav.readUInt32LE(40), 8);
  assert.throws(() => pcmWav(new Float32Array()), /output limit/);
});

test('private native adapter requires its token, correct Host and non-browser requests', async t => {
  let calls = 0;
  const { send } = await fixture(t, async () => { calls++; return clip(); });
  assert.equal((await send(undefined, { Authorization: '' })).status, 401);
  assert.equal((await send(undefined, { Host: 'evil.example' })).status, 403);
  assert.equal((await send(undefined, { Origin: 'http://evil.example' })).status, 403);
  assert.equal(calls, 0);
  const response = await send(); assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'audio/wav');
  assert.equal(Buffer.from(await response.arrayBuffer()).length, 52); assert.equal(calls, 1);
});

test('native adapter rejects unsupported languages, voices, formats and oversized requests', async t => {
  let calls = 0; const { send, body } = await fixture(t, async () => { calls++; return clip(); });
  for (const patch of [{ voice: '../../secret' }, { voice: 'zf_xiaobei' }, { input: '你好' }, { response_format: 'mp3' }, { input: 'x'.repeat(2001) }, { model: 'other' }]) assert.equal((await send({ ...body, ...patch })).status, 400);
  assert.equal((await send({ ...body, unused: 'x'.repeat(17000) })).status, 413);
  assert.equal(calls, 0);
});

test('native adapter bounds work and serializes CPU inference', async t => {
  let release, started;
  const began = new Promise(resolve => { started = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  const { send } = await fixture(t, async () => { started(); await pending; return clip(); }, 1);
  const first = send(); await began;
  assert.equal((await send()).status, 503); release(); assert.equal((await first).status, 200);
});

test('native worker env omits host secrets and NODE_OPTIONS; thread and cache settings are bounded', () => {
  const env = nativeSpeechEnvironment({ PATH: '/bin', LEARNLENS_ACCESS_PASSWORD: 'host-secret', OPENAI_API_KEY: 'provider-secret', KOKORO_API_KEY: 'provider-secret', NODE_OPTIONS: '--require untrusted', LEARNLENS_SPEECH_OFFLINE: '1' }, token);
  assert.equal(env.LEARNLENS_INTERNAL_SPEECH_TOKEN, token); assert.equal(env.LEARNLENS_SPEECH_OFFLINE, '1');
  assert.equal(env.NODE_OPTIONS, undefined); assert.doesNotMatch(JSON.stringify(env), /host-secret|provider-secret/);
  assert.throws(() => nativeSpeechEnvironment({ LEARNLENS_SPEECH_THREADS: '999' }, token), /1–8/);
});

test('native assets use pinned URLs, hashes, atomic writes and offline refusal on corruption', async t => {
  const dir = await temporary(t), file = join(dir, 'asset'), bytes = Buffer.from('trusted model fixture');
  const asset = { path: 'config.json', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  let calls = 0;
  const fetchAsset = async url => { calls++; assert.ok(url.includes(MODEL_REVISION)); return new Response(bytes); };
  await ensureAsset(file, asset, { fetchAsset }); assert.equal(await validAsset(file, asset), true);
  await ensureAsset(file, asset, { offline: true, fetchAsset }); assert.equal(calls, 1);
  await writeFile(file, Buffer.alloc(bytes.length));
  await assert.rejects(ensureAsset(file, asset, { offline: true, fetchAsset }), /Missing or damaged/);
  await assert.rejects(ensureAsset(file, asset, { fetchAsset: async () => new Response(Buffer.alloc(bytes.length)) }), /integrity/);
  assert.deepEqual(await readdir(dir), ['asset']); assert.equal((await readFile(file))[0], 0);
});

test('long narration splits without dropping text instead of silently truncating tokens', async () => {
  const spoken = [];
  const tts = { generate: async text => { if (text.length > 12) { const error = new Error(); error.code = 'SPEECH_SEGMENT_LONG'; throw error; } spoken.push(text); return clip(); } };
  const text = 'Every original word must be spoken fully';
  const output = await generateComplete(tts, text, 'af_heart');
  assert.equal(spoken.join(' '), text); assert.ok(output.audio.length > 4);
  await assert.rejects(generateComplete(tts, 'unbreakabletoolongword', 'af_heart'), /unbroken word/);
});

test('native worker lifecycle uses IPC readiness and stops or reports startup failure', { timeout: 15000 }, async t => {
  const dir = await temporary(t), workerFile = pathToFileURL(join(dir, 'worker.mjs'));
  await writeFile(workerFile, "process.on('message', m=>{if(m.type==='stop')process.exit(0)});process.send({type:'ready',port:12345});setInterval(()=>{},1000);");
  const worker = launchNativeSpeech({ env: {}, workerFile, timeoutMs: 3000 }); t.after(() => worker.stop());
  const info = await worker.waitReady(); assert.equal(info.baseUrl, 'http://127.0.0.1:12345/v1'); assert.equal(info.apiKey.length, 64);
  await worker.stop(); assert.ok(worker.child.exitCode !== null || worker.child.signalCode !== null);
  await writeFile(workerFile, 'process.exit(7);');
  const broken = launchNativeSpeech({ env: {}, workerFile, timeoutMs: 3000 }); t.after(() => broken.stop());
  await assert.rejects(broken.waitReady(), /before becoming ready/);
});

test('native launcher validates hosting before model startup and can explicitly disable speech', async () => {
  let launches = 0; const launchSpeech = () => { launches++; throw Error('Unexpected worker'); };
  await assert.rejects(startNativeApplication({ env: { HOST: '0.0.0.0' }, launchSpeech }), /Remote binding/);
  assert.equal(launches, 0); assert.throws(() => deploymentConfig({ PORT: 'bad' }), /PORT/);
  const app = await startNativeApplication({ env: { PORT: '0', LEARNLENS_SPEECH_MODE: 'disabled' }, launchSpeech });
  try { assert.equal((await fetch(app.origin + '/health')).status, 200); assert.equal(launches, 0); }
  finally { await app.stop(); }
});

test('unexpected native worker exit shuts down the app instead of leaving dead speech advertised', async () => {
  const child = new EventEmitter(); let stopped = 0, notify;
  const failed = new Promise(resolve => { notify = resolve; });
  const app = await startNativeApplication({ env: { PORT: '0' }, launchSpeech: () => ({ child, waitReady: async () => ({ baseUrl: 'http://127.0.0.1:9999/v1', apiKey: token, voices: ['af_heart'] }), stop: async () => { stopped++; } }), onFailure: notify });
  child.emit('exit', 1);
  assert.match((await failed).message, /speech stopped/); assert.equal(app.server.listening, false); assert.equal(stopped, 1);
  await app.stop(); assert.equal(stopped, 1);
});

test('managed WAV format is used without changing optional online-provider MP3 requests or exposing internal keys', async t => {
  const mock = await mockProvider(t);
  const app = await startApp(t, { kokoroBaseUrl: mock.baseUrl, kokoroApiKey: token, kokoroBuiltin: true, kokoroFormat: 'wav', kokoroLanguages: ['en'] });
  const client = await app.client(), state = ok(await client.request('/api/state'));
  assert.deepEqual(state.speechServices.kokoro.languages, ['en']); assert.ok(!JSON.stringify(state).includes(token));
  const probe = ok(await client.request('/api/speech/kokoro/probe', { method: 'POST', json: { consent: true } }));
  assert.equal(probe.check.status, 'verified'); assert.equal(mock.calls[0].json.response_format, 'wav');
  assert.equal(mock.calls[0].headers.authorization, `Bearer ${token}`);
});
