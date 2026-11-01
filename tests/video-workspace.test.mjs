import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { MaterialWorkspace } from '../public/materials.js';
import { parseVideoAnalysis, videoWindows } from '../lib/video-analysis.mjs';

const hash = value => createHash('sha256').update(String(value)).digest('hex');
const role = { api: 'gemini', fps: 24, model: 'synthetic-native', providerId: 'fake' };
const settings = { consent: true, expectedSetupRevision: 7, goal: 'Learn from every source interval', roles: { video: role, primary: { model: 'synthetic-primary' } } };
const network = () => Object.assign(new Error('Synthetic acknowledgement lost'), { network: true });
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function workspace(api, options = {}) {
  const value = new MaterialWorkspace({ list: { querySelectorAll: () => [], replaceChildren() {} }, api, changed() {}, wait: async () => {}, ...options });
  value.render = () => {}; return value;
}
const urlReady = (id, snapshotId = 'url-snapshot-1') => ({ id, snapshotId, snapshotReady: true, sourceHash: hash(snapshotId), status: 'ready', kind: 'text', name: 'Private source title', partCount: 1, warnings: [] });
const partText = { text: 'Exact URL source text.', label: 'Text part 1', images: [] };
function nativeFixture({ duration = 11.25, initial = 'complete', video, wait } = {}) {
  const remoteId = crypto.randomUUID(), snapshotId = crypto.randomUUID(), calls = [], plans = new Map(), states = new Map();
  const manifest = { id: remoteId, snapshotId, sourceHash: hash('original'), snapshotReady: true, status: 'ready', kind: 'media', name: 'synthetic.mp4', analysisMode: 'whole-video', hasAudio: true, hasVideo: true, duration, partCount: Math.ceil(duration / 30), width: 1280, height: 720, warnings: [] };
  const item = { id: 'local-material', remoteId, snapshotId, manifest, remote: true, createAttempted: true, name: manifest.name, kind: 'media', partCount: manifest.partCount, status: 'ready', warnings: [] };
  function makePlan(fps) {
    if (plans.has(fps)) return plans.get(fps);
    const p = { id: hash(snapshotId + ':' + fps), materialId: remoteId, snapshotId, sourceHash: manifest.sourceHash, fps, profileVersion: 1, duration, hasAudio: true, hasVideo: true, analysisMode: 'whole-video', summary: { totalClips: manifest.partCount, completedClips: 0, status: 'ready' }, clips: Array.from({ length: manifest.partCount }, (_, index) => ({ id: hash(snapshotId + ':' + fps + ':' + index), index, start: index * 30, end: Math.min(duration, index * 30 + 30), status: initial })) };
    plans.set(fps, p);
    for (const clip of p.clips) states.set(clip.id, { id: clip.id, status: initial, attempts: initial === 'pending' ? 0 : 1, ...(initial === 'complete' ? { result: result(p, clip.index) } : {}) });
    return p;
  }
  function result(p, index) {
    const clip = p.clips[index];
    return parseVideoAnalysis(JSON.stringify({ version: 1, windows: videoWindows(clip.end - clip.start).map((bounds, n) => ({ ...bounds, transcript: ` ORIGINAL speech ${index}.${n}\n`, visibleText: `SCREEN ${index}.${n} / 2`, observations: `DERIVED ${index}.${n}`, audioCoverage: 'complete', visualCoverage: 'complete' })), warnings: [] }), { ...clip, hasAudio: true, videoSha256: hash('clip-' + index) }, { fps: p.fps });
  }
  const api = async (path, options = {}) => {
    calls.push({ path, method: options.method || 'GET', body: structuredClone(options.body), signal: options.signal });
    if (path.startsWith('/materials/' + remoteId + '/video-plan')) {
      const fps = options.method === 'POST' ? options.body.fps : Number(path.split('=')[1]); return structuredClone(makePlan(fps));
    }
    if (path === '/materials/' + remoteId + '/parts') {
      const index = options.body.index;
      return { videoRef: { materialId: remoteId, snapshotId, index }, analysisMode: 'whole-video', start: index * 30, end: Math.min(duration, index * 30 + 30), label: 'Clip ' + (index + 1), text: '', images: [] };
    }
    if (path.startsWith('/video/plans/')) {
      const [, , , planId, , clipId] = path.split('/');
      const p = [...plans.values()].find(p => p.id === planId), index = p.clips.findIndex(c => c.id === clipId);
      if (video) return video({ path, options, plan: p, index, states, result, calls });
      if (options.method === 'POST') states.set(clipId, { id: clipId, status: 'complete', attempts: 1, attemptId: options.body.attemptId, result: result(p, index) });
      return structuredClone(states.get(clipId));
    }
    if (path === '/materials/summarize') return { text: 'A deliberately lossy lesson digest.', warnings: [] };
    assert.fail('Unexpected route: ' + path);
  };
  const value = workspace(api, wait ? { wait } : {}); value.items = [item];
  return { value, item, manifest, calls, plans, makePlan, states, result };
}

test('URL action creates one consented snapshot without a File; lost ack recovery only GETs', async () => {
  const calls = []; let id, gets = 0;
  const raw = 'https://public.example/lesson?private_token=SECRET#section';
  const value = workspace(async (path, options = {}) => {
    calls.push({ path, method: options.method || 'GET', body: options.body });
    if (path === '/materials/from-url') { id = options.body.id; throw network(); }
    if (path === '/materials/' + id) return ++gets === 1 ? { status: 'fetching', received: 10, snapshotReady: false } : urlReady(id);
    if (path.endsWith('/parts')) return partText;
    assert.fail(path);
  });
  assert.deepEqual(await value.addUrl(raw), []);
  const item = value.items[0]; assert.equal(item.file, undefined); assert.equal(item.status, 'ready');
  assert.equal(item.remoteId, id); assert.equal(item.sourceUrl, raw); assert.equal(item.snapshotId, 'url-snapshot-1');
  assert.deepEqual(calls[0].body, { id, url: raw, mode: 'auto', publicFetchConsent: true });
  assert.equal(calls.filter(c => c.path === '/materials/from-url').length, 1);
  assert.equal(calls.filter(c => c.path.endsWith('/finish')).length, 0);
  const prepared = await value.prepare(settings);
  for (const visible of [prepared, value.checkpointInfo(), value.describe(), value.checkpoint.inputs, [...value.checkpoint.sourceIndex.keys()]]) assert.ok(!JSON.stringify(visible).includes('SECRET'));
  assert.equal(prepared.text.includes('Exact URL source text.'), true);
});

test('missing create acknowledgement never reposts even when status is 404', async () => {
  const calls = [];
  const value = workspace(async (path, options = {}) => {
    calls.push([path, options.method || 'GET']);
    if (path === '/materials/from-url') throw network();
    throw Object.assign(new Error('missing'), { status: 404 });
  });
  await value.addUrl('https://public.example/missing');
  await value.resume(value.items[0]);
  assert.equal(calls.filter(([path]) => path === '/materials/from-url').length, 1);
  assert.ok(calls.slice(1).every(([, method]) => method === 'GET'));
});

test('URL fetch failure requires confirmed reimport with a new ID; local resume never refetches', async () => {
  const calls = []; let allow = false, imports = 0;
  const value = workspace(async (path, options = {}) => {
    calls.push({ path, method: options.method || 'GET', body: options.body });
    if (options.method === 'DELETE') return {};
    if (path === '/materials/from-url') return ++imports === 1 ? { status: 'error', snapshotReady: false } : urlReady(options.body.id, 'new-snapshot');
    if (path.endsWith('/parts')) return partText;
    return { status: 'error', snapshotReady: false };
  }, { confirmUrlImport: async (url, options) => { assert.equal(url, 'https://public.example/one'); assert.deepEqual(options, { mode: 'webpage' }); return allow; } });
  await value.addUrl('https://public.example/one', { mode: 'webpage' });
  const item = value.items[0], oldId = item.remoteId;
  await value.resume(item); assert.equal(imports, 1); assert.ok(!calls.some(c => c.path.endsWith('/finish')));
  assert.equal(await value.reimportUrl(item), false); assert.equal(imports, 1);
  allow = true; assert.equal(await value.reimportUrl(item), true);
  assert.notEqual(item.remoteId, oldId); assert.equal(item.snapshotId, 'new-snapshot');
  const deletion = calls.findIndex(c => c.method === 'DELETE');
  const creation = calls.findLastIndex(c => c.path === '/materials/from-url');
  assert.equal(calls[deletion].path, '/materials/' + oldId); assert.ok(deletion < creation);
});

test('URL local finish is only retried explicitly after snapshotReady, without fetch replay', async () => {
  let id; const calls = [];
  const value = workspace(async (path, options = {}) => {
    calls.push([path, options.method || 'GET']);
    if (path === '/materials/from-url') { id = options.body.id; return { status: 'error', snapshotReady: true }; }
    if (path.endsWith('/finish')) return urlReady(id);
    if (path.endsWith('/parts')) return partText;
    return { status: 'error', snapshotReady: true };
  });
  await value.addUrl('https://public.example/document');
  assert.ok(!calls.some(([p]) => p.endsWith('/finish')));
  await value.resume(value.items[0]);
  assert.equal(value.items[0].status, 'ready');
  assert.equal(calls.filter(([p]) => p.endsWith('/finish')).length, 1);
  assert.equal(calls.filter(([p]) => p === '/materials/from-url').length, 1);
});

test('cancellation before queued create tombstones the chosen ID, never posts a replacement', async () => {
  const calls = [], value = workspace(async (path, options) => { calls.push([path, options.method]); return {}; });
  const pending = value.addUrl('https://public.example/video');
  const item = value.items[0], id = item.remoteId;
  value.cancelPending();
  await assert.rejects(pending, { name: 'AbortError' }); await item.deletePending;
  assert.deepEqual(calls, [['/materials/' + id, 'DELETE']]);
  assert.equal(item.cancelled, true); assert.equal(item.status, 'error');
  await value.resume(item); assert.equal(calls.length, 1);
});

test('cancellation while create ack is delayed cannot resurrect a URL snapshot', async () => {
  const created = deferred(), ack = deferred(), calls = [];
  const value = workspace(async (path, options) => {
    calls.push([path, options.method]);
    if (options.method === 'DELETE') return {};
    created.resolve(); return ack.promise;
  });
  const pending = value.addUrl('https://public.example/video');
  await created.promise; const item = value.items[0];
  await value.cancelUrl(item); ack.resolve(urlReady(item.remoteId));
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(item.status, 'error'); assert.equal(item.manifest, undefined);
  assert.deepEqual(calls.map(c => c[1]), ['POST', 'DELETE']);
});

test('URL session loss, pending-source locks and confirmation races cannot refetch', async () => {
  const calls = []; let id;
  const confirmation = deferred();
  const value = workspace(async (path, options = {}) => {
    calls.push(path);
    if (path === '/materials/from-url') { id = options.body.id; return urlReady(id); }
    if (path.endsWith('/parts')) return partText;
    return {};
  }, { confirmUrlImport: () => confirmation.promise });
  await value.addUrl('https://public.example/text'); const item = value.items[0];
  for (const lock of ['locked', 'pending', 'preparing']) {
    value[lock] = lock === 'pending' ? 1 : true;
    const before = calls.length;
    await assert.rejects(value.addUrl('https://public.example/other'), /Wait/);
    await assert.rejects(value.add([]), /Wait/);
    await value.resume(item); await value.remove(item); await value.reimportUrl(item);
    assert.equal(calls.length, before); value[lock] = lock === 'pending' ? 0 : false;
  }
  const confirming = value.reimportUrl(item);
  await Promise.resolve(); value.cancelPending({ session: true }); confirmation.resolve(true);
  await assert.rejects(confirming, { name: 'AbortError' });
  const before = calls.length;
  await value.resume(item); await assert.rejects(value.prepare(settings), /failed local imports/);
  assert.equal(calls.length, before); assert.equal(item.needsUpload, true);
  assert.ok(!JSON.stringify(value.checkpointInfo()).includes('https://'));
});

test('MP4/WebM uploads request whole-video, while audio-only manifests retain STT fallback', async () => {
  for (const extension of ['mp4', 'webm']) {
    const calls = []; let id;
    const value = workspace(async (path, options = {}) => {
      calls.push({ path, ...options });
      if (path === '/materials') { id = options.body.id; return { status: 'uploading', received: 0 }; }
      if (path.includes('/content?')) return { status: 'uploading', received: 1 };
      if (path.endsWith('/finish')) return { ...urlReady(id), kind: 'media', hasAudio: true, hasVideo: false, analysisMode: 'sampled-stills' };
      if (path.endsWith('/parts')) return { text: '', audio: 'synthetic-audio', images: [] };
      assert.fail(path);
    });
    await value.add([new File(['x'], 'audio-only.' + extension)]);
    assert.equal(calls[0].body.analysisMode, 'whole-video');
    assert.equal(value.needsVideoAnalysis, false); assert.equal(value.needsTranscription, true); assert.equal(value.hasVisuals, false);
  }
});

test('all native windows become source notes; role-free complete receipts return coverage refs without STT/OCR', async () => {
  const f = nativeFixture();
  assert.equal(f.value.needsVideoAnalysis, true); assert.equal(f.value.needsTranscription, false);
  const prepared = await f.value.prepare({ ...settings, roles: {} });
  assert.match(prepared.text, /10–11.25s/);
  const p = f.makePlan(24), r = f.result(p, 0);
  for (const w of r.windows) for (const key of ['transcript', 'visibleText', 'observations']) assert.ok(prepared.text.includes(w[key]));
  assert.match(prepared.text, /Derived visual observations \(not original quoted text\)/);
  assert.deepEqual(prepared.videoPlans, [{ materialId: f.item.remoteId, snapshotId: f.item.snapshotId, planId: p.id }]);
  assert.equal(f.value.needsVideoAnalysis, false); assert.equal(f.value.hasVisuals, false);
  assert.ok(!f.calls.some(c => ['/transcribe', '/audio/extract', '/video/analyze'].includes(c.path)));
  assert.ok(!f.calls.some(c => c.path.startsWith('/video/') && c.method === 'POST'));
  assert.equal(f.value.checkpoint.pinned.size, 1); assert.equal(f.value.checkpoint.sourceIndex.size, 1);
  assert.match(f.value.describe({ roles: { video: { ...role, fps: 12 } }, completeAudio: true }), /12 requested FPS/);
  assert.match(f.value.describe(), /cost indicators, not a price/);
});

test('eager and deferred full audio use identical pinned native receipts, never lossy digests or descriptions', async () => {
  const f = nativeFixture({ duration: 41.25 });
  const ordinary = await f.value.prepare(settings), saved = structuredClone(ordinary), before = f.calls.length;
  assert.equal(f.calls.filter(c => c.path === '/materials/summarize').length, 2);
  for (const c of f.calls.filter(c => c.path === '/materials/summarize')) assert.match(c.body.text, /ORIGINAL speech/);
  f.value.cache.clear(); f.value.cacheBytes = 0;
  const deferredSources = await f.value.upgradeAudioSources({ ...settings, roles: {} });
  assert.deepEqual(ordinary, saved);
  assert.ok(f.calls.slice(before).every(c => c.path.endsWith('/parts')), 'Upgrade only reads local references and pinned results');
  assert.equal(deferredSources.length, 18);
  assert.ok(deferredSources.every(s => !/DERIVED|lossy/.test(s.text)));
  assert.match(deferredSources.at(-1).source, /^40–41.25s/);
  const eager = await f.value.prepare({ ...settings, completeAudio: true });
  assert.deepEqual(eager.audioSources, deferredSources);
  assert.ok(!f.calls.some(c => ['/transcribe', '/audio/extract', '/video/analyze'].includes(c.path)));
});

test('audio upgrade fails closed on missing or damaged pinned native receipts despite cached results', async () => {
  for (const missing of ['index', 'pin', 'invalid']) {
    const f = nativeFixture(); await f.value.prepare(settings);
    const job = f.value.checkpoint, key = [...job.pinned.keys()][0];
    if (missing === 'index') job.sourceIndex.clear();
    else if (missing === 'pin') job.pinned.delete(key);
    else job.pinned.get(key).windows.pop();
    const before = f.calls.length;
    await assert.rejects(f.value.upgradeAudioSources(settings), /receipt|saved source result/);
    assert.ok(f.calls.slice(before).every(c => c.path.endsWith('/parts')));
  }
});

test('ordinary Stop pins late accepted native result before callbacks and cache eviction cannot replay it', async () => {
  const dispatched = deferred(), ack = deferred(); let posts = 0;
  const f = nativeFixture({ initial: 'pending', video: ({ options, plan, index, states, result }) => {
    const clip = plan.clips[index];
    if (options.method === 'POST') { posts++; dispatched.resolve(); return ack.promise; }
    return states.get(clip.id);
  } });
  const pending = f.value.prepare(settings); await dispatched.promise;
  const job = f.value.checkpoint; f.value.cancelPending();
  ack.resolve({ id: f.makePlan(24).clips[0].id, status: 'complete', result: f.result(f.makePlan(24), 0) });
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(job.pinned.size, 1); assert.equal(job.sourceIndex.size, 1); assert.equal(f.value.cache.size, 1);
  f.value.cache.clear(); f.value.cacheBytes = 0;
  const result = await f.value.prepare({ ...settings, roles: {}, resume: true });
  assert.match(result.text, /ORIGINAL speech/); assert.equal(posts, 1);
});

test('ordinary Stop during processing leaves background job alone; Continue polls complete without a role', async () => {
  const waiting = deferred(); let posts = 0;
  const f = nativeFixture({ initial: 'pending', wait: signal => { waiting.resolve(); return new Promise((_, reject) => { const abort = () => reject(new DOMException('Stopped', 'AbortError')); if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true }); }); }, video: ({ options, plan, index, states }) => {
    const clip = plan.clips[index];
    if (options.method === 'POST') { posts++; states.set(clip.id, { id: clip.id, status: 'processing', attemptId: options.body.attemptId }); }
    return states.get(clip.id);
  } });
  const pending = f.value.prepare(settings); await waiting.promise; f.value.cancelPending();
  await assert.rejects(pending, { name: 'AbortError' });
  const p = f.makePlan(24); f.states.set(p.clips[0].id, { id: p.clips[0].id, status: 'complete', result: f.result(p, 0) });
  await f.value.prepare({ ...settings, roles: {}, resume: true });
  assert.equal(posts, 1); assert.ok(!f.calls.some(c => c.method === 'DELETE'));
});

test('discard and session loss cannot resurrect late native result or its cache/index', async () => {
  for (const discard of [v => v.discardCheckpoint(), v => v.cancelPending({ session: true })]) {
    const dispatched = deferred(), ack = deferred();
    const f = nativeFixture({ initial: 'pending', video: ({ options, plan, index, states }) => {
      if (options.method === 'POST') { dispatched.resolve(); return ack.promise; }
      return states.get(plan.clips[index].id);
    } });
    const pending = f.value.prepare(settings); await dispatched.promise;
    const job = f.value.checkpoint; discard(f.value);
    const p = f.makePlan(24); ack.resolve({ id: p.clips[0].id, status: 'complete', result: f.result(p, 0) });
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(f.value.checkpoint, null); assert.equal(job.pinned.size, 0); assert.equal(job.sourceIndex.size, 0); assert.equal(f.value.cache.size, 0);
  }
});

test('failed clip waits for renewed Continue; provider/model may change but FPS may not implicitly resume', async () => {
  const posts = [];
  const f = nativeFixture({ initial: 'failed', video: ({ options, plan, index, states, result }) => {
    const clip = plan.clips[index];
    if (options.method === 'POST') { posts.push(options.body); return { id: clip.id, status: 'complete', result: result(plan, index) }; }
    return states.get(clip.id);
  } });
  await assert.rejects(f.value.prepare(settings), /renewed consent/); assert.equal(posts.length, 0);
  const before = f.calls.length;
  await assert.rejects(f.value.prepare({ ...settings, resume: true, roles: { ...settings.roles, video: { ...role, fps: 12 } } }), /video FPS must match/);
  assert.equal(f.calls.length, before);
  await f.value.prepare({ ...settings, resume: true, expectedSetupRevision: 8, roles: { ...settings.roles, video: { ...role, providerId: 'other', model: 'changed' } } });
  assert.equal(posts.length, 1); assert.equal(posts[0].retry, true); assert.equal(posts[0].expectedSetupRevision, 8);
});

test('new generation chooses a new FPS plan and snapshot identity changes invalidate continuation and audio', async () => {
  const f = nativeFixture(); const first = await f.value.prepare(settings), keys = [...f.value.checkpoint.sourceIndex.keys()];
  const second = await f.value.prepare({ ...settings, roles: { ...settings.roles, video: { ...role, fps: 12 } } });
  assert.notEqual(first.videoPlans[0].planId, second.videoPlans[0].planId);
  assert.notDeepEqual([...f.value.checkpoint.sourceIndex.keys()], keys);
  f.item.manifest.snapshotId = crypto.randomUUID();
  const before = f.calls.length;
  await assert.rejects(f.value.prepare({ ...settings, resume: true }), /matching preparation checkpoint/);
  await assert.rejects(f.value.upgradeAudioSources(settings), /same ordered materials/);
  assert.equal(f.calls.length, before);
});

test('checkpoint_failed is repaired without video role or paid budget and part identity is checked', async () => {
  const f = nativeFixture({ initial: 'checkpoint_failed', video: ({ options, plan, index, result }) => {
    const clip = plan.clips[index];
    return options.method === 'POST' ? { id: clip.id, status: 'complete', result: result(plan, index) } : { id: clip.id, status: 'checkpoint_failed', attemptId: '7b2e32e9-399a-40ed-9a6f-876a095a8797' };
  } });
  await f.value.prepare({ ...settings, roles: {} });
  assert.equal(f.value.checkpoint.calls, 0);
  const posts = f.calls.filter(c => c.path.startsWith('/video/') && c.method === 'POST');
  assert.equal(posts.length, 1); assert.equal(posts[0].body.attemptId, '7b2e32e9-399a-40ed-9a6f-876a095a8797');
  const wrong = nativeFixture();
  wrong.value.part = async () => ({ videoRef: { materialId: wrong.item.remoteId, snapshotId: 'different', index: 0 }, start: 0, end: 11.25, analysisMode: 'whole-video' });
  await assert.rejects(wrong.value.prepare(settings), /immutable snapshot/);
  assert.ok(!wrong.calls.some(c => c.path.startsWith('/video/')));
});

test('cancel during confirmed reimport cleanup leaves an error, not a ready deleted snapshot', async () => {
  const deleting = deferred(), deletion = deferred(); let imports = 0, deletes = 0;
  const value = workspace(async (path, options = {}) => {
    if (path === '/materials/from-url') { imports++; return urlReady(options.body.id); }
    if (path.endsWith('/parts')) return partText;
    if (options.method === 'DELETE') { if (++deletes === 1) { deleting.resolve(); return deletion.promise; } return {}; }
    assert.fail(path);
  }, { confirmUrlImport: async () => true });
  await value.addUrl('https://public.example/text'); const item = value.items[0], id = item.remoteId;
  const pending = value.reimportUrl(item); await deleting.promise;
  value.cancelPending(); deletion.resolve({});
  await assert.rejects(pending, { name: 'AbortError' }); await item.deletePending;
  assert.equal(imports, 1); assert.equal(item.remoteId, id); assert.equal(item.status, 'error'); assert.equal(item.cancelled, true);
});

test('URL entry validation and unsealed ready status fail without leaking the private URL', async () => {
  let requests = 0;
  const value = workspace(async path => { requests++; assert.equal(path, '/materials/from-url'); return { status: 'ready', kind: 'text', partCount: 1, snapshotReady: false }; });
  for (const [url, options] of [['http://public.example', {}], ['https://user:secret@public.example', {}], ['https://public.example', { mode: 'unknown' }], ['not a URL', {}]]) await assert.rejects(value.addUrl(url, options), /public HTTPS|supported import mode/);
  assert.equal(requests, 0);
  await value.addUrl('https://public.example/?token=SECRET');
  assert.equal(value.items[0].status, 'error'); assert.equal(requests, 1);
  assert.ok(!JSON.stringify(value.checkpointInfo()).includes('SECRET')); assert.ok(!value.items[0].error.includes('SECRET'));
});

test('native budget and checkpoint headroom reserve before a new POST, not before receipt reuse', async () => {
  for (const limit of ['calls', 'bytes']) {
    const f = nativeFixture({ initial: 'pending' });
    await assert.rejects(f.value.prepare({ ...settings, progress: () => {
      const job = f.value.checkpoint;
      if (limit === 'calls') job.calls = 512;
      else job.pinnedBytes = 64 * 1024 * 1024;
    } }), /safety budget|checkpoint quota/);
    assert.ok(f.calls.some(c => c.path.startsWith('/video/') && c.method === 'GET'));
    assert.ok(!f.calls.some(c => c.path.startsWith('/video/') && c.method === 'POST'));
  }
  const complete = nativeFixture();
  await complete.value.prepare({ ...settings, roles: {}, progress: () => { complete.value.checkpoint.calls = 512; } });
  assert.equal(complete.value.checkpoint.pinned.size, 1);
});

test('fresh generations reuse native receipts with exact bounded cache accounting', async () => {
  const f = nativeFixture();
  await f.value.prepare(settings); const bytes = f.value.cacheBytes;
  await f.value.prepare({ ...settings, roles: {} });
  assert.equal(f.value.cacheBytes, bytes);
  assert.equal(f.value.cacheBytes, [...f.value.cache.values()].reduce((n, entry) => n + entry.size, 0));
  assert.ok(!f.calls.some(c => c.path.startsWith('/video/') && c.method === 'POST'));
});
