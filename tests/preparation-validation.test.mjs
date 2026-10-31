import test from 'node:test';
import assert from 'node:assert/strict';
import { configured, setRoles, PNG_URL, KEY } from './helpers.mjs';
import { digestPrompt, parseDigest } from '../lib/material-digest.mjs';
import { MaterialWorkspace } from '../public/materials.js';

const PRIVATE = 'PRIVATE_RESPONSE_AND_SOURCE_SENTINEL';
const shortText = 'Synthetic transcript with original learning words. '.repeat(60).slice(0, 2110);
const exactNotes = length => ('Synthetic notes: Café 中文 🧪\n  Equation: 1/2 + 1/2 = 1.\n' + 'Faithful notes. '.repeat(600)).slice(0, length - 4) + ' END';
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

test('digest prompt retains the soft notes target and strict warning limits and required fields', () => {
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
    [json({ notes: PRIVATE + 'x'.repeat(8001), warnings: [] }), 'digest_notes_limit'],
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
  const valid = { notes: 'x'.repeat(8000), warnings: Array(5).fill('w'.repeat(300)) };
  assert.deepEqual(parseDigest('```JSON\n' + json(valid) + '\n```'), { text: valid.notes, warnings: valid.warnings });
});

test('API notes validation preserves upstream success metadata but never retries or exposes response/source/keys', async t => {
  const { client, mock } = await configured(t, { api: 'auto', mock: { outputText: JSON.stringify({ notes: PRIVATE + 'x'.repeat(8001), warnings: [] }) } });
  const result = await summarize(client, { text: PRIVATE.repeat(100), source: PRIVATE, goal: PRIVATE });
  assert.equal(result.status, 502);
  const d = result.json.diagnostics;
  assert.equal(d.stage, 'source_preparation');
  assert.equal(d.category, 'preparation_validation');
  assert.equal(d.validationReason, 'digest_notes_limit');
  assert.equal(d.notesCharacters, PRIVATE.length + 8001);
  assert.match(result.json.error, new RegExp(`notes contained ${PRIVATE.length + 8001} characters; the limit is 8000`));
  assert.equal(d.endpoint, '/responses');
  assert.equal(d.upstreamStatus, 200);
  assert.equal(d.contentType, 'application/json');
  assert.equal(d.completionStatus, 'completed');
  assert.equal(d.maxOutputTokens, 2000);
  assert.ok(d.responseBytes > 8001 && d.elapsedMs >= 0);
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

test('model notes use a decoded UTF-16 hard cap without changing boundary trim or internal text', () => {
  for (const notes of [exactNotes(2473), exactNotes(8000), '🧪'.repeat(4000), '  ' + exactNotes(7996) + '\n ']) {
    assert.deepEqual(parseDigest(JSON.stringify({ notes, warnings: ['  Caveat  '] })), { text: notes.trim(), warnings: ['Caveat'] });
    // JSON escapes do not consume the decoded-character allowance.
    const escaped = JSON.stringify({ notes, warnings: [] }).replace(/[^\x20-\x7e]/g, char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0'));
    assert.deepEqual(parseDigest(escaped), { text: notes.trim(), warnings: [] });
  }
  for (const notes of [exactNotes(8001), '🧪'.repeat(4000) + 'x', ' ' + exactNotes(8000)]) {
    assert.throws(() => parseDigest(JSON.stringify({ notes, warnings: [] })), error => {
      assert.equal(error.diagnostics.validationReason, 'digest_notes_limit');
      assert.equal(error.diagnostics.notesCharacters, 8001);
      assert.match(error.message, /8001 characters; the limit is 8000/);
      return true;
    });
  }
  assert.throws(() => parseDigest(JSON.stringify({ notes: exactNotes(2473) + '\u0000', warnings: [] })), error => error.diagnostics.validationReason === 'digest_notes_controls');
});

test('completed HTTP200 model notes of exactly 2473 and 8000 characters are accepted with no paid repair', async t => {
  for (const api of ['responses', 'chat']) {
    const { client, mock } = await configured(t, { api });
    for (const length of [2473, 8000, 8001]) {
      const notes = exactNotes(length);
      assert.equal(notes.length, length);
      mock.config.outputText = JSON.stringify({ notes, warnings: [] });
      const before = mock.calls.length;
      const response = await summarize(client, { text: 'Original source. '.repeat(200) });
      assert.equal(response.status, length <= 8000 ? 200 : 502, response.json.error);
      if (length <= 8000) assert.deepEqual(response.json, { text: notes, warnings: [], preparationMode: 'model' });
      else {
        assert.equal(response.json.diagnostics.validationReason, 'digest_notes_limit');
        assert.equal(response.json.diagnostics.notesCharacters, 8001);
        assert.equal(response.json.diagnostics.upstreamStatus, 200);
        assert.match(response.json.error, /8001 characters; the limit is 8000/);
      }
      assert.equal(mock.calls.length, before + 1, 'No repair, fallback or automatic retry');
      const call = mock.calls.at(-1).json;
      assert.equal(api === 'responses' ? call.max_output_tokens : call.max_completion_tokens, 2000);
    }
  }
});

test('2473-character API success is pinned by the frontend through later failure and confirmed resume', async t => {
  const notes = exactNotes(2473);
  const { client, mock, roles } = await configured(t, { api: 'responses', mock: { outputText: call => call.json.input[0].content[0].text.includes('First original') ? JSON.stringify({ notes, warnings: [] }) : '{invalid notes' } });
  const revision = (await client.request('/api/state')).json.setupRevision;
  const textParts = ['First original. '.repeat(200), 'Second original. '.repeat(200)];
  let calls = 0;
  const workspace = new MaterialWorkspace({ list: null, changed: () => {}, api: async (path, { body }) => {
    calls++;
    const response = await client.request('/api' + path, { method: 'POST', json: body });
    if (response.status !== 200) throw Object.assign(new Error(response.json.error), { diagnostics: response.json.diagnostics });
    return response.json;
  } });
  workspace.items = [{ id: 'model-notes', name: 'Synthetic.txt', kind: 'text', status: 'ready', textParts, partCount: 2, warnings: [] }];
  const options = { consent: true, goal: 'Learn', roles, expectedSetupRevision: revision, completeAudio: true };
  await assert.rejects(workspace.prepare(options), error => error.diagnostics?.validationReason === 'digest_invalid_json');
  assert.equal(calls, 2);
  assert.equal(mock.calls.length, 2);
  assert.equal(workspace.checkpointInfo().completedCalls, 1);
  assert.equal(workspace.checkpointInfo().completedParts, 1);
  assert.deepEqual([...workspace.checkpoint.pinned.values()].map(result => result.text), [notes]);
  workspace.cache.clear(); workspace.cacheBytes = 0;
  mock.config.outputText = JSON.stringify({ notes: 'Recovered second notes.', warnings: [] });
  const result = await workspace.prepare({ ...options, resume: true });
  assert.equal(calls, 3);
  assert.equal(mock.calls.length, 3);
  assert.equal(result.text, `[Source: Synthetic.txt · Text part 1 (1/2)]\n${notes}\n\n[Source: Synthetic.txt · Text part 2 (2/2)]\nRecovered second notes.`);
  assert.equal(result.audioSources.map(source => source.text).join(''), textParts.join(''));
  assert.strictEqual(await workspace.prepare({ ...options, resume: true }), result);
  assert.equal(calls, 3);
});

test('all-local source preparation does not falsely label verbatim text as an AI digest', async () => {
  const workspace = new MaterialWorkspace({ list: null, changed: () => {}, api: async (_path, { body }) => ({ text: body.text, warnings: [], preparationMode: 'verbatim' }) });
  workspace.items = [{ id: 'local-source', name: 'Synthetic.txt', kind: 'text', status: 'ready', textParts: ['First sentence.', 'Final sentence.'], partCount: 2, warnings: [] }];
  const result = await workspace.prepare({ consent: true, goal: 'Learn', roles: { primary: { model: 'synthetic' } }, expectedSetupRevision: 1 });
  assert.ok(result.text.includes('First sentence.') && result.text.includes('Final sentence.'));
  assert.ok(!result.sourceWarnings.some(warning => /digest/i.test(warning)));
});
