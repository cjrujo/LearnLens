import fs from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { downloadSourceFile, normalizeSourceUrl } from './source-fetch.mjs';
import { extractWebText, decodeSourceText, isUnusableWebText, WebExtractError, WEB_LIMITS, WEB_WARNINGS } from './web-extract.mjs';
import { AppError } from './provider.mjs';

const MiB = 1024 * 1024, MAX_BYTES = 1024 * MiB, DOCUMENT_BYTES = 100 * MiB;
const EXTENSIONS = new Set(['html', 'txt', 'md', 'pdf', 'docx', 'pptx', 'mp3', 'mp4', 'webm', 'wav', 'ogg']);
const TEXT = new Set(['html', 'txt', 'md']), DOCUMENT = new Set(['pdf', 'docx', 'pptx']);
const MIME = new Map([
  ['text/html', 'html'], ['application/xhtml+xml', 'html'], ['text/plain', 'txt'], ['text/markdown', 'md'], ['text/x-markdown', 'md'],
  ['application/pdf', 'pdf'], ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx'],
  ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'pptx'],
  ['audio/mpeg', 'mp3'], ['audio/mp3', 'mp3'], ['video/mp4', 'mp4'], ['audio/mp4', 'mp4'],
  ['video/webm', 'webm'], ['audio/webm', 'webm'], ['audio/wav', 'wav'], ['audio/wave', 'wav'], ['audio/x-wav', 'wav'],
  ['audio/ogg', 'ogg'], ['video/ogg', 'ogg'], ['application/ogg', 'ogg'],
]);
const GENERIC = new Set(['application/octet-stream', 'binary/octet-stream']);
const PRIVACY = 'Citation links omit query parameters and fragments; the original request URL remains private.';
const ORIGINAL = 'The downloaded original is retained unchanged. Document or media validity is checked again during local preparation.';
const LINKED = 'Selected the only static native video resource. Both the original HTML and media are retained; scripts, images and embedded players were not loaded.';
const safeErrors = new WeakSet();
function failure(message, status = 422) { const error = new AppError(message, status); safeErrors.add(error); return error; }
const unsupported = () => failure('Source MIME type, signature and filename do not identify a supported text, document or media format.', 415);
const oversized = () => failure('Source exceeds the shared import byte budget or format limit.', 413);
function safeFailure(error) {
  if (safeErrors.has(error) || error instanceof WebExtractError) return error;
  const status = [400, 413, 415, 422, 499, 503, 504].includes(error?.status) ? error.status : 502;
  return failure('URL source import failed. No automatic retry was made.', status);
}
export function sourceCitationUrl(value) {
  const url = new URL(normalizeSourceUrl(value));
  url.search = ''; url.hash = '';
  return url.href;
}
function hintFor(value) {
  let path;
  try { path = decodeURIComponent(new URL(value).pathname); } catch { throw unsupported(); }
  const extension = /\.([a-z0-9]+)$/i.exec(path)?.[1].toLowerCase();
  const alias = { htm: 'html', markdown: 'md', wave: 'wav' }[extension] || extension;
  return EXTENSIONS.has(alias) ? alias : null;
}
function typeFor(value) {
  if (typeof value !== 'string' || value.length > 1024) throw unsupported();
  const type = value.split(';', 1)[0].trim().toLowerCase();
  if (!MIME.has(type) && !GENERIC.has(type)) throw unsupported();
  return type;
}
function htmlSignature(bytes) {
  let text;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) text = new TextDecoder('utf-16le').decode(bytes.subarray(2));
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) text = new TextDecoder('utf-16be').decode(bytes.subarray(2));
  else text = bytes.toString('utf8');
  text = text.replace(/^\uFEFF/, '').replace(/^\s*<\?xml[^>]*\?>/i, '');
  return /^\s*(?:<!doctype\s+html\b|<!--|<(?:html|head|body|title|meta|script|style|main|article|section|div|span|p|h[1-6]|ul|ol|table|video|audio)\b)/i.test(text);
}
function signature(bytes, size) {
  // UTF-16LE BOM bytes can otherwise resemble an MPEG frame sync word.
  if (bytes[0] === 0xff && bytes[1] === 0xfe || bytes[0] === 0xfe && bytes[1] === 0xff) return htmlSignature(bytes) ? 'html' : null;
  if (bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) return 'pdf';
  if (bytes.length >= 4 && bytes.readUInt32LE(0) === 0x04034b50) return 'zip';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WAVE') return 'wav';
  if (bytes.length >= 27 && bytes.toString('ascii', 0, 4) === 'OggS' && bytes[4] === 0) return 'ogg';
  if (bytes.length >= 10 && bytes.toString('ascii', 0, 3) === 'ID3' && [2, 3, 4].includes(bytes[3]) && bytes.subarray(6, 10).every(byte => byte < 128)) return 'mp3';
  if (bytes.length >= 4 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0 && (bytes[1] & 6) !== 0 && (bytes[1] & 0x18) !== 8 && (bytes[2] >> 4) > 0 && (bytes[2] >> 4) < 15 && (bytes[2] & 12) !== 12) return 'mp3';
  if (bytes.length >= 12 && bytes.readUInt32BE(0) === 0x1a45dfa3 && bytes.includes(Buffer.from([0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d]))) return 'webm';
  if (bytes.length >= 16 && bytes.toString('ascii', 4, 8) === 'ftyp') {
    const length = bytes.readUInt32BE(0), brands = new Set(['isom', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'M4V ', 'M4A ']);
    if (length >= 16 && length <= 4096 && length <= size && length <= bytes.length && length % 4 === 0) {
      for (let offset = 8; offset < length; offset += 4) if (offset !== 12 && brands.has(bytes.toString('ascii', offset, offset + 4))) return 'mp4';
    }
  }
  if (htmlSignature(bytes)) return 'html';
  return null;
}
function classify(bytes, size, contentType, url) {
  const type = typeFor(contentType), declared = MIME.get(type), hint = hintFor(url), detected = signature(bytes, size);
  let extension;
  if (declared === 'html' || !declared && detected === 'html') {
    if (detected && detected !== 'html') throw unsupported();
    // HTML has no universal magic bytes (fragments/plain bodies are legal).
    // The isolated parser performs fatal Unicode validation over ALL bytes.
    extension = 'html'; // An HTML landing/error page must never masquerade as media.
  } else if (declared === 'txt' || declared === 'md' || !declared && ['txt', 'md'].includes(hint)) {
    if (detected || hint && !TEXT.has(hint)) throw unsupported();
    extension = declared === 'md' || hint === 'md' ? 'md' : 'txt';
  } else {
    extension = detected === 'zip' ? (declared || hint) : detected;
    if (!extension || !EXTENSIONS.has(extension) || TEXT.has(extension) ||
      detected === 'zip' && !['docx', 'pptx'].includes(extension) ||
      declared && declared !== extension || hint && hint !== extension) throw unsupported();
  }
  const limit = TEXT.has(extension) ? WEB_LIMITS.inputBytes : DOCUMENT.has(extension) ? DOCUMENT_BYTES : MAX_BYTES;
  if (size > limit) throw oversized();
  return { extension, kind: TEXT.has(extension) ? 'text' : DOCUMENT.has(extension) ? 'document' : 'media', type };
}
function checkMode(mode, classification) {
  const { extension, kind, type } = classification;
  if (mode === 'webpage' && kind !== 'text') throw failure('Webpage mode requires static HTML, UTF-8 or BOM-marked UTF-16 text.');
  if (mode === 'video' && extension !== 'html' && (kind !== 'media' || !['mp4', 'webm', 'ogg'].includes(extension) || type.startsWith('audio/'))) {
    throw failure('Video mode requires an original video, not text, captions or audio-only content.');
  }
  // MIME labels cannot prove that MP4/WebM/Ogg containers have no visual track.
  // Do not silently route those containers through audio-only preparation.
  if (mode === 'audio' && !['mp3', 'wav'].includes(extension)) {
    throw failure('Audio mode requires an unambiguous MP3 or WAV source. Import other containers in auto or video mode so visuals are not discarded.');
  }
}
function verifyDirectory(directory) {
  if (typeof directory !== 'string' || !isAbsolute(directory) || directory.includes('\0')) throw failure('Invalid private source directory.', 400);
  const normalized = resolve(directory), info = fs.lstatSync(normalized);
  if (!info.isDirectory() || info.isSymbolicLink()) throw failure('Invalid private source directory.', 400);
  const actual = fs.realpathSync(normalized);
  if (process.platform === 'win32' ? actual.toLowerCase() !== normalized.toLowerCase() : actual !== normalized) throw failure('Invalid private source directory.', 400);
  return normalized;
}
function readOriginal(file, expectedSize, all = false) {
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size !== expectedSize || !info.size || info.size > MAX_BYTES) throw failure('Source did not produce a complete regular private file.');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.size !== info.size || opened.ino !== info.ino || opened.dev !== info.dev) throw failure('Source file changed during import.');
    if (all && info.size > WEB_LIMITS.inputBytes) throw oversized();
    const bytes = Buffer.alloc(all ? info.size : Math.min(info.size, 64 * 1024));
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) throw failure('Source file was incomplete.');
      offset += count;
    }
    const completed = fs.fstatSync(fd), current = fs.lstatSync(file);
    if (!current.isFile() || current.isSymbolicLink() || current.ino !== opened.ino || current.dev !== opened.dev ||
      [completed, current].some(stat => stat.size !== opened.size || stat.mtimeMs !== opened.mtimeMs || stat.ctimeMs !== opened.ctimeMs)) {
      throw failure('Source file changed during import.');
    }
    return bytes;
  } finally { fs.closeSync(fd); }
}

/** Local-only preparation of a trusted, store-owned original. The caller seals
 * and accounts for acquisition first; failures never remove or rewrite it.
 * Parser injection is construction-time only, never a per-import option. */
export function createUrlTextExtractor({ extractWeb = extractWebText } = {}) {
  if (typeof extractWeb !== 'function') throw new TypeError('Invalid saved URL text extractor factory.');
  return async function extractSavedUrlText({ file, extension, size, signal } = {}) {
    const check = () => { if (signal?.aborted) throw new WebExtractError('cancelled'); };
    try {
      if (typeof file !== 'string' || !isAbsolute(file) || file.includes('\0') ||
        process.platform === 'win32' && (!/^[a-z]:[\\/]/i.test(file) || file.slice(2).includes(':')) ||
        !TEXT.has(extension) || !Number.isSafeInteger(size) || size < 1 ||
        signal !== undefined && !(signal instanceof AbortSignal)) throw failure('Invalid saved URL text options.', 400);
      if (size > WEB_LIMITS.inputBytes) throw oversized();
      check();
      file = resolve(file);
      verifyDirectory(dirname(file));
      const bytes = readOriginal(file, size, true);
      check();
      let text, title, warnings = [];
      if (extension === 'html') {
        const extracted = await extractWeb(bytes, { mode: 'webpage', signal, timeoutMs: WEB_LIMITS.timeoutMs });
        check();
        if (!extracted || extracted.title !== undefined && (typeof extracted.title !== 'string' ||
          extracted.title.length > WEB_LIMITS.titleLength || /[\p{Cc}\p{Cf}]/u.test(extracted.title)) ||
          !Array.isArray(extracted.warnings) || extracted.warnings.length > 1 ||
          extracted.warnings.some(warning => warning !== WEB_WARNINGS[0])) throw new WebExtractError('invalid');
        text = extracted.text; title = extracted.title; warnings = [...extracted.warnings];
      } else text = decodeSourceText(bytes);
      if (typeof text !== 'string') throw new WebExtractError('invalid');
      if (text.length > WEB_LIMITS.textLength) throw new WebExtractError('text');
      if (isUnusableWebText(text)) throw new WebExtractError('empty');
      check();
      return { text, ...(title ? { title } : {}), warnings };
    } catch (error) {
      if (signal instanceof AbortSignal) check();
      if (safeErrors.has(error) || error instanceof WebExtractError) throw error;
      throw failure('Saved source text extraction failed. The original was not changed.', 422);
    }
  };
}
export const extractSavedUrlText = createUrlTextExtractor();

function publish(file, directory, extension) {
  const target = join(directory, `source.${extension}`);
  // rename() can overwrite on POSIX. An exclusive hard link never replaces an
  // existing original, then removes only the temporary name owned by this import.
  fs.linkSync(file, target);
  fs.unlinkSync(file);
  return target;
}
function youtubeHost(value) {
  const host = new URL(value).hostname;
  return host === 'youtu.be' || host.endsWith('.youtu.be') || host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtube-nocookie.com' || host.endsWith('.youtube-nocookie.com');
}
function operationScope(signal, timeoutMs) {
  const controller = new AbortController(), deadline = performance.now() + timeoutMs;
  const cancel = () => { if (!controller.signal.aborted) controller.abort(failure('URL source import was cancelled.', 499)); };
  const timer = setTimeout(() => { if (!controller.signal.aborted) controller.abort(failure('URL source import exceeded its shared total deadline.', 504)); }, timeoutMs);
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  const check = () => {
    if (!controller.signal.aborted && performance.now() >= deadline) controller.abort(failure('URL source import exceeded its shared total deadline.', 504));
    if (controller.signal.aborted) throw controller.signal.reason;
  };
  return { signal: controller.signal, check, remaining() { check(); return Math.max(1, Math.floor(deadline - performance.now())); },
    close() { clearTimeout(timer); signal?.removeEventListener('abort', cancel); } };
}
function nativeVideo(candidates, pageUrl) {
  const urls = new Set();
  for (const candidate of candidates) {
    if (candidate.kind !== 'video') continue;
    if (candidate.type && !['video/mp4', 'video/webm', 'video/ogg', 'application/ogg', 'application/octet-stream'].includes(candidate.type)) throw failure('The webpage has unsupported or ambiguous native video formats.');
    const value = candidate.url;
    // Do not let URL resolution repair ambiguous whitespace, backslashes or
    // encoded credentials/controls. Guarded transport still revalidates all DNS.
    if (typeof value !== 'string' || !value || /[\s\p{Cc}\\]/u.test(value)) throw failure('The webpage has an invalid native video link.');
    let resolved;
    try {
      resolved = /^[a-z][a-z\d+.-]*:/i.test(value) ? normalizeSourceUrl(value) :
        normalizeSourceUrl(value.startsWith('//') ? `https:${value}` : new URL(value, pageUrl).href);
    } catch { throw failure('The webpage has an invalid native video link.'); }
    urls.add(resolved);
  }
  if (urls.size !== 1) throw failure('Video mode requires exactly one unambiguous static native video link. Embedded or scripted players are not supported.');
  const url = [...urls][0];
  if (url === pageUrl || youtubeHost(url)) throw failure('A native video link must point directly to a media resource, not another webpage or player.');
  return url;
}

/** Trusted code/test seams. HTTP options cannot replace transport, parser,
 * YouTube helper, URL validation or the shared deadline policy. */
export function createUrlSourceDownloader({
  transport = { downloadSourceFile }, extractWeb = extractWebText,
  youtubeLoader = () => import('./youtube-source.mjs'), timeoutMs = 60_000,
} = {}) {
  if (typeof transport?.downloadSourceFile !== 'function' || typeof extractWeb !== 'function' || typeof youtubeLoader !== 'function' ||
    !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) throw new TypeError('Invalid URL source factory.');
  // Trusted store callers may postpone final text preparation until the
  // complete private original has been sealed, hashed and accounted for.
  return async function downloadUrlSource({ url, mode = 'auto', directory, maxBytes = MAX_BYTES, signal, onProgress, deferTextExtraction = false } = {}) {
    let scope;
    try {
      if (!['auto', 'webpage', 'video', 'audio'].includes(mode) || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BYTES ||
        signal !== undefined && !(signal instanceof AbortSignal) || onProgress !== undefined && typeof onProgress !== 'function' ||
        typeof deferTextExtraction !== 'boolean') throw failure('Invalid URL source options.', 400);
      // Always use the real validator, even when the transport is test-injected.
      const initialUrl = normalizeSourceUrl(url);
      directory = verifyDirectory(directory);
      scope = operationScope(signal, timeoutMs); scope.check();
      if (youtubeHost(initialUrl)) {
        if (!['auto', 'video'].includes(mode)) throw failure('YouTube imports require video or auto mode; captions and audio-only substitutions are not supported.');
        const helper = await youtubeLoader(); scope.check();
        if (typeof helper?.youtubeVideoUrl !== 'function' || typeof helper?.acquireYouTubeVideo !== 'function') throw failure('The YouTube source helper is unavailable.', 503);
        const canonical = helper.youtubeVideoUrl(url);
        if (typeof canonical !== 'string' || !/^https:\/\/www\.youtube\.com\/watch\?v=[A-Za-z0-9_-]{11}$/.test(canonical)) throw failure('Use a supported single public YouTube video URL.', 400);
        const result = await helper.acquireYouTubeVideo({ url: canonical, directory, maxBytes, signal: scope.signal, onProgress }); scope.check();
        if (!result || result.kind !== 'media' || !['mp4', 'webm'].includes(result.extension) || result.text !== undefined ||
          result.file !== join(directory, `source.${result.extension}`) || !Number.isSafeInteger(result.size) || result.size < 1 || result.size > maxBytes) throw failure('The YouTube helper did not return a complete original video.');
        const bytes = readOriginal(result.file, result.size);
        if (signature(bytes, result.size) !== result.extension) throw failure('The YouTube helper did not return a supported video container.');
        const title = result.provenance?.title;
        if (title !== undefined && (typeof title !== 'string' || title.length > WEB_LIMITS.titleLength || /[\p{Cc}\p{Cf}]/u.test(title))) throw failure('The YouTube helper returned invalid source metadata.');
        if (!Array.isArray(result.warnings) || result.warnings.length > 32 || result.warnings.some(item => typeof item !== 'string' || item.length > 1000 || /https?:\/\/|[\p{Cc}\p{Cf}]/u.test(item))) throw failure('The YouTube helper returned invalid source warnings.');
        return { file: result.file, extension: result.extension, size: result.size, kind: 'media', name: `source.${result.extension}`,
          provenance: { type: 'youtube', citationUrl: canonical, ...(title ? { title } : {}), importedAt: new Date().toISOString() }, warnings: [...result.warnings, PRIVACY] };
      }
      let received = 0;
      async function acquire(value, resourceOnly = false) {
        scope.check();
        const remaining = maxBytes - received;
        if (remaining < 1) throw oversized();
        const pendingFile = join(directory, `.source-${randomUUID()}.download`);
        let policyError;
        const downloaded = await transport.downloadSourceFile(value, pendingFile, {
          maxBytes: remaining, signal: scope.signal, timeoutMs: scope.remaining(),
          limitForHeaders({ contentType }) {
            try {
              const declared = MIME.get(typeFor(contentType));
              if (resourceOnly && declared && (TEXT.has(declared) || DOCUMENT.has(declared))) throw failure('Native video links must resolve directly to media, not another webpage.');
              return declared && TEXT.has(declared) ? Math.min(remaining, WEB_LIMITS.inputBytes) : declared && DOCUMENT.has(declared) ? Math.min(remaining, DOCUMENT_BYTES) : remaining;
            } catch (error) { policyError = error; throw error; }
          },
          onProgress: onProgress ? progress => {
            scope.check();
            return onProgress({ receivedBytes: received + progress.receivedBytes,
              ...(mode !== 'video' && progress.totalBytes !== undefined ? { totalBytes: received + progress.totalBytes } : {}) });
          } : undefined,
        }).catch(error => { throw policyError || error; });
        scope.check();
        if (!downloaded || !Number.isSafeInteger(downloaded.size) || downloaded.size < 1 || downloaded.size > remaining) throw failure('Source returned an empty or invalid download.');
        const finalUrl = normalizeSourceUrl(downloaded.url);
        const bytes = readOriginal(pendingFile, downloaded.size);
        const classification = classify(bytes, downloaded.size, downloaded.contentType, finalUrl);
        checkMode(mode, classification);
        if (resourceOnly && classification.kind !== 'media') throw failure('Native video links must resolve directly to media, not another webpage.');
        const file = publish(pendingFile, directory, classification.extension);
        received += downloaded.size;
        scope.check();
        return { ...classification, file, size: downloaded.size, url: finalUrl };
      }
      const initial = await acquire(initialUrl);
      let source = initial, text, title, warnings = [PRIVACY];
      const textPending = deferTextExtraction && TEXT.has(initial.extension) && mode !== 'video';
      if (textPending) {
        // A video-mode page is discovery input, not the final original. It
        // still requires parsing and a successful original-media acquisition.
        if (initial.extension === 'html') warnings.push(WEB_WARNINGS[0]);
      } else if (initial.extension === 'html') {
        const extracted = await extractWeb(readOriginal(initial.file, initial.size, true), { mode, signal: scope.signal, timeoutMs: Math.min(WEB_LIMITS.timeoutMs, scope.remaining()) });
        scope.check();
        text = extracted.text; title = extracted.title; warnings.push(...extracted.warnings);
        if (mode === 'video') {
          const selected = nativeVideo(extracted.mediaCandidates, initial.url);
          source = await acquire(selected, true);
          text = undefined;
          warnings.push(LINKED, ORIGINAL);
        }
      } else if (TEXT.has(initial.extension)) {
        text = decodeSourceText(readOriginal(initial.file, initial.size, true));
        if (isUnusableWebText(text)) throw failure('The source has no readable text, or is only an error or login message.');
      } else warnings.push(ORIGINAL);
      if (text !== undefined && (typeof text !== 'string' || !text.trim() || text.length > WEB_LIMITS.textLength)) throw failure('Source did not produce complete bounded text.');
      scope.check();
      const provenanceType = initial.extension === 'html' && mode !== 'video' ? 'webpage' : source.kind === 'media' ? 'direct-media' : source.kind === 'document' ? 'direct-document' : 'text';
      return { file: source.file, extension: source.extension, size: source.size, kind: source.kind, name: `source.${source.extension}`,
        ...(textPending ? { textPending: true } : text !== undefined ? { text } : {}),
        provenance: { type: provenanceType, citationUrl: sourceCitationUrl(initial.url), ...(title ? { title } : {}), importedAt: new Date().toISOString() }, warnings };
    } catch (error) {
      if (scope) { try { scope.check(); } catch (cancelled) { throw cancelled; } }
      throw safeFailure(error);
    } finally { scope?.close(); }
  };
}
export const downloadUrlSource = createUrlSourceDownloader();
