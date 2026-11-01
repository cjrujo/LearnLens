import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createMaterialStore } from '../lib/material-store.mjs';
import { createUrlSourceDownloader, createUrlTextExtractor } from '../lib/url-source.mjs';
import { extractWebText, WebExtractError } from '../lib/web-extract.mjs';

test('real deferred adapter and isolated HTML worker recover locally using the same saved snapshot', async t => {
  const root = await fs.mkdtemp(join(tmpdir(), 'learnlens-deferred-integration-'));
  const original = Buffer.from('<html><head><title>Biology</title></head><body><p>anti<b>body</b> and <span>中</span><span>文</span></p><pre>def f():\n    return 1\nx = 2</pre></body></html>');
  let downloads = 0, parses = 0, savedFile, acquisitionError;
  const downloader = createUrlSourceDownloader({ transport: { async downloadSourceFile(url, file) {
    downloads++; await fs.writeFile(file, original, { flag: 'wx' });
    return { url, size: original.length, contentType: 'text/html' };
  } }, extractWeb() { throw Error('Acquisition must not parse final HTML'); } });
  const extractor = createUrlTextExtractor({ async extractWeb(...args) {
    if (++parses === 1) throw new WebExtractError('worker');
    return extractWebText(...args);
  } });
  const store = createMaterialStore({ directory: root, limits: { minFreeBytes: 0 }, downloader: async options => { try { return await downloader(options); } catch (error) { acquisitionError = error.message; throw error; } },
    sourceTextExtractor: options => { savedFile = options.file; return extractor(options); } });
  t.after(async () => { await store.close(); await fs.rm(root, { recursive: true, force: true }); });
  const id = randomUUID(); await store.startImport('owner', { id, url: 'https://example.com/lesson?token=PRIVATE', mode: 'webpage' });
  const deadline = Date.now() + 5000;
  while (!['error', 'ready'].includes(store.status('owner', id).status) && Date.now() < deadline) await delay(2);
  const failed = store.status('owner', id); assert.equal(failed.status, 'error'); assert.equal(failed.snapshotReady, true, JSON.stringify({ error: failed.error, acquisitionError, downloads, parses }));
  assert.deepEqual(await fs.readFile(savedFile), original);
  const ready = await store.finish('owner', id); assert.equal(ready.snapshotId, failed.snapshotId); assert.equal(ready.sourceHash, failed.sourceHash);
  assert.equal(ready.provenance.title, 'Biology'); assert.equal(ready.provenance.citationUrl, 'https://example.com/lesson');
  assert.equal((await store.part('owner', id, 0)).text, 'antibody and 中文\ndef f():\n    return 1\nx = 2');
  assert.equal(downloads, 1); assert.equal(parses, 2); assert.deepEqual(await fs.readFile(savedFile), original);
  assert.ok(!JSON.stringify(ready).includes('PRIVATE'));
});
