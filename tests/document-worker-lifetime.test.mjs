import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setImmediate as tick } from 'node:timers/promises';
import { importDocument } from '../lib/document-import.mjs';
import { createApp } from '../server.mjs';
import { zip, docxEntries, paragraph } from './document-fixtures.mjs';

const TIMEOUT = { timeout: 15000 }, bytes = Buffer.from('synthetic document');
const result = { text: 'synthetic extracted text', images: [], warnings: [] };
const privateError = () => new Error('PRIVATE_WORKER_PATH_OR_DETAILS');
function observe(promise) {
  const state = { settled: false };
  state.outcome = promise.then(value => { state.settled = true; return { value }; }, error => { state.settled = true; return { error }; });
  return state;
}
async function pending(state) { await tick(); await tick(); assert.equal(state.settled, false, 'Worker promise must stay pending until exit/close'); }
async function until(run) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { const value = await run(); if (value) return value; await tick(); }
  assert.fail('Worker fixture did not reach its barrier');
}
function fakeWorkers(t, options = {}) {
  const original = childProcess.fork, children = [];
  childProcess.fork = (...args) => {
    if (options.forkThrows) throw privateError();
    const child = new EventEmitter();
    Object.assign(child, { pid: options.noPid ? undefined : 1000 + children.length, killed: false, exited: false, sends: 0, kills: 0, args,
      kill() {
        this.kills++;
        if (options.killThrows) throw privateError();
        this.killed = true; return !options.killReturnsFalse;
      },
      send(_, callback) {
        this.sends++;
        if (options.sendThrows) throw privateError();
        callback?.(options.sendError ? privateError() : undefined);
      },
    });
    child.once('exit', () => { child.exited = true; }); child.once('close', () => { child.exited = true; });
    children.push(child); options.onFork?.(child); return child;
  };
  syncBuiltinESMExports();
  t.after(() => {
    for (const child of children) if (!child.exited) child.emit('exit', 1, 'SIGKILL');
    childProcess.fork = original; syncBuiltinESMExports();
  });
  return children;
}
function expectError(outcome, pattern, status) {
  assert.ok(outcome.error); assert.match(outcome.error.message, pattern);
  assert.doesNotMatch(outcome.error.message, /PRIVATE_WORKER_PATH_OR_DETAILS/);
  if (status) assert.equal(outcome.error.status, status);
}

for (const event of ['exit', 'close']) test(`successful document result waits for ${event} and requests stop once`, TIMEOUT, async t => {
  const children = fakeWorkers(t), work = observe(importDocument(bytes, 'docx')), child = children[0];
  child.emit('message', { result });
  child.emit('message', { result: { text: 'late replacement' } });
  assert.equal(child.kills, 1); await pending(work);
  child.emit(event, 0, null); assert.deepEqual(await work.outcome, { value: result });
  child.emit(event === 'exit' ? 'close' : 'exit', 0, null); assert.equal(child.kills, 1);
});

for (const failure of ['abort', 'worker error', 'invalid message', 'error after spawn', 'send callback', 'send throw', 'kill throw', 'kill false', 'deadline']) {
  test(`document ${failure} does not release a spawned worker before termination`, TIMEOUT, async t => {
    const options = { sendError: failure === 'send callback', sendThrows: failure === 'send throw', killThrows: failure === 'kill throw', killReturnsFalse: failure === 'kill false' };
    const children = fakeWorkers(t, options), controller = new AbortController();
    const work = observe(importDocument(bytes, 'docx', { signal: controller.signal, timeoutMs: failure === 'deadline' ? 5 : 5000 }));
    const child = children[0];
    const patterns = { abort: /cancelled/, 'worker error': /synthetic parser error/, 'invalid message': /invalid result/,
      'error after spawn': /could not start|stopped/, 'send callback': /could not receive/, 'send throw': /could not receive/,
      'kill throw': /could not stop|stopped|could not start/, 'kill false': /cancelled/, deadline: /deadline/ };
    if (failure === 'abort' || failure === 'kill false') controller.abort();
    if (failure === 'worker error') child.emit('message', { error: 'synthetic parser error' });
    if (failure === 'invalid message') child.emit('message', {});
    if (failure === 'error after spawn') child.emit('error', privateError());
    if (failure === 'kill throw') child.emit('message', { result });
    if (failure === 'deadline') await until(() => child.kills === 1);
    assert.equal(child.kills, 1); await pending(work);
    child.emit('exit', 1, 'SIGKILL');
    expectError(await work.outcome, patterns[failure]); assert.equal(child.kills, 1);
  });
}

test('successful result followed by abort during drain rejects cancellation and cannot be replaced by late IPC', TIMEOUT, async t => {
  const children = fakeWorkers(t), controller = new AbortController();
  const work = observe(importDocument(bytes, 'docx', { signal: controller.signal })), child = children[0];
  child.emit('message', { result }); await pending(work);
  controller.abort(); child.emit('message', { result }); await pending(work);
  assert.equal(child.kills, 1);
  child.emit('close', 0, null); expectError(await work.outcome, /cancelled/, 409);
});

test('pre-aborted document never forks', TIMEOUT, async t => {
  const children = fakeWorkers(t);
  await assert.rejects(importDocument(bytes, 'docx', { signal: AbortSignal.abort() }), error => error.status === 409);
  assert.equal(children.length, 0);
});

for (const timing of ['during fork', 'during listener registration']) test(`abort ${timing} is observed before send and still waits for exit`, TIMEOUT, async t => {
  const controller = new AbortController();
  const children = fakeWorkers(t, { onFork: timing === 'during fork' ? () => controller.abort() : undefined });
  if (timing === 'during listener registration') {
    const add = controller.signal.addEventListener.bind(controller.signal);
    t.mock.method(controller.signal, 'addEventListener', (...args) => { add(...args); controller.abort(); });
  }
  const work = observe(importDocument(bytes, 'docx', { signal: controller.signal })), child = children[0];
  assert.equal(child.kills, 1); assert.equal(child.sends, 0); await pending(work);
  child.emit('exit', 1, 'SIGKILL'); expectError(await work.outcome, /cancelled/, 409);
});

test('fork throw and failed-to-spawn error without a PID settle safely without nonexistent exit', TIMEOUT, async t => {
  await t.test('fork throw', async sub => {
    fakeWorkers(sub, { forkThrows: true });
    expectError(await observe(importDocument(bytes, 'docx')).outcome, /could not start/, 503);
  });
  await t.test('no PID error', async sub => {
    const children = fakeWorkers(sub, { noPid: true }), work = observe(importDocument(bytes, 'docx'));
    children[0].emit('error', privateError());
    expectError(await work.outcome, /could not start/, 503); assert.equal(children[0].kills, 0);
  });
});

test('unexpected exit with no result is rejected, not a successful undefined extraction', TIMEOUT, async t => {
  const children = fakeWorkers(t), work = observe(importDocument(bytes, 'docx'));
  children[0].emit('exit', 0, null); expectError(await work.outcome, /stopped|invalid/, 422);
});

// Exercise the actual HTTP handler without binding any port or socket.
function request(server, client, path, { method = 'GET', body } = {}) {
  const req = new PassThrough(); req.method = method; req.url = path;
  req.headers = { host: 'localhost:1', ...(client ? { cookie: client.cookie, 'x-learnlens-token': client.token } : {}),
    ...(body === undefined ? {} : { 'content-type': 'application/json' }) };
  return new Promise(resolve => {
    const res = new EventEmitter();
    Object.assign(res, { statusCode: 200, headers: {}, headersSent: false, writableEnded: false,
      setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
      writeHead(status, headers = {}) { this.statusCode = status; this.headersSent = true; for (const [name, value] of Object.entries(headers)) this.setHeader(name, value); },
      end(value = '') {
        this.writableEnded = this.headersSent = true;
        const text = value.toString(); let json; try { json = JSON.parse(text); } catch { /* Bootstrap HTML. */ }
        resolve({ status: this.statusCode, headers: this.headers, text, json });
      },
    });
    server.emit('request', req, res); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
async function clientFor(server) {
  const response = await request(server, null, '/'); assert.equal(response.status, 200);
  const token = /name="learnlens-token"\s+content="([^"]+)"/.exec(response.text)?.[1]; assert.ok(token);
  return { cookie: response.headers['set-cookie'].split(';')[0], token };
}

test('server retains both local worker slots and waits for exit during logout; third import stays blocked', TIMEOUT, async t => {
  const denied = () => { throw new Error('Network is forbidden in worker lifetime tests'); };
  t.mock.method(net.Socket.prototype, 'connect', denied); t.mock.method(net.Server.prototype, 'listen', denied); t.mock.method(globalThis, 'fetch', denied);
  const children = fakeWorkers(t), directory = await fs.mkdtemp(join(tmpdir(), 'learnlens-worker-lifetime-'));
  const { server } = createApp({ materialStoreOptions: { directory, downloader: async options => {
    const file = join(options.directory, 'source.docx'); await fs.writeFile(file, bytes, { flag: 'wx' });
    return { file, name: 'source.docx', extension: 'docx', kind: 'document', size: bytes.length, warnings: [],
      provenance: { type: 'direct-document', citationUrl: 'https://example.com/synthetic', importedAt: '2026-10-31T00:00:00.000Z' } };
  } }, audioPlanStoreOptions: { directory }, videoPlanStoreOptions: { directory } });
  const start = (client, id) => request(server, client, '/api/materials/from-url', { method: 'POST', body: { id, url: 'https://example.com/synthetic', publicFetchConsent: true } });
  try {
    const a = await clientFor(server), b = await clientFor(server), c = await clientFor(server), firstId = randomUUID(), thirdId = randomUUID();
    assert.equal((await start(a, firstId)).status, 202); await until(() => children.length === 1);
    assert.equal((await start(b, randomUUID())).status, 202); await until(() => children.length === 2);
    const logout = observe(request(server, a, '/api/logout', { method: 'POST', body: {} }));
    await until(() => children[0].kills === 1); await pending(logout);
    assert.equal((await request(server, a, '/api/state')).json.locked, true);
    assert.equal((await start(c, thirdId)).status, 503); assert.equal(children.length, 2);
    children[0].emit('exit', 1, 'SIGKILL'); assert.equal((await logout.outcome).value.status, 200);
    assert.equal((await request(server, a, `/api/materials/${firstId}`)).status, 404);
    assert.equal((await start(c, thirdId)).status, 202); await until(() => children.length === 3);
    assert.equal(children.filter(child => !child.exited).length, 2);
  } finally {
    server.emit('close');
    for (const child of children) if (!child.exited) child.emit('exit', 1, 'SIGKILL');
    await until(async () => !(await fs.readdir(directory)).length);
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('actual isolated worker still extracts synthetic DOCX, rejects damaged files, and honors deadlines', TIMEOUT, async () => {
  const source = zip(docxEntries(paragraph('Retained actual-worker evidence.')));
  assert.match((await importDocument(source, 'docx')).text, /Retained actual-worker evidence/);
  await assert.rejects(importDocument(Buffer.from('not a ZIP'), 'docx'), error => error.status === 422);
  await assert.rejects(importDocument(source, 'docx', { timeoutMs: 1 }), /deadline/);
});
