// A separate, lossless inventory of extracted originals, never lesson digests.
// Coverage describes extraction, not a promise that a document/media import is perfect.
export const AUDIO_SOURCE_MAX_CHARS = 40000; // UTF-16 code units per descriptor
export const AUDIO_SOURCE_MAX_BYTES = 64 * 1024 * 1024; // UTF-8 source text, including pending slices
export const TRANSCRIPTION_WARNING = 'Speech is automatically transcribed and may omit words, names or equations.';
export const VISION_WARNING = 'English text is automatically extracted from this image and may omit or misread words, layout or equations; verify against the original.';
const encoder = new TextEncoder();
const high = value => /[\uD800-\uDBFF]/.test(value || '');
const low = value => /[\uDC00-\uDFFF]/.test(value || '');
const whitespace = value => value !== undefined && /\s/u.test(value);
const cjk = value => /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(value);
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const warningsOf = warnings => [...new Set((warnings || []).map(String))];
const checkIndex = index => {
  if (!Number.isSafeInteger(index) || index < 0) throw new Error('Audio source indexes must be nonnegative safe integers.');
};
const label = source => {
  let end = Math.min(String(source).length, 300);
  if (high(String(source)[end - 1]) && low(String(source)[end])) end--;
  return String(source).slice(0, end);
};

// Never trim, insert separators, split a word/surrogate pair, or discard a tail.
export function splitAudioText(text, maxChars = AUDIO_SOURCE_MAX_CHARS) {
  if (typeof text !== 'string') throw new TypeError('Audio source text must be a string.');
  if (!Number.isInteger(maxChars) || maxChars < 2 || maxChars > AUDIO_SOURCE_MAX_CHARS) throw new RangeError('Invalid audio source block size.');
  if (!text.length) return [''];
  const blocks = [];
  // Lazy segmentation keeps ordinary short descriptors cheap. Candidate breaks
  // must be whole graphemes, including supplementary Han and variation selectors.
  let graphemes;
  for (let start = 0; start < text.length;) {
    let end = Math.min(text.length, start + maxChars);
    if (end < text.length) {
      let wordBoundary = 0, preferredBoundary = 0;
      for (let boundary = end; boundary > start; boundary--) {
        if (high(text[boundary - 1]) && low(text[boundary])) continue;
        const before = text.slice(boundary - (low(text[boundary - 1]) && high(text[boundary - 2]) ? 2 : 1), boundary);
        const after = String.fromCodePoint(text.codePointAt(boundary));
        const sentenceEnd = /[。！？]/u.test(before);
        const spaced = whitespace(before) || whitespace(after);
        // CJK does not require spaces between words. Allow grapheme boundaries
        // beside CJK, but never introduce a break inside an embedded Latin word.
        if (!spaced && !sentenceEnd && !cjk(before) && !cjk(after)) continue;
        const preferred = sentenceEnd || /[\r\n]/.test(before) ||
          (whitespace(before) && /[.!?。！？]/u.test(text[boundary - 2] || ''));
        if (wordBoundary && !preferred) continue;
        graphemes ||= graphemeSegmenter.segment(text);
        if (graphemes.containing(boundary).index !== boundary) continue;
        wordBoundary ||= boundary;
        if (preferred) {
          preferredBoundary = boundary; break;
        }
      }
      end = preferredBoundary || wordBoundary;
      if (!end) throw new Error(`Audio source contains an unbroken token longer than ${maxChars} UTF-16 characters. Split that token locally before continuing; no source text was truncated.`);
    }
    blocks.push(text.slice(start, end)); start = end;
  }
  return blocks;
}

// TXT/MD (including manually pasted material) and Office imports are contiguous
// slices, sometimes midword. PDF pages and media segments are independent sources.
export function isContiguousAudioText(item) {
  return item.kind === 'text' || (item.kind === 'document' && /\.(docx|pptx)$/i.test(item.name || ''));
}

export function validateVisionExtraction(result) {
  if (!result || typeof result.text !== 'string' || !Array.isArray(result.warnings) ||
      result.warnings.some(warning => typeof warning !== 'string') ||
      !['complete', 'uncertain', 'no_english'].includes(result.coverage)) {
    throw new Error('The provider returned an invalid English-text extraction result. Confirm consent again before continuing; no automatic retry was made.');
  }
  return result;
}

export class AudioSourceCollector {
  constructor({ maxBytes = AUDIO_SOURCE_MAX_BYTES } = {}) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > AUDIO_SOURCE_MAX_BYTES) throw new RangeError('Invalid audio source retention limit.');
    this.maxBytes = maxBytes; this.retainedBytes = 0; this.sources = []; this.current = null;
  }
  beginItem({ key, source, contiguous = false }) {
    if (this.current) throw new Error('Finish the previous audio source item first.');
    // The caller supplies an opaque identity (in the workspace, SHA-256 of item.id).
    if (typeof key !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(key)) throw new Error('Audio item identity must be opaque and printable.');
    this.current = { key, source: label(source), contiguous, slices: [], warnings: [], count: 0, lastCharacter: '', hasOriginalSource: false };
  }
  reserve(text, adjustment = 0) {
    if (typeof text !== 'string') throw new TypeError('Audio source text must be a string.');
    const bytes = encoder.encode(text).byteLength + adjustment;
    if (this.retainedBytes + bytes > this.maxBytes) throw new Error('Full audio sources exceed the 64 MiB UTF-8 retained-text limit (or the configured smaller local limit). No text was truncated. Reduce the attached material before continuing.');
    this.retainedBytes += bytes;
  }
  emit({ key, text, source, extraction, coverage, warnings = [] }) {
    const blocks = splitAudioText(text);
    for (let index = 0; index < blocks.length; index++) this.sources.push({
      key: `audio:${this.current.key}:${key}:block:${index}`,
      text: blocks[index], source: label(source), origin: 'uploaded', extraction, coverage, warnings: warningsOf(warnings)
    });
  }
  addPart({ index, text = '', source, warnings = [], hasAlternativeExtraction = false }) {
    const current = this.current;
    checkIndex(index);
    if (!current || index !== current.count) throw new Error('Audio source parts must be collected in original order.');
    // Adjacent slices can even divide a surrogate pair. Count its joined UTF-8
    // representation, not two replacement characters (6 bytes instead of 4).
    const adjustment = current.contiguous && high(current.lastCharacter) && low(text[0]) ? -2 : 0;
    const readable = Boolean(text.trim());
    const hasOriginalSource = readable || !hasAlternativeExtraction;
    current.hasOriginalSource ||= hasOriginalSource;
    // An audio/image-only part is represented by its later extraction descriptors,
    // not a spurious missing-text-layer descriptor. Keep contiguous whitespace
    // until the item finishes, since it may separate surrounding original words.
    if (current.contiguous || hasOriginalSource) this.reserve(text, adjustment);
    current.count++;
    if (current.contiguous) {
      current.slices.push(text); current.warnings = warningsOf([...current.warnings, ...warnings]);
      if (text.length) current.lastCharacter = text.at(-1);
      if (!readable && !hasAlternativeExtraction) this.emit({ key: `part:${index}:empty`, text: '', source, extraction: 'unavailable', coverage: 'unavailable', warnings: [...warnings, 'This part has no readable original text.'] });
    } else if (hasOriginalSource) {
      this.emit({ key: `part:${index}:text`, text, source, extraction: text.trim() ? 'text' : 'unavailable', coverage: text.trim() ? (warnings.length ? 'uncertain' : 'complete') : 'unavailable', warnings: text.trim() ? warnings : [...warnings, 'This part has no readable original text.'] });
    }
  }
  addTranscription({ index, text, source, warnings = [] }) {
    checkIndex(index);
    if (!this.current || index >= this.current.count) throw new Error('Collect the original part before its transcription.');
    this.reserve(text);
    this.emit({ key: `part:${index}:transcription`, text, source, extraction: 'transcription', coverage: 'uncertain', warnings: [...warnings, TRANSCRIPTION_WARNING] });
  }
  addVision({ index, imageIndex, result, source, warnings = [] }) {
    checkIndex(index); checkIndex(imageIndex);
    if (!this.current || index >= this.current.count) throw new Error('Collect the original part before its images.');
    validateVisionExtraction(result); this.reserve(result.text);
    // Even a provider's "complete" OCR report is not verified verbatim coverage.
    this.emit({ key: `part:${index}:image:${imageIndex}`, text: result.text, source, extraction: 'vision', coverage: result.coverage === 'no_english' ? 'no_english' : 'uncertain', warnings: [...warnings, ...result.warnings, VISION_WARNING] });
  }
  endItem() {
    const current = this.current;
    if (!current) throw new Error('No audio source item is active.');
    if (current.contiguous) {
      const text = current.slices.join('');
      if (current.hasOriginalSource) this.emit({ key: 'text', text, source: `${current.source} · original text (parts 1–${current.count})`, extraction: text.trim() ? 'text' : 'unavailable', coverage: text.trim() ? (current.warnings.length ? 'uncertain' : 'complete') : 'unavailable', warnings: current.warnings });
      else this.retainedBytes -= encoder.encode(text).byteLength;
    }
    this.current = null; // Only plaintext descriptors survive; never retain part/image objects.
  }
  finish() {
    if (this.current) throw new Error('Finish the current audio source item first.');
    return this.sources;
  }
}
