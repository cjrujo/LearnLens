import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { speechEnvironment, launchService } from '../deploy/kokoro-runtime.mjs';
import { mockProvider, startApp, ok } from './helpers.mjs';

test('bundled sessions select Kokoro with no learner configuration and restore that default on clear', async t => {
  const speech = await mockProvider(t);
  const app = await startApp(t, { kokoroBaseUrl: speech.baseUrl, kokoroBuiltin: true });
  const client = await app.client();
  const before = ok(await client.request('/api/state'));
  assert.equal(before.speechServices.kokoro.bundled, true);
  assert.equal(before.roles.primary, null);
  assert.deepEqual(before.roles.speech, { engine: 'kokoro', model: 'kokoro', api: 'auto', voice: 'af_heart' });
  assert.deepEqual(before.providers, []); assert.equal(speech.calls.length, 0, 'No paid probe or synthesis during setup');
  const unsafe = await client.request('/api/speech/kokoro/probe', { method: 'POST', json: { consent: true, voice: '../../private/model' } });
  assert.equal(unsafe.status, 400); assert.equal(speech.calls.length, 0);
  ok(await client.request('/api/roles', { method: 'PUT', json: { primary: null, speech: null, transcription: null } }));
  assert.equal(ok(await client.request('/api/state')).roles.speech, null, 'Users may explicitly disable speech');
  ok(await client.request('/api/logout', { method: 'POST', json: {} }));
  assert.equal(ok(await client.request('/api/state')).roles.speech.engine, 'kokoro');
});

test('speech child environment excludes host credentials and disables network downloads and advanced routes', () => {
  const env = speechEnvironment({ PATH: '/bin', HOME: '/home/appuser', LEARNLENS_ACCESS_PASSWORD: 'secret', KOKORO_API_KEY: 'secret', OPENAI_API_KEY: 'secret', PORT: '3210', HOST: '0.0.0.0' });
  assert.equal(env.HOST, '127.0.0.1'); assert.equal(env.PORT, '8880');
  assert.equal(env.HF_HUB_OFFLINE, '1'); assert.equal(env.TRANSFORMERS_OFFLINE, '1');
  assert.equal(env.ENABLE_INNO_TUNER, 'false'); assert.equal(env.ENABLE_DEBUG_ENDPOINTS, 'false');
  assert.equal(env.ENABLE_VOICE_TAGS, 'false'); assert.equal(env.ENABLE_SSML, 'false');
  assert.ok(!JSON.stringify(env).includes('secret'));
  assert.equal(speechEnvironment({}, false).HF_HUB_OFFLINE, undefined, 'Build-time warmup may populate caches');
});

test('speech lifecycle waits for readiness, stops children, and reports startup failure', { timeout: 15000 }, async t => {
  const server = http.createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end('{"status":"healthy"}'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const worker = launchService({ command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], readyUrl: `http://127.0.0.1:${server.address().port}/health`, timeoutMs: 1000, intervalMs: 20, stdio: 'ignore' });
  t.after(() => worker.stop());
  await worker.waitReady(); await worker.stop();
  assert.ok(worker.child.exitCode !== null || worker.child.signalCode !== null);
  const failing = launchService({ command: process.execPath, args: ['-e', 'process.exit(7)'], readyUrl: 'http://127.0.0.1:9/health', timeoutMs: 1000, intervalMs: 20, stdio: 'ignore' });
  t.after(() => failing.stop());
  await assert.rejects(failing.waitReady(), /exited/);
  const absent = launchService({ command: 'learnlens-nonexistent-python', readyUrl: 'http://127.0.0.1:9/health', timeoutMs: 1000, intervalMs: 20, stdio: 'ignore' });
  await assert.rejects(absent.waitReady(), /could not start/); await absent.stop();
});
