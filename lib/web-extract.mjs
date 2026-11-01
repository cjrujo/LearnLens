import { fork as nodeFork } from 'node:child_process';
import { Parser } from 'htmlparser2';
import { AppError } from './provider.mjs';

// Limits are fixed policy, never controlled by source markup or request options.
export const WEB_LIMITS = Object.freeze({
  inputBytes: 8 * 1024 * 1024, textLength: 2_000_000, depth: 128,
  events: 250_000, candidates: 32, candidateLength: 8192, titleLength: 512,
  timeoutMs: 10_000,
});
const ERRORS = Object.freeze({
  input: 'Web source is empty or exceeds the 8 MiB input limit.',
  encoding: 'Web text must be valid UTF-8 or BOM-marked UTF-16 without binary control characters.',
  text: 'Web source exceeds the 2,000,000-character decoded text limit. No text was truncated.',
  complexity: 'Web source exceeds the static parser depth or event limit.',
  metadata: 'Web source exceeds the title or native media candidate limit.',
  empty: 'No readable static text was found. Dynamic pages, login/error pages and embedded players are not supported.',
  base: 'Native video selection does not support HTML base URL overrides.',
  media: 'Native video selection does not support nested video or audio fallback elements.',
  timeout: 'Static webpage extraction exceeded its processing deadline.',
  cancelled: 'Static webpage extraction was cancelled.',
  worker: 'The static webpage parser stopped or exceeded its memory budget.',
  invalid: 'Static webpage extraction returned an invalid result.',
});
export const WEB_WARNINGS = Object.freeze([
  'Only static webpage text is imported. Scripts, styles, navigation, hidden content, images and embedded players are not executed or loaded; CSS layout is not reproduced.',
  'Native media candidates come only from static video, audio and source elements; scripts and embedded players are not inspected.',
]);
export class WebExtractError extends AppError {
  constructor(code) {
    super(ERRORS[code] || ERRORS.invalid, ['input', 'text', 'complexity', 'metadata'].includes(code) ? 413 : code === 'cancelled' ? 499 : code === 'timeout' ? 504 : 422);
    this.code = Object.hasOwn(ERRORS, code) ? code : 'invalid';
  }
}
const fail = code => { throw new WebExtractError(code); };

/** Fatal decoding only. HTML markup has a separate decoded-text counter so
 * markup bytes do not incorrectly consume the readable-text allowance. */
export function decodeSourceText(input, { markup = false } = {}) {
  if (!(input instanceof Uint8Array) || !input.byteLength || input.byteLength > WEB_LIMITS.inputBytes) fail('input');
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  let encoding = 'utf-8', offset = 0;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) { encoding = 'utf-16le'; offset = 2; }
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) { encoding = 'utf-16be'; offset = 2; }
  else if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) offset = 3;
  let text;
  try { text = new TextDecoder(encoding, { fatal: true, ignoreBOM: true }).decode(bytes.subarray(offset)); }
  catch { fail('encoding'); }
  if (/[\u0000-\u0008\u000b\u000e-\u001f\u007f-\u009f]/u.test(text)) fail('encoding');
  if (!markup && text.length > WEB_LIMITS.textLength) fail('text');
  return text;
}

const IGNORED = new Set(['script', 'style', 'nav', 'template', 'noscript', 'iframe', 'object', 'embed', 'svg', 'canvas']);
const BLOCKS = new Set(['address', 'article', 'aside', 'blockquote', 'div', 'dl', 'dt', 'dd', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'header', 'hr', 'main', 'ol', 'p', 'pre', 'section', 'table', 'tbody', 'thead', 'tfoot', 'tr', 'ul']);
function hidden(attrs) {
  return Object.hasOwn(attrs, 'hidden') || Object.hasOwn(attrs, 'inert') ||
    attrs['aria-hidden']?.trim().toLowerCase() === 'true' || attrs.role?.trim().toLowerCase() === 'navigation' ||
    /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse)|content-visibility\s*:\s*hidden)\s*(?:!important\s*)?(?:;|$)/i.test((attrs.style || '').replace(/\/\*[\s\S]*?\*\//g, ''));
}
function textSink() {
  const parts = [];
  let length = 0, last = '', pending = '';
  const append = value => {
    if (value.length > WEB_LIMITS.textLength - length) fail('text');
    if (!value) return;
    parts.push(value); length += value.length; last = value.at(-1);
  };
  const boundary = value => { if (value === '\n' || !pending) pending = value; };
  const flush = () => {
    if (length && pending && last !== '\n' && last !== '\r' && (pending === '\n' || last !== '\t' && last !== ' ')) append(pending);
    pending = '';
  };
  return {
    boundary,
    text(value, preformatted = false) {
      if (!value) return;
      if (preformatted) { flush(); append(value); return; }
      // Only HTML's collapsible whitespace is normalized. NBSP and other
      // explicit Unicode spaces are content, including at the output edges.
      // Pending spaces survive entity/tokenizer chunks and inline tags, but
      // inline element boundaries themselves never introduce characters.
      const collapsed = value.replace(/[\t\n\f\r ]+/g, ' ');
      if (collapsed.startsWith(' ')) boundary(' ');
      const normalized = collapsed.replace(/^ | $/g, '');
      if (!normalized) return;
      flush(); append(normalized);
      if (collapsed.endsWith(' ')) boundary(' ');
    },
    cell() {
      if (pending === '\n') flush();
      pending = ''; append('\t');
    },
    // Only uncommitted layout separators are discarded. Trimming the final
    // string would destroy pre indentation/newlines, NBSP and empty cells.
    finish() { return parts.join(''); },
  };
}

export function isUnusableWebText(value) {
  const text = value.replace(/^[\t ]*(?:#{1,6}[\t ]+|[-*][\t ]+|\d+\.[\t ]+)/gm, '').replace(/\s+/g, ' ').trim();
  if (!/[\p{L}\p{N}]/u.test(text)) return true;
  // Conservative whole-short-page detection, not keyword filtering of lessons.
  return text.length < 600 && /^(?:(?:error\s*)?(?:401|403|404|410|429|500|502|503|504)\b|access denied\b|forbidden\b|(?:page )?not found\b|just a moment\b|checking your browser\b|(?:please\s+)?(?:enable|turn on) javascript\b|javascript (?:is )?(?:disabled|required|not enabled)\b|javascript must be enabled\b|you need to enable javascript\b|(?:please )?(?:sign|log) in to (?:continue|view|access)\b)/i.test(text);
}

/** Streaming tokenizer, not a DOM/browser. Nothing evaluates CSS, JS, URLs,
 * images, XML entities or embeds. Production callers use the worker below. */
export function parseWebHtml(input, { mode = 'webpage' } = {}) {
  if (!['auto', 'webpage', 'video'].includes(mode)) fail('invalid');
  const html = decodeSourceText(input, { markup: true });
  const stack = [], sink = textSink(), mediaCandidates = [];
  let events = 0, decoded = 0, title = '', titleCount = 0;
  const event = () => { if (++events > WEB_LIMITS.events) fail('complexity'); };
  const addCandidate = (kind, attrs) => {
    if (mode !== 'video' || !attrs.src?.trim()) return;
    const url = attrs.src.trim(), type = (attrs.type || '').trim().toLowerCase();
    if (url.length > WEB_LIMITS.candidateLength || Buffer.byteLength(url) > WEB_LIMITS.candidateLength || type.length > 128 || mediaCandidates.length >= WEB_LIMITS.candidates) fail('metadata');
    mediaCandidates.push({ kind, url, ...(type ? { type } : {}) });
  };
  const parser = new Parser({
    onopentagname() { event(); if (stack.length >= WEB_LIMITS.depth) fail('complexity'); },
    onattribute() { event(); },
    onopentag(tag, attrs) {
      event();
      const parent = stack.at(-1);
      const suppressed = Boolean(parent?.suppressed || IGNORED.has(tag) || hidden(attrs));
      const isMedia = tag === 'video' || tag === 'audio';
      // A media element inside an active media element is fallback content,
      // not a second playable resource, even if separated by other markup.
      if (mode === 'video' && isMedia && parent?.media) fail('media');
      const frame = { tag, suppressed, inHead: tag === 'head' || parent?.inHead,
        noText: parent?.noText || isMedia, preformatted: tag === 'pre' || parent?.preformatted,
        media: parent?.media || (!suppressed && isMedia ? tag : undefined),
        activeMedia: !suppressed && isMedia && !parent?.media, cells: 0, items: 0 };
      if (!suppressed) {
        if (tag === 'meta') {
          const charset = attrs.charset || (attrs['http-equiv']?.toLowerCase() === 'content-type' ? /charset\s*=\s*["']?([^\s;"']+)/i.exec(attrs.content || '')?.[1] : '');
          const hasUtf16Bom = input[0] === 0xff && input[1] === 0xfe || input[0] === 0xfe && input[1] === 0xff;
          if (charset && !(/^(?:utf-8|utf8)$/i.test(charset) && !hasUtf16Bom || /^utf-16(?:le|be)?$/i.test(charset) && hasUtf16Bom)) fail('encoding');
        }
        if (tag === 'base' && attrs.href && mode === 'video') fail('base');
        if (frame.activeMedia) addCandidate(tag, attrs);
        if (tag === 'source' && parent?.activeMedia) addCandidate(parent.tag, attrs);
      }
      stack.push(frame);
      if (suppressed || frame.inHead || frame.noText || tag === 'title') return;
      if (/^h[1-6]$/.test(tag)) { sink.boundary('\n'); sink.text('#'.repeat(Number(tag[1])) + ' '); }
      else if (tag === 'li') {
        sink.boundary('\n');
        const list = [...stack].reverse().find(item => item.tag === 'ul' || item.tag === 'ol');
        sink.text(list?.tag === 'ol' ? `${++list.items}. ` : '- ');
      } else if (tag === 'td' || tag === 'th') {
        const row = [...stack].reverse().find(item => item.tag === 'tr');
        if (row && row.cells++ > 0) sink.cell();
      } else if (tag === 'br' && frame.preformatted) sink.text('\n', true);
      else if (BLOCKS.has(tag) || tag === 'br') sink.boundary('\n');
    },
    ontext(value) {
      event(); decoded += value.length;
      if (decoded > WEB_LIMITS.textLength) fail('text');
      if (/[\u0000-\u0008\u000b\u000e-\u001f\u007f-\u009f]/u.test(value)) fail('encoding');
      const frame = stack.at(-1);
      if (frame?.suppressed) return;
      if (frame?.tag === 'title') {
        titleCount += value.length;
        if (titleCount > WEB_LIMITS.titleLength) fail('metadata');
        title += value;
      } else if (!frame?.inHead && !frame?.noText) sink.text(value, frame?.preformatted);
    },
    onclosetag() {
      event();
      const frame = stack.pop();
      if (!frame || frame.suppressed || frame.inHead || frame.noText || frame.tag === 'title') return;
      if (BLOCKS.has(frame.tag) || frame.tag === 'li' || /^h[1-6]$/.test(frame.tag)) sink.boundary('\n');
    },
    oncomment: event, onprocessinginstruction: event, onerror() { fail('invalid'); },
  }, { decodeEntities: true, xmlMode: false });
  // Avoid a single giant tokenizer write and expose all tail bytes to the parser.
  for (let offset = 0; offset < html.length; offset += 16_384) parser.write(html.slice(offset, offset + 16_384));
  parser.end();
  const text = sink.finish();
  if (isUnusableWebText(text) && !(mode === 'video' && !text && mediaCandidates.some(item => item.kind === 'video'))) fail('empty');
  title = title.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/gu, ' ').trim();
  return { text, title, warnings: mode === 'video' ? [...WEB_WARNINGS] : [WEB_WARNINGS[0]], mediaCandidates };
}

export function webWorkerEnvironment(base = process.env) {
  // No HOME, PATH, proxy/auth/provider settings, NODE_OPTIONS or preload flags.
  return Object.fromEntries(['SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'LANG', 'LC_ALL'].filter(key => typeof base[key] === 'string').map(key => [key, base[key]]));
}
function validResult(value, mode) {
  return value && typeof value.text === 'string' && value.text.length <= WEB_LIMITS.textLength &&
    typeof value.title === 'string' && value.title.length <= WEB_LIMITS.titleLength &&
    Array.isArray(value.warnings) && value.warnings.length <= WEB_WARNINGS.length && value.warnings.every(warning => WEB_WARNINGS.includes(warning)) &&
    Array.isArray(value.mediaCandidates) && value.mediaCandidates.length <= WEB_LIMITS.candidates &&
    (mode === 'video' || value.mediaCandidates.length === 0) && value.mediaCandidates.every(item =>
      item && ['video', 'audio'].includes(item.kind) && typeof item.url === 'string' && item.url.length > 0 &&
      item.url.length <= WEB_LIMITS.candidateLength && Buffer.byteLength(item.url) <= WEB_LIMITS.candidateLength &&
      (item.type === undefined || typeof item.type === 'string' && item.type.length <= 128)) &&
    (!isUnusableWebText(value.text) || mode === 'video' && !value.text && value.mediaCandidates.some(item => item.kind === 'video'));
}

/** Trusted construction-time seam only. Per-import callers cannot select code,
 * environment, executable, memory limits or parser policy. */
export function createWebExtractor({ fork = nodeFork, workerFile = new URL('./web-worker.mjs', import.meta.url) } = {}) {
  if (typeof fork !== 'function') throw new TypeError('Invalid web worker factory.');
  return function extractWebText(buffer, { mode = 'webpage', signal, timeoutMs = WEB_LIMITS.timeoutMs } = {}) {
    if (!(buffer instanceof Uint8Array) || !buffer.byteLength || buffer.byteLength > WEB_LIMITS.inputBytes) return Promise.reject(new WebExtractError('input'));
    if (!['auto', 'webpage', 'video'].includes(mode) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > WEB_LIMITS.timeoutMs || signal !== undefined && !(signal instanceof AbortSignal)) return Promise.reject(new WebExtractError('invalid'));
    if (signal?.aborted) return Promise.reject(new WebExtractError('cancelled'));
    return new Promise((resolve, reject) => {
      let child, result, error, stopping = false, settled = false, timer;
      const finish = () => {
        if (settled) return;
        settled = true; clearTimeout(timer); signal?.removeEventListener('abort', cancel);
        error ? reject(error) : resolve(result);
      };
      const stop = (failure, value) => {
        if (stopping) return;
        stopping = true; error = failure; result = value;
        clearTimeout(timer); signal?.removeEventListener('abort', cancel);
        // Wait for exit, not merely kill(), before releasing caller accounting.
        try { child.kill('SIGKILL'); } catch { error = new WebExtractError('worker'); }
      };
      const cancel = () => stop(new WebExtractError('cancelled'));
      try {
        child = fork(workerFile, [], {
          execArgv: ['--max-old-space-size=128', '--max-semi-space-size=4'],
          env: webWorkerEnvironment(), stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
          serialization: 'advanced', windowsHide: true,
        });
        child.once('exit', () => { if (!stopping) error = new WebExtractError('worker'); finish(); });
        child.once('error', () => {
          if (!child.pid) { error = new WebExtractError('worker'); finish(); }
          else stop(new WebExtractError('worker'));
        });
        child.on('message', message => {
          if (message?.error && Object.hasOwn(ERRORS, message.error)) stop(new WebExtractError(message.error));
          else if (validResult(message?.result, mode)) stop(null, message.result);
          else stop(new WebExtractError('invalid'));
        });
        timer = setTimeout(() => stop(new WebExtractError('timeout')), timeoutMs);
        signal?.addEventListener('abort', cancel, { once: true });
        if (signal?.aborted) cancel();
        if (!stopping) child.send({ buffer, mode }, sendError => { if (sendError) stop(new WebExtractError('worker')); });
      } catch {
        if (child?.pid) stop(new WebExtractError('worker'));
        else { error = new WebExtractError('worker'); finish(); }
      }
    });
  };
}
export const extractWebText = createWebExtractor();
