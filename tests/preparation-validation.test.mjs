import test from 'node:test';
import assert from 'node:assert/strict';
import { configured, setRoles, PNG_URL, KEY } from './helpers.mjs';
import { digestPrompt, parseDigest } from '../lib/material-digest.mjs';
import { MaterialWorkspace } from '../public/materials.js';

const PRIVATE = 'PRIVATE_RESPONSE_AND_SOURCE_SENTINEL';
const shortText = 'Synthetic transcript with original learning words. '.repeat(60).slice(0, 2110);
const summarize = (client, body) => client.request('/api/materials/summarize', { method: 'POST', json: { consent: true, ...body } });

// Mirrors the reported 2110-character text-only step, without user material.
test('short transcript preparation preserves text locally even when the configured model would return invalid notes', async t => {
  const { client, mock } = await configured(t, { mock: { outputText: '{invalid model notes' } });
  const response = await summarize(client, { text: shortText, images: [] });
  assert.equal(response.status, 200, response.json.error);
  assert.equal(response.json.text, shortText.trim());
  assert.equal(response.json.preparationMode, 'verbatim');
  assert.deepEqual(response.json.warnings, []);
  assert.equal(mock.calls.length, 0, 'Already-small source text must not depend on another model response');
});

test('local preparation retains exact decoded text and the 2200-character boundary, not a lossy rewrite', async t => {
  const { client, mock } = await configured(t, { mock: { chatStatus: 500 } });
  for (const text of [
    'x'.repeat(2200),
    '  Café — 中文\n  1/2 + 1/2 = 1.\nOriginal spacing and 🧪 remain.  ',
    '{"notes":"This is source text, not a generated summary.","warnings":[]}',
  ]) {
    const result = await summarize(client, { text });
    assert.equal(result.status, 200, result.json.error);
    assert.equal(result.json.text, text.trim(), 'Only the pre-existing input boundary trim is applied');
    assert.equal(result.json.preparationMode, 'verbatim');
  }
  assert.equal(mock.calls.length, 0);
});

test('local preparation retains consent, setup revision, input validation and CSRF guards', async t => {
  const { client, mock } = await configured(t);
  const state = (await client.request('/api/state')).json;
  for (const consent of [undefined, false, 'true', 1]) {
    assert.equal((await summarize(client, { text: shortText, consent })).status, 400);
  }
  assert.equal((await summarize(client, { text: shortText, expectedSetupRevision: state.setupRevision - 1 })).status, 409);
  assert.equal((await summarize(client, { text: '' })).status, 400);
  assert.equal((await summarize(client, { text: 'Bad\u0000source' })).status, 400);
  assert.equal((await client.request('/api/materials/summarize', { method: 'POST', token: 'wrong', json: { text: shortText, consent: true } })).status, 403);
  assert.equal(mock.calls.length, 0);
});

test('long text and every visual still use one model request with unchanged thinking and token budgets', async t => {
  for (const api of ['responses', 'chat']) {
    const { client, mock, roles } = await configured(t, { api, mock: { outputText: '{"notes":"Prepared notes","warnings":[]}' } });
    await setRoles(client, { ...roles, primary: { ...roles.primary, reasoningEffort: 'xhigh' } });
    for (const body of [{ text: 'x'.repeat(2201) }, { text: 'Short visual caption', images: [{ name: 'Synthetic image', dataUrl: PNG_URL }] }]) {
      const before = mock.calls.length;
      const response = await summarize(client, body);
      assert.equal(response.status, 200, response.json.error);
      assert.deepEqual(response.json, { text: 'Prepared notes', warnings: [], preparationMode: 'model' });
      assert.equal(mock.calls.length, before + 1);
      const call = mock.calls.at(-1).json;
      assert.equal(api === 'responses' ? call.max_output_tokens : call.max_completion_tokens, 2000);
      assert.equal(api === 'responses' ? call.reasoning.effort : call.reasoning_effort, 'xhigh');
      assert.equal(call.stream, false);
    }
  }
});

test('digest prompt explicitly documents every strict length and required field', () => {
  const { instructions } = digestPrompt({ text: shortText, images: [], source: 'Synthetic', goal: 'Learn' });
  assert.match(instructions, /two required fields/);
  assert.match(instructions, /2200 characters/);
  assert.match(instructions, /0 to 5 strings, each at most 300 characters/);
  assert.match(instructions, /warnings: \[\]/);
  assert.match(instructions, /decoded text/);
});

test('every notes rejection has a deterministic metadata-only reason and never echoes model text', async t => {
  const json = value => JSON.stringify(value);
  const cases = [
    [null, 'digest_text_type'],
    [PRIVATE.repeat(4000), 'digest_output_limit'],
    [`{${PRIVATE}`, 'digest_invalid_json'],
    [json(null), 'digest_object_required'],
    [json([PRIVATE]), 'digest_object_required'],
    [json({ notes: [PRIVATE], warnings: [] }), 'digest_notes_type'],
    [json({ notes: '  ', warnings: [] }), 'digest_notes_empty'],
    [json({ notes: PRIVATE + 'x'.repeat(2201), warnings: [] }), 'digest_notes_limit'],
    [json({ notes: PRIVATE + '\u0000', warnings: [] }), 'digest_notes_controls'],
    [json({ notes: PRIVATE }), 'digest_warnings_type'],
    [json({ notes: PRIVATE, warnings: Array(6).fill(PRIVATE) }), 'digest_warnings_limit'],
    [json({ notes: PRIVATE, warnings: [null] }), 'digest_warning_type'],
    [json({ notes: PRIVATE, warnings: [' '] }), 'digest_warning_empty'],
    [json({ notes: PRIVATE, warnings: [PRIVATE + 'x'.repeat(301)] }), 'digest_warning_limit'],
    [json({ notes: PRIVATE, warnings: [PRIVATE + '\u0007'] }), 'digest_warning_controls'],
  ];
  for (const [text, reason] of cases) await t.test(reason, () => {
    assert.throws(() => parseDigest(text), error => {
      assert.equal(error.status, 502);
      assert.equal(error.diagnostics.category, 'preparation_validation');
      assert.equal(error.diagnostics.validationReason, reason);
      assert.equal(error.diagnostics.outputCharacters, typeof text === 'string' ? text.length : 0);
      assert.equal(error.diagnostics.automaticRetry, false);
      assert.equal(error.diagnostics.responseBodyOmitted, true);
      assert.ok(!JSON.stringify({ message: error.message, diagnostics: error.diagnostics }).includes(PRIVATE));
      return true;
    });
  });
  const valid = { notes: 'x'.repeat(2200), warnings: Array(5).fill('w'.repeat(300)) };
  assert.deepEqual(parseDigest('```JSON\n' + json(valid) + '\n```'), { text: valid.notes, warnings: valid.warnings });
});

test('API notes validation preserves upstream success metadata but never retries or exposes response/source/keys', async t => {
  const { client, mock } = await configured(t, { api: 'auto', mock: { outputText: JSON.stringify({ notes: PRIVATE + 'x'.repeat(2201), warnings: [] }) } });
  const result = await summarize(client, { text: PRIVATE.repeat(100), source: PRIVATE, goal: PRIVATE });
  assert.equal(result.status, 502);
  const d = result.json.diagnostics;
  assert.equal(d.stage, 'source_preparation');
  assert.equal(d.category, 'preparation_validation');
  assert.equal(d.validationReason, 'digest_notes_limit');
  assert.equal(d.notesCharacters, PRIVATE.length + 2201);
  assert.equal(d.endpoint, '/responses');
  assert.equal(d.upstreamStatus, 200);
  assert.equal(d.contentType, 'application/json');
  assert.equal(d.completionStatus, 'completed');
  assert.equal(d.maxOutputTokens, 2000);
  assert.ok(d.responseBytes > 2201 && d.elapsedMs >= 0);
  assert.equal(d.automaticRetry, false);
  assert.equal(d.responseBodyOmitted, true);
  assert.ok(!result.text.includes(PRIVATE));
  assert.ok(!result.text.includes(KEY));
  assert.match(result.json.requestId, /^[a-f0-9-]{36}$/);
  assert.equal(mock.calls.length, 1, 'Malformed HTTP200 must not fall back or retry');
});

test('a local retained result survives a later model failure and checkpoint continuation preserves all source text', async t => {
  const { client, mock, roles } = await configured(t, { mock: { outputText: '{invalid notes' } });
  const revision = (await client.request('/api/state')).json.setupRevision;
  const longText = 'Long original source with its own final sentinel. '.repeat(70);
  const calls = [];
  const workspace = new MaterialWorkspace({ list: null, changed: () => {}, api: async (path, options) => {
    calls.push(path);
    const response = await client.request('/api' + path, { method: options.method, json: options.body });
    if (response.status !== 200) throw Object.assign(new Error(response.json.error), { status: response.status, diagnostics: response.json.diagnostics });
    return response.json;
  } });
  workspace.items = [{ id: 'synthetic-text', name: 'Synthetic source.txt', kind: 'text', status: 'ready', textParts: [shortText, longText], partCount: 2, warnings: [] }];
  const options = { consent: true, goal: 'Learn the original source', roles, expectedSetupRevision: revision, completeAudio: true };
  await assert.rejects(workspace.prepare(options), error => error.diagnostics.validationReason === 'digest_invalid_json');
  assert.equal(workspace.checkpointInfo().completedCalls, 1);
  assert.equal(workspace.checkpointInfo().completedParts, 1);
  assert.equal(mock.calls.length, 1, 'Only the long second part needs a model');
  workspace.cache.clear(); workspace.cacheBytes = 0;
  mock.config.outputText = '{"notes":"Successful summary of the longer second part.","warnings":[]}';
  const result = await workspace.prepare({ ...options, resume: true });
  assert.equal(calls.length, 3, 'Continue retries only the unfinished part, not the successful local part');
  assert.equal(mock.calls.length, 2);
  assert.ok(result.text.includes(shortText.trim()));
  assert.equal(result.audioSources.map(source => source.text).join(''), shortText + longText);
  assert.equal(workspace.checkpointInfo().complete, true);
  assert.strictEqual(await workspace.prepare({ ...options, resume: true }), result);
  assert.equal(calls.length, 3);
  workspace.discardCheckpoint();
});

test('all-local source preparation does not falsely label verbatim text as an AI digest', async () => {
  const workspace = new MaterialWorkspace({ list: null, changed: () => {}, api: async (_path, { body }) => ({ text: body.text, warnings: [], preparationMode: 'verbatim' }) });
  workspace.items = [{ id: 'local-source', name: 'Synthetic.txt', kind: 'text', status: 'ready', textParts: ['First sentence.', 'Final sentence.'], partCount: 2, warnings: [] }];
  const result = await workspace.prepare({ consent: true, goal: 'Learn', roles: { primary: { model: 'synthetic' } }, expectedSetupRevision: 1 });
  assert.ok(result.text.includes('First sentence.') && result.text.includes('Final sentence.'));
  assert.ok(!result.sourceWarnings.some(warning => /digest/i.test(warning)));
});
