import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioSourceCollector, splitAudioText, isContiguousAudioText, validateVisionExtraction, AUDIO_SOURCE_MAX_CHARS, AUDIO_SOURCE_MAX_BYTES, TRANSCRIPTION_WARNING, VISION_WARNING } from '../public/audio-sources.js';
import { MaterialWorkspace } from '../public/materials.js';

const collect = (texts, options = {}) => {
  const collector = new AudioSourceCollector(options);
  collector.beginItem({ key: 'opaque_item_1', source: 'Pasted notes.txt', contiguous: true });
  texts.forEach((text, index) => collector.addPart({ index, text, source: `part ${index + 1}` }));
  collector.endItem();
  return { collector, sources: collector.finish() };
};
const assertDescriptors = sources => {
  for (const source of sources) {
    assert.deepEqual(Object.keys(source).sort(), ['key', 'text', 'source', 'origin', 'extraction', 'coverage', 'warnings'].sort());
    assert.match(source.key, /^[\x20-\x7e]{1,200}$/);
    assert.ok(source.source.length <= 300);
    assert.ok(source.text.length <= AUDIO_SOURCE_MAX_CHARS);
    assert.equal(source.origin, 'uploaded');
    assert.ok(Array.isArray(source.warnings));
  }
  assert.equal(new Set(sources.map(source => source.key)).size, sources.length);
};

test('contiguous slices rejoin midwords exactly, including first/middle/last and more than eight blocks', () => {
  const original = ' FIRST\r\n' + 'English sentence with meaningful content. '.repeat(11000) + '\nLAST  ';
  // This imitates actual item.textParts and Office slices, NOT sentence boundaries.
  const slices = [];
  for (let i = 0; i < original.length; i += 20000) slices.push(original.slice(i, i + 20000));
  const { sources } = collect(slices);
  assert.ok(sources.length > 8);
  assert.equal(sources.map(source => source.text).join(''), original);
  assert.match(sources[0].text, /^ FIRST\r\n/);
  assert.match(sources.at(-1).text, /LAST  $/);
  assertDescriptors(sources);
  assert.deepEqual(collect(slices).sources, sources, 'identical originals have stable descriptor identities');
  assert.ok(sources.every(source => !source.key.includes('Pasted') && !source.key.includes('English')));
});

test('text and Office items are contiguous, PDF and media parts are independent', () => {
  for (const item of [{ kind: 'text', textParts: ['mid', 'word'], partCount: 2 }, { kind: 'document', name: 'slides.PPTX' }, { kind: 'document', name: 'notes.docx' }]) assert.equal(isContiguousAudioText(item), true);
  for (const item of [{ kind: 'document', name: 'pages.pdf' }, { kind: 'media', name: 'voice.mp3' }, { kind: 'image', name: 'page.png' }]) assert.equal(isContiguousAudioText(item), false);
  assert.equal(collect(['first mid', 'dle ', 'last']).sources.map(source => source.text).join(''), 'first middle last');
  const collector = new AudioSourceCollector();
  collector.beginItem({ key: 'pdf', source: 'pages.pdf' });
  ['first page', 'next page'].forEach((text, index) => collector.addPart({ index, text, source: `pages ${index * 3 + 1}–${index * 3 + 3}` }));
  collector.endItem();
  assert.deepEqual(collector.finish().map(({ text, source }) => [text, source]), [['first page', 'pages 1–3'], ['next page', 'pages 4–6']]);
  // Independent sources can be presented with newline separators, not spliced into a word.
  assert.equal(collector.finish().map(source => source.text).join('\n'), 'first page\nnext page');
});

test('sentence/newline boundaries are preferred, words and mixed Unicode are never cut', () => {
  assert.equal(splitAudioText('One sentence. more words beyond limit', 22)[0], 'One sentence. ');
  assert.equal(splitAudioText('first line\nmore words beyond limit', 20)[0], 'first line\n');
  assert.equal(splitAudioText('alpha beta gamma delta', 12)[0], 'alpha beta ');
  const text = (' English café e\u0301 中文 😀\r\n العربية Ελληνικά. ').repeat(3000) + 'tail😀';
  const { sources, collector } = collect([text.slice(0, 11), text.slice(11, 40001), text.slice(40001)]);
  assert.equal(sources.map(source => source.text).join(''), text);
  assert.equal(collector.retainedBytes, Buffer.byteLength(text, 'utf8'));
  sources.forEach(source => {
    assert.equal(source.text.isWellFormed(), true);
    assert.ok(!/^[\uDC00-\uDFFF]/.test(source.text));
    assert.ok(!/[\uD800-\uDBFF]$/.test(source.text));
  });
  assertDescriptors(sources);
});

test('long unspaced CJK uses sentence/grapheme boundaries without splitting embedded English', () => {
  assert.equal(splitAudioText('第一句话。第二句话。', 8)[0], '第一句话。');
  const keyword = 'photosynthesis';
  for (const original of [
    '这是没有空格的中文句子。'.repeat(7000),
    '中'.repeat(39996) + keyword + '文'.repeat(40001) + '。尾',
    '中'.repeat(39999) + '漢\u{E0100}' + '字'.repeat(40003),
    '𠀀'.repeat(40001) + '结束。'
  ]) {
    const { sources } = collect([original.slice(0, 20000), original.slice(20000, 40000), original.slice(40000)]);
    const blocks = sources.map(source => source.text);
    assert.equal(blocks.join(''), original);
    assert.ok(blocks.length > 1);
    assert.ok(blocks.every(block => block.isWellFormed()));
    const boundaries = new Set([...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(original)].map(segment => segment.index));
    let offset = 0;
    for (const block of blocks.slice(0, -1)) { offset += block.length; assert.ok(boundaries.has(offset), `split ${offset} must be a whole grapheme`); }
    if (original.includes(keyword)) assert.equal(blocks.filter(block => block.includes(keyword)).length, 1);
    assertDescriptors(sources);
  }
  assert.throws(() => splitAudioText('中' + 'x'.repeat(40001) + '文'), /unbroken token/);
});

test('surrogates divided by original slices rejoin and use exact UTF-8 accounting', () => {
  const { sources, collector } = collect(['A\ud83d', '', '\ude00Z'], { maxBytes: 6 });
  assert.equal(sources.filter(source => source.extraction === 'text').map(source => source.text).join(''), 'A😀Z');
  assert.equal(collector.retainedBytes, 6);
  assert.throws(() => collect(['A\ud83d', '\ude00Z!'], { maxBytes: 6 }), /UTF-8 retained-text limit/);
});

test('exact boundaries and pathological unbroken tokens fail explicitly without truncation', () => {
  assert.deepEqual(splitAudioText('x'.repeat(40000)), ['x'.repeat(40000)]);
  assert.equal(splitAudioText('x'.repeat(40000) + ' tail').join(''), 'x'.repeat(40000) + ' tail');
  assert.equal(splitAudioText('😀'.repeat(20000) + ' tail').join(''), '😀'.repeat(20000) + ' tail');
  assert.throws(() => splitAudioText('x'.repeat(40001)), /unbroken token.*40000.*no source text was truncated/i);
  assert.throws(() => collect(['x'.repeat(20000), 'x'.repeat(20001)]), /unbroken token/);
  assert.throws(() => splitAudioText('😀'.repeat(20001)), /unbroken token/);
  assert.throws(() => splitAudioText('text', 40001), /Invalid audio source block size/);
});

test('UTF-8 retention limit covers pending originals, transcriptions and OCR together', () => {
  assert.equal(AUDIO_SOURCE_MAX_BYTES, 64 * 1024 * 1024);
  assert.equal(new AudioSourceCollector().maxBytes, AUDIO_SOURCE_MAX_BYTES);
  assert.throws(() => new AudioSourceCollector({ maxBytes: AUDIO_SOURCE_MAX_BYTES + 1 }), /retention limit/);
  const collector = new AudioSourceCollector({ maxBytes: 12 });
  collector.beginItem({ key: 'budget', source: 'test', contiguous: true });
  collector.addPart({ index: 0, text: '😀', source: 'original' }); // 4 bytes pending
  collector.addTranscription({ index: 0, text: 'é', source: 'speech' }); // 2
  collector.addVision({ index: 0, imageIndex: 0, result: { text: '中文', coverage: 'complete', warnings: [] }, source: 'image' }); // 6
  assert.equal(collector.retainedBytes, 12);
  assert.throws(() => collector.addPart({ index: 1, text: 'a', source: 'part 2' }), /64 MiB.*No text was truncated/);
  assert.equal(collector.retainedBytes, 12);
  collector.endItem();
  assertDescriptors(collector.finish());
});

test('blank parts and no-English images have explicit statuses with whitespace preserved', () => {
  assert.deepEqual(splitAudioText(''), ['']);
  const { sources } = collect([' \n', '', '\t']);
  assert.ok(sources.every(source => source.coverage === 'unavailable'));
  assert.equal(sources.map(source => source.text).join(''), ' \n\t');
  const collector = new AudioSourceCollector();
  collector.beginItem({ key: 'empty', source: 'scan' });
  collector.addPart({ index: 0, text: '  ', source: 'page 1', warnings: ['No text layer.'] });
  collector.addPart({ index: 1, text: '', source: 'page 2', hasAlternativeExtraction: true });
  collector.addVision({ index: 1, imageIndex: 0, source: 'page 2 · image 1', result: { text: '', coverage: 'no_english', warnings: ['No English detected.'] } });
  collector.endItem();
  assert.equal(collector.finish()[0].text, '  ');
  assert.equal(collector.finish()[0].extraction, 'unavailable');
  assert.equal(collector.finish()[1].coverage, 'no_english');
  assert.ok(collector.finish()[1].warnings.includes('No English detected.'));
  assertDescriptors(collector.finish());
});

test('alternative extraction replaces empty raw text, but genuinely empty parts remain unavailable', () => {
  for (const contiguous of [false, true]) {
    const collector = new AudioSourceCollector();
    collector.beginItem({ key: 'alternatives', source: 'material', contiguous });
    collector.addPart({ index: 0, text: '', source: 'speech part', hasAlternativeExtraction: true });
    collector.addTranscription({ index: 0, text: 'Exact speech', source: 'speech part' });
    collector.addPart({ index: 1, text: ' \n', source: 'image part', hasAlternativeExtraction: true });
    collector.addVision({ index: 1, imageIndex: 0, source: 'image part', result: { text: '', warnings: [], coverage: 'no_english' } });
    collector.endItem();
    assert.deepEqual(collector.finish().map(source => source.extraction), ['transcription', 'vision']);
    assert.equal(collector.retainedBytes, Buffer.byteLength('Exact speech'));
    collector.beginItem({ key: 'truly_empty', source: 'empty part', contiguous });
    collector.addPart({ index: 0, text: '', source: 'empty part' });
    collector.endItem();
    assert.ok(collector.finish().some(source => source.extraction === 'unavailable'));
    assertDescriptors(collector.finish());
  }
  const mixed = new AudioSourceCollector();
  mixed.beginItem({ key: 'mixed', source: 'mixed.docx', contiguous: true });
  mixed.addPart({ index: 0, text: 'left', source: 'part 1' });
  mixed.addPart({ index: 1, text: ' \n', source: 'part 2', hasAlternativeExtraction: true });
  mixed.addVision({ index: 1, imageIndex: 0, source: 'part 2', result: { text: 'image', warnings: [], coverage: 'complete' } });
  mixed.addPart({ index: 2, text: 'right', source: 'part 3' });
  mixed.endItem();
  assert.equal(mixed.finish().find(source => source.extraction === 'text').text, 'left \nright');
  assert.ok(mixed.finish().every(source => source.extraction !== 'unavailable'));
});

test('every image has separate provenance, retains all text, and exposes OCR/transcription uncertainty', () => {
  const collector = new AudioSourceCollector();
  collector.beginItem({ key: 'media', source: 'lecture.mp4' });
  collector.addPart({ index: 0, text: 'Original text', source: '0–30 seconds', warnings: ['Sampled frames only.'] });
  const transcript = '  full transcript. '.repeat(3000) + '\n';
  collector.addTranscription({ index: 0, text: transcript, source: '0–30 seconds · speech', warnings: ['Low confidence word.'] });
  for (let imageIndex = 0; imageIndex < 10; imageIndex++) collector.addVision({ index: 0, imageIndex, source: `0–30 seconds · image ${imageIndex + 1}`, result: { text: ` English from image ${imageIndex}\n`, coverage: imageIndex % 2 ? 'uncertain' : 'complete', warnings: ['Small print.'] }, warnings: ['Resized.'], image: { dataUrl: 'must not be retained' } });
  collector.endItem();
  const sources = collector.finish(), speech = sources.filter(source => source.extraction === 'transcription'), images = sources.filter(source => source.extraction === 'vision');
  assert.equal(speech.map(source => source.text).join(''), transcript);
  assert.ok(speech.every(source => source.coverage === 'uncertain' && source.warnings.includes(TRANSCRIPTION_WARNING) && source.warnings.includes('Low confidence word.')));
  assert.equal(images.length, 10);
  images.forEach((source, index) => {
    assert.equal(source.coverage, 'uncertain');
    assert.equal(source.text, ` English from image ${index}\n`);
    assert.equal(source.source, `0–30 seconds · image ${index + 1}`);
    assert.deepEqual(source.warnings, ['Resized.', 'Small print.', VISION_WARNING]);
  });
  assert.equal(collector.current, null);
  assert.ok(!JSON.stringify(collector).includes('must not be retained'));
  assertDescriptors(sources);
});

test('source labels are bounded, identities never embed labels, invalid extraction is rejected', () => {
  const collector = new AudioSourceCollector();
  collector.beginItem({ key: 'opaque', source: 'private.txt' });
  collector.addPart({ index: 0, text: 'private words', source: 'a'.repeat(299) + '😀filename' });
  collector.endItem();
  assert.equal(collector.finish()[0].source.length, 299);
  assert.equal(collector.finish()[0].source.isWellFormed(), true);
  assert.ok(!collector.finish()[0].key.includes('private'));
  for (const result of [null, {}, { text: '', warnings: [], coverage: 'invalid' }, { text: '', coverage: 'complete' }, { text: '', warnings: [42], coverage: 'complete' }]) assert.throws(() => validateVisionExtraction(result), /invalid English-text extraction/);
  assert.equal(validateVisionExtraction({ text: '', warnings: [], coverage: 'no_english' }).coverage, 'no_english');
  assert.throws(() => collector.beginItem({ key: 'bad\nidentity', source: '' }), /opaque and printable/);
  assertDescriptors(collector.finish());
});

// No DOM is needed: test preparation with real textParts and stubbed paid calls.
const workspace = (items, api = async () => ({ text: 'LOSSY DIGEST', warnings: [] })) => {
  const value = new MaterialWorkspace({ list: null, changed: () => {}, api });
  value.items = items;
  return value;
};
const settings = { consent: true, goal: 'Learner instructions are not uploaded material', roles: { primary: { model: 'primary' }, transcription: { model: 'speech' } }, expectedSetupRevision: 1 };

test('prepare defaults to legacy shape and opt-in returns original pasted text, never digests or goal', async () => {
  const calls = [];
  const text = ' first mid' + 'dle. '.repeat(10000) + ' last\n';
  const textParts = [];
  for (let i = 0; i < text.length; i += 20000) textParts.push(text.slice(i, i + 20000));
  const value = workspace([{ id: 'stable-random-id', name: 'Pasted notes.txt', kind: 'text', status: 'ready', textParts, partCount: textParts.length, warnings: [] }], async path => { calls.push(path); return { text: 'LOSSY DIGEST', warnings: [] }; });
  const legacy = await value.prepare(settings);
  assert.deepEqual(Object.keys(legacy).sort(), ['images', 'sourceWarnings', 'text']);
  assert.ok(!calls.includes('/audio/extract'));
  const before = calls.length;
  const full = await value.prepare({ ...settings, completeAudio: true });
  assert.equal(calls.length, before, 'paid digests use the existing successful result cache');
  assert.deepEqual(Object.keys(full).sort(), ['audioSources', 'images', 'sourceWarnings', 'text']);
  assert.equal(full.audioSources.map(source => source.text).join(''), text);
  assert.ok(!JSON.stringify(full.audioSources).includes('LOSSY DIGEST'));
  assert.ok(!JSON.stringify(full.audioSources).includes(settings.goal));
  assertDescriptors(full.audioSources);
  assert.match(value.describe({ completeAudio: true }), /every source image.*potentially billable/);
  assert.match(value.describe({ completeAudio: true }), /many narration clips/);
  assert.ok(!value.describe().includes('every source image'));
  assert.ok(value.cacheBytes <= 8 * 1024 * 1024);
});

test('prepare includes exact independent transcripts with warnings before digesting', async () => {
  const value = workspace([{ id: 'media-id', name: 'voice.mp3', kind: 'media', status: 'ready', partCount: 2, warnings: [] }], async path => path === '/transcribe' ? { text: ' Full speech.\n', warnings: ['Unclear word.'] } : { text: 'LOSSY DIGEST', warnings: [] });
  value.part = async (_item, index) => ({ text: `Original ${index}`, audio: `audio-${index}`, images: [], label: `${index * 30}–${(index + 1) * 30} seconds` });
  const { audioSources } = await value.prepare({ ...settings, completeAudio: true });
  assert.deepEqual(audioSources.map(source => source.text), ['Original 0', ' Full speech.\n', 'Original 1', ' Full speech.\n']);
  assert.ok(audioSources[1].source.includes('0–30 seconds'));
  assert.ok(audioSources[3].source.includes('30–60 seconds'));
  assert.ok(audioSources[1].warnings.includes('Unclear word.'));
  assert.ok(audioSources[3].warnings.includes(TRANSCRIPTION_WARNING));
  assertDescriptors(audioSources);
});

test('prepare does not declare audio-only MP3 parts unavailable', async () => {
  const value = workspace([{ id: 'speech-only', name: 'voice.mp3', kind: 'media', status: 'ready', partCount: 1, warnings: [] }], async () => ({ text: 'Transcript', warnings: [] }));
  value.part = async () => ({ text: '', audio: 'audio-data', images: [], label: '0–30 seconds' });
  const { audioSources } = await value.prepare({ ...settings, completeAudio: true });
  assert.deepEqual(audioSources.map(source => source.extraction), ['transcription']);
  assert.equal(audioSources[0].text, 'Transcript');
});

// Decode tiny already-normalized visuals without a browser or canvas. These test
// the real paid/cache path, not DOM rendering or image conversion.
const stubImage = t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'Image');
  Object.defineProperty(globalThis, 'Image', { configurable: true, value: class {
    width = 1; height = 1;
    async decode() {}
  } });
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'Image', previous); else delete globalThis.Image; });
};
const visualWorkspace = (count, api, partCount = 1) => {
  const value = workspace([{ id: 'image-item-id', name: 'scans.pdf', kind: 'document', status: 'ready', partCount, warnings: [] }], api);
  value.part = async (_item, index) => ({ text: '', images: Array.from({ length: count }, (_, imageIndex) => ({ name: `scan-${imageIndex}`, dataUrl: `data:image/png;base64,${index}-${imageIndex}` })), label: `pages ${index * 3 + 1}–${index * 3 + 3}` });
  return value;
};

test('prepare extracts every normalized visual in every part with primary role/revision cache identity', async t => {
  stubImage(t);
  const calls = [];
  const value = visualWorkspace(6, async (path, options) => {
    calls.push({ path, body: options.body });
    return path === '/audio/extract' ? { text: options.body.image.dataUrl.endsWith('-0') ? '' : 'Full image words.\n', coverage: options.body.image.dataUrl.endsWith('-0') ? 'no_english' : 'complete', warnings: ['Verify fine print.'] } : { text: 'DIGEST', warnings: [] };
  }, 2);
  await value.prepare(settings);
  assert.ok(calls.every(call => call.path !== '/audio/extract'));
  calls.length = 0;
  const result = await value.prepare({ ...settings, completeAudio: true });
  assert.equal(calls.length, 12, 'previous digests are reused; all 12 images get separate OCR calls');
  calls.forEach(call => {
    assert.equal(call.path, '/audio/extract');
    assert.deepEqual(Object.keys(call.body).sort(), ['consent', 'expectedSetupRevision', 'image']);
    assert.equal(call.body.consent, true);
    assert.equal(call.body.expectedSetupRevision, 1);
    assert.equal(typeof call.body.image.dataUrl, 'string');
  });
  assert.equal(result.images.length, 5, 'representative preview cap stays unchanged');
  const images = result.audioSources.filter(source => source.extraction === 'vision');
  assert.equal(images.length, 12);
  assert.ok(result.audioSources.every(source => source.extraction !== 'unavailable'), 'image-only parts do not imply missing sources');
  assert.equal(images.filter(source => source.coverage === 'no_english').length, 2);
  assert.ok(images.every(source => source.warnings.includes('Verify fine print.') && source.warnings.includes(VISION_WARNING)));
  assertDescriptors(result.audioSources);
  await value.prepare({ ...settings, completeAudio: true });
  assert.equal(calls.length, 12, 'successful OCR including empty no-English text is cached');
  calls.length = 0;
  await value.prepare({ ...settings, completeAudio: true, roles: { ...settings.roles, primary: { model: 'different-primary' } } });
  assert.equal(calls.filter(call => call.path === '/audio/extract').length, 12, 'primary role changes invalidate extraction cache');
  calls.length = 0;
  await value.prepare({ ...settings, completeAudio: true, expectedSetupRevision: 2 });
  assert.equal(calls.filter(call => call.path === '/audio/extract').length, 12, 'setup revision changes invalidate extraction cache');
});

test('failed or invalid image extraction is not cached, retried, or replaced by a digest', async t => {
  stubImage(t);
  let calls = 0, fail = true;
  const value = visualWorkspace(2, async () => {
    calls++;
    if (fail) throw new Error('Unknown billable outcome');
    return { text: 'recovered words', warnings: [], coverage: 'complete' };
  });
  await assert.rejects(value.prepare({ ...settings, completeAudio: true }), /Unknown billable outcome/);
  assert.equal(calls, 1);
  assert.equal(value.cache.size, 0);
  await assert.rejects(value.prepare({ ...settings, completeAudio: true, consent: false }), /Explicit paid consent/);
  assert.equal(calls, 1);
  fail = false;
  await value.prepare({ ...settings, completeAudio: true });
  assert.equal(calls, 3);
  const invalid = visualWorkspace(2, async () => { calls++; return { text: 'invalid', warnings: [], coverage: 'unknown' }; });
  await assert.rejects(invalid.prepare({ ...settings, completeAudio: true }), /invalid English-text extraction/);
  assert.equal(calls, 4);
  assert.equal(invalid.cache.size, 0);
});

test('image extraction shares the 512-call budget and 8 MiB result cache', async t => {
  stubImage(t);
  let calls = 0;
  const value = visualWorkspace(513, async () => { calls++; return { text: 'words', warnings: [], coverage: 'complete' }; });
  await assert.rejects(value.prepare({ ...settings, completeAudio: true }), /512 calls/);
  assert.equal(calls, 512);
  assert.ok(value.cacheBytes <= 8 * 1024 * 1024);
  // Existing cache sizing is JSON UTF-16 bytes. Oversize successes are returned
  // but not cached, and a subsequent paid attempt still requires consent.
  const bigText = 'a '.repeat(2100000);
  let largeCalls = 0;
  const large = visualWorkspace(1, async () => { largeCalls++; return { text: bigText, warnings: [], coverage: 'complete' }; });
  const result = await large.prepare({ ...settings, completeAudio: true });
  assert.equal(result.audioSources.filter(source => source.extraction === 'vision').map(source => source.text).join(''), bigText);
  assert.equal(large.cacheBytes, 0);
  assert.equal(largeCalls, 1);
  await assert.rejects(large.prepare({ ...settings, completeAudio: true, consent: false }), /Explicit paid consent/);
  assert.equal(largeCalls, 1);
});

test('unreadable-only sources return explicit inventory on opt-in; legacy still errors', async () => {
  const value = workspace([{ id: 'blank-id', name: 'blank.pdf', kind: 'document', status: 'ready', partCount: 1, warnings: [] }]);
  value.part = async () => ({ text: ' \n', images: [], label: 'pages 1–3' });
  await assert.rejects(value.prepare(settings), /No readable material/);
  const { audioSources } = await value.prepare({ ...settings, completeAudio: true });
  assert.equal(audioSources[0].coverage, 'unavailable');
  assert.equal(audioSources[0].text, ' \n');
  assert.deepEqual((await workspace([]).prepare({ ...settings, completeAudio: true })).audioSources, []);
});
