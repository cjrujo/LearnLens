import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createMaterialStore } from '../lib/material-store.mjs';

const original = Buffer.from('<pre>def f():\n    return 1</pre>');
async function until(run) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { const result = await run(); if (result) return result; await delay(2); }
  assert.fail('Local background operation did not settle');
}
async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(join(tmpdir(), 'learnlens-url-text-test-'));
  let acquisitions = 0, originalPath;
  const store = createMaterialStore({ directory, ...options, downloader: async input => {
    acquisitions++; assert.equal(input.deferTextExtraction, true);
    originalPath = join(input.directory, 'source.html');
    await fs.writeFile(originalPath, original, { flag: 'wx', mode: 0o600 });
    return { file: originalPath, extension: 'html', kind: 'text', name: 'source.html', size: original.length, textPending: true,
      provenance: { type: 'webpage', citationUrl: 'https://example.com/lesson', importedAt: new Date().toISOString() }, warnings: [] };
  } });
  t.after(async () => { await store.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const id = randomUUID();
  await store.startImport('owner', { id, url: 'https://example.com/lesson?private=token', mode: 'webpage' });
  const settled = () => until(() => { const value = store.status('owner', id); return ['ready', 'error'].includes(value.status) && value; });
  return { store, id, settled, acquisitions: () => acquisitions, originalPath: () => originalPath };
}

test('completed HTML acquisition survives parser failure; finish retries local extraction only', async t => {
  let parsed = 0;
  const f = await fixture(t, { sourceTextExtractor: async ({ file, extension, size }) => {
    parsed++; assert.equal(extension, 'html'); assert.equal(size, original.length); assert.deepEqual(await fs.readFile(file), original);
    if (parsed === 1) throw new Error('Synthetic local worker stopped');
    return { text: 'def f():\n    return 1', title: 'Example', warnings: ['Static text only.'] };
  } });
  const failed = await f.settled(); assert.equal(failed.status, 'error'); assert.equal(failed.snapshotReady, true);
  assert.match(failed.sourceHash, /^[a-f0-9]{64}$/); assert.deepEqual(await fs.readFile(f.originalPath()), original);
  const repeated = await f.store.startImport('owner', { id: f.id, url: 'https://example.com/lesson?private=token', mode: 'webpage' });
  assert.equal(repeated.status, 'error'); assert.equal(parsed, 1); assert.equal(f.acquisitions(), 1);
  const ready = await f.store.finish('owner', f.id);
  assert.equal(ready.status, 'ready'); assert.equal(ready.snapshotId, failed.snapshotId); assert.equal(ready.sourceHash, failed.sourceHash);
  assert.equal((await f.store.part('owner', f.id, 0)).text, 'def f():\n    return 1');
  assert.equal(ready.provenance.title, 'Example'); assert.equal(parsed, 2); assert.equal(f.acquisitions(), 1);
});

test('sidecar publication failures retain original and bounded accepted local text without reparsing', async t => {
  let parsed = 0, deny = true;
  const f = await fixture(t, { sourceTextExtractor: async () => { parsed++; return { text: 'Complete text / 中文\n  indented' }; },
    fs: { rename: async (from, to) => { if (deny && basename(to).startsWith('text-')) throw Object.assign(new Error('Synthetic rename error'), { code: 'EPERM' }); return fs.rename(from, to); } } });
  const failed = await f.settled(); assert.equal(failed.status, 'error'); assert.equal(failed.snapshotReady, true);
  for (let n = 0; n < 3; n++) await assert.rejects(f.store.finish('owner', f.id));
  const path = f.originalPath(); assert.deepEqual(await fs.readFile(path), original);
  const files = await fs.readdir(join(path, '..'), { recursive: true });
  assert.equal(files.filter(file => file.endsWith('.tmp')).length, 0); assert.equal(parsed, 1);
  deny = false;
  assert.equal((await f.store.finish('owner', f.id)).status, 'ready');
  assert.equal((await f.store.part('owner', f.id, 0)).text, 'Complete text / 中文\n  indented');
  assert.equal(parsed, 1); assert.equal(f.acquisitions(), 1);
});

test('text quota failure retains sealed original and can recover locally after capacity is available', async t => {
  let large = true, parsed = 0;
  const f = await fixture(t, { limits: { ownerBytes: 512, instanceBytes: 512, mediaBytes: 512, minFreeBytes: 0 },
    sourceTextExtractor: async () => { parsed++; return { text: large ? '文'.repeat(300) : 'Short complete text' }; } });
  const failed = await f.settled(); assert.equal(failed.status, 'error'); assert.equal(failed.snapshotReady, true);
  assert.deepEqual(await fs.readFile(f.originalPath()), original);
  assert.equal((await fs.readdir(join(f.originalPath(), '..'), { recursive: true })).some(name => name.endsWith('.txt')), false);
  large = false;
  const ready = await f.store.finish('owner', f.id); assert.equal(ready.status, 'ready');
  assert.equal((await f.store.part('owner', f.id, 0)).text, 'Short complete text');
  assert.equal(parsed, 2); assert.equal(f.acquisitions(), 1);
});

test('source deletion waits for local text extraction and never publishes its late result', async t => {
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const f = await fixture(t, { sourceTextExtractor: async () => { enter(); await gate; return { text: 'Late local text' }; } });
  await entered; let removed = false;
  const removal = f.store.remove('owner', f.id).then(() => { removed = true; });
  await delay(20); assert.equal(removed, false); assert.deepEqual(await fs.readFile(f.originalPath()), original);
  release(); await removal;
  assert.throws(() => f.store.status('owner', f.id), /not found/); await assert.rejects(fs.stat(f.originalPath()), { code: 'ENOENT' });
  assert.equal(f.acquisitions(), 1);
});
