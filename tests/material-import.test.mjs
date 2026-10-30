import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMaterialStore, splitMaterialText, UPLOAD_CHUNK_BYTES } from '../lib/material-store.mjs';
import { documentEnvironment, importDocument } from '../lib/document-import.mjs';
import { digestInput, parseDigest } from '../lib/material-digest.mjs';
import { pdf, zip, docxEntries, paragraph } from './document-fixtures.mjs';
import { startApp, configured, browserClient } from './helpers.mjs';

test('automatic text chunks retain all text and Unicode, with no 35k truncation', () => {
  const text = ('A paragraph about science.\n😀終\n').repeat(4000);
  const chunks = splitMaterialText(text);
  assert.ok(chunks.length > 3); assert.equal(chunks.join(''), text);
  for (const chunk of chunks) { assert.ok(chunk.length <= 20000); assert.ok(!/[\uD800-\uDBFF]$/.test(chunk)); }
});
test('parser worker does not inherit credentials or runtime injection settings', () => {
  const env = documentEnvironment({ PATH: 'test', SYSTEMROOT: 'test', NODE_OPTIONS: '--require secret', OPENAI_API_KEY: 'secret', LEARNLENS_ACCESS_PASSWORD: 'secret' });
  assert.deepEqual(env, { PATH: 'test', SYSTEMROOT: 'test' });
});
test('real isolated PDF worker returns requested pages beyond first three', async () => {
  const result = await importDocument(pdf({ pages: 7 }), 'pdf', { options: { startPage: 4, pageCount: 3 } });
  assert.equal(result.startPage, 4); assert.equal(result.nextPage, 7);
  assert.match(result.text, /Page 4/); assert.ok(!result.text.includes('[Page 1]'));
  assert.equal(result.images.length, 3);
});
test('worker pre-abort and deadline fail safely', async () => {
  const signal = AbortSignal.abort();
  await assert.rejects(importDocument(pdf(), 'pdf', { signal }), /cancelled/);
  await assert.rejects(importDocument(pdf(), 'pdf', { timeoutMs: 1 }), /deadline/);
});
test('resumable chunks are idempotent, isolated and private temp data is removed', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'learnlens-store-test-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const store = createMaterialStore({ directory: dir, importDoc: async () => ({ text: 'x'.repeat(65000), images: [], warnings: [] }) }); t.after(() => store.close());
  const id = randomUUID(), data = Buffer.from('source');
  await store.create('alice', { id, name: 'notes.docx', size: data.length });
  assert.throws(() => store.status('bob', id), /not found/);
  await assert.rejects(store.create('bob', { id, name: 'notes.docx', size: data.length }), /not found/);
  await store.append('alice', id, 0, data);
  assert.equal((await store.append('alice', id, 0, data)).received, data.length);
  await assert.rejects(store.append('alice', id, 0, Buffer.from('change')), /position/);
  const ready = await store.finish('alice', id); assert.equal(ready.partCount, 4);
  let complete = ''; for (let i = 0; i < ready.partCount; i++) complete += (await store.part('alice', id, i)).text;
  assert.equal(complete.length, 65000);
  await store.clearOwner('alice'); assert.throws(() => store.status('alice', id), /not found/);
  await store.close(); assert.deepEqual(await readdir(dir), []);
});
test('removing a material cancels active local preparation', async t => {
  let started;
  const begin = new Promise(resolve => { started = resolve; });
  const store = createMaterialStore({ importDoc: async (_, __, { signal }) => { started(); return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true })); } });
  t.after(() => store.close()); const id = randomUUID();
  await store.create('alice', { id, name: 'notes.docx', size: 1 }); await store.append('alice', id, 0, Buffer.from('x'));
  const preparation = store.finish('alice', id); const rejected = assert.rejects(preparation, /processing failed/);
  await begin; await store.clearOwner('alice'); await rejected;
});
test('binary upload API enforces CSRF, automatic multipart text, session isolation and logout cleanup', async t => {
  const app = await startApp(t), client = await app.client(), other = await browserClient(app.url);
  const body = zip(docxEntries(paragraph('Study text. '.repeat(6000)))); const id = randomUUID();
  const created = await client.request('/api/materials', { method: 'POST', json: { id, name: 'long.docx', size: body.length } }); assert.equal(created.status, 201);
  let offset = 0;
  while (offset < body.length) {
    const raw = body.subarray(offset, offset + UPLOAD_CHUNK_BYTES);
    const response = await client.request(`/api/materials/${id}/content?offset=${offset}`, { method: 'PUT', raw, headers: { 'content-type': 'application/octet-stream' } }); assert.equal(response.status, 200); offset = response.json.received;
  }
  assert.equal((await client.request(`/api/materials/${id}/finish`, { method: 'POST', json: {}, token: 'wrong' })).status, 403);
  const finished = await client.request(`/api/materials/${id}/finish`, { method: 'POST', json: {}, timeout: 30000 }); assert.equal(finished.status, 200, finished.text); assert.ok(finished.json.partCount >= 4);
  assert.equal((await other.request(`/api/materials/${id}`)).status, 404);
  const part = await client.request(`/api/materials/${id}/parts`, { method: 'POST', json: { index: 3 } }); assert.equal(part.status, 200); assert.match(part.json.source, /long.docx/); assert.ok(part.json.text.length > 0);
  const state = await client.request('/api/state'); assert.equal(state.json.providers.length, 0, 'Import must not need or call a provider');
  await client.request('/api/logout', { method: 'POST', json: {} }); assert.equal((await client.request(`/api/materials/${id}`)).status, 404);
});
test('digest preparation requires explicit consent and safely validates provider output', async t => {
  assert.throws(() => digestInput({ text: 'notes' }), /consent/);
  assert.deepEqual(parseDigest('{"notes":"Safe notes","warnings":[]}'), { text: 'Safe notes', warnings: [] });
  assert.throws(() => parseDigest('{"notes":"' + 'x'.repeat(2201) + '","warnings":[]}'), /valid preparation/);
  const { client, mock } = await configured(t, { mock: { outputText: '{"notes":"Prepared source notes","warnings":[]}' } });
  const response = await client.request('/api/materials/summarize', { method: 'POST', json: { text: 'source', images: [] } });
  assert.equal(response.status, 400); assert.equal(mock.calls.length, 0);
  const state = await client.request('/api/state');
  const changed = await client.request('/api/materials/summarize', { method: 'POST', json: { text: 'source', consent: true, expectedSetupRevision: state.json.setupRevision - 1 } });
  assert.equal(changed.status, 409); assert.equal(mock.calls.length, 0, 'Stale destination consent must not call a provider');
  const result = await client.request('/api/materials/summarize', { method: 'POST', json: { text: 'source', consent: true, expectedSetupRevision: state.json.setupRevision } });
  assert.equal(result.status, 200); assert.equal(result.json.text, 'Prepared source notes'); assert.equal(mock.calls.length, 1);
});
