import test from 'node:test';
import assert from 'node:assert/strict';
import { createAudioContext, prepareAudioPlan, generateAudioClips, pollAudioClip, readAudioPlan, exportAudioPlan, audioExportable, lessonRetentionBlocker, retainLesson, releaseAudioSnapshots, discardAudioContext, unfinishedAudio } from '../public/audio-client.js';

function fixture(statuses = ['pending', 'pending']) {
  const context = createAudioContext({ id: 'plan-1', sources: [{ key: 'source-1', text: 'Entire source, not a digest.' }, { key: 'source-2', text: 'Second source.' }],
    approvedSetup: { revision: 3, roles: { speech: { engine: 'kokoro', model: 'kokoro', voice: 'af_heart' } } },
    input: { text: 'Bounded lesson input', images: [] }, result: { lesson: { title: 'Teaching' }, warnings: [] } });
  const manifest = { id: context.id, setupRevision: 3, speech: context.approvedSetup.roles.speech, sourceKeys: [], warnings: [],
    summary: { status: 'collecting', totalClips: statuses.length, completedClips: statuses.filter(s => s === 'complete').length },
    clips: statuses.map((status, index) => ({ id: 'clip-' + index, status, attempts: 0 })) };
  const calls = [];
  const api = async (path, options = {}) => {
    calls.push({ path, ...options });
    if (path === '/audio/plans' || path === '/audio/plans/plan-1') return structuredClone(manifest);
    if (path.endsWith('/reconfirm')) { manifest.setupRevision = options.body.expectedSetupRevision; return structuredClone(manifest); }
    if (path.endsWith('/sources')) { manifest.sourceKeys.push(options.body.source.key); return {}; }
    if (path.endsWith('/seal')) { manifest.summary.status = 'ready'; return structuredClone(manifest); }
    if (path.endsWith('/export')) return { html: '<!doctype html><p>Retained</p>', audioSummary: structuredClone(manifest.summary) };
    if (path.includes('/clips/')) {
      const clip = manifest.clips.find(item => path.endsWith('/' + item.id));
      if (options.method === 'POST') { clip.status = 'complete'; clip.attempts++; }
      manifest.summary.completedClips = manifest.clips.filter(item => item.status === 'complete').length;
      if (manifest.summary.completedClips === manifest.summary.totalClips) manifest.summary.status = 'complete';
      return structuredClone({ clip, summary: manifest.summary });
    }
    throw new Error('Unexpected route: ' + path);
  };
  return { context, manifest, api, calls };
}

test('pending source inventory cannot silently seal a lesson-only plan; explicit discard releases its references', async () => {
  const { context, api, calls } = fixture();
  context.sourcePending = true; context.sourceMaterials = 'opaque-material-signature';
  await assert.rejects(prepareAudioPlan(api, context), /Finish the original audio-source inventory/);
  assert.equal(calls.length, 0);
  assert.equal(context.createAttempted, false);
  assert.equal(unfinishedAudio(context), true);
  await assert.rejects(discardAudioContext(api, context), /Explicit discard/);
  assert.equal(context.sourcePending, true);
  await discardAudioContext(api, context, { consent: true });
  assert.equal(context.sourcePending, false);
  assert.equal(context.sourceMaterials, null);
  assert.equal(context.input, null);
  assert.equal(context.result, null);
  assert.deepEqual(context.sources, []);
  assert.equal(calls.length, 0, 'Discarding an uncreated inventory makes no provider or plan call');
});

test('plan uses a single stable ID and sources are uploaded separately, then sealed locally', async () => {
  const { context, api, calls } = fixture();
  await prepareAudioPlan(api, context);
  assert.deepEqual(calls.map(c => c.path), ['/audio/plans', '/audio/plans/plan-1', '/audio/plans/plan-1/sources', '/audio/plans/plan-1/sources', '/audio/plans/plan-1/seal']);
  assert.equal(calls[0].body.id, 'plan-1');
  assert.deepEqual(calls[0].body.expectedSources, ['source-1', 'source-2']);
  assert.equal(JSON.stringify(calls[0].body).includes('Entire source'), false);
  assert.equal(context.manifest.summary.totalClips, 2);
});

test('resume reads existing state first, reconfirms revision, and adds only missing sources', async () => {
  const { context, manifest, api, calls } = fixture();
  context.createAttempted = true; manifest.sourceKeys = ['source-1'];
  await prepareAudioPlan(api, context, { resume: true, revision: 5 });
  assert.equal(calls[0].path, '/audio/plans/plan-1');
  assert.equal(calls[1].path, '/audio/plans/plan-1/reconfirm');
  assert.equal(calls[1].body.expectedSetupRevision, 5);
  assert.deepEqual(calls.filter(c => c.path.endsWith('/sources')).map(c => c.body.source.key), ['source-2']);
  assert.equal(calls.some(c => c.path === '/audio/plans' || c.path === '/lessons'), false);
  assert.equal(context.revision, 5);
});

test('interrupted local collection resumes without preparation or teaching', async () => {
  const { context, api, calls } = fixture(); let interrupt = true;
  const transport = async (path, options) => {
    if (interrupt && path.endsWith('/sources') && options.body.source.key === 'source-2') throw new Error('Local connection lost');
    return api(path, options);
  };
  await assert.rejects(prepareAudioPlan(transport, context), /connection lost/);
  interrupt = false;
  await prepareAudioPlan(transport, context, { resume: true, revision: 3 });
  assert.equal(calls.filter(c => c.path === '/audio/plans').length, 1);
  assert.equal(calls.filter(c => c.path.endsWith('/sources') && c.body.source.key === 'source-1').length, 1);
  assert.equal(context.manifest.sourceKeys.length, 2);
});

test('encoding recovery is ordered before earlier damaged clips', async () => {
  const { context, api, calls } = fixture(['damaged', 'encoding_failed']);
  await prepareAudioPlan(api, context);
  await generateAudioClips(api, context, { consent: true, retryFailed: true });
  assert.deepEqual(calls.filter(c => c.method === 'POST' && c.path.includes('/clips/')).map(c => c.path.split('/').at(-1)), ['clip-1', 'clip-0']);
});

test('immediate continuation with unchanged setup does not reconfirm against a busy session', async () => {
  const { context, manifest, api, calls } = fixture(['processing']); context.createAttempted = true; context.planKnown = true; manifest.summary.status = 'ready';
  await prepareAudioPlan(api, context, { resume: true, revision: 3 });
  assert.equal(calls.some(c => c.method === 'POST'), false, 'Only local reads before exact-count speech consent');
  let polled = 0;
  await generateAudioClips(async (path, options) => {
    if (path.includes('/clips/')) { assert.notEqual(options?.method, 'POST'); polled++; manifest.clips[0].status = 'complete'; }
    return api(path, options);
  }, context, { consent: true, retryFailed: true, pollOptions: { intervalMs: 0 } });
  assert.equal(polled, 1); assert.equal(calls.some(c => c.method === 'POST'), false);
});

test('speech requires explicit consent and skips complete clips', async () => {
  const { context, api, calls } = fixture(['complete', 'pending']);
  await prepareAudioPlan(api, context);
  await assert.rejects(generateAudioClips(api, context), /confirmation/);
  assert.equal(calls.some(c => c.path.includes('/clips/')), false);
  await generateAudioClips(api, context, { consent: true });
  const speech = calls.filter(c => c.path.includes('/clips/') && c.method === 'POST');
  assert.equal(speech.length, 1); assert.match(speech[0].path, /clip-1$/);
  assert.equal(speech[0].body.retry, false); assert.equal(speech[0].body.expectedSetupRevision, 3);
  assert.match(speech[0].body.attemptId, /^[a-f0-9-]{36}$/);
});

test('HTTP 200 failed state stops immediately; explicit resumed retry uses a NEW attempt ID', async () => {
  const { context, manifest, api, calls } = fixture(); await prepareAudioPlan(api, context);
  let fail = true; const attempts = [];
  const transport = async (path, options = {}) => {
    if (path.includes('/clips/') && options.method === 'POST') {
      attempts.push(options.body);
      if (fail) { manifest.clips[0].status = 'failed'; return structuredClone({ clip: manifest.clips[0], summary: manifest.summary }); }
    }
    return api(path, options);
  };
  await assert.rejects(generateAudioClips(transport, context, { consent: true }), /did not complete/);
  assert.equal(attempts.length, 1);
  await assert.rejects(generateAudioClips(transport, context, { consent: true }), /renewed consent/);
  assert.equal(attempts.length, 1);
  fail = false;
  await generateAudioClips(transport, context, { consent: true, retryFailed: true });
  assert.equal(attempts[1].retry, true); assert.notEqual(attempts[0].attemptId, attempts[1].attemptId);
  assert.equal(context.manifest.summary.completedClips, 2);
  assert.equal(calls.some(c => c.path === '/lessons'), false);
});

test('unknown transport outcome never replays automatically; later consent checks status first', async () => {
  const { context, api, calls } = fixture(); await prepareAudioPlan(api, context);
  let attempts = 0;
  const transport = async (path, options = {}) => {
    if (path.includes('/clips/') && options.method === 'POST') { attempts++; throw new Error('Unknown outcome'); }
    return api(path, options);
  };
  await assert.rejects(generateAudioClips(transport, context, { consent: true }), /Unknown outcome/);
  assert.equal(attempts, 1); const previousId = context.attempts[0].attemptId;
  calls.length = 0;
  await prepareAudioPlan(api, context, { resume: true, revision: 3 });
  assert.equal(calls[0].path, '/audio/plans/plan-1');
  await generateAudioClips(api, context, { consent: true, retryFailed: true });
  assert.notEqual(context.attempts[1].attemptId, previousId);
});

test('pending/queued response is not mistaken for success and is not automatically replayed', async () => {
  const { context, api } = fixture(); await prepareAudioPlan(api, context); let posts = 0;
  const transport = async (path, options = {}) => {
    if (path.includes('/clips/') && options.method === 'POST') { posts++; return { clip: context.manifest.clips[0], summary: context.manifest.summary }; }
    return api(path, options);
  };
  await assert.rejects(generateAudioClips(transport, context, { consent: true }), /did not complete/);
  assert.equal(posts, 1);
});

test('processing polls only local GETs; polling is bounded and abort-aware', async () => {
  const { context, api, calls } = fixture(['processing']); await prepareAudioPlan(api, context); calls.length = 0;
  await assert.rejects(pollAudioClip(api, context, context.manifest.clips[0], { maxPolls: 2, intervalMs: 0 }), /still processing/);
  assert.equal(calls.length, 2); assert.ok(calls.every(c => !c.method));
  assert.equal(audioExportable(context), false);
  const controller = new AbortController(); controller.abort(); calls.length = 0;
  await assert.rejects(pollAudioClip(api, context, context.manifest.clips[0], { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(calls.length, 0);
});

test('failed polling outcome never automatically retries even with prior resume consent', async () => {
  const { context, api } = fixture(['processing']); await prepareAudioPlan(api, context); let posts = 0;
  const transport = async (path, options = {}) => {
    if (path.includes('/clips/')) { if (options.method === 'POST') posts++; return { clip: { ...context.manifest.clips[0], status: 'failed' }, summary: context.manifest.summary }; }
    return api(path, options);
  };
  await assert.rejects(generateAudioClips(transport, context, { consent: true, retryFailed: true, pollOptions: { intervalMs: 0 } }), /Confirm Continue audio again/);
  assert.equal(posts, 0);
});

test('missing known plan (restart/expired session) is never recreated', async () => {
  const { context } = fixture(); context.createAttempted = true; context.planKnown = true; const calls = [];
  const api = async (path, options = {}) => { calls.push({ path, ...options }); throw Object.assign(new Error('Not found'), { status: 404 }); };
  await assert.rejects(prepareAudioPlan(api, context, { resume: true }), /server may have restarted/);
  assert.equal(context.unavailable, true); assert.equal(calls.length, 1); assert.equal(calls[0].method, undefined);
});

test('setup identity conflict stops before sources, sealing or speech', async () => {
  const { context, api, calls } = fixture(); context.createAttempted = true;
  const transport = async (path, options) => {
    if (path.endsWith('/reconfirm')) throw Object.assign(new Error('Speech identity changed'), { status: 409 });
    return api(path, options);
  };
  await assert.rejects(prepareAudioPlan(transport, context, { resume: true, revision: 4 }), /identity changed/);
  assert.equal(context.revision, 3); assert.equal(calls.length, 1);
});

test('local export checks current status; only returned complete HTML permits cleanup', async () => {
  const { context, manifest, api, calls } = fixture(['complete']); await prepareAudioPlan(api, context);
  manifest.summary.status = 'complete'; calls.length = 0;
  const result = await exportAudioPlan(api, context);
  assert.match(result.html, /Retained/); assert.equal(context.exportedComplete, true);
  assert.deepEqual(calls.map(c => c.path), ['/audio/plans/plan-1', '/audio/plans/plan-1/export']);
  context.exportedComplete = false; manifest.clips[0].status = 'processing';
  await assert.rejects(exportAudioPlan(api, context), /still collecting or processing/);
  assert.equal(context.exportedComplete, false);
});

test('export integrity downgrade is reflected in retained progress, not claimed complete', async () => {
  const { context, manifest, api } = fixture(['complete']); await prepareAudioPlan(api, context);
  manifest.summary.status = 'complete';
  const transport = async (path, options) => path.endsWith('/export')
    ? { html: '<p>Damaged clip omitted</p>', audioSummary: { ...manifest.summary, status: 'partial', completedClips: 0 } }
    : api(path, options);
  await exportAudioPlan(transport, context);
  assert.equal(context.exportedComplete, false);
  assert.equal(context.manifest.summary.status, 'partial');
  assert.equal(context.manifest.summary.completedClips, 0);
});

test('400/413 local creation rejection can be retried only by explicit resume with the same ID', async () => {
  for (const status of [400, 413]) {
    const { context, api, calls } = fixture(); let rejected = true; const creationIds = [];
    const transport = async (path, options = {}) => {
      if (path === '/audio/plans') {
        creationIds.push(options.body.id);
        if (rejected) throw Object.assign(new Error('Local quota/validation failure'), { status });
      }
      if (path === '/audio/plans/plan-1' && !context.planKnown) throw Object.assign(new Error('Not found'), { status: 404 });
      return api(path, options);
    };
    await assert.rejects(prepareAudioPlan(transport, context), /quota/);
    assert.equal(context.planKnown, false); assert.equal(context.attempts.length, 0);
    // Even catch-path local export/status does not poison this never-created context.
    await assert.rejects(exportAudioPlan(transport, context), /No audio plan was received/);
    assert.equal(context.unavailable, false);
    rejected = false;
    await assert.rejects(prepareAudioPlan(transport, context), /No audio plan was received/);
    assert.equal(creationIds.length, 1);
    await prepareAudioPlan(transport, context, { resume: true, revision: 3 });
    assert.deepEqual(creationIds, ['plan-1', 'plan-1']); assert.equal(context.planKnown, true);
    assert.equal(calls.some(c => c.path === '/lessons' || c.path.includes('/clips/') || c.path === '/audio/extract'), false);
  }
});

test('unknown local creation outcome checks GET before retrying and never duplicates a known plan', async () => {
  for (const accepted of [false, true]) {
    const { context, api } = fixture(); const calls = []; let first = true, exists = false;
    const transport = async (path, options = {}) => {
      calls.push({ path, ...options });
      if (path === '/audio/plans') {
        if (first) { first = false; exists = accepted; throw new Error('Unknown network outcome'); }
        exists = true;
      }
      if (path === '/audio/plans/plan-1' && !exists) throw Object.assign(new Error('Missing'), { status: 404 });
      return api(path, options);
    };
    await assert.rejects(prepareAudioPlan(transport, context), /Unknown network/);
    const start = calls.length;
    await prepareAudioPlan(transport, context, { resume: true, revision: 3 });
    assert.equal(calls[start].path, '/audio/plans/plan-1'); assert.equal(calls[start].method, undefined);
    assert.equal(calls.filter(c => c.path === '/audio/plans').length, accepted ? 1 : 2);
    assert.equal(calls.some(c => c.path.includes('/clips/')), false);
  }
});

test('uncreated plan cannot adopt a new setup revision, even without speech attempts', async () => {
  const { context } = fixture(); context.createAttempted = true; const calls = [];
  const api = async (path, options = {}) => { calls.push({ path, ...options }); throw Object.assign(new Error('Missing'), { status: 404 }); };
  await assert.rejects(prepareAudioPlan(api, context, { resume: true, revision: 4 }), /cannot be rebound safely/);
  assert.equal(calls.length, 1); assert.equal(calls[0].method, undefined);
  assert.equal(context.revision, 3); assert.equal(context.unavailable, false);
});

test('any speech attempt prevents recreation even if no plan-known flag was retained', async () => {
  const { context } = fixture(); context.createAttempted = true; context.attempts.push({ attemptId: 'unknown' });
  const calls = []; const api = async (path, options = {}) => { calls.push({ path, ...options }); throw Object.assign(new Error('Missing'), { status: 404 }); };
  await assert.rejects(prepareAudioPlan(api, context, { resume: true }), /server may have restarted/);
  assert.equal(context.unavailable, true); assert.equal(calls.length, 1); assert.equal(calls[0].method, undefined);
});

test('successful creation acknowledgement prevents recreation if subsequent GET loses the plan', async () => {
  const { context } = fixture(); let creates = 0;
  const api = async path => { if (path === '/audio/plans') { creates++; return {}; } throw Object.assign(new Error('Missing'), { status: 404 }); };
  await assert.rejects(prepareAudioPlan(api, context), /server may have restarted/);
  assert.equal(context.planKnown, true);
  await assert.rejects(prepareAudioPlan(api, context, { resume: true }), /cannot resume/);
  assert.equal(creates, 1);
});

test('retention stays at two and blocks eviction of unfinished or expired audio', () => {
  const history = [];
  for (let n = 0; n < 50; n++) retainLesson(history, { html: 'HTML ' + n });
  assert.deepEqual(history.map(lesson => lesson.html), ['HTML 48', 'HTML 49']);
  const { context } = fixture(); history[0].audio = context;
  assert.equal(lessonRetentionBlocker(history), history[0]);
  assert.throws(() => retainLesson(history, { html: 'Third' }), /finish or explicitly discard/);
  context.unavailable = true;
  assert.equal(unfinishedAudio(context), true);
  assert.throws(() => retainLesson(history, { html: 'Third' }), /unfinished audio/);
  assert.equal(history.length, 2); assert.equal(context.sources.length, 2);
  context.discarded = true; retainLesson(history, { html: 'Third' });
  assert.deepEqual(history.map(lesson => lesson.html), ['HTML 49', 'Third']);
});

test('completed snapshots can be released while retained HTML and summary stay intact', () => {
  const { context, manifest } = fixture(['complete']); context.exportedComplete = true; context.manifest = manifest;
  const lesson = { html: '<p>Full offline HTML</p>', audioSummary: manifest.summary, audio: context };
  releaseAudioSnapshots(context);
  assert.deepEqual(context.sources, []); assert.equal(context.input, null); assert.equal(context.result, null);
  assert.equal(lesson.html, '<p>Full offline HTML</p>'); assert.equal(lesson.audioSummary, manifest.summary);
  const history = [lesson, { html: 'Second' }]; retainLesson(history, { html: 'Third' });
  assert.equal(history.length, 2);
});

test('discard requires confirmation, deletes locally with JSON, and never exports/generates', async () => {
  const { context } = fixture(); context.createAttempted = true;
  const lesson = { html: 'Last retained partial HTML', audio: context }, calls = [];
  const api = async (path, options) => { calls.push({ path, ...options }); return {}; };
  await assert.rejects(discardAudioContext(api, context), /confirmation/); assert.equal(calls.length, 0);
  await discardAudioContext(api, context, { consent: true });
  assert.deepEqual(calls, [{ path: '/audio/plans/plan-1', method: 'DELETE', body: {}, signal: undefined }]);
  assert.equal(context.discarded, true); assert.equal(context.unavailable, true); assert.equal(context.input, null); assert.equal(context.result, null);
  assert.deepEqual(context.sources, []); assert.equal(lesson.html, 'Last retained partial HTML');
  assert.equal(unfinishedAudio(context), false);
});

test('explicit discard retires expired/missing and disconnected contexts without paid calls', async () => {
  for (const status of [401, 403, 404]) {
    const { context } = fixture(); context.createAttempted = true; context.unavailable = true;
    const calls = [];
    await discardAudioContext(async (path, options) => { calls.push({ path, ...options }); throw Object.assign(new Error('Expired'), { status }); }, context, { consent: true });
    assert.equal(calls.length, 1); assert.equal(calls[0].method, 'DELETE'); assert.equal(context.discarded, true); assert.deepEqual(context.sources, []);
  }
  const { context } = fixture(); context.createAttempted = true; context.unavailable = true;
  await discardAudioContext(() => assert.fail('No request while disconnected'), context, { consent: true, canContact: false });
  assert.equal(context.discarded, true); assert.match(context.notice, /cleanup could not be confirmed/);
});

test('busy cleanup failure preserves unfinished source/input snapshots and retention block', async () => {
  const { context } = fixture(); context.createAttempted = true;
  await assert.rejects(discardAudioContext(async () => { throw Object.assign(new Error('Still running'), { status: 409 }); }, context, { consent: true }), /Still running/);
  assert.equal(context.discarded, false); assert.equal(context.sources.length, 2); assert.ok(context.input); assert.ok(context.result);
  assert.equal(unfinishedAudio(context), true);
});

test('session authorization failure disables continuation without provider calls', async () => {
  const { context } = fixture();
  await assert.rejects(readAudioPlan(async () => { throw Object.assign(new Error('Expired'), { status: 401 }); }, context), /Expired/);
  assert.equal(context.unavailable, true);
});
