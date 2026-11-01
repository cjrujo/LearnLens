import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { Duplex } from 'node:stream';
import { once, getEventListeners } from 'node:events';
import { createSourceProxy } from '../lib/source-proxy.mjs';
import { createSourceTransport } from '../lib/source-fetch.mjs';

const PUBLIC = '93.184.216.34';
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture({ addresses = [{ address: PUBLIC, family: 4 }], lookup, peer = PUBLIC, peerPort = 443, hang = false } = {}) {
  const connections = [], sockets = [], lookups = [];
  const transport = createSourceTransport({ lookup: async (...args) => {
    lookups.push(args); return lookup ? lookup(...args) : addresses;
  } });
  return { connections, sockets, lookups, deps: { resolve: transport.resolvePublicTarget, connect(options) {
    connections.push(options);
    const upstream = new Duplex({ read() {}, write(chunk, _encoding, done) { this.push(chunk); done(); }, final(done) { this.push(null); done(); } });
    upstream.remoteAddress = peer; upstream.remotePort = peerPort;
    upstream.setTimeout = () => upstream;
    sockets.push(upstream);
    if (!hang) queueMicrotask(() => upstream.emit('connect'));
    return upstream;
  } } };
}
async function open(proxy) {
  const url = new URL(proxy.url);
  const socket = net.connect({ host: '127.0.0.1', port: Number(url.port) });
  socket.on('error', () => {});
  await once(socket, 'connect');
  return socket;
}
function request(proxy, line = 'CONNECT www.youtube.com:443 HTTP/1.1', extra = '') {
  const url = new URL(proxy.url);
  const auth = Buffer.from(`${url.username}:${url.password}`).toString('base64');
  return `${line}\r\nHost: www.youtube.com:443\r\nProxy-Authorization: Basic ${auth}\r\n${extra}\r\n`;
}
function until(socket, match) {
  return new Promise((resolve, reject) => {
    let output = '';
    const onData = chunk => { output += chunk.toString(); if (match(output)) { clean(); resolve(output); } };
    const onClose = () => { clean(); reject(new Error('Closed before expected data')); };
    const timer = setTimeout(() => { clean(); reject(new Error('Local fixture timed out')); }, 2000);
    const clean = () => { clearTimeout(timer); socket.off('data', onData); socket.off('close', onClose); };
    socket.on('data', onData); socket.on('close', onClose);
  });
}
async function denied(proxy, payload) {
  const socket = await open(proxy);
  const closed = new Promise(resolve => socket.once('close', resolve));
  socket.write(payload); socket.resume(); await closed;
  assert.equal(proxy.signal.aborted, true);
}

test('authenticated loopback CONNECT pins the public address, checks peer, and forwards bounded bytes', async t => {
  const fake = fixture(), controller = new AbortController();
  const proxy = await createSourceProxy({ signal: controller.signal }, fake.deps);
  t.after(() => proxy.close());
  const socket = await open(proxy); t.after(() => socket.destroy());
  const ready = until(socket, value => value.endsWith('\r\n\r\n'));
  socket.write(request(proxy)); assert.match(await ready, /^HTTP\/1.1 200/);
  const data = until(socket, value => value === 'hello'); socket.write('hello'); await data;
  assert.deepEqual(fake.connections, [{ host: PUBLIC, family: 4, port: 443, autoSelectFamily: false }]);
  assert.deepEqual(fake.lookups[0], ['www.youtube.com', { all: true, verbatim: true }]);
  assert.equal(proxy.stats().bytes, 10);
  await proxy.close(); await proxy.close();
  assert.ok(fake.sockets.every(item => item.destroyed));
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('no unauthenticated, general HTTP, alternate authority, header-smuggled or pipelined fetch surface', async () => {
  const forms = [
    p => 'CONNECT www.youtube.com:443 HTTP/1.1\r\n\r\n',
    p => request(p).replace(/Basic [^\r]+/, 'Basic Zm9vOmJhcg=='),
    p => request(p, 'GET https://www.youtube.com/ HTTP/1.1'),
    p => request(p, 'CONNECT youtubei.googleapis.com:443 HTTP/1.1'),
    p => request(p, 'CONNECT www.youtube.com.evil.com:443 HTTP/1.1'),
    p => request(p, 'CONNECT www.youtube.com.:443 HTTP/1.1'),
    p => request(p, 'CONNECT 127.0.0.1:443 HTTP/1.1'),
    p => request(p, 'CONNECT www.youtube.com:444 HTTP/1.1'),
    p => request(p, 'CONNECT user@www.youtube.com:443 HTTP/1.1'),
    p => request(p, undefined, 'Proxy-Authorization: Basic eA==\r\n'),
    p => request(p, undefined, 'Transfer-Encoding: chunked\r\n'),
    p => request(p, undefined, 'Content-Length: 0\r\n'),
    p => request(p) + 'GET / HTTP/1.1\r\n\r\n',
    p => 'X'.repeat(8193),
  ];
  for (const form of forms) {
    const fake = fixture(), proxy = await createSourceProxy({}, fake.deps);
    try { await denied(proxy, form(proxy)); assert.equal(fake.connections.length, 0); assert.equal(fake.lookups.length, 0); }
    finally { await proxy.close(); }
  }
});

test('all-DNS policy rejects mixed/private/reserved/198.18 answers before connect', async () => {
  for (const addresses of [[], [{ address: '198.18.0.1', family: 4 }], [{ address: '127.0.0.1', family: 4 }],
    [{ address: PUBLIC, family: 4 }, { address: '::1', family: 6 }],
    [{ address: '::ffff:127.0.0.1', family: 6 }], [{ address: '2001:db8::1', family: 6 }]]) {
    const fake = fixture({ addresses }), proxy = await createSourceProxy({}, fake.deps);
    try { await denied(proxy, request(proxy)); assert.equal(fake.connections.length, 0); }
    finally { await proxy.close(); }
  }
});

test('peer/address or port mismatch fails closed; mapped public peer is only representation equivalence', async () => {
  for (const settings of [{ peer: '127.0.0.1' }, { peer: '93.184.216.35' }, { peerPort: 444 }]) {
    const fake = fixture(settings), proxy = await createSourceProxy({}, fake.deps);
    try { await denied(proxy, request(proxy)); assert.ok(fake.sockets.every(item => item.destroyed)); }
    finally { await proxy.close(); }
  }
  const fake = fixture({ peer: `::ffff:${PUBLIC}` }), proxy = await createSourceProxy({}, fake.deps);
  try {
    const socket = await open(proxy); const ready = until(socket, value => value.includes('200'));
    socket.write(request(proxy)); await ready; socket.destroy();
  } finally { await proxy.close(); }
});

test('cancellation during slow DNS never makes a late connection and closes all owned resources', async () => {
  let answer;
  const fake = fixture({ lookup: () => new Promise(resolve => { answer = resolve; }) });
  const controller = new AbortController(), proxy = await createSourceProxy({ signal: controller.signal }, fake.deps);
  const socket = await open(proxy); socket.write(request(proxy));
  while (!answer) await tick();
  const closed = new Promise(resolve => socket.once('close', resolve)); socket.resume();
  controller.abort(); await proxy.close(); await closed;
  answer([{ address: PUBLIC, family: 4 }]); await tick();
  assert.equal(fake.connections.length, 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('total/idle deadlines, connections and cumulative tunnel bytes are authoritative', async () => {
  for (const options of [{ timeoutMs: 40 }, { idleTimeoutMs: 40 }]) {
    const proxy = await createSourceProxy(options, fixture().deps);
    try {
      const socket = await open(proxy); const closed = new Promise(resolve => socket.once('close', resolve));
      socket.resume(); await closed; assert.equal(proxy.signal.aborted, true);
    } finally { await proxy.close(); }
  }
  {
    const fake = fixture(), proxy = await createSourceProxy({ maxBytes: 5 }, fake.deps);
    try {
      const socket = await open(proxy), ready = until(socket, value => value.includes('200'));
      socket.write(request(proxy)); await ready;
      const closed = new Promise(resolve => socket.once('close', resolve));
      socket.write('123456'); socket.resume(); await closed;
      assert.equal(proxy.stats().bytes, 0); assert.equal(proxy.signal.aborted, true);
    } finally { await proxy.close(); }
  }
  for (const options of [{ maxConnections: 1 }, { maxConcurrent: 1 }]) {
    const proxy = await createSourceProxy(options, fixture().deps);
    try {
      const one = await open(proxy); one.resume();
      const two = await open(proxy); two.resume();
      await new Promise(resolve => two.once('close', resolve));
      assert.equal(proxy.signal.aborted, true);
    } finally { await proxy.close(); }
  }
});

test('pre-aborted signal and invalid budgets allocate no listener', async () => {
  await assert.rejects(createSourceProxy({ signal: AbortSignal.abort() }, fixture().deps));
  for (const options of [{ maxBytes: 0 }, { timeoutMs: 60_001 }, { maxConnections: Infinity }])
    await assert.rejects(createSourceProxy(options, fixture().deps));
});
