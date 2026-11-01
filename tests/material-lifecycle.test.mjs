import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setImmediate as tick } from 'node:timers/promises';
import { createMaterialStore } from '../lib/material-store.mjs';
import { syntheticVideoLoader } from './video-test-fixtures.mjs';

const TIMEOUT = { timeout: 10000 };
const tiny = { ownerBytes: 8, instanceBytes: 8, documentBytes: 8, mediaBytes: 8, minFreeBytes: 0 };
const parsed = text => ({ text, images: [], warnings: [] });
function deferred(t) {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  t?.after(() => resolve());
  return { promise, resolve };
}
async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(join(tmpdir(), 'learnlens-lifecycle-'));
  const store = createMaterialStore({ directory, videoLoader: syntheticVideoLoader, importDoc: async () => parsed('complete source text'), ...options });
  t.after(async () => { try { await store.close(); } finally { await fs.rm(directory, { recursive: true, force: true }); } });
  return { store, directory };
}
async function uploaded(store, { owner = 'alice', name = 'source.docx', bytes = Buffer.from('synthetic'), finish = true } = {}) {
  const id = randomUUID();
  await store.create(owner, { id, name, size: bytes.length });
  await store.append(owner, id, 0, bytes);
  if (finish) await store.finish(owner, id);
  return id;
}
const statusCode = code => error => error.status === code;

test('initialization is awaited by duplicate create and early append; reservation precedes disk', TIMEOUT, async t => {
  const entered = deferred(t), resume = deferred(t);
  let opens = 0;
  const { store } = await fixture(t, { limits: tiny, fs: {
    writeFile: async (path, ...args) => { if (basename(path) === 'source.docx') { entered.resolve(); await resume.promise; } return fs.writeFile(path, ...args); },
    open: async (...args) => { opens++; return fs.open(...args); },
  } });
  const id = randomUUID(), body = { id, name: 'notes.docx', size: 8 };
  const creation = store.create('alice', body); await entered.promise;
  let duplicateDone = false;
  const duplicate = store.create('alice', body).then(value => { duplicateDone = true; return value; });
  const append = store.append('alice', id, 0, Buffer.from('12345678'));
  await tick();
  assert.equal(store.status('alice', id).status, 'initializing');
  assert.equal(duplicateDone, false); assert.equal(opens, 0);
  await assert.rejects(store.create('alice', { ...body, id: randomUUID(), size: 1 }), statusCode(413));
  await assert.rejects(store.create('bob', body), statusCode(404));
  await assert.rejects(store.create('alice', { ...body, name: 'other.docx' }), statusCode(409));
  resume.resolve(); await Promise.all([creation, duplicate, append]);
  assert.equal(store.status('alice', id).received, 8);
  assert.equal((await store.finish('alice', id)).status, 'ready');
});

test('delete during late mkdir keeps entry and quota until initialization settles', TIMEOUT, async t => {
  const entered = deferred(t), resume = deferred(t);
  let physical;
  const { store } = await fixture(t, { limits: tiny, fs: {
    mkdir: async (path, options) => { await fs.mkdir(path, options); physical = path; entered.resolve(); await resume.promise; },
  } });
  const id = randomUUID();
  const creation = store.create('alice', { id, name: 'notes.docx', size: 8 });
  const rejected = assert.rejects(creation, statusCode(409)); await entered.promise;
  let removed = false;
  const removal = store.remove('alice', id).then(() => { removed = true; });
  assert.equal(store.status('alice', id).status, 'deleting');
  await assert.rejects(store.create('bob', { id: randomUUID(), name: 'next.docx', size: 1 }), statusCode(413));
  await assert.rejects(store.create('alice', { id, name: 'notes.docx', size: 8 }), statusCode(409));
  await tick(); assert.equal(removed, false); assert.ok((await fs.stat(physical)).isDirectory());
  resume.resolve(); await Promise.all([removal, rejected]);
  await assert.rejects(fs.stat(physical), { code: 'ENOENT' });
  assert.throws(() => store.status('alice', id), statusCode(404));
  await store.create('bob', { id: randomUUID(), name: 'next.docx', size: 8 });
});

test('owner-scoped cancellation tombstones are bounded, expire, and never reuse physical paths', TIMEOUT, async t => {
  let time = 0; const paths = [];
  const { store } = await fixture(t, { now: () => time, limits: { tombstoneOwnerCount: 2, tombstoneCount: 3, tombstoneTtlMs: 10 }, fs: {
    mkdir: async (path, options) => { paths.push(path); return fs.mkdir(path, options); },
  } });
  const id = randomUUID(), body = { id, name: 'notes.docx', size: 1 };
  await store.remove('alice', id);
  await assert.rejects(store.create('alice', body), statusCode(409));
  await store.create('bob', body); await store.remove('bob', id);
  time = 11;
  await store.create('alice', body); await store.remove('alice', id);
  assert.equal(new Set(paths).size, 2); assert.notEqual(basename(paths[0]), id);
  const ids = [randomUUID(), randomUUID(), randomUUID()];
  for (const cancelled of ids) await store.remove('charlie', cancelled);
  await store.create('charlie', { ...body, id: ids[0] }); // Oldest per-owner cancellation was bounded out.
  await assert.rejects(store.create('charlie', { ...body, id: ids[2] }), statusCode(409));
  await store.remove('david', randomUUID()); await store.remove('david', randomUUID());
  await store.create('charlie', { ...body, id: ids[1] }); // Global tombstone bound is independent of owner count.
});

test('initialization failure drains waiting append without self-await and releases capacity', TIMEOUT, async t => {
  const entered = deferred(t), resume = deferred(t); let fail = true;
  const { store } = await fixture(t, { limits: tiny, fs: {
    statfs: async path => { if (fail) { fail = false; entered.resolve(); await resume.promise; throw new Error('synthetic disk failure'); } return fs.statfs(path); },
  } });
  const id = randomUUID();
  const creation = store.create('alice', { id, name: 'notes.docx', size: 8 });
  const rejected = assert.rejects(creation, /processing failed/); await entered.promise;
  const appendRejected = assert.rejects(store.append('alice', id, 0, Buffer.from('x')), /processing failed/);
  resume.resolve(); await Promise.all([rejected, appendRejected]);
  assert.throws(() => store.status('alice', id), statusCode(404));
  await store.create('alice', { id: randomUUID(), name: 'retry.docx', size: 8 });
});

test('failed root creation can be retried and close never waits on its own initializer', TIMEOUT, async t => {
  let fail = true;
  const { store } = await fixture(t, { fs: {
    mkdtemp: async prefix => { if (fail) { fail = false; throw new Error('synthetic root failure'); } return fs.mkdtemp(prefix); },
  } });
  await assert.rejects(store.create('alice', { id: randomUUID(), name: 'notes.docx', size: 1 }), /processing failed/);
  await store.create('alice', { id: randomUUID(), name: 'notes.docx', size: 1 });
  await store.close(); await store.close();
});

for (const phase of ['open', 'write', 'close']) test(`delete waits for an append ${phase} already in flight`, TIMEOUT, async t => {
  const entered = deferred(t), resume = deferred(t);
  let handleClosed = false, cleanupCalls = 0;
  const { store } = await fixture(t, { limits: tiny, fs: {
    open: async (path, flags) => {
      const handle = await fs.open(path, flags);
      if (flags !== 'r+') return handle;
      if (phase === 'open') { entered.resolve(); await resume.promise; }
      return {
        write: async (...args) => { const result = await handle.write(...args); if (phase === 'write') { entered.resolve(); await resume.promise; } return result; },
        truncate: (...args) => handle.truncate(...args), sync: () => handle.sync(),
        close: async () => { if (phase === 'close') { entered.resolve(); await resume.promise; } await handle.close(); handleClosed = true; },
      };
    },
  }, cleanup: async path => { cleanupCalls++; assert.equal(handleClosed, true); await fs.rm(path, { recursive: true, force: true }); } });
  const id = randomUUID(); await store.create('alice', { id, name: 'notes.docx', size: 8 });
  const append = store.append('alice', id, 0, Buffer.from('12345678'));
  const result = assert.rejects(append, statusCode(409));
  await entered.promise;
  const removal = store.remove('alice', id); await tick();
  assert.equal(cleanupCalls, 0);
  await assert.rejects(store.create('bob', { id: randomUUID(), name: 'next.docx', size: 1 }), statusCode(413));
  resume.resolve(); await Promise.all([result, removal]);
  assert.equal(handleClosed, true); assert.equal(cleanupCalls, 1);
});

test('snapshot seal is stable across local retry, duplicate upload acknowledgement and status mutation', TIMEOUT, async t => {
  let calls = 0;
  const { store } = await fixture(t, { importDoc: async () => { if (++calls === 1) throw new Error('synthetic parser failure'); return parsed('retained'); } });
  const bytes = Buffer.from('immutable synthetic original');
  const id = await uploaded(store, { bytes, finish: false });
  await assert.rejects(store.finish('alice', id), /processing failed/);
  const failed = store.status('alice', id);
  assert.equal(failed.snapshotReady, true);
  assert.equal(failed.sourceHash, createHash('sha256').update(bytes).digest('hex'));
  const ready = await store.finish('alice', id);
  assert.equal(ready.snapshotId, failed.snapshotId); assert.equal(ready.sourceHash, failed.sourceHash);
  assert.equal((await store.append('alice', id, 0, bytes)).status, 'ready');
  await assert.rejects(store.append('alice', id, 0, Buffer.from('different')), statusCode(409));
  ready.warnings.push('not persisted'); assert.ok(!store.status('alice', id).warnings.includes('not persisted'));
  await store.withSnapshot('alice', id, async snapshot => {
    assert.equal(Object.isFrozen(snapshot), true); assert.deepEqual(await fs.readFile(snapshot.file), bytes);
    assert.equal(snapshot.sourceHash, ready.sourceHash); assert.equal(snapshot.signal.aborted, false);
  });
  assert.equal(calls, 2);
});

test('pending part is registered before a cache read and delete waits for cache-hit readers', TIMEOUT, async t => {
  const entered = deferred(t), resume = deferred(t); let block = false, reads = 0, calls = 0;
  const { store } = await fixture(t, { importDoc: async () => { calls++; return parsed('retained'); }, fs: {
    readFile: async (path, ...args) => {
      if (block && basename(path) === 'part-0.json') { reads++; entered.resolve(); await resume.promise; }
      return fs.readFile(path, ...args);
    },
  } });
  const id = await uploaded(store); block = true;
  const first = store.part('alice', id, 0); const firstRejected = assert.rejects(first, statusCode(409));
  await entered.promise;
  const secondRejected = assert.rejects(store.part('alice', id, 0), statusCode(409));
  let removed = false; const removal = store.remove('alice', id).then(() => { removed = true; });
  await tick(); assert.equal(removed, false); assert.equal(reads, 1);
  resume.resolve(); await Promise.all([firstRejected, secondRejected, removal]); assert.equal(calls, 1);
});

test('cache-miss readers coalesce before any await, and publication uses a temporary file plus rename', TIMEOUT, async t => {
  const entered = deferred(t), resume = deferred(t); let initialRead = true, generated = 0;
  const writes = [], renames = [];
  const { store } = await fixture(t, { importDoc: async (_, __, { options }) => {
    if (options.startPage === 4) generated++;
    return { ...parsed(`pages starting ${options.startPage}`), pages: 9 };
  }, fs: {
    readFile: async (path, ...args) => { if (initialRead && basename(path) === 'part-1.json') { initialRead = false; entered.resolve(); await resume.promise; } return fs.readFile(path, ...args); },
    writeFile: async (path, ...args) => { writes.push(path); return fs.writeFile(path, ...args); },
    rename: async (from, to) => { renames.push([from, to]); return fs.rename(from, to); },
  } });
  const id = await uploaded(store, { name: 'synthetic.pdf' });
  const first = store.part('alice', id, 1); await entered.promise;
  const second = store.part('alice', id, 1); resume.resolve();
  const values = await Promise.all([first, second]);
  assert.deepEqual(values[0], values[1]); assert.equal(generated, 1);
  assert.ok(writes.filter(path => basename(path).includes('part-')).every(path => path.endsWith('.tmp')));
  assert.equal(renames.length, 2); assert.ok(renames.every(([from, to]) => from.endsWith('.tmp') && to.endsWith('.json')));
});

test('eviction serializes with cache reads and keeps the preview plus latest generated part', TIMEOUT, async t => {
  const entered = deferred(t), resume = deferred(t); let block = false, evicted = false;
  const { store } = await fixture(t, { importDoc: async (_, __, { options }) => ({ ...parsed(`pages ${options.startPage}`), pages: 9 }), fs: {
    readFile: async (path, ...args) => { if (block && basename(path) === 'part-1.json') { block = false; entered.resolve(); await resume.promise; } return fs.readFile(path, ...args); },
    rm: async (path, ...args) => { if (basename(path) === 'part-1.json') evicted = true; return fs.rm(path, ...args); },
  } });
  const id = await uploaded(store, { name: 'synthetic.pdf' }); await store.part('alice', id, 1);
  block = true; const read = store.part('alice', id, 1); await entered.promise;
  const next = store.part('alice', id, 2); await tick(); assert.equal(evicted, false);
  resume.resolve(); const [oldPart, newPart] = await Promise.all([read, next]);
  assert.equal(oldPart.text, 'pages 4'); assert.equal(newPart.text, 'pages 7'); assert.equal(evicted, true);
  await store.withSnapshot('alice', id, async snapshot => {
    const cache = (await fs.readdir(snapshot.directory)).find(name => name.startsWith('parts-'));
    assert.deepEqual((await fs.readdir(join(snapshot.directory, cache))).sort(), ['part-0.json', 'part-2.json']);
  });
});

test('failed atomic cache publication leaves no partial JSON and local finish can retry', TIMEOUT, async t => {
  let fail = true, calls = 0;
  const { store } = await fixture(t, { importDoc: async () => { calls++; return parsed('x'.repeat(45000)); }, fs: {
    rename: async (from, to) => { if (fail && basename(to) === 'part-1.json') { fail = false; throw new Error('synthetic rename failure'); } return fs.rename(from, to); },
  } });
  const id = await uploaded(store, { finish: false });
  await assert.rejects(store.finish('alice', id), /processing failed/);
  await store.withSnapshot('alice', id, async snapshot => {
    const cache = (await fs.readdir(snapshot.directory)).find(name => name.startsWith('parts-'));
    assert.deepEqual(await fs.readdir(join(snapshot.directory, cache)), ['part-0.json']);
  });
  const result = await store.finish('alice', id); assert.equal(result.partCount, 3); assert.equal(calls, 2);
  assert.equal((await store.part('alice', id, 2)).text.length, 5000);
});

test('cleanup failure retains entry, accounting and clearOwner gate until independent retry succeeds', TIMEOUT, async t => {
  let fail = true;
  const { store } = await fixture(t, { limits: tiny, cleanup: async path => { if (fail) throw new Error('synthetic removal failure'); await fs.rm(path, { recursive: true, force: true }); } });
  t.after(() => { fail = false; });
  const id = randomUUID(); await store.create('alice', { id, name: 'notes.docx', size: 8 });
  await assert.rejects(store.clearOwner('alice'), /Storage remains reserved/);
  assert.equal(store.status('alice', id).status, 'deleting'); assert.equal(store.status('alice', id).cleanupPending, true);
  await assert.rejects(store.create('alice', { id: randomUUID(), name: 'next.docx', size: 1 }), statusCode(409));
  await assert.rejects(store.create('bob', { id: randomUUID(), name: 'next.docx', size: 1 }), statusCode(413));
  assert.deepEqual(await store.retryCleanup(), { pending: 1, failed: 1 });
  fail = false; assert.deepEqual(await store.retryCleanup(), { pending: 0, failed: 0 });
  assert.throws(() => store.status('alice', id), statusCode(404));
  await store.create('alice', { id: randomUUID(), name: 'next.docx', size: 8 });
});

test('close gates new admissions immediately and drains late initialization before deleting the root', TIMEOUT, async t => {
  const entered = deferred(t), resume = deferred(t);
  const { store, directory } = await fixture(t, { fs: {
    writeFile: async (path, ...args) => { entered.resolve(); await resume.promise; return fs.writeFile(path, ...args); },
  } });
  const creation = store.create('alice', { id: randomUUID(), name: 'notes.docx', size: 1 });
  const rejected = assert.rejects(creation, statusCode(409)); await entered.promise;
  let closed = false; const closing = store.close().then(() => { closed = true; });
  await assert.rejects(store.create('bob', { id: randomUUID(), name: 'notes.docx', size: 1 }), statusCode(503));
  await tick(); assert.equal(closed, false);
  resume.resolve(); await Promise.all([closing, rejected]);
  assert.deepEqual(await fs.readdir(directory), []);
});

test('root cleanup failure remains retryable after entries and their accounting are gone', TIMEOUT, async t => {
  let failRoot = true;
  const { store, directory } = await fixture(t, { cleanup: async path => {
    if (basename(path).startsWith('learnlens-materials-') && failRoot) throw new Error('synthetic root removal failure');
    await fs.rm(path, { recursive: true, force: true });
  } });
  await uploaded(store);
  await assert.rejects(store.close(), /cleanup failed/);
  assert.deepEqual(await store.retryCleanup(), { pending: 1, failed: 1 });
  failRoot = false;
  assert.deepEqual(await store.retryCleanup(), { pending: 0, failed: 0 });
  assert.deepEqual(await fs.readdir(directory), []); await store.close();
});

test('withSnapshot borrowers are tracked until settled and cannot publish after deletion', TIMEOUT, async t => {
  const entered = deferred(t), resume = deferred(t); let snapshot;
  const { store } = await fixture(t);
  const id = await uploaded(store);
  const borrower = store.withSnapshot('alice', id, async value => { snapshot = value; entered.resolve(); await resume.promise; return fs.readFile(value.file, 'utf8'); });
  const rejected = assert.rejects(borrower, statusCode(409)); await entered.promise;
  let removed = false; const removal = store.remove('alice', id).then(() => { removed = true; });
  assert.equal(snapshot.signal.aborted, true); await tick(); assert.equal(removed, false);
  assert.equal(await fs.readFile(snapshot.file, 'utf8'), 'synthetic');
  resume.resolve(); await Promise.all([rejected, removal]);
  await assert.rejects(fs.stat(snapshot.directory), { code: 'ENOENT' });
});

test('default limits stay at 10 items, 1 GiB owner, 4 GiB instance, 100 MiB documents and 1 GiB media', TIMEOUT, async t => {
  const GiB = 1024 ** 3, MiB = 1024 ** 2;
  const { store } = await fixture(t, { fs: { statfs: async () => ({ bavail: 100 * GiB, bsize: 1 }) } });
  await assert.rejects(store.create('docs', { id: randomUUID(), name: 'oversize.docx', size: 100 * MiB + 1 }), statusCode(413));
  await assert.rejects(store.create('media', { id: randomUUID(), name: 'oversize.mp4', size: GiB + 1 }), statusCode(413));
  for (let i = 0; i < 10; i++) await store.create('count', { id: randomUUID(), name: 'tiny.docx', size: 1 });
  await assert.rejects(store.create('count', { id: randomUUID(), name: 'eleventh.docx', size: 1 }), statusCode(413));
  await store.clearOwner('count');
  for (let i = 0; i < 4; i++) await store.create(`owner-${i}`, { id: randomUUID(), name: 'empty-placeholder.mp4', size: GiB });
  await assert.rejects(store.create('owner-0', { id: randomUUID(), name: 'over-owner.docx', size: 1 }), statusCode(413));
  await assert.rejects(store.create('owner-4', { id: randomUUID(), name: 'over-instance.docx', size: 1 }), statusCode(413));
  await store.clearOwner('owner-1');
  await store.create('docs', { id: randomUUID(), name: 'at-limit.docx', size: 100 * MiB });
});

test('limits are constructor-only bounded capabilities, not upload body options', TIMEOUT, async t => {
  assert.throws(() => createMaterialStore({ limits: { ownerItems: 11 } }), /Invalid material store limit/);
  assert.throws(() => createMaterialStore({ limits: { unknownLimit: 1 } }), /Invalid material store limit/);
  const { store } = await fixture(t, { limits: tiny });
  await assert.rejects(store.create('alice', { id: randomUUID(), name: 'notes.docx', size: 9, limits: { ownerBytes: 100 }, directory: 'C:/not-used' }), statusCode(413));
});

test('uploaded whole-video is opt-in, retains native info, and exposes only stable clip references', TIMEOUT, async t => {
  const info = { duration: 60.2, hasAudio: true, hasVideo: true, partCount: 1, width: 1280, height: 720 };
  let sampled = 0;
  const { store } = await fixture(t, { mediaLoader: async () => ({
    inspectMedia: async () => info,
    prepareMediaPart: async () => { sampled++; return { ...parsed('legacy sample'), start: 0, end: 60.2 }; },
  }) });
  const legacy = await uploaded(store, { name: 'legacy.mp4' });
  assert.equal(store.status('alice', legacy).analysisMode, 'sampled-stills');
  assert.equal((await store.part('alice', legacy, 0)).text, 'legacy sample');
  const id = randomUUID(), body = { id, name: 'complete.mp4', size: 1, analysisMode: 'whole-video' };
  await store.create('alice', body);
  const pending = store.list('alice').find(item => item.id === id);
  assert.equal(pending.status, 'uploading'); assert.equal(pending.analysisMode, 'whole-video'); assert.equal(pending.snapshotReady, false);
  await store.append('alice', id, 0, Buffer.from('x'));
  const ready = await store.finish('alice', id);
  assert.equal(ready.analysisMode, 'whole-video'); assert.equal(ready.partCount, 2);
  await assert.rejects(store.create('alice', { ...body, analysisMode: 'sampled-stills' }), statusCode(409));
  for (let index = 0; index < 2; index++) {
    const part = await store.part('alice', id, index);
    assert.deepEqual(Object.keys(part).sort(), ['analysisMode', 'end', 'images', 'index', 'label', 'source', 'start', 'text', 'videoRef']);
    assert.deepEqual(part.videoRef, { materialId: id, snapshotId: ready.snapshotId, index });
    assert.equal(part.start, index * 30); assert.equal(part.end, index ? 60.2 : 30);
    assert.equal(part.text, ''); assert.deepEqual(part.images, []);
  }
  assert.equal(sampled, 1, 'Whole-video references never invoke native sample preparation');
  await store.withSnapshot('alice', id, async snapshot => {
    assert.deepEqual(snapshot.info, info); assert.equal(snapshot.info.partCount, 1);
    assert.equal(snapshot.videoPlan.partCount, 2); assert.equal(Object.isFrozen(snapshot.videoPlan), true);
    assert.equal(snapshot.analysisMode, 'whole-video');
    assert.deepEqual(await fs.readdir(snapshot.directory), ['source.mp4']);
  });
  await assert.rejects(store.part('alice', id, 2), /Invalid material part/);
  assert.equal(store.list('alice').length, 2); assert.deepEqual(store.list('bob'), []);
  assert.ok(store.list('alice').every(value => !('directory' in value) && !('file' in value) && !('videoPlan' in value)));
  await store.remove('alice', id); assert.equal(store.list('alice').length, 1);
});

test('whole-video request for audio remains audio; invalid analysis mode is rejected', TIMEOUT, async t => {
  let videoLoads = 0;
  const { store } = await fixture(t, { mediaLoader: async () => ({ inspectMedia: async () => ({ duration: 60, hasAudio: true, hasVideo: false, partCount: 1 }) }), videoLoader: async () => { videoLoads++; throw new Error('must not load'); } });
  const body = { id: randomUUID(), name: 'synthetic.mp3', size: 1, analysisMode: 'whole-video' };
  await store.create('alice', body); await store.append('alice', body.id, 0, Buffer.from('x'));
  assert.equal((await store.finish('alice', body.id)).analysisMode, 'sampled-stills'); assert.equal(videoLoads, 0);
  await assert.rejects(store.create('alice', { ...body, id: randomUUID(), analysisMode: 'silent-fallback' }), /Invalid material analysis mode/);
});

test('deletion drains an atomic-cache writer even when it ignores cancellation', TIMEOUT, async t => {
  const entered = deferred(t), resume = deferred(t); let temporary;
  const { store } = await fixture(t, { fs: {
    writeFile: async (path, bytes, options) => {
      if (path.endsWith('.tmp')) {
        temporary = path; await fs.writeFile(path, '{', options); entered.resolve(); await resume.promise;
        return fs.writeFile(path, bytes, { ...options, flag: 'w' });
      }
      return fs.writeFile(path, bytes, options);
    },
  } });
  const id = await uploaded(store, { finish: false });
  const failed = assert.rejects(store.finish('alice', id), statusCode(409)); await entered.promise;
  let removed = false; const removal = store.remove('alice', id).then(() => { removed = true; });
  await tick(); assert.equal(removed, false); assert.equal(await fs.readFile(temporary, 'utf8'), '{');
  resume.resolve(); await Promise.all([failed, removal]);
  await assert.rejects(fs.stat(dirname(dirname(temporary))), { code: 'ENOENT' });
});

test('failed eviction stays tracked and cannot accumulate additional large cache parts', TIMEOUT, async t => {
  let failEviction = true;
  const { store } = await fixture(t, { importDoc: async (_, __, { options }) => ({ ...parsed(`page ${options.startPage}`), pages: 12 }), fs: {
    rm: async (path, ...args) => { if (failEviction && basename(path) === 'part-1.json') throw new Error('synthetic eviction failure'); return fs.rm(path, ...args); },
  } });
  const id = await uploaded(store, { name: 'synthetic.pdf' }); await store.part('alice', id, 1);
  await assert.rejects(store.part('alice', id, 2), /processing failed/);
  await assert.rejects(store.part('alice', id, 3), /processing failed/);
  await store.withSnapshot('alice', id, async snapshot => {
    const cache = (await fs.readdir(snapshot.directory)).find(name => name.startsWith('parts-'));
    assert.deepEqual((await fs.readdir(join(snapshot.directory, cache))).sort(), ['part-0.json', 'part-1.json']);
  });
  failEviction = false; assert.equal((await store.part('alice', id, 2)).text, 'page 7');
});
