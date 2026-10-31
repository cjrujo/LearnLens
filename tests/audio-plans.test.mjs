import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAudioPlanStore } from '../lib/audio-plans.mjs';
import { AppError } from '../lib/provider.mjs';
import { parseAudioExtraction, audioExtractionPrompt } from '../lib/audio-extract.mjs';
import { PNG_URL } from './helpers.mjs';

const lesson = { title: 'Read', subject: 'English', level: 'Auto', language: 'English', summary: 'Read well.', objectives: ['Listen.'],
  sections: [{ type: 'explanation', title: 'Words', body: 'Hello world.', items: [], question: '', answer: '', translation: '', source: '' }], audio: [], warnings: [] };
const setup = { speech: { engine: 'kokoro', model: 'kokoro', voice: 'af_heart', api: 'auto' }, setupRevision: 4, speechIdentity: 'fixed-private-identity' };
const source = (key, text) => ({ key, text, source: 'Source fixture', extraction: 'text', coverage: 'complete', warnings: [] });
const make = async (t, options = {}) => { const directory = await mkdtemp(join(tmpdir(), 'learnlens-audio-test-')); const store = createAudioPlanStore({ directory, ...options }); t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }); }); return { store, directory }; };
const create = (store, keys = [], owner = 'owner') => store.create(owner, { id: randomUUID(), lesson, expectedSources: keys }, setup);
// Deliberately fake codec output: these tests cover storage/state, not decodability.
const generate = async text => ({ buffer: Buffer.from(text), mime: 'audio/wav' });
const encode = async raw => Buffer.concat([Buffer.from('ID3fixture:'), raw.buffer]);
const planDirectory = async (directory, id) => { const root = join(directory, (await readdir(directory))[0]); return join(root, (await readdir(root)).find(name => name.startsWith(id + '-'))); };
const run = (store, id, clipId, extras = {}) => store.synthesize('owner', id, clipId, { attemptId: randomUUID(), generate, encode, ...extras });

test('full inventory includes source tails and more than eight clips; every clip is shared and immutable', async t => {
  const { store } = await make(t); const plan = await create(store, ['source:1']);
  await assert.rejects(store.seal('owner', plan.id), /incomplete/);
  const text = Array.from({ length: 15 }, (_, n) => `Sentence ${n} has a keyword${n}.`).join('\n') + '\nFinal original sentence.';
  await store.addSource('owner', plan.id, source('source:1', text));
  const sealed = await store.seal('owner', plan.id); assert.ok(sealed.summary.totalClips > 8);
  let calls = 0;
  for (const clip of sealed.clips) await run(store, plan.id, clip.id, { generate: async value => { calls++; return generate(value); } });
  const first = sealed.clips[0]; await run(store, plan.id, first.id, { generate: () => { throw new Error('Paid replay'); } });
  const result = await store.exportLesson('owner', plan.id);
  assert.equal(result.audioSummary.completedClips, sealed.clips.length); assert.equal(result.audioSummary.status, 'complete'); assert.equal(calls, sealed.clips.length);
  assert.match(result.html, /Final/); assert.match(result.html, /original/); assert.match(result.html, /Source fixture/);
  assert.equal((result.html.match(/src="data:audio\/mpeg;base64,/g) || []).length, sealed.clips.length);
});

test('source identity, ownership and complete source manifest are enforced before seal', async t => {
  const { store } = await make(t); const body = { id: randomUUID(), lesson, expectedSources: ['x', 'y'] };
  const plan = await store.create('owner', body, setup); assert.deepEqual(await store.create('owner', body, setup), plan);
  await assert.rejects(store.create('other', body, setup), error => error.status === 404);
  await store.addSource('owner', plan.id, source('x', 'The original.'));
  const before = store.status('owner', plan.id);
  await store.addSource('owner', plan.id, source('x', 'The original.'));
  assert.deepEqual(store.status('owner', plan.id), before);
  await assert.rejects(store.addSource('owner', plan.id, source('x', 'Different content.')), error => error.status === 409);
  await assert.rejects(store.addSource('owner', plan.id, source('z', 'Unknown.')), error => error.status === 409);
  await assert.rejects(store.seal('owner', plan.id), /incomplete/);
  await store.addSource('owner', plan.id, { ...source('y', ''), extraction: 'unavailable', coverage: 'unavailable' });
  await store.seal('owner', plan.id);
  const exported = await store.exportLesson('owner', plan.id); assert.match(exported.warnings.join(' '), /uncertain or unavailable/);
  assert.equal(exported.audioSummary.sourceUncertainties, 1); assert.notEqual(exported.audioSummary.status, 'complete');
  assert.throws(() => store.status('other', plan.id), error => error.status === 404);
  await assert.rejects(store.exportLesson('other', plan.id), error => error.status === 404);
  await assert.rejects(store.remove('other', plan.id), error => error.status === 404);
});

test('failed and unknown attempts are never replayed automatically; local encoding can reuse paid speech', async t => {
  const { store } = await make(t); const plan = await create(store); const sealed = await store.seal('owner', plan.id), clip = sealed.clips[0];
  const attemptId = randomUUID(); let calls = 0;
  await assert.rejects(run(store, plan.id, clip.id, { attemptId, generate: async () => { calls++; throw new AppError('Speech failed safely.', 502); } }), /Speech failed safely/);
  const replay = await run(store, plan.id, clip.id, { attemptId, generate: async () => { calls++; return generate('unexpected'); } });
  assert.equal(replay.clip.status, 'failed'); assert.equal(calls, 1);
  await assert.rejects(run(store, plan.id, clip.id), /explicit retry/);
  await assert.rejects(run(store, plan.id, clip.id, { retry: true, generate: async text => { calls++; return generate(text); }, encode: async () => { throw new Error('Private disk path must not leak'); } }), /Local audio preparation failed/);
  assert.equal(store.clipStatus('owner', plan.id, clip.id).clip.status, 'encoding_failed'); assert.equal(calls, 2);
  await assert.rejects(run(store, plan.id, sealed.clips[1].id), /Finish encoding/);
  const finished = await run(store, plan.id, clip.id, { retry: true, generate: () => { throw new Error('Must reuse raw speech'); } });
  assert.equal(finished.clip.status, 'complete'); assert.equal(calls, 2);
});

test('in-flight status is read-only, reservations precede work, and logout prevents late resurrection', async t => {
  const { store, directory } = await make(t); const plan = await create(store); const sealed = await store.seal('owner', plan.id);
  let resolveSpeech, dispatched;
  const started = new Promise(resolve => { dispatched = resolve; });
  const pending = run(store, plan.id, sealed.clips[0].id, { generate: () => { dispatched(); return new Promise(resolve => { resolveSpeech = resolve; }); } });
  await started;
  assert.equal(store.clipStatus('owner', plan.id, sealed.clips[0].id).clip.status, 'processing');
  await assert.rejects(run(store, plan.id, sealed.clips[1].id), /another clip/);
  await assert.rejects(store.exportLesson('owner', plan.id), /operation or export/);
  await store.clearOwner('owner'); resolveSpeech(await generate('Late output'));
  await assert.rejects(pending, /workspace closed/); assert.throws(() => store.status('owner', plan.id), error => error.status === 404);
  const roots = await readdir(directory); assert.equal((await readdir(join(directory, roots[0]))).length, 0);
});

test('audio storage and markup quotas are explicit and do not discard committed sources', async t => {
  const { store } = await make(t, { limits: { audioBytes: 1024, instanceAudioBytes: 2048, clipBytes: 1024 } });
  const plan = await create(store, ['s']); await store.addSource('owner', plan.id, source('s', 'Original tail.')); const sealed = await store.seal('owner', plan.id);
  await run(store, plan.id, sealed.clips[0].id);
  let invoked = false;
  await assert.rejects(run(store, plan.id, sealed.clips[1].id, { generate: () => { invoked = true; return generate('No'); } }), /storage quota/);
  assert.equal(invoked, false); assert.equal(store.status('owner', plan.id).summary.sourceCount, 1);
  const second = await create(store); await assert.rejects(create(store, [], 'other'), /workspace quota/); await store.remove('owner', second.id);
  const { store: small } = await make(t, { limits: { markupBytes: 60000 } }); const s = await create(small, ['huge']);
  await assert.rejects(small.addSource('owner', s.id, source('huge', 'word '.repeat(1000))), /markup storage quota/);
  assert.equal(small.status('owner', s.id).summary.sourceCount, 0);
});

test('cache hashes detect damage and require explicit regeneration; raw provider identity is not persisted', async t => {
  const { store, directory } = await make(t); const plan = await create(store); const sealed = await store.seal('owner', plan.id); const clip = sealed.clips[0];
  await run(store, plan.id, clip.id); const base = await planDirectory(directory, plan.id);
  assert.ok(!(await readFile(join(base, 'plan.json'), 'utf8')).includes('fixed-private-identity'));
  await writeFile(join(base, clip.id + '.mp3'), 'damaged');
  const partial = await store.exportLesson('owner', plan.id); assert.equal(partial.audioSummary.completedClips, 0); assert.equal(partial.audioSummary.bytes, 0);
  await assert.rejects(run(store, plan.id, clip.id), /explicit retry/); await run(store, plan.id, clip.id, { retry: true });
  assert.ok(store.status('owner', plan.id).summary.bytes > 0);
  assert.throws(() => store.assertSetup('owner', plan.id, 5), /setup changed/);
  await assert.rejects(store.reconfirm('owner', plan.id, { setupRevision: 5, speechIdentity: 'different' }), /different speech/);
  await store.reconfirm('owner', plan.id, { setupRevision: 5, speechIdentity: setup.speechIdentity }); assert.deepEqual(store.assertSetup('owner', plan.id, 5), setup.speech);
});

test('failed filesystem cleanup retains quota and retries independently of expired session ownership', async t => {
  let failures = 1, removals = 0;
  const { store, directory } = await make(t, { limits: { audioBytes: 1024, instanceAudioBytes: 1024 }, removeDirectory: async path => {
    removals++;
    if (failures > 0) { failures--; throw new Error('Synthetic deletion failure'); }
    await rm(path, { recursive: true, force: true });
  } });
  const plan = await create(store); const path = await planDirectory(directory, plan.id);
  await assert.rejects(store.remove('owner', plan.id), /Synthetic deletion/);
  assert.throws(() => store.status('owner', plan.id), error => error.status === 404);
  await assert.rejects(create(store, [], 'other'), /workspace quota/);
  assert.match(await readFile(join(path, 'plan.json'), 'utf8'), /Read/);
  await store.retryCleanup(); assert.equal(removals, 1, 'No hot-loop cleanup retries');
  await store.retryCleanup(Date.now() + 60001); assert.equal(removals, 2, 'Cleanup does not require a live session or owner-supplied retry');
  await assert.rejects(readFile(join(path, 'plan.json')), error => error.code === 'ENOENT');
  await create(store, [], 'other');
});

test('status-commit failure can replace a charged clip at the exact storage boundary without new speech', async t => {
  const { store, directory } = await make(t, { limits: { audioBytes: 1024, instanceAudioBytes: 2048, clipBytes: 1024 } });
  const plan = await create(store), sealed = await store.seal('owner', plan.id), clip = sealed.clips[0];
  const statusPath = join(await planDirectory(directory, plan.id), clip.id + '.json');
  await assert.rejects(run(store, plan.id, clip.id, { encode: async () => {
    await rm(statusPath); await mkdir(statusPath); return Buffer.alloc(100, 1);
  } }), /Local audio preparation failed/);
  assert.equal(store.clipStatus('owner', plan.id, clip.id).clip.status, 'encoding_failed');
  assert.equal(store.status('owner', plan.id).summary.bytes, 100);
  await rm(statusPath, { recursive: true });
  await run(store, plan.id, clip.id, { retry: true, generate: () => { throw new Error('Paid replay'); }, encode: async () => Buffer.alloc(100, 1) });
  assert.equal(store.status('owner', plan.id).summary.bytes, 100);
  assert.equal(store.clipStatus('owner', plan.id, clip.id).clip.status, 'complete');
});

test('image extraction has a bounded, non-summary, untrusted-source contract', () => {
  const prompt = audioExtractionPrompt({ image: { dataUrl: PNG_URL } });
  assert.equal(prompt.images.length, 1); assert.match(prompt.instructions, /ALL readable original English/); assert.match(prompt.instructions, /untrusted DATA/);
  assert.deepEqual(parseAudioExtraction('{"text":"Last source sentence.","coverage":"complete","warnings":[]}'), { text: 'Last source sentence.', coverage: 'complete', warnings: [] });
  assert.equal(parseAudioExtraction('{"text":"","coverage":"no_english","warnings":[]}').text, '');
  for (const bad of ['{}', '{"text":"","coverage":"complete","warnings":[]}', '{"text":"","coverage":"uncertain","warnings":[]}', '{"text":"English","coverage":"no_english","warnings":[]}', 'not JSON']) assert.throws(() => parseAudioExtraction(bad), /No automatic retry/);
});
