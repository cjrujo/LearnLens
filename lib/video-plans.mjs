// Session-only receipts for native whole-video analysis. This is not a durable
// job queue: no credentials, provider bodies or source media are written here.
import { createHash } from 'node:crypto';
import * as disk from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { AppError } from './provider.mjs';
import { videoFailureDiagnostics } from './video-diagnostics.mjs';
import { DEFAULT_VIDEO_FPS, parseVideoAnalysis, videoAnalysisInput } from './video-analysis.mjs';
import { prepareVideoClip, videoClipPlan, videoClipBounds } from './video-clips.mjs';

const MiB = 1024 * 1024;
export const VIDEO_PROFILE_VERSION = 1;
export const VIDEO_PLAN_LIMITS = Object.freeze({
  ownerBytes: 64 * MiB, instanceBytes: 256 * MiB, ownerPlans: 20,
  instancePlans: 80, resultBytes: 512 * 1024, clipAttempts: 64,
});
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const digest = value => createHash('sha256').update(value).digest('hex');
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const size = value => Buffer.byteLength(JSON.stringify(value));
const notFound = () => new AppError('Video plan not found or expired.', 404);
const cancelled = () => new AppError('Video workspace closed. No further analysis request was made.', 409);
const quotaError = () => new AppError('Temporary video result or metadata quota reached. Remove unused sources or ask the host for more capacity. No new provider request was made.', 413);
const cleanupError = () => new AppError('Private video cleanup failed. Storage remains reserved until cleanup succeeds.', 503);
const incomplete = () => new AppError('Every interval of each attached whole video must have a verified saved analysis before teaching.', 409);
const invalidSource = () => new AppError('A ready immutable whole-video source snapshot is required.', 409);
const invalidResult = () => new AppError('Video analysis did not match the complete prepared interval. No partial result was accepted.', 502);
const CHECKPOINT_ERROR = 'The accepted video analysis is retained in this session, but its local checkpoint failed. Continue to save it locally without another provider request.';
const DAMAGED_ERROR = 'Saved video analysis failed integrity verification. Explicit retry with a new attempt ID is required.';
const planIdFor = (snapshotId, fps) => digest(JSON.stringify([snapshotId, fps, VIDEO_PROFILE_VERSION]));
function sampling(fps = DEFAULT_VIDEO_FPS) {
  if (typeof fps !== 'number' || !Number.isFinite(fps) || fps < 1 || fps > 24) throw new AppError('Video sampling must be between 1 and 24 frames per second.');
  return fps;
}
function identity(value, fps) {
  // Select bounded identifiers only; never retain whole role/provider objects.
  if (!value || typeof value.providerId !== 'string' || typeof value.model !== 'string' ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,199}$/.test(value.providerId) ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_./-]{0,199}$/.test(value.model) ||
      value.api !== 'gemini' || value.fps !== fps || !Number.isSafeInteger(value.setupRevision) || value.setupRevision < 0) throw new AppError('Confirm a Gemini-native video role and setup revision matching this plan\'s immutable sampling rate.', 409);
  return { providerId: value.providerId, model: value.model, api: 'gemini', fps, setupRevision: value.setupRevision };
}
function sourceDescriptor(value) {
  if (!value || !uuid(value.id) || !uuid(value.snapshotId) || !hex(value.sourceHash) || value.status !== 'ready' ||
      value.snapshotReady !== true || value.kind !== 'media' || value.analysisMode !== 'whole-video' || value.hasVideo !== true || typeof value.hasAudio !== 'boolean') throw invalidSource();
  let nativePlan;
  try { nativePlan = videoClipPlan(value); } catch { throw invalidSource(); }
  return { materialId: value.id, snapshotId: value.snapshotId, sourceHash: value.sourceHash,
    duration: nativePlan.duration, hasAudio: nativePlan.hasAudio, hasVideo: true, analysisMode: 'whole-video' };
}
function acceptedResult(value, input, fps) {
  // analyzeClip is a trusted adapter, but pin only the strict parser's complete,
  // canonical result. In particular, the model cannot supply source identities.
  try {
    if (!value || !Array.isArray(value.windows) || !Array.isArray(value.warnings) || value.windows.length > 7) throw invalidResult();
    const text = JSON.stringify({ version: value.version, windows: value.windows.map(window => ({
      start: window.start, end: window.end, transcript: window.transcript, visibleText: window.visibleText,
      observations: window.observations, audioCoverage: window.audioCoverage, visualCoverage: window.visualCoverage,
    })), warnings: value.warnings.slice(1) });
    const result = parseVideoAnalysis(text, input, { fps });
    if (!isDeepStrictEqual(value, result)) throw invalidResult();
    return result;
  } catch { throw invalidResult(); }
}

/** All dependencies are trusted host/test capabilities, never HTTP body fields.
 * writeResult(path, buffer, options) writes the staging file only; the store owns
 * rename, integrity verification and publication. fs overrides support local
 * fault/barrier tests. Limits may lower, not raise, production ceilings.
 */
export function createVideoPlanStore({ materials, directory = tmpdir(), clipper = prepareVideoClip,
  limits: requested = {}, writeResult, removeDirectory, fs: overrides = {},
} = {}) {
  if (!materials || typeof materials.status !== 'function' || typeof materials.withSnapshot !== 'function') throw new TypeError('A private material snapshot store is required.');
  const fs = { ...disk, ...overrides }, limits = { ...VIDEO_PLAN_LIMITS };
  for (const [key, value] of Object.entries(requested)) {
    if (!(key in limits) || !Number.isSafeInteger(value) || value < 1 || value > VIDEO_PLAN_LIMITS[key]) throw new TypeError('Invalid video store limit.');
    limits[key] = value;
  }
  Object.freeze(limits);
  const write = writeResult || ((path, data, options) => fs.writeFile(path, data, options));
  const erase = removeDirectory || (path => fs.rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const plans = new Map(), ownerGates = new Map(), retiredMaterials = new Map();
  let reserved = 0, rootPromise, rootPath, rootCleanup, closePromise, closed = false;
  const materialKey = (owner, materialId) => JSON.stringify([owner, materialId]);
  const root = () => rootPromise ||= Promise.resolve().then(async () => {
    rootPath = await fs.mkdtemp(join(directory, 'learnlens-video-')); return rootPath;
  }).catch(error => { rootPromise = undefined; throw error; });
  const readSource = (owner, materialId) => {
    let value;
    try { value = sourceDescriptor(materials.status(owner, materialId)); } catch { throw invalidSource(); }
    if (value.materialId !== materialId) throw invalidSource();
    return value;
  };
  function admission(owner, materialId) {
    if (closed) throw new AppError('Video workspace is stopping.', 503);
    if (ownerGates.has(owner) || retiredMaterials.has(materialKey(owner, materialId))) throw cancelled();
  }
  function alive(plan) {
    if (closed || plan.deleting || plan.controller.signal.aborted || plans.get(plan.id) !== plan) throw cancelled();
  }
  function matchesSource(plan) {
    if (!isDeepStrictEqual(readSource(plan.owner, plan.source.materialId), plan.source)) throw invalidSource();
  }
  function get(owner, id) {
    const plan = plans.get(id);
    if (!plan || plan.owner !== owner || plan.deleting || closed) throw notFound();
    matchesSource(plan); return plan;
  }
  function clipFor(plan, id) {
    const clip = plan.clips.get(id);
    if (!clip) throw new AppError('Video clip not found.', 404);
    return clip;
  }
  function reserve(plan, amount) {
    const owned = [...plans.values()].filter(item => item.owner === plan.owner).reduce((sum, item) => sum + item.reservedBytes, 0);
    if (owned + amount > limits.ownerBytes || reserved + amount > limits.instanceBytes) throw quotaError();
    plan.reservedBytes += amount; reserved += amount;
  }
  // Registration is synchronous; the callback cannot start until cleanup can
  // see it. Cleanup itself is never registered, avoiding self-await deadlocks.
  function track(plan, run) {
    const work = Promise.resolve().then(run);
    plan.work.add(work);
    work.then(() => plan.work.delete(work), () => plan.work.delete(work));
    return work;
  }
  function requestCleanup(plan) {
    if (plan.removal) return plan.removal;
    const work = Promise.resolve().then(async () => {
      while (plan.work.size) await Promise.allSettled([...plan.work]);
      if (plan.directory) await erase(plan.directory);
      if (plans.get(plan.id) === plan) {
        plans.delete(plan.id); reserved -= plan.reservedBytes; plan.reservedBytes = 0;
        for (const clip of plan.clips.values()) clip.retained = null;
      }
      if (![...plans.values()].some(item => item.owner === plan.owner) && !ownerGates.get(plan.owner)?.promise) ownerGates.delete(plan.owner);
    }).catch(() => { throw cleanupError(); });
    plan.removal = work;
    work.then(() => { plan.removal = null; }, () => { plan.removal = null; });
    return work;
  }
  function retire(plan) {
    plan.deleting = true; plan.controller.abort();
    // This may be called from a tracked writer. Never await its own cleanup.
    const cleanup = requestCleanup(plan); cleanup.catch(() => {}); return cleanup;
  }
  async function check(plan, checkCurrent, signal) {
    alive(plan);
    try {
      if (signal?.aborted) throw cancelled();
      matchesSource(plan);
      if (checkCurrent && await checkCurrent() === false) throw cancelled();
      alive(plan);
      if (signal?.aborted) throw cancelled();
    } catch { retire(plan); throw cancelled(); }
  }
  function snapshotFor(plan, snapshot) {
    if (!snapshot || snapshot.id !== plan.source.materialId || snapshot.snapshotId !== plan.source.snapshotId || snapshot.sourceHash !== plan.source.sourceHash ||
        snapshot.analysisMode !== 'whole-video' || !snapshot.info || snapshot.info.hasVideo !== true || snapshot.info.hasAudio !== plan.source.hasAudio || snapshot.info.duration !== plan.source.duration ||
        !snapshot.signal || snapshot.signal.aborted || typeof snapshot.file !== 'string' || !['mp4', 'webm'].includes(snapshot.extension)) throw invalidSource();
    const nativePlan = videoClipPlan(snapshot.info);
    if (snapshot.videoPlan !== undefined && !isDeepStrictEqual(snapshot.videoPlan, nativePlan)) throw invalidSource();
    return nativePlan;
  }
  const clipView = clip => ({ id: clip.id, index: clip.index, start: clip.start, end: clip.end, status: clip.status,
    attempts: clip.attempts, working: Boolean(clip.work), providerRequested: clip.attempt?.providerRequested === true,
    ...(clip.diagnostics ? { diagnostics: { ...clip.diagnostics } } : {}),
    ...(clip.attempt ? { attemptId: clip.attempt.id } : {}), ...(clip.error ? { error: clip.error } : {}) });
  function manifest(plan) {
    const clips = [...plan.clips.values()];
    const completed = clips.filter(clip => clip.status === 'complete');
    const status = plan.creating ? 'initializing' : completed.length === clips.length ? 'complete'
      : clips.some(clip => clip.work) ? 'processing'
        : clips.some(clip => ['failed', 'checkpoint_failed', 'damaged'].includes(clip.status)) ? 'partial' : 'ready';
    return { id: plan.id, ...plan.source, profileVersion: VIDEO_PROFILE_VERSION, fps: plan.fps,
      summary: { status, totalClips: clips.length, completedClips: completed.length,
        uncertainClips: completed.filter(clip => clip.receipt.uncertainWindows > 0).length,
        bytes: completed.reduce((sum, clip) => sum + clip.receipt.bytes, 0) },
      clips: clips.map(clipView), warnings: [...plan.nativePlan.warnings] };
  }
  function status(owner, id) { return manifest(get(owner, id)); }
  function find(owner, materialId, fps = DEFAULT_VIDEO_FPS) {
    fps = sampling(fps);
    let source;
    try { source = readSource(owner, materialId); } catch { throw notFound(); }
    return status(owner, planIdFor(source.snapshotId, fps));
  }
  async function create(owner, materialId, { fps = DEFAULT_VIDEO_FPS } = {}) {
    admission(owner, materialId); fps = sampling(fps);
    const source = readSource(owner, materialId), id = planIdFor(source.snapshotId, fps);
    if (plans.has(id)) {
      const previous = get(owner, id);
      if (!isDeepStrictEqual(previous.source, source)) throw invalidSource();
      await previous.init; return status(owner, id);
    }
    if (plans.size >= limits.instancePlans || [...plans.values()].filter(plan => plan.owner === owner).length >= limits.ownerPlans) throw quotaError();
    const nativePlan = videoClipPlan(source), clips = new Map();
    for (let index = 0; index < nativePlan.partCount; index++) {
      const bounds = videoClipBounds(index, nativePlan);
      const clipId = digest(JSON.stringify([source.sourceHash, VIDEO_PROFILE_VERSION, fps, bounds.start, bounds.end]));
      clips.set(clipId, { id: clipId, index, ...bounds, status: 'pending', attempts: 0, resultReservation: 0 });
    }
    const plan = { id, owner, source, fps, nativePlan, clips, attempts: new Map(), controller: new AbortController(),
      reservedBytes: 0, creating: true, work: new Set() };
    reserve(plan, size({ id, source, fps, clips: [...clips.values()] }) + 2048);
    plans.set(id, plan);
    plan.init = track(plan, async () => {
      try {
        await materials.withSnapshot(owner, materialId, async snapshot => {
          snapshotFor(plan, snapshot); await check(plan, null, snapshot.signal);
          const base = await root(); await check(plan, null, snapshot.signal);
          // Assignment occurs even if cancellation arrives during mkdtemp, so
          // the registered cleanup always knows the actual physical directory.
          plan.directory = await fs.mkdtemp(join(base, id + '-'));
          await check(plan, null, snapshot.signal);
        });
        alive(plan); plan.creating = false;
      } catch (error) { retire(plan); throw error?.status === 409 ? cancelled() : new AppError('Could not initialize private video result storage.', 503); }
    });
    try { await plan.init; return status(owner, id); }
    catch (error) { await requestCleanup(plan).catch(() => {}); throw error; }
  }

  async function readVerified(plan, clip, receipt) {
    const path = join(plan.directory, clip.id + '.json');
    let handle;
    try {
      const info = await fs.lstat(path); alive(plan);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size !== receipt.bytes || info.size > limits.resultBytes) throw invalidResult();
      handle = await fs.open(path, 'r'); alive(plan);
      const before = await handle.stat();
      if (!before.isFile() || before.nlink !== 1 || before.ino !== info.ino || before.dev !== info.dev || before.size !== receipt.bytes) throw invalidResult();
      const buffer = Buffer.alloc(receipt.bytes + 1); let count = 0;
      while (count < buffer.length) {
        const { bytesRead } = await handle.read(buffer, count, buffer.length - count, count); alive(plan);
        if (!bytesRead) break; count += bytesRead;
      }
      const after = await handle.stat(); alive(plan);
      if (count !== receipt.bytes || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || digest(buffer.subarray(0, count)) !== receipt.sha256) throw invalidResult();
      const envelope = JSON.parse(buffer.subarray(0, count).toString('utf8'));
      if (envelope.planId !== plan.id || envelope.clipId !== clip.id || envelope.snapshotId !== plan.source.snapshotId || envelope.sourceHash !== plan.source.sourceHash || envelope.profileVersion !== VIDEO_PROFILE_VERSION) throw invalidResult();
      return acceptedResult(envelope.result, { start: clip.start, end: clip.end, hasAudio: plan.source.hasAudio, videoSha256: receipt.videoSha256 }, plan.fps);
    } finally { await handle?.close(); }
  }
  async function verifiedStatus(plan, clip) {
    if (clip.status !== 'complete') return clipView(clip);
    const receipt = clip.receipt;
    try {
      const result = await readVerified(plan, clip, receipt); alive(plan); matchesSource(plan);
      if (clip.status !== 'complete' || clip.receipt !== receipt) return clipView(clip);
      return { ...clipView(clip), result };
    } catch {
      alive(plan); matchesSource(plan);
      if (clip.receipt === receipt && clip.status === 'complete') { clip.status = 'damaged'; clip.error = DAMAGED_ERROR; }
      return clipView(clip);
    }
  }
  async function clipStatus(owner, id, clipId) {
    const plan = get(owner, id), clip = clipFor(plan, clipId);
    return track(plan, () => verifiedStatus(plan, clip));
  }
  async function checkpoint(plan, clip, checkCurrent, signal) {
    const pinned = clip.retained, target = join(plan.directory, clip.id + '.json'), temporary = target + '.tmp';
    if (!pinned) throw invalidResult();
    // A previously failed rename/verification can leave either file behind.
    // Remove these uncommitted copies first: only one 512 KiB slot is reserved.
    await check(plan, checkCurrent, signal); await fs.rm(target, { force: true });
    await check(plan, checkCurrent, signal); await fs.rm(temporary, { force: true });
    await check(plan, checkCurrent, signal);
    await write(temporary, pinned.data, { mode: 0o600, flag: 'wx', signal: plan.controller.signal });
    await check(plan, checkCurrent, signal); await fs.rename(temporary, target);
    await check(plan, checkCurrent, signal); await readVerified(plan, clip, pinned.receipt);
    await check(plan, checkCurrent, signal);
    // Only verified files permit shrinking headroom. Failed writes/cleanup
    // retain their entire reservation, independent of live session ownership.
    const freed = clip.resultReservation - pinned.receipt.bytes;
    reserved -= freed; plan.reservedBytes -= freed; clip.resultReservation = pinned.receipt.bytes;
    clip.receipt = pinned.receipt; clip.status = 'complete'; clip.retained = null; delete clip.error; delete clip.diagnostics;
  }
  function pin(plan, clip, result) {
    const data = Buffer.from(JSON.stringify({ planId: plan.id, clipId: clip.id, snapshotId: plan.source.snapshotId,
      sourceHash: plan.source.sourceHash, profileVersion: VIDEO_PROFILE_VERSION, result }));
    if (data.length > limits.resultBytes) throw invalidResult();
    clip.retained = { data, receipt: { bytes: data.length, sha256: digest(data), videoSha256: result.videoSha256, uncertainWindows: result.uncertainWindows } };
  }
  function acquire(callback) {
    if (callback !== undefined && typeof callback !== 'function') throw new TypeError('Invalid video job acquisition callback.');
    let release;
    try { release = callback ? callback() : () => {}; }
    catch { throw new AppError('Video analysis job capacity is unavailable. No new provider request was made.', 429); }
    if (typeof release !== 'function') throw new TypeError('Video job acquisition must return a synchronous release function.');
    let released = false;
    return () => { if (!released) { released = true; try { release(); } catch { /* Never expose job-manager details. */ } } };
  }
  function launch(plan, clip, { acquireJob, checkCurrent, analyzeClip }, recovery) {
    const release = acquire(acquireJob);
    const work = track(plan, async () => {
      let snapshotSignal;
      try {
        await check(plan, checkCurrent);
        if (recovery) {
          // Deliberately no current role, identity, snapshot borrow, encoder or
          // provider callback is required to save a previously accepted result.
          await checkpoint(plan, clip, checkCurrent);
        } else {
          await materials.withSnapshot(plan.owner, plan.source.materialId, async snapshot => {
            const nativePlan = snapshotFor(plan, snapshot);
            snapshotSignal = AbortSignal.any([plan.controller.signal, snapshot.signal]);
            await check(plan, checkCurrent, snapshotSignal);
            const prepared = await clipper(snapshot.file, snapshot.extension, clip.index, nativePlan, { signal: snapshotSignal, sourceHash: plan.source.sourceHash });
            await check(plan, checkCurrent, snapshotSignal);
            const input = videoAnalysisInput(prepared);
            if (input.start !== clip.start || input.end !== clip.end || input.hasAudio !== plan.source.hasAudio || prepared.hasVideo !== true || prepared.analysisMode !== 'whole-video' || prepared.videoSha256 !== input.videoSha256) throw invalidResult();
            const nativeClip = Object.freeze({ video: prepared.video, start: clip.start, end: clip.end, hasAudio: input.hasAudio,
              hasVideo: true, analysisMode: 'whole-video', videoSha256: input.videoSha256, signal: snapshotSignal });
            const attempt = clip.attempt;
            let open = true;
            const markDispatched = () => {
              alive(plan);
              if (!open || snapshotSignal.aborted || attempt.providerRequested || clip.attempt !== attempt) throw cancelled();
              attempt.providerRequested = true; clip.status = 'processing';
            };
            let response;
            try { response = await analyzeClip(nativeClip, markDispatched); } finally { open = false; }
            await check(plan, checkCurrent, snapshotSignal);
            if (!attempt.providerRequested) throw invalidResult();
            const result = acceptedResult(response, input, plan.fps);
            pin(plan, clip, result); // Before the FIRST local result write/await.
            await checkpoint(plan, clip, checkCurrent, snapshotSignal);
          });
        }
        await check(plan, checkCurrent, snapshotSignal);
      } catch (error) {
        try {
          await check(plan, checkCurrent, snapshotSignal);
          if (clip.status === 'complete') return;
          clip.status = clip.retained ? 'checkpoint_failed' : 'failed';
          if (!clip.retained) clip.diagnostics = videoFailureDiagnostics(error, clip.attempt.providerRequested);
          clip.error = clip.retained ? CHECKPOINT_ERROR : clip.attempt.providerRequested
            ? 'Video analysis failed or its outcome is unknown. The provider may have processed the request. No automatic retry was made; confirm a new attempt explicitly.'
            : 'Local video preparation or dispatch checks failed. No provider request was recorded. Confirm a new attempt explicitly; the source will not be fetched again.';
        } catch { /* Deletion/session invalidation must never publish late state. */ }
      } finally { clip.work = null; release(); }
    });
    clip.work = work;
    work.catch(() => {}); // Detached work always has a settled rejection handler.
  }
  async function startAnalysis(owner, id, clipId, { attemptId, retry = false } = {}, dependencies = {}) {
    const plan = get(owner, id), clip = clipFor(plan, clipId);
    if (!uuid(attemptId)) throw new AppError('Video analysis attempt ID must be a UUID.');
    const previous = plan.attempts.get(attemptId);
    if (previous && previous.clipId !== clipId) throw new AppError('Video attempt ID already belongs to another clip.', 409);
    // Duplicates, a busy clip and completed clips do not acquire a job, validate
    // current model settings, encode or start any new background work.
    if (clip.work || clip.status === 'complete') return clipStatus(owner, id, clipId);
    if (clip.status === 'checkpoint_failed' && clip.retained) {
      admission(owner, plan.source.materialId);
      if (dependencies.checkCurrent !== undefined && typeof dependencies.checkCurrent !== 'function') throw new TypeError('Invalid current-owner check.');
      launch(plan, clip, dependencies, true);
      return clipView(clip);
    }
    if (previous) return clipStatus(owner, id, clipId);
    admission(owner, plan.source.materialId);
    if (plan.creating) throw new AppError('Video plan initialization is still in progress.', 409);
    if (clip.status !== 'pending' && retry !== true) throw new AppError('Failed or damaged video requires explicit retry confirmation with a new attempt ID.', 409);
    if (clip.attempts >= limits.clipAttempts) throw new AppError('Video clip attempt limit reached. No new provider request was made.', 413);
    if (typeof dependencies.analyzeClip !== 'function' || (dependencies.checkCurrent !== undefined && typeof dependencies.checkCurrent !== 'function')) throw new TypeError('Invalid video analysis callbacks.');
    const analysisIdentity = identity(dependencies.analysisIdentity, plan.fps);
    const attempt = { id: attemptId, clipId, analysisIdentity, providerRequested: false };
    const amount = size(attempt) + 512 + limits.resultBytes - clip.resultReservation;
    reserve(plan, amount);
    const old = { status: clip.status, attempt: clip.attempt, error: clip.error, diagnostics: clip.diagnostics };
    clip.status = 'preparing'; clip.attempt = attempt; delete clip.error; delete clip.diagnostics;
    try { launch(plan, clip, dependencies, false); }
    catch (error) { Object.assign(clip, old); plan.reservedBytes -= amount; reserved -= amount; throw error; }
    clip.resultReservation = limits.resultBytes; clip.attempts++; plan.attempts.set(attemptId, attempt);
    return clipView(clip);
  }

  async function assertComplete(owner, refs) {
    if (!Array.isArray(refs) || refs.length > 10 || refs.some(ref => !ref || !uuid(ref.materialId) || !uuid(ref.snapshotId) || !hex(ref.planId)) || new Set(refs.map(ref => ref.materialId)).size !== refs.length) throw incomplete();
    const coverage = [], verified = [];
    for (const ref of refs) {
      const plan = get(owner, ref.planId);
      if (plan.source.materialId !== ref.materialId || plan.source.snapshotId !== ref.snapshotId || plan.creating) throw incomplete();
      const item = await track(plan, () => materials.withSnapshot(owner, ref.materialId, async snapshot => {
        const nativePlan = snapshotFor(plan, snapshot); await check(plan, null, snapshot.signal);
        const clips = [...plan.clips.values()], receipts = [];
        if (clips.length !== nativePlan.partCount) throw incomplete();
        let end = 0;
        for (const [index, clip] of clips.entries()) {
          const bounds = videoClipBounds(index, nativePlan);
          if (clip.index !== index || clip.start !== end || clip.start !== bounds.start || clip.end !== bounds.end || clip.status !== 'complete' || clip.work) throw incomplete();
          const receipt = clip.receipt;
          const state = await verifiedStatus(plan, clip); await check(plan, null, snapshot.signal);
          if (state.status !== 'complete' || clip.status !== 'complete' || clip.work || clip.receipt !== receipt) throw incomplete();
          end = clip.end;
          verified.push({ plan, clip, receipt });
          receipts.push({ id: clip.id, start: clip.start, end: clip.end, videoSha256: state.result.videoSha256, uncertainWindows: state.result.uncertainWindows });
        }
        if (end !== plan.source.duration) throw incomplete();
        return { ...plan.source, planId: plan.id, profileVersion: VIDEO_PROFILE_VERSION, fps: plan.fps,
          totalClips: receipts.length, uncertainClips: receipts.filter(receipt => receipt.uncertainWindows > 0).length, clips: receipts };
      })).catch(() => { throw incomplete(); });
      coverage.push(item);
    }
    // Reject deletion, damage or a retry that raced another interval's read.
    for (const ref of refs) get(owner, ref.planId);
    for (const { plan, clip, receipt } of verified) {
      alive(plan);
      if (clip.status !== 'complete' || clip.work || clip.receipt !== receipt) throw incomplete();
    }
    const totalClips = coverage.reduce((sum, item) => sum + item.totalClips, 0);
    return { status: 'complete', complete: true, coverageBasis: 'model_reported', totalClips, completedClips: totalClips,
      uncertainClips: coverage.reduce((sum, item) => sum + item.uncertainClips, 0), materials: coverage };
  }
  function removeMaterial(owner, materialId) {
    if (!uuid(materialId)) return Promise.reject(new AppError('Invalid material ID.'));
    const key = materialKey(owner, materialId);
    retiredMaterials.delete(key); retiredMaterials.set(key, owner);
    // Bounded session tombstones cover cancellation before/while create starts.
    while (retiredMaterials.size > 4096) retiredMaterials.delete(retiredMaterials.keys().next().value);
    const removals = [...plans.values()].filter(plan => plan.owner === owner && plan.source.materialId === materialId).map(retire);
    return Promise.allSettled(removals).then(results => { if (results.some(result => result.status === 'rejected')) throw cleanupError(); });
  }
  function clearOwner(owner) {
    if (ownerGates.get(owner)?.promise) return ownerGates.get(owner).promise;
    const gate = {}; ownerGates.set(owner, gate);
    const cleanups = [...plans.values()].filter(plan => plan.owner === owner).map(retire);
    const work = Promise.allSettled(cleanups).then(results => {
      if (results.some(result => result.status === 'rejected')) throw cleanupError();
      if (ownerGates.get(owner) === gate) ownerGates.delete(owner);
      for (const [key, retiredOwner] of retiredMaterials) if (retiredOwner === owner) retiredMaterials.delete(key);
    });
    gate.promise = work;
    work.then(() => { gate.promise = null; }, () => { gate.promise = null; });
    return work;
  }
  async function cleanRoot() {
    if (!closed || plans.size || !rootPath) return;
    if (!rootCleanup) {
      const path = rootPath;
      rootCleanup = Promise.resolve().then(() => erase(path)).then(() => { if (rootPath === path) rootPath = undefined; });
      rootCleanup.then(() => { rootCleanup = null; }, () => { rootCleanup = null; });
    }
    await rootCleanup;
  }
  async function retryCleanup() {
    const results = await Promise.allSettled([...plans.values()].filter(plan => plan.deleting).map(requestCleanup));
    const rootResult = await Promise.allSettled([cleanRoot()]);
    return { pending: [...plans.values()].filter(plan => plan.deleting).length + (closed && !plans.size && rootPath ? 1 : 0),
      failed: [...results, ...rootResult].filter(result => result.status === 'rejected').length };
  }
  function close() {
    closed = true;
    if (closePromise) return closePromise;
    const cleanups = [...plans.values()].map(retire);
    closePromise = Promise.allSettled(cleanups).then(async results => {
      if (results.some(result => result.status === 'rejected')) throw cleanupError();
      try { await cleanRoot(); } catch { throw cleanupError(); }
    });
    closePromise.then(() => { closePromise = null; }, () => { closePromise = null; });
    return closePromise;
  }
  return { create, find, status, clipStatus, startAnalysis, assertComplete, removeMaterial, clearOwner, retryCleanup, close, limits };
}
