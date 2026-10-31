import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { renderLesson, escapeHtml, renderScriptHash, fullAudioRenderScriptHash } from '../lib/render.mjs';
import { buildSpeechBlock, lessonSpeechBlocks } from '../lib/speech-inventory.mjs';

const dataUrl = 'data:audio/mpeg;base64,SUQzAAAAAAAAAAAA';
const otherUrl = 'data:audio/wav;base64,UklGRgAAAAAA';
const section = overrides => ({ type: 'quiz', title: 'Practice', body: 'Read carefully.', items: [], question: 'Which animal?', answer: 'The secret answer is otter.', translation: '翻译 English', source: 'Worksheet', ...overrides });
const lesson = () => ({ title: 'Hello world.', summary: 'Read and listen.', subject: 'English', language: 'English', level: 'School', objectives: ['Read every word.'], sections: [section({})], audio: [{ text: 'Listen again.', translation: '再听一次' }], warnings: [] });
function courseFor(blocks) {
  const built = blocks.map(buildSpeechBlock);
  const clips = [...new Map(built.flatMap(item => item.clips).map(clip => [clip.id, { ...clip, dataUrl }])).values()];
  const units = built.flatMap(item => item.units);
  return { blocks: built.map(item => item.block), units, clips, summary: { totalClips: clips.length, completedClips: clips.length, totalUnits: units.length, status: 'complete' }, warnings: [] };
}
const scriptOf = html => /<script>([\s\S]*?)<\/script>/.exec(html)[1];
const count = (text, needle) => text.split(needle).length - 1;
const withoutTags = text => text.replace(/<[^>]*>/g, '');

test('all keyed generated fields and complete uploaded sources get exact word and sentence controls', () => {
  const value = lesson();
  value.sections[0].items = Array.from({ length: 12 }, (_, i) => `Item ${i} remains present.`);
  const source = 'FIRST original page.\n' + 'Unabridged paragraph.\n'.repeat(35) + 'TAIL final sentence.';
  const blocks = [...lessonSpeechBlocks(value), { key: 'source.0', text: source, source: 'Original worksheet.pdf · page 1', origin: 'uploaded', answer: false }];
  const course = courseFor(blocks);
  const html = renderLesson(value, { audioCourse: course });
  for (const block of blocks.filter(block => block.text)) {
    const unit = course.units.find(unit => unit.blockKey === block.key && unit.kind === 'sentence');
    if (unit) assert.ok(html.includes(escapeHtml(`Play sentence: ${unit.text}`)), block.key);
  }
  assert.ok(withoutTags(html).includes(source));
  assert.match(html, /Original worksheet\.pdf · page 1/);
  assert.ok(withoutTags(html).includes('Item 11 remains present.'));
  assert.match(html, /English audio coverage: \d+ \/ \d+ clips completed\. Complete\./);
  assert.equal(count(html, dataUrl), 1, 'all identical assets, including sentence/word aliases, embedded once');
  assert.equal(count(html, 'id="course-player"'), 1);
  assert.ok(!html.includes('autoplay'));
  assert.ok(!html.includes('Play all'));
  for (const speed of ['1', '0.75', '0.5']) assert.ok(html.includes(`data-speed="${speed}"`));
  for (const repeat of [1, 3, 5]) assert.ok(html.includes(`data-repeat="${repeat}"`));
  assert.match(html, /id="audio-stop"/);
  const objectivesEnd = html.indexOf('</aside>');
  const controlsStart = html.indexOf('<section class="audio-section course-controls"');
  const firstSection = html.indexOf('<section class="lesson-section');
  assert.ok(objectivesEnd < controlsStart && controlsStart < firstSection);
  const controlCss = /\.course-controls\{([^}]+)\}/.exec(html)[1];
  assert.ok(!/(?:^|;)(?:height|position):/.test(controlCss));
  assert.match(controlCss, /padding:14px 18px/);
});

test('word matching uses exact inventory tokens, repeats and Unicode boundaries', () => {
  const value = lesson();
  value.title = "cat cats cat Cat don't café co‑operate";
  const course = courseFor([{ key: 'lesson.title', text: value.title, source: 'Generated', origin: 'generated', answer: false }]);
  // Removing cats must not leave a misleading button for its cat prefix.
  course.units = course.units.filter(unit => unit.text !== 'cats');
  const html = renderLesson(value, { audioCourse: course });
  const heading = /<h1>([\s\S]*?)<\/h1>/.exec(html)[1];
  assert.equal(count(heading, 'aria-label="Play word: cat"'), 2);
  assert.equal(count(heading, 'aria-label="Play word: Cat"'), 1);
  for (const word of ["don't", 'café', 'co‑operate']) assert.ok(heading.includes(escapeHtml(`Play word: ${word}`)));
  assert.ok(!heading.includes('Play word: cats'));
  const buttons = [...heading.matchAll(/<button[^>]+data-audio-unit="word"[^>]*>(.*?)<\/button>/g)];
  assert.deepEqual(buttons.map(match => match[1]), ['cat', 'cat', 'Cat', 'don&#39;t', 'café', 'co‑operate']);
  const wordCss = /\.word-play\{([^}]+)\}/.exec(html)[1];
  assert.match(wordCss, /font:inherit/);
  assert.match(wordCss, /line-height:inherit/);
  assert.match(wordCss, /letter-spacing:inherit/);
  assert.match(wordCss, /text-decoration:underline dotted/);
  assert.ok(!/(?:^|;)(?:width|height|content):/.test(wordCss));
  assert.ok(!/\.word-play:{1,2}before/.test(html));
  assert.match(html, /\.sentence-play:before\{content:'▶'\}/);
  assert.match(html, /button:focus-visible/);
  assert.match(html, /@media print\{\.sentence-play,\.course-controls\{display:none\}\.word-play\{color:inherit;background:none;text-decoration:none\}\}/);
  assert.equal(withoutTags(heading), escapeHtml(value.title));
  assert.ok(!/<button[^>]*>(?:(?!<\/button>)[\s\S])*<button/.test(heading));
});

test('word labels preserve punctuation, whitespace and disabled text without nested controls', () => {
  const value = lesson();
  value.title = '“Hello,” world!\nHello & café';
  const course = courseFor([{ key: 'lesson.title', text: value.title, source: 'Generated', origin: 'generated', answer: false }]);
  const word = course.units.find(unit => unit.kind === 'word' && unit.text === 'Hello');
  course.clips.find(clip => clip.id === word.clipIds[0]).dataUrl = undefined;
  const html = renderLesson(value, { audioCourse: course });
  const heading = /<h1>([\s\S]*?)<\/h1>/.exec(html)[1];
  assert.equal(withoutTags(heading), escapeHtml(value.title));
  assert.match(heading, /^“<button[^>]* disabled[^>]*>Hello<\/button>,” /);
  assert.match(heading, />world<\/button>!<button[^>]*data-audio-unit="sentence"[^>]*><\/button>\n/);
  assert.match(heading, />café<\/button><button[^>]*data-audio-unit="sentence"[^>]*><\/button>$/);
  assert.ok(!/<button[^>]*>(?:(?!<\/button>)[\s\S])*<button/.test(heading));
  assert.match(html, /\.word-play:disabled\{color:inherit;opacity:1;text-decoration:none;cursor:text\}/);
});

test('unfinished, invalid and multi-chunk assets cannot be played or claimed complete', () => {
  const value = lesson();
  const course = courseFor(lessonSpeechBlocks(value));
  const target = course.units.find(unit => unit.blockKey === 'lesson.title' && unit.kind === 'sentence');
  target.clipIds.push('deadbeef');
  course.clips.push({ id: 'deadbeef', text: 'unfinished' });
  const html = renderLesson(value, { audioCourse: course });
  assert.match(html, /Incomplete —/);
  assert.ok(!html.includes('clips completed. Complete.'));
  const button = html.match(/<button[^>]+aria-label="Audio not ready for sentence: Hello world\."[^>]*>/)[0];
  assert.match(button, / disabled/);
  assert.ok(!button.includes('data-clips'));
  course.clips.at(-1).dataUrl = otherUrl;
  const ready = renderLesson(value, { audioCourse: course });
  assert.match(ready, /data-clips="a0 a1" aria-label="Play sentence: Hello world\."/);
  course.summary.status = 'collecting';
  assert.match(renderLesson(value, { audioCourse: course }), /Incomplete —/);
});

test('hostile text, metadata, IDs, and URLs are escaped or rejected; actual static script matches CSP', () => {
  const payload = '</script><img src="https://evil.test" onerror="alert(1)">';
  const value = lesson();
  value.sections[0].body = payload;
  value.sections[0].type = 'quiz" onclick="evil()';
  const course = courseFor([{ key: 'lesson.sections.0.body', text: payload, source: payload, origin: 'generated', answer: false }, { key: payload, text: 'Uploaded safely.', source: payload, origin: 'uploaded', answer: false }]);
  course.warnings = [payload];
  const badUrls = ['https://evil.test/a.mp3', 'javascript:evil()', 'data:text/html;base64,PHNjcmlwdD4=', 'data:audio/svg+xml;base64,AAAA', 'data:audio/mpeg;base64,AAAA" onerror="evil()', 'data:audio/mpeg;base64,!!!', 'data:audio/mpeg;base64,'];
  course.clips = badUrls.map((url, i) => ({ id: i.toString(16), text: payload, dataUrl: url }));
  course.clips.push({ id: '\" onclick=evil()', text: payload, dataUrl });
  course.units.forEach(unit => { unit.id = payload; unit.clipIds = ['\" onclick=evil()']; });
  const html = renderLesson(value, { audioCourse: course });
  assert.equal(count(html, '<script>'), 1);
  assert.ok(html.includes(escapeHtml(payload)));
  assert.ok(!html.includes('<img src="https:'));
  assert.ok(!html.includes('src="javascript:'));
  assert.ok(!html.includes('data-asset="a0"'));
  assert.match(html, /type-quiz&quot; onclick=&quot;evil\(\)/);
  const script = scriptOf(html);
  assert.ok(!script.includes(payload));
  assert.ok(!/fetch\(|speechSynthesis|https?:|JSON\.parse/.test(script));
  const hash = 'sha256-' + createHash('sha256').update(script).digest('base64');
  assert.equal(hash, fullAudioRenderScriptHash);
  assert.notEqual(fullAudioRenderScriptHash, renderScriptHash);
  assert.ok(html.includes(`script-src '${fullAudioRenderScriptHash}'`));
  const second = renderLesson(lesson(), { audioCourse: courseFor(lessonSpeechBlocks(lesson())) });
  assert.equal('sha256-' + createHash('sha256').update(scriptOf(second)).digest('base64'), fullAudioRenderScriptHash);
  for (const directive of ["default-src 'none'", "connect-src 'none'", 'media-src data:', "base-uri 'none'", "form-action 'none'"]) assert.ok(html.includes(directive));
});

test('answers stay inside closed details, with no always-visible audio answer bank', () => {
  const value = lesson();
  value.audio.push({ text: value.sections[0].answer, translation: '答案' });
  const html = renderLesson(value, { audioCourse: courseFor(lessonSpeechBlocks(value)) });
  const tokens = html.match(/<[^>]+>|[^<]+/g);
  let depth = 0;
  for (const token of tokens) {
    if (/^<details(?:\s|>)/.test(token)) { assert.ok(!/\sopen(?:\s|=|>)/.test(token)); depth++; }
    if (token.includes('Play sentence: The secret answer is otter.') || token.includes('Play word: otter') || token.includes('The secret answer is otter.')) assert.ok(depth > 0, token);
    if (token === '</details>') depth--;
  }
  assert.equal(depth, 0);
});

test('reading-pause audio preserves rendered slashes, word controls, source offsets and hidden answers', () => {
  const value = lesson();
  value.sections[0] = section({
    title: 'Read / listen', body: 'The fox / rests beside reeds.',
    items: ['The hare / waits nearby.'], question: 'Where does the otter / swim?',
    answer: 'The otter / swims home.', translation: 'Instruction / translation', readingPauses: true,
  });
  value.audio = [{ text: value.sections[0].answer, translation: 'Answer / translation', readingPauses: true }];
  const before = structuredClone(value);
  const course = courseFor(lessonSpeechBlocks(value));
  const html = renderLesson(value, { audioCourse: course });
  assert.deepEqual(value, before);
  for (const field of ['body', 'question', 'answer']) {
    const block = course.blocks.find(block => block.key === 'lesson.sections.0.' + field);
    const unit = course.units.find(unit => unit.blockKey === block.key && unit.kind === 'sentence');
    assert.equal(block.text, value.sections[0][field]);
    assert.equal(block.text.slice(unit.start, unit.end), unit.text);
    assert.equal(unit.answer, field === 'answer');
    assert.ok(html.includes(escapeHtml('Play sentence: ' + unit.text)));
    const clip = course.clips.find(clip => clip.id === unit.clipIds[0]);
    assert.equal(clip.text, unit.text.replace(' / ', ', '));
  }
  const sectionHtml = /<section class="lesson-section type-quiz">([\s\S]*?)<\/section>/.exec(html)[1];
  const body = /<p>([\s\S]*?)<\/p>/.exec(sectionHtml)[1];
  assert.equal(withoutTags(body), escapeHtml(value.sections[0].body));
  assert.ok(body.includes(' / '));
  for (const word of ['The', 'fox', 'rests', 'beside', 'reeds']) assert.ok(body.includes(escapeHtml('Play word: ' + word)));
  const tokens = html.match(/<[^>]+>|[^<]+/g);
  let depth = 0, answerControls = 0;
  for (const token of tokens) {
    if (/^<details(?:\s|>)/.test(token)) { assert.ok(!/\sopen(?:\s|=|>)/.test(token)); depth++; }
    if (token.includes('Play sentence: The otter / swims home.') || token.includes('Play word: swims')) {
      answerControls++;
      assert.ok(depth > 0, token);
    }
    if (token === '</details>') depth--;
  }
  assert.ok(answerControls >= 2);
  assert.equal(depth, 0);
  assert.equal('sha256-' + createHash('sha256').update(scriptOf(html)).digest('base64'), fullAudioRenderScriptHash);
});

test('missing matching blocks render unchanged; legacy audio and CSP remain compatible', () => {
  const value = lesson();
  const legacy = renderLesson(value, { audio: [{ text: 'Legacy.', dataUrl }] });
  assert.match(legacy, /<audio controls preload="none" aria-label="Sentence 1" src="data:audio\/mpeg;base64,/);
  assert.equal('sha256-' + createHash('sha256').update(scriptOf(legacy)).digest('base64'), renderScriptHash);
  assert.ok(!renderLesson(value).includes('<audio'));
  const course = courseFor([{ key: 'lesson.title', text: 'Wrong text.', source: 'Generated', origin: 'generated', answer: false }]);
  const html = renderLesson(value, { audioCourse: course, audio: [{ text: 'Legacy.', dataUrl }] });
  assert.match(html, /<h1>Hello world\.<\/h1>/);
  assert.equal(count(html, dataUrl), 1, 'legacy and course share asset storage');
  assert.match(html, /<audio controls[^>]+data-legacy-asset="a0"/);
});

// A deterministic DOM/media double tests asynchronous cancellation without any
// browser, provider, network, timers, or real sound device.
class Node {
  constructor(dataset = {}) { this.dataset = dataset; this.listeners = new Map(); this.attrs = new Map(); this.textContent = ''; this.disabled = false; }
  addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn); }
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
  emit(type, event = {}) { for (const fn of [...(this.listeners.get(type) || [])]) fn(event); }
  setAttribute(key, value) { this.attrs.set(key, value); }
  removeAttribute(key) { this.attrs.delete(key); if (key === 'src') this.src = ''; }
  getAttribute(key) { return this.attrs.get(key); }
}
class Audio extends Node {
  constructor() { super(); this.src = ''; this.paused = true; this.ended = false; this.plays = []; }
  pause() { this.paused = true; }
  load() { this.ended = false; }
  play() {
    this.paused = false; this.emit('play');
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    this.plays.push({ src: this.src, resolve, reject });
    return promise;
  }
  finish() { this.ended = true; this.emit('ended'); }
}
function harness() {
  const player = new Audio(), legacy = new Audio(), status = new Node(), stop = new Node();
  const first = new Node({ clips: 'a0 a1' }), second = new Node({ clips: 'a1' });
  const speeds = [1, .75, .5].map(speed => new Node({ speed: String(speed) }));
  const repeats = [1, 3, 5].map(repeat => new Node({ repeat: String(repeat) }));
  const details = new Node(); details.open = true; details.contains = node => node === first; details.querySelectorAll = () => [];
  const assets = [dataUrl, otherUrl].map((src, i) => { const node = new Node({ asset: `a${i}` }); node.setAttribute('src', src); return node; });
  const document = new Node();
  document.getElementById = id => ({ 'course-player': player, 'audio-status': status, 'audio-stop': stop, 'audio-assets': { content: { querySelectorAll: () => assets } } })[id];
  document.querySelectorAll = selector => ({ '[data-speed]': speeds, 'audio': [player, legacy], '[data-audio-unit]': [first, second], '[data-repeat]': repeats, 'audio[controls]': [legacy], 'audio[data-legacy-asset]': [], 'details': [details] })[selector] || [];
  const window = new Node(), parent = {};
  vm.runInNewContext(scriptOf(renderLesson(lesson(), { audioCourse: courseFor(lessonSpeechBlocks(lesson())) })), { document, window, parent });
  return { player, legacy, status, stop, first, second, speeds, repeats, details, document, window, parent };
}

test('chunks and repetitions play sequentially, speed persists, and no autoplay occurs', () => {
  const h = harness();
  assert.equal(h.player.plays.length, 0);
  h.repeats[1].emit('click'); h.speeds[2].emit('click'); h.first.emit('click');
  for (let i = 0; i < 6; i++) {
    assert.equal(h.player.plays[i].src, i % 2 ? otherUrl : dataUrl);
    assert.equal(h.player.playbackRate, .5);
    h.player.finish();
  }
  assert.equal(h.player.plays.length, 6);
  assert.equal(h.player.paused, true);
  assert.equal(h.status.textContent, 'Finished.');
});

test('rapid clicks, stale ended callbacks and rejected promises cannot resurrect old queues', async () => {
  const h = harness();
  h.first.emit('click');
  const oldEnded = [...h.player.listeners.get('ended')][0];
  const oldPlay = h.player.plays[0];
  h.second.emit('click');
  h.player.ended = true; oldEnded();
  oldPlay.reject(new Error('stale play'));
  await Promise.resolve();
  assert.equal(h.player.plays.length, 2);
  assert.equal(h.player.src, otherUrl);
  assert.equal(h.player.paused, false);
  h.stop.emit('click'); h.player.finish();
  assert.equal(h.player.plays.length, 2);
  assert.equal(h.player.src, '');
  assert.equal(h.status.textContent, 'Stopped.');
});

test('chunk promise callbacks are guarded independently and errors clear playback', async () => {
  const h = harness(); h.first.emit('click');
  const oldPlay = h.player.plays[0]; h.player.finish();
  oldPlay.reject(new Error('old chunk')); await Promise.resolve();
  assert.equal(h.player.src, otherUrl);
  h.player.emit('error');
  assert.equal(h.player.src, '');
  assert.equal(h.player.paused, true);
  assert.match(h.status.textContent, /Audio unavailable/);
  h.first.emit('click'); h.player.plays.at(-1).reject(new Error('blocked')); await Promise.resolve();
  assert.equal(h.player.src, '');
});

test('stop on lifecycle, containing details collapse, parent-only message and legacy playback', () => {
  const h = harness();
  h.first.emit('click');
  h.window.emit('message', { source: {}, data: { type: 'learnlens-stop-audio' } });
  assert.equal(h.player.paused, false);
  h.window.emit('message', { source: h.parent, data: { type: 'play-audio' } });
  assert.equal(h.player.paused, false);
  h.window.emit('message', { source: h.parent, data: { type: 'learnlens-stop-audio' } });
  assert.equal(h.player.paused, true);
  h.first.emit('click'); h.details.open = false; h.details.emit('toggle'); assert.equal(h.player.paused, true);
  h.second.emit('click'); h.details.emit('toggle'); assert.equal(h.player.paused, false);
  h.document.hidden = true; h.document.emit('visibilitychange'); assert.equal(h.player.paused, true);
  h.first.emit('click'); h.window.emit('pagehide'); assert.equal(h.player.paused, true);
  h.first.emit('click'); h.legacy.play(); assert.equal(h.player.paused, true); assert.equal(h.legacy.paused, false);
  h.second.emit('click'); assert.equal(h.legacy.paused, true); assert.equal(h.player.paused, false);
  h.legacy.play(); h.details.querySelectorAll = () => [h.legacy]; h.details.emit('toggle'); assert.equal(h.legacy.paused, true);
});
