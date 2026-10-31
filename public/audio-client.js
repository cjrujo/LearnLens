// Session-only complete audio orchestration. No preparation, teaching or automatic paid retries.
export const RETRYABLE_AUDIO = new Set(['failed', 'encoding_failed', 'damaged']);
const stopped = () => new DOMException('Audio stopped. Text and completed clips are retained.', 'AbortError');
function check(signal) { if (signal?.aborted) throw stopped(); }
export function audioPath(context) { return '/audio/plans/' + encodeURIComponent(context.id); }
export function createAudioContext({ sources, approvedSetup, input, result, id = crypto.randomUUID() }) {
  return { id, sources, approvedSetup: structuredClone(approvedSetup), revision: approvedSetup.revision,
    input, result, createAttempted: false, planKnown: false, manifest: null, unavailable: false, discarded: false, exportedComplete: false, paused: false,
    operation: 'Text retained; audio not started.', notice: '', attempts: [] };
}
export function unfinishedAudio(context) { return Boolean(context && !context.exportedComplete && !context.discarded); }
export function lessonRetentionBlocker(history) { return history.length >= 2 && unfinishedAudio(history[0].audio) ? history[0] : null; }
export function retainLesson(history, lesson) {
  if (lessonRetentionBlocker(history)) throw new Error('The oldest retained lesson has unfinished audio. Switch previous lesson and finish or explicitly discard its remaining audio first.');
  history.push(lesson);
  while (history.length > 2) history.shift();
}
export function releaseAudioSnapshots(context) {
  context.sources = []; context.input = null; context.result = null;
  context.sourcePending = false; context.sourceMaterials = null;
}
export async function discardAudioContext(api, context, { consent = false, canContact = true, signal } = {}) {
  if (!consent) throw new Error('Explicit discard confirmation is required.');
  if (context.discarded) return;
  let serverRemoved = !context.createAttempted;
  if (context.createAttempted && canContact) {
    try { await api(audioPath(context), { method: 'DELETE', body: {}, signal }); serverRemoved = true; }
    catch (error) {
      if (![401, 403, 404].includes(error.status)) throw error; // A running/busy plan is not safe to drop.
      serverRemoved = true;
    }
  }
  context.discarded = true; context.unavailable = true; context.paused = false;
  releaseAudioSnapshots(context); context.attempts = [];
  context.operation = 'Remaining audio discarded; retained HTML unchanged';
  context.notice = 'Audio continuation and source snapshots were discarded. Your current HTML is unchanged; no export or paid request was made.' + (serverRemoved ? '' : ' Server cleanup could not be confirmed while disconnected/locked; its temporary plan may remain until session expiry.');
}
export function audioIdle(manifest) { return Boolean(manifest && !manifest.clips.some(clip => clip.status === 'processing')); }
export function audioExportable(context) {
  return !context.unavailable && audioIdle(context.manifest) && context.manifest.summary.status !== 'collecting';
}
export async function readAudioPlan(api, context, signal) {
  check(signal);
  try { context.manifest = await api(audioPath(context), { signal }); context.planKnown = true; return context.manifest; }
  catch (error) {
    if ([401, 403].includes(error.status) || (error.status === 404 && (context.planKnown || context.attempts.length))) {
      context.unavailable = true;
      if (error.status === 404) error.message = 'This audio plan is no longer available (the server may have restarted or the session expired). Your retained HTML is still available. Audio cannot resume; nothing will be regenerated automatically.';
    } else if (error.status === 404) {
      error.message = 'No audio plan was received and no speech attempt was started. Continue audio can explicitly retry local creation with the same ID and original approved setup; teaching and preparation will not repeat.';
    }
    throw error;
  }
}
export async function prepareAudioPlan(api, context, { resume = false, revision = context.revision, signal, changed = () => {} } = {}) {
  check(signal);
  if (context.discarded || context.unavailable) throw new Error('This audio context cannot resume. Keep its retained HTML or explicitly discard remaining audio.');
  if (context.sourcePending) throw new Error('Finish the original audio-source inventory before creating a speech plan. No source was silently omitted.');
  const path = audioPath(context);
  let exists = false;
  if (context.createAttempted || context.planKnown || context.attempts.length) {
    // Unknown creation outcomes are resolved locally first. Known lost plans are NEVER recreated.
    try { await readAudioPlan(api, context, signal); exists = true; }
    catch (error) {
      if (!(resume && error.status === 404 && !context.planKnown && context.attempts.length === 0)) throw error;
    }
  }
  if (exists) {
    // An unchanged revision is already bound to this plan. Avoid a write while
    // an old request is running; exact-count consent precedes read-only polling.
    if (resume && revision !== context.manifest.setupRevision) {
      for (const clip of [...context.manifest.clips].filter(item => item.status === 'processing')) {
        context.operation = 'Waiting for already submitted speech (local status checks only)'; changed();
        await pollAudioClip(api, context, clip, { signal, changed });
      }
      await api(path + '/reconfirm', { method: 'POST', body: { consent: true, expectedSetupRevision: revision }, signal });
      context.revision = revision;
      await readAudioPlan(api, context, signal);
    }
    if (resume) context.revision = revision;
  } else {
    // There is no authoritative plan identity to compare: do not silently rebind to a new setup.
    if (revision !== context.approvedSetup.revision) throw new Error('AI setup changed since the original approval. This uncreated audio plan cannot be rebound safely. The original approved revision is no longer current; explicitly discard remaining audio to retire this context. No teaching or speech was repeated.');
    context.createAttempted = true;
    const { input, result } = context;
    context.manifest = await api('/audio/plans', { method: 'POST', body: { id: context.id, lesson: result.lesson,
      images: input.images, sourceText: input.text, warnings: result.warnings,
      expectedSources: context.sources.map(source => source.key), expectedSetupRevision: context.revision }, signal });
    context.planKnown = true; // Even a successful creation acknowledgement proves the plan existed.
    await readAudioPlan(api, context, signal);
  }
  check(signal); changed();
  if (context.manifest.summary.status === 'collecting') {
    const received = new Set(context.manifest.sourceKeys);
    for (const source of context.sources) {
      check(signal);
      if (received.has(source.key)) continue;
      context.operation = `Storing source ${received.size + 1} of ${context.sources.length} locally`; changed();
      await api(path + '/sources', { method: 'POST', body: { source }, signal });
      received.add(source.key);
    }
    check(signal);
    context.operation = 'Building the complete word and sentence inventory locally'; changed();
    context.manifest = await api(path + '/seal', { method: 'POST', body: {}, signal });
  }
  changed(); return context.manifest;
}
function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    check(signal);
    const abort = () => { clearTimeout(timer); reject(stopped()); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}
function mergeClip(context, result) {
  const index = context.manifest.clips.findIndex(clip => clip.id === result.clip.id);
  if (index < 0) throw new Error('Unexpected audio status. No further speech requests were sent.');
  context.manifest.clips[index] = result.clip;
  context.manifest.summary = result.summary;
  return result.clip;
}
export async function pollAudioClip(api, context, clip, { signal, changed = () => {}, maxPolls = 120, intervalMs = 1500 } = {}) {
  for (let count = 0; clip.status === 'processing' && count < maxPolls; count++) {
    await delay(intervalMs, signal); check(signal);
    const timeout = AbortSignal.timeout(10000);
    const pollSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    clip = mergeClip(context, await api(audioPath(context) + '/clips/' + encodeURIComponent(clip.id), { signal: pollSignal }));
    changed();
  }
  if (clip.status === 'processing') throw new Error('Audio is still processing on the server. Local status polling stopped; use Continue audio later. No request has been replayed.');
  return clip;
}
export async function generateAudioClips(api, context, { consent = false, retryFailed = false, signal, changed = () => {}, pollOptions = {} } = {}) {
  if (!consent) throw new Error('Explicit speech confirmation is required.');
  // Take one snapshot. A failure in this run never becomes a retry in the same run.
  // Resolve in-flight work and retained successful speech BEFORE damaged earlier
  // clips: the server permits only one raw result awaiting local encoding.
  const priority = clip => clip.status === 'processing' ? 0 : clip.status === 'encoding_failed' ? 1 : 2;
  const clips = [...context.manifest.clips].sort((a, b) => priority(a) - priority(b));
  for (let clip of clips) {
    check(signal);
    if (clip.status === 'complete') continue;
    if (clip.status === 'processing') {
      context.operation = 'Checking an existing speech operation locally'; changed();
      clip = await pollAudioClip(api, context, clip, { ...pollOptions, signal, changed });
      if (clip.status === 'complete') continue;
      throw new Error('The previous operation did not complete. Confirm Continue audio again before any new attempt.');
    }
    const retry = RETRYABLE_AUDIO.has(clip.status);
    if (clip.status !== 'pending' && !(retry && retryFailed)) throw new Error('A clip needs renewed consent. Use Continue audio; no automatic retry was made.');
    const attemptId = crypto.randomUUID();
    context.attempts.push({ attemptId, clipId: clip.id });
    context.operation = `Speech generation · ${context.manifest.summary.completedClips}/${context.manifest.summary.totalClips} clips complete`; changed();
    const result = await api(audioPath(context) + '/clips/' + encodeURIComponent(clip.id), { method: 'POST',
      body: { consent: true, expectedSetupRevision: context.revision, attemptId, retry }, signal });
    clip = mergeClip(context, result); changed();
    clip = await pollAudioClip(api, context, clip, { ...pollOptions, signal, changed });
    if (clip.status !== 'complete') throw new Error('Audio did not complete. Text and earlier clips are retained. A failed or unknown request may still be billable; confirm Continue audio before another attempt.');
  }
  check(signal); await readAudioPlan(api, context, signal); changed();
}
export async function exportAudioPlan(api, context, signal) {
  await readAudioPlan(api, context, signal);
  if (!audioExportable(context)) throw new Error('Audio is still collecting or processing. Keep the retained HTML and try a local export later.');
  const result = await api(audioPath(context) + '/export', { signal });
  if (typeof result.html !== 'string') throw new Error('The local audio export did not return HTML. Your prior download is unchanged.');
  // Export can discover damaged files and downgrade a formerly complete plan.
  if (result.audioSummary) context.manifest.summary = result.audioSummary;
  context.exportedComplete = result.audioSummary?.status === 'complete';
  return result;
}
