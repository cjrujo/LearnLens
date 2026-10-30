import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../server.mjs';
import { configured, startApp, ok, lessonInput, setRoles, EMPTY_ROLES, request } from './helpers.mjs';

const OPTIONS = { timeout: 15000 };

test('logout during a partial upload cannot repopulate the cleared provider store', OPTIONS, async t => {
  const app = await startApp(t), client = await app.client();
  const data = JSON.stringify({ name: 'Late provider', baseUrl: 'http://127.0.0.1:3211/v1', apiKey: '' });
  const received = Promise.withResolvers(), finished = Promise.withResolvers();
  app.server.on('request', req => { if (req.url === '/api/providers') req.once('data', () => received.resolve()); });
  const upload = http.request(app.url + '/api/providers', { method: 'POST', headers: {
    'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data),
    Cookie: client.cookie, 'X-LearnLens-Token': client.token,
  } }, response => {
    let text = ''; response.on('data', chunk => text += chunk);
    response.on('end', () => finished.resolve({ status: response.statusCode, text }));
  });
  upload.on('error', finished.reject);
  t.after(() => upload.destroy());
  upload.write(data.slice(0, 10));
  await received.promise;
  ok(await client.request('/api/logout', { method: 'POST', json: {} }));
  upload.end(data.slice(10));
  const result = await finished.promise;
  assert.equal(result.status, 401);
  assert.match(result.text, /Session changed/);
  assert.deepEqual(ok(await client.request('/api/state')).providers, []);
});

test('one AI job per session; logout invalidates its result before any follow-on speech call', OPTIONS, async t => {
  const { client, mock, provider, roles } = await configured(t);
  await setRoles(client, { ...roles, speech: { providerId: provider.id, model: 'speech', api: 'auto', voice: 'alloy' } });
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  mock.config.beforeResponse = async () => { entered.resolve(); await release.promise; };
  const first = client.request('/api/lessons', { method: 'POST', json: lessonInput({ includeAudio: true }) });
  try {
    await entered.promise;
    const second = await client.request('/api/lessons', { method: 'POST', json: lessonInput() });
    assert.equal(second.status, 409);
    ok(await client.request('/api/logout', { method: 'POST', json: {} }));
  } finally { release.resolve(); }
  const result = await first;
  assert.equal(result.status, 401);
  assert.match(result.json.error, /Session changed/);
  assert.equal(mock.calls.length, 1, 'No speech job may start after logout.');
  const state = ok(await client.request('/api/state'));
  assert.deepEqual(state.providers, []);
  assert.deepEqual(state.roles, EMPTY_ROLES);
});

test('hosted configuration fails closed and issues secure sessions only for its HTTPS origin', OPTIONS, async t => {
  assert.throws(() => createApp({ publicOrigin: 'http://example.com' }), /HTTPS/);
  assert.throws(() => createApp({ publicOrigin: 'https://example.com' }), /password/i);
  assert.throws(() => createApp({ accessPassword: 'short' }), /16/);
  const app = await startApp(t, { publicOrigin: 'https://learnlens.example', accessPassword: 'private-beta-test-password' });
  const wrongHost = await request(app.url + '/');
  assert.equal(wrongHost.status, 403);
  const response = await request(app.url + '/', { headers: { Host: 'learnlens.example', Origin: 'https://learnlens.example' } });
  assert.equal(response.status, 200);
  assert.match(response.headers['set-cookie'][0], /; Secure/);
  assert.match(response.headers['set-cookie'][0], /HttpOnly; SameSite=Strict/);
  assert.equal(response.headers['strict-transport-security'], 'max-age=31536000');
  const hostile = await request(app.url + '/', { headers: { Host: 'learnlens.example', Origin: 'https://other.example' } });
  assert.equal(hostile.status, 403);
});
