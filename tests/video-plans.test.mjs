import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import * as disk from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createVideoPlanStore, VIDEO_PLAN_LIMITS } from '../lib/video-plans.mjs';
import { videoClipPlan, videoClipBounds } from '../lib/video-clips.mjs';
import { parseVideoAnalysis, videoAnalysisInput } from '../lib/video-analysis.mjs';
import { createMaterialStore } from '../lib/material-store.mjs';
import { syntheticVideoLoader } from './video-test-fixtures.mjs';
import { AppError } from '../lib/provider.mjs';

// Signature-only transport bytes; native A/V decoding belongs to video-clips.test.
// Every encoder/provider below is injected. No network or AI requests are made.
const mp4 = Buffer.from('000000186674797069736f6d0000020069736f6d69736f32', 'hex');
const hash = value => createHash('sha256').update(value).digest('hex');
const role = (fps = 24, overrides = {}) => ({ providerId: 'private-provider', model: 'models/private-model', api: 'gemini', fps, setupRevision: 1, ...overrides });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const isStatus = status => error => error instanceof AppError && error.status === status;
const refs = plan => [{ materialId: plan.materialId, snapshotId: plan.snapshotId, planId: plan.id }];
function native(index, plan) {
  return { video: 'data:video/mp4;base64,' + mp4.toString('base64'), ...videoClipBounds(index, plan), hasVideo: true,
    hasAudio: plan.hasAudio, analysisMode: 'whole-video', videoSha256: hash(mp4) };
}
function result(body, fps = 24, uncertain = false) {
  const input = videoAnalysisInput(body);
  return parseVideoAnalysis(JSON.stringify({ version: 1, windows: input.windows.map((bounds, index) => ({ ...bounds,
    transcript: body.hasAudio ? `Original speech ${body.start + bounds.start} / 原文` : '',
    visibleText: `Original screen ${body.start + bounds.start}: 1 / 2`, observations: 'A diagram changes position.',
    audioCoverage: body.hasAudio ? 'complete' : 'no_audio', visualCoverage: uncertain && index === 0 ? 'uncertain' : 'complete',
  })), warnings: uncertain ? ['Small labels remain uncertain.'] : [] }), input, { fps });
}
function materialFixtures(directory) {
  const entries = new Map();
  const counters = { borrows: 0, activeBorrows: 0 };
  const store = {
    counters, entries,
    add(owner = 'owner', changes = {}) {
      const id = randomUUID(), controller = new AbortController();
      const item = { id, owner, snapshotId: randomUUID(), sourceHash: hash('source-' + id), status: 'ready', snapshotReady: true,
        kind: 'media', name: 'Synthetic source.mp4', duration: 30, hasVideo: true, hasAudio: true, analysisMode: 'whole-video',
        extension: 'mp4', file: join(directory, 'PRIVATE synthetic source.mp4'), controller, ...changes };
      entries.set(item.id, item); return item;
    },
    status(owner, id) {
      const item = entries.get(id);
      if (!item || item.owner !== owner) throw new AppError('No fixture.', 404);
      return { ...item, info: undefined, file: undefined, controller: undefined };
    },
    list(owner) { return [...entries.values()].filter(item => item.owner === owner).map(item => store.status(owner, item.id)); },
    async withSnapshot(owner, id, work) {
      store.status(owner, id); const item = entries.get(id);
      if (store.sourceFailure) throw new Error('PRIVATE_SOURCE_FAILURE');
      counters.borrows++; counters.activeBorrows++;
      try {
        const info = { duration: item.duration, hasAudio: item.hasAudio, hasVideo: item.hasVideo };
        return await work({ id, snapshotId: item.snapshotId, sourceHash: item.sourceHash, kind: item.kind,
          name: item.name, directory, file: item.file, extension: item.extension, info,
          analysisMode: item.analysisMode, videoPlan: videoClipPlan(info), signal: item.controller.signal });
      } finally { counters.activeBorrows--; }
    },
  };
  return store;
}
async function fixture(t, options = {}) {
  const directory = await disk.mkdtemp(join(tmpdir(), 'learnlens-video-plan-test-'));
  const materials = materialFixtures(directory), gates = [], jobs = [], counters = { encoded: 0, analyzed: 0, acquired: 0, released: 0 };
  const state = { active: true };
  const gate = () => { const value = deferred(); gates.push(value); return value; };
  const acquireJob = () => {
    counters.acquired++; const released = deferred(); jobs.push(released);
    return () => { counters.released++; released.resolve(); };
  };
  const clipper = async (file, extension, index, plan, { signal }) => {
    counters.encoded++; assert.equal(extension, 'mp4'); assert.ok(file.startsWith(directory)); assert.equal(signal.aborted, false);
    return native(index, plan);
  };
  const store = createVideoPlanStore({ directory, materials, clipper, ...options });
  const callbacks = (overrides = {}, fps = 24) => ({ acquireJob, checkCurrent: () => {
    if (!state.active) throw new Error('PRIVATE expired owner');
  }, analysisIdentity: role(fps), analyzeClip: async (body, markDispatched) => {
    markDispatched(); counters.analyzed++; return result(body, fps);
  }, ...overrides });
  t.after(async () => {
    gates.forEach(value => value.resolve());
    try { await store.close(); } finally { await disk.rm(directory, { recursive: true, force: true }); }
  });
  const create = async (changes = {}, fps = 24, owner = 'owner') => {
    const source = materials.add(owner, changes);
    return { source, plan: await store.create(owner, source.id, { fps }) };
  };
  const run = async (plan, clip = plan.clips[0], request = {}, deps = {}) => {
    const before = counters.acquired;
    const ack = await store.startAnalysis('owner', plan.id, clip.id, { attemptId: randomUUID(), ...request }, callbacks(deps, plan.fps));
    if (counters.acquired > before) await jobs.at(-1).promise;
    return { ack, status: await store.clipStatus('owner', plan.id, clip.id) };
  };
  const planDirectory = async plan => {
    const roots = await disk.readdir(directory);
    for (const name of roots.filter(name => name.startsWith('learnlens-video-'))) {
      const root = join(directory, name), names = await disk.readdir(root);
      const physical = names.find(name => name.startsWith(plan.id + '-'));
      if (physical) return join(root, physical);
    }
    throw new Error('No fixture plan directory');
  };
  return { directory, store, materials, counters, callbacks, jobs, gate, state, create, run, planDirectory,
    unblockOnCleanup: value => gates.push(value) };
}

test('full original coverage includes every clip/window and precise tail, with idempotent immutable manifests', async t => {
  const f = await fixture(t), { source, plan } = await f.create({ duration: 271.267 });
  assert.equal(plan.clips.length, 10); assert.equal(plan.clips[0].start, 0); assert.equal(plan.clips.at(-1).end, source.duration);
  assert.equal(plan.sourceHash, source.sourceHash); assert.equal(plan.snapshotId, source.snapshotId);
  assert.equal(plan.analysisMode, 'whole-video'); assert.equal(plan.fps, 24); assert.equal(plan.profileVersion, 1);
  assert.deepEqual(await f.store.create('owner', source.id, {}), plan);
  assert.deepEqual(f.store.find('owner', source.id, 24), plan);
  assert.equal(f.counters.encoded, 0); assert.equal(f.materials.counters.borrows, 1);
  await assert.rejects(f.store.assertComplete('owner', refs(plan)), isStatus(409));
  for (const [index, clip] of plan.clips.entries()) {
    const { status } = await f.run(plan, clip, {}, { analyzeClip: async (body, mark) => { mark(); f.counters.analyzed++; return result(body, 24, index === 2); } });
    assert.equal(status.status, 'complete'); assert.equal(status.result.windows[0].sourceStart, clip.start);
    assert.equal(status.result.windows.at(-1).sourceEnd, clip.end);
  }
  const coverage = await f.store.assertComplete('owner', refs(plan));
  assert.equal(coverage.totalClips, 10); assert.equal(coverage.uncertainClips, 1); assert.equal(coverage.coverageBasis, 'model_reported');
  assert.equal(coverage.materials[0].clips.at(-1).end, 271.267);
  assert.equal(f.counters.analyzed, 10); assert.equal(f.counters.encoded, 10); assert.equal(f.counters.released, 10);
  const manifest = f.store.status('owner', plan.id);
  assert.equal(manifest.summary.status, 'complete'); assert.equal(manifest.summary.uncertainClips, 1);
  assert.ok(!JSON.stringify(manifest).includes('Original speech'));
  assert.ok(!JSON.stringify(manifest).includes('Original screen'));
  assert.match((await f.store.clipStatus('owner', plan.id, plan.clips.at(-1).id)).result.windows.at(-1).visibleText, /Original screen/);
  const low = await f.store.create('owner', source.id, { fps: 12 });
  assert.notEqual(low.id, plan.id); assert.notEqual(low.clips[0].id, plan.clips[0].id);
  assert.equal(f.store.status('owner', plan.id).fps, 24);
  assert.equal(f.counters.analyzed, 10);
});

test('silent video and merged short tail retain all visual windows without inventing speech', async t => {
  const f = await fixture(t), { plan } = await f.create({ duration: 60.25, hasAudio: false }, 2.5);
  assert.deepEqual(plan.clips.map(({ start, end }) => ({ start, end })), [{ start: 0, end: 30 }, { start: 30, end: 60.25 }]);
  for (const clip of plan.clips) {
    const { status } = await f.run(plan, clip);
    assert.equal(status.result.fps, 2.5); assert.ok(status.result.windows.every(window => window.audioCoverage === 'no_audio' && window.transcript === ''));
  }
  assert.equal((await f.store.assertComplete('owner', refs(plan))).complete, true);
});

test('lookup is read-only; creation rejects non-whole/unready snapshots and invalid FPS without encoding', async t => {
  const f = await fixture(t), source = f.materials.add();
  assert.throws(() => f.store.find('owner', source.id, 24), isStatus(404));
  assert.equal((await disk.readdir(f.directory)).length, 0);
  for (const fps of [0, 25, '24', NaN, Infinity, null]) await assert.rejects(f.store.create('owner', source.id, { fps }), isStatus(400));
  for (const change of [{ status: 'preparing' }, { snapshotReady: false }, { hasVideo: false }, { analysisMode: 'sampled-stills' }, { sourceHash: 'bad' }, { snapshotId: 'bad' }, { duration: 0 }, { kind: 'text' }]) {
    const invalid = f.materials.add('owner', change);
    await assert.rejects(f.store.create('owner', invalid.id, {}), isStatus(409));
  }
  const plan = await f.store.create('owner', source.id, {});
  assert.throws(() => f.store.status('other', plan.id), isStatus(404));
  assert.throws(() => f.store.find('other', source.id, 24), isStatus(404));
  await assert.rejects(f.store.clipStatus('other', plan.id, plan.clips[0].id), isStatus(404));
  await assert.rejects(f.store.clipStatus('owner', plan.id, 'bad'), isStatus(404));
  assert.equal(f.counters.encoded, 0); assert.equal(f.counters.acquired, 0);
});

test('lost acknowledgement, polling and current-processing POSTs never acquire another job or dispatch', async t => {
  const f = await fixture(t), { plan } = await f.create({ duration: 61 });
  const entered = f.gate(), finish = f.gate(), attemptId = randomUUID(), responseController = new AbortController();
  const callbacks = f.callbacks({ signal: responseController.signal, analyzeClip: async (body, mark) => {
    mark(); f.counters.analyzed++; entered.resolve(body.signal); await finish.promise; return result(body);
  } });
  const accepted = await f.store.startAnalysis('owner', plan.id, plan.clips[0].id, { attemptId }, callbacks);
  assert.equal(accepted.status, 'preparing'); assert.equal(accepted.attemptId, attemptId);
  const backgroundSignal = await entered.promise;
  responseController.abort(); assert.equal(backgroundSignal.aborted, false, 'HTTP acknowledgement loss is not a job cancellation');
  for (let index = 0; index < 5; index++) {
    const pending = await f.store.clipStatus('owner', plan.id, plan.clips[0].id);
    assert.equal(pending.status, 'processing'); assert.equal(pending.providerRequested, true); assert.ok(!pending.result);
    assert.equal(f.store.find('owner', plan.materialId, 24).summary.status, 'processing');
    assert.equal((await f.store.startAnalysis('owner', plan.id, plan.clips[0].id, { attemptId: index % 2 ? randomUUID() : attemptId, retry: true }, {})).status, 'processing');
  }
  await assert.rejects(f.store.startAnalysis('owner', plan.id, plan.clips[1].id, { attemptId }, callbacks), /another clip/);
  assert.equal(f.counters.acquired, 1); assert.equal(f.counters.encoded, 1); assert.equal(f.counters.analyzed, 1);
  finish.resolve(); await f.jobs[0].promise;
  for (const id of [attemptId, randomUUID()]) assert.equal((await f.store.startAnalysis('owner', plan.id, plan.clips[0].id, { attemptId: id }, {})).status, 'complete');
  assert.equal(f.counters.acquired, 1); assert.equal(f.counters.released, 1);
});

test('failed/unknown provider outcomes need explicit new attempts; unfinished work may use newly confirmed model identity', async t => {
  const f = await fixture(t), { plan } = await f.create(), attemptId = randomUUID();
  const failed = await f.run(plan, plan.clips[0], { attemptId }, { analyzeClip: async (_body, mark) => {
    mark(); f.counters.analyzed++; throw new AppError('PRIVATE secret https://gateway.example/?key=SECRET C:\\private\\file', 502);
  } });
  assert.equal(failed.status.status, 'failed'); assert.equal(failed.status.providerRequested, true);
  assert.match(failed.status.error, /may have processed/); assert.ok(!/PRIVATE|SECRET|gateway|C:/.test(failed.status.error));
  assert.equal((await f.store.startAnalysis('owner', plan.id, plan.clips[0].id, { attemptId, retry: true }, {})).status, 'failed');
  await assert.rejects(f.store.startAnalysis('owner', plan.id, plan.clips[0].id, { attemptId: randomUUID() }, f.callbacks()), /explicit retry/);
  await assert.rejects(f.store.startAnalysis('owner', plan.id, plan.clips[0].id, { attemptId: randomUUID(), retry: true }, f.callbacks({ analysisIdentity: role(12) })), /immutable sampling/);
  const retried = await f.run(plan, plan.clips[0], { retry: true }, { analysisIdentity: role(24, { providerId: 'second-provider', model: 'models/new-confirmed-model', setupRevision: 2 }) });
  assert.equal(retried.status.status, 'complete'); assert.equal(retried.status.attempts, 2);
  assert.equal(f.counters.analyzed, 2); assert.equal(f.counters.released, 2);
  assert.equal((await f.store.startAnalysis('owner', plan.id, plan.clips[0].id, { attemptId }, {})).status, 'complete');
  assert.equal(f.counters.analyzed, 2);
});

test('source, encoder and pre-dispatch confirmation errors remain unbilled failures and never auto-retry', async t => {
  for (const stage of ['source', 'encoder', 'confirmation']) await t.test(stage, async t => {
    const f = await fixture(t, stage === 'encoder' ? { clipper: async () => { throw new Error('PRIVATE encoder path'); } } : {});
    const { plan } = await f.create();
    if (stage === 'source') f.materials.sourceFailure = true;
    const { status } = await f.run(plan, plan.clips[0], {}, stage === 'confirmation' ? { analyzeClip: async () => { throw new AppError('PRIVATE changed revision', 409); } } : {});
    assert.equal(status.status, 'failed'); assert.equal(status.providerRequested, false); assert.match(status.error, /No provider request was recorded/);
    const count = f.counters.acquired;
    await f.store.startAnalysis('owner', plan.id, plan.clips[0].id, { attemptId: status.attemptId, retry: true }, {});
    assert.equal(f.counters.acquired, count); assert.equal(f.counters.analyzed, 0);
  });
});

test('validated responses survive write, rename and post-rename failure with local-only recovery and no new attempt', async t => {
  for (const stage of ['write', 'rename', 'after-rename']) await t.test(stage, async t => {
    let fail = true, writes = 0, returned;
    const f = await fixture(t, {
      writeResult: async (...args) => { writes++; if (fail && stage === 'write') throw new Error('PRIVATE disk path'); return disk.writeFile(...args); },
      fs: { rename: async (...args) => { if (fail && stage === 'rename') throw new Error('PRIVATE rename'); await disk.rename(...args); if (fail && stage === 'after-rename') throw new Error('PRIVATE after rename'); } },
    });
    const { plan } = await f.create(), attemptId = randomUUID();
    const first = await f.run(plan, plan.clips[0], { attemptId }, { analyzeClip: async (body, mark) => {
      mark(); f.counters.analyzed++; returned = result(body); return returned;
    } });
    assert.equal(first.status.status, 'checkpoint_failed'); assert.ok(!first.status.result); assert.equal(first.status.providerRequested, true);
    assert.match(first.status.error, /without another provider/);
    returned.windows[0].transcript = 'Mutated adapter return object';
    for (let i = 0; i < 3; i++) {
      assert.equal((await f.store.clipStatus('owner', plan.id, plan.clips[0].id)).status, 'checkpoint_failed');
      assert.equal(f.store.find('owner', plan.materialId, 24).summary.status, 'partial');
    }
    assert.equal(writes, 1, 'polling neither writes nor infers completion');
    await assert.rejects(f.store.assertComplete('owner', refs(plan)), isStatus(409));
    fail = false;
    // No role/identity/model/encoder is supplied; use the existing attempt ID.
    await f.store.startAnalysis('owner', plan.id, plan.clips[0].id, { attemptId }, { acquireJob: f.callbacks().acquireJob });
    await f.jobs.at(-1).promise;
    const saved = await f.store.clipStatus('owner', plan.id, plan.clips[0].id);
    assert.equal(saved.status, 'complete'); assert.equal(saved.attempts, 1); assert.equal(saved.attemptId, attemptId);
    assert.match(saved.result.windows[0].transcript, /^Original speech/);
    assert.equal(f.counters.analyzed, 1); assert.equal(f.counters.encoded, 1); assert.equal(f.counters.acquired, 2); assert.equal(f.counters.released, 2);
    assert.equal(f.materials.counters.borrows, 3, 'create, analysis and failed coverage check only; local recovery never borrows/re-fetches the source');
  });
});

test('accepted result is pinned before local write; role removal after dispatch cannot discard it', async t => {
  const entered = deferred(), finish = deferred(); let writes = 0, hasRole = true;
  const f = await fixture(t, { writeResult: async (...args) => { writes++; entered.resolve(); await finish.promise; return disk.writeFile(...args); } });
  f.unblockOnCleanup(finish);
  const { plan } = await f.create();
  await f.store.startAnalysis('owner', plan.id, plan.clips[0].id, { attemptId: randomUUID() }, f.callbacks({ analyzeClip: async (body, mark) => {
    assert.equal(hasRole, true); mark(); f.counters.analyzed++; return result(body);
  } }));
  await entered.promise; hasRole = false;
  assert.equal((await f.store.clipStatus('owner', plan.id, plan.clips[0].id)).status, 'processing');
  finish.resolve(); await f.jobs[0].promise;
  assert.equal((await f.store.clipStatus('owner', plan.id, plan.clips[0].id)).status, 'complete');
  assert.equal(writes, 1); assert.equal(f.counters.analyzed, 1);
});

test('checkpoint recovery ignores replacement attempt/model arguments and cannot collide with another clip attempt', async t => {
  let fail = false;
  const f = await fixture(t, { writeResult: async (...args) => { if (fail) throw new Error('disk'); return disk.writeFile(...args); } });
  const { plan } = await f.create({ duration: 60 });
  const good = await f.run(plan), otherId = good.status.attemptId;
  fail = true; const failed = await f.run(plan, plan.clips[1]);
  await assert.rejects(f.store.startAnalysis('owner', plan.id, plan.clips[1].id, { attemptId: otherId }, {}), /another clip/);
  fail = false;
  await f.store.startAnalysis('owner', plan.id, plan.clips[1].id, { attemptId: randomUUID(), retry: true }, {
    acquireJob: f.callbacks().acquireJob, analysisIdentity: { invalid: true }, analyzeClip: () => assert.fail('No replay'),
  });
  await f.jobs.at(-1).promise;
  const saved = await f.store.clipStatus('owner', plan.id, plan.clips[1].id);
  assert.equal(saved.attemptId, failed.status.attemptId); assert.equal(saved.attempts, 1);
  assert.equal(f.counters.analyzed, 2); assert.equal(f.counters.encoded, 2);
});

test('saved files are bounded and hash-verified; same-length corruption blocks teaching and needs explicit regeneration', async t => {
  const f = await fixture(t), { plan } = await f.create(), done = await f.run(plan);
  const path = join(await f.planDirectory(plan), plan.clips[0].id + '.json');
  const bytes = await disk.readFile(path); bytes[bytes.indexOf(Buffer.from('Original speech'))] = 'X'.charCodeAt(0);
  await disk.writeFile(path, bytes);
  await assert.rejects(f.store.assertComplete('owner', refs(plan)), isStatus(409));
  let state = await f.store.clipStatus('owner', plan.id, plan.clips[0].id);
  assert.equal(state.status, 'damaged'); assert.ok(!state.result); assert.equal(f.store.status('owner', plan.id).summary.completedClips, 0);
  await f.store.startAnalysis('owner', plan.id, plan.clips[0].id, { attemptId: done.status.attemptId, retry: true }, {});
  await assert.rejects(f.store.startAnalysis('owner', plan.id, plan.clips[0].id, { attemptId: randomUUID() }, f.callbacks()), /explicit retry/);
  assert.equal(f.counters.analyzed, 1);
  state = (await f.run(plan, plan.clips[0], { retry: true })).status;
  assert.equal(state.status, 'complete'); assert.equal(state.attempts, 2); assert.equal((await f.store.assertComplete('owner', refs(plan))).complete, true);
  await disk.truncate(path, VIDEO_PLAN_LIMITS.resultBytes + 1);
  assert.equal((await f.store.clipStatus('owner', plan.id, plan.clips[0].id)).status, 'damaged');
  assert.equal(f.counters.analyzed, 2);
});

test('disk read failures never leak paths or expose an unverified retained result', async t => {
  let fail = false;
  const f = await fixture(t, { fs: { open: async (...args) => { if (fail) throw new Error('PRIVATE path'); return disk.open(...args); } } });
  const { plan } = await f.create(); await f.run(plan); fail = true;
  const state = await f.store.clipStatus('owner', plan.id, plan.clips[0].id);
  assert.equal(state.status, 'damaged'); assert.ok(!state.result); assert.ok(!state.error.includes('PRIVATE'));
});

test('strict adapter results cannot forge byte identity, intervals, FPS, windows or acceptance metadata', async t => {
  const mutations = [r => r.videoSha256 = '0'.repeat(64), r => r.start = 1, r => r.end = 29, r => r.fps = 12,
    r => r.windows.pop(), r => r.windows[0].sourceStart = 100, r => r.uncertainWindows = 99,
    r => r.windows[0].audioCoverage = 'no_audio', r => r.providerId = 'forged', r => r.coverageBasis = 'certified', r => r.warnings.shift()];
  const f = await fixture(t), { plan } = await f.create();
  for (const [index, mutate] of mutations.entries()) {
    const { status } = await f.run(plan, plan.clips[0], { retry: index > 0 }, { analyzeClip: async (body, mark) => {
      mark(); f.counters.analyzed++; const value = result(body); mutate(value); return value;
    } });
    assert.equal(status.status, 'failed'); assert.equal(status.providerRequested, true); assert.ok(!status.result);
    assert.equal((await disk.readdir(await f.planDirectory(plan))).length, 0);
  }
  assert.equal(f.counters.analyzed, mutations.length);
  const missingMark = await f.run(plan, plan.clips[0], { retry: true }, { analyzeClip: async body => result(body) });
  assert.equal(missingMark.status.status, 'failed'); assert.equal(missingMark.status.providerRequested, false);
  const doubleMark = await f.run(plan, plan.clips[0], { retry: true }, { analyzeClip: async (_body, mark) => { mark(); mark(); } });
  assert.equal(doubleMark.status.status, 'failed'); assert.equal(doubleMark.status.providerRequested, true);
});

test('prepared media is checked against source and actual bytes before any provider invocation', async t => {
  for (const change of [{ start: 1 }, { end: 29 }, { hasAudio: false }, { hasVideo: false }, { analysisMode: 'sampled-stills' }, { videoSha256: '0'.repeat(64) }, { video: 'https://private.example/video' }]) await t.test(JSON.stringify(change), async t => {
    const f = await fixture(t, { clipper: async (_file, _extension, index, plan) => ({ ...native(index, plan), ...change }) });
    const { plan } = await f.create(), { status } = await f.run(plan);
    assert.equal(status.status, 'failed'); assert.equal(status.providerRequested, false); assert.equal(f.counters.analyzed, 0);
  });
});

test('result headroom and bounded private identity metadata are reserved before job acquisition or dispatch', async t => {
  const f = await fixture(t, { limits: { ownerBytes: 400000 } }), { plan } = await f.create();
  await assert.rejects(f.store.startAnalysis('owner', plan.id, plan.clips[0].id, { attemptId: randomUUID() }, f.callbacks()), isStatus(413));
  assert.equal(f.counters.acquired, 0); assert.equal(f.counters.encoded, 0); assert.equal(f.counters.analyzed, 0);
  assert.equal(f.materials.counters.borrows, 1);
  const g = await fixture(t), good = await g.create();
  for (const analysisIdentity of [role(12), role(24, { api: 'auto' }), role(24, { model: 'x'.repeat(201) }), role(24, { providerId: 'https://secret/?key=PRIVATE' }), role(24, { providerId: 1 }), role(24, { setupRevision: undefined }), role(24, { setupRevision: -1 })]) {
    await assert.rejects(g.store.startAnalysis('owner', good.plan.id, good.plan.clips[0].id, { attemptId: randomUUID() }, g.callbacks({ analysisIdentity })), isStatus(409));
  }
  assert.equal(g.counters.acquired, 0);
  const final = await g.run(good.plan, good.plan.clips[0], {}, { analysisIdentity: { ...role(), apiKey: 'NEVER_SAVE', baseUrl: 'https://PRIVATE.example' } });
  const directory = await g.planDirectory(good.plan), files = await disk.readdir(directory);
  assert.deepEqual(files, [good.plan.clips[0].id + '.json']);
  const saved = await disk.readFile(join(directory, files[0]), 'utf8');
  assert.ok(!/NEVER_SAVE|PRIVATE|private-provider|private-model|data:video|Original synthetic/.test(saved));
  assert.ok(!/private-provider|private-model|NEVER_SAVE/.test(JSON.stringify(final.status)));
});

test('full headroom is retained during work and shrinks only after a verified file, permitting complete long videos', async t => {
  const f = await fixture(t, { limits: { ownerBytes: 600000 } }), { plan } = await f.create({ duration: 60 });
  const entered = f.gate(), finish = f.gate();
  await f.store.startAnalysis('owner', plan.id, plan.clips[0].id, { attemptId: randomUUID() }, f.callbacks({ analyzeClip: async (body, mark) => {
    mark(); f.counters.analyzed++; entered.resolve(); await finish.promise; return result(body);
  } }));
  await entered.promise;
  await assert.rejects(f.store.startAnalysis('owner', plan.id, plan.clips[1].id, { attemptId: randomUUID() }, f.callbacks()), isStatus(413));
  assert.equal(f.counters.acquired, 1);
  finish.resolve(); await f.jobs[0].promise;
  await f.run(plan, plan.clips[1]);
  assert.equal((await f.store.assertComplete('owner', refs(plan))).totalClips, 2);
});

test('attempt limits and job admission failures cannot consume an attempt or silently replay old IDs', async t => {
  const f = await fixture(t, { limits: { clipAttempts: 2 } }), { plan } = await f.create(), firstId = randomUUID();
  await assert.rejects(f.store.startAnalysis('owner', plan.id, plan.clips[0].id, { attemptId: firstId }, f.callbacks({ acquireJob: () => { throw new Error('PRIVATE manager'); } })), error => error.status === 429 && !error.message.includes('PRIVATE'));
  assert.equal((await f.store.clipStatus('owner', plan.id, plan.clips[0].id)).attempts, 0);
  const failed = { analyzeClip: async (_body, mark) => { mark(); f.counters.analyzed++; throw new Error('timeout'); } };
  await f.run(plan, plan.clips[0], { attemptId: firstId }, failed);
  await f.run(plan, plan.clips[0], { retry: true }, failed);
  await assert.rejects(f.store.startAnalysis('owner', plan.id, plan.clips[0].id, { attemptId: randomUUID(), retry: true }, f.callbacks()), /attempt limit/);
  assert.equal((await f.store.startAnalysis('owner', plan.id, plan.clips[0].id, { attemptId: firstId, retry: true }, {})).attempts, 2);
  assert.equal(f.counters.analyzed, 2); assert.equal(f.counters.released, 2);
});

test('deletion races with a registered directory initializer without late directories or quota release', async t => {
  const entered = deferred(), finish = deferred(); let eraseCalls = 0, childPath;
  const f = await fixture(t, { fs: { mkdtemp: async prefix => {
    const path = await disk.mkdtemp(prefix);
    if (/[a-f0-9]{64}-$/.test(prefix)) { childPath = path; entered.resolve(); await finish.promise; }
    return path;
  } }, removeDirectory: async path => { eraseCalls++; await disk.rm(path, { recursive: true, force: true }); } });
  f.unblockOnCleanup(finish);
  const source = f.materials.add(), creating = f.store.create('owner', source.id, {});
  const rejected = assert.rejects(creating, isStatus(409));
  await entered.promise;
  const removing = f.store.removeMaterial('owner', source.id);
  await nextTurn(); assert.equal(eraseCalls, 0);
  await assert.rejects(f.store.create('owner', source.id, {}), isStatus(409));
  finish.resolve(); await Promise.all([rejected, removing]);
  await assert.rejects(disk.stat(childPath), error => error.code === 'ENOENT');
  assert.equal(eraseCalls, 1); assert.equal(f.counters.acquired, 0);
});

test('delete aborts and waits for encoder, provider and result writers before physical cleanup; no late publication', async t => {
  for (const stage of ['encoder', 'provider', 'write']) await t.test(stage, async t => {
    const entered = deferred(), finish = deferred(); let signal, erased = 0;
    const options = { removeDirectory: async path => { erased++; await disk.rm(path, { recursive: true, force: true }); } };
    if (stage === 'encoder') options.clipper = async (_file, _extension, index, plan, options) => {
      signal = options.signal; entered.resolve(); await finish.promise; return native(index, plan);
    };
    if (stage === 'write') options.writeResult = async (...args) => { entered.resolve(); await finish.promise; return disk.writeFile(...args); };
    const f = await fixture(t, options), { source, plan } = await f.create();
    f.unblockOnCleanup(finish);
    await f.store.startAnalysis('owner', plan.id, plan.clips[0].id, { attemptId: randomUUID() }, f.callbacks(stage === 'provider' ? { analyzeClip: async (body, mark) => {
      signal = body.signal; mark(); f.counters.analyzed++; entered.resolve(); await finish.promise; return result(body);
    } } : {}));
    await entered.promise;
    const physical = await f.planDirectory(plan), removing = f.store.removeMaterial('owner', source.id);
    if (signal) assert.equal(signal.aborted, true);
    assert.throws(() => f.store.status('owner', plan.id), isStatus(404));
    await assert.rejects(f.store.create('owner', source.id, {}), isStatus(409));
    await nextTurn(); assert.equal(erased, 0); assert.equal(f.counters.released, 0);
    finish.resolve(); await removing;
    assert.equal(f.counters.released, 1); assert.equal(erased, 1); assert.equal(f.materials.counters.activeBorrows, 0);
    await assert.rejects(disk.stat(physical), error => error.code === 'ENOENT');
    await assert.rejects(f.store.clipStatus('owner', plan.id, plan.clips[0].id), isStatus(404));
    assert.equal(f.counters.analyzed, stage === 'encoder' ? 0 : 1);
  });
});

test('verification readers are registered too, and deletion cannot acknowledge before their handles close', async t => {
  const entered = deferred(), finish = deferred(); let blockRead = false, handleClosed = false, erased = false;
  const f = await fixture(t, { fs: { open: async (...args) => {
    const handle = await disk.open(...args);
    if (!blockRead) return handle;
    return { stat: () => handle.stat(), read: async (...args) => { entered.resolve(); await finish.promise; return handle.read(...args); },
      close: async () => { await handle.close(); handleClosed = true; } };
  } }, removeDirectory: async path => { assert.equal(handleClosed, true); erased = true; await disk.rm(path, { recursive: true, force: true }); } });
  f.unblockOnCleanup(finish);
  const { plan } = await f.create(); await f.run(plan); blockRead = true;
  const read = f.store.clipStatus('owner', plan.id, plan.clips[0].id), rejected = assert.rejects(read, isStatus(409));
  await entered.promise;
  const removing = f.store.removeMaterial('owner', plan.materialId);
  await nextTurn(); assert.equal(erased, false);
  finish.resolve(); await Promise.all([rejected, removing]);
  assert.equal(erased, true); assert.equal(handleClosed, true);
});

test('owner invalidation retires detached work without self-await or late resurrection', async t => {
  const f = await fixture(t), { plan } = await f.create(), entered = f.gate(), finish = f.gate();
  await f.store.startAnalysis('owner', plan.id, plan.clips[0].id, { attemptId: randomUUID() }, f.callbacks({ analyzeClip: async (body, mark) => {
    mark(); f.counters.analyzed++; entered.resolve(); await finish.promise; return result(body);
  } }));
  await entered.promise; f.state.active = false; finish.resolve(); await f.jobs[0].promise;
  assert.throws(() => f.store.status('owner', plan.id), isStatus(404));
  assert.deepEqual(await f.store.retryCleanup(), { pending: 0, failed: 0 });
  assert.equal(f.counters.released, 1); assert.equal(f.counters.analyzed, 1);
  assert.equal(f.materials.counters.activeBorrows, 0);
});

test('clearOwner gates admission; failed cleanup retains owner/instance quota and can be retried without a session', async t => {
  let fail = true, erased = 0;
  const f = await fixture(t, { limits: { instancePlans: 1, ownerPlans: 1 }, removeDirectory: async path => {
    erased++; if (fail) throw new Error('PRIVATE removal'); await disk.rm(path, { recursive: true, force: true });
  } });
  const { plan } = await f.create(); await f.run(plan);
  const firstClear = f.store.clearOwner('owner');
  assert.equal(f.store.clearOwner('owner'), firstClear);
  await assert.rejects(firstClear, error => error.status === 503 && !error.message.includes('PRIVATE'));
  assert.throws(() => f.store.status('owner', plan.id), isStatus(404));
  const sameOwner = f.materials.add(), otherOwner = f.materials.add('other');
  await assert.rejects(f.store.create('owner', sameOwner.id, {}), isStatus(409));
  await assert.rejects(f.store.create('other', otherOwner.id, {}), isStatus(413));
  assert.equal(erased, 1);
  fail = false; f.state.active = false;
  assert.deepEqual(await f.store.retryCleanup(), { pending: 0, failed: 0 });
  assert.equal(erased, 2);
  const next = await f.store.create('owner', sameOwner.id, {});
  assert.equal(next.summary.status, 'ready'); assert.equal(f.counters.analyzed, 1);
});

test('failed cleanup holds result byte reservations, not merely plan counts', async t => {
  let fail = true;
  const f = await fixture(t, { limits: { instanceBytes: 600000 },
    writeResult: async () => { throw new Error('disk'); },
    removeDirectory: async path => { if (fail) throw new Error('disk'); await disk.rm(path, { recursive: true, force: true }); } });
  const { plan } = await f.create(); await f.run(plan);
  await assert.rejects(f.store.removeMaterial('owner', plan.materialId), isStatus(503));
  const { plan: second } = await f.create();
  await assert.rejects(f.store.startAnalysis('owner', second.id, second.clips[0].id, { attemptId: randomUUID() }, f.callbacks()), isStatus(413));
  assert.equal(f.counters.analyzed, 1);
  fail = false; await f.store.retryCleanup();
  await f.run(second); assert.equal(f.counters.analyzed, 2);
});

test('owner clearing waits for writers and does not permit concurrent replacement plans', async t => {
  const entered = deferred(), finish = deferred();
  const f = await fixture(t, { writeResult: async (...args) => { entered.resolve(); await finish.promise; return disk.writeFile(...args); } });
  f.unblockOnCleanup(finish);
  const { plan } = await f.create(), next = f.materials.add();
  await f.store.startAnalysis('owner', plan.id, plan.clips[0].id, { attemptId: randomUUID() }, f.callbacks());
  await entered.promise;
  const clearing = f.store.clearOwner('owner');
  await assert.rejects(f.store.create('owner', next.id, {}), isStatus(409));
  finish.resolve(); await clearing;
  assert.equal(f.counters.released, 1);
  assert.equal((await f.store.create('owner', next.id, {})).summary.status, 'ready');
});

test('coverage gate rejects swapped/duplicate/partial refs and changed source identities without provider work', async t => {
  const f = await fixture(t), one = await f.create(), two = await f.create();
  await f.run(one.plan);
  for (const value of [[...refs(one.plan), ...refs(one.plan)], [{ ...refs(one.plan)[0], snapshotId: two.plan.snapshotId }],
    [{ ...refs(one.plan)[0], materialId: two.plan.materialId }], [...refs(one.plan), ...refs(two.plan)]]) {
    await assert.rejects(f.store.assertComplete('owner', value), isStatus(409));
  }
  await assert.rejects(f.store.assertComplete('other', refs(one.plan)), isStatus(404));
  const oldHash = one.source.sourceHash; one.source.sourceHash = 'f'.repeat(64);
  await assert.rejects(f.store.assertComplete('owner', refs(one.plan)), isStatus(409));
  await assert.rejects(f.store.startAnalysis('owner', one.plan.id, one.plan.clips[0].id, { attemptId: randomUUID() }, f.callbacks()), isStatus(409));
  one.source.sourceHash = oldHash; one.source.analysisMode = 'sampled-stills';
  await assert.rejects(f.store.assertComplete('owner', refs(one.plan)), isStatus(409));
  assert.equal(f.counters.analyzed, 1);
  assert.equal((await f.store.assertComplete('owner', [])).totalClips, 0, 'server must separately require references for every attached whole video');
});

test('close is idempotent, rejects new admissions and retries failed physical root cleanup', async t => {
  let failRoot = true, eraseCalls = 0;
  const f = await fixture(t, { removeDirectory: async path => {
    eraseCalls++;
    if (failRoot && !/[a-f0-9]{64}-[^\\/]+$/.test(path)) throw new Error('PRIVATE root path');
    await disk.rm(path, { recursive: true, force: true });
  } });
  const { source, plan } = await f.create(); await f.run(plan);
  const first = f.store.close(); assert.equal(f.store.close(), first);
  await assert.rejects(first, error => error.status === 503 && !error.message.includes('PRIVATE'));
  assert.equal(eraseCalls, 2);
  await assert.rejects(f.store.create('owner', source.id, {}), isStatus(503));
  failRoot = false;
  assert.deepEqual(await f.store.retryCleanup(), { pending: 0, failed: 0 });
  await f.store.close(); assert.equal(eraseCalls, 3);
});

test('initialization failures are sanitized, fully retired and locally retryable without source refetch', async t => {
  let fail = true;
  const f = await fixture(t, { fs: { mkdtemp: async (...args) => { if (fail) throw new Error('PRIVATE mkdtemp'); return disk.mkdtemp(...args); } } });
  const source = f.materials.add();
  await assert.rejects(f.store.create('owner', source.id, {}), error => error.status === 503 && !error.message.includes('PRIVATE'));
  fail = false;
  const plan = await f.store.create('owner', source.id, {});
  assert.equal(plan.summary.status, 'ready'); assert.equal(f.counters.analyzed, 0);
  assert.equal(f.materials.counters.borrows, 2);
});

test('concurrent creation is registered before initialization and creates only one physical directory', async t => {
  const entered = deferred(), finish = deferred(); let directories = 0;
  const f = await fixture(t, { limits: { instancePlans: 1 }, fs: { mkdtemp: async prefix => {
    const path = await disk.mkdtemp(prefix);
    if (/[a-f0-9]{64}-$/.test(prefix)) { directories++; entered.resolve(); await finish.promise; }
    return path;
  } } });
  f.unblockOnCleanup(finish);
  const source = f.materials.add(), first = f.store.create('owner', source.id, {});
  await entered.promise;
  const second = f.store.create('owner', source.id, {});
  assert.equal(f.store.find('owner', source.id, 24).summary.status, 'initializing');
  const other = f.materials.add('other');
  await assert.rejects(f.store.create('other', other.id, {}), isStatus(413));
  finish.resolve(); const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(a, b); assert.equal(directories, 1); assert.equal(f.materials.counters.borrows, 1);
  const oldDirectory = await f.planDirectory(a);
  await f.store.clearOwner('owner');
  const recreated = await f.store.create('owner', source.id, {});
  assert.equal(recreated.id, a.id); assert.notEqual(await f.planDirectory(recreated), oldDirectory);
});

test('source abort or identity changes during encoding cancel work independently of HTTP acknowledgement', async t => {
  for (const change of ['abort', 'hash']) await t.test(change, async t => {
    const entered = deferred(), finish = deferred(); let signal;
    const f = await fixture(t, { clipper: async (_file, _extension, index, plan, options) => {
      signal = options.signal; entered.resolve(); await finish.promise; return native(index, plan);
    } });
    f.unblockOnCleanup(finish);
    const { source, plan } = await f.create();
    await f.store.startAnalysis('owner', plan.id, plan.clips[0].id, { attemptId: randomUUID() }, f.callbacks());
    await entered.promise;
    if (change === 'abort') { source.controller.abort(); assert.equal(signal.aborted, true); }
    else source.sourceHash = 'f'.repeat(64);
    finish.resolve(); await f.jobs.at(-1).promise; await f.store.retryCleanup();
    assert.throws(() => f.store.status('owner', plan.id), isStatus(404));
    assert.equal(f.counters.analyzed, 0); assert.equal(f.counters.released, 1);
  });
});

test('bounded per-attempt metadata exhausts quota before another provider call', async t => {
  const f = await fixture(t, { limits: { ownerBytes: 530000 } }), { plan } = await f.create();
  let denied = false, last;
  const deps = { analysisIdentity: role(24, { providerId: 'p'.repeat(200), model: 'm'.repeat(200), setupRevision: 99 }),
    analyzeClip: async (_body, mark) => { mark(); f.counters.analyzed++; throw new Error('failure'); } };
  for (let i = 0; i < 20; i++) {
    const before = f.counters.acquired;
    try { last = await f.run(plan, plan.clips[0], { retry: i > 0 }, deps); }
    catch (error) { assert.equal(error.status, 413); assert.equal(f.counters.acquired, before); denied = true; break; }
  }
  assert.equal(denied, true); assert.ok(f.counters.analyzed > 0 && f.counters.analyzed < 20);
  const before = f.counters.analyzed;
  await f.store.startAnalysis('owner', plan.id, plan.clips[0].id, { attemptId: last.status.attemptId, retry: true }, {});
  assert.equal(f.counters.analyzed, before);
});

test('a delayed verified reader never exposes result beside a concurrently damaged status', async t => {
  const entered = deferred(), finish = deferred(); let blockClose = false;
  const f = await fixture(t, { fs: { open: async (...args) => {
    const handle = await disk.open(...args);
    if (!blockClose) return handle;
    blockClose = false;
    return { stat: () => handle.stat(), read: (...args) => handle.read(...args),
      close: async () => { entered.resolve(); await finish.promise; await handle.close(); } };
  } } });
  f.unblockOnCleanup(finish);
  const { plan } = await f.create(); await f.run(plan);
  blockClose = true;
  const reading = f.store.clipStatus('owner', plan.id, plan.clips[0].id);
  await entered.promise;
  const path = join(await f.planDirectory(plan), plan.clips[0].id + '.json');
  await disk.writeFile(path, 'corrupted');
  assert.equal((await f.store.clipStatus('owner', plan.id, plan.clips[0].id)).status, 'damaged');
  finish.resolve(); const state = await reading;
  assert.equal(state.status, 'damaged'); assert.ok(!state.result);
});

test('coverage gate rechecks receipt states after asynchronous reads of other clips', async t => {
  const entered = deferred(), finish = deferred(); let blockedPath;
  const f = await fixture(t, { fs: { open: async (...args) => {
    const handle = await disk.open(...args);
    if (args[0] !== blockedPath) return handle;
    blockedPath = null;
    return { stat: () => handle.stat(), read: (...args) => handle.read(...args),
      close: async () => { entered.resolve(); await finish.promise; await handle.close(); } };
  } } });
  f.unblockOnCleanup(finish);
  const { plan } = await f.create({ duration: 60 });
  for (const clip of plan.clips) await f.run(plan, clip);
  const directory = await f.planDirectory(plan);
  blockedPath = join(directory, plan.clips[1].id + '.json');
  const checking = f.store.assertComplete('owner', refs(plan)), rejected = assert.rejects(checking, isStatus(409));
  await entered.promise;
  await disk.writeFile(join(directory, plan.clips[0].id + '.json'), 'corrupted');
  assert.equal((await f.store.clipStatus('owner', plan.id, plan.clips[0].id)).status, 'damaged');
  finish.resolve(); await rejected;
  assert.equal(f.counters.analyzed, 2);
});

test('coverage snapshot failures are sanitized rather than exposing private material errors', async t => {
  const f = await fixture(t), { plan } = await f.create(); await f.run(plan);
  f.materials.sourceFailure = true;
  await assert.rejects(f.store.assertComplete('owner', refs(plan)), error => error.status === 409 && !error.message.includes('PRIVATE'));
  assert.equal(f.counters.analyzed, 1);
});

test('public contract integrates with real immutable material snapshots using only injected media/AI fixtures', async t => {
  const directory = await disk.mkdtemp(join(tmpdir(), 'learnlens-video-material-contract-'));
  const materials = createMaterialStore({ directory, videoLoader: syntheticVideoLoader, limits: { minFreeBytes: 0 },
    mediaLoader: async () => ({ inspectMedia: async () => ({ duration: 30, hasVideo: true, hasAudio: true, partCount: 1 }) }) });
  const ledger = createVideoPlanStore({ directory, materials, clipper: async (_file, _extension, index, plan) => native(index, plan) });
  t.after(async () => { try { await ledger.close(); await materials.close(); } finally { await disk.rm(directory, { recursive: true, force: true }); } });
  const id = randomUUID();
  await materials.create('owner', { id, name: 'synthetic.mp4', size: mp4.length, analysisMode: 'whole-video' });
  await materials.append('owner', id, 0, mp4); const source = await materials.finish('owner', id);
  const plan = await ledger.create('owner', id, { fps: 24 });
  assert.equal(plan.sourceHash, hash(mp4)); assert.equal(plan.snapshotId, source.snapshotId);
  const released = deferred(); let analyzed = 0;
  await ledger.startAnalysis('owner', plan.id, plan.clips[0].id, { attemptId: randomUUID() }, {
    analysisIdentity: role(), acquireJob: () => () => released.resolve(), checkCurrent: () => {},
    analyzeClip: async (body, mark) => { mark(); analyzed++; return result(body); },
  });
  await released.promise;
  assert.equal((await ledger.assertComplete('owner', refs(plan))).complete, true);
  assert.equal(analyzed, 1); assert.equal((await materials.part('owner', id, 0)).videoRef.snapshotId, source.snapshotId);
  await ledger.removeMaterial('owner', id); await materials.remove('owner', id);
  assert.throws(() => ledger.status('owner', plan.id), isStatus(404));
});
