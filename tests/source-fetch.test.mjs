import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, getEventListeners } from 'node:events';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { AppError } from '../lib/provider.mjs';
import { normalizeSourceUrl, isPublicSourceAddress, createSourceTransport } from '../lib/source-fetch.mjs';

// Entirely offline. Never invoke the default transport or open a listener.
const PUBLIC = '93.184.216.34';
const SOURCE = 'https://media.public-domain.com/movie?signature=TOP_SECRET';
const SECRET = 'TOP_SECRET';
const hash = data => createHash('sha256').update(data).digest('hex');
const tick = () => new Promise(resolve => setImmediate(resolve));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const artifacts = fileURLToPath(new URL('../artifacts/', import.meta.url));

function scratch(t) {
  fs.mkdirSync(artifacts, { recursive: true });
  const dir = fs.mkdtempSync(join(artifacts, 'source-fetch-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, file: join(dir, 'private.media') };
}

function fakeTransport({ plans = [{}], lookup, addresses = [{ address: PUBLIC, family: 4 }] } = {}) {
  const requests = [], dns = [], sockets = [], responses = [];
  const timers = new Set();
  const schedule = (callback, ms = 0) => {
    if (!ms) { queueMicrotask(callback); return; }
    const timer = setTimeout(() => { timers.delete(timer); callback(); }, ms);
    timers.add(timer);
  };
  const transport = createSourceTransport({
    lookup(hostname, options) {
      dns.push({ hostname, options });
      return lookup ? lookup(hostname, options, dns.length) : Promise.resolve(addresses);
    },
    request(url, options, callback) {
      const plan = plans[requests.length];
      if (!plan) throw new Error(`Unexpected replay ${SECRET}`);
      if (plan.throwRequest) { requests.push({ url, options }); throw new Error(SECRET); }
      const req = new EventEmitter();
      let res, socket;
      req.destroyed = false;
      req.destroy = () => {
        req.destroyed = true;
        for (const timer of timers) clearTimeout(timer);
        timers.clear();
        res?.destroy(); socket?.destroy();
        if (!plan.noDestroyEvents) queueMicrotask(() => req.emit('close'));
      };
      const entry = { url: new URL(url), options, req, ends: 0, lookupResult: null };
      requests.push(entry);
      req.end = (...args) => {
        entry.ends++; entry.endArgs = args;
        schedule(() => {
          if (req.destroyed) return;
          if (plan.noEvents) return;
          if (plan.error) { req.emit('error', new Error(SECRET)); return; }
          if (plan.closeEarly) { req.emit('close'); return; }
          socket = new EventEmitter();
          socket.remoteAddress = plan.peer ?? PUBLIC;
          socket.encrypted = true; socket.authorized = true;
          socket.destroyed = false;
          socket.destroy = () => { socket.destroyed = true; };
          sockets.push(socket);
          req.emit('socket', socket);
          options.lookup(url.hostname, { all: plan.lookupAll ?? true }, (error, address, family) => {
            entry.lookupResult = { error, address, family };
          });
          if (plan.securePeer !== false) socket.emit('secureConnect');
          if (req.destroyed) return;
          if (plan.upgrade || plan.connect) {
            req.emit(plan.connect ? 'connect' : 'upgrade', new EventEmitter(), socket, Buffer.from(SECRET));
            return;
          }
          const chunks = [...(plan.chunks ?? [Buffer.from('media')])];
          let reading = false;
          res = new Readable({
            highWaterMark: 64 * 1024,
            read() {
              if (reading || plan.noBodyEvents) return;
              reading = true;
              schedule(() => {
                reading = false;
                if (this.destroyed) return;
                if (chunks.length) this.push(chunks.shift());
                else if (plan.bodyError) this.destroy(new Error(SECRET));
                else if (plan.aborted) this.emit('aborted');
                else if (plan.closeBody) this.destroy();
                else if (!plan.neverEnd) { this.complete = plan.complete ?? true; this.push(null); }
              }, plan.chunkDelay);
            },
            ...(plan.noDestroyEvents ? { destroy() {} } : {}),
          });
          responses.push(res);
          res.statusCode = plan.status ?? 200;
          res.complete = false;
          res.socket = socket;
          res.headers = plan.headers ?? { 'content-type': 'video/mp4' };
          res.rawHeaders = plan.rawHeaders ?? Object.entries(res.headers).flatMap(([key, value]) =>
            (Array.isArray(value) ? value : [value]).flatMap(item => [key, item]));
          res.rawTrailers = plan.rawTrailers ?? [];
          res.trailers = plan.trailers ?? {};
          plan.beforeResponse?.({ req, res, socket, options });
          callback(res);
          if (plan.afterResponse) schedule(() => plan.afterResponse({ req, res, socket }), plan.afterDelay);
        }, plan.headersDelay);
      };
      return req;
    },
  });
  return { ...transport, requests, dns, sockets, responses, timers };
}

async function rejectsSafe(promise, status) {
  await assert.rejects(promise, error => {
    assert.ok(error instanceof AppError);
    if (status !== undefined) assert.equal(error.status, status);
    const diagnostic = `${error.message}\n${error.stack}\n${JSON.stringify(error)}`;
    assert.ok(!diagnostic.includes(SECRET), diagnostic);
    assert.ok(!diagnostic.includes('https://'), diagnostic);
    assert.ok(!diagnostic.includes(PUBLIC), diagnostic);
    assert.equal(error.cause, undefined);
    return true;
  });
}

function assertDisposed(fake) {
  assert.ok(fake.requests.every(entry => !entry.req || entry.req.destroyed));
  assert.ok(fake.sockets.every(socket => socket.destroyed));
  assert.equal(fake.timers.size, 0);
}

test('URL normalization preserves a signed query privately and removes the fragment', () => {
  assert.equal(normalizeSourceUrl('HTTPS://Media.Public-Domain.com:443/a/../movie?q=%2F%2B&x=1#part'),
    'https://media.public-domain.com/movie?q=%2F%2B&x=1');
  assert.equal(normalizeSourceUrl('https://8.8.8.8/'), 'https://8.8.8.8/');
  assert.equal(normalizeSourceUrl('https://[2606:4700:4700:0000:0000:0000:0000:1111]/x'), 'https://[2606:4700:4700::1111]/x');
  assert.equal(normalizeSourceUrl('https://xn--bcher-kva.de/path'), 'https://xn--bcher-kva.de/path');
  assert.equal(normalizeSourceUrl('https://media.public-domain.com/Lesson%20One.mp4?title=A%20B'), 'https://media.public-domain.com/Lesson%20One.mp4?title=A%20B');
});

test('URL syntax rejects credentials, ambiguity, controls, whitespace, special hosts and encoded IP tricks', () => {
  const bad = [
    null, {}, '', ' https://media.public-domain.com/', 'https://media.public-domain.com/\n',
    'https://media.public-domain.com/\u0085', 'https://media.public-domain.com/\u00a0',
    'http://8.8.8.8/', '//8.8.8.8/', 'https:8.8.8.8', 'https:///8.8.8.8/', 'https:////8.8.8.8/',
    'https://8.8.8.8:80/', 'https://8.8.8.8:444/', 'https://8.8.8.8:0443/', 'https://8.8.8.8:/',
    `https://${SECRET}@8.8.8.8/`, 'https://@8.8.8.8/', 'https://:pass@8.8.8.8/',
    'https://localhost/', 'https://foo.localhost/', 'https://localhost.localdomain/',
    'https://foo.local/', 'https://foo.internal/', 'https://foo.home.arpa/', 'https://foo.onion/',
    'https://foo.invalid/', 'https://foo.test/', 'https://foo.alt/', 'https://com/',
    'https://media.public-domain.com./', 'https://.public-domain.com/', 'https://a..public-domain.com/',
    'https://-a.public-domain.com/', 'https://a-.public-domain.com/', 'https://a_b.public-domain.com/',
    'https://bücher.de/', 'https://media。public-domain.com/', 'https://ｍedia.public-domain.com/',
    'https://127.0.0.1/', 'https://127.1/', 'https://2130706433/', 'https://0x7f000001/',
    'https://0177.0.0.1/', 'https://127.000.000.001/', 'https://0x7f.0.0.1/',
    'https://0x08080808/', 'https://010.010.010.010/', 'https://8.8.8.0x8/',
    'https://%38.%38.%38.%38/', 'https://media%2epublic-domain.com/', 'https://8.8.8.8%2f@localhost/',
    'https://media.public-domain.com\\@127.0.0.1/', 'https://media.public-domain.com/%5Cevil',
    'https://media.public-domain.com/%0a', 'https://media.public-domain.com/raw space',
    'https://media.public-domain.com/%c2%85', 'https://media.public-domain.com/?x=%',
    'https://[::1]/', 'https://[::ffff:8.8.8.8]/', 'https://[2001:db8::1]/',
    'https://[fe80::1%25eth0]/', 'https://[2606:4700:4700::1111%eth0]/',
    `https://media.public-domain.com/${'x'.repeat(8192)}`,
    `https://${'a'.repeat(64)}.com/`,
  ];
  for (const input of bad) {
    assert.throws(() => normalizeSourceUrl(input), error => error instanceof AppError && !error.message.includes(SECRET), String(input));
  }
  const prefix = 'https://media.public-domain.com/';
  assert.equal(normalizeSourceUrl(prefix + 'a'.repeat(8192 - prefix.length)).length, 8192);
});

test('address classifier denies special/transition ranges including expanded IPv6 spellings', () => {
  for (const ip of ['8.8.8.8', PUBLIC, '1.1.1.1', '172.15.255.255', '172.32.0.1', '100.63.255.255', '100.128.0.1',
    '192.0.1.1', '198.20.0.1', '2606:4700:4700::1111', '2001:4860:4860::8888', '2001:0200::1', '3fff:1000::1']) {
    assert.equal(isPublicSourceAddress(ip), true, ip);
  }
  for (const ip of [undefined, null, 0, '', 'hostname', '8.8.8.8 ', '008.8.8.8',
    '0.1.2.3', '10.1.2.3', '100.64.0.0', '100.127.255.255', '127.9.8.7', '169.254.1.1',
    '172.16.0.1', '172.31.255.255', '192.0.0.9', '192.0.2.1', '192.88.99.1', '192.168.1.1',
    '198.18.0.1', '198.19.255.255', '198.51.100.1', '203.0.113.1', '224.0.0.1', '240.0.0.1', '255.255.255.255',
    '::', '::1', '::8.8.8.8', '::ffff:8.8.8.8', '::ffff:0808:0808', '::ffff:0:8.8.8.8',
    '64:ff9b::808:808', '64:ff9b:1::808:808', '100::1', 'fc00::1', 'fd00::1', 'fe80::1', 'fec0::1', 'ff00::1',
    '2001::1', '2001:0000:4136:e378:8000:63bf:3fff:fdd2', '2001:2::1', '2001:10::1', '2001:20::1', '2001:01ff::1',
    '2001:db8::1', '2001:0db8:0000:0000:0000:0000:0000:0001', '2002:0808:0808::1', '3ffe::1', '3fff:0fff::1',
    '5f00::1', '2606:4700::1%eth0', '[2606:4700::1]']) {
    assert.equal(isPublicSourceAddress(ip), false, String(ip));
  }
});

test('resolvePublicTarget requires every answer to be public and consistent with its family', async () => {
  for (const addresses of [[], null, [{ address: PUBLIC, family: 6 }], [{ address: '::ffff:8.8.8.8', family: 6 }],
    [{ address: PUBLIC, family: 4 }, { address: '10.0.0.1', family: 4 }],
    [{ address: '2606:4700::1111', family: 6 }, { address: '2001:db8::1', family: 6 }],
    [{ address: PUBLIC, family: 4 }, { address: '::1', family: 6 }]]) {
    const fake = fakeTransport({ addresses });
    await rejectsSafe(fake.fetchSourceBuffer(SOURCE), 400);
    assert.equal(fake.requests.length, 0);
  }
  const fake = fakeTransport();
  const target = await fake.resolvePublicTarget(SOURCE + '#fragment');
  assert.ok(target.url instanceof URL);
  assert.equal(target.url.href, SOURCE);
  assert.equal(target.address, PUBLIC);
  assert.equal(target.family, 4);
  assert.deepEqual(fake.dns[0].options, { all: true, verbatim: true });
  assert.equal(fake.requests.length, 0);
});

test('literal IP targets skip DNS but never bypass validation', async () => {
  const fake = fakeTransport({ plans: [{ peer: '8.8.8.8' }, { peer: '2606:4700:4700:0:0:0:0:1111' }] });
  await fake.fetchSourceBuffer('https://8.8.8.8/');
  await fake.fetchSourceBuffer('https://[2606:4700:4700::1111]/');
  assert.equal(fake.dns.length, 0);
  assert.equal(fake.requests[1].options.servername, '');
  await rejectsSafe(fake.fetchSourceBuffer('https://127.0.0.1/'), 400);
  assert.equal(fake.requests.length, 2);
  assertDisposed(fake);
});

test('pins one answer, preserves original TLS identity and sends only fixed unauthenticated headers', async () => {
  const fake = fakeTransport({ addresses: [{ address: PUBLIC, family: 4 }, { address: '8.8.8.8', family: 4 }] });
  const result = await fake.fetchSourceBuffer(SOURCE, { request: () => assert.fail('user transport override'), lookup: () => assert.fail('user DNS override'),
    headers: { Authorization: SECRET, Cookie: SECRET }, agent: SECRET, proxy: SECRET });
  assert.equal(result.buffer.toString(), 'media');
  assert.equal(result.sha256, hash('media'));
  assert.equal(result.url, SOURCE);
  assert.equal(result.contentType, 'video/mp4');
  const { options, lookupResult, endArgs, ends } = fake.requests[0];
  assert.deepEqual(options.headers, { 'User-Agent': 'LearnLens-Source/1.0', 'Accept-Encoding': 'identity' });
  assert.equal(options.agent, false);
  assert.deepEqual(options.proxyEnv, {});
  assert.equal(options.timeout, 0);
  assert.equal(options.rejectUnauthorized, true);
  assert.equal(options.servername, 'media.public-domain.com');
  assert.equal(options.hostname, 'media.public-domain.com');
  assert.equal(options.port, 443);
  assert.equal(options.autoSelectFamily, false);
  assert.equal(options.family, 4);
  assert.equal(options.method, 'GET');
  assert.equal(options.insecureHTTPParser, false);
  assert.equal(options.maxHeaderSize, 16 * 1024);
  assert.equal(options.auth, undefined);
  assert.equal(options.createConnection, undefined);
  assert.equal(options.checkServerIdentity('attacker.invalid', { subjectaltname: 'DNS:media.public-domain.com' }), undefined);
  assert.ok(options.checkServerIdentity('media.public-domain.com', { subjectaltname: 'DNS:attacker.invalid' }) instanceof Error);
  assert.deepEqual(lookupResult, { error: null, address: [{ address: PUBLIC, family: 4 }], family: undefined });
  assert.equal(ends, 1); assert.deepEqual(endArgs, []);
  let pinned;
  // Even a delayed native lookup after the completed hop is inert.
  options.lookup('totally-different.invalid', {}, (error, address, family) => { pinned = { error, address, family }; });
  assert.ok(pinned.error instanceof AppError);
  assert.equal(pinned.address, undefined);
  assert.equal(fake.dns.length, 1);
  assertDisposed(fake);
});

test('peer rebinding to a different public or private IP is rejected before any body', async () => {
  for (const peer of ['127.0.0.1', '8.8.8.8', '::ffff:127.0.0.1', undefined]) {
    const fake = fakeTransport({ plans: [{ peer: peer ?? '', securePeer: false }] });
    await rejectsSafe(fake.fetchSourceBuffer(SOURCE));
    assert.equal(fake.requests.length, 1);
    assertDisposed(fake);
  }
  const fake = fakeTransport({ plans: [{ peer: `::ffff:${PUBLIC}` }] });
  assert.equal((await fake.fetchSourceBuffer(SOURCE)).buffer.toString(), 'media');
  assertDisposed(fake);
});

test('a peer mismatch at secureConnect destroys the socket without waiting for headers', async () => {
  const fake = fakeTransport({ plans: [{ peer: '127.0.0.1' }] });
  await rejectsSafe(fake.fetchSourceBuffer(SOURCE));
  assert.equal(fake.responses.length, 0);
  assertDisposed(fake);
});

test('redirects repeat public DNS checks and never reuse authorization or cookies', async () => {
  const fake = fakeTransport({ plans: [
    { status: 302, headers: { location: '/other?token=TOP_SECRET#x', 'set-cookie': `session=${SECRET}` } },
    { status: 307, headers: { location: 'https://cdn.public-domain.com/final' } },
    { headers: { 'content-type': 'VIDEO/MP4; codecs="avc1"' } },
  ] });
  const result = await fake.fetchSourceBuffer(SOURCE);
  assert.equal(result.url, 'https://cdn.public-domain.com/final');
  assert.equal(result.contentType, 'video/mp4');
  assert.equal(fake.dns.length, 3);
  assert.equal(fake.requests.length, 3);
  assert.equal(fake.requests[1].url.hash, '');
  assert.equal(fake.requests[1].url.search, '?token=TOP_SECRET');
  assert.ok(fake.requests.every(item => item.options.headers.Cookie === undefined && item.options.auth === undefined));
  assertDisposed(fake);
});

test('same-host redirect does fresh all-answer DNS validation, not a reused public decision', async () => {
  const fake = fakeTransport({
    lookup: (_host, _options, count) => [{ address: count === 1 ? PUBLIC : '127.0.0.1', family: 4 }],
    plans: [{ status: 302, headers: { location: '/second' } }],
  });
  await rejectsSafe(fake.fetchSourceBuffer(SOURCE), 400);
  assert.equal(fake.dns.length, 2);
  assert.equal(fake.requests.length, 1);
  assertDisposed(fake);
});

test('redirect downgrade, credentials, malformed locations and ambiguous host spellings are denied', async () => {
  for (const location of ['http://8.8.8.8/', `https://${SECRET}@8.8.8.8/`, 'https://@8.8.8.8/',
    '//user@8.8.8.8/', '///8.8.8.8/', 'https://0x08080808/', 'https://%38.8.8.8/',
    'https:8.8.8.8', 'https://localhost/', '//127.0.0.1/', '\\127.0.0.1/', '/%0d%0aevil', ' /path']) {
    const fake = fakeTransport({ plans: [{ status: 302, headers: { location } }] });
    await rejectsSafe(fake.fetchSourceBuffer(SOURCE), 400);
    assert.equal(fake.requests.length, 1, location);
    assertDisposed(fake);
  }
  for (const headers of [{}, { location: '' }, { location: ['/a', '/b'] }]) {
    const fake = fakeTransport({ plans: [{ status: 302, headers }] });
    await rejectsSafe(fake.fetchSourceBuffer(SOURCE));
    assert.equal(fake.requests.length, 1);
  }
});

test('redirect loop detection and five-hop hard limit', async () => {
  const loop = fakeTransport({ plans: [{ status: 302, headers: { location: '#loop' } }] });
  await rejectsSafe(loop.fetchSourceBuffer(SOURCE));
  assert.equal(loop.requests.length, 1);
  const success = fakeTransport({ plans: [...Array.from({ length: 5 }, (_, i) => ({ status: 302, headers: { location: `/hop${i}` } })), {}] });
  await success.fetchSourceBuffer(SOURCE);
  assert.equal(success.requests.length, 6);
  const excess = fakeTransport({ plans: Array.from({ length: 6 }, (_, i) => ({ status: 302, headers: { location: `/hop${i}` } })) });
  await rejectsSafe(excess.fetchSourceBuffer(SOURCE));
  assert.equal(excess.requests.length, 6);
  assertDisposed(loop); assertDisposed(success); assertDisposed(excess);
});

test('allowUrl is applied before DNS at EVERY hop, using a non-mutating URL clone', async () => {
  const seen = [];
  const fake = fakeTransport({ plans: [{ status: 302, headers: { location: 'https://evil-googlevideo.com/media' } }] });
  await rejectsSafe(fake.fetchSourceBuffer('https://r1.googlevideo.com/media', {
    allowUrl(url) { seen.push(url.hostname); const allowed = url.hostname.endsWith('.googlevideo.com'); url.hostname = '127.0.0.1'; return allowed; },
  }), 400);
  assert.deepEqual(seen, ['r1.googlevideo.com', 'evil-googlevideo.com']);
  assert.equal(fake.dns.length, 1);
  assert.equal(fake.requests[0].url.hostname, 'r1.googlevideo.com');
  const denied = fakeTransport();
  await rejectsSafe(denied.fetchSourceBuffer(SOURCE, { allowUrl: () => false }), 400);
  assert.equal(denied.dns.length, 0);
  assert.equal(denied.requests.length, 0);
  await rejectsSafe(denied.fetchSourceBuffer(SOURCE, { allowUrl: () => { throw new AppError(SECRET); } }));
  await rejectsSafe(denied.fetchSourceBuffer(SOURCE, { allowUrl: async () => { throw new Error(SECRET); } }));
});

test('cancelled/expired DNS settles independently, late DNS never connects or rejects unhandled', async () => {
  let finish;
  const fake = fakeTransport({ lookup: () => new Promise(resolve => { finish = resolve; }) });
  const controller = new AbortController();
  const pending = fake.fetchSourceBuffer(SOURCE, { signal: controller.signal, timeoutMs: 1000 });
  await tick(); controller.abort(new Error(SECRET));
  await rejectsSafe(pending, 499);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  finish([{ address: PUBLIC, family: 4 }]);
  await tick();
  assert.equal(fake.requests.length, 0);
  let fail;
  const timed = fakeTransport({ lookup: () => new Promise((_resolve, reject) => { fail = reject; }) });
  await rejectsSafe(timed.fetchSourceBuffer(SOURCE, { timeoutMs: 20 }), 504);
  fail(new Error(SECRET)); await tick();
  assert.equal(timed.requests.length, 0);
});

test('standalone resolver and pre-aborted transfers do not rely on DNS cancellation support', async () => {
  const controller = new AbortController();
  const fake = fakeTransport({ lookup: () => new Promise(() => {}) });
  const pending = fake.resolvePublicTarget(SOURCE, { signal: controller.signal });
  await tick(); controller.abort(SECRET);
  await rejectsSafe(pending, 499);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  await rejectsSafe(fake.fetchSourceBuffer(SOURCE, { signal: controller.signal }), 499);
  assert.equal(fake.dns.length, 1);
  assert.equal(fake.requests.length, 0);
});

test('request with no events and inert destroy still settles on abort/deadline without replay', async () => {
  for (const abort of [false, true]) {
    const fake = fakeTransport({ plans: [{ noEvents: true, noDestroyEvents: true }] });
    const controller = new AbortController();
    const pending = fake.fetchSourceBuffer(SOURCE, { signal: controller.signal, timeoutMs: abort ? 1000 : 20 });
    if (abort) { await tick(); controller.abort(new Error(SECRET)); }
    await rejectsSafe(pending, abort ? 499 : 504);
    assert.equal(fake.requests.length, 1);
    assertDisposed(fake);
    let lateLookupError;
    fake.requests[0].options.lookup('ignored', {}, error => { lateLookupError = error; });
    assert.ok(lateLookupError instanceof AppError);
    fake.requests[0].req.emit('error', new Error(SECRET));
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  }
});

test('101 upgrades and CONNECT sockets are destroyed, rejected and never replayed', async () => {
  for (const plan of [{ upgrade: true }, { connect: true }, { status: 101 }]) {
    const fake = fakeTransport({ plans: [plan] });
    await rejectsSafe(fake.fetchSourceBuffer(SOURCE, { timeoutMs: 1000 }));
    assert.equal(fake.requests.length, 1);
    assertDisposed(fake);
  }
});

test('all non-200/non-redirect statuses, partial responses and auth challenges fail without replay', async () => {
  for (const status of [100, 201, 204, 205, 206, 300, 304, 305, 400, 401, 403, 404, 407, 429, 500, 503]) {
    const fake = fakeTransport({ plans: [{ status, chunks: [Buffer.from(SECRET)] }] });
    await rejectsSafe(fake.fetchSourceBuffer(SOURCE));
    assert.equal(fake.requests.length, 1, String(status));
    assertDisposed(fake);
  }
  for (const headers of [{ 'www-authenticate': `Basic ${SECRET}` }, { 'proxy-authenticate': SECRET }, { 'content-range': 'bytes 0-4/100' }]) {
    const fake = fakeTransport({ plans: [{ headers }] });
    await rejectsSafe(fake.fetchSourceBuffer(SOURCE));
    assertDisposed(fake);
  }
});

test('rejects compressed, ambiguous framing, duplicate lengths/encodings/types and invalid lengths', async () => {
  const bad = [
    { 'content-encoding': 'gzip' }, { 'content-encoding': 'br' }, { 'content-encoding': 'deflate' },
    { 'content-encoding': '' }, { 'content-encoding': 'identity, identity' }, { 'content-encoding': ['identity', 'identity'] },
    { 'transfer-encoding': 'gzip, chunked' }, { 'transfer-encoding': 'identity' }, { 'transfer-encoding': '' },
    { 'transfer-encoding': ['chunked', 'chunked'] }, { 'transfer-encoding': 'chunked', 'content-length': '5' },
    { 'content-length': ['5', '5'] }, { 'content-length': '5,5' }, { 'content-length': '-1' },
    { 'content-length': '+5' }, { 'content-length': '05' }, { 'content-length': '5.0' },
    { 'content-length': '' }, { 'content-length': '9007199254740992' }, { 'content-length': SECRET },
    { 'content-type': ['video/mp4', 'video/mp4'] }, { 'content-type': '' }, { 'content-type': SECRET },
    { 'content-type': `video/mp4\r\n${SECRET}` }, { 'x-huge': 'x'.repeat(16 * 1024) },
  ];
  for (const headers of bad) {
    const fake = fakeTransport({ plans: [{ headers }] });
    await rejectsSafe(fake.fetchSourceBuffer(SOURCE));
    assertDisposed(fake);
  }
  const duplicate = fakeTransport({ plans: [{ rawHeaders: ['Content-Length', '5', 'content-length', '5'] }] });
  await rejectsSafe(duplicate.fetchSourceBuffer(SOURCE));
  for (const headers of [{ 'content-encoding': 'identity', 'content-length': '5' }, { 'transfer-encoding': 'chunked' }, {}]) {
    const fake = fakeTransport({ plans: [{ headers }] });
    assert.equal((await fake.fetchSourceBuffer(SOURCE)).buffer.toString(), 'media');
    assertDisposed(fake);
  }
});

test('body length, completion, aborted/error/close events and trailers are verified', async () => {
  for (const plan of [
    { headers: { 'content-length': '4' } }, { headers: { 'content-length': '6' } },
    { complete: false }, { bodyError: true }, { aborted: true }, { closeBody: true },
    { rawTrailers: ['Content-Length', '999'] }, { trailers: { 'content-encoding': 'gzip' } },
    { error: true }, { throwRequest: true }, { closeEarly: true },
  ]) {
    const fake = fakeTransport({ plans: [plan] });
    await rejectsSafe(fake.fetchSourceBuffer(SOURCE));
    assert.equal(fake.requests.length, 1);
    assertDisposed(fake);
  }
});

test('buffer wrapper enforces declared and streamed caps, including the independent 8 MiB ceiling', async () => {
  for (const plan of [{}, { headers: { 'content-length': '5' } }, { chunks: [Buffer.alloc(3), Buffer.alloc(3)] }]) {
    const fake = fakeTransport({ plans: [plan] });
    await rejectsSafe(fake.fetchSourceBuffer(SOURCE, { maxBytes: 4 }), 413);
    assertDisposed(fake);
  }
  const exact = fakeTransport({ plans: [{ chunks: [Buffer.alloc(8 * 1024 * 1024)] }] });
  assert.equal((await exact.fetchSourceBuffer(SOURCE)).buffer.length, 8 * 1024 * 1024);
  const over = fakeTransport({ plans: [{ chunks: [Buffer.alloc(8 * 1024 * 1024), Buffer.alloc(1)] }] });
  await rejectsSafe(over.fetchSourceBuffer(SOURCE), 413);
  const empty = fakeTransport({ plans: [{ headers: { 'content-length': '0' }, chunks: [] }] });
  assert.equal((await empty.fetchSourceBuffer(SOURCE)).sha256, hash(''));
  assertDisposed(exact); assertDisposed(over); assertDisposed(empty);
});

test('invalid limits/timeouts/callbacks/signals fail before DNS or destination creation', async t => {
  const { file } = scratch(t);
  const fake = fakeTransport();
  for (const maxBytes of [0, -1, 1.1, Infinity, NaN, '4', null, 1024 ** 3 + 1]) {
    await rejectsSafe(fake.downloadSourceFile(SOURCE, file, { maxBytes }), 400);
  }
  for (const timeoutMs of [0, -1, 1.1, Infinity, NaN, '20', null, 600001]) {
    await rejectsSafe(fake.fetchSourceBuffer(SOURCE, { timeoutMs }), 400);
  }
  await rejectsSafe(fake.fetchSourceBuffer(SOURCE, { maxBytes: 8 * 1024 * 1024 + 1 }), 400);
  for (const options of [null, [], { allowUrl: true }, { onProgress: 1 }, { limitForHeaders: 'x' }, { signal: {} }]) {
    await rejectsSafe(fake.downloadSourceFile(SOURCE, file, options), 400);
  }
  assert.equal(fs.existsSync(file), false);
  assert.equal(fake.dns.length, 0);
  assert.equal(fake.requests.length, 0);
});

test('file success is private, exclusive, hashed, incrementally written, and progress contains counts only', async t => {
  const { file } = scratch(t);
  const chunks = Array.from({ length: 16 }, (_, i) => Buffer.alloc(32768, i));
  const expected = Buffer.concat(chunks);
  const progress = [];
  const fake = fakeTransport({ plans: [{ headers: { 'content-length': String(expected.length), 'content-type': 'video/mp4' }, chunks }] });
  const result = await fake.downloadSourceFile(SOURCE, file, {
    maxBytes: expected.length, onProgress: counts => progress.push(counts),
  });
  assert.deepEqual(result, { url: SOURCE, size: expected.length, contentType: 'video/mp4', sha256: hash(expected) });
  assert.deepEqual(fs.readFileSync(file), expected);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(progress[0], { receivedBytes: 0, totalBytes: expected.length });
  assert.equal(progress.at(-1).receivedBytes, expected.length);
  assert.ok(progress.length > 2);
  for (const [index, counts] of progress.entries()) {
    assert.deepEqual(Object.keys(counts).sort(), ['receivedBytes', 'totalBytes']);
    assert.ok(Object.values(counts).every(value => Number.isSafeInteger(value) && value >= 0));
    if (index) assert.ok(counts.receivedBytes >= progress[index - 1].receivedBytes);
  }
  const existing = fakeTransport();
  await rejectsSafe(existing.downloadSourceFile(SOURCE, file));
  assert.deepEqual(fs.readFileSync(file), expected);
  assertDisposed(fake); assertDisposed(existing);
});

test('failed partial file cleanup completes before rejection for limits, truncation, protocol, abort and no events', async t => {
  const { file, dir } = scratch(t);
  for (const plan of [{}, { headers: { 'content-length': '6' } }, { bodyError: true },
    { complete: false }, { noBodyEvents: true, noDestroyEvents: true }, { neverEnd: true },
    { headers: { 'content-encoding': 'gzip' } }, { status: 206 }]) {
    const fake = fakeTransport({ plans: [plan] });
    await rejectsSafe(fake.downloadSourceFile(SOURCE, file, { maxBytes: Object.keys(plan).length ? 100 : 4, timeoutMs: 40 }));
    assert.equal(fs.existsSync(file), false);
    assert.deepEqual(fs.readdirSync(dir), []);
    assertDisposed(fake);
  }
  const controller = new AbortController();
  const fake = fakeTransport({ plans: [{ chunks: [Buffer.from('first'), Buffer.from('second')] }] });
  await rejectsSafe(fake.downloadSourceFile(SOURCE, file, {
    signal: controller.signal, onProgress({ receivedBytes }) { if (receivedBytes > 0) controller.abort(SECRET); },
  }), 499);
  assert.equal(fs.existsSync(file), false);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assertDisposed(fake);
});

test('per-response header cap can only tighten; async policy errors are sanitized and cleaned', async t => {
  const { file } = scratch(t);
  const fake = fakeTransport({ plans: [{ headers: { 'content-type': 'text/html', 'content-length': '5' } }] });
  let metadata;
  await rejectsSafe(fake.downloadSourceFile(SOURCE, file, {
    maxBytes: 10, limitForHeaders: async headers => { metadata = headers; return 4; },
  }), 413);
  assert.deepEqual(metadata, { contentType: 'text/html', contentLength: 5 });
  assert.equal(fs.existsSync(file), false);
  const cannotRaise = fakeTransport();
  await rejectsSafe(cannotRaise.downloadSourceFile(SOURCE, file, { maxBytes: 4, limitForHeaders: () => 100 }), 413);
  for (const limitForHeaders of [() => 0, () => Infinity, () => -1, () => 1.5, () => '5', () => 1024 ** 3 + 1,
    () => { throw new AppError(SECRET); }, async () => { throw new Error(SECRET); }]) {
    const invalid = fakeTransport();
    await rejectsSafe(invalid.downloadSourceFile(SOURCE, file, { limitForHeaders }));
    assert.equal(fs.existsSync(file), false);
    assertDisposed(invalid);
  }
  const success = fakeTransport();
  await success.downloadSourceFile(SOURCE, file, { limitForHeaders: () => undefined });
  assert.equal(fs.readFileSync(file).toString(), 'media');
});

test('policy/progress promises are deadline-bounded; late rejections are handled', async t => {
  const { file } = scratch(t);
  for (const which of ['allowUrl', 'limitForHeaders', 'onProgress']) {
    let fail;
    const fake = fakeTransport();
    await rejectsSafe(fake.downloadSourceFile(SOURCE, file, { timeoutMs: 20,
      [which]: () => new Promise((_resolve, reject) => { fail = reject; }),
    }), 504);
    assert.equal(fs.existsSync(file), false);
    fail(new Error(SECRET)); await tick();
    assertDisposed(fake);
  }
  const fake = fakeTransport();
  await rejectsSafe(fake.downloadSourceFile(SOURCE, file, {
    onProgress({ receivedBytes }) { if (receivedBytes) throw new AppError(SECRET); },
  }));
  assert.equal(fs.existsSync(file), false);
});

test('one total deadline includes DNS, drip headers, drip body and redirects, never resetting on activity', async t => {
  const { file } = scratch(t);
  const cases = [
    { lookup: async () => { await sleep(25); return [{ address: PUBLIC, family: 4 }]; }, plans: [{ headersDelay: 40 }] },
    { plans: [{ headersDelay: 100 }] },
    { plans: [{ chunks: Array.from({ length: 30 }, () => Buffer.alloc(1)), chunkDelay: 5 }] },
    { plans: [{ status: 302, headers: { location: '/hop' }, headersDelay: 25 }, { headersDelay: 40 }] },
    { plans: [{ headersDelay: 25, chunks: Array.from({ length: 30 }, () => Buffer.alloc(1)), chunkDelay: 5 }] },
  ];
  for (const scenario of cases) {
    const fake = fakeTransport(scenario);
    const start = performance.now();
    await rejectsSafe(fake.downloadSourceFile(SOURCE, file, { timeoutMs: 50 }), 504);
    assert.ok(performance.now() - start < 500, 'deadline must not wait for missing events');
    assert.equal(fs.existsSync(file), false);
    assertDisposed(fake);
  }
});

test('short writes are retried only locally, in <=64KiB blocks, never by replaying HTTP', async t => {
  const { file } = scratch(t);
  const original = fs.writeSync;
  const payload = Buffer.alloc(200000, 0x65);
  const lengths = [];
  fs.writeSync = (fd, buffer, offset, length) => {
    lengths.push(length);
    return original(fd, buffer, offset, Math.min(length, 997));
  };
  try {
    const fake = fakeTransport({ plans: [{ chunks: [payload] }] });
    const result = await fake.downloadSourceFile(SOURCE, file);
    assert.equal(result.size, payload.length);
    assert.deepEqual(fs.readFileSync(file), payload);
    assert.ok(lengths.length > 100);
    assert.ok(lengths.every(length => length > 0 && length <= 65536));
    assert.equal(fake.requests.length, 1);
    assertDisposed(fake);
  } finally { fs.writeSync = original; }
});

test('zero/failed writes, cancellation during a write, and an exhausted write deadline remove partial files', async t => {
  const { file } = scratch(t);
  const original = fs.writeSync;
  for (const mode of ['zero', 'error', 'abort', 'deadline']) {
    const controller = new AbortController();
    const fake = fakeTransport({ plans: [{ chunks: [Buffer.alloc(150000)] }] });
    let calls = 0;
    fs.writeSync = (...args) => {
      calls++;
      if (mode === 'zero') return 0;
      if (mode === 'error') throw new Error(`Disk ${SECRET}`);
      const bytes = original(...args);
      if (mode === 'abort') controller.abort(SECRET);
      if (mode === 'deadline') { const end = performance.now() + 35; while (performance.now() < end) { /* simulate a bounded slow syscall */ } }
      return bytes;
    };
    try {
      await rejectsSafe(fake.downloadSourceFile(SOURCE, file, {
        signal: controller.signal, timeoutMs: mode === 'deadline' ? 20 : 1000,
      }), mode === 'abort' ? 499 : mode === 'deadline' ? 504 : 502);
      assert.equal(calls, 1);
      assert.equal(fs.existsSync(file), false);
      assert.equal(fake.requests.length, 1);
      assertDisposed(fake);
    } finally { fs.writeSync = original; }
  }
});

test('destination create failures are safe and do not remove unrelated files or directories', async t => {
  const { dir } = scratch(t);
  for (const file of [dir, join(dir, 'missing', 'file')]) {
    const fake = fakeTransport();
    await rejectsSafe(fake.downloadSourceFile(SOURCE, file));
    assert.equal(fs.statSync(dir).isDirectory(), true);
    assertDisposed(fake);
  }
});

test('cleanup errors are explicit, sanitized, and never cause a second network attempt', async t => {
  const { file } = scratch(t);
  const original = fs.unlinkSync;
  const fake = fakeTransport({ plans: [{ neverEnd: true }] });
  fs.unlinkSync = () => { throw new Error(SECRET); };
  try {
    await assert.rejects(fake.downloadSourceFile(SOURCE, file, { timeoutMs: 20 }), error => {
      assert.equal(error.status, 500);
      assert.match(error.message, /cleaned up/);
      assert.ok(!error.message.includes(SECRET));
      return true;
    });
    assert.equal(fake.requests.length, 1);
    assertDisposed(fake);
  } finally { fs.unlinkSync = original; }
  assert.equal(fs.existsSync(file), true);
  fs.unlinkSync(file);
});

test('uncertain close failures are reported, unlink is still attempted, and a numeric fd is not closed twice', async t => {
  const { file } = scratch(t);
  const original = fs.closeSync;
  const fake = fakeTransport();
  let closes = 0;
  fs.closeSync = fd => { closes++; original(fd); throw new Error(SECRET); };
  try {
    await rejectsSafe(fake.downloadSourceFile(SOURCE, file), 500);
    assert.equal(closes, 1);
    assert.equal(fs.existsSync(file), false);
    assert.equal(fake.requests.length, 1);
    assertDisposed(fake);
  } finally { fs.closeSync = original; }
});

test('late response/upgrade/error events after abort cannot revive the operation or leak sockets', async () => {
  let onResponse, req, socket;
  const controller = new AbortController();
  const transport = createSourceTransport({
    lookup: async () => [{ address: PUBLIC, family: 4 }],
    request(_url, _options, callback) {
      onResponse = callback;
      req = new EventEmitter(); req.end = () => {}; req.destroy = () => { req.destroyed = true; };
      return req;
    },
  });
  const pending = transport.fetchSourceBuffer(SOURCE, { signal: controller.signal });
  await tick(); controller.abort(SECRET);
  await rejectsSafe(pending, 499);
  const res = new Readable({ read() {} });
  socket = new EventEmitter(); socket.destroy = () => { socket.destroyed = true; };
  res.socket = socket;
  onResponse(res);
  req.emit('upgrade', res, socket, Buffer.from(SECRET));
  req.emit('error', new Error(SECRET));
  assert.equal(req.destroyed, true);
  assert.equal(res.destroyed, true);
  assert.equal(socket.destroyed, true);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('unknown-length file bodies are capped after actual partial writes and progress omits unknown totals', async t => {
  const { file } = scratch(t);
  const seen = [];
  const fake = fakeTransport({ plans: [{ chunks: [Buffer.from('abc'), Buffer.from('def')], chunkDelay: 2 }] });
  await rejectsSafe(fake.downloadSourceFile(SOURCE, file, {
    maxBytes: 100,
    limitForHeaders({ contentType, contentLength }) {
      assert.equal(contentType, 'video/mp4'); assert.equal(contentLength, null); return 4;
    },
    onProgress(counts) {
      seen.push(counts);
      if (counts.receivedBytes) assert.equal(fs.readFileSync(file).toString(), 'abc');
    },
  }), 413);
  assert.deepEqual(seen, [{ receivedBytes: 0 }, { receivedBytes: 3 }]);
  assert.equal(fs.existsSync(file), false);
  assertDisposed(fake);
});

test('unknown-length buffers retain at most their cap and unused backing bytes are zeroed', async () => {
  const fake = fakeTransport();
  const { buffer } = await fake.fetchSourceBuffer(SOURCE, { maxBytes: 100 });
  assert.equal(buffer.toString(), 'media');
  assert.equal(buffer.buffer.byteLength, 100);
  assert.ok(new Uint8Array(buffer.buffer, buffer.byteOffset + buffer.length).every(byte => byte === 0));
  assertDisposed(fake);
});

test('DNS failures are sanitized and request options use a single-address callback without replay', async () => {
  const bad = fakeTransport({ lookup: () => { throw new AppError(SECRET); } });
  await rejectsSafe(bad.fetchSourceBuffer(SOURCE));
  assert.equal(bad.requests.length, 0);
  const fake = fakeTransport({ plans: [{ lookupAll: false }] });
  await fake.fetchSourceBuffer(SOURCE);
  assert.deepEqual(fake.requests[0].lookupResult, { error: null, address: PUBLIC, family: 4 });
  assertDisposed(fake);
});

test('maximum permitted file/time ceilings remain valid without allocating the file cap in memory', async t => {
  const { file } = scratch(t);
  const fake = fakeTransport();
  const result = await fake.downloadSourceFile(SOURCE, file, { maxBytes: 1024 ** 3, timeoutMs: 600000 });
  assert.equal(result.size, 5);
  assert.equal(fs.statSync(file).size, 5);
  assertDisposed(fake);
});

test('repeated completed/aborted operations release external listeners and leave no owned timers', async () => {
  const controller = new AbortController();
  const fake = fakeTransport({ plans: Array.from({ length: 30 }, () => ({})) });
  for (let i = 0; i < 30; i++) {
    await fake.fetchSourceBuffer(SOURCE, { signal: controller.signal });
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  }
  assert.equal(fake.requests.length, 30);
  assertDisposed(fake);
});
