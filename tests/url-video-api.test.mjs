import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import dns from 'node:dns';
import dnsPromises from 'node:dns/promises';
import * as disk from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { videoClipBounds } from '../lib/video-clips.mjs';
import { syntheticVideoLoader } from './video-test-fixtures.mjs';
import { startApp, mockProvider, addProvider, lessonInput, validLesson, ok, noSecrets, KEY } from './helpers.mjs';

// Transport-signature bytes, NOT a decodable audiovisual fixture. Acquisition,
// inspection and clipping are injected; the real analyzeVideo/parser/HTTP stack
// talks only to mockProvider on ephemeral IPv4 loopback ports. No FFmpeg, DNS,
// external fetch, real AI, operator .env, browser or original media is involved.
const MP4 = Buffer.from('000000186674797069736f6d0000020069736f6d69736f32', 'hex');
const SHA256 = createHash('sha256').update(MP4).digest('hex');
const SOURCE_URL = 'https://example.com/lesson.mp4?signature=PRIVATE_QUERY#PRIVATE_FRAGMENT';
const LEGACY_ROLES = { primary: null, transcription: null, speech: null };
const TIMEOUT = { timeout: 20_000 };
const isNative = call => call.method === 'POST' && call.path.endsWith(':generateContent');
const planPath = material => `/api/materials/${material.id}/video-plan`;
const clipPath = (plan, clip = plan.clips[0]) => `/api/video/plans/${plan.id}/clips/${clip.id}`;
const reference = plan => ({ materialId: plan.materialId, snapshotId: plan.snapshotId, planId: plan.id });

function status(response, expected, label = 'API request') {
  assert.equal(response.status, expected, `${label}: ${response.status} ${response.text.slice(0, 800)}`);
  assert.ok(response.json && typeof response.json === 'object', `${label}: JSON required`);
  if (expected >= 400) assert.equal(typeof response.json.error, 'string');
  return response.json;
}
async function until(read, label) {
  const deadline = Date.now() + 6000;
  let last;
  while (Date.now() < deadline) {
    last = await read();
    if (last) return last;
    await delay(3);
  }
  assert.fail(`Timed out waiting for ${label}; last=${JSON.stringify(last)}`);
}
async function state(client) { return ok(await client.request('/api/state')); }
async function saveRoles(client, roles) {
  const value = status(await client.request('/api/roles', { method: 'PUT', json: roles }), 200, 'Save roles');
  return value.roles;
}
function nativeFixture(index, plan) {
  return { video: `data:video/mp4;base64,${MP4.toString('base64')}`, ...videoClipBounds(index, plan),
    hasVideo: true, hasAudio: plan.hasAudio, analysisMode: 'whole-video', videoSha256: SHA256 };
}
function geminiFixture(call) {
  const instruction = call.json.contents[0].parts[0].text;
  const windows = JSON.parse(/Required windows: (\[.*?\])\./.exec(instruction)[1]);
  const hasAudio = !instruction.includes('is absent');
  return { candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify({ version: 1,
    windows: windows.map(bounds => ({ ...bounds,
      transcript: hasAudio ? 'Original local fixture speech / 原文' : '',
      visibleText: 'Original on-screen formula: 1 / 2', observations: 'A synthetic diagram changes position.',
      audioCoverage: hasAudio ? 'complete' : 'no_audio', visualCoverage: 'complete',
    })), warnings: [],
  }) }] }, finishReason: 'STOP' }] };
}

// Lose the response body on an actual socket, not an artificial store callback.
// The accepted background import must survive the disconnected acknowledgement.
async function loseAcknowledgement(client, path, json) {
  const url = new URL(client.baseUrl);
  assert.equal(url.hostname, '127.0.0.1');
  const body = Buffer.from(JSON.stringify(json));
  await new Promise((resolve, reject) => {
    let receivedHeaders = false;
    const req = http.request({ hostname: url.hostname, port: url.port, path, method: 'POST', agent: false,
      headers: { cookie: client.cookie, 'x-learnlens-token': client.token,
        'content-type': 'application/json', 'content-length': body.length } }, response => {
      receivedHeaders = true;
      const code = response.statusCode;
      response.destroy(); req.destroy();
      if (code === 202) resolve(); else reject(new Error(`Expected lost 202 acknowledgement, got ${code}`));
    });
    req.on('error', error => { if (!receivedHeaders) reject(error); });
    req.setTimeout(6000, () => req.destroy(new Error('Lost-ack fixture timed out')));
    req.end(body);
  });
}

async function fixture(t, { configure = true, fps = 24, timeoutSeconds = 300, duration = 30, hasAudio = true } = {}) {
  const directory = await disk.mkdtemp(join(tmpdir(), 'learnlens-url-video-api-'));
  const controls = { duration, hasAudio, failDownload: false, failClip: false, failWrite: false };
  const counters = { downloads: 0, inspections: 0, encodes: 0, writes: 0, cleanups: 0 };
  const gates = [], clients = [];
  const gate = () => {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    const value = { promise, resolve }; gates.push(value); return value;
  };
  // This hook is registered before server shutdown: drain deliberately blocked
  // writers through logout before deleting this test's private temporary root.
  t.after(async () => {
    gates.forEach(value => value.resolve());
    controls.beforeCleanup = undefined;
    controls.failWrite = false;
    for (const client of clients) status(await client.request('/api/logout', { method: 'POST', json: {}, timeout: 6000 }), 200, 'Fixture cleanup');
    await disk.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  // Node also calls lookup for literal listen addresses. Resolve the one allowed
  // literal locally; never invoke an OS resolver, even for test server startup.
  const literalAddress = (host, options) => {
    assert.equal(host, '127.0.0.1', 'Hostname/DNS resolution is forbidden');
    return options?.all ? [{ address: host, family: 4 }] : { address: host, family: 4 };
  };
  t.mock.method(dnsPromises, 'lookup', async (host, options) => literalAddress(host, options));
  t.mock.method(dns, 'lookup', (host, ...args) => {
    const options = args.length > 1 ? args[0] : undefined, callback = args.at(-1);
    const value = literalAddress(host, options);
    queueMicrotask(() => options?.all ? callback(null, value) : callback(null, value.address, value.family));
  });
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', (input, options) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    assert.equal(url.protocol, 'http:'); assert.equal(url.hostname, '127.0.0.1', 'No external fetch');
    return realFetch(input, options);
  });
  const mock = await mockProvider(t, { beforeResponse: async call => {
    if (isNative(call)) mock.config.geminiResponse = geminiFixture(call);
    await controls.beforeResponse?.(call, mock.config);
  } });
  const app = await startApp(t, {
    audioPlanStoreOptions: { directory },
    materialStoreOptions: { directory, videoLoader: syntheticVideoLoader, limits: { minFreeBytes: 0, mediaBytes: 1024 * 1024 },
      downloader: async options => {
        counters.downloads++;
        controls.lastDownload = options;
        await controls.beforeDownload?.(options);
        if (controls.failDownload) throw new Error(`PRIVATE_DOWNLOAD_FAILURE ${SOURCE_URL} C:/PRIVATE_LOCAL_PATH`);
        const file = join(options.directory, 'synthetic-source.mp4');
        await disk.writeFile(file, MP4, { flag: 'wx', mode: 0o600 });
        // A cancelled writer deliberately ignores its abort signal in the logout
        // test, proving the owner gate waits for real completion, not just abort.
        if (!options.signal.aborted) options.onProgress?.({ receivedBytes: MP4.length, totalBytes: MP4.length });
        return { file, extension: 'mp4', size: MP4.length, kind: 'media', name: 'Synthetic source.mp4',
          provenance: { type: 'direct-media', citationUrl: SOURCE_URL, title: 'Local synthetic source',
            importedAt: '2026-10-31T00:00:00.000Z' }, warnings: [] };
      },
      mediaLoader: async () => ({ inspectMedia: async (_file, extension, { signal }) => {
        counters.inspections++; assert.equal(extension, 'mp4'); assert.equal(signal.aborted, false);
        return { duration: controls.duration, hasAudio: controls.hasAudio, hasVideo: true, partCount: 1 };
      } }),
      cleanup: async path => {
        counters.cleanups++; await controls.beforeCleanup?.(path);
        return disk.rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      },
    },
    videoPlanStoreOptions: { directory,
      clipper: async (file, extension, index, plan, { signal }) => {
        counters.encodes++; assert.ok(file.startsWith(directory)); assert.equal(extension, 'mp4');
        assert.equal(signal.aborted, false); await controls.beforeClip?.({ file, index, plan, signal });
        const prepared = nativeFixture(index, plan);
        return controls.failClip ? { ...prepared, videoSha256: '0'.repeat(64) } : prepared;
      },
      writeResult: async (...args) => {
        counters.writes++;
        if (controls.failWrite) throw new Error('PRIVATE_CHECKPOINT_PATH');
        return disk.writeFile(...args);
      },
    },
  });
  const newClient = async () => { const client = await app.client(); clients.push(client); return client; };
  const client = await newClient();
  let provider;
  if (configure) {
    provider = await addProvider(client, mock);
    await saveRoles(client, { ...LEGACY_ROLES,
      primary: { providerId: provider.id, model: 'fixture-primary', api: 'chat', timeoutSeconds: 90 },
      video: { providerId: provider.id, model: 'models/fixture-video', api: 'gemini', fps, timeoutSeconds },
    });
  }
  assert.equal(mock.calls.length, 0, 'Configuration must not probe providers');
  const importSource = async (overrides = {}, browser = client) => {
    const body = { id: randomUUID(), url: SOURCE_URL, mode: 'video', publicFetchConsent: true, ...overrides };
    const ack = status(await browser.request('/api/materials/from-url', { method: 'POST', json: body }), 202);
    assert.equal(ack.id, body.id); return ack;
  };
  const materialStatus = async (id, browser = client) => status(await browser.request(`/api/materials/${id}`), 200);
  const waitMaterial = async (id, expected = 'ready', browser = client) => until(async () => {
    const value = await materialStatus(id, browser);
    if (['ready', 'error'].includes(value.status)) { assert.equal(value.status, expected, JSON.stringify(value)); return value; }
  }, `material ${id} ${expected}`);
  const createPlan = async (material, planFps = fps, browser = client) => status(await browser.request(planPath(material), {
    method: 'POST', json: planFps === undefined ? {} : { fps: planFps },
  }), 201);
  const prepare = async (overrides = {}) => {
    const ack = await importSource(overrides), material = await waitMaterial(ack.id), plan = await createPlan(material);
    return { material, plan };
  };
  const waitClip = async (plan, clip = plan.clips[0], expected = 'complete', browser = client) => until(async () => {
    const value = status(await browser.request(clipPath(plan, clip)), 200);
    if (['complete', 'failed', 'checkpoint_failed', 'damaged'].includes(value.status)) {
      assert.equal(value.status, expected, JSON.stringify(value)); return value;
    }
  }, `clip ${clip.id} ${expected}`);
  const postClip = async (plan, clip = plan.clips[0], overrides = {}, browser = client) => browser.request(clipPath(plan, clip), {
    method: 'POST', json: { consent: true, expectedSetupRevision: (await state(browser)).setupRevision,
      attemptId: randomUUID(), ...overrides },
  });
  const analyze = async (plan, clip = plan.clips[0], overrides = {}, expected = 'complete') => {
    status(await postClip(plan, clip, overrides), 202);
    return waitClip(plan, clip, expected);
  };
  const nativeCalls = () => mock.calls.filter(isNative);
  const lessonCalls = () => mock.calls.filter(call => /\/(chat\/completions|responses)$/.test(call.path));
  const lesson = (videoPlans, browser = client) => browser.request('/api/lessons', {
    method: 'POST', json: lessonInput({ ...(videoPlans === undefined ? {} : { videoPlans }) }),
  });
  return { directory, controls, counters, gate, mock, app, client, provider, newClient, importSource, materialStatus,
    waitMaterial, createPlan, prepare, waitClip, postClip, analyze, nativeCalls, lessonCalls, lesson };
}

test('native-video role is explicit, independently bounded, atomically saved and additive to legacy roles', TIMEOUT, async t => {
  const f = await fixture(t, { configure: false });
  const provider = await addProvider(f.client, f.mock);
  const base = { ...LEGACY_ROLES, primary: { providerId: provider.id, model: 'fixture-primary', api: 'chat', timeoutSeconds: 90 } };
  const video = { providerId: provider.id, model: 'models/fixture-video', api: 'gemini' };
  const roles = await saveRoles(f.client, { ...base, video });
  assert.deepEqual(roles.video, { providerId: provider.id, model: 'fixture-video', api: 'gemini', fps: 24, timeoutSeconds: 300 });
  const initial = await state(f.client);
  const invalid = [
    { api: undefined }, { api: 'auto' }, { api: 'chat' }, { api: 'responses' }, { api: 'Gemini' },
    { fps: 0 }, { fps: 25 }, { fps: '24' }, { fps: true },
    { timeoutSeconds: 29 }, { timeoutSeconds: 601 }, { timeoutSeconds: 30.5 }, { timeoutSeconds: '300' },
    { providerId: randomUUID() }, { model: 'bad\nmodel' }, { reasoningEffort: 'high' },
  ];
  for (const change of invalid) {
    status(await f.client.request('/api/roles', { method: 'PUT', json: {
      ...base, primary: { ...base.primary, model: 'must-not-be-partially-written' }, video: { ...video, ...change },
    } }), 400, `Invalid video settings ${JSON.stringify(change)}`);
    const current = await state(f.client);
    assert.deepEqual(current.roles, initial.roles, 'Invalid video role must not partially overwrite another role');
    assert.equal(current.setupRevision, initial.setupRevision, 'Rejected settings do not revoke valid consent');
  }
  for (const extra of [{ primary: { ...base.primary, fps: 12 } }, { transcription: { ...video, timeoutSeconds: 60 } }]) {
    status(await f.client.request('/api/roles', { method: 'PUT', json: { ...base, video, ...extra } }), 400);
    assert.deepEqual((await state(f.client)).roles, initial.roles);
  }
  const legacy = await saveRoles(f.client, base);
  assert.deepEqual(legacy.video, initial.roles.video, 'An old three-role client cannot erase the new role');
  for (const [fps, timeoutSeconds] of [[1, 30], [2.5, 45], [24, 600]]) {
    const saved = await saveRoles(f.client, { ...base, video: { ...video, fps, timeoutSeconds } });
    assert.equal(saved.video.fps, fps); assert.equal(saved.video.timeoutSeconds, timeoutSeconds);
    assert.equal(saved.primary.timeoutSeconds, 90);
  }
  assert.equal((await saveRoles(f.client, { ...base, video: null })).video, null, 'Explicit unassignment remains available');
  noSecrets(await state(f.client)); assert.equal(f.mock.calls.length, 0);
});

test('URL consent, lost acknowledgements, private status, conflict reuse, tombstones and explicit reimport', TIMEOUT, async t => {
  const f = await fixture(t), entered = f.gate(), finish = f.gate();
  f.controls.beforeDownload = async () => { entered.resolve(); await finish.promise; };
  const body = { id: randomUUID(), url: SOURCE_URL, mode: 'auto' };
  for (const consent of [undefined, false, 'true', 1]) status(await f.client.request('/api/materials/from-url', {
    method: 'POST', json: { ...body, publicFetchConsent: consent, consent: true },
  }), 400, 'AI consent must not substitute for public-fetch consent');
  assert.equal(f.counters.downloads, 0); assert.equal(f.mock.calls.length, 0);
  await loseAcknowledgement(f.client, '/api/materials/from-url', { ...body, publicFetchConsent: true });
  await entered.promise;
  assert.equal(f.controls.lastDownload.signal.aborted, false, 'Acknowledgement loss does not cancel the source');
  for (let index = 0; index < 3; index++) {
    const pending = await f.materialStatus(body.id);
    assert.equal(pending.status, 'fetching'); assert.equal(pending.snapshotReady, false);
    assert.equal(pending.analysisMode, 'whole-video', 'Unclassified auto imports cannot bypass the whole-video gate');
    noSecrets(pending, [KEY, 'PRIVATE_QUERY', 'PRIVATE_FRAGMENT', f.directory]);
    assert.equal((await f.importSource(body)).status, 'fetching');
  }
  status(await f.lesson([]), 409); assert.equal(f.mock.calls.length, 0);
  for (const change of [{ url: 'https://example.com/another.mp4' }, { mode: 'video' }]) {
    status(await f.client.request('/api/materials/from-url', { method: 'POST', json: { ...body, ...change, publicFetchConsent: true } }), 409);
  }
  assert.equal(f.counters.downloads, 1); finish.resolve();
  const ready = await f.waitMaterial(body.id);
  assert.equal(ready.sourceHash, SHA256); assert.equal(ready.snapshotReady, true);
  assert.equal(ready.provenance.citationUrl, 'https://example.com/lesson.mp4');
  noSecrets(ready, [KEY, 'PRIVATE_QUERY', 'PRIVATE_FRAGMENT', f.directory]);
  assert.deepEqual(await f.importSource(body), ready, 'Duplicate completion reads the same immutable snapshot');
  for (let i = 0; i < 2; i++) status(await f.client.request(`/api/materials/${body.id}`, { method: 'DELETE' }), 200);
  status(await f.client.request(`/api/materials/${body.id}`), 404);
  status(await f.client.request('/api/materials/from-url', { method: 'POST', json: { ...body, publicFetchConsent: true } }), 409);
  assert.equal(f.counters.downloads, 1);
  const again = await f.waitMaterial((await f.importSource()).id);
  assert.notEqual(again.id, ready.id); assert.notEqual(again.snapshotId, ready.snapshotId);
  assert.equal(again.sourceHash, ready.sourceHash); assert.equal(f.counters.downloads, 2);
  await f.createPlan(again); assert.equal(f.mock.calls.length, 0);
});

test('failed URL acquisition stays failed without automatic refetch and blocks teaching before any provider call', TIMEOUT, async t => {
  const f = await fixture(t); f.controls.failDownload = true;
  const ack = await f.importSource(); await f.waitMaterial(ack.id, 'error');
  const failed = await until(async () => {
    const value = await f.materialStatus(ack.id); return !value.cleanupPending && value;
  }, 'failed acquisition cleanup');
  assert.equal(failed.snapshotReady, false); assert.equal(failed.sourceHash, null);
  noSecrets(failed, ['PRIVATE_DOWNLOAD_FAILURE', 'PRIVATE_QUERY', 'PRIVATE_FRAGMENT', 'PRIVATE_LOCAL_PATH']);
  for (let i = 0; i < 3; i++) assert.deepEqual(await f.importSource({ id: ack.id }), failed);
  status(await f.lesson([]), 409); assert.equal(f.mock.calls.length, 0); assert.equal(f.counters.downloads, 1);
  f.controls.failDownload = false;
  status(await f.client.request(`/api/materials/${ack.id}`, { method: 'DELETE' }), 200);
  const next = await f.waitMaterial((await f.importSource()).id);
  await f.createPlan(next); assert.equal(f.counters.downloads, 2, 'Failure releases its job lease for explicit replacement');
});

test('video plan GET is strictly read-only; POST creates immutable FPS-specific plans without a role or inference', TIMEOUT, async t => {
  const f = await fixture(t, { configure: false, duration: 60.25 });
  const material = await f.waitMaterial((await f.importSource()).id);
  for (const suffix of ['', '?fps=12', '?fps=24']) status(await f.client.request(planPath(material) + suffix), 404);
  assert.ok(!(await disk.readdir(f.directory)).some(name => name.startsWith('learnlens-video-')), 'GET must not initialize the plan store');
  for (const fps of [0, 25, null, '24', false]) status(await f.client.request(planPath(material), { method: 'POST', json: { fps } }), 400);
  const plan = status(await f.client.request(planPath(material), { method: 'POST', json: {} }), 201);
  assert.match(plan.id, /^[a-f0-9]{64}$/); assert.equal(plan.fps, 24);
  assert.equal(plan.snapshotId, material.snapshotId); assert.equal(plan.sourceHash, material.sourceHash);
  assert.deepEqual(plan.clips.map(({ start, end }) => ({ start, end })), [{ start: 0, end: 30 }, { start: 30, end: 60.25 }]);
  assert.deepEqual(status(await f.client.request(planPath(material)), 200), plan);
  assert.deepEqual(await f.createPlan(material), plan);
  const low = await f.createPlan(material, 12); assert.notEqual(low.id, plan.id);
  assert.deepEqual(status(await f.client.request(planPath(material) + '?fps=12'), 200), low);
  const pending = status(await f.client.request(clipPath(plan)), 200);
  assert.equal(pending.status, 'pending'); assert.equal(pending.attempts, 0); assert.equal(pending.providerRequested, false);
  status(await f.postClip(plan), 400, 'A primary/transcription model cannot implicitly become a video model');
  assert.equal(f.counters.encodes, 0); assert.equal(f.mock.calls.length, 0);
});

test('lesson gate requires every clip and every attached whole-video snapshot, never just client-claimed coverage', TIMEOUT, async t => {
  const f = await fixture(t, { duration: 61 });
  const { material, plan } = await f.prepare();
  for (const refs of [undefined, [], null, {}, [reference(plan)],
    [{ ...reference(plan), snapshotId: randomUUID() }], [{ ...reference(plan), planId: '0'.repeat(64) }],
    [{ ...reference(plan), complete: true, status: 'complete' }]]) {
    const response = await f.lesson(refs);
    assert.ok([404, 409].includes(response.status), `${response.status}: ${response.text}`);
    assert.equal(f.mock.calls.length, 0, 'Rejected coverage must precede any billable work');
  }
  const first = await f.analyze(plan);
  assert.equal(first.result.windows[0].sourceStart, 0); assert.equal(first.result.windows.at(-1).sourceEnd, 30);
  status(await f.lesson([reference(plan)]), 409); assert.equal(f.lessonCalls().length, 0);
  for (const clip of plan.clips.slice(1)) await f.analyze(plan, clip);
  assert.equal(f.nativeCalls().length, 3);
  const complete = status(await f.client.request(`/api/video/plans/${plan.id}`), 200);
  assert.equal(complete.summary.completedClips, 3); assert.equal(complete.summary.status, 'complete');
  assert.ok(!JSON.stringify(complete).includes('Original local fixture speech'), 'Manifest does not inline private transcripts');
  const tail = status(await f.client.request(clipPath(plan, plan.clips.at(-1))), 200);
  assert.equal(tail.result.windows.at(-1).sourceEnd, material.duration);
  assert.equal(tail.result.coverageBasis, 'model_reported');
  f.controls.duration = 4;
  const second = await f.prepare();
  for (const refs of [[reference(plan)], [reference(plan), reference(plan)], [reference(plan), reference(second.plan)]]) {
    status(await f.lesson(refs), 409); assert.equal(f.lessonCalls().length, 0);
  }
  await f.analyze(second.plan);
  validLesson(await f.lesson([reference(plan), reference(second.plan)]));
  assert.equal(f.lessonCalls().length, 1); assert.equal(f.nativeCalls().length, 4);
  status(await f.client.request(`/api/materials/${material.id}`, { method: 'DELETE' }), 200);
  status(await f.client.request(`/api/video/plans/${plan.id}`), 404);
  status(await f.lesson([reference(plan), reference(second.plan)]), 409);
  assert.equal(f.lessonCalls().length, 1);
  validLesson(await f.lesson([reference(second.plan)]));
});

test('new analysis requires literal consent, current integer revision, explicit video role and matching plan FPS', TIMEOUT, async t => {
  const f = await fixture(t), { plan } = await f.prepare();
  const original = await state(f.client), attemptId = randomUUID();
  for (const consent of [undefined, false, 'true', 1]) status(await f.postClip(plan, undefined, { consent, attemptId }), 400);
  for (const expectedSetupRevision of [undefined, null, String(original.setupRevision), original.setupRevision - 1]) {
    status(await f.postClip(plan, undefined, { attemptId, expectedSetupRevision }), 409);
  }
  for (const bad of [undefined, 'not-a-uuid', 'a'.repeat(64)]) status(await f.postClip(plan, undefined, { attemptId: bad }), 400);
  await saveRoles(f.client, { ...original.roles, video: { ...original.roles.video, fps: 12 } });
  status(await f.postClip(plan, undefined, { attemptId }), 409);
  await saveRoles(f.client, { ...original.roles, video: null,
    transcription: { providerId: f.provider.id, model: 'fixture-video', api: 'gemini' } });
  status(await f.postClip(plan, undefined, { attemptId }), 400);
  assert.equal(f.counters.encodes, 0); assert.equal(f.mock.calls.length, 0);
  assert.equal(status(await f.client.request(clipPath(plan)), 200).attempts, 0, 'Rejected authorization consumes no attempt');
  await saveRoles(f.client, original.roles);
  await f.analyze(plan, undefined, { attemptId });
  assert.equal(f.counters.encodes, 1); assert.equal(f.nativeCalls().length, 1);
});

test('settings changed while clipping prevent dispatch and require explicit fresh confirmation, not automatic retry', TIMEOUT, async t => {
  const f = await fixture(t), { plan } = await f.prepare(), entered = f.gate(), finish = f.gate();
  const initial = await state(f.client), attemptId = randomUUID();
  f.controls.beforeClip = async () => { entered.resolve(); await finish.promise; };
  status(await f.postClip(plan, undefined, { attemptId }), 202); await entered.promise;
  await saveRoles(f.client, { ...initial.roles, video: { ...initial.roles.video, model: 'replacement-video' } });
  finish.resolve();
  const failed = await f.waitClip(plan, undefined, 'failed');
  assert.equal(failed.providerRequested, false); assert.equal(failed.attemptId, attemptId);
  assert.equal(f.counters.encodes, 1); assert.equal(f.mock.calls.length, 0);
  status(await f.postClip(plan, undefined, { attemptId, retry: true, expectedSetupRevision: initial.setupRevision }), 202);
  status(await f.postClip(plan, undefined, { retry: true, expectedSetupRevision: initial.setupRevision }), 409);
  status(await f.postClip(plan, undefined, { retry: true, consent: false }), 400);
  status(await f.postClip(plan), 409, 'Retry is an explicit decision');
  await f.analyze(plan, undefined, { retry: true });
  assert.equal(f.counters.encodes, 2); assert.equal(f.nativeCalls().length, 1);
  assert.match(f.nativeCalls()[0].path, /\/replacement-video:generateContent$/);
});

for (const { fps, timeoutSeconds, hasAudio } of [
  { fps: 2.5, timeoutSeconds: 300, hasAudio: true },
  { fps: 24, timeoutSeconds: 600, hasAudio: false },
]) test(`native Gemini wire uses FPS ${fps} and independent ${timeoutSeconds}s wait without API fallback`, TIMEOUT, async t => {
  const f = await fixture(t, { fps, timeoutSeconds, hasAudio, duration: 5.25 });
  const deadlines = [], originalTimeout = AbortSignal.timeout;
  t.mock.method(AbortSignal, 'timeout', function (milliseconds) {
    deadlines.push(milliseconds); return Reflect.apply(originalTimeout, this, [milliseconds]);
  });
  const fetchCalls = [], guardedFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', (...args) => { fetchCalls.push(args[0]); return guardedFetch(...args); });
  const { plan } = await f.prepare(), result = await f.analyze(plan);
  assert.deepEqual(deadlines, [timeoutSeconds * 1000]);
  assert.equal(fetchCalls.length, timeoutSeconds > 300 ? 0 : 1, 'Long video wait must use Node transport, not fetch headers timeout');
  const [call] = f.nativeCalls(); assert.equal(f.mock.calls.length, 1);
  assert.equal(call.path, '/custom/v1beta/models/fixture-video:generateContent');
  assert.equal(call.headers.authorization, `Bearer ${KEY}`);
  assert.equal(call.headers.cookie, undefined); assert.equal(call.headers['x-learnlens-token'], undefined);
  assert.equal(call.json.contents[0].parts.length, 2);
  assert.deepEqual(call.json.contents[0].parts[1], {
    inlineData: { mimeType: 'video/mp4', data: MP4.toString('base64') }, videoMetadata: { fps },
  });
  assert.equal(call.json.generationConfig.responseMimeType, 'application/json');
  assert.equal(call.json.generationConfig.candidateCount, 1);
  assert.equal(call.json.model, undefined); assert.equal(call.json.messages, undefined);
  assert.equal(result.result.fps, fps); assert.equal(result.result.videoSha256, SHA256);
  assert.equal(result.result.windows.length, 2); assert.equal(result.result.windows.at(-1).sourceEnd, 5.25);
  if (!hasAudio) assert.ok(result.result.windows.every(window => window.transcript === '' && window.audioCoverage === 'no_audio'));
  const current = await state(f.client), check = current.providers[0].checks['fixture-video'].video;
  assert.equal(check.status, 'verified'); assert.equal(check.fps, fps); assert.equal(check.timeoutSeconds, timeoutSeconds);
  assert.equal(current.roles.primary.timeoutSeconds, 90);
  validLesson(await f.lesson([reference(plan)]));
  assert.deepEqual(deadlines, [timeoutSeconds * 1000, 90_000], 'Video wait never replaces the primary model wait');
  assert.equal(f.lessonCalls().length, 1); assert.equal(f.nativeCalls().length, 1);
});

test('pending/complete duplicate attempts and GETs never encode, acquire a second job or infer again', TIMEOUT, async t => {
  const f = await fixture(t, { duration: 60 }), { plan } = await f.prepare(), entered = f.gate(), finish = f.gate();
  f.controls.beforeResponse = async call => { if (isNative(call)) { entered.resolve(); await finish.promise; } };
  const attemptId = randomUUID(); status(await f.postClip(plan, undefined, { attemptId }), 202); await entered.promise;
  for (let index = 0; index < 4; index++) {
    const pending = status(await f.client.request(clipPath(plan)), 200);
    assert.equal(pending.status, 'processing'); assert.equal(pending.providerRequested, true); assert.equal(pending.result, undefined);
    const duplicate = status(await f.postClip(plan, undefined, { attemptId: index % 2 ? randomUUID() : attemptId, retry: true }), 202);
    assert.equal(duplicate.attemptId, attemptId); assert.equal(duplicate.attempts, 1);
  }
  status(await f.postClip(plan, plan.clips[1], { attemptId }), 409, 'Attempt ID is bound to its original clip');
  assert.equal(f.nativeCalls().length, 1); assert.equal(f.counters.encodes, 1);
  finish.resolve(); const complete = await f.waitClip(plan);
  const initial = await state(f.client); await saveRoles(f.client, { ...initial.roles, video: null });
  for (const id of [attemptId, randomUUID()]) {
    const duplicate = status(await f.postClip(plan, undefined, { attemptId: id, expectedSetupRevision: initial.setupRevision }), 202);
    assert.deepEqual(duplicate, complete);
    assert.deepEqual(status(await f.client.request(clipPath(plan)), 200), complete);
  }
  assert.equal(f.nativeCalls().length, 1); assert.equal(f.counters.encodes, 1);
  await saveRoles(f.client, initial.roles); await f.analyze(plan, plan.clips[1]);
  assert.equal(f.nativeCalls().length, 2, 'Original job lease is released for the next clip');
});

for (const failure of ['missing-window', 'native-404']) test(`${failure}: no fallback or automatic retry; only fresh consent plus a new explicit retry dispatches`, TIMEOUT, async t => {
  const f = await fixture(t), { plan } = await f.prepare(), attemptId = randomUUID();
  f.controls.beforeResponse = (call, config) => {
    if (!isNative(call)) return;
    if (failure === 'native-404') config.geminiStatus = 404;
    else config.geminiResponse.candidates[0].content.parts[0].text = JSON.stringify({ version: 1, windows: [], warnings: [] });
  };
  const failed = await f.analyze(plan, undefined, { attemptId }, 'failed');
  assert.equal(failed.providerRequested, true); assert.equal(failed.result, undefined); assert.match(failed.error, /No automatic retry/);
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(status(await f.client.request(clipPath(plan)), 200), failed);
    assert.deepEqual(status(await f.postClip(plan, undefined, { attemptId, retry: true }), 202), failed);
  }
  status(await f.lesson([reference(plan)]), 409);
  status(await f.postClip(plan), 409);
  status(await f.postClip(plan, undefined, { retry: true, consent: false }), 400);
  status(await f.postClip(plan, undefined, { retry: true, expectedSetupRevision: -1 }), 409);
  assert.equal(f.mock.calls.length, 1); assert.equal(f.counters.encodes, 1);
  f.controls.beforeResponse = undefined; f.mock.config.geminiStatus = 200;
  const complete = await f.analyze(plan, undefined, { retry: true });
  assert.equal(complete.attempts, 2); assert.notEqual(complete.attemptId, attemptId);
  assert.equal(f.mock.calls.length, 2); assert.ok(f.mock.calls.every(isNative), 'Native video never falls back to chat, image or transcription');
  assert.equal(f.counters.downloads, 1, 'Retry reuses the immutable snapshot');
});

test('invalid prepared clip fails locally without inference or automatic re-encoding', TIMEOUT, async t => {
  const f = await fixture(t), { plan } = await f.prepare(), attemptId = randomUUID(); f.controls.failClip = true;
  const failed = await f.analyze(plan, undefined, { attemptId }, 'failed');
  assert.equal(failed.providerRequested, false); assert.equal(failed.result, undefined);
  for (let i = 0; i < 3; i++) status(await f.postClip(plan, undefined, { attemptId, retry: true }), 202);
  status(await f.lesson([reference(plan)]), 409);
  assert.equal(f.counters.encodes, 1); assert.equal(f.mock.calls.length, 0);
  f.controls.failClip = false; await f.analyze(plan, undefined, { retry: true });
  assert.equal(f.counters.encodes, 2); assert.equal(f.mock.calls.length, 1); assert.equal(f.counters.downloads, 1);
});

test('checkpoint failure repairs locally after provider/role deletion; polling and stale-revision replays stay unbilled', TIMEOUT, async t => {
  const f = await fixture(t), { plan } = await f.prepare(), attemptId = randomUUID();
  const oldRevision = (await state(f.client)).setupRevision; f.controls.failWrite = true;
  const failed = await f.analyze(plan, undefined, { attemptId }, 'checkpoint_failed');
  assert.equal(failed.providerRequested, true); assert.equal(failed.result, undefined); assert.match(failed.error, /without another provider/);
  for (let i = 0; i < 3; i++) assert.deepEqual(status(await f.client.request(clipPath(plan)), 200), failed);
  status(await f.lesson([reference(plan)]), 409);
  assert.equal(f.counters.writes, 1); assert.equal(f.counters.encodes, 1); assert.equal(f.mock.calls.length, 1);
  status(await f.client.request(`/api/providers/${f.provider.id}`, { method: 'DELETE' }), 200);
  assert.equal((await state(f.client)).roles.video, null);
  f.controls.failWrite = false;
  status(await f.postClip(plan, undefined, { attemptId, expectedSetupRevision: oldRevision }), 202);
  // Recovery keeps checkpoint_failed visible while its local writer is running.
  const complete = await until(async () => {
    const value = status(await f.client.request(clipPath(plan)), 200);
    assert.ok(['checkpoint_failed', 'complete'].includes(value.status), JSON.stringify(value));
    return value.status === 'complete' && value;
  }, 'accepted result checkpoint repair');
  assert.equal(complete.attemptId, attemptId); assert.equal(complete.attempts, 1);
  assert.equal(f.counters.writes, 2); assert.equal(f.counters.encodes, 1); assert.equal(f.mock.calls.length, 1);
  assert.deepEqual(status(await f.postClip(plan, undefined, { expectedSetupRevision: undefined }), 202), complete);
  assert.deepEqual(status(await f.client.request(clipPath(plan)), 200), complete);
  assert.equal(f.counters.writes, 2); assert.equal(f.counters.encodes, 1); assert.equal(f.mock.calls.length, 1);
  const another = await f.waitMaterial((await f.importSource()).id); await f.createPlan(another);
});

test('material, plan, clip and lesson references are owner-bound; another cookie cannot mutate or infer', TIMEOUT, async t => {
  const f = await fixture(t), { material, plan } = await f.prepare(), other = await f.newClient();
  for (const path of [`/api/materials/${material.id}`, planPath(material), `/api/video/plans/${plan.id}`, clipPath(plan)]) {
    status(await other.request(path), 404, 'Foreign reads reveal no material');
  }
  status(await other.request('/api/materials/from-url', { method: 'POST', json: {
    id: material.id, url: SOURCE_URL, mode: 'video', publicFetchConsent: true,
  } }), 404);
  // DELETE is deliberately idempotent and does not reveal foreign existence.
  for (let i = 0; i < 2; i++) status(await other.request(`/api/materials/${material.id}`, { method: 'DELETE' }), 200);
  assert.deepEqual(await f.materialStatus(material.id), material, 'Foreign DELETE must be a harmless no-op');
  status(await f.postClip(plan, undefined, {}, other), 404);
  const foreignCreate = await other.request(planPath(material), { method: 'POST', json: {} });
  assert.ok([404, 409].includes(foreignCreate.status), foreignCreate.text);
  const provider = await addProvider(other, f.mock);
  await saveRoles(other, { ...LEGACY_ROLES, primary: { providerId: provider.id, model: 'other-primary', api: 'chat' } });
  status(await f.lesson([reference(plan)], other), 409);
  assert.equal(f.mock.calls.length, 0); assert.equal(f.counters.encodes, 0); assert.equal(f.counters.downloads, 1);
  assert.deepEqual(await f.materialStatus(material.id), material);
  await f.analyze(plan); assert.equal(f.nativeCalls().length, 1);
  status(await other.request(clipPath(plan)), 404);
});

test('logout during asynchronous URL import waits for writer and cleanup, gates new work, and never resurrects late material', TIMEOUT, async t => {
  const f = await fixture(t), entered = f.gate(), finish = f.gate(), erasing = f.gate(), erased = f.gate();
  f.controls.beforeDownload = async () => { entered.resolve(); await finish.promise; };
  f.controls.beforeCleanup = async () => { erasing.resolve(); await erased.promise; };
  const ack = await f.importSource(); await entered.promise;
  const { signal, directory } = f.controls.lastDownload;
  const logout = f.client.request('/api/logout', { method: 'POST', json: {} });
  await until(async () => (await state(f.client)).locked, 'logout cleanup gate');
  assert.equal(signal.aborted, true); assert.equal(f.counters.cleanups, 0, 'Do not erase beneath a live writer');
  const blocked = { id: randomUUID(), url: SOURCE_URL, mode: 'video', publicFetchConsent: true };
  status(await f.client.request('/api/materials/from-url', { method: 'POST', json: blocked }), 409);
  status(await f.client.request(planPath(ack), { method: 'POST', json: {} }), 409);
  assert.equal(f.counters.downloads, 1); finish.resolve(); await erasing.promise;
  status(await f.client.request('/api/materials/from-url', { method: 'POST', json: blocked }), 409);
  erased.resolve(); status(await logout, 200);
  status(await f.client.request(`/api/materials/${ack.id}`), 404);
  await assert.rejects(disk.stat(directory), { code: 'ENOENT' });
  assert.equal(f.counters.inspections, 0, 'Late acquisition cannot enter media parsing');
  const cleared = await state(f.client); assert.equal(cleared.locked, false); assert.deepEqual(cleared.providers, []);
  status(await f.client.request('/api/materials/from-url', { method: 'POST', json: { ...blocked, id: ack.id } }), 409);
  const replacement = await f.waitMaterial((await f.importSource({ id: blocked.id })).id);
  await f.createPlan(replacement); assert.equal(f.counters.downloads, 2); assert.equal(f.mock.calls.length, 0);
});

test('global local-job capacity is reserved once, duplicates use no extra slot, and completion releases exactly once', TIMEOUT, async t => {
  const f = await fixture(t, { configure: false }), second = await f.newClient(), third = await f.newClient();
  const entered = [f.gate(), f.gate(), f.gate()], finish = [f.gate(), f.gate(), f.gate()];
  f.controls.beforeDownload = async () => {
    const index = f.counters.downloads - 1;
    entered[index]?.resolve(); if (finish[index]) await finish[index].promise;
  };
  const a = await f.importSource(); await entered[0].promise;
  status(await f.client.request('/api/materials/from-url', { method: 'POST', json: {
    id: randomUUID(), url: SOURCE_URL, mode: 'video', publicFetchConsent: true,
  } }), 409, 'One in-flight job per session');
  for (let i = 0; i < 3; i++) await f.importSource({ id: a.id });
  const b = await f.importSource({}, second); await entered[1].promise;
  const nextId = randomUUID();
  status(await third.request('/api/materials/from-url', { method: 'POST', json: {
    id: nextId, url: SOURCE_URL, mode: 'video', publicFetchConsent: true,
  } }), 503, 'Two local imports is the instance limit');
  assert.equal(f.counters.downloads, 2);
  finish[0].resolve(); const readyA = await f.waitMaterial(a.id);
  const c = await f.importSource({ id: nextId }, third); await entered[2].promise;
  // A double release would incorrectly allow this third concurrent import.
  status(await f.client.request('/api/materials/from-url', { method: 'POST', json: {
    id: randomUUID(), url: SOURCE_URL, mode: 'video', publicFetchConsent: true,
  } }), 503);
  finish[1].resolve(); await f.waitMaterial(b.id, 'ready', second);
  finish[2].resolve(); await f.waitMaterial(c.id, 'ready', third);
  for (let i = 0; i < 4; i++) await f.createPlan(readyA);
  const final = await f.waitMaterial((await f.importSource()).id); await f.createPlan(final);
  assert.equal(f.counters.downloads, 4); assert.equal(f.counters.encodes, 0); assert.equal(f.mock.calls.length, 0);
});
