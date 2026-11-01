import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setImmediate as tick, setTimeout as delay } from 'node:timers/promises';
import { createMaterialStore } from '../lib/material-store.mjs';

const TIMEOUT = { timeout: 10000 };
const locked = () => Object.assign(new Error('synthetic staging failure'), { code: 'EPERM' });
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function fixture(t) {
  const directory = await fs.mkdtemp(join(tmpdir(), 'learnlens-cache-cleanup-'));
  const faults = { publish: false, write: false, unlink: false, orphan: false, barrier: null, writes: [], removals: 0 };
  const store = createMaterialStore({ directory, limits: { ownerBytes: 8, instanceBytes: 8, minFreeBytes: 0 },
    importDoc: async (_, __, { options }) => ({ text: `Synthetic page ${options.startPage}`, pages: 12, warnings: [],
      images: [{ name: 'synthetic.jpg', dataUrl: 'data:image/jpeg;base64,' + 'a'.repeat(256 * 1024) }] }),
    fs: {
      writeFile: async (path, bytes, options) => {
        if (path.endsWith('.tmp')) {
          faults.writes.push(path);
          if (faults.write) { await fs.writeFile(path, '{', options); faults.orphan = true; throw locked(); }
        }
        return fs.writeFile(path, bytes, options);
      },
      rename: async (from, to) => { if (faults.publish) { faults.orphan = true; throw locked(); } return fs.rename(from, to); },
      rm: async (path, options) => {
        if (path.endsWith('.tmp') && faults.orphan) {
          faults.removals++;
          if (faults.unlink) throw locked();
          if (faults.barrier) { faults.barrier.entered.resolve(); await faults.barrier.resume.promise; }
        }
        return fs.rm(path, options);
      },
    },
  });
  t.after(async () => {
    faults.publish = faults.write = faults.unlink = false; faults.barrier?.resume.resolve();
    await store.close(); await fs.rm(directory, { recursive: true, force: true });
  });
  const id = randomUUID();
  await store.create('alice', { id, name: 'synthetic.pdf', size: 8 });
  await store.append('alice', id, 0, Buffer.from('original'));
  const initial = await store.finish('alice', id);
  let source, cache;
  await store.withSnapshot('alice', id, snapshot => { source = snapshot.file; cache = join(snapshot.directory, ''); });
  cache = join(cache, (await fs.readdir(cache)).find(name => name.startsWith('parts-')));
  faults.writes.length = 0;
  return { store, faults, id, initial, source, cache };
}
async function abandoned(value, phase = 'publish') {
  value.faults[phase] = true; value.faults.unlink = true;
  await assert.rejects(value.store.part('alice', value.id, 1), /processing failed/);
}

for (const phase of ['publish', 'write']) test(`failed cache ${phase} cleanup uses at most one reusable staging file and retries independently`, TIMEOUT, async t => {
  const value = await fixture(t), { store, faults, id, initial, source, cache } = value;
  await abandoned(value, phase);
  for (const index of [1, 2, 3, 1]) await assert.rejects(store.part('alice', id, index), /processing failed/);
  const files = await fs.readdir(cache);
  assert.equal(files.filter(name => name.endsWith('.tmp')).length, 1, 'Repeated failures must not accumulate staging files');
  assert.equal(faults.writes.length, 1, 'Blocked staging cleanup must prevent another write, not merely reuse a filename');
  assert.equal(store.status('alice', id).cleanupPending, true);
  assert.deepEqual(await store.retryCleanup(), { pending: 1, failed: 1 });
  assert.equal(await fs.readFile(source, 'utf8'), 'original');
  assert.equal((await store.part('alice', id, 0)).text, 'Synthetic page 1');
  await assert.rejects(store.create('bob', { id: randomUUID(), name: 'blocked.docx', size: 1 }), error => error.status === 413);
  faults.publish = faults.write = faults.unlink = false;
  assert.deepEqual(await store.retryCleanup(), { pending: 0, failed: 0 });
  assert.deepEqual(await fs.readdir(cache), ['part-0.json']);
  const status = store.status('alice', id);
  assert.equal(status.snapshotId, initial.snapshotId); assert.equal(status.sourceHash, initial.sourceHash);
  assert.equal(status.snapshotReady, true); assert.equal(status.cleanupPending, undefined);
  assert.equal(await fs.readFile(source, 'utf8'), 'original');
  await assert.rejects(store.create('bob', { id: randomUUID(), name: 'still-reserved.docx', size: 1 }), error => error.status === 413);
  await store.part('alice', id, 1); await store.part('alice', id, 2);
  assert.equal(new Set(faults.writes).size, 1, 'All part indexes share the same serialized staging slot');
  assert.deepEqual((await fs.readdir(cache)).sort(), ['part-0.json', 'part-2.json']);
});

test('independent staging cleanup coalesces and serializes with queued cache readers and writers', TIMEOUT, async t => {
  const value = await fixture(t), { store, faults, id, cache } = value;
  await abandoned(value);
  faults.publish = faults.unlink = false;
  const barrier = faults.barrier = { entered: deferred(), resume: deferred() };
  const before = faults.removals, retry = store.retryCleanup();
  await barrier.entered.promise;
  const second = store.retryCleanup();
  const preview = store.part('alice', id, 0), next = store.part('alice', id, 2);
  await tick(); assert.equal(faults.removals, before + 1);
  assert.equal(faults.writes.length, 1);
  barrier.resume.resolve();
  assert.deepEqual(await retry, { pending: 0, failed: 0 });
  assert.deepEqual(await second, { pending: 0, failed: 0 });
  assert.equal((await preview).text, 'Synthetic page 1'); assert.equal((await next).text, 'Synthetic page 7');
  assert.deepEqual((await fs.readdir(cache)).sort(), ['part-0.json', 'part-2.json']);
});

for (const operation of ['remove', 'clearOwner', 'close']) test(`${operation} waits for registered staging cleanup before erasing the source or releasing quota`, TIMEOUT, async t => {
  const value = await fixture(t), { store, faults, id, source } = value;
  await abandoned(value); faults.publish = faults.unlink = false;
  const barrier = faults.barrier = { entered: deferred(), resume: deferred() };
  const retry = store.retryCleanup(); await barrier.entered.promise;
  let done = false;
  const removal = (operation === 'remove' ? store.remove('alice', id) : operation === 'clearOwner' ? store.clearOwner('alice') : store.close()).then(() => { done = true; });
  await tick(); assert.equal(done, false); assert.equal(await fs.readFile(source, 'utf8'), 'original');
  await assert.rejects(store.create('bob', { id: randomUUID(), name: 'blocked.docx', size: 1 }), error => error.status === (operation === 'close' ? 503 : 413));
  barrier.resume.resolve(); await Promise.all([retry, removal]);
  await assert.rejects(fs.stat(source), { code: 'ENOENT' });
  assert.deepEqual(await store.retryCleanup(), { pending: 0, failed: 0 });
  if (operation !== 'close') await store.create('bob', { id: randomUUID(), name: 'capacity.docx', size: 8 });
});

test('failed URL finish repairs only the staging slot, retaining snapshot identity and never fetching again', TIMEOUT, async t => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'learnlens-url-cache-cleanup-'));
  let fail = true, abandoned = false, downloads = 0, source;
  const store = createMaterialStore({ directory, limits: { ownerBytes: 8, instanceBytes: 8, minFreeBytes: 0 },
    downloader: async options => {
      downloads++; source = join(options.directory, 'source.docx'); await fs.writeFile(source, 'original', { flag: 'wx' });
      return { file: source, name: 'source.docx', extension: 'docx', kind: 'document', size: 8, warnings: [],
        provenance: { type: 'direct-document', citationUrl: 'https://example.com/synthetic', importedAt: '2026-10-31T00:00:00.000Z' } };
    },
    importDoc: async () => ({ text: 'x'.repeat(45000), images: [], warnings: [] }),
    fs: {
      rename: async (from, to) => { if (fail && basename(to) === 'part-1.json') { abandoned = true; throw locked(); } return fs.rename(from, to); },
      rm: async (path, options) => { if (fail && abandoned && path.endsWith('.tmp')) throw locked(); return fs.rm(path, options); },
    },
  });
  t.after(async () => { fail = false; await store.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const id = randomUUID(), body = { id, url: 'https://example.com/synthetic' };
  await store.startImport('alice', body);
  const deadline = Date.now() + 5000;
  while (store.status('alice', id).status !== 'error' && Date.now() < deadline) await delay(2);
  const failed = store.status('alice', id);
  assert.equal(failed.status, 'error'); assert.equal(failed.snapshotReady, true);
  for (let i = 0; i < 3; i++) await assert.rejects(store.finish('alice', id), /processing failed/);
  await store.startImport('alice', body); assert.equal(downloads, 1);
  assert.deepEqual(await store.retryCleanup(), { pending: 1, failed: 1 });
  assert.equal(await fs.readFile(source, 'utf8'), 'original');
  fail = false; assert.deepEqual(await store.retryCleanup(), { pending: 0, failed: 0 });
  const ready = await store.finish('alice', id);
  assert.equal(ready.snapshotId, failed.snapshotId); assert.equal(ready.sourceHash, failed.sourceHash);
  assert.equal(ready.partCount, 3); assert.equal(downloads, 1);
  let fullText = ''; for (let i = 0; i < 3; i++) fullText += (await store.part('alice', id, i)).text;
  assert.equal(fullText.length, 45000); assert.equal(await fs.readFile(source, 'utf8'), 'original');
  await assert.rejects(store.create('bob', { id: randomUUID(), name: 'blocked.docx', size: 1 }), error => error.status === 413);
});

test('queued staging cleanup is registered before its first await and immediate deletion cannot deadlock', TIMEOUT, async t => {
  const value = await fixture(t), { store, faults, id, source } = value;
  await abandoned(value); faults.publish = faults.unlink = false;
  const retry = store.retryCleanup(), removal = store.remove('alice', id);
  await Promise.all([retry, removal]);
  await assert.rejects(fs.stat(source), { code: 'ENOENT' });
  assert.deepEqual(await store.retryCleanup(), { pending: 0, failed: 0 });
});
