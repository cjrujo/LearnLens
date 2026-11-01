import * as disk from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { AppError } from './provider.mjs';
import { importDocument } from './document-import.mjs';
import { normalizeSourceUrl } from './source-fetch.mjs';

export const UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024;
const MiB = 1024 * 1024, DOCS = ['pdf', 'docx', 'pptx'], MEDIA = ['mp3', 'mp4', 'webm', 'wav', 'ogg'], TEXT = ['html', 'txt', 'md'];
const DEFAULT_LIMITS = Object.freeze({
  ownerItems: 10, ownerBytes: 1024 * MiB, instanceBytes: 4096 * MiB,
  documentBytes: 100 * MiB, mediaBytes: 1024 * MiB, minFreeBytes: 256 * MiB,
  tombstoneCount: 4096, tombstoneOwnerCount: 128, tombstoneTtlMs: 10 * 60 * 1000,
});
export function splitMaterialText(text, size = 20000) {
  const chunks = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(text.length, start + size);
    if (end < text.length) { const line = text.lastIndexOf('\n', end); if (line > start + size / 2) end = line + 1; if (/[\uD800-\uDBFF]/.test(text[end - 1])) end--; }
    chunks.push(text.slice(start, end)); start = end;
  }
  return chunks.length ? chunks : [''];
}
const safeError = error => error instanceof AppError ? error : error?.name === 'MediaImportError' ? new AppError(error.message, 422) : new AppError('Material processing failed. Check the app installation, available disk space and resource limits.', 422);
const cancelled = () => new AppError('Material processing was cancelled.', 409);
const quotaError = () => new AppError('Temporary workspace storage quota reached. Remove unused attachments or ask the host for more capacity.', 413);
const cleanupError = () => new AppError('Temporary material cleanup failed. Storage remains reserved until cleanup succeeds.', 503);
const invalidSnapshot = () => new AppError('Source acquisition returned an invalid private snapshot.', 422);
const validId = id => typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id);
const validName = name => typeof name === 'string' && name.length > 0 && name.length <= 180 && !/[\\/\x00-\x1f\x7f]/.test(name);
function frozenCopy(value) {
  const freeze = obj => { if (obj && typeof obj === 'object') { Object.values(obj).forEach(freeze); Object.freeze(obj); } return obj; };
  return value == null ? value : freeze(structuredClone(value));
}
// Downloader diagnostics are not a channel for fetch URLs (which may contain
// credentials in a signed query), response bodies, local paths or native errors.
const sourceFailure = error => new AppError(
  error?.status === 413 ? 'Source exceeds the available temporary storage or source-size limit.'
    : error?.status === 507 ? 'Not enough temporary disk space on this workspace.'
      : 'Source import failed. No automatic refetch was made. Reimport explicitly with a new material ID.',
  [400, 409, 413, 415, 422, 429, 503, 504, 507].includes(error?.status) ? error.status : 422,
);
function publicText(value, max) {
  return typeof value === 'string' ? value.replace(/https?:\/\/[^\s<>"']+/gi, '[source URL]').replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, max) : '';
}
function provenanceOf(value) {
  if (!value || !['webpage', 'direct-media', 'direct-document', 'youtube', 'text'].includes(value.type) || typeof value.citationUrl !== 'string') throw invalidSnapshot();
  let url;
  try { url = new URL(value.citationUrl); } catch { throw invalidSnapshot(); }
  const videoId = url.searchParams.get('v');
  url.username = ''; url.password = ''; url.search = ''; url.hash = '';
  if (value.type === 'youtube') {
    if (!['www.youtube.com', 'youtube.com', 'm.youtube.com'].includes(url.hostname) || !/^[\w-]{11}$/.test(videoId || '')) throw invalidSnapshot();
    url = new URL(`https://www.youtube.com/watch?v=${videoId}`);
  }
  let citationUrl;
  try { citationUrl = normalizeSourceUrl(url.href); } catch { throw invalidSnapshot(); }
  if (typeof value.importedAt !== 'string' || !Number.isFinite(Date.parse(value.importedAt))) throw invalidSnapshot();
  return Object.freeze({ type: value.type, citationUrl, ...(value.title ? { title: publicText(value.title, 512) } : {}), importedAt: new Date(value.importedAt).toISOString() });
}

/** All injections here are host/test capabilities, never request-body options.
 * Limits may only lower the production ceilings. fs overrides individual
 * fs/promises methods; cleanup(path) must complete only once its writers stop.
 */
export function createMaterialStore({
  importDoc = importDocument, mediaLoader = () => import('./native-media.mjs'), directory = tmpdir(),
  videoLoader = () => import('./video-clips.mjs'),
  downloader, sourceTextExtractor,
  fs: overrides = {}, cleanup, limits: requestedLimits = {}, now = Date.now,
} = {}) {
  const fs = { ...disk, ...overrides }, limits = { ...DEFAULT_LIMITS };
  for (const [key, value] of Object.entries(requestedLimits)) {
    if (!(key in limits) || !Number.isSafeInteger(value) || value < (key === 'minFreeBytes' ? 0 : 1) || value > DEFAULT_LIMITS[key]) throw new TypeError('Invalid material store limit.');
    limits[key] = value;
  }
  const erase = cleanup || (path => fs.rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const entries = new Map(), ownerGates = new Map(), tombstones = new Map();
  let rootPromise, rootPath, rootCleanup, closePromise, reserved = 0, closed = false;
  const root = () => rootPromise ||= Promise.resolve().then(async () => {
    rootPath = await fs.mkdtemp(join(resolve(directory), 'learnlens-materials-')); return rootPath;
  }).catch(error => { rootPromise = undefined; throw error; });

  // No asynchronous operation starts until its promise is in this registry.
  // Cleanup is deliberately NOT registered: it drains the registry, never itself.
  function track(item, run) {
    const work = Promise.resolve().then(run);
    item.work.add(work);
    work.then(() => item.work.delete(work), () => item.work.delete(work));
    return work;
  }
  function ensure(item) {
    if (closed || item.deleting || item.controller.signal.aborted || entries.get(item.id) !== item) throw cancelled();
  }
  async function check(item) {
    ensure(item);
    if (item.checkCurrent) {
      try { if (await item.checkCurrent() === false) throw cancelled(); }
      catch { beginDelete(item); throw cancelled(); }
      ensure(item);
    }
  }
  async function step(item, run) {
    await check(item); ensure(item);
    const result = await run();
    await check(item); ensure(item);
    return result;
  }
  function get(owner, id, allowDeleting = false) {
    const item = entries.get(id);
    if (!item || item.owner !== owner) throw new AppError('Material not found or expired. Re-add the original file.', 404);
    if (!allowDeleting) ensure(item);
    item.touched = now(); return item;
  }
  const publicItem = item => ({
    id: item.id, name: item.name, size: item.size, received: item.received, status: item.status,
    kind: item.kind, analysisMode: item.analysisMode, partCount: item.partCount || 0, duration: item.info?.duration,
    hasAudio: item.info?.hasAudio, hasVideo: item.info?.hasVideo, pages: item.pages,
    warnings: [...(item.warnings || [])], error: item.error || null, chunkSize: UPLOAD_CHUNK_BYTES,
    snapshotReady: item.snapshotReady, snapshotId: item.snapshotId, sourceHash: item.sourceHash || null,
    provenance: item.provenance ? { ...item.provenance } : null,
    ...(item.totalBytes !== undefined ? { totalBytes: item.totalBytes } : {}),
    ...(item.cleanupNeeded || item.cacheCleanupNeeded ? { cleanupPending: true } : {}),
  });
  function pruneTombstones() {
    const time = now();
    for (const [key, value] of tombstones) if (value.expires <= time) tombstones.delete(key);
  }
  const tombstoneKey = (owner, id) => JSON.stringify([owner, id]);
  function remember(owner, id) {
    if (!validId(id)) return;
    pruneTombstones();
    const key = tombstoneKey(owner, id);
    tombstones.delete(key); tombstones.set(key, { owner, expires: now() + limits.tombstoneTtlMs });
    const owned = [...tombstones].filter(([, value]) => value.owner === owner);
    while (owned.length > limits.tombstoneOwnerCount) tombstones.delete(owned.shift()[0]);
    while (tombstones.size > limits.tombstoneCount) tombstones.delete(tombstones.keys().next().value);
  }
  function admission(owner, id) {
    if (closed) throw new AppError('Workspace is stopping.', 503);
    if (!validId(id)) throw new AppError('Invalid material ID.');
    if (ownerGates.has(owner)) throw new AppError('This workspace is clearing its materials. Wait for cleanup to finish.', 409);
    pruneTombstones();
    if (tombstones.has(tombstoneKey(owner, id))) throw cancelled();
  }
  function capacity(owner) {
    const owned = [...entries.values()].filter(item => item.owner === owner);
    if (owned.length >= limits.ownerItems) throw quotaError();
    return Math.min(limits.ownerBytes - owned.reduce((sum, item) => sum + item.reservedBytes, 0), limits.instanceBytes - reserved);
  }
  function allocate(owner, id, bytes, fields) {
    const item = {
      id, owner, ...fields, reservedBytes: bytes, received: 0, chunks: new Map(), status: 'initializing',
      controller: new AbortController(), touched: now(), pendingParts: new Map(), work: new Set(),
      cacheTail: Promise.resolve(), cached: new Set(), snapshotReady: false, snapshotId: randomUUID(),
      analysisMode: fields.requestedAnalysisMode || 'sampled-stills',
    };
    entries.set(id, item); reserved += bytes; return item;
  }
  function releaseBytes(item, remaining = 0) {
    reserved -= item.reservedBytes - remaining; item.reservedBytes = remaining;
  }
  function releaseGate(owner) {
    if (![...entries.values()].some(item => item.owner === owner)) ownerGates.delete(owner);
  }
  function requestCleanup(item) {
    item.cleanupNeeded = true;
    if (item.cleanupPromise) return item.cleanupPromise;
    const work = Promise.resolve().then(async () => {
      // Include initialization, append handles, cache reads/writes, local/native
      // processors and internal snapshot borrowers, including nested late work.
      while (item.work.size) await Promise.allSettled([...item.work]);
      if (item.directory) await erase(item.directory);
      item.directory = undefined; item.file = undefined; item.textFile = undefined;
      item.cacheDirectory = undefined; item.cached.clear(); item.cacheCleanupNeeded = false;
      releaseBytes(item); item.cleanupNeeded = false;
      if (item.deleting && entries.get(item.id) === item) entries.delete(item.id);
      releaseGate(item.owner);
    }).catch(() => { throw cleanupError(); });
    item.cleanupPromise = work;
    work.then(() => { item.cleanupPromise = null; }, () => { item.cleanupPromise = null; });
    return work;
  }
  function beginDelete(item) {
    if (!item.deleting) {
      item.deleting = true; item.status = 'deleting'; remember(item.owner, item.id);
      item.controller.abort();
    }
    return requestCleanup(item);
  }
  async function initialize(item, upload) {
    await check(item); ensure(item);
    const base = await step(item, root);
    const space = await step(item, () => fs.statfs(base)); ensure(item);
    if (Number(space.bavail) * Number(space.bsize) < item.reservedBytes + limits.minFreeBytes) throw new AppError('Not enough temporary disk space on this workspace.', 507);
    // Logical IDs are reusable after the bounded cancellation window. Never
    // reuse their physical paths, including after a failed or delayed removal.
    item.directory = join(base, randomUUID());
    await step(item, () => fs.mkdir(item.directory, { mode: 0o700 }));
    if (upload) {
      item.file = join(item.directory, 'source.' + item.extension);
      await step(item, () => fs.writeFile(item.file, '', { mode: 0o600, flag: 'wx' }));
      ensure(item); item.status = 'uploading';
    }
  }
  async function create(owner, body) {
    const { id, name, size, analysisMode = 'sampled-stills' } = body || {};
    admission(owner, id);
    if (!['sampled-stills', 'whole-video'].includes(analysisMode)) throw new AppError('Invalid material analysis mode.');
    if (!validName(name)) throw new AppError('Invalid material filename.');
    const extension = name.split('.').pop().toLowerCase();
    if (![...DOCS, ...MEDIA].includes(extension)) throw new AppError('Use PDF, DOCX, PPTX, MP3, MP4, WebM, WAV or OGG.');
    const max = DOCS.includes(extension) ? limits.documentBytes : limits.mediaBytes;
    if (!Number.isSafeInteger(size) || size < 1 || size > max) throw new AppError(`This workspace supports ${DOCS.includes(extension) ? '100 MB documents' : '1 GB media files'}. This is a host storage quota, not a model segment limit.`, 413);
    if (entries.has(id)) {
      const item = get(owner, id);
      if (item.origin !== 'upload' || item.name !== name || item.size !== size || item.requestedAnalysisMode !== analysisMode) throw new AppError('Material ID already belongs to another upload.', 409);
      await item.init; await check(item); ensure(item); return publicItem(item);
    }
    if (size > capacity(owner)) throw quotaError();
    const item = allocate(owner, id, size, { origin: 'upload', name, size, extension, requestedAnalysisMode: analysisMode, kind: DOCS.includes(extension) ? 'document' : 'media' });
    item.init = track(item, async () => {
      try { await initialize(item, true); }
      catch (error) { beginDelete(item); throw safeError(error); }
    });
    try { await item.init; await check(item); ensure(item); return publicItem(item); }
    catch (error) {
      // Not inside init: waiting here cannot form cleanup -> init -> cleanup.
      if (item.cleanupPromise) await item.cleanupPromise.catch(() => {});
      throw safeError(error);
    }
  }
  async function append(owner, id, offset, data) {
    const item = get(owner, id);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Buffer.isBuffer(data) || !data.length || data.length > UPLOAD_CHUNK_BYTES) throw new AppError('Invalid upload chunk.');
    if (item.origin !== 'upload') throw new AppError('This source snapshot is immutable.', 409);
    const hash = createHash('sha256').update(data).digest('hex'), old = item.chunks.get(offset);
    if (old && old.length === data.length && old.hash === hash) return publicItem(item);
    if (item.snapshotReady) throw new AppError('This source snapshot is immutable.', 409);
    if (item.writing || item.preparing || !['initializing', 'uploading'].includes(item.status) || offset !== item.received || offset + data.length > item.size) throw new AppError('Upload position changed. Read its current status before continuing.', 409);
    item.writing = true;
    const bytes = Buffer.from(data);
    return track(item, async () => {
      let handle;
      try {
        await item.init; await check(item); ensure(item);
        handle = await fs.open(item.file, 'r+'); await check(item); ensure(item);
        let written = 0;
        while (written < bytes.length) {
          const result = await step(item, () => handle.write(bytes, written, bytes.length - written, offset + written));
          if (!result.bytesWritten) throw new Error('Short write'); written += result.bytesWritten;
        }
        await step(item, () => handle.sync()); ensure(item);
        item.received += bytes.length; item.chunks.set(offset, { length: bytes.length, hash });
      } catch (error) { await handle?.truncate(item.received).catch(() => {}); throw safeError(error); }
      finally { try { await handle?.close(); } finally { item.writing = false; } }
      await check(item); ensure(item); return publicItem(item);
    });
  }

  async function hashSource(item, file, expectedSize) {
    if (!isAbsolute(file) || dirname(resolve(file)) !== resolve(item.directory)) throw invalidSnapshot();
    const owned = await step(item, () => fs.lstat(item.directory));
    if (!owned.isDirectory() || owned.isSymbolicLink()) throw invalidSnapshot();
    const info = await step(item, () => fs.lstat(file));
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size !== expectedSize) throw invalidSnapshot();
    const realDirectory = await step(item, () => fs.realpath(item.directory));
    const realFile = await step(item, () => fs.realpath(file));
    if (dirname(realFile) !== realDirectory) throw invalidSnapshot();
    let handle;
    try {
      handle = await fs.open(file, 'r'); await check(item); ensure(item);
      const before = await step(item, () => handle.stat());
      if (!before.isFile() || before.size !== expectedSize || before.ino !== info.ino || before.dev !== info.dev) throw invalidSnapshot();
      const hash = createHash('sha256'), buffer = Buffer.alloc(64 * 1024);
      let bytes = 0;
      while (bytes < expectedSize) {
        const { bytesRead } = await step(item, () => handle.read(buffer, 0, Math.min(buffer.length, expectedSize - bytes), bytes));
        if (!bytesRead) throw invalidSnapshot();
        hash.update(buffer.subarray(0, bytesRead)); bytes += bytesRead;
      }
      const after = await step(item, () => handle.stat());
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw invalidSnapshot();
      return hash.digest('hex');
    } finally { await handle?.close(); }
  }
  async function sealUrl(item, result) {
    if (!result || ![...TEXT, ...DOCS, ...MEDIA].includes(result.extension) || !validName(result.name) || !Number.isSafeInteger(result.size) || result.size < 1 || typeof result.file !== 'string') throw invalidSnapshot();
    const kind = TEXT.includes(result.extension) ? 'text' : DOCS.includes(result.extension) ? 'document' : 'media';
    if (result.kind !== kind || (['video', 'audio'].includes(item.mode) && kind !== 'media')) throw invalidSnapshot();
    if (result.size > (kind === 'media' ? limits.mediaBytes : limits.documentBytes)) throw quotaError();
    const deferredText = kind === 'text' && result.textPending === true && result.text === undefined;
    if (kind === 'text' && !deferredText && (typeof result.text !== 'string' || result.text.length > 2_000_000 || !result.text.isWellFormed())) throw invalidSnapshot();
    if (kind !== 'text' && (result.text !== undefined || result.textPending !== undefined)) throw invalidSnapshot();
    const provenance = provenanceOf(result.provenance);
    if ((kind === 'text' && !['text', 'webpage'].includes(provenance.type)) || (kind === 'document' && provenance.type !== 'direct-document') || (kind === 'media' && !['direct-media', 'youtube'].includes(provenance.type))) throw invalidSnapshot();
    const textBytes = kind === 'text' && !deferredText ? Buffer.byteLength(result.text, 'utf8') : 0;
    const sourceHash = await hashSource(item, result.file, result.size);
    // HTML-selected media can retain both originals. Inspect and account ALL
    // handed-over files, not only result.size; never shrink away auxiliary bytes.
    const files = await step(item, () => fs.readdir(item.directory));
    if (!files.includes(basename(result.file))) throw invalidSnapshot();
    let retainedBytes = 0;
    for (const name of files) {
      const info = await step(item, () => fs.lstat(join(item.directory, name)));
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || !Number.isSafeInteger(info.size)) throw invalidSnapshot();
      retainedBytes += info.size;
      if (!Number.isSafeInteger(retainedBytes) || retainedBytes > item.reservedBytes) throw quotaError();
    }
    // Seal the completed acquisition BEFORE local extraction or sidecar writes.
    // Failures beyond this point retain the same original and never refetch it.
    await check(item); ensure(item);
    Object.assign(item, { file: result.file, extension: result.extension, kind, name: result.name, size: result.size, received: result.size, provenance, sourceHash,
      analysisMode: kind === 'media' ? item.analysisMode : 'sampled-stills',
      warnings: Array.isArray(result.warnings) ? result.warnings.filter(value => typeof value === 'string').slice(0, 50).map(value => publicText(value, 2000)) : [], snapshotReady: true });
    item.originalBytes = retainedBytes;
    if (kind === 'text') {
      item.textTarget = join(item.directory, `text-${randomUUID()}.txt`);
      // At most three UTF-8 bytes per decoded UTF-16 code unit (2M units).
      releaseBytes(item, Math.min(item.reservedBytes, retainedBytes + (deferredText ? 6_000_000 : textBytes)));
      if (!deferredText) {
        if (retainedBytes + textBytes > item.reservedBytes) throw quotaError();
        item.pendingText = result.text;
      }
    } else releaseBytes(item, retainedBytes);
  }
  async function startImport(owner, body, { acquireJob, checkCurrent } = {}) {
    const { id, url, mode = 'auto' } = body || {};
    admission(owner, id);
    if (!['auto', 'webpage', 'video', 'audio'].includes(mode)) throw new AppError('Invalid URL source mode.');
    const normalized = normalizeSourceUrl(url);
    if (entries.has(id)) {
      const item = get(owner, id);
      if (item.origin !== 'url' || item.url !== normalized || item.mode !== mode) throw new AppError('Material ID already belongs to another source.', 409);
      return publicItem(item);
    }
    if ((acquireJob !== undefined && typeof acquireJob !== 'function') || (checkCurrent !== undefined && typeof checkCurrent !== 'function')) throw new TypeError('Invalid material job callbacks.');
    const bytes = Math.min(limits.mediaBytes, capacity(owner));
    if (bytes < 1) throw quotaError();
    // Unknown auto/video sources must not slip through the whole-video receipt
    // gate while fetching/inspecting. Non-video classification clears this flag.
    const requestedAnalysisMode = ['auto', 'video'].includes(mode) ? 'whole-video' : 'sampled-stills';
    const item = allocate(owner, id, bytes, { origin: 'url', url: normalized, mode, checkCurrent, requestedAnalysisMode, name: 'URL source', kind: 'source', size: 0 });
    let release;
    try {
      release = acquireJob?.();
      if (acquireJob && typeof release !== 'function') throw new TypeError('acquireJob must return a release function.');
    } catch (error) { entries.delete(id); releaseBytes(item); throw error; }
    item.init = track(item, () => initialize(item, false));
    item.importing = track(item, async () => {
      try {
        await item.init; await check(item); ensure(item); item.status = 'fetching';
        const download = downloader || (await step(item, () => import('./url-source.mjs'))).downloadUrlSource;
        const result = await step(item, () => download({
          url: item.url, mode: item.mode, directory: item.directory, maxBytes: item.reservedBytes, deferTextExtraction: true,
          signal: item.controller.signal,
          onProgress: progress => {
            ensure(item);
            if (!progress || !Number.isSafeInteger(progress.receivedBytes) || progress.receivedBytes < item.received || progress.receivedBytes > item.reservedBytes) throw invalidSnapshot();
            item.received = progress.receivedBytes;
            if (progress.totalBytes !== undefined) {
              if (!Number.isSafeInteger(progress.totalBytes) || progress.totalBytes < progress.receivedBytes || progress.totalBytes > item.reservedBytes) throw quotaError();
              item.totalBytes = progress.totalBytes;
            }
          },
        }));
        await sealUrl(item, result);
        await finish(owner, id);
      } catch (error) {
        if (!item.deleting) {
          const failure = item.snapshotReady ? safeError(error) : sourceFailure(error);
          item.status = 'error'; item.error = failure.message;
          if (!item.snapshotReady) requestCleanup(item);
        }
      } finally { const done = release; release = null; try { await done?.(); } catch { /* A host lease must not leak an unhandled background rejection. */ } }
    });
    return publicItem(item);
  }

  function cacheTask(item, run) {
    const previous = item.cacheTail;
    const work = track(item, async () => { await previous.catch(() => {}); await check(item); ensure(item); return run(); });
    item.cacheTail = work; return work;
  }
  async function cacheDirectory(item) {
    if (!item.cacheDirectory) {
      const path = join(item.directory, `parts-${randomUUID()}`);
      await step(item, () => fs.mkdir(path, { mode: 0o700 })); ensure(item); item.cacheDirectory = path;
    }
    return item.cacheDirectory;
  }
  // Only call under cacheTask's lock. An abandoned staging slot must be
  // removed before any subsequent publication; never discard its retry state.
  async function clearCacheStaging(item) {
    try {
      await fs.rm(join(item.cacheDirectory, '.part-staging.tmp'), { force: true });
      item.cacheCleanupNeeded = false;
    } catch (error) { item.cacheCleanupNeeded = true; throw error; }
  }
  function retryCacheCleanup(item) {
    if (item.cacheCleanupPromise) return item.cacheCleanupPromise;
    const work = cacheTask(item, async () => {
      if (item.cacheCleanupNeeded) await step(item, () => clearCacheStaging(item));
    });
    item.cacheCleanupPromise = work;
    work.then(() => { item.cacheCleanupPromise = null; }, () => { item.cacheCleanupPromise = null; });
    return work;
  }
  async function cachePart(item, index, result) {
    return cacheTask(item, async () => {
      const path = await cacheDirectory(item);
      await step(item, () => clearCacheStaging(item));
      const label = item.extension === 'pdf' ? `pages ${index * 3 + 1}–${Math.min(item.pages, index * 3 + 3)}` : result.start !== undefined ? `${result.start}–${result.end} seconds` : `part ${index + 1}`;
      const value = { ...result, index, label, source: `${item.name} · ${label}` };
      // Read, publication and eviction share a lock. Evict before adding a
      // large part: repeated eviction failures cannot grow an unbounded cache.
      // A failed publication can regenerate the evicted part from the original.
      if (index > 0 && (item.extension === 'pdf' || item.kind === 'media')) {
        for (const old of item.cached) if (old > 0 && old !== index) {
          await step(item, () => fs.rm(join(path, `part-${old}.json`), { force: true })); item.cached.delete(old);
        }
      }
      // One reusable slot per material, including across different part indexes.
      const temporary = join(path, '.part-staging.tmp'), target = join(path, `part-${index}.json`);
      let published = false;
      try {
        await step(item, () => fs.writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' }));
        await step(item, () => fs.rename(temporary, target)); ensure(item);
        published = true; item.cached.add(index);
        return value;
      } finally {
        // This remains part of the registered writer even during deletion.
        if (!published) await clearCacheStaging(item).catch(() => {});
      }
    });
  }
  async function prepareUrlText(item) {
    if (item.textFile) return;
    return cacheTask(item, async () => {
      if (item.textFile) return;
      const path = await cacheDirectory(item);
      await step(item, () => clearCacheStaging(item));
      if (item.pendingText === undefined) {
        const extract = sourceTextExtractor || (await step(item, () => import('./url-source.mjs'))).extractSavedUrlText;
        const result = await step(item, () => extract({ file: item.file, extension: item.extension, size: item.size, signal: item.controller.signal }));
        if (!result || typeof result.text !== 'string' || result.text.length > 2_000_000 || !result.text.isWellFormed()) throw invalidSnapshot();
        const needed = item.originalBytes + Buffer.byteLength(result.text, 'utf8');
        if (needed > item.reservedBytes) {
          const extra = needed - item.reservedBytes;
          const owned = [...entries.values()].filter(entry => entry.owner === item.owner).reduce((sum, entry) => sum + entry.reservedBytes, 0);
          if (owned + extra > limits.ownerBytes || reserved + extra > limits.instanceBytes) throw quotaError();
          reserved += extra; item.reservedBytes += extra;
        }
        item.pendingText = result.text;
        if (Array.isArray(result.warnings)) item.warnings = [...new Set([...item.warnings, ...result.warnings.filter(value => typeof value === 'string').slice(0, 50).map(value => publicText(value, 2000))])];
        if (result.title) item.provenance = Object.freeze({ ...item.provenance, title: publicText(result.title, 512) });
      }
      const temporary = join(path, '.part-staging.tmp');
      let published = false;
      try {
        // A failed rename acknowledgement can leave the bounded target behind.
        // Remove it before another write; never accumulate duplicate sidecars.
        await step(item, () => fs.rm(item.textTarget, { force: true }));
        await step(item, () => fs.writeFile(temporary, item.pendingText, { encoding: 'utf8', mode: 0o600, flag: 'wx' }));
        await step(item, () => fs.rename(temporary, item.textTarget));
        item.textFile = item.textTarget; published = true;
        releaseBytes(item, item.originalBytes + Buffer.byteLength(item.pendingText, 'utf8'));
        item.pendingText = undefined;
      } finally { if (!published) await clearCacheStaging(item).catch(() => {}); }
    });
  }
  async function documentResult(item, index = 0) {
    const bytes = await step(item, () => fs.readFile(item.file));
    return step(item, () => importDoc(bytes, item.extension, { signal: item.controller.signal, timeoutMs: 120000,
      ...(item.extension === 'pdf' ? { options: { startPage: index * 3 + 1, pageCount: 3 } } : {}) }));
  }
  async function prepare(item) {
    if (!item.snapshotReady) {
      const sourceHash = await hashSource(item, item.file, item.size);
      await check(item); ensure(item); item.sourceHash = sourceHash; item.snapshotReady = true;
    }
    if (item.kind === 'text' || item.kind === 'document') {
      if (item.kind === 'text') await prepareUrlText(item);
      const result = item.kind === 'text'
        ? { text: await step(item, () => fs.readFile(item.textFile, 'utf8')), images: [], warnings: item.warnings || [] }
        : await documentResult(item);
      await check(item); ensure(item);
      if (typeof result.text !== 'string') throw new AppError('Document extraction returned an invalid result.', 422);
      item.analysisMode = 'sampled-stills'; item.pages = result.pages;
      item.warnings = [...new Set([...(item.warnings || []), ...(result.warnings || [])])];
      if (item.extension === 'pdf') {
        if (!Number.isSafeInteger(result.pages) || result.pages < 1) throw new AppError('Document extraction returned an invalid page count.', 422);
        item.partCount = Math.ceil(result.pages / 3); await cachePart(item, 0, result);
      } else {
        const chunks = splitMaterialText(result.text); item.partCount = chunks.length;
        for (let i = 0; i < chunks.length; i++) await cachePart(item, i, { text: chunks[i], images: [], warnings: item.warnings });
      }
    } else {
      const media = await step(item, mediaLoader);
      const info = await step(item, () => media.inspectMedia(item.file, item.extension, { signal: item.controller.signal }));
      if (!Number.isSafeInteger(info.partCount) || info.partCount < 1) throw new AppError('Media inspection returned an invalid part count.', 422);
      if (item.origin === 'url' && ((item.mode === 'audio' && info.hasVideo) || (item.mode === 'video' && !info.hasVideo) || (item.provenance.type === 'youtube' && (!info.hasVideo || !info.hasAudio)))) throw new AppError('This source does not contain the requested audiovisual media. No audio-only substitution is allowed.', 422);
      ensure(item);
      item.analysisMode = info.hasVideo && (item.origin === 'url' || item.requestedAnalysisMode === 'whole-video') ? 'whole-video' : 'sampled-stills';
      if (item.analysisMode === 'whole-video') {
        const video = await step(item, videoLoader);
        if (!item.videoInspectedInfo) {
          const inspected = await step(item, () => video.inspectWholeVideoSource(item.file, item.extension, info,
            { signal: item.controller.signal, sourceHash: item.sourceHash }));
          ensure(item); item.videoInspectedInfo = frozenCopy(inspected);
        }
        item.info = item.videoInspectedInfo;
        const plan = await step(item, () => video.videoClipPlan(item.info)); ensure(item);
        item.videoPlan = frozenCopy(plan); item.videoBounds = video.videoClipBounds; item.partCount = plan.partCount;
        item.warnings = [...new Set([...(item.warnings || []), ...plan.warnings])];
      } else {
        item.info = frozenCopy(info);
        item.partCount = info.partCount;
        item.warnings = [...new Set([...(item.warnings || []), 'Long recordings are automatically processed in chronological segments. Video uses sampled stills, not every frame.'])];
      }
    }
    await check(item); ensure(item); item.status = 'ready'; return publicItem(item);
  }
  async function finish(owner, id) {
    const item = get(owner, id);
    if (item.status === 'ready') return publicItem(item);
    if (item.preparing) return item.preparing;
    if (item.origin === 'url' && !item.snapshotReady) throw new AppError('Wait for a complete source snapshot. Failed acquisition must be reimported explicitly with a new ID.', 409);
    if (item.writing || item.received !== item.size) throw new AppError('Wait for the upload to finish.', 409);
    item.status = 'preparing'; item.error = null;
    const work = track(item, async () => {
      try { await item.init; await check(item); ensure(item); return await prepare(item); }
      catch (error) {
        const failure = safeError(error);
        if (!item.deleting) { item.status = 'error'; item.error = failure.message; }
        throw failure;
      }
    });
    item.preparing = work;
    work.then(() => { item.preparing = null; }, () => { item.preparing = null; });
    return work;
  }
  async function part(owner, id, index) {
    const item = get(owner, id);
    if (item.status !== 'ready' || !Number.isInteger(index) || index < 0 || index >= item.partCount) throw new AppError('Invalid material part.');
    if (item.pendingParts.has(index)) return item.pendingParts.get(index);
    const work = track(item, async () => {
      try {
        await item.init; await check(item); ensure(item);
        if (item.analysisMode === 'whole-video' && item.info?.hasVideo) {
          const { start, end } = item.videoBounds(index, item.videoPlan);
          const label = `${start}–${end} seconds`;
          return { videoRef: { materialId: item.id, snapshotId: item.snapshotId, index }, analysisMode: 'whole-video',
            start, end, text: '', images: [], index, label, source: `${item.name} · ${label}` };
        }
        const cached = await cacheTask(item, async () => {
          try {
            const raw = await step(item, () => fs.readFile(join(item.cacheDirectory || item.directory, `part-${index}.json`), 'utf8'));
            return JSON.parse(raw);
          } catch (error) { if (error.code !== 'ENOENT') throw error; }
        });
        if (cached !== undefined) { await check(item); ensure(item); return cached; }
        let result;
        if (item.kind === 'text') {
          const chunks = splitMaterialText(await step(item, () => fs.readFile(item.textFile, 'utf8')));
          result = { text: chunks[index], images: [], warnings: item.warnings };
        } else if (item.kind === 'document') {
          result = await documentResult(item, index);
          if (item.extension !== 'pdf') result = { text: splitMaterialText(result.text)[index], images: [], warnings: result.warnings || [] };
        } else {
          const media = await step(item, mediaLoader);
          result = await step(item, () => media.prepareMediaPart(item.file, item.extension, index, item.info, { signal: item.controller.signal }));
        }
        return await cachePart(item, index, result);
      } catch (error) { throw safeError(error); }
    });
    item.pendingParts.set(index, work);
    work.then(() => item.pendingParts.delete(index), () => item.pendingParts.delete(index));
    return work;
  }
  async function withSnapshot(owner, id, work) {
    const item = get(owner, id);
    if (!item.snapshotReady || typeof work !== 'function') throw new AppError('A complete immutable source snapshot is required.', 409);
    return track(item, async () => {
      await item.init; await check(item); ensure(item);
      const snapshot = Object.freeze({ id: item.id, snapshotId: item.snapshotId, sourceHash: item.sourceHash, name: item.name,
        kind: item.kind, directory: item.directory, file: item.file, extension: item.extension, info: frozenCopy(item.info),
        analysisMode: item.analysisMode, videoPlan: frozenCopy(item.videoPlan), signal: item.controller.signal, provenance: item.provenance });
      return step(item, () => work(snapshot));
    });
  }
  async function remove(owner, id) {
    remember(owner, id);
    const item = entries.get(id);
    if (!item || item.owner !== owner) return;
    return beginDelete(item);
  }
  function clearOwner(owner) {
    const existing = ownerGates.get(owner);
    if (existing?.promise) return existing.promise;
    const gate = {}; ownerGates.set(owner, gate);
    const cleanups = [...entries.values()].filter(item => item.owner === owner).map(beginDelete);
    const work = Promise.allSettled(cleanups).then(results => {
      if (results.some(result => result.status === 'rejected')) throw cleanupError();
      if (ownerGates.get(owner) === gate) ownerGates.delete(owner);
    });
    gate.promise = work;
    work.then(() => { gate.promise = null; }, () => { gate.promise = null; });
    return work;
  }
  async function cleanRoot() {
    if (!closed || entries.size || !rootPath) return;
    if (!rootCleanup) {
      const path = rootPath;
      rootCleanup = Promise.resolve().then(() => erase(path)).then(() => { if (rootPath === path) rootPath = undefined; });
      rootCleanup.then(() => { rootCleanup = null; }, () => { rootCleanup = null; });
    }
    await rootCleanup;
  }
  async function retryCleanup() {
    const results = await Promise.allSettled([...entries.values()].filter(item => item.cleanupNeeded || item.cacheCleanupNeeded)
      .map(item => item.cleanupNeeded ? requestCleanup(item) : retryCacheCleanup(item)));
    const rootResult = await Promise.allSettled([cleanRoot()]);
    return { pending: [...entries.values()].filter(item => item.cleanupNeeded || item.cacheCleanupNeeded).length + (closed && !entries.size && rootPath ? 1 : 0), failed: [...results, ...rootResult].filter(result => result.status === 'rejected').length };
  }
  function close() {
    closed = true;
    if (closePromise) return closePromise;
    const cleanups = [...entries.values()].map(beginDelete);
    closePromise = Promise.allSettled(cleanups).then(async results => {
      if (results.some(result => result.status === 'rejected')) throw cleanupError();
      try { await cleanRoot(); } catch { throw cleanupError(); }
    });
    closePromise.then(() => { closePromise = null; }, () => { closePromise = null; });
    return closePromise;
  }
  return { create, append, finish, part, startImport, withSnapshot, remove, clearOwner, close, retryCleanup,
    list: owner => [...entries.values()].filter(item => item.owner === owner).map(publicItem),
    status: (owner, id) => publicItem(get(owner, id, true)) };
}
