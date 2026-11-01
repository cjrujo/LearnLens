import test from 'node:test';
import assert from 'node:assert/strict';
import { VideoAnalysisClient, videoFps, validateVideoPlan, validateVideoAnalysis, videoSourceNotes } from '../public/video-client.js';
import { parseVideoAnalysis, videoWindows } from '../lib/video-analysis.mjs';

const role = { providerId: 'fake', model: 'fake-native', api: 'gemini', fps: 24 };
const plan = () => ({ id: 'a'.repeat(64), materialId: 'material-1', snapshotId: 'snapshot-1', sourceHash: 'b'.repeat(64), profileVersion: 1, fps: 24, duration: 11.25, hasAudio: true, hasVideo: true, analysisMode: 'whole-video', summary: { totalClips: 1, completedClips: 0, status: 'ready' }, clips: [{ id: 'c'.repeat(64), index: 0, start: 0, end: 11.25, status: 'pending' }] });
const expected = () => ({ ...plan(), partCount: 1 });
function analysis(p = plan(), index = 0) {
  const clip = p.clips[index];
  return parseVideoAnalysis(JSON.stringify({ version: 1, windows: videoWindows(clip.end - clip.start).map((bounds, n) => ({ ...bounds, transcript: ` speech ${n}\n`, visibleText: `screen ${n} / 2`, observations: `DERIVED ${n}`, audioCoverage: 'complete', visualCoverage: 'complete' })), warnings: [] }), { ...clip, hasAudio: true, videoSha256: 'd'.repeat(64) }, { fps: p.fps });
}
const receipt = (status, extra = {}) => ({ id: plan().clips[0].id, status, attempts: status === 'pending' ? 0 : 1, providerRequested: status !== 'pending', ...extra });
const done = () => receipt('complete', { result: analysis() });
const network = () => Object.assign(new Error('Synthetic lost acknowledgement'), { network: true });
function fixture(responses) {
  const calls = [];
  const client = new VideoAnalysisClient({ wait: async () => {}, api: async (path, options = {}) => {
    calls.push({ path, ...options });
    assert.ok(responses.length, 'No unplanned automatic request');
    const value = responses.shift();
    if (value instanceof Error) throw value;
    return typeof value === 'function' ? value(options, path) : structuredClone(value);
  } });
  return { client, calls, run: options => client.analyze({ plan: plan(), index: 0, state: {}, role, consent: true, expectedSetupRevision: 7, ...options }) };
}

test('local checkpoint repair polls while its writer runs without another POST or role', async () => {
  const attemptId = crypto.randomUUID();
  const f = fixture([receipt('checkpoint_failed', { attemptId }), receipt('checkpoint_failed', { attemptId, working: true }), receipt('checkpoint_failed', { attemptId, working: true }), done()]);
  await f.run({ role: null });
  assert.deepEqual(f.calls.map(call => call.method || 'GET'), ['GET', 'POST', 'GET', 'GET']);
});

test('failed native receipt exposes safe diagnostics and never retries without new consent', async () => {
  const diagnostics = { category: 'timeout', timeoutMs: 600000, automaticRetry: false };
  const f = fixture([receipt('failed', { diagnostics })]);
  await assert.rejects(f.run(), error => error.stage === 'video_analysis' && error.diagnostics.timeoutMs === 600000);
  assert.equal(f.calls.length, 1);
});

test('known rejected dispatch remains a known HTTP error after read-only pending recovery', async () => {
  const rejected = Object.assign(new Error('Confirm changed AI setup'), { status: 409 });
  const f = fixture([receipt('pending'), rejected, receipt('pending')]);
  await assert.rejects(f.run(), error => error === rejected);
  assert.deepEqual(f.calls.map(call => call.method || 'GET'), ['GET', 'POST', 'GET']);
});

test('native plan is read-only when present, created locally only after a 404', async () => {
  const present = fixture([plan()]);
  await present.client.plan(expected());
  assert.deepEqual(present.calls.map(c => [c.path, c.method]), [['/materials/material-1/video-plan?fps=24', undefined]]);
  const missing = fixture([Object.assign(new Error('missing'), { status: 404 }), plan()]);
  await missing.client.plan(expected());
  assert.deepEqual(missing.calls[1].body, { fps: 24 });
  const offline = fixture([network()]);
  await assert.rejects(offline.client.plan(expected()));
  assert.equal(offline.calls.length, 1, 'Unknown status never implies permission to create');
});

test('plan validation rejects snapshot/hash/FPS/profile/count and coverage drift', () => {
  const changes = [p => p.snapshotId = 'other', p => p.sourceHash = 'e'.repeat(64), p => p.fps = 2, p => p.profileVersion = 2, p => p.summary.totalClips = 2, p => p.hasVideo = false, p => p.clips[0].start = 0.1, p => p.clips[0].end = 9];
  for (const change of changes) { const p = plan(); change(p); assert.throws(() => validateVideoPlan(p, expected())); }
  assert.equal(videoFps({}), 24); assert.equal(videoFps({ fps: 1.5 }), 1.5);
  for (const fps of [0, 25, NaN, '24']) assert.throws(() => videoFps({ fps }));
});

test('complete receipt works without a video role, budget, consent or dispatch', async () => {
  const f = fixture([done()]); let accepted = 0;
  const result = await f.run({ role: null, consent: false, expectedSetupRevision: undefined, beforeDispatch: () => assert.fail('No paid work'), accept: r => { accepted++; return r; } });
  assert.deepEqual(result, analysis()); assert.equal(accepted, 1);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].method, undefined);
});

test('processing is read-only polling even with no role; a later failure needs another Continue', async () => {
  const f = fixture([receipt('processing', { attemptId: 'old' }), receipt('preparing'), done()]);
  await f.run({ role: null });
  assert.ok(f.calls.every(c => !c.method));
  const failed = fixture([receipt('processing', { attemptId: 'old' }), receipt('failed', { attemptId: 'old' })]);
  await assert.rejects(failed.run({ renewedConsent: true }), /explicitly Continue/);
  assert.ok(failed.calls.every(c => !c.method));
});

test('first unpaid receipt is checked before role validation and before budget reservation', async () => {
  const f = fixture([receipt('pending')]);
  await assert.rejects(f.run({ role: null, beforeDispatch: () => assert.fail('No budget reservation') }), /video role/);
  assert.equal(f.calls.length, 1);
  const capped = fixture([receipt('pending')]);
  await assert.rejects(capped.run({ beforeDispatch: () => { throw new Error('quota'); } }), /quota/);
  assert.equal(capped.calls.length, 1);
  const mismatch = fixture([receipt('pending')]);
  await assert.rejects(mismatch.run({ role: { ...role, fps: 1 } }), /FPS changed/);
  assert.equal(mismatch.calls.length, 1);
});

test('one paid POST has exact ledger body, then polls without replaying', async () => {
  const state = {}, f = fixture([receipt('pending'), receipt('processing'), done()]); let reservations = 0;
  await f.run({ state, beforeDispatch: () => reservations++ });
  const post = f.calls[1];
  assert.match(post.path, /^\/video\/plans\/[a-f0-9]{64}\/clips\/[a-f0-9]{64}$/);
  assert.deepEqual(post.body, { consent: true, expectedSetupRevision: 7, attemptId: state.attemptId });
  assert.match(state.attemptId, /^[a-f0-9-]{36}$/);
  assert.equal(reservations, 1); assert.equal(f.calls.filter(c => c.method === 'POST').length, 1);
  assert.ok(!JSON.stringify(post.body).includes('video/mp4'));
});

test('failed/damaged receipts require renewed Continue and a new attempt ID, never same-call retry', async () => {
  for (const status of ['failed', 'damaged']) {
    const old = crypto.randomUUID(), state = { attemptId: old };
    const blocked = fixture([receipt(status, { attemptId: old })]);
    await assert.rejects(blocked.run({ state }), /renewed consent/);
    assert.equal(blocked.calls.length, 1);
    const f = fixture([receipt(status, { attemptId: old }), receipt('failed')]);
    await assert.rejects(f.run({ state, renewedConsent: true, expectedSetupRevision: 8, role: { ...role, model: 'changed' } }), /No automatic retry/);
    assert.equal(f.calls.length, 2); assert.notEqual(state.attemptId, old);
    assert.deepEqual(f.calls[1].body, { consent: true, expectedSetupRevision: 8, attemptId: state.attemptId, retry: true });
  }
});

test('lost POST acknowledgement only GETs known status; unknown/pending never silently replays', async () => {
  const f = fixture([receipt('pending'), network(), receipt('processing'), done()]);
  await f.run();
  assert.deepEqual(f.calls.map(c => c.method || 'GET'), ['GET', 'POST', 'GET', 'GET']);
  const state = {}, pending = fixture([receipt('pending'), network(), receipt('pending')]);
  await assert.rejects(pending.run({ state }), /acknowledgement is unknown/);
  const old = state.attemptId;
  const again = fixture([receipt('pending')]);
  await assert.rejects(again.run({ state }), /renewed consent/);
  const renewed = fixture([receipt('pending'), done()]);
  await renewed.run({ state, renewedConsent: true });
  assert.notEqual(state.attemptId, old); assert.equal(renewed.calls[1].body.retry, true);
});

test('checkpoint_failed repairs locally with original attempt even after role removal', async () => {
  const old = crypto.randomUUID(), f = fixture([receipt('checkpoint_failed', { attemptId: old }), done()]);
  const state = {};
  await f.run({ state, role: null, beforeDispatch: () => assert.fail('Local repair cannot reserve paid work') });
  assert.deepEqual(f.calls[1].body, { consent: true, expectedSetupRevision: 7, attemptId: old });
  const lost = fixture([receipt('checkpoint_failed', { attemptId: old }), network(), done()]);
  await lost.run({ role: null }); assert.deepEqual(lost.calls.map(c => c.method || 'GET'), ['GET', 'POST', 'GET']);
  const failed = fixture([receipt('checkpoint_failed', { attemptId: old }), receipt('checkpoint_failed', { attemptId: old })]);
  await assert.rejects(failed.run({ renewedConsent: true }), /local checkpoint repair/);
  assert.equal(failed.calls.length, 2);
});

test('accepted complete results reach pin callback before an ordinary Stop check', async () => {
  let stopped = false, pinned;
  const f = fixture([receipt('pending'), () => { stopped = true; return done(); }]);
  await assert.rejects(f.run({ check: () => { if (stopped) throw new DOMException('Stopped', 'AbortError'); }, accept: value => { pinned = value; return value; } }), { name: 'AbortError' });
  assert.deepEqual(pinned, analysis());
});

test('malformed receipts never pin or retry; all original windows and separate observations survive notes', async () => {
  for (const mutate of [r => r.windows.pop(), r => r.windows[0].transcript = '\ud800', r => r.windows[0].observations = '', r => r.windows[1].start = 0, r => r.fps = 3, r => r.videoSha256 = 'not-a-hash', r => r.uncertainWindows = 4, r => r.windows[0].sourceStart = 9]) {
    const d = done(); mutate(d.result);
    const f = fixture([d]); await assert.rejects(f.run({ accept: () => assert.fail('Never accept partial text') }), /receipt/);
    assert.equal(f.calls.length, 1);
  }
  const r = analysis(); validateVideoAnalysis(r, { start: 0, end: 11.25, fps: 24 });
  const notes = videoSourceNotes(r);
  for (const w of r.windows) { assert.ok(notes.includes(w.transcript)); assert.ok(notes.includes(w.visibleText)); assert.ok(notes.includes(w.observations)); }
  assert.match(notes, /10–11.25s/); assert.match(notes, /Derived visual observations \(not original quoted text\)/);
});

test('an initializing plan is read-only polled before any clip can dispatch', async () => {
  const initializing = plan(); initializing.summary.status = 'initializing';
  const f = fixture([initializing, plan()]);
  await f.client.plan(expected());
  assert.deepEqual(f.calls.map(c => c.path), ['/materials/material-1/video-plan?fps=24', '/video/plans/' + plan().id]);
  assert.ok(f.calls.every(c => !c.method));
});
