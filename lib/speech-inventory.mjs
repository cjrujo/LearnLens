import { createHash } from 'node:crypto';
import { AppError } from './provider.mjs';

// English/Latin-script targeting, NOT language detection. Latin-script French,
// Spanish, etc. are indistinguishable here; native English Kokoro may mispronounce them.
const MAX_TEXT = 40_000;
const MAX_CLIP = 500;
const latinLetter = /\p{Script=Latin}/u;
const letter = /\p{L}/u;
const mark = /\p{M}/u;
const latinMark = /[\p{Script_Extensions=Latin}\p{Script_Extensions=Inherited}]/u;
// Include digits in exact keyword forms (GPT-4, 3D, CO2); filter pure numbers below.
const wordPattern = /[\p{Script=Latin}0-9][\p{Script=Latin}\p{M}0-9]*(?:['’ʼ\-‐‑][\p{Script=Latin}0-9][\p{Script=Latin}\p{M}0-9]*)*/gu;
const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
const commonAbbreviation = /(?:\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|Mt|vs|etc|e\.g|i\.e)|\b[A-Z])\.$/i;

function checkString(value, label, max, multiline = false, required = false) {
  // OCR/PDF soft hyphens and zero-width spaces are retained in content, not metadata.
  // Other format controls (including bidi overrides) remain invalid.
  const controls = multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]|(?![\u00ad\u200b])\p{Cf}/u : /[\p{Cc}\p{Cf}\u2028\u2029]/u;
  if (typeof value !== 'string' || value.length > max || controls.test(value) || /[\uD800-\uDFFF]/u.test(value) || (required && !value.trim())) {
    throw new AppError(`${label} must be ${required ? 'non-empty ' : ''}text with no unsafe controls or invalid Unicode, at most ${max} UTF-16 characters.`);
  }
  return value; // Never normalize, trim, summarize, or truncate source fields.
}

function descriptor({ key, text, source, origin = 'uploaded', answer = false, translation = '' }) {
  checkString(key, 'Speech block key', 200, false, true);
  checkString(source, 'Speech source', 300);
  checkString(text, 'Speech text (batch longer sources)', MAX_TEXT, true);
  checkString(translation, 'Speech translation', MAX_TEXT, true);
  if (!['uploaded', 'generated'].includes(origin)) throw new AppError('Speech origin must be uploaded or generated.');
  if (typeof answer !== 'boolean') throw new AppError('Speech answer flag must be a boolean.');
  return { key, text, source, origin, answer, translation };
}

function hash(...parts) {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

// A run contains Latin letters with their combining marks and neutral punctuation.
// Other scripts (including their digits/marks) are boundaries, never speech input.
// U+00AD/U+200B also form nonspoken boundaries: unknown source hyphenation cannot
// be reconstructed reliably. We do not join fragments or guarantee pronunciation.
function latinRuns(text) {
  const runs = [];
  let start = 0, offset = 0, hasLatin = false, attachedLatin = false, skipped = false;
  const flush = end => { if (hasLatin) runs.push({ start, end }); hasLatin = false; };
  for (const char of text) {
    const isLatin = latinLetter.test(char) && letter.test(char);
    const isMark = mark.test(char) && latinMark.test(char) && attachedLatin;
    const neutral = /^[\x20-\x40\x5b-\x60\x7b-\x7e\t\r\n\u00a0\u02bc\u2010-\u2015\u2018-\u201f\u2022\u2026\u2028\u2029]$/u.test(char);
    if (isLatin || isMark || neutral) {
      hasLatin ||= isLatin;
      attachedLatin = isLatin || isMark;
    } else {
      flush(offset);
      start = offset + char.length;
      attachedLatin = false;
      skipped = true;
    }
    offset += char.length;
  }
  flush(offset);
  return { runs, skipped };
}

/** Exact UTF-16 spans for every English/Latin-script word, including repeats. */
export function speechWords(text) {
  checkString(text, 'Speech text (batch longer sources)', MAX_TEXT, true);
  const words = [];
  for (const run of latinRuns(text).runs) {
    for (const match of text.slice(run.start, run.end).matchAll(wordPattern)) {
      if (!latinLetter.test(match[0])) continue;
      const start = run.start + match.index;
      words.push({ text: match[0], start, end: start + match[0].length });
    }
  }
  return words;
}

function sentenceRanges(text, run) {
  const result = [];
  // Newlines are phrase boundaries even when the source omits punctuation.
  const lines = text.slice(run.start, run.end).matchAll(/[^\r\n\u2028\u2029]+/gu);
  for (const line of lines) {
    let pending = null;
    for (const segment of segmenter.segment(line[0])) {
      const start = run.start + line.index + segment.index;
      const end = start + segment.segment.length;
      if (pending && commonAbbreviation.test(text.slice(pending.start, pending.end).trimEnd())) pending.end = end;
      else {
        if (pending) result.push(pending);
        pending = { start, end };
      }
    }
    if (pending) result.push(pending);
  }
  return result.map(({ start, end }) => {
    const raw = text.slice(start, end);
    start += raw.length - raw.trimStart().length;
    end -= raw.length - raw.trimEnd().length;
    return { start, end };
  }).filter(({ start, end }) => /\p{Script=Latin}/u.test(text.slice(start, end)));
}

function speechPieces(text) {
  // Whitespace boundaries are Unicode-safe and never split a word or grapheme.
  // Retain internal whitespace; only separators between clips are omitted.
  const pieces = [];
  let pending = '', pendingEnd = 0;
  for (const match of text.matchAll(/\S+/gu)) {
    const token = match[0];
    if (token.length > MAX_CLIP) throw new AppError('Speech extraction resource limit: an unbroken token exceeds 500 UTF-16 characters. Split that token before narration.', 422);
    const gap = pending ? text.slice(pendingEnd, match.index) : '';
    if (pending && pending.length + gap.length + token.length > MAX_CLIP) {
      pieces.push(pending);
      pending = token;
    } else pending += gap + token;
    pendingEnd = match.index + token.length;
  }
  if (pending) pieces.push(pending);
  return pieces;
}

/** Inventory all sentence/phrase spans and ALL distinct exact word forms. */
export function buildSpeechBlock(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AppError('Speech block must be an object.');
  const block = descriptor(input);
  const { key, text, source, origin, answer } = block;
  const units = [], clips = new Map(), warnings = [];
  const metadata = { blockKey: key, answer, source, origin };
  const clipIds = value => speechPieces(value).map(piece => {
    const id = hash('clip', piece);
    if (!clips.has(id)) clips.set(id, { id, text: piece });
    return id;
  });
  const { runs, skipped } = latinRuns(text);
  if (/[\u00ad\u200b]/u.test(text)) warnings.push('Source soft hyphens (U+00AD) or zero-width spaces (U+200B) are retained as nonspoken boundaries. Fragments are not joined; unknown source hyphenation may affect pronunciation.');
  if (skipped) warnings.push('English/Latin-script speech coverage only: non-Latin text or unsupported symbols were skipped. Original block text is retained; non-Latin translations are not narrated. Latin script does not guarantee English.');
  for (const run of runs) {
    for (const { start, end } of sentenceRanges(text, run)) {
      const value = text.slice(start, end);
      units.push({ id: hash('sentence', key, start, end, value), ...metadata, start, end, text: value, kind: 'sentence', clipIds: clipIds(value) });
    }
  }
  const seen = new Set();
  for (const word of speechWords(text)) {
    if (seen.has(word.text)) continue;
    seen.add(word.text);
    units.push({ id: hash('word', key, word.text), ...metadata, text: word.text, kind: 'word', clipIds: clipIds(word.text) });
  }
  return { block, units, clips: [...clips.values()], warnings };
}

/** Generated source descriptors, not a selected sample of lesson.audio. */
export function lessonSpeechBlocks(lesson) {
  if (!lesson || typeof lesson !== 'object' || Array.isArray(lesson)) throw new AppError('Lesson must be an object.');
  const blocks = [];
  const add = (key, text, label, answer = false, translation = '') => {
    if (text === undefined || text === null) return;
    blocks.push(descriptor({ key, text, source: `Generated lesson: ${lesson.title || 'Untitled'} · ${label}`, origin: 'generated', answer, translation }));
  };
  const list = (value, label) => {
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw new AppError(`${label} must be an array.`);
    return value;
  };
  add('lesson.title', lesson.title, 'title');
  add('lesson.summary', lesson.summary, 'summary');
  list(lesson.objectives, 'Lesson objectives').forEach((text, i) => add(`lesson.objectives.${i}`, text, `objective ${i + 1}`));
  list(lesson.sections, 'Lesson sections').forEach((section, i) => {
    if (!section || typeof section !== 'object' || Array.isArray(section)) throw new AppError('Lesson section must be an object.');
    for (const field of ['title', 'body', 'question', 'answer', 'translation']) {
      // A section translation may cover multiple fields: do not guess alignment.
      add(`lesson.sections.${i}.${field}`, section[field], `section ${i + 1} ${field}`, field === 'answer');
    }
    list(section.items, 'Section items').forEach((text, j) => add(`lesson.sections.${i}.items.${j}`, text, `section ${i + 1} item ${j + 1}`));
  });
  list(lesson.audio, 'Lesson audio').forEach((audio, i) => {
    if (!audio || typeof audio !== 'object' || Array.isArray(audio)) throw new AppError('Lesson audio entry must be an object.');
    // Only audio explicitly supplies a translation paired to this whole block.
    add(`lesson.audio.${i}.text`, audio.text, `audio ${i + 1}`, false, audio.translation ?? '');
  });
  return blocks;
}
