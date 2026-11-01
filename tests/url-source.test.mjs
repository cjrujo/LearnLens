import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter, getEventListeners } from 'node:events';
import { Readable } from 'node:stream';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { createSourceTransport } from '../lib/source-fetch.mjs';
import { createUrlSourceDownloader, sourceCitationUrl, extractSavedUrlText, createUrlTextExtractor } from '../lib/url-source.mjs';
import { parseWebHtml, WEB_LIMITS, WEB_WARNINGS, WebExtractError } from '../lib/web-extract.mjs';
import { AppError } from '../lib/provider.mjs';

const ROOT = fileURLToPath(new URL('../artifacts/', import.meta.url));
const SOURCE = 'https://static.public-domain.com/lesson?token=TOP_SECRET#private-fragment';
const PUBLIC = '93.184.216.34';
const MP4 = Buffer.from('000000186674797069736f6d0000020069736f6d6d703432', 'hex');
const MP3 = Buffer.from([0xff, 0xfb, 0x90, 0, ...Array(64).fill(0)]);
const WAV = Buffer.concat([Buffer.from('RIFF'), Buffer.from([36, 0, 0, 0]), Buffer.from('WAVEfmt '), Buffer.alloc(32)]);
const WEBM = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x87, 0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d]);
const OGG = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(23), Buffer.from('OpusHead')]);
const body = value => Buffer.isBuffer(value) ? value : Buffer.from(value);
function scratch(t) {
  fs.mkdirSync(ROOT, { recursive: true });
  const directory = fs.mkdtempSync(join(ROOT, 'url-source-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}
function saved(t, extension, content) {
  const file = join(scratch(t), `source.${extension}`), bytes = body(content);
  fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
  return { file, extension, size: bytes.length };
}
const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function fakeDownloader(plans) {
  const calls = [];
  return { calls, async downloadSourceFile(url, file, options) {
    const plan = plans[calls.length];
    calls.push({ url, file, options });
    if (!plan) throw new Error('Unexpected download TOP_SECRET');
    plan.onCall?.({ url, file, options });
    if (plan.error) throw plan.error;
    if (plan.delay || plan.hang) await new Promise((resolve, reject) => {
      let timer;
      const stop = () => { clearTimeout(timer); options.signal.removeEventListener('abort', stop); reject(new Error('Cancelled TOP_SECRET')); };
      options.signal.addEventListener('abort', stop, { once: true });
      if (options.signal.aborted) { stop(); return; }
      if (!plan.hang) timer = setTimeout(() => { options.signal.removeEventListener('abort', stop); resolve(); }, plan.delay);
    });
    const bytes = body(plan.body ?? 'Text'), type = plan.type ?? 'text/plain';
    const limit = await options.limitForHeaders({ contentType: type, contentLength: bytes.length });
    if (bytes.length > Math.min(options.maxBytes, limit)) throw new AppError('TOP_SECRET too big', 413);
    options.signal.throwIfAborted();
    fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
    await options.onProgress?.({ receivedBytes: bytes.length, totalBytes: bytes.length });
    return { url: plan.finalUrl ?? url, size: plan.size ?? bytes.length, contentType: type };
  } };
}
const localParser = (bytes, options) => Promise.resolve(parseWebHtml(bytes, options));
function make(plans, options = {}) {
  const transport = fakeDownloader(plans);
  return { transport, download: createUrlSourceDownloader({ transport, extractWeb: localParser, ...options }) };
}
async function rejectsSafe(promise, status) {
  await assert.rejects(promise, error => {
    assert.ok(error instanceof AppError);
    if (status !== undefined) assert.equal(error.status, status, error.message);
    assert.doesNotMatch(`${error.message}\n${error.stack}\n${JSON.stringify(error)}`, /TOP_SECRET|https?:\/\//);
    assert.equal(error.cause, undefined);
    return true;
  });
}

// End-to-end through the real guarded transport, but never creates a socket.
function fakeHttps(plans, addresses = [{ address: PUBLIC, family: 4 }]) {
  const calls = [], lookups = [];
  const transport = createSourceTransport({
    lookup: async host => { lookups.push(host); return addresses; },
    request(url, options, callback) {
      const plan = plans[calls.length];
      if (!plan) throw new Error('No more fixtures TOP_SECRET');
      const request = new EventEmitter();
      let response;
      const socket = new EventEmitter(); socket.remoteAddress = PUBLIC; socket.destroy = () => {};
      request.destroy = () => { request.destroyed = true; response?.destroy(); };
      request.end = () => queueMicrotask(() => {
        if (request.destroyed) return;
        request.emit('socket', socket); socket.emit('secureConnect');
        const bytes = body(plan.body ?? '');
        response = Readable.from([bytes]);
        response.complete = true; response.statusCode = plan.status ?? 200; response.socket = socket;
        response.rawHeaders = ['Content-Type', plan.type ?? 'text/plain', 'Content-Length', String(bytes.length), ...Object.entries(plan.headers || {}).flat()];
        response.rawTrailers = []; response.trailers = {};
        callback(response);
      });
      calls.push({ url: String(url), options, request });
      return request;
    },
  });
  return { transport, calls, lookups };
}

test('fake HTTPS plus real isolated parser produces an immutable private HTML original and redacted provenance', async t => {
  const directory = scratch(t);
  const html = '<!doctype html><title>Faithful &amp; static</title><h1>Lesson</h1><p>Body <b>words</b> and complete tail.</p><img src="https://unused.public-domain.com/image">';
  const fake = fakeHttps([{ status: 302, headers: { Location: '/final?token=TOP_SECRET' } }, { type: 'text/html', body: html }]);
  const progress = [];
  const download = createUrlSourceDownloader({ transport: fake.transport });
  const result = await download({ url: SOURCE, directory, maxBytes: 4096, onProgress: value => progress.push(value) });
  assert.equal(result.file, join(directory, 'source.html'));
  assert.equal(result.extension, 'html'); assert.equal(result.size, Buffer.byteLength(html));
  assert.equal(result.kind, 'text'); assert.equal(result.name, 'source.html');
  assert.equal(fs.readFileSync(result.file, 'utf8'), html);
  assert.equal(result.text, '# Lesson\nBody words and complete tail.');
  assert.equal(result.provenance.type, 'webpage'); assert.equal(result.provenance.title, 'Faithful & static');
  assert.equal(result.provenance.citationUrl, 'https://static.public-domain.com/final');
  assert.ok(Number.isFinite(Date.parse(result.provenance.importedAt)));
  assert.doesNotMatch(result.warnings.join(' '), /TOP_SECRET|https?:\/\//);
  assert.equal(fake.calls.length, 2); assert.equal(fake.lookups.length, 2);
  assert.equal(fake.calls[0].options.headers['Accept-Encoding'], 'identity');
  assert.deepEqual(fake.calls[0].options.proxyEnv, {});
  assert.equal(fake.calls[0].options.rejectUnauthorized, true);
  assert.equal(fake.calls[0].options.agent, false);
  assert.equal(progress.at(-1).receivedBytes, result.size);
  assert.ok(progress.every(value => Object.keys(value).every(key => ['receivedBytes', 'totalBytes'].includes(key))));
  assert.deepEqual(fs.readdirSync(directory), ['source.html']);
});

test('known public validator and DNS pinning stay in force with test seams; bad addresses never open a connection', async t => {
  const directory = scratch(t), fixture = make([{ body: 'Safe' }]);
  for (const url of ['http://public-domain.com/a', 'https://127.0.0.1/a', 'https://user:TOP_SECRET@public-domain.com/a', 'https://public-domain.com:444/a', 'https://0x7f000001/a']) {
    await rejectsSafe(fixture.download({ url, directory }), 400);
  }
  assert.equal(fixture.transport.calls.length, 0);
  const fake = fakeHttps([{ body: 'Safe' }], [{ address: PUBLIC, family: 4 }, { address: '10.0.0.1', family: 4 }]);
  await rejectsSafe(createUrlSourceDownloader({ transport: fake.transport })({ url: SOURCE, directory }), 400);
  assert.equal(fake.calls.length, 0);
  assert.deepEqual(fs.readdirSync(directory), []);
});

test('text originals retain exact UTF-8 and UTF-16 bytes, decoded content and final whitespace', async t => {
  const text = 'Full text\r\n你好 😀\nComplete final line.\n';
  const variants = [body(text), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body(text)]),
    Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]),
    Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, 'utf16le').swap16()])];
  for (const original of variants) {
    const directory = scratch(t), { download } = make([{ body: original }]);
    const result = await download({ url: SOURCE, directory, mode: 'webpage' });
    assert.equal(result.text, text); assert.deepEqual(fs.readFileSync(result.file), original);
    assert.equal(result.provenance.type, 'text'); assert.equal(result.size, original.length);
  }
  const { download } = make([{ body: '# Notes\nLast paragraph\n', type: 'text/plain' }]);
  const markdown = await download({ url: 'https://static.public-domain.com/notes.md?token=TOP_SECRET', directory: scratch(t) });
  assert.equal(markdown.extension, 'md'); assert.ok(markdown.text.endsWith('paragraph\n'));
});

test('deferred HTML/TXT/MD return complete originals, privacy warnings and no text or parser calls', async t => {
  let parsed = 0, youtubeLoads = 0;
  for (const mode of ['auto', 'webpage']) for (const [extension, type, original] of [
    ['html', 'text/html', '<title>Not parsed yet</title><pre>  anti<b>body</b>\n</pre><video src="ignored.mp4"></video>'],
    ['txt', 'text/plain', '  Complete text\r\n最后一行\n'],
    ['md', 'text/markdown', '# Notes\n  Final paragraph\n'],
  ]) {
    const fixture = make([{ type, body: original }], {
      extractWeb() { parsed++; throw new Error('Must not parse TOP_SECRET'); },
      youtubeLoader() { youtubeLoads++; throw new Error('Must not load TOP_SECRET'); },
    });
    const directory = scratch(t), progress = [];
    const result = await fixture.download({ url: SOURCE, directory, mode, deferTextExtraction: true, onProgress: value => progress.push(value) });
    assert.equal(result.textPending, true); assert.equal(Object.hasOwn(result, 'text'), false);
    assert.equal(Object.hasOwn(result.provenance, 'title'), false);
    assert.equal(result.extension, extension); assert.equal(result.kind, 'text');
    assert.equal(result.size, Buffer.byteLength(original)); assert.equal(result.file, join(directory, `source.${extension}`));
    assert.equal(fs.readFileSync(result.file, 'utf8'), original);
    assert.equal(fs.lstatSync(result.file).isFile(), true); assert.equal(fs.lstatSync(result.file).isSymbolicLink(), false);
    assert.deepEqual(fs.readdirSync(directory), [`source.${extension}`]);
    assert.equal(result.provenance.type, extension === 'html' ? 'webpage' : 'text');
    assert.equal(result.provenance.citationUrl, 'https://static.public-domain.com/lesson');
    assert.ok(result.warnings.some(warning => /query parameters and fragments/.test(warning)));
    assert.equal(result.warnings.includes(WEB_WARNINGS[0]), extension === 'html');
    assert.doesNotMatch(result.warnings.join(' '), /TOP_SECRET|https?:\/\//);
    assert.equal(progress.at(-1).receivedBytes, result.size);
    assert.equal(fixture.transport.calls.length, 1);
  }
  assert.equal(parsed, 0); assert.equal(youtubeLoads, 0);
});

test('immediate extraction remains the default and deferral requires an actual boolean', async t => {
  let parsed = 0;
  for (const options of [{}, { deferTextExtraction: false }]) {
    const fixture = make([{ type: 'text/html', body: '<title>Known title</title><p>anti<b>body</b></p>' }], {
      extractWeb(...args) { parsed++; return localParser(...args); },
    });
    const result = await fixture.download({ url: SOURCE, directory: scratch(t), ...options });
    assert.equal(result.text, 'antibody'); assert.equal(result.provenance.title, 'Known title');
    assert.equal(Object.hasOwn(result, 'textPending'), false);
  }
  assert.equal(parsed, 2);
  const fixture = make([{ body: 'Must not download' }]);
  for (const deferTextExtraction of ['true', 1, null, {}, []]) {
    await rejectsSafe(fixture.download({ url: SOURCE, directory: scratch(t), deferTextExtraction }), 400);
  }
  assert.equal(fixture.transport.calls.length, 0);
});

test('deferred validation failures happen only during local extraction and never delete the original', async t => {
  let parsed = 0;
  for (const [extension, type, original, code] of [
    ['txt', 'text/plain', Buffer.from([0xc3, 0x28]), 'encoding'],
    ['md', 'text/markdown', Buffer.from('No BOM', 'utf16le'), 'encoding'],
    ['txt', 'text/plain', '   ', 'empty'],
    ['txt', 'text/plain', 'x'.repeat(WEB_LIMITS.textLength + 1), 'text'],
    ['html', 'text/html', Buffer.concat([body('<p>Prefix</p>'), Buffer.from([0xc3, 0x28])]), 'encoding'],
    ['html', 'text/html', '<div id="root"></div><script>run()</script>', 'empty'],
    ['html', 'text/html', '<h1>403 Forbidden</h1>', 'empty'],
  ]) {
    const fixture = make([{ type, body: original }], { extractWeb() { parsed++; throw new Error('TOP_SECRET'); } });
    const result = await fixture.download({ url: SOURCE, directory: scratch(t), deferTextExtraction: true });
    assert.equal(result.extension, extension); assert.equal(result.textPending, true);
    const hash = digest(result.file);
    await assert.rejects(extractSavedUrlText(result), error => error instanceof WebExtractError && error.code === code);
    assert.equal(digest(result.file), hash); assert.equal(fixture.transport.calls.length, 1);
  }
  assert.equal(parsed, 0);
  const tooBig = make([{ type: 'text/html', body: ' '.repeat(WEB_LIMITS.inputBytes + 1) }], { extractWeb() { parsed++; } });
  await rejectsSafe(tooBig.download({ url: SOURCE, directory: scratch(t), deferTextExtraction: true }), 413);
  assert.equal(parsed, 0);
});

test('saved text extraction is local-only, fatal and lossless for UTF-8 and BOM-marked UTF-16 TXT/MD', async t => {
  const text = '  First\r\n第二段 😀\nFull tail.\n\t';
  for (const extension of ['txt', 'md']) for (const content of [body(text), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body(text)]),
    Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]),
    Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, 'utf16le').swap16()])]) {
    const input = saved(t, extension, content), hash = digest(input.file);
    assert.deepEqual(await extractSavedUrlText(input), { text, warnings: [] });
    assert.equal(digest(input.file), hash);
  }
  for (const content of [Buffer.from([0xc3, 0x28]), Buffer.from([0xff, 0xfe, 0]), Buffer.from([0xfe, 0xff, 0xdc, 0]),
    Buffer.from('No BOM', 'utf16le'), body('binary\0control')]) {
    await assert.rejects(extractSavedUrlText(saved(t, 'txt', content)), error => error.code === 'encoding');
  }
});

test('saved HTML uses the isolated static worker and ignores per-call network/parser/YouTube overrides', async t => {
  const html = '<title>Local &amp; faithful</title><pre>  anti<b>body</b>\n    &#x4e2d;<span>文</span>  \n</pre>' +
    '<video src="https://private.public-domain.com/ignore.mp4?token=TOP_SECRET"></video><script>fetch("https://private.public-domain.com")</script>';
  const input = saved(t, 'html', html), hash = digest(input.file);
  let overrides = 0;
  const trap = () => { overrides++; throw new Error('Must not call TOP_SECRET'); };
  const result = await extractSavedUrlText({ ...input, url: SOURCE, mode: 'video', extractWeb: trap,
    transport: { downloadSourceFile: trap }, youtubeLoader: trap, workerFile: 'TOP_SECRET' });
  assert.deepEqual(result, { text: '  antibody\n    中文  \n', title: 'Local & faithful', warnings: [WEB_WARNINGS[0]] });
  assert.equal(overrides, 0); assert.equal(digest(input.file), hash);
});

test('a local worker failure retries the same sealed original without refetch or automatic parser retry', async t => {
  const html = '<title>Retained lesson</title><pre>  code\n</pre>', directory = scratch(t);
  let acquisitionParses = 0, localParses = 0;
  const fixture = make([{ type: 'text/html', body: html }], { extractWeb() { acquisitionParses++; throw new Error('TOP_SECRET'); } });
  const acquired = await fixture.download({ url: SOURCE, directory, deferTextExtraction: true });
  const hash = digest(acquired.file), controller = new AbortController();
  const extract = createUrlTextExtractor({ extractWeb(bytes, options) {
    localParses++;
    assert.equal(bytes.toString('utf8'), html); assert.equal(options.mode, 'webpage');
    assert.equal(options.signal, controller.signal); assert.equal(options.timeoutMs, WEB_LIMITS.timeoutMs);
    if (localParses === 1) throw new WebExtractError('worker');
    return localParser(bytes, options);
  } });
  fs.chmodSync(acquired.file, 0o400);
  try {
    await assert.rejects(extract({ ...acquired, signal: controller.signal }), error => error.code === 'worker');
    assert.equal(localParses, 1); assert.equal(digest(acquired.file), hash);
    assert.equal(fixture.transport.calls.length, 1);
    const retried = await extract({ ...acquired, signal: controller.signal });
    assert.deepEqual(retried, { text: '  code\n', title: 'Retained lesson', warnings: [WEB_WARNINGS[0]] });
    assert.equal(localParses, 2); assert.equal(acquisitionParses, 0);
    assert.equal(fixture.transport.calls.length, 1); assert.equal(digest(acquired.file), hash);
    assert.deepEqual(fs.readdirSync(directory), ['source.html']);
  } finally { fs.chmodSync(acquired.file, 0o600); }
});

test('saved extraction validates options, regular-file size and canonical private ancestry before parsing', async t => {
  let parsed = 0;
  const extract = createUrlTextExtractor({ extractWeb(...args) { parsed++; return localParser(...args); } });
  const input = saved(t, 'html', '<p>Saved</p>');
  for (const options of [
    { file: 'source.html' }, { file: SOURCE }, { file: `${input.file}\0` }, { file: null },
    { extension: 'mp4' }, { extension: '.html' }, { extension: 'HTML' }, { size: 0 }, { size: -1 },
    { size: 1.5 }, { size: String(input.size) }, { size: NaN }, { size: undefined }, { signal: {} },
    ...(process.platform === 'win32' ? [{ file: '\\\\private-host\\share\\source.html' }, { file: `${input.file}:stream` }] : []),
  ]) await rejectsSafe(extract({ ...input, ...options }), 400);
  await rejectsSafe(extract({ ...input, size: WEB_LIMITS.inputBytes + 1 }), 413);
  await rejectsSafe(extract({ ...input, size: input.size + 1 }), 422);
  await rejectsSafe(extract({ ...input, file: join(dirname(input.file), 'missing-TOP_SECRET.html') }), 422);
  await rejectsSafe(extract({ ...input, file: dirname(input.file) }), 422);
  const empty = saved(t, 'html', '');
  await rejectsSafe(extract({ ...empty, size: 1 }), 422);
  const root = scratch(t), actual = join(root, 'actual'), alias = join(root, 'alias');
  fs.mkdirSync(actual); fs.mkdirSync(join(actual, 'child'));
  fs.writeFileSync(join(actual, 'child', 'source.html'), '<p>Saved</p>');
  fs.symlinkSync(actual, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await rejectsSafe(extract({ ...input, file: join(alias, 'child', 'source.html') }), 400);
  // A terminal link is rejected too, independently of ancestor validation.
  await rejectsSafe(extract({ ...input, file: alias }), 422);
  assert.equal(parsed, 0);
  assert.throws(() => createUrlTextExtractor({ extractWeb: null }), TypeError);
});

test('saved extraction rejects changed or incomplete files before invoking the HTML parser', async t => {
  let parsed = 0;
  const extract = createUrlTextExtractor({ extractWeb() { parsed++; } });
  const read = fs.readSync;
  for (const change of ['grow', 'incomplete']) {
    const input = saved(t, 'html', '<p>Saved</p>');
    const replacement = t.mock.method(fs, 'readSync', (...args) => {
      if (change === 'incomplete') return 0;
      const count = read(...args);
      fs.appendFileSync(input.file, 'extra');
      return count;
    });
    try { await rejectsSafe(extract(input), 422); }
    finally { replacement.mock.restore(); }
  }
  assert.equal(parsed, 0);
});

test('saved extractor enforces exact 8 MiB input and 2M decoded text bounds without truncation', async t => {
  const extract = createUrlTextExtractor({ extractWeb: localParser });
  const prefix = '<!--', suffix = '--><pre>  Full tail\n</pre>';
  const exactBytes = prefix + 'x'.repeat(WEB_LIMITS.inputBytes - prefix.length - suffix.length) + suffix;
  assert.equal((await extract(saved(t, 'html', exactBytes))).text, '  Full tail\n');
  await rejectsSafe(extract(saved(t, 'html', exactBytes + ' ')), 413);
  const exactText = 'x'.repeat(WEB_LIMITS.textLength - 9) + 'FULLTAIL\n';
  for (const extension of ['txt', 'md', 'html']) {
    const content = extension === 'html' ? `<pre>${exactText}</pre>` : exactText;
    assert.equal((await extract(saved(t, extension, content))).text, exactText);
    await assert.rejects(extract(saved(t, extension, content + 'x')), error => error.code === 'text');
  }
});

test('saved extraction honors cancellation without leaking the abort reason or starting another operation', async t => {
  let parsed = 0;
  const before = new AbortController(); before.abort(new Error('https://private.public-domain.com/TOP_SECRET'));
  const extract = createUrlTextExtractor({ extractWeb() { parsed++; } });
  await rejectsSafe(extract({ ...saved(t, 'html', '<p>Text</p>'), signal: before.signal }), 499);
  assert.equal(parsed, 0);
  for (const reject of [false, true]) {
    const during = new AbortController(), input = saved(t, 'html', '<p>Text</p>'), hash = digest(input.file);
    const cancelled = createUrlTextExtractor({ async extractWeb(bytes, options) {
      assert.equal(options.signal, during.signal);
      during.abort(new Error('TOP_SECRET'));
      if (reject) throw new Error('TOP_SECRET');
      return localParser(bytes, options);
    } });
    await rejectsSafe(cancelled({ ...input, signal: during.signal }), 499);
    assert.equal(digest(input.file), hash); assert.equal(getEventListeners(during.signal, 'abort').length, 0);
  }
});

test('saved extractor rejects unsafe worker metadata and hides raw local errors without modifying input', async t => {
  const input = saved(t, 'html', '<p>Text</p>'), hash = digest(input.file);
  for (const value of [null, { text: null, warnings: [] }, { text: 'Text', title: 'TOP_SECRET\n', warnings: [] },
    { text: 'Text', warnings: ['https://private.public-domain.com/TOP_SECRET'] }, { text: 'Access denied', warnings: [] }]) {
    await rejectsSafe(createUrlTextExtractor({ extractWeb: async () => value })(input), 422);
  }
  await rejectsSafe(createUrlTextExtractor({ extractWeb() { throw new Error('https://private.public-domain.com/TOP_SECRET'); } })(input), 422);
  assert.equal(digest(input.file), hash);
});

test('fatal/empty/dynamic/error/overlimit text rejects without replacement or truncation', async t => {
  for (const plan of [
    { body: Buffer.from([0xc3, 0x28]) }, { body: Buffer.from('No BOM', 'utf16le') }, { body: '' },
    { body: '   ' }, { body: 'Access denied' }, { type: 'text/html', body: '<html><title>Title</title><div id="app"></div><script>run()</script></html>' },
    { type: 'text/html', body: '<h1>403 Forbidden</h1>' }, { body: 'x'.repeat(WEB_LIMITS.textLength + 1) },
    { type: 'text/html', body: '<p>' + 'x'.repeat(WEB_LIMITS.textLength + 1) + '</p>' },
    { type: 'text/html', body: ' '.repeat(WEB_LIMITS.inputBytes + 1) },
  ]) {
    const { download } = make([plan]);
    await rejectsSafe(download({ url: SOURCE, directory: scratch(t) }));
  }
});

test('declared HTML fragments, plain HTML bodies and long leading whitespace use full fatal text validation', async t => {
  for (const html of ['<b>Fragment</b>', 'A plain text HTML response.', ' '.repeat(70_000) + '<h1>Untruncated tail</h1>']) {
    const fixture = make([{ type: 'text/html', body: html }]);
    const result = await fixture.download({ url: SOURCE, directory: scratch(t) });
    assert.equal(result.extension, 'html'); assert.equal(result.text, parseWebHtml(body(html)).text);
    assert.equal(fs.readFileSync(result.file, 'utf8'), html);
  }
});

test('MIME/signature/safe extension classification supports document and media originals', async t => {
  const variants = [
    ['pdf', 'application/pdf', body('%PDF-1.7\nsynthetic')],
    ['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', Buffer.from('504b030400000000', 'hex')],
    ['pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', Buffer.from('504b030400000000', 'hex')],
    ['mp3', 'audio/mpeg', MP3], ['mp4', 'video/mp4', MP4], ['webm', 'video/webm', WEBM], ['wav', 'audio/wav', WAV], ['ogg', 'audio/ogg', OGG],
  ];
  for (const [extension, type, data] of variants) {
    const { download } = make([{ type, body: data }]), directory = scratch(t);
    const result = await download({ url: `https://static.public-domain.com/material.${extension}?token=TOP_SECRET`, directory });
    assert.equal(result.extension, extension); assert.equal(result.file, join(directory, `source.${extension}`));
    assert.deepEqual(fs.readFileSync(result.file), data);
    assert.equal(result.kind, ['pdf', 'docx', 'pptx'].includes(extension) ? 'document' : 'media');
    assert.equal(result.text, undefined); assert.equal(result.size, data.length);
    assert.equal(result.provenance.type, result.kind === 'document' ? 'direct-document' : 'direct-media');
  }
  const generic = make([{ type: 'application/octet-stream', body: MP4 }]);
  assert.equal((await generic.download({ url: SOURCE, directory: scratch(t) })).extension, 'mp4');
});

test('mislabeled binaries, unsupported types, unsafe suffixes and MIME/extension conflicts never become accepted media', async t => {
  for (const [url, plan] of [
    [SOURCE, { type: 'video/mp4', body: '<html><p>Text, not a video.</p></html>' }],
    [SOURCE, { type: 'video/mp4', body: MP3 }], [SOURCE, { type: 'application/pdf', body: 'not a PDF' }],
    [SOURCE, { type: 'text/plain', body: MP4 }], [SOURCE, { type: 'application/javascript', body: 'run()' }],
    [SOURCE, { type: 'image/svg+xml', body: '<svg></svg>' }], [SOURCE, { type: 'application/octet-stream', body: 'opaque unknown data' }],
    ['https://static.public-domain.com/renamed.mp3', { type: 'video/mp4', body: MP4 }],
    ['https://static.public-domain.com/renamed.pdf', { type: 'text/plain', body: 'error body' }],
    ['https://static.public-domain.com/renamed.pptx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', body: Buffer.from('504b0304', 'hex') }],
  ]) await rejectsSafe(make([plan]).download({ url, directory: scratch(t) }), 415);
  // A download endpoint need not have a filename; generated output never adopts it.
  const result = await make([{ type: 'application/pdf', body: '%PDF-1.7\nsynthetic' }]).download({ url: 'https://static.public-domain.com/download.php?name=../../TOP_SECRET.exe', directory: scratch(t) });
  assert.equal(result.name, 'source.pdf'); assert.ok(result.name.length <= 180);
});

test('mode dispatch is explicit and never substitutes text or drops visuals for video/audio', async t => {
  for (const [mode, plan] of [
    ['video', { body: 'captions are not a video' }], ['video', { body: MP3, type: 'audio/mpeg' }],
    ['video', { body: MP4, type: 'audio/mp4' }], ['video', { body: WEBM, type: 'audio/webm' }],
    ['audio', { body: MP4, type: 'video/mp4' }], ['audio', { body: WEBM, type: 'audio/webm' }],
    ['audio', { body: OGG, type: 'audio/ogg' }], ['webpage', { body: MP4, type: 'video/mp4' }],
    ['webpage', { body: '%PDF-1.7\nfixture', type: 'application/pdf' }],
  ]) await rejectsSafe(make([plan]).download({ url: SOURCE, directory: scratch(t), mode }), 422);
  for (const [type, data] of [['audio/mpeg', MP3], ['audio/wav', WAV]]) {
    assert.equal((await make([{ type, body: data }]).download({ url: SOURCE, directory: scratch(t), mode: 'audio' })).kind, 'media');
  }
  const html = '<p>Static information.</p><video src="movie.mp4"></video>';
  const auto = make([{ type: 'text/html', body: html }]);
  const result = await auto.download({ url: SOURCE, directory: scratch(t) });
  assert.equal(result.kind, 'text'); assert.equal(result.text, 'Static information.'); assert.equal(auto.transport.calls.length, 1);
});

test('explicit video resolves one deduplicated native link, retains both originals and shares cumulative budget/progress', async t => {
  const html = '<title>Native lesson</title><video src="../clip.mp4?token=TOP_SECRET"><source src="../clip.mp4?token=TOP_SECRET" type="video/mp4"></video><audio src="ignored.mp3"></audio>';
  const fixture = make([{ type: 'text/html', body: html, finalUrl: 'https://static.public-domain.com/pages/view?token=TOP_SECRET' }, { type: 'video/mp4', body: MP4 }]);
  const directory = scratch(t), progress = [], budget = Buffer.byteLength(html) + MP4.length;
  const result = await fixture.download({ url: SOURCE, directory, mode: 'video', maxBytes: budget, onProgress: value => progress.push(value) });
  assert.equal(result.kind, 'media'); assert.equal(result.extension, 'mp4'); assert.equal(result.text, undefined);
  assert.equal(result.size, MP4.length); assert.equal(result.provenance.title, 'Native lesson');
  assert.equal(result.provenance.citationUrl, 'https://static.public-domain.com/pages/view');
  assert.equal(fixture.transport.calls.length, 2);
  assert.equal(fixture.transport.calls[1].url, 'https://static.public-domain.com/clip.mp4?token=TOP_SECRET');
  assert.equal(fixture.transport.calls[1].options.maxBytes, MP4.length);
  assert.ok(fixture.transport.calls[1].options.timeoutMs <= fixture.transport.calls[0].options.timeoutMs);
  assert.equal(fixture.transport.calls[1].options.signal, fixture.transport.calls[0].options.signal);
  assert.equal(progress.at(-1).receivedBytes, budget); assert.ok(progress.every(value => value.totalBytes === undefined));
  assert.deepEqual(fs.readdirSync(directory).sort(), ['source.html', 'source.mp4']);
  assert.equal(fs.readFileSync(join(directory, 'source.html'), 'utf8'), html);
  assert.deepEqual(fs.readFileSync(result.file), MP4);
  assert.doesNotMatch(result.warnings.join(' '), /TOP_SECRET|https?:\/\//);
});

test('deferral never bypasses intermediate video HTML selection or marks media/documents as text pending', async t => {
  let parsed = 0;
  const fixture = make([{ type: 'text/html', body: '<title>Native</title><video><div><source src="inactive.mp4"></div><source src="active.mp4"></video>' },
    { type: 'video/mp4', body: MP4 }], { extractWeb(bytes, options) { parsed++; assert.equal(options.mode, 'video'); return localParser(bytes, options); } });
  const result = await fixture.download({ url: SOURCE, directory: scratch(t), mode: 'video', deferTextExtraction: true });
  assert.equal(parsed, 1); assert.equal(fixture.transport.calls.length, 2);
  assert.equal(fixture.transport.calls[1].url, 'https://static.public-domain.com/active.mp4');
  assert.equal(result.kind, 'media'); assert.equal(Object.hasOwn(result, 'textPending'), false);
  assert.equal(Object.hasOwn(result, 'text'), false); assert.equal(result.provenance.title, 'Native');
  for (const [type, content] of [['video/mp4', MP4], ['application/pdf', '%PDF-1.7\nsynthetic']]) {
    const direct = make([{ type, body: content }], { extractWeb() { parsed++; throw new Error('Must not parse TOP_SECRET'); } });
    const original = await direct.download({ url: SOURCE, directory: scratch(t), deferTextExtraction: true });
    assert.equal(Object.hasOwn(original, 'textPending'), false); assert.equal(Object.hasOwn(original, 'text'), false);
  }
  assert.equal(parsed, 1);
});

test('native nested fallback and non-direct source elements cannot cause a second acquisition, deferred or not', async t => {
  for (const deferTextExtraction of [false, true]) for (const html of [
    '<video><video src="fallback.mp4"></video></video>',
    '<video><div><source src="not-direct.mp4"></div></video>',
    '<audio><video src="fallback.mp4"></video></audio>',
    '<video src="outer.mp4"><div><audio src="fallback.mp3"></audio></div></video>',
    '<video><source src="outer.mp4"><video hidden src="fallback.mp4"></video></video>',
    '<p>Text</p><video hidden><source src="hidden.mp4"></video>',
  ]) {
    const fixture = make([{ type: 'text/html', body: html }, { type: 'video/mp4', body: MP4 }]);
    const directory = scratch(t);
    await rejectsSafe(fixture.download({ url: SOURCE, directory, mode: 'video', deferTextExtraction }), 422);
    assert.equal(fixture.transport.calls.length, 1);
    assert.deepEqual(fs.readdirSync(directory), ['source.html']);
  }
});

test('native video ambiguity, unsafe candidates, scripted/embedded players and recursive pages are rejected without extra discovery', async t => {
  for (const html of [
    '<p>Text</p><iframe src="https://players.public-domain.com/player"></iframe>',
    '<p>Text</p><script>const url="movie.mp4"</script>', '<audio src="sound.mp3"></audio>',
    '<video src="one.mp4"><source src="two.webm"></video>',
    '<video src="http://static.public-domain.com/movie.mp4"></video>', '<video src="https://127.0.0.1/movie.mp4"></video>',
    '<video src="https:////static.public-domain.com/movie.mp4"></video>', '<video src="https://static.public-domain.com:0443/movie.mp4"></video>',
    '<video src="https://user:TOP_SECRET@static.public-domain.com/movie.mp4"></video>', '<video src="//localhost/movie.mp4"></video>',
    '<video src="data:video/mp4,TOP_SECRET"></video>', '<video src="blob:https://static.public-domain.com/id"></video>',
    '<video><source src="playlist.m3u8" type="application/vnd.apple.mpegurl"></video>',
    '<video src="https://www.youtube.com/watch?v=abcdefghijk"></video>',
  ]) {
    const fixture = make([{ type: 'text/html', body: html }]);
    await rejectsSafe(fixture.download({ url: SOURCE, directory: scratch(t), mode: 'video' }));
    assert.equal(fixture.transport.calls.length, 1);
  }
  const fixture = make([
    { type: 'text/html', body: '<video src="next.html"></video>' },
    { type: 'text/html', body: '<video src="third.mp4"></video>' },
  ]);
  await rejectsSafe(fixture.download({ url: SOURCE, directory: scratch(t), mode: 'video' }), 422);
  assert.equal(fixture.transport.calls.length, 2);
});

test('aggregate byte budget includes the HTML original and cannot reset for its media resource', async t => {
  const html = '<video src="movie.mp4"></video>';
  const fixture = make([{ type: 'text/html', body: html }, { type: 'video/mp4', body: MP4 }]);
  const directory = scratch(t);
  await rejectsSafe(fixture.download({ url: SOURCE, directory, mode: 'video', maxBytes: Buffer.byteLength(html) + MP4.length - 1 }), 413);
  assert.equal(fixture.transport.calls[1].options.maxBytes, MP4.length - 1);
  assert.equal(fs.readFileSync(join(directory, 'source.html'), 'utf8'), html);
  assert.equal(fs.existsSync(join(directory, 'source.mp4')), false);
});

test('one total deadline includes page download, parser and resource; abort settles downloader before rejection', async t => {
  let mediaStopped = false;
  const fixture = make([
    { type: 'text/html', body: '<video src="movie.mp4"></video>', delay: 20 },
    { type: 'video/mp4', body: MP4, hang: true, onCall({ options }) { options.signal.addEventListener('abort', () => { mediaStopped = true; }, { once: true }); } },
  ], { timeoutMs: 120 });
  const started = performance.now();
  await rejectsSafe(fixture.download({ url: SOURCE, directory: scratch(t), mode: 'video' }), 504);
  assert.ok(mediaStopped); assert.equal(fixture.transport.calls.length, 2);
  assert.ok(fixture.transport.calls[1].options.timeoutMs < 110);
  assert.ok(performance.now() - started < 2000);
  const controller = new AbortController();
  const cancelled = make([{ hang: true, onCall() { queueMicrotask(() => controller.abort(new Error('TOP_SECRET'))); } }]);
  await rejectsSafe(cancelled.download({ url: SOURCE, directory: scratch(t), signal: controller.signal }), 499);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.equal(cancelled.transport.calls.length, 1);
});

test('exclusive source filename never overwrites existing files and successful output is directly inside owned directory', async t => {
  const directory = scratch(t), existing = join(directory, 'source.txt');
  fs.writeFileSync(existing, 'Existing original');
  const fixture = make([{ body: 'New text' }]);
  await rejectsSafe(fixture.download({ url: SOURCE, directory }));
  assert.equal(fs.readFileSync(existing, 'utf8'), 'Existing original');
  const ownTemporary = fs.readdirSync(directory).filter(name => /^\.source-.*\.download$/.test(name));
  assert.equal(ownTemporary.length, 1); assert.equal(fs.readFileSync(join(directory, ownTemporary[0]), 'utf8'), 'New text');
  const clean = scratch(t);
  const result = await make([{ body: 'New text' }]).download({ url: SOURCE, directory: clean });
  assert.equal(dirname(result.file), clean); assert.ok(fs.lstatSync(result.file).isFile()); assert.equal(fs.lstatSync(result.file).isSymbolicLink(), false);
});

test('directory symlinks or junction ancestors cannot redirect output outside the provided private directory', async t => {
  const root = scratch(t), actual = join(root, 'actual'), alias = join(root, 'alias');
  fs.mkdirSync(actual); fs.mkdirSync(join(actual, 'child'));
  fs.symlinkSync(actual, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const fixture = make([{ body: 'Safe' }]);
  await rejectsSafe(fixture.download({ url: SOURCE, directory: alias }), 400);
  await rejectsSafe(fixture.download({ url: SOURCE, directory: join(alias, 'child') }), 400);
  assert.equal(fixture.transport.calls.length, 0);
});

test('errors and warnings cannot include raw downloader or worker errors; injection exists only at construction', async t => {
  const fixture = make([{ error: new Error('https://secret.public-domain.com/?key=TOP_SECRET') }]);
  await rejectsSafe(fixture.download({ url: SOURCE, directory: scratch(t) }));
  const parser = make([{ type: 'text/html', body: '<p>Safe</p>' }], { extractWeb: async () => { throw new Error('TOP_SECRET'); } });
  await rejectsSafe(parser.download({ url: SOURCE, directory: scratch(t) }));
  let overrideCalled = false;
  const safe = make([{ body: 'Safe' }]);
  const result = await safe.download({ url: SOURCE, directory: scratch(t), transport: { downloadSourceFile() { overrideCalled = true; } }, youtubeLoader() { overrideCalled = true; }, workerFile: 'TOP_SECRET' });
  assert.equal(result.text, 'Safe'); assert.equal(overrideCalled, false);
  assert.equal(sourceCitationUrl('https://static.public-domain.com/a?q=TOP_SECRET#TOP_SECRET'), 'https://static.public-domain.com/a');
});

test('YouTube delegates lazily to exact helper contract, keeps real video original and canonical v citation only', async t => {
  let loads = 0, argumentsSeen;
  const directory = scratch(t);
  const fixture = make([], { youtubeLoader: async () => {
    loads++;
    return {
      youtubeVideoUrl(value) { assert.equal(value, 'https://youtu.be/abcdefghijk?t=7#TOP_SECRET'); return 'https://www.youtube.com/watch?v=abcdefghijk'; },
      async acquireYouTubeVideo(options) {
        argumentsSeen = options;
        const file = join(options.directory, 'source.mp4'); fs.writeFileSync(file, MP4, { flag: 'wx' });
        return { file, extension: 'mp4', size: MP4.length, kind: 'media', name: 'Native lesson.mp4',
          provenance: { type: 'youtube', title: 'Native lesson' }, warnings: ['Only a public progressive audiovisual format is supported.'] };
      },
    };
  } });
  const result = await fixture.download({ url: 'https://youtu.be/abcdefghijk?t=7#TOP_SECRET', directory, mode: 'video', maxBytes: 4096, deferTextExtraction: true });
  assert.equal(Object.hasOwn(result, 'textPending'), false);
  assert.equal(loads, 1); assert.equal(fixture.transport.calls.length, 0);
  assert.equal(argumentsSeen.url, 'https://www.youtube.com/watch?v=abcdefghijk'); assert.equal(argumentsSeen.directory, directory);
  assert.equal(argumentsSeen.maxBytes, 4096); assert.ok(argumentsSeen.signal instanceof AbortSignal);
  assert.deepEqual(fs.readFileSync(result.file), MP4); assert.equal(result.text, undefined);
  assert.equal(result.provenance.type, 'youtube'); assert.equal(result.provenance.citationUrl, 'https://www.youtube.com/watch?v=abcdefghijk');
  assert.doesNotMatch(JSON.stringify(result.warnings), /TOP_SECRET|https?:\/\//);
  const plain = make([{ body: 'Text' }], { youtubeLoader() { throw new Error('Should not load TOP_SECRET'); } });
  assert.equal((await plain.download({ url: SOURCE, directory: scratch(t) })).text, 'Text');
});

test('YouTube rejects unsupported URL, captions, audio-only results and unsanitized metadata without downgrade', async t => {
  for (const mode of ['audio', 'webpage']) {
    const fixture = make([], { youtubeLoader: () => { throw new Error('Must not load TOP_SECRET'); } });
    await rejectsSafe(fixture.download({ url: 'https://www.youtube.com/watch?v=abcdefghijk', directory: scratch(t), mode }), 422);
  }
  for (const resultType of ['unsupported', 'captions', 'audio', 'warning', 'throw']) {
    const fixture = make([], { youtubeLoader: async () => ({
      youtubeVideoUrl() { return resultType === 'unsupported' ? null : 'https://www.youtube.com/watch?v=abcdefghijk'; },
      async acquireYouTubeVideo({ directory }) {
        if (resultType === 'throw') throw new Error('YouTube TOP_SECRET https://private.public-domain.com');
        const file = join(directory, 'source.mp4'); fs.writeFileSync(file, MP4, { flag: 'wx' });
        return { file, extension: resultType === 'audio' ? 'mp3' : 'mp4', size: MP4.length, kind: 'media',
          ...(resultType === 'captions' ? { text: 'Substituted captions' } : {}),
          warnings: resultType === 'warning' ? ['https://private.public-domain.com/TOP_SECRET'] : [] };
      },
    }) });
    await rejectsSafe(fixture.download({ url: 'https://www.youtube.com/watch?v=abcdefghijk', directory: scratch(t), mode: 'video' }));
    assert.equal(fixture.transport.calls.length, 0);
  }
});
