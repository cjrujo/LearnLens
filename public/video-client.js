// Native-video transport: immutable server plans and receipts, never browser media bytes.
export const DEFAULT_VIDEO_FPS = 24;
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const round = value => Math.round(value * 1e6) / 1e6;
const failure = (message, receipt) => Object.assign(new Error(message), { stage: 'video_analysis', ...(receipt?.diagnostics ? { diagnostics: receipt.diagnostics } : {}) });
const invalid = () => new Error('The native-video receipt is incomplete or does not match this snapshot. No replacement analysis was requested.');

export function videoFps(role) {
  const fps = role?.fps ?? DEFAULT_VIDEO_FPS;
  if (!Number.isFinite(fps) || fps < 1 || fps > 24) throw new Error('Video sampling must be between 1 and 24 FPS. Start a new generation after changing FPS.');
  return fps;
}

export function waitForVideoPoll(signal) {
  return new Promise((resolve, reject) => {
    const aborted = () => { clearTimeout(timer); signal?.removeEventListener('abort', aborted); reject(new DOMException('Stopped.', 'AbortError')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', aborted); resolve(); }, 750);
    if (signal?.aborted) aborted(); else signal?.addEventListener('abort', aborted, { once: true });
  });
}

export function validateVideoAnalysis(result, { start, end, fps, hasAudio } = {}) {
  if (!result || result.version !== 1 || !hex(result.videoSha256) || !Number.isFinite(result.start) || !Number.isFinite(result.end) || result.start < 0 || result.end <= result.start || result.end - result.start > 30.5 || result.end > 14400 || !Number.isFinite(result.fps) || result.fps < 1 || result.fps > 24 || result.coverageBasis !== 'model_reported') throw invalid();
  if ((start !== undefined && result.start !== start) || (end !== undefined && result.end !== end) || (fps !== undefined && result.fps !== fps)) throw invalid();
  const safe = text => typeof text === 'string' && text.isWellFormed() && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text);
  const duration = round(result.end - result.start);
  if (!Array.isArray(result.windows) || result.windows.length !== Math.ceil(duration / 5) || !Array.isArray(result.warnings) || result.warnings.length > 11 || result.warnings.some(w => !safe(w) || !w.trim() || w.length > 500)) throw invalid();
  let chars = 0, uncertain = 0;
  for (const [index, window] of result.windows.entries()) {
    if (!window || window.start !== index * 5 || window.end !== Math.min(duration, index * 5 + 5)) throw invalid();
    for (const key of ['transcript', 'visibleText', 'observations']) {
      if (!safe(window[key]) || window[key].length > 10000) throw invalid();
      chars += window[key].length;
    }
    if (chars > 40000 || !window.observations.trim() || !['complete', 'uncertain'].includes(window.visualCoverage) || !['complete', 'uncertain', 'no_speech', 'no_audio'].includes(window.audioCoverage)) throw invalid();
    if ((window.audioCoverage === 'complete' && !window.transcript.trim()) || (['no_audio', 'no_speech'].includes(window.audioCoverage) && window.transcript !== '')) throw invalid();
    if ((hasAudio === true && window.audioCoverage === 'no_audio') || (hasAudio === false && window.audioCoverage !== 'no_audio')) throw invalid();
    if ((window.sourceStart !== undefined && round(window.sourceStart) !== round(result.start + window.start)) || (window.sourceEnd !== undefined && round(window.sourceEnd) !== round(result.start + window.end))) throw invalid();
    if (window.audioCoverage === 'uncertain' || window.visualCoverage === 'uncertain') uncertain++;
  }
  if (result.uncertainWindows !== uncertain) throw invalid();
  return result;
}

// Preserve ALL source windows before any separately labelled, lossy lesson digest.
export function videoSourceNotes(result) {
  validateVideoAnalysis(result);
  return result.windows.map(window => `[${round(result.start + window.start)}–${round(result.start + window.end)}s; speech coverage: ${window.audioCoverage}; visual coverage: ${window.visualCoverage}]\nRecognized original speech:\n${window.transcript}\nRecognized original screen text:\n${window.visibleText}\nDerived visual observations (not original quoted text):\n${window.observations}`).join('\n\n');
}

export function validateVideoPlan(plan, expected) {
  if (!plan || !hex(plan.id) || plan.materialId !== expected.materialId || plan.snapshotId !== expected.snapshotId || plan.fps !== expected.fps || plan.profileVersion !== 1 || !Number.isFinite(plan.duration) || plan.duration <= 0 || plan.duration > 14400 || !Array.isArray(plan.clips) || !plan.clips.length || plan.clips.length !== expected.partCount || plan.summary?.totalClips !== plan.clips.length || plan.hasVideo !== true || typeof plan.hasAudio !== 'boolean' || plan.analysisMode !== 'whole-video') throw new Error('The native-video plan does not match the immutable material. Start a new generation; no analysis was requested.');
  if (expected.duration !== undefined && plan.duration !== expected.duration) throw invalid();
  if (expected.sourceHash !== undefined && plan.sourceHash !== expected.sourceHash) throw invalid();
  let end = 0;
  const ids = new Set();
  for (const [index, clip] of plan.clips.entries()) {
    if (!clip || !hex(clip.id) || ids.has(clip.id) || clip.index !== index || clip.start !== end || !Number.isFinite(clip.end) || clip.end <= clip.start || clip.end - clip.start > 30.5) throw invalid();
    ids.add(clip.id); end = clip.end;
  }
  if (end !== plan.duration) throw invalid();
  return plan;
}

export class VideoAnalysisClient {
  constructor({ api, wait = waitForVideoPoll }) { this.api = api; this.wait = wait; }
  async plan(expected, { signal, check = () => {} } = {}) {
    const path = '/materials/' + encodeURIComponent(expected.materialId) + '/video-plan';
    check(); let plan;
    try { plan = await this.api(path + '?fps=' + expected.fps, { signal }); }
    catch (error) {
      check(); if (error.status !== 404) throw error;
      plan = await this.api(path, { method: 'POST', body: { fps: expected.fps }, signal });
    }
    check(); validateVideoPlan(plan, expected);
    while (plan.summary.status === 'initializing') {
      await this.wait(signal); check();
      plan = await this.api('/video/plans/' + plan.id, { signal });
      check(); validateVideoPlan(plan, expected);
    }
    return plan;
  }
  async analyze({ plan, index, state = {}, role, consent, expectedSetupRevision, renewedConsent = false, signal, check = () => {}, beforeDispatch = () => {}, accept = result => result }) {
    const clip = plan.clips[index];
    if (!clip || !hex(plan.id) || !hex(clip.id)) throw invalid();
    const path = `/video/plans/${plan.id}/clips/${clip.id}`;
    const get = () => this.api(path, { signal });
    check();
    // ALWAYS consult the receipt before role validation, budget reservation or POST.
    let receipt = await get(), posted = false, repaired = false, observedProcessing = false;
    for (;;) {
      if (!receipt || receipt.id !== clip.id) throw invalid();
      if (receipt.status === 'complete') {
        const result = validateVideoAnalysis(receipt.result, { ...clip, fps: plan.fps, hasAudio: plan.hasAudio });
        // The workspace pins here BEFORE callbacks and an ordinary Stop check.
        const accepted = accept(result); check(); return accepted;
      }
      check();
      if (receipt.status === 'preparing' || receipt.status === 'processing' || (receipt.status === 'checkpoint_failed' && receipt.working === true)) {
        observedProcessing = true;
        if (receipt.attemptId) state.attemptId = receipt.attemptId;
        await this.wait(signal); check(); receipt = await get(); continue;
      }
      const repair = receipt.status === 'checkpoint_failed';
      const retry = receipt.status === 'failed' || receipt.status === 'damaged' || (receipt.status === 'pending' && Boolean(state.attemptId || receipt.attempts));
      if (!repair && receipt.status !== 'pending' && !retry) throw invalid();
      if (repair) {
        if (repaired || !receipt.attemptId) throw new Error('The accepted video result still needs local checkpoint repair. Continue to retry local storage only; no new analysis was requested.');
        repaired = true; posted = true; state.attemptId = receipt.attemptId;
      } else {
        if (posted || observedProcessing || (retry && !renewedConsent)) throw failure('Video analysis failed or its outcome is unknown. Review status and explicitly Continue with renewed consent before a new attempt. No automatic retry was made.', receipt);
        if (!consent || !Number.isInteger(expectedSetupRevision)) throw new Error('Confirm the current AI setup and paid consent before new video analysis.');
        if (!role || role.api !== 'gemini') throw new Error('Assign a compatible Gemini-native video role for unfinished clips. Speech-to-text and image support are not video compatibility.');
        if (videoFps(role) !== plan.fps) throw new Error('Video FPS changed. Start a new generation to create a new plan; implicit resume is not allowed.');
        beforeDispatch(); check();
        state.attemptId = crypto.randomUUID(); posted = true;
      }
      const body = { consent: true, expectedSetupRevision, attemptId: state.attemptId, ...(!repair && retry ? { retry: true } : {}) };
      // A returned processing state is a background job, not a browser-owned request.
      // Lost acknowledgement is resolved ONLY by GET; never replay this POST.
      try { receipt = await this.api(path, { method: 'POST', body, signal }); }
      catch (error) {
        check();
        receipt = await get();
        if (receipt?.status === 'pending') {
          if (Number.isInteger(error.status)) throw error; // A known rejection is not a lost acknowledgement.
          throw failure('Video attempt acknowledgement is unknown. No POST was replayed. Check status or explicitly Continue with renewed consent.', receipt);
        }
      }
    }
  }
}
