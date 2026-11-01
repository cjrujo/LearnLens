import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, getEventListeners } from 'node:events';
import { fork } from 'node:child_process';
import fs from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  WEB_LIMITS, WEB_WARNINGS, WebExtractError, decodeSourceText, parseWebHtml, isUnusableWebText,
  extractWebText, createWebExtractor, webWorkerEnvironment,
} from '../lib/web-extract.mjs';

const bytes = text => Buffer.from(text);
const artifacts = fileURLToPath(new URL('../artifacts/', import.meta.url));
function scratch(t) {
  fs.mkdirSync(artifacts, { recursive: true });
  const dir = fs.mkdtempSync(join(artifacts, 'web-extract-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const hasCode = code => error => error instanceof WebExtractError && error.code === code;

const STRUCTURED = `<!DOCTYPE html><html><head><title>Static &amp; faithful</title></head><body>
  <h1>Heading &lt;one&gt;</h1><p>Hello<strong>world</strong>, entities &amp; &#x1f600; and <em>inline</em>words.</p>
  <h2>List</h2><ol><li>First <b>item</b></li><li>Second</li></ol><ul><li>Another</li></ul>
  <table><tr><th>Key</th><th>Value</th></tr><tr><td>Alpha</td><td>Beta</td></tr><tr><td></td><td>Tail cell</td></tr></table>
  <p>Final tail remains.</p></body></html>`;

test('static tokenizer preserves headings, lists, cells, inline boundaries, entities and full tail', () => {
  const result = parseWebHtml(bytes(STRUCTURED));
  assert.equal(result.title, 'Static & faithful');
  assert.equal(result.text, '# Heading <one>\nHelloworld, entities & 😀 and inlinewords.\n## List\n1. First item\n2. Second\n- Another\nKey\tValue\nAlpha\tBeta\n\tTail cell\nFinal tail remains.');
  assert.deepEqual(result.warnings, [WEB_WARNINGS[0]]);
  assert.deepEqual(result.mediaCandidates, []);
});

test('entity decoder chunks are not mistaken for element word boundaries', () => {
  const result = parseWebHtml(bytes('<p>A&amp;B &#65;BC foo&#x62;ar punctuation<b>test</b>! &notin; &#x1f4da;</p>'));
  assert.equal(result.text, 'A&B ABC foobar punctuationtest! ∉ 📚');
});

test('inline boundaries preserve actual whitespace without inserting word or CJK separators', () => {
  const html = '<p>anti<b>body</b> and <span>中</span><span>文</span>; <span>甲</span> <span>乙</span></p>' +
    '<p>Hello<strong>world</strong>; Hello <strong>world</strong>; Hello<strong> world</strong>; Hello<strong> </strong>world</p>' +
    '<p>one<span></span>two<!-- comment -->three <i>\t\n</i>four&nbsp;<b>five</b></p>';
  assert.equal(parseWebHtml(bytes(html)).text,
    'antibody and 中文; 甲 乙\nHelloworld; Hello world; Hello world; Hello world\nonetwothree four\u00a0five');
});

test('preformatted text preserves edge indentation, newlines and entity/inline chunk boundaries', () => {
  const html = ' \n<pre>  def <b>f</b>():\n    <span>return &#49;</span>\n\tx = &lt;value&gt;\n  </pre>\n ';
  assert.equal(parseWebHtml(bytes(html)).text, '  def f():\n    return 1\n\tx = <value>\n  ');
  assert.equal(parseWebHtml(bytes('<pre>\n  <code>first</code>\n\n  last  \n</pre>')).text, '\n  first\n\n  last  \n');
  assert.equal(parseWebHtml(bytes('<p>Before</p><pre>  code\n</pre><p>After</p>')).text, 'Before\n  code\nAfter');
  assert.equal(parseWebHtml(bytes('<pre><b>  </b><i>x</i><br><span> y</span>\t</pre>')).text, '  x\n y\t');
  const prefix = ' '.repeat(16_370), tail = '\r\n  LAST TAIL\t ';
  assert.equal(parseWebHtml(bytes('<pre>' + prefix + '<code>A&#66;C</code>' + tail + '</pre>')).text, prefix + 'ABC' + tail);
  const exact = ' '.repeat(WEB_LIMITS.textLength - 4) + 'TAIL';
  assert.equal(parseWebHtml(bytes('<pre>' + exact + '</pre>')).text, exact);
  assert.throws(() => parseWebHtml(bytes('<pre>' + exact + ' </pre>')), hasCode('text'));
});

test('meaningful whitespace survives output edges and entity chunks without a final trim', () => {
  assert.equal(parseWebHtml(bytes('<p>&nbsp;<span>word</span>&#x2003;</p>')).text, '\u00a0word\u2003');
  assert.equal(parseWebHtml(bytes('<pre>&#32;<b>&#32;</b>x&#10;<span>&#9;</span>&#32;</pre>')).text, '  x\n\t ');
  assert.equal(parseWebHtml(bytes('<pre>  x<br><br></pre>')).text, '  x\n\n');
  assert.equal(parseWebHtml(bytes('<table><tr><td></td><td>value</td><td></td></tr></table>')).text, '\tvalue\t');
  const word = 'x'.repeat(16_378);
  assert.equal(parseWebHtml(bytes('<p>' + word + '<span>&#x4e2d;</span><b>文</b> tail</p>')).text, word + '中文 tail');
});

test('suppresses script/style/nav/template/hidden/embeds and never emits raw URLs in warnings', () => {
  const result = parseWebHtml(bytes(`<html><head><script>fetch('https://secret.public-domain.com/?token=SECRET')</script><style>.x{display:none}</style></head><body>
  <nav>NO_NAV</nav><div role="navigation">NO_ROLE_NAV</div><div hidden="false">NO_HIDDEN</div><div aria-hidden="true">NO_ARIA</div><div inert>NO_INERT</div>
  <div style="color:red;display: none !important;">NO_STYLE</div><span style="visibility: hidden">NO_VISIBILITY</span>
  <div style="content-visibility:hidden">NO_CONTENT</div><div style="display:/* not visible */none">NO_CSS_COMMENT</div><template><p>NO_TEMPLATE</p></template><noscript>Enable JavaScript</noscript>
  <iframe src="https://secret.public-domain.com">NO_IFRAME<video src="leak.mp4"></video></iframe><object>NO_OBJECT</object>
  <svg><text>NO_SVG</text></svg><canvas>NO_CANVAS</canvas><img src="https://secret.public-domain.com/?token=SECRET" onerror="execute()">
  <p>Visible tail.</p></body></html>`), { mode: 'video' });
  assert.equal(result.text, 'Visible tail.');
  assert.deepEqual(result.mediaCandidates, []);
  assert.doesNotMatch(result.warnings.join(' '), /SECRET|https?:\/\//);
});

test('empty, dynamic-only and short access/error pages reject instead of producing a lesson', () => {
  for (const html of [' ', '<html><head><title>Title is not content</title></head><body></body></html>',
    '<div id="root"></div><script>document.body.textContent="Not static"</script>', '<p>Please enable JavaScript to view this page.</p>',
    '<h1>404 Not Found</h1><p>The requested item is missing.</p>', '<p>500 Internal server error</p>', '<p>Page not found</p>', '<p>Access denied</p>', '<p>!!!</p>', '<noscript>Enable JavaScript</noscript>']) {
    assert.throws(() => parseWebHtml(bytes(html)), hasCode('empty'));
  }
  assert.equal(parseWebHtml(bytes('<p>This lesson explains JavaScript and a 404 error.</p>')).text, 'This lesson explains JavaScript and a 404 error.');
});

test('error pages stay errors even if they contain a native video; encoded controls reject', () => {
  assert.throws(() => parseWebHtml(bytes('<h1>503 Unavailable</h1><video src="promo.mp4"></video>'), { mode: 'video' }), hasCode('empty'));
  assert.throws(() => parseWebHtml(bytes('<p>Text &#x1b; more text</p>')), hasCode('encoding'));
});

test('plain decoding accepts UTF-8/BOM UTF-16 LE and BE and preserves original trailing text', () => {
  const text = 'First\r\n第二段 😀\nFull tail.\n';
  assert.equal(decodeSourceText(bytes(text)), text);
  assert.equal(decodeSourceText(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes(text)])), text);
  const le = Buffer.from(text, 'utf16le'), be = Buffer.from(le).swap16();
  assert.equal(decodeSourceText(Buffer.concat([Buffer.from([0xff, 0xfe]), le])), text);
  assert.equal(decodeSourceText(Buffer.concat([Buffer.from([0xfe, 0xff]), be])), text);
  for (const input of [Buffer.from([0xc3, 0x28]), Buffer.from([0xff]), Buffer.from([0xff, 0xfe, 0]),
    Buffer.from([0xff, 0xfe, 0x00, 0xd8]), Buffer.from([0xfe, 0xff, 0xdc, 0]), Buffer.from('no BOM', 'utf16le'), bytes('bad\0bytes')]) {
    assert.throws(() => decodeSourceText(input), hasCode('encoding'));
  }
  assert.throws(() => parseWebHtml(bytes('<meta charset="windows-1252"><p>Text</p>')), hasCode('encoding'));
  assert.throws(() => parseWebHtml(bytes('<meta http-equiv="content-type" content="text/html;charset=utf-16"><p>Text</p>')), hasCode('encoding'));
  assert.equal(parseWebHtml(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('<meta charset="utf-16"><p>Tail</p>', 'utf16le')])).text, 'Tail');
});

test('native candidates are bounded static video/audio/source only, exposed only in video mode', () => {
  const html = `<head><title>Player</title></head><p>Static caption</p><video src="/movie.mp4?x=1&amp;y=2"><source src="other.webm" type="video/webm"></video>
  <audio src="track.mp3"><source src="other.ogg" type="audio/ogg"></audio><picture><source srcset="image.webp" src="image.png"></picture>
  <a href="not-a-native-video.mp4">Link</a><script>url='not-a-native-source.mp4'</script><video hidden src="hidden.mp4"></video>`;
  assert.deepEqual(parseWebHtml(bytes(html)).mediaCandidates, []);
  assert.deepEqual(parseWebHtml(bytes(html), { mode: 'video' }).mediaCandidates, [
    { kind: 'video', url: '/movie.mp4?x=1&y=2' }, { kind: 'video', url: 'other.webm', type: 'video/webm' },
    { kind: 'audio', url: 'track.mp3' }, { kind: 'audio', url: 'other.ogg', type: 'audio/ogg' },
  ]);
  assert.equal(parseWebHtml(bytes('<video src="movie.mp4"></video>'), { mode: 'video' }).text, '');
  assert.throws(() => parseWebHtml(bytes('<video src="movie.mp4"></video>')), hasCode('empty'));
  assert.throws(() => parseWebHtml(bytes('<base href="https://other.public-domain.com/"><video src="movie.mp4"></video>'), { mode: 'video' }), hasCode('base'));
  assert.throws(() => parseWebHtml(bytes('<video>' + '<source src="a.mp4">'.repeat(33) + '</video>'), { mode: 'video' }), hasCode('metadata'));
  assert.throws(() => parseWebHtml(bytes('<video src="' + 'a'.repeat(8193) + '"></video>'), { mode: 'video' }), hasCode('metadata'));
});

test('video selection rejects nested media fallback and collects only direct active media sources', () => {
  for (const outer of ['video', 'audio']) for (const inner of ['video', 'audio']) {
    for (const middle of ['', '<div>']) {
      const html = `<p>Visible page</p><${outer}><source src="outer.mp4">${middle}<${inner} src="fallback.mp4"></${inner}>${middle ? '</div>' : ''}</${outer}>`;
      assert.throws(() => parseWebHtml(bytes(html), { mode: 'video' }), hasCode('media'));
      assert.deepEqual(parseWebHtml(bytes(html)).mediaCandidates, []);
    }
  }
  assert.throws(() => parseWebHtml(bytes('<video src="outer.mp4"><video hidden src="fallback.mp4"></video></video>'), { mode: 'video' }), hasCode('media'));
  const html = '<p>Visible page</p><video><div><source src="not-direct.mp4"></div><source src="active.mp4"></video>' +
    '<audio><span><source src="not-direct.mp3"></span><source src="active.mp3"></audio>' +
    '<video hidden><source src="hidden.mp4"><video src="fallback.mp4"></video></video><source src="orphan.mp4">';
  assert.deepEqual(parseWebHtml(bytes(html), { mode: 'video' }).mediaCandidates,
    [{ kind: 'video', url: 'active.mp4' }, { kind: 'audio', url: 'active.mp3' }]);
  assert.throws(() => parseWebHtml(bytes('<video><div><source src="not-direct.mp4"></div></video>'), { mode: 'video' }), hasCode('empty'));
});

test('fixed input/depth/event/title/text caps reject, never return a truncated prefix', () => {
  assert.throws(() => parseWebHtml(Buffer.alloc(WEB_LIMITS.inputBytes + 1, 32)), hasCode('input'));
  assert.throws(() => parseWebHtml(Buffer.alloc(0)), hasCode('input'));
  assert.throws(() => parseWebHtml(bytes('<div>'.repeat(129) + 'tail' + '</div>'.repeat(129))), hasCode('complexity'));
  assert.throws(() => parseWebHtml(bytes('<br>'.repeat(90_000) + '<p>tail</p>')), hasCode('complexity'));
  assert.throws(() => parseWebHtml(bytes('<title>' + 'a'.repeat(513) + '</title><p>tail</p>')), hasCode('metadata'));
  assert.throws(() => decodeSourceText(bytes('a'.repeat(WEB_LIMITS.textLength + 1))), hasCode('text'));
  assert.throws(() => parseWebHtml(bytes('<p>' + 'a'.repeat(WEB_LIMITS.textLength + 1) + '</p>')), hasCode('text'));
  assert.throws(() => parseWebHtml(bytes('<script>' + 'a'.repeat(WEB_LIMITS.textLength + 1) + '</script><p>Tail</p>')), hasCode('text'));
  const text = 'a'.repeat(WEB_LIMITS.textLength - 8) + 'FULLTAIL';
  assert.equal(parseWebHtml(bytes('<p>' + text + '</p>')).text, text);
});

test('parent-side usability validation handles the full 2M newline limit without cross-line backtracking', () => {
  const whitespace = '\n'.repeat(WEB_LIMITS.textLength);
  assert.equal(isUnusableWebText(whitespace), true);
  assert.equal(isUnusableWebText(whitespace.slice(10) + 'Full tail.'), false);
});

test('real isolated worker preserves output and does not execute page scripts or handlers', async t => {
  const dir = scratch(t), marker = join(dir, 'must-not-exist');
  const result = await extractWebText(bytes(STRUCTURED + `<script>require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed')</script><img src="https://no-fetch.public-domain.com/image" onerror="throw 'SECRET'">`));
  assert.deepEqual(result, parseWebHtml(bytes(STRUCTURED)));
  const pre = await extractWebText(bytes('<pre>  anti<b>body</b>\n    &#x4e2d;<i>文</i>  \n</pre>'));
  assert.equal(pre.text, '  antibody\n    中文  \n');
  await assert.rejects(extractWebText(bytes('<video><video src="fallback.mp4"></video></video>'), { mode: 'video' }), hasCode('media'));
  assert.equal(fs.existsSync(marker), false);
  const long = 'x'.repeat(1_200_000) + ' LAST_UNTRUNCATED_TAIL';
  assert.equal((await extractWebText(bytes('<article>' + long + '</article>'))).text, long);
  await assert.rejects(extractWebText(bytes('<div>'.repeat(150) + 'x')), hasCode('complexity'));
});

test('worker policy filters environment, pins 128 MiB old heap and waits for exit', async () => {
  assert.deepEqual(webWorkerEnvironment({ TEMP: 'scratch', SYSTEMROOT: 'windows', LANG: 'C', PATH: 'untrusted', HOME: 'user', NODE_OPTIONS: '--require bad',
    HTTPS_PROXY: 'secret', OPENAI_API_KEY: 'secret', LEARNLENS_SECRET: 'secret' }), { SYSTEMROOT: 'windows', TEMP: 'scratch', LANG: 'C' });
  let options, killed = false, exited = false;
  const extract = createWebExtractor({ fork(_file, _args, settings) {
    options = settings;
    const child = new EventEmitter(); child.pid = 123;
    child.send = () => queueMicrotask(() => child.emit('message', { result: parseWebHtml(bytes('<p>Safe</p>')) }));
    child.kill = signal => { assert.equal(signal, 'SIGKILL'); killed = true; setImmediate(() => { exited = true; child.emit('exit', 0); }); };
    return child;
  } });
  const controller = new AbortController();
  const result = await extract(bytes('<p>Safe</p>'), { signal: controller.signal });
  assert.equal(result.text, 'Safe'); assert.ok(killed && exited);
  assert.deepEqual(options.execArgv, ['--max-old-space-size=128', '--max-semi-space-size=4']);
  assert.deepEqual(options.stdio, ['ignore', 'ignore', 'ignore', 'ipc']);
  assert.equal(options.serialization, 'advanced');
  assert.equal(options.env.NODE_OPTIONS, undefined); assert.equal(options.env.HTTP_PROXY, undefined);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('in-flight worker cancellation waits for process exit and removes the abort listener', async () => {
  const controller = new AbortController();
  let exited = false;
  const extract = createWebExtractor({ fork() {
    const child = new EventEmitter(); child.pid = 123;
    child.send = () => queueMicrotask(() => controller.abort(new Error('SECRET')));
    child.kill = () => setImmediate(() => { exited = true; child.emit('exit', null); });
    return child;
  } });
  await assert.rejects(extract(bytes('<p>Text</p>'), { signal: controller.signal }), hasCode('cancelled'));
  assert.ok(exited); assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('worker cancellation, real timeout and raw error/result messages are safely rejected', async () => {
  const controller = new AbortController(); controller.abort(new Error('SECRET'));
  await assert.rejects(extractWebText(bytes('<p>Text</p>'), { signal: controller.signal }), hasCode('cancelled'));
  await assert.rejects(extractWebText(bytes('<p>Text</p>'), { timeoutMs: 1 }), hasCode('timeout'));
  for (const message of [{ error: 'https://secret.public-domain.com/?token=SECRET' }, { result: { text: 'SECRET' } },
    { result: { ...parseWebHtml(bytes('<p>Safe</p>')), warnings: ['SECRET'] } }]) {
    const extractor = createWebExtractor({ fork() {
      const child = new EventEmitter(); child.pid = 123;
      child.send = () => queueMicrotask(() => child.emit('message', message));
      child.kill = () => queueMicrotask(() => child.emit('exit', 0));
      return child;
    } });
    await assert.rejects(extractor(bytes('<p>Safe</p>')), error => {
      assert.equal(error.code, 'invalid'); assert.doesNotMatch(error.message, /SECRET|https?:\/\//); return true;
    });
  }
});

test('real worker network guards deny fetch, sockets, TLS, HTTP and DNS without contacting a network', async t => {
  const dir = scratch(t), probe = join(dir, 'probe.mjs');
  const worker = new URL('../lib/web-worker.mjs', import.meta.url).href;
  fs.writeFileSync(probe, `import net from 'node:net'; import tls from 'node:tls'; import http from 'node:http'; import https from 'node:https'; import dns from 'node:dns'; import promises from 'node:dns/promises';
    await import(${JSON.stringify(worker)});
    let denied = 0;
    for (const call of [() => net.connect(443,'network.public-domain.com'), () => tls.connect(443,'network.public-domain.com'), () => http.get('http://network.public-domain.com'), () => https.get('https://network.public-domain.com'), () => dns.lookup('network.public-domain.com'), () => promises.lookup('network.public-domain.com'), () => fetch('https://network.public-domain.com')]) {
      try { await call(); } catch (error) { if (error.message === 'Network access is disabled during static webpage extraction.') denied++; }
    }
    process.send({denied}, () => process.exit(0));`);
  const child = fork(pathToFileURL(probe), [], { execArgv: ['--max-old-space-size=128'], env: webWorkerEnvironment(), stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  t.after(() => child.kill('SIGKILL'));
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Network guard probe timed out')); }, 5000);
    child.once('message', message => { clearTimeout(timer); resolve(message); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
  });
  assert.deepEqual(result, { denied: 7 });
});
