import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createMaterialStore } from '../lib/material-store.mjs';
import { syntheticVideoLoader } from './video-test-fixtures.mjs';
import { AppError } from '../lib/provider.mjs';
import { importDocument } from '../lib/document-import.mjs';
import { createUrlSourceDownloader } from '../lib/url-source.mjs';
import { parseWebHtml } from '../lib/web-extract.mjs';
import { zip, docxEntries, paragraph } from './document-fixtures.mjs';

// All acquisitions are local injected writers. No downloader, DNS, network,
// browser, credentials, installed helper or provider is invoked by these tests.
const TIMEOUT = { timeout: 15000 };
const URL_SOURCE = 'https://example.com/lesson?signature=private-test-value#private-fragment';
const statusCode = code => error => error.status === code;
const parsed = text => ({ text, images: [], warnings: [] });
function deferred(t) {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  t?.after(() => resolve());
  return { promise, resolve };
}
async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(join(tmpdir(), 'learnlens-url-store-'));
  const store = createMaterialStore({ directory, videoLoader: syntheticVideoLoader, importDoc: async () => parsed('synthetic local document'), ...options });
  t.after(async () => { try { await store.close(); } finally { await fs.rm(directory, { recursive: true, force: true }); } });
  return { store, directory };
}
function provenance(type = 'text') {
  return { type, citationUrl: 'https://example.com/lesson?private=signed#secret', title: 'Synthetic teaching source', importedAt: '2026-10-31T00:00:00.000Z' };
}
async function source(options, { bytes = Buffer.from('raw original'), text = 'full retained text', extension = 'txt', kind = 'text', extra = {} } = {}) {
  const file = join(options.directory, 'source.' + extension);
  await fs.writeFile(file, bytes, { mode: 0o600, flag: 'wx' });
  options.onProgress?.({ receivedBytes: bytes.length, totalBytes: bytes.length });
  return { file, extension, size: bytes.length, kind, name: 'Synthetic source.' + extension,
    ...(kind === 'text' ? { text } : {}), provenance: provenance(kind === 'media' ? 'direct-media' : kind === 'document' ? 'direct-document' : extension === 'html' ? 'webpage' : 'text'), warnings: [], ...extra };
}
async function until(run, message = 'background work did not settle') {
  const deadline = Date.now() + 7000;
  while (Date.now() < deadline) { const result = await run(); if (result) return result; await delay(2); }
  assert.fail(message);
}
const settled = (store, owner, id) => until(() => { const item = store.status(owner, id); return ['ready', 'error'].includes(item.status) && item; });
const gone = (store, owner, id) => until(() => { try { store.status(owner, id); return false; } catch (error) { if (error.status === 404) return true; throw error; } });

test('startImport acknowledges before initialization; normalized duplicates and status reads never acquire again', TIMEOUT, async t => {
  const initEntered = deferred(t), initialize = deferred(t), parserEntered = deferred(t), parse = deferred(t);
  let downloads = 0, leases = 0, releases = 0;
  const { store } = await fixture(t, {
    fs: { mkdir: async (path, ...args) => { if (!basename(path).startsWith('parts-')) { initEntered.resolve(); await initialize.promise; } return fs.mkdir(path, ...args); } },
    downloader: async options => { downloads++; return source(options, { kind: 'document', extension: 'docx' }); },
    importDoc: async () => { parserEntered.resolve(); await parse.promise; return parsed('local'); },
  });
  const id = randomUUID(), job = { acquireJob: () => { leases++; return () => { releases++; }; }, checkCurrent: () => true };
  const accepted = await store.startImport('alice', { id, url: URL_SOURCE }, job);
  assert.equal(accepted.status, 'initializing'); assert.equal(accepted.snapshotReady, false); assert.equal(accepted.analysisMode, 'whole-video');
  await initEntered.promise;
  assert.equal(store.list('alice')[0].status, 'initializing'); assert.equal(store.list('alice')[0].analysisMode, 'whole-video');
  assert.equal(store.list('alice')[0].snapshotId, accepted.snapshotId);
  const duplicate = await store.startImport('alice', { id, url: 'https://EXAMPLE.COM:443/lesson?signature=private-test-value#another' }, job);
  assert.equal(duplicate.snapshotId, accepted.snapshotId);
  for (let i = 0; i < 10; i++) assert.equal(store.status('alice', id).status, 'initializing');
  assert.equal(downloads, 0); assert.equal(leases, 1); assert.equal(releases, 0);
  await assert.rejects(store.startImport('alice', { id, url: URL_SOURCE, mode: 'video' }, job), statusCode(409));
  await assert.rejects(store.startImport('alice', { id, url: 'https://example.com/other' }, job), statusCode(409));
  await assert.rejects(store.startImport('bob', { id, url: URL_SOURCE }, job), statusCode(404));
  await assert.rejects(store.create('alice', { id, name: 'same.docx', size: 1 }), statusCode(409));
  await assert.rejects(store.finish('alice', id), statusCode(409));
  initialize.resolve(); await parserEntered.promise;
  assert.equal(store.status('alice', id).snapshotReady, true); assert.equal(releases, 0);
  assert.equal(store.list('alice')[0].analysisMode, 'sampled-stills', 'Confirmed documents clear the conservative pending-video gate');
  const one = store.finish('alice', id), two = store.finish('alice', id); parse.resolve(); await Promise.all([one, two]);
  await until(() => releases === 1);
  assert.equal(downloads, 1); assert.equal(leases, 1); assert.equal((await settled(store, 'alice', id)).status, 'ready');
  await store.startImport('alice', { id, url: URL_SOURCE }, job); assert.equal(downloads, 1); assert.equal(releases, 1);
});

test('text snapshots retain the unchanged original, accounted UTF-8 sidecar and every Unicode text part', TIMEOUT, async t => {
  const text = ('Full original teaching text. 😀終\n').repeat(4000), bytes = Buffer.from('<html>synthetic raw original</html>');
  const total = bytes.length + Buffer.byteLength(text), cap = total + 7;
  let downloads = 0;
  const { store } = await fixture(t, { limits: { ownerBytes: cap, instanceBytes: cap + 100, minFreeBytes: 0 }, downloader: async options => {
    downloads++; assert.equal(options.maxBytes, cap);
    return source(options, { bytes, text, extension: 'html', extra: {
      provenance: { ...provenance('webpage'), citationUrl: 'https://username:password@example.com/lesson?secret=query#fragment', title: 'Title https://example.com/?secret=hidden' },
      warnings: ['Public source; do not share https://example.com/?signature=private-test-value'],
    } });
  } });
  const id = randomUUID(); await store.startImport('alice', { id, url: URL_SOURCE });
  const ready = await settled(store, 'alice', id);
  assert.equal(ready.status, 'ready'); assert.equal(ready.size, bytes.length); assert.equal(ready.received, bytes.length);
  assert.ok(ready.partCount > 3); assert.equal(ready.sourceHash, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(ready.provenance.citationUrl, 'https://example.com/lesson');
  const serialized = JSON.stringify(ready);
  assert.doesNotMatch(serialized, /private-test-value|username|password|secret=|fragment|directory/);
  assert.equal('file' in ready, false);
  let complete = '';
  for (let i = 0; i < ready.partCount; i++) { const part = await store.part('alice', id, i); complete += part.text; assert.ok(!/[\uD800-\uDBFF]$/.test(part.text)); }
  assert.equal(complete, text); assert.equal(downloads, 1);
  await store.withSnapshot('alice', id, async snapshot => {
    assert.deepEqual(await fs.readFile(snapshot.file), bytes); assert.ok(Object.isFrozen(snapshot));
    assert.equal('url' in snapshot, false);
    const files = await fs.readdir(snapshot.directory), sidecar = files.find(file => /^text-.*\.txt$/.test(file));
    assert.equal((await fs.stat(join(snapshot.directory, sidecar))).size, Buffer.byteLength(text));
    assert.equal(await fs.readFile(join(snapshot.directory, sidecar), 'utf8'), text);
    const cache = files.find(file => file.startsWith('parts-'));
    await fs.rm(join(snapshot.directory, cache, 'part-0.json'));
  });
  const regenerated = await store.part('alice', id, 0);
  assert.equal(regenerated.text, text.slice(0, regenerated.text.length)); assert.equal(downloads, 1);
  await store.create('alice', { id: randomUUID(), name: 'remaining.docx', size: 7 });
  await assert.rejects(store.create('alice', { id: randomUUID(), name: 'over.docx', size: 1 }), statusCode(413));
  ready.provenance.citationUrl = 'mutated'; ready.warnings.push('mutated');
  assert.equal(store.status('alice', id).provenance.citationUrl, 'https://example.com/lesson');
  assert.ok(!store.list('alice')[0].warnings.includes('mutated'));
});

test('concurrent unknown-size imports reserve owner and instance ceilings atomically', TIMEOUT, async t => {
  const entered = deferred(t), resume = deferred(t); const ceilings = [];
  const { store } = await fixture(t, { limits: { ownerBytes: 40, instanceBytes: 60, mediaBytes: 40, minFreeBytes: 0 }, downloader: async options => {
    ceilings.push(options.maxBytes); if (ceilings.length === 2) entered.resolve(); await resume.promise;
    return source(options, { bytes: Buffer.from('xx'), text: 'four' });
  } });
  const a = randomUUID(), b = randomUUID();
  await store.startImport('alice', { id: a, url: URL_SOURCE });
  await assert.rejects(store.startImport('alice', { id: randomUUID(), url: URL_SOURCE }), statusCode(413));
  await store.startImport('bob', { id: b, url: URL_SOURCE }); await entered.promise;
  assert.deepEqual(ceilings.sort((x, y) => y - x), [40, 20]);
  await assert.rejects(store.create('charlie', { id: randomUUID(), name: 'no-room.docx', size: 1 }), statusCode(413));
  resume.resolve(); assert.equal((await settled(store, 'alice', a)).status, 'ready'); assert.equal((await settled(store, 'bob', b)).status, 'ready');
  await store.create('alice', { id: randomUUID(), name: 'exact-remaining.docx', size: 34 });
  await assert.rejects(store.create('alice', { id: randomUUID(), name: 'over-owner.docx', size: 1 }), statusCode(413));
});

test('partial transfer failure retains its ID and reservation until cleanup; retries never refetch', TIMEOUT, async t => {
  let failCleanup = true, downloads = 0, releases = 0, originalDirectory;
  const { store } = await fixture(t, { limits: { ownerBytes: 30, instanceBytes: 30, mediaBytes: 30, minFreeBytes: 0 }, downloader: async options => {
    downloads++; originalDirectory = options.directory;
    await fs.writeFile(join(options.directory, 'partial.tmp'), 'partial');
    throw new AppError('unsafe error https://example.com/?signature=private-test-value C:/secret/path', 502);
  }, cleanup: async path => { if (failCleanup) throw new Error('synthetic cleanup failure'); await fs.rm(path, { recursive: true, force: true }); } });
  const id = randomUUID(); await store.startImport('alice', { id, url: URL_SOURCE }, { acquireJob: () => () => { releases++; } });
  const failed = await settled(store, 'alice', id);
  assert.equal(failed.status, 'error'); assert.equal(failed.snapshotReady, false); assert.equal(failed.sourceHash, null);
  assert.doesNotMatch(JSON.stringify(failed), /private-test-value|secret\/path|unsafe error/);
  assert.deepEqual(await store.retryCleanup(), { pending: 1, failed: 1 });
  assert.ok((await fs.stat(originalDirectory)).isDirectory());
  await assert.rejects(store.create('bob', { id: randomUUID(), name: 'blocked.docx', size: 1 }), statusCode(413));
  for (let i = 0; i < 3; i++) assert.equal((await store.startImport('alice', { id, url: URL_SOURCE }, { acquireJob: () => assert.fail('duplicate job lease') })).status, 'error');
  await assert.rejects(store.finish('alice', id), /reimported explicitly/); assert.equal(downloads, 1); assert.equal(releases, 1);
  failCleanup = false; assert.deepEqual(await store.retryCleanup(), { pending: 0, failed: 0 });
  await assert.rejects(fs.stat(originalDirectory), { code: 'ENOENT' });
  assert.equal(store.status('alice', id).status, 'error', 'Failure retains the immutable ID binding even after disk cleanup');
  await store.create('bob', { id: randomUUID(), name: 'capacity-restored.docx', size: 30 });
  await store.startImport('alice', { id, url: URL_SOURCE }); assert.equal(downloads, 1);
});

test('local parser failure retains a sealed source and finish retries only local work', TIMEOUT, async t => {
  let downloads = 0, parses = 0;
  const bytes = zip(docxEntries(paragraph('Synthetic source retained in full. '.repeat(2000))));
  const { store } = await fixture(t, { downloader: async options => { downloads++; return source(options, { bytes, extension: 'docx', kind: 'document' }); },
    importDoc: async (...args) => { if (++parses < 3) throw new Error('synthetic local parser failure'); return importDocument(...args); },
  });
  const id = randomUUID(); await store.startImport('alice', { id, url: URL_SOURCE });
  const failed = await settled(store, 'alice', id); assert.equal(failed.status, 'error'); assert.equal(failed.snapshotReady, true);
  await store.startImport('alice', { id, url: URL_SOURCE }); assert.equal(parses, 1);
  await assert.rejects(store.finish('alice', id), /processing failed/);
  const ready = await store.finish('alice', id); assert.equal(ready.status, 'ready'); assert.equal(downloads, 1); assert.equal(parses, 3);
  assert.equal(ready.snapshotId, failed.snapshotId); assert.equal(ready.sourceHash, failed.sourceHash);
  let retained = ''; for (let index = 0; index < ready.partCount; index++) retained += (await store.part('alice', id, index)).text;
  assert.equal((retained.match(/Synthetic source retained in full\./g) || []).length, 2000);
  await store.withSnapshot('alice', id, async snapshot => assert.deepEqual(await fs.readFile(snapshot.file), bytes));
});

test('cache failure after acquisition can be retried locally without changing source identity or lease', TIMEOUT, async t => {
  let downloads = 0, fail = true, releases = 0;
  const { store } = await fixture(t, { downloader: async options => { downloads++; return source(options, { text: 'z'.repeat(45000) }); }, fs: {
    rename: async (from, to) => { if (fail && basename(to) === 'part-1.json') { fail = false; throw new Error('synthetic cache failure'); } return fs.rename(from, to); },
  } });
  const id = randomUUID(); await store.startImport('alice', { id, url: URL_SOURCE }, { acquireJob: () => () => { releases++; } });
  const failed = await settled(store, 'alice', id); assert.equal(failed.status, 'error'); assert.equal(failed.snapshotReady, true);
  const ready = await store.finish('alice', id);
  assert.equal(ready.sourceHash, failed.sourceHash); assert.equal(ready.snapshotId, failed.snapshotId);
  assert.equal(downloads, 1); assert.equal(releases, 1); assert.equal(ready.partCount, 3);
  assert.equal((await store.part('alice', id, 2)).text.length, 5000);
});

for (const stage of ['before initialization', 'after acquisition', 'after parsing']) test(`session invalidation ${stage} aborts without late resurrection and releases its lease once`, TIMEOUT, async t => {
  const entered = deferred(t), resume = deferred(t); let current = stage !== 'before initialization', downloads = 0, parses = 0, releases = 0;
  const { store } = await fixture(t, { downloader: async options => {
    downloads++; if (stage === 'after acquisition') { entered.resolve(); await resume.promise; }
    return source(options, { extension: 'docx', kind: 'document' });
  }, importDoc: async () => { parses++; if (stage === 'after parsing') { entered.resolve(); await resume.promise; } return parsed('late local result'); } });
  const id = randomUUID(); await store.startImport('alice', { id, url: URL_SOURCE }, { acquireJob: () => () => { releases++; }, checkCurrent: async () => current });
  if (stage !== 'before initialization') { await entered.promise; current = false; resume.resolve(); }
  await gone(store, 'alice', id); await until(() => releases === 1);
  assert.equal(downloads, stage === 'before initialization' ? 0 : 1);
  assert.equal(parses, stage === 'after parsing' ? 1 : 0);
  await assert.rejects(store.startImport('alice', { id, url: URL_SOURCE }), statusCode(409));
});

test('microtask cancellation during a session check cannot start a subsequent filesystem operation', TIMEOUT, async t => {
  let store, armed = true, roots = 0, releases = 0;
  ({ store } = await fixture(t, { fs: { mkdtemp: async prefix => { roots++; return fs.mkdtemp(prefix); } }, downloader: () => assert.fail('must not fetch') }));
  const id = randomUUID();
  await store.startImport('alice', { id, url: URL_SOURCE }, { acquireJob: () => () => { releases++; }, checkCurrent: () => {
    if (armed) { armed = false; queueMicrotask(() => { void store.remove('alice', id); }); } return true;
  } });
  await gone(store, 'alice', id); assert.equal(roots, 0); assert.equal(releases, 1);
});

test('clearOwner waits for a downloader ignoring abort, keeps its admission gate and prevents late files', TIMEOUT, async t => {
  const entered = deferred(t), resume = deferred(t); let snapshotDirectory, signal, downloads = 0;
  const { store } = await fixture(t, { downloader: async options => {
    downloads++; snapshotDirectory = options.directory; signal = options.signal; entered.resolve(); await resume.promise;
    // Intentionally ignore cancellation and onProgress, testing the store's drain.
    return source({ ...options, onProgress: undefined });
  } });
  const id = randomUUID(); await store.startImport('alice', { id, url: URL_SOURCE }); await entered.promise;
  let removed = false; const clearing = store.clearOwner('alice').then(() => { removed = true; });
  assert.equal(signal.aborted, true);
  await assert.rejects(store.startImport('alice', { id: randomUUID(), url: URL_SOURCE }), statusCode(409));
  assert.equal(removed, false); assert.ok((await fs.stat(snapshotDirectory)).isDirectory());
  resume.resolve(); await clearing;
  assert.equal(downloads, 1); await assert.rejects(fs.stat(snapshotDirectory), { code: 'ENOENT' });
  assert.deepEqual(store.list('alice'), []);
});

test('cancel-before-create rejects import before acquiring a lease; another owner is unaffected', TIMEOUT, async t => {
  let downloads = 0, leases = 0;
  const { store } = await fixture(t, { downloader: async options => { downloads++; return source(options); } });
  const id = randomUUID(); await store.remove('alice', id);
  await assert.rejects(store.startImport('alice', { id, url: URL_SOURCE }, { acquireJob: () => { leases++; return () => {}; } }), statusCode(409));
  assert.equal(downloads, 0); assert.equal(leases, 0);
  await store.startImport('bob', { id, url: URL_SOURCE }); assert.equal((await settled(store, 'bob', id)).status, 'ready');
});

test('job admission failure leaves no ID or quota binding and release occurs only for an accepted job', TIMEOUT, async t => {
  let downloads = 0, releases = 0;
  const { store } = await fixture(t, { limits: { ownerBytes: 50, instanceBytes: 50, mediaBytes: 50, minFreeBytes: 0 }, downloader: async options => { downloads++; return source(options); } });
  const id = randomUUID();
  await assert.rejects(store.startImport('alice', { id, url: URL_SOURCE }, { acquireJob: () => { throw new AppError('Local jobs busy.', 503); } }), statusCode(503));
  assert.deepEqual(store.list('alice'), []); assert.equal(downloads, 0);
  await store.startImport('alice', { id, url: URL_SOURCE }, { acquireJob: () => () => { releases++; } });
  assert.equal((await settled(store, 'alice', id)).status, 'ready'); await until(() => releases === 1);
  assert.equal(downloads, 1);
});

test('sidecar bytes must fit the atomic reservation; retain completed original without truncating text', TIMEOUT, async t => {
  let directory;
  const { store } = await fixture(t, { limits: { ownerBytes: 10, instanceBytes: 10, mediaBytes: 10, minFreeBytes: 0 }, downloader: async options => {
    directory = options.directory; return source(options, { bytes: Buffer.from('12345'), text: '終終' }); // 5 + 6 > 10.
  } });
  const id = randomUUID(); await store.startImport('alice', { id, url: URL_SOURCE });
  const failed = await settled(store, 'alice', id); assert.equal(failed.status, 'error'); assert.equal(failed.snapshotReady, true);
  assert.match(failed.error, /storage/); await store.retryCleanup();
  assert.equal(await fs.readFile(join(directory, 'source.txt'), 'utf8'), '12345');
  assert.deepEqual(await fs.readdir(directory), ['source.txt']);
  await assert.rejects(store.create('bob', { id: randomUUID(), name: 'capacity.docx', size: 10 }), statusCode(413));
  await store.remove('alice', id);
  await assert.rejects(fs.stat(directory), { code: 'ENOENT' });
  await store.create('bob', { id: randomUUID(), name: 'capacity.docx', size: 10 });
});

const invalidCases = {
  'outside-owned file': async (result, context) => ({ ...result, file: context.outside, size: 7 }),
  'relative file': async result => ({ ...result, file: 'source.txt' }),
  'directory instead of regular file': async (result, context) => { const file = join(context.owned, 'directory.txt'); await fs.mkdir(file); return { ...result, file }; },
  'hard-linked file': async (result, context) => { await fs.rm(result.file); await fs.link(context.outside, result.file); return { ...result, size: 7 }; },
  'incorrect declared byte size': async result => ({ ...result, size: result.size - 1 }),
  'zero bytes': async result => ({ ...result, size: 0 }),
  'kind-extension mismatch': async result => ({ ...result, kind: 'media' }),
  'unsupported extension': async result => ({ ...result, extension: 'exe' }),
  'path-like name': async result => ({ ...result, name: '../secret.txt' }),
  'oversized text': async result => ({ ...result, text: 'x'.repeat(2_000_001) }),
  'missing text': async result => ({ ...result, text: undefined }),
  'unpaired UTF-16 that would be corrupted in the sidecar': async result => ({ ...result, text: '\uD800' }),
  'invalid provenance URL': async result => ({ ...result, provenance: { ...result.provenance, citationUrl: 'file:///private/path' } }),
  'invalid provenance timestamp': async result => ({ ...result, provenance: { ...result.provenance, importedAt: 'not a date' } }),
  'auxiliary non-regular entry': async (result, context) => { await fs.mkdir(join(context.owned, 'helper-directory')); return result; },
};
for (const [name, mutate] of Object.entries(invalidCases)) test(`trusted downloader result validation rejects ${name}`, TIMEOUT, async t => {
  const external = await fs.mkdtemp(join(tmpdir(), 'learnlens-url-outside-')), outside = join(external, 'untouched.txt');
  await fs.writeFile(outside, 'outside'); t.after(() => fs.rm(external, { recursive: true, force: true }));
  let owned, downloads = 0;
  const { store } = await fixture(t, { downloader: async options => { downloads++; owned = options.directory; return mutate(await source(options), { outside, owned }); } });
  const id = randomUUID(); await store.startImport('alice', { id, url: URL_SOURCE });
  const failed = await settled(store, 'alice', id); assert.equal(failed.status, 'error'); assert.equal(failed.snapshotReady, false);
  await store.retryCleanup(); await assert.rejects(fs.stat(owned), { code: 'ENOENT' });
  assert.equal(await fs.readFile(outside, 'utf8'), 'outside');
  await store.startImport('alice', { id, url: URL_SOURCE }); assert.equal(downloads, 1);
});

for (const name of ['symlink', 'realpath escape']) test(`filesystem validation rejects a ${name} without following it`, TIMEOUT, async t => {
  const { store } = await fixture(t, { downloader: options => source(options), fs: name === 'symlink' ? {
    lstat: async path => { const stat = await fs.lstat(path); if (basename(path) === 'source.txt') stat.isSymbolicLink = () => true; return stat; },
  } : { realpath: async path => basename(path) === 'source.txt' ? join(tmpdir(), 'not-owned', 'source.txt') : fs.realpath(path) } });
  const id = randomUUID(); await store.startImport('alice', { id, url: URL_SOURCE });
  assert.equal((await settled(store, 'alice', id)).snapshotReady, false); await store.retryCleanup();
});

for (const extension of ['txt', 'md', 'html', 'docx', 'pptx', 'pdf', 'mp3', 'mp4', 'webm', 'wav', 'ogg']) test(`snapshot dispatch supports ${extension} without remote reads during preparation`, TIMEOUT, async t => {
  let downloads = 0, samples = 0;
  const kind = ['txt', 'md', 'html'].includes(extension) ? 'text' : ['pdf', 'docx', 'pptx'].includes(extension) ? 'document' : 'media';
  const hasVideo = ['mp4', 'webm'].includes(extension);
  const { store } = await fixture(t, { downloader: async options => { downloads++; return source(options, { extension, kind }); },
    importDoc: async () => ({ ...parsed('synthetic document'), pages: 4 }),
    mediaLoader: async () => ({ inspectMedia: async () => ({ duration: 65, hasAudio: true, hasVideo, partCount: 1 }), prepareMediaPart: async () => { samples++; return { ...parsed('sampled media'), start: 0, end: 65 }; } }),
  });
  const id = randomUUID(); await store.startImport('alice', { id, url: URL_SOURCE });
  const ready = await settled(store, 'alice', id); assert.equal(ready.status, 'ready'); assert.equal(ready.kind, kind);
  const part = await store.part('alice', id, 0);
  if (hasVideo) {
    assert.equal(ready.analysisMode, 'whole-video'); assert.equal(ready.partCount, 3);
    assert.deepEqual(part.videoRef, { materialId: id, snapshotId: ready.snapshotId, index: 0 });
    assert.equal(part.start, 0); assert.equal(part.end, 30); assert.equal(part.text, ''); assert.deepEqual(part.images, []);
    assert.equal('video' in part, false); assert.equal(samples, 0);
    await store.withSnapshot('alice', id, snapshot => { assert.equal(snapshot.info.partCount, 1); assert.equal(snapshot.videoPlan.partCount, 3); });
  } else assert.equal(ready.analysisMode, 'sampled-stills');
  await store.finish('alice', id); await store.startImport('alice', { id, url: URL_SOURCE }); assert.equal(downloads, 1);
});

for (const mode of ['audio', 'video', 'youtube']) test(`${mode} cannot silently substitute the wrong audiovisual track set`, TIMEOUT, async t => {
  let downloads = 0;
  const { store } = await fixture(t, { downloader: async options => {
    downloads++; return source(options, { extension: 'mp4', kind: 'media', extra: mode === 'youtube' ? { provenance: { ...provenance('youtube'), citationUrl: 'https://www.youtube.com/watch?v=abcdefghijk&signature=private#fragment' } } : {} });
  }, mediaLoader: async () => ({ inspectMedia: async () => ({ duration: 60, partCount: 1, hasAudio: true, hasVideo: mode === 'audio' }) }) });
  const id = randomUUID(); await store.startImport('alice', { id, url: URL_SOURCE, mode: mode === 'youtube' ? 'auto' : mode });
  const failed = await settled(store, 'alice', id); assert.equal(failed.status, 'error'); assert.equal(failed.snapshotReady, true);
  assert.match(failed.error, /No audio-only substitution/);
  if (mode === 'youtube') assert.equal(failed.provenance.citationUrl, 'https://www.youtube.com/watch?v=abcdefghijk');
  await assert.rejects(store.finish('alice', id), /No audio-only substitution/); assert.equal(downloads, 1);
});

test('withSnapshot registration pins URL originals across deletion and never exposes a raw fetch URL', TIMEOUT, async t => {
  const entered = deferred(t), resume = deferred(t); let borrowed;
  const { store } = await fixture(t, { downloader: options => source(options) });
  const id = randomUUID(); await store.startImport('alice', { id, url: URL_SOURCE }); await settled(store, 'alice', id);
  const work = store.withSnapshot('alice', id, async snapshot => { borrowed = snapshot; entered.resolve(); await resume.promise; return fs.readFile(snapshot.file); });
  const rejected = assert.rejects(work, statusCode(409)); await entered.promise;
  const removal = store.remove('alice', id);
  assert.equal(borrowed.signal.aborted, true); assert.equal('url' in borrowed, false);
  assert.equal(await fs.readFile(borrowed.file, 'utf8'), 'raw original');
  resume.resolve(); await Promise.all([rejected, removal]); await assert.rejects(fs.stat(borrowed.directory), { code: 'ENOENT' });
});

test('request bodies cannot inject downloader, filesystem, byte caps or callback capabilities', TIMEOUT, async t => {
  let calls = 0;
  const { store } = await fixture(t, { downloader: async options => { calls++; assert.ok(options.maxBytes <= 1024 ** 3); return source(options); } });
  const id = randomUUID();
  await store.startImport('alice', { id, url: URL_SOURCE, downloader: () => assert.fail('body capability'), checkCurrent: () => false, maxBytes: Infinity, directory: 'C:/not-used', fs: {} });
  assert.equal((await settled(store, 'alice', id)).status, 'ready'); assert.equal(calls, 1);
  for (const url of ['http://example.com/source', 'https://user:pass@example.com/source', 'https://127.0.0.1/source']) await assert.rejects(store.startImport('alice', { id: randomUUID(), url }), statusCode(400));
  await assert.rejects(store.startImport('alice', { id: randomUUID(), url: URL_SOURCE, mode: 'anything' }), /Invalid URL source mode/);
  assert.equal(calls, 1);
});

test('actual URL adapter handoff retains and accounts HTML plus selected video without any network', TIMEOUT, async t => {
  const html = Buffer.from('<html><title>Synthetic page</title><body><p>Local native video fixture</p><video src="/lesson.mp4"></video></body></html>');
  const video = Buffer.from('000000186674797069736f6d0000020069736f6d6d703432', 'hex');
  let requests = 0;
  const downloader = createUrlSourceDownloader({
    extractWeb: async (bytes, options) => parseWebHtml(bytes, options),
    transport: { downloadSourceFile: async (url, file, options) => {
      const index = requests++, bytes = index === 0 ? html : video;
      assert.ok(index < 2); const contentType = index === 0 ? 'text/html' : 'video/mp4';
      assert.ok(bytes.length <= options.maxBytes);
      assert.ok(bytes.length <= options.limitForHeaders({ contentType }));
      await fs.writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
      options.onProgress?.({ receivedBytes: bytes.length, totalBytes: bytes.length });
      return { url, contentType, size: bytes.length };
    } },
  });
  const capacity = html.length + video.length + 5;
  const { store } = await fixture(t, { downloader, limits: { ownerBytes: capacity, instanceBytes: capacity, minFreeBytes: 0 },
    mediaLoader: async () => ({ inspectMedia: async () => ({ duration: 40, hasVideo: true, hasAudio: true, partCount: 1 }), prepareMediaPart: () => assert.fail('Whole-video must not prepare samples') }),
  });
  const id = randomUUID(); await store.startImport('alice', { id, url: URL_SOURCE, mode: 'video' });
  const ready = await settled(store, 'alice', id); assert.equal(ready.status, 'ready'); assert.equal(ready.analysisMode, 'whole-video');
  assert.equal(ready.size, video.length); assert.equal(ready.sourceHash, createHash('sha256').update(video).digest('hex'));
  await store.withSnapshot('alice', id, async snapshot => {
    assert.deepEqual((await fs.readdir(snapshot.directory)).sort(), ['source.html', 'source.mp4']);
    assert.deepEqual(await fs.readFile(join(snapshot.directory, 'source.html')), html);
    assert.deepEqual(await fs.readFile(snapshot.file), video);
  });
  await store.create('alice', { id: randomUUID(), name: 'exact-remaining.docx', size: 5 });
  await assert.rejects(store.create('alice', { id: randomUUID(), name: 'over.docx', size: 1 }), statusCode(413));
  await store.part('alice', id, 1); await store.finish('alice', id); assert.equal(requests, 2);
});

test('retained auxiliary file bytes cannot overflow the reserved ceiling', TIMEOUT, async t => {
  const { store } = await fixture(t, { limits: { ownerBytes: 40, instanceBytes: 40, mediaBytes: 40, minFreeBytes: 0 }, downloader: async options => {
    const result = await source(options, { bytes: Buffer.from('raw'), text: 'x' });
    await fs.writeFile(join(options.directory, 'retained-original.html'), Buffer.alloc(40)); return result;
  } });
  const id = randomUUID(); await store.startImport('alice', { id, url: URL_SOURCE });
  const failed = await settled(store, 'alice', id); assert.equal(failed.snapshotReady, false); assert.match(failed.error, /storage/);
  await store.retryCleanup();
  await store.create('bob', { id: randomUUID(), name: 'fully-released.docx', size: 40 });
});

test('list keeps unresolved, preparing, failed and deleting whole-video sources visible to the receipt gate', TIMEOUT, async t => {
  const downloading = deferred(t), download = deferred(t), inspecting = deferred(t), inspect = deferred(t), cleaning = deferred(t), clean = deferred(t);
  let inspections = 0;
  const { store } = await fixture(t, { downloader: async options => { downloading.resolve(); await download.promise; return source(options, { kind: 'media', extension: 'mp4' }); },
    mediaLoader: async () => ({ inspectMedia: async () => {
      if (++inspections === 1) { inspecting.resolve(); await inspect.promise; throw new Error('synthetic local inspection failure'); }
      return { duration: 60, partCount: 1, hasAudio: true, hasVideo: true };
    } }), cleanup: async path => { cleaning.resolve(); await clean.promise; await fs.rm(path, { recursive: true, force: true }); },
  });
  const id = randomUUID(), accepted = await store.startImport('alice', { id, url: URL_SOURCE }); await downloading.promise;
  const current = () => {
    const listed = store.list('alice'); assert.equal(listed.length, 1);
    const item = listed[0]; assert.equal(item.id, id); assert.equal(item.snapshotId, accepted.snapshotId); assert.equal(item.analysisMode, 'whole-video');
    assert.equal('directory' in item, false); assert.equal('file' in item, false); return item;
  };
  assert.equal(current().status, 'fetching'); assert.equal(current().hasVideo, undefined); assert.equal(current().snapshotReady, false);
  download.resolve(); await inspecting.promise;
  assert.equal(current().status, 'preparing'); assert.equal(current().hasVideo, undefined); assert.equal(current().snapshotReady, true);
  inspect.resolve(); assert.equal((await settled(store, 'alice', id)).status, 'error'); assert.equal(current().status, 'error');
  await store.finish('alice', id); assert.equal(current().status, 'ready'); assert.equal(current().hasVideo, true);
  const removal = store.remove('alice', id); await cleaning.promise;
  assert.equal(current().status, 'deleting'); clean.resolve(); await removal; assert.deepEqual(store.list('alice'), []);
});
