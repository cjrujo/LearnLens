import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioSourceCollector } from '../public/audio-sources.js';
import { parseVideoAnalysis, videoAnalysisInput } from '../lib/video-analysis.mjs';

function analysis() {
  const input = videoAnalysisInput({ video: 'data:video/mp4;base64,' + Buffer.from('000000186674797069736f6d0000020069736f6d69736f32', 'hex').toString('base64'), start: 60, end: 71.25, hasAudio: true });
  return parseVideoAnalysis(JSON.stringify({ version: 1, windows: input.windows.map(bounds => ({ ...bounds, transcript: ' Original / speech.\n', visibleText: '画面 original 1 / 2', observations: 'DERIVED_DESCRIPTION_NOT_ORIGINAL', audioCoverage: 'complete', visualCoverage: 'complete' })), warnings: [] }), input);
}
function collector(options) {
  const c = new AudioSourceCollector(options);
  c.beginItem({ key: 'snapshot123', source: 'Synthetic video', contiguous: false });
  c.addPart({ index: 0, text: '', source: 'Clip 1', hasAlternativeExtraction: true });
  return c;
}

test('video speech inventory retains exact transcript and screen words, never descriptions', () => {
  const c = collector(), result = analysis();
  c.addVideoAnalysis({ index: 0, result, source: 'Synthetic clip' }); c.endItem();
  const sources = c.finish();
  assert.equal(sources.length, 6);
  assert.equal(sources[0].text, ' Original / speech.\n');
  assert.equal(sources[1].text, '画面 original 1 / 2');
  assert.equal(sources[0].extraction, 'transcription'); assert.equal(sources[1].extraction, 'vision');
  assert.match(sources[0].source, /^60–65s/); assert.match(sources.at(-1).source, /^70–71.25s/);
  assert.ok(sources.every(s => s.origin === 'uploaded' && s.coverage === 'uncertain' && !s.readingPauses));
  assert.ok(!sources.some(s => s.text.includes('DERIVED_DESCRIPTION')));
  assert.equal(new Set(sources.map(s => s.key)).size, 6);
});

test('eager and deferred collection from the same retained video receipt are identical', () => {
  const collect = () => { const c = collector(); c.addVideoAnalysis({ index: 0, result: analysis(), source: 'Clip' }); c.endItem(); return c.finish(); };
  assert.deepEqual(collect(), collect()); // Entirely local: no request callback exists.
});

test('empty windows remain explicit without inventing narrated descriptions', () => {
  const c = collector(), result = analysis();
  for (const w of result.windows) { w.transcript = ''; w.visibleText = ''; w.audioCoverage = 'no_speech'; }
  c.addVideoAnalysis({ index: 0, result, source: 'Clip' }); c.endItem();
  const sources = c.finish();
  assert.equal(sources.length, 3);
  assert.ok(sources.every(s => s.text === '' && s.warnings.some(w => /no speech or readable text/.test(w))));
});

test('missing and corrupt video receipts fail before modifying the source inventory', () => {
  const mutations = [r => r.windows.pop(), r => r.windows[1].start = 4, r => r.windows[1].transcript = null, r => r.windows[1].transcript = '\ud800', r => r.windows[1].observations = '', r => r.videoSha256 = 'wrong', r => r.windows[1].audioCoverage = 'skipped'];
  for (const mutate of mutations) {
    const c = collector(), result = analysis(); mutate(result);
    assert.throws(() => c.addVideoAnalysis({ index: 0, result, source: 'Clip' }), /No video, transcription or OCR request was made/);
    assert.equal(c.sources.length, 0); assert.equal(c.retainedBytes, 0);
  }
  assert.throws(() => collector().addVideoAnalysis({ index: 1, result: analysis(), source: 'Clip' }), /original video part/);
});

test('video text quota is checked atomically without clipping or skipping late windows', () => {
  const result = analysis();
  const bytes = result.windows.reduce((n, w) => n + Buffer.byteLength(w.transcript) + Buffer.byteLength(w.visibleText), 0);
  const exact = collector({ maxBytes: bytes }); exact.addVideoAnalysis({ index: 0, result, source: 'Clip' });
  assert.equal(exact.retainedBytes, bytes);
  const small = collector({ maxBytes: bytes - 1 });
  assert.throws(() => small.addVideoAnalysis({ index: 0, result, source: 'Clip' }), /No video text was truncated/);
  assert.equal(small.retainedBytes, 0); assert.equal(small.sources.length, 0);
});
