import test from 'node:test';
import assert from 'node:assert/strict';
import { AppError } from '../lib/provider.mjs';
import { createHash } from 'node:crypto';
import * as inventory from '../lib/speech-inventory.mjs';
const { buildSpeechBlock, lessonSpeechBlocks, speechWords, normalizeReadingPauses } = inventory;

const build = (text, extra = {}) => buildSpeechBlock({ key: 'upload.page.1', source: 'Uploaded page 1', text, ...extra });
const sentences = result => result.units.filter(unit => unit.kind === 'sentence');
const words = result => result.units.filter(unit => unit.kind === 'word');
const clipTexts = (result, unit) => unit.clipIds.map(id => result.clips.find(clip => clip.id === id).text);

function assertCoverage(result) {
  for (const word of speechWords(result.block.text)) {
    assert.ok(sentences(result).some(unit => unit.start <= word.start && unit.end >= word.end), `Uncovered word at ${word.start}`);
    assert.ok(words(result).some(unit => unit.text === word.text), `Missing word ${word.text}`);
  }
  for (const unit of sentences(result)) assert.equal(unit.text, result.block.text.slice(unit.start, unit.end));
  for (const unit of result.units) for (const id of unit.clipIds) assert.ok(result.clips.some(clip => clip.id === id));
  for (const clip of result.clips) {
    assert.match(clip.id, /^[a-f0-9]{64}$/);
    assert.ok(clip.text.length <= 500);
    assert.ok(!/[\uD800-\uDFFF]/u.test(clip.text));
  }
}

test('inventories more than eight sentences and all first/middle/tail words without changing source', () => {
  const text = '  First sentence is present.\n' + Array.from({ length: 18 }, (_, i) => `Sentence number ${i} includes word${i}.`).join(' ') + '\nUnpunctuated final tail';
  const result = build(text);
  assert.equal(result.block.text, text);
  assert.equal(sentences(result).length, 20);
  assert.equal(sentences(result)[0].text, 'First sentence is present.');
  assert.equal(sentences(result)[10].text, 'Sentence number 9 includes word9.');
  assert.equal(sentences(result).at(-1).text, 'Unpunctuated final tail');
  assertCoverage(result);
  assert.deepEqual(result, build(text));
});

test('long single lines split into bounded clips at whitespace, preserving every token and tail', () => {
  const text = 'Café ' + 'extraordinary naïve co-operate '.repeat(85) + 'FINALTAIL.';
  const result = build(text);
  assert.equal(sentences(result).length, 1);
  const pieces = clipTexts(result, sentences(result)[0]);
  assert.ok(pieces.length > 4);
  assert.equal(pieces.join(' '), text);
  assert.ok(pieces.at(-1).endsWith('FINALTAIL.'));
  assertCoverage(result);
  assert.equal(build('a'.repeat(500)).clips[0].text.length, 500);
  assert.throws(() => build('a'.repeat(501)), error => error instanceof AppError && error.status === 422 && /unbroken token/.test(error.message));
});

test('word bank keeps each exact form; clips deduplicate within and across blocks', () => {
  const a = build('Repeat repeat Repeat\nrepeat\nrepeat');
  const b = build('repeat', { key: 'other.block' });
  assert.deepEqual(words(a).map(unit => unit.text), ['Repeat', 'repeat']);
  const word = words(a).find(unit => unit.text === 'repeat');
  assert.equal(word.clipIds[0], words(b)[0].clipIds[0]);
  assert.notEqual(word.id, words(b)[0].id);
  assert.equal(new Set(a.clips.map(clip => clip.id)).size, a.clips.length);
  const repeatedSentences = sentences(a).filter(unit => unit.text === 'repeat');
  assert.notEqual(repeatedSentences[0].id, repeatedSentences[1].id);
  assert.deepEqual(repeatedSentences[0].clipIds, word.clipIds);
});

test('mixed scripts never reach speech clips; source and exact UTF-16 offsets survive', () => {
  const text = '你好First hello. 中文Middle café。العربية English tail. Русский last\n😀After emoji.';
  const result = build(text);
  assert.equal(result.block.text, text);
  assert.ok(result.warnings.some(value => /non-Latin.*skipped/.test(value)));
  assert.ok(result.warnings.some(value => /does not guarantee English/.test(value)));
  assertCoverage(result);
  for (const clip of result.clips) assert.doesNotMatch(clip.text, /[\p{Script=Han}\p{Script=Arabic}\p{Script=Cyrillic}]/u);
  assert.deepEqual(words(result).map(unit => unit.text), ['First', 'hello', 'Middle', 'café', 'English', 'tail', 'last', 'After', 'emoji']);
});

test('Arabic inherited-script marks attached to Latin letters are excluded too', () => {
  const result = build('Latin\u064b next\u0651 café cafe\u0301');
  assert.ok(result.warnings.length);
  for (const clip of result.clips) assert.doesNotMatch(clip.text, /[\u064b\u0651]/u);
  assert.deepEqual(words(result).map(unit => unit.text), ['Latin', 'next', 'café', 'cafe\u0301']);
  assertCoverage(result);
});

test('word spans support apostrophes, hyphens, diacritics and decomposed accents exactly', () => {
  const text = "你好😀 don't DON’T lʼami co-operate non‑breaking re‐enter café cafe\u0301 déjà-vu!";
  const spans = speechWords(text);
  assert.deepEqual(spans.map(word => word.text), ["don't", 'DON’T', 'lʼami', 'co-operate', 'non‑breaking', 're‐enter', 'café', 'cafe\u0301', 'déjà-vu']);
  for (const span of spans) assert.equal(text.slice(span.start, span.end), span.text);
  assertCoverage(build(text));
});

test('alphanumeric keywords retain digits, case, connectors and exact offsets', () => {
  const expected = ['GPT-4', '3D', 'CO2', 'H2O', 'v1', 'GPT-4', 'gpt-4', '3D’s', 'café2', 'cafe\u0301-3', 'non‑2D'];
  const text = `你好😀 ${expected.join(' ')} 123 45-67`;
  const spans = speechWords(text);
  assert.deepEqual(spans.map(word => word.text), expected);
  for (const span of spans) assert.equal(text.slice(span.start, span.end), span.text);
  const result = build(text);
  assert.deepEqual(words(result).map(word => word.text), [...new Set(expected)]);
  for (const word of words(result)) assert.deepEqual(clipTexts(result, word), [word.text]);
  assertCoverage(result);
});

test('OCR formatting stays in original content but separates speech without joining fragments', () => {
  const text = '😀 inter\u00adnational zero\u200bwidth GPT\u00ad4 tail';
  const translation = 'trans\u00adlation\u200btext';
  const result = build(text, { translation });
  assert.equal(result.block.text, text);
  assert.equal(result.block.translation, translation);
  assert.deepEqual(speechWords(text).map(word => word.text), ['inter', 'national', 'zero', 'width', 'GPT', 'tail']);
  for (const word of speechWords(text)) assert.equal(text.slice(word.start, word.end), word.text);
  for (const clip of result.clips) {
    assert.doesNotMatch(clip.text, /[\u00ad\u200b]/u);
    assert.doesNotMatch(clip.text, /international|zerowidth|GPT4/u);
  }
  assert.ok(result.warnings.some(warning => /nonspoken boundaries/.test(warning) && /pronunciation/.test(warning)));
  assertCoverage(result);
  for (const formatting of ['\u00ad', '\u200b']) {
    for (const field of ['key', 'source']) assert.throws(() => build('Safe text', { [field]: `bad${formatting}metadata` }), AppError);
  }
  for (const text of ['bad\u0001text', 'bad\u202etext', 'bad\u2066text', '\udfff']) {
    assert.throws(() => build(text), AppError);
    assert.throws(() => speechWords(text), AppError);
  }
});

test('common abbreviations, multiline phrases, and final incomplete sentence are covered', () => {
  const text = 'Dr. Smith arrived. Mr. Jones left.\r\nA standalone phrase\nUse e.g. apples for practice.\nFinal fragment';
  const result = build(text);
  assert.equal(sentences(result)[0].text, 'Dr. Smith arrived.');
  assert.ok(sentences(result).some(unit => unit.text === 'Mr. Jones left.'));
  assert.equal(sentences(result).at(-1).text, 'Final fragment');
  assertCoverage(result);
});

test('empty/no-letter sources have no invented clips or units', () => {
  for (const text of ['', '123 456!?\n()', '中文 العربية Русский 😀']) {
    const result = build(text);
    assert.equal(result.block.text, text);
    assert.deepEqual(result.units, []);
    assert.deepEqual(result.clips, []);
  }
  assert.ok(build('中文').warnings.length);
});

test('markup and URL/path-looking source stay literal text; IDs contain only hex', () => {
  const text = '<script>alert("x")</script> ../../secret https://example.test/?q=" onerror="bad';
  const result = build(text, { key: '../<img src=x onerror=bad>', source: '<b>Source</b>' });
  assert.equal(result.block.text, text);
  assertCoverage(result);
  for (const unit of result.units) assert.match(unit.id, /^[a-f0-9]{64}$/);
  assert.ok(words(result).some(unit => unit.text === 'script'));
});

test('generated descriptors cover every requested field with stable keys and restricted answer flags', () => {
  const lesson = {
    title: 'Generated title', summary: 'Full summary.', objectives: ['First objective', 'Second objective'],
    sections: [{ title: 'Section title', body: 'One sentence. Another sentence.', items: ['First item', 'Last item'], question: 'What is this?', answer: 'Correct answer.', translation: '完整翻译。' }],
    audio: [{ text: 'Original extra narration.', translation: '配对翻译' }, { text: 'Full summary.', translation: '' }],
  };
  const blocks = lessonSpeechBlocks(lesson);
  assert.deepEqual(blocks.map(block => block.key), [
    'lesson.title', 'lesson.summary', 'lesson.objectives.0', 'lesson.objectives.1',
    'lesson.sections.0.title', 'lesson.sections.0.body', 'lesson.sections.0.question', 'lesson.sections.0.answer', 'lesson.sections.0.translation',
    'lesson.sections.0.items.0', 'lesson.sections.0.items.1', 'lesson.audio.0.text', 'lesson.audio.1.text',
  ]);
  for (const block of blocks) {
    assert.equal(block.origin, 'generated');
    assert.match(block.source, /Generated lesson: Generated title/);
    assert.equal(block.answer, block.key === 'lesson.sections.0.answer');
    const result = buildSpeechBlock(block);
    assertCoverage(result);
    for (const unit of result.units) {
      assert.equal(unit.answer, block.answer);
      assert.equal(unit.source, block.source);
      assert.equal(unit.origin, 'generated');
    }
  }
  assert.equal(blocks.find(block => block.key.endsWith('.body')).translation, '');
  assert.equal(blocks.find(block => block.key === 'lesson.audio.0.text').translation, '配对翻译');
  assert.equal(blocks.find(block => block.key.endsWith('.translation')).text, '完整翻译。');
});

test('block metadata and optional translation are preserved exactly', () => {
  const result = build('  Original sentence.  ', { answer: true, origin: 'generated', translation: ' 原始翻译 ' });
  assert.deepEqual(result.block, { key: 'upload.page.1', source: 'Uploaded page 1', text: '  Original sentence.  ', answer: true, origin: 'generated', translation: ' 原始翻译 ' });
  for (const unit of result.units) {
    assert.equal(unit.answer, true);
    assert.equal(unit.blockKey, result.block.key);
    assert.equal(Object.hasOwn(unit, 'translation'), false);
  }
});

test('reading-pause flags are optional booleans for generated blocks only', () => {
  assert.equal(Object.hasOwn(build('The fox / rests.').block, 'readingPauses'), false);
  for (const readingPauses of [true, false]) {
    assert.equal(build('The fox / rests.', { origin: 'generated', readingPauses }).block.readingPauses, readingPauses);
    assert.throws(() => build('The fox / rests.', { readingPauses }), /generated/i);
  }
  for (const readingPauses of [null, 'true', 'false', 0, 1, [], {}]) {
    assert.throws(() => build('The fox / rests.', { origin: 'generated', readingPauses }), AppError);
    assert.throws(() => lessonSpeechBlocks({ sections: [{ readingPauses }] }), AppError);
    assert.throws(() => lessonSpeechBlocks({ audio: [{ readingPauses }] }), AppError);
  }
});

test('generated reading pauses reach prose and explicit audio only, without changing reveal flags', () => {
  const text = 'The fox / rests.';
  const lesson = {
    title: text, summary: text, objectives: [text],
    sections: [
      { title: text, body: text, items: [text], question: text, answer: text, translation: text, readingPauses: true },
      { body: text, items: [text], readingPauses: false },
      { body: text, items: [text] },
    ],
    audio: [{ text, translation: text, readingPauses: true }, { text, readingPauses: false }, { text }],
  };
  const marked = new Set(['lesson.sections.0.body', 'lesson.sections.0.items.0', 'lesson.sections.0.question', 'lesson.sections.0.answer', 'lesson.audio.0.text']);
  const explicitlyFalse = new Set(['lesson.sections.1.body', 'lesson.sections.1.items.0', 'lesson.audio.1.text']);
  for (const block of lessonSpeechBlocks(lesson)) {
    assert.equal(block.readingPauses, marked.has(block.key) ? true : explicitlyFalse.has(block.key) ? false : undefined, block.key);
    assert.equal(block.answer, block.key === 'lesson.sections.0.answer');
    const result = buildSpeechBlock(block);
    assert.equal(result.block.text, text);
    assert.deepEqual(clipTexts(result, sentences(result)[0]), [marked.has(block.key) ? 'The fox, rests.' : text]);
    for (const unit of result.units) assert.equal(unit.answer, block.answer);
  }
});

test('marked sentence speech changes, but exact source, offsets and every word survive', () => {
  const text = '  😀The fox / rests beside reeds.\nThe hare, / waits / nearby.  ';
  const options = { origin: 'generated', answer: true, translation: ' Instruction / translation ' };
  const marked = build(text, { ...options, readingPauses: true });
  const original = build(text, options);
  assert.equal(marked.block.text, text);
  assert.equal(marked.block.translation, options.translation);
  assert.deepEqual(sentences(marked).map(unit => ({ ...unit, clipIds: [] })), sentences(original).map(unit => ({ ...unit, clipIds: [] })));
  assert.deepEqual(sentences(marked).flatMap(unit => clipTexts(marked, unit)), ['The fox, rests beside reeds.', 'The hare, waits, nearby.']);
  assert.deepEqual(words(marked), words(original));
  for (const unit of words(marked)) assert.deepEqual(clipTexts(marked, unit), [unit.text]);
  assertCoverage(marked);
});

test('exported speech normalizer is explicitly opt-in and preserves existing punctuation at pauses', () => {
  assert.equal(typeof normalizeReadingPauses, 'function');
  const examples = [
    ['The fox / rests / beside reeds.', 'The fox, rests, beside reeds.'],
    ['The fox, / rests.', 'The fox, rests.'],
    ['The fox / , rests.', 'The fox, rests.'],
    ['The fox; / rests.', 'The fox; rests.'],
    ['The fox / ; rests.', 'The fox; rests.'],
    ['The fox... / rests.', 'The fox... rests.'],
    ['“The fox,” / said the hare.', '“The fox,” said the hare.'],
    ['The fox / “rests nearby.”', 'The fox, “rests nearby.”'],
    ['/ The fox / rests /', 'The fox, rests'],
    [' / The fox rests. / ', 'The fox rests.'],
    ['The fox / .', 'The fox.'],
    [' / ', ''],
    ['The fox\t/\tkeeps the word slash.', 'The fox, keeps the word slash.'],
    ['The fox\u00a0/\u00a0rests.', 'The fox, rests.'],
  ];
  for (const [source, expected] of examples) {
    assert.equal(normalizeReadingPauses(source, true), expected, source);
    assert.equal(normalizeReadingPauses(source), source);
    assert.equal(normalizeReadingPauses(source, false), source);
    assert.equal(normalizeReadingPauses(expected, true), expected, 'idempotent punctuation');
  }
});

test('meaningful slashes and unaffected IDs are preserved even in marked prose', () => {
  const examples = [
    'The fox eats 1 / 2 of a berry.',
    'The fox eats (12 / 24) of the berries.',
    'The ratio is A / B and x / y.',
    'The fox uses cat/dog and and/or as alternatives.',
    'The fox visits https://animals.test/fox?q=a/b.',
    'The fox reads /srv/fox/notes and C:\\animals\\fox.txt.',
    'The fox reads ../animals / notes and C: / animals.',
    'The fox reads /kæt/ and /ˈkæt/ and /dɒɡ/.',
    'Say / kæt / clearly.',
    'The fox keeps // and / / literal.',
    'The word slash is an ordinary word.',
    '  The fox\t rests,  beside reeds.  ',
  ];
  const hashClip = text => createHash('sha256').update(JSON.stringify(['clip', text])).digest('hex');
  for (const text of examples) {
    assert.equal(normalizeReadingPauses(text, true), text, text);
    const base = build(text);
    const marked = build(text, { origin: 'generated', readingPauses: true });
    assert.deepEqual(marked.clips, base.clips, text);
    for (const clip of base.clips) assert.equal(clip.id, hashClip(clip.text));
    assertCoverage(marked);
  }
  for (const text of ['cat / dog', 'yes / no', 'I / you / we / they']) {
    assert.equal(normalizeReadingPauses(text), text, 'alternatives must not be opted in');
    assert.deepEqual(build(text).clips, build(text, { origin: 'generated', readingPauses: false }).clips);
  }
});

test('normalized speech pieces dedupe with ordinary prose, including long bounded splits', () => {
  const markedText = 'The fox / rests beside reeds and the hare / waits nearby; '.repeat(35) + 'the otter / swims home.';
  const spokenText = 'The fox, rests beside reeds and the hare, waits nearby; '.repeat(35) + 'the otter, swims home.';
  const marked = build(markedText, { origin: 'generated', readingPauses: true });
  const ordinary = build(spokenText, { key: 'other' });
  assert.equal(marked.block.text, markedText);
  assert.deepEqual(marked.clips, ordinary.clips);
  assert.deepEqual(sentences(marked).map(unit => unit.clipIds), sentences(ordinary).map(unit => unit.clipIds));
  const pieces = sentences(marked).flatMap(unit => clipTexts(marked, unit));
  assert.ok(pieces.length > 3);
  assert.equal(pieces.join(' '), spokenText);
  assertCoverage(marked);
  assert.deepEqual(words(marked).map(unit => unit.text), words(ordinary).map(unit => unit.text));
  assert.throws(() => build('x'.repeat(501) + ' / fox', { origin: 'generated', readingPauses: true }), error => error.status === 422);
});

test('strict bounds, types, controls and Unicode validation use AppError without truncation', () => {
  const base = { key: 'k', source: 's', text: 'Text' };
  for (const patch of [
    { key: 'k'.repeat(201) }, { key: '' }, { key: 'line\nkey' }, { source: 's'.repeat(301) },
    { text: 'a '.repeat(20001) }, { text: 7 }, { source: {} }, { key: [] }, { answer: 'true' },
    { origin: 'unknown' }, { translation: 7 }, { translation: 'a'.repeat(40001) },
    { text: 'bad\u0000' }, { text: 'bad\u007f' }, { text: 'bad\u0085' }, { text: 'bad\u202e' }, { text: '\ud800' },
  ]) assert.throws(() => buildSpeechBlock({ ...base, ...patch }), AppError);
  for (const input of [null, undefined, [], 'text']) assert.throws(() => buildSpeechBlock(input), AppError);
  assert.equal(build('a '.repeat(20000), { key: 'k'.repeat(200), source: 's'.repeat(300) }).block.text.length, 40000);
  assert.throws(() => speechWords(null), AppError);
  assert.throws(() => lessonSpeechBlocks({ sections: 'bad' }), AppError);
});
