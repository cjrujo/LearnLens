import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import * as audioClient from '../public/audio-client.js';
import * as audioSources from '../public/audio-sources.js';
import { audioDecision } from '../public/audio-policy.js';

// Defaults to production sources. The override is solely for replaying these
// same tests against an explicitly saved pre-fix app/materials pair.
const sourceRoot = process.env.LEARNLENS_UI_RECOVERY_SOURCE_DIR
  ? pathToFileURL(resolve(process.env.LEARNLENS_UI_RECOVERY_SOURCE_DIR) + sep)
  : new URL('../public/', import.meta.url);
const appSource = readFileSync(new URL('app.js', sourceRoot), 'utf8');
const materialSource = readFileSync(new URL('materials.js', sourceRoot), 'utf8');
const withoutImports = source => source.replace(/^import .*;\r?\n/gm, '');
const wiringStart = appSource.indexOf('// Navigation and dialogs.');
assert.ok(wiringStart > 0, 'Locate app event wiring without substituting implementation snippets.');
const appFunctions = withoutImports(appSource.slice(0, wiringStart));
const materialFunctions = withoutImports(materialSource).replace(/^export class MaterialWorkspace/m, 'class MaterialWorkspace');

class Element {
  constructor() {
    this.style = {}; this.value = ''; this.hidden = true; this.disabled = false;
    this.checked = false; this.open = false; this.textContent = '';
    this.classList = { add() {}, remove() {}, toggle() {} };
    this.contentWindow = { postMessage() {} };
  }
  append() {}
  after() {}
  replaceChildren() {}
  setAttribute() {}
  querySelectorAll() { return []; }
  querySelector() { return new Element(); }
  focus() {}
  close() { this.open = false; }
  click() { if (!this.disabled) this.onclick?.({ preventDefault() {} }); }
}

const resultFor = title => ({
  title, html: '<!doctype html><p>' + title + '</p>', warnings: [],
  lesson: { title, subject: 'Mathematics', englishLearning: false, level: 'Auto', language: 'English',
    summary: 'Synthetic lesson.', objectives: ['Understand fractions.'],
    sections: [{ type: 'explanation', title: 'Equal parts', body: 'A half is one of two equal parts.',
      items: [], question: '', answer: '', translation: '', source: '' }], audio: [], warnings: [] },
});
const setup = () => ({
  locked: false, setupRevision: 7, providers: [{ id: 'fixture', name: 'Synthetic provider' }],
  roles: { primary: { providerId: 'fixture', model: 'synthetic-primary' }, transcription: { model: 'synthetic-stt' },
    speech: { engine: 'kokoro', model: 'synthetic-kokoro', voice: 'af_heart' } },
});

function harness(transport = async path => { throw new Error('Unexpected synthetic API route: ' + path); }) {
  const nodes = new Map(), requests = [], dialogs = [];
  const get = id => { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id); };
  let modalChoice = 'accept';
  get('confirm-dialog').showModal = () => {
    get('confirm-dialog').open = true;
    dialogs.push({ title: get('confirm-title').textContent, paid: !get('confirm-consent-row').hidden,
      acceptDisabled: get('confirm-accept').disabled });
    // Exercise the real confirmAction and its checkbox handler. A disabled DOM
    // button must not accept a click. No browser, timers or network are involved.
    queueMicrotask(() => {
      if (modalChoice === 'accept') {
        get('confirm-consent').checked = true;
        get('confirm-consent').onchange();
      }
      if (modalChoice !== 'cancel') get('confirm-accept').click();
      if (get('confirm-dialog').open) get('confirm-cancel').click();
    });
  };
  const document = {
    getElementById: get, createElement: () => new Element(), createElementNS: () => new Element(),
    querySelector: () => ({ content: 'synthetic-token-not-a-session' }), querySelectorAll: () => [],
  };
  const api = async (path, options = {}) => {
    requests.push({ path, method: options.method, body: structuredClone(options.body) });
    return transport(path, options);
  };
  const context = vm.createContext({
    ...audioClient, ...audioSources, audioDecision, document, testApi: api,
    structuredClone, crypto, DOMException, AbortController, AbortSignal, TextEncoder,
    console, navigator: {}, queueMicrotask,
    Image: class { width = 1; height = 1; async decode() {} },
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    fetch() { assert.fail('The VM must never make a network request.'); },
  });
  vm.runInContext(materialFunctions, context, { filename: 'materials.js' });
  vm.runInContext(appFunctions, context, { filename: 'app.js' });
  vm.runInContext(`
    // Only rendering/navigation/refresh are replaced. Generation, retention,
    // confirmation, source preparation and audio continuation remain real.
    updateStatus = () => {}; renderAudioStatus = () => {}; renderTrace = () => {};
    renderGenerationCheckpoint = () => {}; navigate = () => {}; tab = () => {};
    announce = () => {}; stopPreviewAudio = () => {}; displayLesson = () => {};
    beginTrace = () => {}; refreshState = async () => {};
    api = testApi; materials.api = testApi; materials.render = () => {};
    ready = true;
    globalThis.ui = {
      materials, history: lessonHistory, generate, preview, continueLessonAudio,
      approval: approvedAudioSetup, signature: materialSignature,
      setState(value) { state = value; },
      setCurrent(value) { currentLesson = value; },
      setCheckpoint(value) { generationCheckpoint = value; },
      get current() { return currentLesson; },
      get checkpoint() { return generationCheckpoint; },
      get blocked() { return Boolean(lessonRetentionBlocker(lessonHistory)); },
    };
  `, context);
  const ui = context.ui;
  ui.setState(setup());
  for (const [id, value] of Object.entries({ 'audio-mode': 'off', subject: 'custom', 'custom-subject': 'Mathematics', language: 'English', level: 'Auto', 'learning-goal': 'Learn fractions.' })) get(id).value = value;
  return { ui, requests, dialogs, get, context,
    async act(action, choice = 'accept') { modalChoice = choice; return action(); },
    evaluate: source => vm.runInContext(source, context),
  };
}

function unfinishedLesson(title = 'A') {
  return { ...resultFor(title), audio: { sourcePending: false, discarded: false, exportedComplete: false } };
}

for (const entry of ['generate', 'preview']) test(`UI ${entry}: demo cannot make an interrupted teaching resume bypass two-lesson retention`, async () => {
  let teachingCalls = 0;
  const h = harness(async path => {
    if (path === '/demo') return resultFor('Demo');
    assert.equal(path, '/lessons');
    teachingCalls++;
    if (teachingCalls === 1) throw new Error('Synthetic B teaching failure');
    return resultFor('Acknowledged B');
  });
  const oldest = unfinishedLesson();
  h.ui.history.push(oldest); h.ui.setCurrent(oldest);
  await h.act(() => h.ui.generate());
  assert.equal(h.ui.checkpoint.phase, 'lesson');
  assert.ok(h.ui.checkpoint.prepared, 'Ordinary preparation has completed.');
  assert.equal(teachingCalls, 1);
  await h.act(() => h.ui.preview('demo'));
  assert.deepEqual(Array.from(h.ui.history, lesson => lesson.title), ['A', 'Demo']);
  assert.equal(h.ui.blocked, true);
  const resume = () => entry === 'generate'
    ? h.ui.generate(undefined, { resume: true })
    : h.ui.preview('generate', h.ui.checkpoint.request, h.ui.approval(), { resume: true });
  await h.act(resume);
  await h.act(resume);
  assert.equal(teachingCalls, 1, 'Blocked continuation must not dispatch or repeat teaching.');
  assert.equal(h.dialogs.length, 1, 'Only the original failed teaching attempt requested paid consent.');
  assert.equal(h.ui.current.title, 'Demo');
  assert.deepEqual(Array.from(h.ui.history, lesson => lesson.title), ['A', 'Demo']);
  assert.equal(h.ui.checkpoint.phase, 'lesson');
});

test('UI checkpoints acknowledged teaching before local retention and reuses it after a local failure', async () => {
  let teachingCalls = 0;
  const acknowledged = resultFor('Acknowledged once');
  const h = harness(async path => { assert.equal(path, '/lessons'); teachingCalls++; return acknowledged; });
  const originalRetain = h.context.retainLesson;
  h.context.retainLesson = () => { throw new Error('Synthetic local retention failure'); };
  await h.act(() => h.ui.generate());
  assert.equal(teachingCalls, 1);
  assert.equal(h.ui.history.length, 0);
  assert.match(h.get('preview-error-message').textContent, /Synthetic local retention failure/);
  const pinned = h.ui.checkpoint.teachingResult;
  h.context.retainLesson = originalRetain;
  await h.act(() => h.ui.generate(undefined, { resume: true }));
  assert.equal(teachingCalls, 1, 'An acknowledged teaching response must not be paid for again.');
  assert.strictEqual(pinned, acknowledged, 'Keep the received result before any local retention work.');
  assert.equal(h.ui.history.length, 1);
  assert.equal(h.ui.current.html, acknowledged.html);
  assert.equal(h.ui.checkpoint.phase, 'retained');
  assert.equal(h.ui.checkpoint.teachingResult, null, 'Release the pinned response only after retention succeeds.');
});

test('UI retained-phase audio-only continuation bypasses new-lesson capacity and needs no primary role', async () => {
  const h = harness();
  const oldest = unfinishedLesson(), retained = unfinishedLesson('B');
  retained.audio.sourcePending = true;
  h.ui.history.push(oldest, retained); h.ui.setCurrent(oldest);
  h.ui.setCheckpoint({ phase: 'retained', lesson: retained, materials: h.ui.signature(), unavailable: false });
  const state = setup(); state.roles.primary = null; h.ui.setState(state);
  h.evaluate('globalThis.audioContinuations = 0; continueLessonAudio = async () => { audioContinuations++; };');
  await h.act(() => h.ui.generate(undefined, { resume: true }));
  assert.equal(h.context.audioContinuations, 1, 'Route retained audio before the guard for another teaching result.');
  assert.strictEqual(h.ui.current, retained);
  assert.equal(h.ui.history.length, 2);
  assert.equal(h.requests.length, 0);
});

async function videoRecovery(manifest) {
  let plan;
  const result = { ...resultFor('Retained English text'), lesson: { ...resultFor('Retained English text').lesson, subject: 'English', englishLearning: true } };
  const h = harness(async (path, { body } = {}) => {
    if (path === '/transcribe') return { text: 'Exact synthetic transcript ' + body.dataUrl, warnings: [] };
    if (path === '/materials/summarize') return { text: 'Synthetic digest', warnings: [] };
    if (path === '/audio/preflight') return { ready: true };
    if (path === '/audio/extract') return { text: 'Exact synthetic image words', coverage: 'complete', warnings: [] };
    if (path === '/audio/plans') {
      plan = { id: body.id, setupRevision: body.expectedSetupRevision, speech: setup().roles.speech,
        sourceKeys: [], warnings: [], clips: [], summary: { status: 'collecting', totalClips: 0, completedClips: 0 } };
      return structuredClone(plan);
    }
    if (path === '/audio/plans/' + plan?.id) return structuredClone(plan);
    if (path === '/audio/plans/' + plan?.id + '/sources') { plan.sourceKeys.push(body.source.key); return {}; }
    if (path === '/audio/plans/' + plan?.id + '/seal') { plan.summary.status = 'complete'; return structuredClone(plan); }
    if (path === '/audio/plans/' + plan?.id + '/export') return { ...result, audioSummary: structuredClone(plan.summary) };
    assert.fail('Unexpected synthetic endpoint: ' + path);
  });
  const video = { id: 'synthetic-video', name: 'clip.mp4', kind: 'media', partCount: 2, status: 'ready', warnings: [], manifest,
    preview: { images: [{ dataUrl: 'synthetic-preview-frame' }] } };
  const text = { id: 'synthetic-text', name: 'notes.txt', kind: 'text', partCount: 1, status: 'ready', warnings: [], textParts: ['Original notes'] };
  h.ui.materials.items = [video, text];
  h.ui.materials.part = async (item, index) => item === video
    ? { text: '', audio: 'audio-' + index, images: [{ name: 'Frame ' + index, dataUrl: 'data:image/png;base64,synthetic-' + index }] }
    : { text: text.textParts[0], images: [] };
  await h.ui.materials.loadPreview(text, 0, h.ui.materials.epoch);
  assert.equal(video.preview.images.length, 0, 'Loading another attachment evicts the video preview, not its frames.');
  await h.ui.materials.prepare({ consent: true, goal: 'Practice English.', roles: setup().roles, expectedSetupRevision: 7 });
  assert.equal(h.requests.filter(request => request.path === '/audio/extract').length, 0);
  const context = audioClient.createAudioContext({ sources: [], approvedSetup: h.ui.approval(), input: { text: 'Bounded notes', images: [] }, result });
  context.sourcePending = true; context.sourceMaterials = h.ui.signature();
  const lesson = { ...result, audio: context };
  h.ui.history.push(lesson); h.ui.setCurrent(lesson);
  h.requests.length = 0;
  return h;
}

for (const [label, manifest] of [['known video', { hasAudio: true, hasVideo: true }], ['unknown media', undefined]]) {
  test(`UI ${label}: evicted previews cannot remove the paid OCR confirmation gate`, async () => {
    const h = await videoRecovery(manifest);
    const checkpoint = h.ui.materials.checkpoint;
    await h.act(() => h.ui.continueLessonAudio(), 'without-checkbox');
    assert.equal(h.requests.length, 0, 'Unchecked paid consent must dispatch neither preflight nor OCR.');
    assert.equal(h.dialogs[0].paid, true);
    assert.equal(h.dialogs[0].acceptDisabled, true);
    assert.equal(h.ui.current.audio.sourcePending, true);
    assert.strictEqual(h.ui.materials.checkpoint, checkpoint);
    await h.act(() => h.ui.continueLessonAudio(), 'accept');
    assert.equal(h.dialogs[1].paid, true);
    const recognition = h.requests.filter(request => request.path === '/audio/extract');
    assert.equal(recognition.length, 2, 'Fresh explicit consent permits only missing frame recognition.');
    for (const request of recognition) {
      assert.equal(request.body.consent, true);
      assert.equal(request.body.expectedSetupRevision, 7);
    }
    assert.ok(!h.requests.some(request => ['/lessons', '/transcribe', '/materials/summarize'].includes(request.path)));
    assert.equal(h.ui.current.audio.sourcePending, false);
    assert.equal(h.ui.current.audio.exportedComplete, true, 'No swallowed synthetic transport failure may pass as recovery.');
    const uploads = h.requests.filter(request => request.path.endsWith('/sources'));
    assert.deepEqual(uploads.map(request => request.body.source.extraction), ['transcription', 'vision', 'transcription', 'vision', 'text']);
    assert.equal(uploads.at(-1).body.source.text, 'Original notes');
    assert.equal(h.ui.materials.checkpoint, null, 'Sources transfer before the pinned original job is released.');
  });
}

test('UI known audio-only media without preview images does not imply paid image recognition', () => {
  const h = harness();
  h.ui.materials.items = [{ kind: 'media', manifest: { hasAudio: true, hasVideo: false }, preview: { images: [] } }];
  assert.equal(h.ui.materials.hasVisuals, false);
});
