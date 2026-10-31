import test from 'node:test';
import assert from 'node:assert/strict';
import { configured, setRoles, lessonSpec, lessonInput, ok } from './helpers.mjs';

test('legacy narration honors explicit reading pauses without changing returned/displayed text', async t => {
  const marked = 'A bright bird / rests in the shade.';
  const literal = 'Read 1 / 2 and https://example.test/a/b.';
  const lesson = lessonSpec({ englishLearning: true, audio: [
    { text: marked, translation: '', readingPauses: true },
    { text: literal, translation: '' },
  ] });
  const { client, mock, provider, roles } = await configured(t, { mock: { lesson } });
  await setRoles(client, { ...roles, speech: { providerId: provider.id, model: 'synthetic-tts', api: 'auto', voice: 'fixture-voice' } });
  const result = ok(await client.request('/api/lessons', { method: 'POST', json: lessonInput({ includeAudio: true }) }));
  const speech = mock.calls.filter(call => call.path.endsWith('/audio/speech'));
  assert.equal(speech.length, 2);
  assert.equal(speech[0].json.input, 'A bright bird, rests in the shade.');
  assert.equal(speech[1].json.input, literal);
  assert.equal(result.lesson.audio[0].text, marked);
  assert.equal(result.lesson.audio[0].readingPauses, true);
  assert.equal(result.lesson.englishLearning, true);
  assert.ok(result.html.includes(marked));
});

test('classification alone never grants API speech consent or enables legacy narration', async t => {
  const { client, mock } = await configured(t, { mock: { lesson: lessonSpec({ englishLearning: true }) } });
  const denied = await client.request('/api/lessons', { method: 'POST', json: lessonInput({ consent: false }) });
  assert.equal(denied.status, 400);
  assert.equal(mock.calls.length, 0);
  const result = ok(await client.request('/api/lessons', { method: 'POST', json: lessonInput({ includeAudio: false }) }));
  assert.equal(result.lesson.englishLearning, true);
  assert.equal(mock.calls.filter(call => call.path.endsWith('/audio/speech')).length, 0);
  assert.doesNotMatch(result.html, /data:audio\//);
});
