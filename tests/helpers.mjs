import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';

export const KEY = 'learnlens-fixture-key-NEVER-EXPOSE';
export const EMPTY_ROLES = Object.freeze({ primary: null, transcription: null, speech: null });
export const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);
export const PNG_URL = `data:image/png;base64,${PNG.toString('base64')}`;
export const TRANSCRIPT = 'This transcription came from the local mock provider.';

export function lessonSpec(overrides = {}) {
  const section = (type, fields = {}) => ({
    type, title: 'A useful idea', body: '', items: [], question: '', answer: '',
    translation: '', source: 'Provided notes', ...fields,
  });
  return {
    title: 'Fractions from your notes', subject: 'Mathematics', level: 'Primary',
    language: 'English', summary: 'A fraction describes equal parts of a whole.',
    objectives: ['Identify the numerator and denominator.'],
    sections: [
      section('explanation', { body: 'The denominator counts equal parts.' }),
      section('steps', { items: ['Divide a whole equally.', 'Count the selected parts.'] }),
      section('example', { body: 'One of two equal pieces is 1/2.' }),
      section('vocabulary', { items: ['Numerator: selected parts.'], translation: '分子' }),
      section('quiz', { question: 'What is one of four equal parts?', answer: '1/4', translation: '四分之一' }),
      section('summary', { body: 'Equal parts matter.' }),
    ],
    audio: [
      { text: 'A fraction describes equal parts.', translation: '分数描述相等的部分。' },
      { text: 'One half is one of two equal parts.', translation: '二分之一是两个相等部分中的一个。' },
    ],
    warnings: [], ...overrides,
  };
}

export function lessonInput(overrides = {}) {
  return {
    text: 'Provided notes: a fraction is an equal part of a whole. One of four parts is 1/4.',
    images: [], language: 'English', level: 'Primary', subject: 'Mathematics',
    goal: 'Explain equal parts and include one quiz.', includeAudio: false, ...overrides,
  };
}

// A real, tiny PCM WAV container; no speech synthesis or media dependencies needed.
export function tinyWav() {
  const samples = 800;
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(8000, 24);
  buffer.writeUInt32LE(16000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(samples * 2, 40);
  return buffer;
}

export const WAV = tinyWav();

// Add a valid ancillary PNG text chunk so size-limit tests do not use corrupt files.
export function sizedPng(byteLength) {
  const textLength = byteLength - PNG.length - 12;
  assert.ok(textLength >= 8);
  const chunk = Buffer.alloc(textLength + 12, 0x61);
  chunk.writeUInt32BE(textLength, 0);
  chunk.write('tEXt', 4);
  chunk.write('padding\0', 8);
  let crc = 0xffffffff;
  for (const byte of chunk.subarray(4, -4)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4);
  return Buffer.concat([PNG.subarray(0, -12), chunk, PNG.subarray(-12)]);
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', onError);
      resolve();
    });
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}`;
}

async function close(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
}

/** All traffic initiated by the test harness is restricted to IPv4 loopback. */
export async function request(url, { method = 'GET', json, raw, token, cookie, headers = {}, timeout = 10_000 } = {}) {
  const target = new URL(url);
  assert.equal(target.protocol, 'http:', 'Tests must never contact external providers.');
  assert.equal(target.hostname, '127.0.0.1', 'Tests may contact only their loopback fixtures.');
  const body = json !== undefined ? Buffer.from(JSON.stringify(json))
    : raw !== undefined ? Buffer.from(raw) : undefined;
  const requestHeaders = {};
  if (json !== undefined) requestHeaders['content-type'] = 'application/json';
  if (body !== undefined) requestHeaders['content-length'] = body.length;
  if (token != null) requestHeaders['x-learnlens-token'] = token;
  if (cookie != null) requestHeaders.cookie = cookie;
  Object.assign(requestHeaders, headers);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port: target.port, path: target.pathname + target.search,
      method, headers: requestHeaders, agent: false,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        const bytes = Buffer.concat(chunks);
        const text = bytes.toString('utf8');
        let parsed = null;
        try { parsed = JSON.parse(text); } catch { /* HTML and binary responses are valid here. */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json: parsed, bytes });
      });
    });
    req.setTimeout(timeout, () => req.destroy(new Error(`Timed out: ${method} ${target.pathname}`)));
    req.on('error', reject);
    req.end(body);
  });
}

function readSessionCookie(response, required = false) {
  const cookies = response.headers['set-cookie'] ?? [];
  const cookie = (Array.isArray(cookies) ? cookies : [cookies])
    .find((value) => /^learnlens_session=/.test(value));
  if (required) assert.ok(cookie, 'GET / must set the learnlens_session cookie.');
  return cookie?.split(';', 1)[0];
}

function readMetaToken(html) {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const attributes = {};
    for (const match of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
      attributes[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4];
    }
    if (attributes.name === 'learnlens-token') {
      const token = attributes.content;
      assert.ok(token && !token.includes('__APP_TOKEN__'), 'The session CSRF meta token must be injected.');
      return token.replaceAll('&amp;', '&').replaceAll('&quot;', '"').replaceAll('&#39;', "'");
    }
  }
  assert.fail('GET / must include <meta name="learnlens-token" content="...">; no other index markup is required.');
}

export async function browserClient(baseUrl) {
  const client = {
    baseUrl, cookie: undefined, token: undefined,
    async refresh() {
      const response = await request(`${baseUrl}/`, { cookie: this.cookie });
      assert.equal(response.status, 200, `Browser bootstrap GET / failed: ${response.text.slice(0, 300)}`);
      const cookie = readSessionCookie(response, this.cookie === undefined);
      if (cookie) this.cookie = cookie;
      this.token = readMetaToken(response.text);
      return response;
    },
    async request(path, options = {}) {
      const response = await request(baseUrl + path, {
        ...options,
        token: Object.hasOwn(options, 'token') ? options.token : this.token,
        cookie: Object.hasOwn(options, 'cookie') ? options.cookie : this.cookie,
      });
      if (!Object.hasOwn(options, 'cookie')) {
        const cookie = readSessionCookie(response);
        if (cookie) this.cookie = cookie;
      }
      return response;
    },
  };
  await client.refresh();
  return client;
}

const guardedTests = new WeakSet();
function guardExternalNetwork(t) {
  if (guardedTests.has(t)) return;
  guardedTests.add(t);
  const blocked = [];
  const connect = net.Socket.prototype.connect;
  t.mock.method(net.Socket.prototype, 'connect', function (...args) {
    let first = args[0];
    // net.createConnection also uses Node's normalized [options, callback] form.
    if (Array.isArray(first)) first = first[0];
    const host = first && typeof first === 'object'
      ? first.host ?? first.hostname ?? 'localhost'
      : typeof args[1] === 'string' ? args[1] : 'localhost';
    if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)) {
      blocked.push(String(host));
      throw new Error(`External network is forbidden in LearnLens tests: ${host}`);
    }
    return Reflect.apply(connect, this, args);
  });
  t.after(() => assert.deepEqual(blocked, [], 'The app attempted a forbidden external connection.'));
}

export async function startApp(t, options = {}) {
  guardExternalNetwork(t);
  const { createApp } = await import('../server.mjs');
  // Deliberately ignore createApp().token: the browser cookie/meta pair is authoritative.
  const { server } = await createApp(options);
  assert.ok(server instanceof http.Server, 'createApp must return its HTTP server.');
  t.after(() => close(server));
  const url = await listen(server);
  return { server, url, client: () => browserClient(url) };
}

function sendJson(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
}

export async function mockProvider(t, options = {}) {
  const config = {
    basePath: '/custom/v1', models: [{ id: 'listed-text-only' }], modelsStatus: 200,
    responsesStatus: 200, chatStatus: 200, speechStatus: 200, transcriptionStatus: 200,
    lesson: lessonSpec(), outputText: undefined, ...options,
  };
  const calls = [];
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks);
      let json = null;
      try { json = JSON.parse(raw.toString('utf8')); } catch { /* Multipart or empty. */ }
      const call = { method: req.method, path: req.url, headers: req.headers, raw, json };
      calls.push(call);
      if (config.beforeResponse) await config.beforeResponse(call);
      const route = req.url.slice(config.basePath.length);
      if (!req.url.startsWith(`${config.basePath}/`)) {
        return sendJson(res, 404, { error: { message: `Wrong API prefix: ${req.url}` } });
      }
      const failure = (status) => sendJson(res, status, { error: { message: `Local mock status ${status}` } });
      if (req.method === 'GET' && route === '/models') {
        if (config.modelsStatus !== 200) return failure(config.modelsStatus);
        return sendJson(res, 200, { object: 'list', data: config.models });
      }
      if (req.method === 'POST' && (route === '/responses' || route === '/chat/completions')) {
        const status = route === '/responses' ? config.responsesStatus : config.chatStatus;
        if (status !== 200) return failure(status);
        const text = typeof config.outputText === 'function' ? config.outputText(call)
          : config.outputText ?? JSON.stringify(config.lesson);
        if (route === '/responses') {
          // Use the real HTTP wire shape, not an SDK-only output_text convenience property.
          return sendJson(res, 200, {
            id: 'resp_local_fixture', object: 'response', status: 'completed', model: json?.model,
            output: [{ id: 'msg_fixture', type: 'message', role: 'assistant', status: 'completed',
              content: [{ type: 'output_text', text, annotations: [] }] }],
          });
        }
        return sendJson(res, 200, {
          id: 'chatcmpl_local_fixture', object: 'chat.completion', model: json?.model,
          choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      }
      if (req.method === 'POST' && route === '/audio/speech') {
        if (config.speechStatus !== 200) return failure(config.speechStatus);
        res.writeHead(200, { 'content-type': 'audio/wav' });
        return res.end(WAV);
      }
      if (req.method === 'POST' && route === '/audio/transcriptions') {
        if (config.transcriptionStatus !== 200) return failure(config.transcriptionStatus);
        return sendJson(res, 200, { text: TRANSCRIPT });
      }
      return sendJson(res, 404, { error: { message: `Unexpected mock route: ${req.method} ${req.url}` } });
    } catch (error) {
      if (!res.headersSent) sendJson(res, 500, { error: { message: String(error) } });
      else res.destroy(error);
    }
  });
  t.after(() => close(server));
  const url = await listen(server);
  return { server, url, baseUrl: url + config.basePath, calls, config };
}

export function ok(response, label = 'API request') {
  assert.ok(response.status >= 200 && response.status < 300,
    `${label}: expected 2xx, received ${response.status}: ${response.text.slice(0, 700)}`);
  assert.ok(response.json && typeof response.json === 'object', `${label}: expected JSON.`);
  return response.json;
}

export function rejected(response, label = 'Invalid request', clientOnly = true) {
  assert.ok(response.status >= 400 && response.status < (clientOnly ? 500 : 600),
    `${label}: expected ${clientOnly ? '4xx' : 'an error'}, received ${response.status}: ${response.text.slice(0, 700)}`);
  assert.equal(typeof response.json?.error, 'string', `${label}: errors must have {error: string}.`);
  assert.ok(response.json.error.length > 0, `${label}: explain the error.`);
}

export function noSecrets(value, secrets = [KEY]) {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of secrets) {
    if (secret) assert.ok(!serialized.includes(secret), `A response exposed a secret: ${secret.slice(0, 12)}…`);
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      assert.ok(!/^(apiKey|api_key|authorization)$/i.test(key), `Public state contains write-only field ${key}.`);
      if (child && typeof child === 'object') noSecrets(child, secrets);
    }
  }
}

export async function addProvider(client, mock, overrides = {}) {
  const response = await client.request('/api/providers', {
    method: 'POST', json: { name: 'Local fixture provider', baseUrl: mock.baseUrl, apiKey: KEY, ...overrides },
  });
  const { provider } = ok(response, 'Add provider');
  assert.equal(typeof provider?.id, 'string');
  assert.ok(provider.id.length > 0);
  noSecrets(provider, [overrides.apiKey ?? KEY]);
  return provider;
}

export async function setRoles(client, roles) {
  const value = ok(await client.request('/api/roles', { method: 'PUT', json: roles }), 'Save roles');
  assert.deepEqual(value.roles, roles, 'Saved roles must preserve manual model IDs and explicit API selection.');
  return value.roles;
}

export async function configured(t, { api = 'chat', mock: options = {} } = {}) {
  const mock = await mockProvider(t, options);
  const app = await startApp(t);
  const client = await app.client();
  const provider = await addProvider(client, mock);
  const roles = { ...EMPTY_ROLES, primary: { providerId: provider.id, model: 'manual-primary', api } };
  await setRoles(client, roles);
  assert.equal(mock.calls.filter((call) => call.method !== 'GET').length, 0,
    'Adding a provider or saving roles must not silently make paid inference/probe calls.');
  mock.calls.length = 0;
  return { app, client, mock, provider, roles };
}

export function assertProviderCall(call, mock, endpoint, key = KEY) {
  assert.ok(call, `Expected a provider request to ${endpoint}.`);
  assert.equal(call.path, mock.config.basePath + endpoint, 'Preserve the complete configured API prefix.');
  assert.equal(call.method, endpoint === '/models' ? 'GET' : 'POST');
  assert.equal(call.headers.authorization, `Bearer ${key}`, 'Forward the selected provider API key.');
  assert.equal(call.headers.cookie, undefined, 'Never send browser session cookies to a provider.');
  assert.equal(call.headers['x-learnlens-token'], undefined, 'Never send local CSRF credentials to a provider.');
}

const SECTION_TYPES = new Set(['explanation', 'steps', 'example', 'vocabulary', 'quiz', 'summary']);
function strings(value, label) {
  assert.ok(Array.isArray(value), `${label} must be an array.`);
  for (const item of value) assert.equal(typeof item, 'string', `${label} entries must be strings.`);
}

export function validLesson(response) {
  const value = ok(response, 'Generate lesson');
  assert.equal(typeof value.id, 'string');
  assert.ok(value.id.length > 0);
  assert.equal(typeof value.title, 'string');
  assert.equal(typeof value.html, 'string');
  assert.match(value.html, /<html\b/i, 'A downloadable lesson must be a self-contained HTML document.');
  strings(value.warnings, 'response.warnings');
  const spec = value.lesson;
  assert.ok(spec && !Array.isArray(spec) && typeof spec === 'object', 'A validated LessonSpec is required.');
  for (const field of ['title', 'subject', 'level', 'language', 'summary']) {
    assert.equal(typeof spec[field], 'string', `lesson.${field} is required.`);
  }
  assert.equal(value.title, spec.title);
  strings(spec.objectives, 'lesson.objectives');
  strings(spec.warnings, 'lesson.warnings');
  assert.ok(Array.isArray(spec.sections));
  assert.ok(spec.sections.length <= 16);
  for (const section of spec.sections) {
    assert.ok(SECTION_TYPES.has(section.type), `Unsupported section type: ${section.type}`);
    for (const field of ['title', 'body', 'question', 'answer', 'translation', 'source']) {
      assert.equal(typeof section[field], 'string', `section.${field} is required.`);
    }
    strings(section.items, 'section.items');
  }
  assert.ok(Array.isArray(spec.audio));
  assert.ok(spec.audio.length <= 8);
  for (const sentence of spec.audio) {
    assert.equal(typeof sentence.text, 'string');
    assert.equal(typeof sentence.translation, 'string');
  }
  assert.doesNotMatch(value.html, /\b(?:src|href)\s*=\s*["']\s*(?:https?:)?\/\//i,
    'Generated lesson assets must not make external requests.');
  return value;
}

export function validCheck(check, expectedStatus) {
  assert.equal(check?.status, expectedStatus);
  assert.equal(typeof check.detail, 'string');
  assert.ok(check.checkedAt != null && Number.isFinite(new Date(check.checkedAt).getTime()),
    'Capability checks need a real checkedAt timestamp.');
}

export function multipartParts(call) {
  const type = call.headers['content-type'];
  assert.match(type ?? '', /^multipart\/form-data\s*;/i);
  const match = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(type);
  assert.ok(match, 'Multipart upload must declare its boundary.');
  const boundary = match[1] ?? match[2];
  const parts = new Map();
  for (const segment of call.raw.toString('latin1').split(`--${boundary}`)) {
    const split = segment.indexOf('\r\n\r\n');
    if (split < 0) continue;
    const headers = segment.slice(0, split);
    const name = /\bname="([^"]+)"/i.exec(headers)?.[1];
    if (!name) continue;
    const content = segment.slice(split + 4).replace(/\r\n$/, '');
    parts.set(name, {
      headers, filename: /\bfilename="([^"]+)"/i.exec(headers)?.[1],
      body: Buffer.from(content, 'latin1'),
    });
  }
  return parts;
}
