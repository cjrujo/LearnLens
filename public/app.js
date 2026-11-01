import { MaterialWorkspace } from './materials.js';
import { audioDecision } from './audio-policy.js';
import { createAudioContext, prepareAudioPlan, generateAudioClips, exportAudioPlan, audioExportable, audioPath, RETRYABLE_AUDIO, lessonRetentionBlocker, retainLesson, releaseAudioSnapshots, discardAudioContext, unfinishedAudio } from './audio-client.js';

const $ = id => document.getElementById(id);
const $$ = selector => [...document.querySelectorAll(selector)];
const token = document.querySelector('meta[name="learnlens-token"]').content;
const EMPTY = { primary: null, transcription: null, video: null, speech: null };
let state = { providers: [], roles: { ...EMPTY }, locked: false };
let ready = false, busy = false, settingsBusy = false, page = 'lesson';
let currentLesson = null, downloadUrl = '', lastRequest = null, clock = null;
const lessonHistory = [];
let activeAudio = null, generationCheckpoint = null;
let roleDrafts = { ...EMPTY }, roleViews = {};
let editingProviderId = null, recommendations = null;
let recording = null, micStream = null, recordTimer = null, micPending = false;
let sessionEpoch = 0, confirming = false, generationController = null;
const materials = new MaterialWorkspace({ list: $('material-list'), api, changed: () => updateStatus(), confirmUrlImport });
function cancelWork(session = false) { sessionEpoch++; generationController?.abort(); materials.cancelPending({ session }); if (session) { if (generationCheckpoint) { generationCheckpoint.unavailable = true; generationCheckpoint.prepared = null; } for (const lesson of lessonHistory) if (lesson.audio) { lesson.audio.unavailable = true; lesson.audio.notice = 'Session changed. Retained HTML is available, but this audio plan cannot resume.'; } } }
let toastTimer;

function element(tag, text, className) { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; }
function icon(name) { const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('class', 'icon'); svg.setAttribute('aria-hidden', 'true'); const use = document.createElementNS(svg.namespaceURI, 'use'); use.setAttribute('href', '#i-' + name); svg.append(use); return svg; }
function message(id, text = '', type = '') { const node = typeof id === 'string' ? $(id) : id; node.textContent = text; node.classList.add('inline-message'); node.classList.remove('error', 'warning'); if (type) node.classList.add(type); node.hidden = !text; }
function toast(text) { $('toast-message').textContent = text; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 5000); }
function announce(text) { $('announcer').textContent = text; }
function providerFor(role) { return state.providers.find(p => p.id === role?.providerId); }
function chosenSubject() { return $('subject').value === 'custom' ? $('custom-subject').value.trim() : 'Auto'; }
function chosenLanguage() { return $('language').value === 'custom' ? $('custom-language').value.trim() : $('language').value; }
function pendingAudioSources() { return lessonHistory.find(lesson => lesson.audio?.sourcePending && !lesson.audio.discarded); }
function approvedAudioSetup() { return { revision: state.setupRevision, roles: structuredClone(state.roles), speechProvider: providerFor(state.roles.speech)?.name || 'Built-in Kokoro' }; }
function duration(seconds) { return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`; }
function transcriptionMode(role) { return role?.api === 'gemini' ? 'Gemini-native audio (generateContent)' : 'OpenAI multipart (/audio/transcriptions)'; }
function primaryWait(role) { return `Primary request wait: ${role?.timeoutSeconds ?? 300} seconds per provider request. Providers/proxies may stop sooner; no automatic timeout retry.`; }
function videoDisclosure(roles) {
  if (!materials.items.some(item => item.manifest?.analysisMode === 'whole-video')) return '';
  const role = roles.video;
  return '\nNative video: ' + (providerFor(role)?.name || 'Not configured') + ' / ' + (role?.model || 'required for unfinished video') +
    '\nGemini-native audiovisual input; requested sampling ' + (role?.fps ?? 24) + ' fps, frozen per source plan; ' + (role?.timeoutSeconds ?? 300) + ' seconds per request.' +
    '\nEvery chronological clip must finish before teaching. Full-duration copies may be resized/re-encoded; source quality and model sampling can miss fine text, frames, speech or motion. Coverage is model-reported, not certified. Long videos and higher sampling can incur many billable calls. Accepted video results are reused for English audio without separate STT or still OCR.';
}
function checkOf(role, kind) {
  const check = role?.engine === 'kokoro' ? state.speechServices?.kokoro?.checks?.[role.voice] : providerFor(role)?.checks?.[role?.model]?.[kind];
  if (kind === 'video' && (check?.api !== role?.api || check?.fps !== role?.fps)) return null;
  if (!check || (['text', 'vision'].includes(kind) && (check.api !== role?.api || (check.reasoningEffort || 'default') !== (role?.reasoningEffort || 'default') || (check.timeoutSeconds ?? 300) !== (role?.timeoutSeconds ?? 300))) || (kind === 'speech' && check.voice !== (role?.voice || 'alloy')) || (kind === 'transcription' && (check.api === 'gemini') !== (role?.api === 'gemini'))) return null;
  return check;
}

// Metadata-only, per-attempt activity; never retain request bodies, filenames or credentials.
let lessonTrace = null;
// Lookup keys remain private; reports contain only normalized endpoint templates.
const videoActivity = new Map();
const tracePanel = element('details'), traceTitle = element('summary', 'Request activity & safe diagnostics');
tracePanel.id = 'lesson-diagnostics'; tracePanel.className = 'guide-card'; tracePanel.hidden = true;
const traceStatus = element('p'), traceHint = element('p'), traceOutput = element('pre'), traceCopy = element('button', 'Copy safe report');
traceStatus.id = 'diagnostic-status'; traceHint.id = 'diagnostic-hint'; traceHint.className = 'field-hint';
traceOutput.id = 'diagnostic-report'; traceOutput.className = 'material-text-preview'; traceOutput.tabIndex = 0;
traceCopy.id = 'copy-diagnostics'; traceCopy.type = 'button'; traceCopy.className = 'btn secondary small';
tracePanel.append(traceTitle, traceStatus, traceHint, traceOutput, traceCopy,
  element('p', 'Current attempt only; up to 520 operations. Keys, request/response bodies, instructions and filenames are not collected. Provider/model labels are included—review before sharing. Reloading clears this report and the in-page preparation cache.', 'field-hint'));
$('preview-error').after(tracePanel);
traceStatus.style.overflowWrap = 'anywhere';
const stageLabel = value => ({ transcription: 'Transcribing audio', source_preparation: 'Preparing source notes', lesson_generation: 'Generating final lesson', source_recognition: 'Recognizing source text', speech_generation: 'Generating English audio', video_analysis: 'Analyzing whole-video clips' }[value] || value);
const traceStages = { '/transcribe': 'Transcribing audio', '/materials/summarize': 'Preparing source notes', '/lessons': 'Generating final lesson', '/audio/extract': 'source_recognition' };
// This private checkpoint contains source snapshots; diagnostics receive counts ONLY.
const generationPanel = element('section', undefined, 'guide-card'); generationPanel.id = 'generation-checkpoint'; generationPanel.hidden = true;
const generationSummary = element('p'), generationHint = element('p'), generationContinue = element('button', 'Continue generation', 'btn secondary small');
generationSummary.id = 'generation-checkpoint-summary'; generationHint.className = 'field-hint'; generationContinue.id = 'continue-generation'; generationContinue.type = 'button';
generationPanel.append(element('h3', 'Generation checkpoint'), generationSummary, generationHint, generationContinue); $('preview-error').after(generationPanel);
function materialSignature() { return JSON.stringify(materials.items.map(item => [item.id, item.snapshotId || item.manifest?.snapshotId || null, item.partCount])); }
function requestSignature(request) { return JSON.stringify([request.goal, request.language, request.level, request.subject, request.audioMode, request.includeAudio]); }
function checkpointMetadata() {
  const info = materials.checkpointInfo(), checkpoint = generationCheckpoint;
  return { phase: checkpoint?.lesson?.audio?.sourcePending ? 'audio_sources' : checkpoint?.phase || 'preparation', completedCalls: info.completedCalls || 0, completedParts: info.completedParts || 0, totalParts: info.totalParts || 0, preparationComplete: Boolean(checkpoint?.prepared || info.complete), audioSourceStarted: Boolean(info.audioSourceStarted), audioSourceComplete: Boolean(info.audioSourceComplete) };
}
function renderGenerationCheckpoint() {
  const checkpoint = generationCheckpoint;
  generationPanel.hidden = !checkpoint || checkpoint.phase === 'retained';
  if (!checkpoint || generationPanel.hidden) return;
  const info = checkpointMetadata(), mismatch = checkpoint.materials !== materialSignature();
  generationSummary.textContent = `${info.completedCalls} successful preparation call(s) retained · ${info.completedParts}/${info.totalParts} parts prepared. ` + (checkpoint.teachingResult ? 'Teaching is complete; Continue restores its received result locally.' : info.preparationComplete ? 'Source preparation is complete; only the final text-lesson request remains.' : 'Continue resumes the unfinished preparation step, not the beginning.');
  generationHint.textContent = checkpoint.unavailable ? 'This checkpoint cannot resume after a session change. Your draft/retained HTML remain; a new generation needs fresh consent.' : mismatch ? 'Attachments changed. Restore the saved attachment set to continue, or explicitly create a new lesson. No old checkpoint will be silently replayed.' : 'Saved on this page for this session only—do not reload. Continue uses the saved instructions/options and current confirmed AI settings for unfinished steps. Successful steps are reused, even if performed by a previous model. Failed/unknown requests may already have been billed; continuation always asks for consent.';
  generationContinue.hidden = !$('preview-error').hidden && lastRequest?.kind !== 'demo';
  generationContinue.disabled = busy || settingsBusy || confirming || materials.busy || !ready || state.locked || Boolean(recording) || micPending || checkpoint.unavailable || mismatch;
  if (lastRequest?.kind !== 'demo') { $('retry-preview').textContent = 'Continue generation'; $('retry-preview').disabled ||= generationContinue.disabled; }
  if (lessonTrace) lessonTrace.checkpoint = info;
}
function renderTrace() {
  if (!lessonTrace) return;
  const { roles, providers, part, ...report } = lessonTrace;
  const last = report.operations.at(-1), { operations, ...summary } = report;
  traceOutput.textContent = JSON.stringify({ ...summary, lastOperation: last, operations }, null, 2);
  traceStatus.textContent = `${report.status} · ${stageLabel(report.failedAt?.stage || last?.stage || 'Local preparation')}${last?.provider ? ` · ${last.provider} / ${last.model}` : ''}${last?.part ? ` · part ${last.part.current}/${last.part.total}` : ''}${last?.upstreamStatus ? ` · provider HTTP ${last.upstreamStatus}` : ''}${last?.timeoutMs ? ` · wait limit ${last.timeoutMs / 1000}s` : ''} · ${report.cachedResults} cached preparation result(s) retained`;
  traceHint.textContent = last?.category === 'timeout'
    ? `LearnLens reached its ${last.timeoutMs / 1000}-second waiting limit ${last.timeoutPhase === 'response_body' ? 'while reading the response body' : 'before receiving response headers'}. This does not explain the upstream delay or prove it stopped processing. Completed work is retained. ${last.role === 'primary' ? 'Changing the primary wait limit affects only unfinished requests after saving settings and confirming Continue.' : 'Transcription and speech have separate deadlines; the primary wait setting does not change them.'} A failed/unknown attempt may already have been billed.`
    : last?.category === 'preparation_validation'
    ? 'The provider returned text, but it did not satisfy the notes contract. The validation reason and counts below identify the rejected field without recording its contents. Completed checkpoints are retained; retrying requires confirmation and may be billable.'
    : last?.execution === 'local' ? 'This short text part was retained verbatim locally. No provider inference request was made for this preparation step.'
    : last?.providerCode === 'convert_request_failed'
    ? 'The gateway reported request conversion failure. Check its support for the selected endpoint/model, images/audio and thinking level. Give gateway support the provider request ID, if shown. This is not proof your files are invalid.'
    : last?.upstreamStatus >= 500 ? 'The upstream service returned a server error. This alone does not identify the cause. Check provider status/logs with the request ID before choosing another potentially billable attempt.'
    : 'Requests below are sent only after your confirmation. Successful preparation and completed audio clips are reused; failed or unknown paid calls are never automatically replayed. API Auto may try Chat only after Responses returns 404, 405 or 501. Audio progress counts completed clips, not estimated time.';
}
traceCopy.onclick = async () => {
  try { await navigator.clipboard.writeText(traceOutput.textContent); toast('Diagnostic metadata copied. Review provider/model labels before sharing.'); }
  catch { const selection = getSelection(), range = document.createRange(); range.selectNodeContents(traceOutput); selection.removeAllRanges(); selection.addRange(range); toast('Select and copy the diagnostic report manually.'); }
};
function beginTrace(approvedSetup, resume = false) {
  videoActivity.clear();
  lessonTrace = { version: 1, startedAt: new Date().toISOString(), status: resume ? 'Continuing from checkpoint' : 'Preparing', resumedFromCheckpoint: resume, cachedResults: materials.cache.size,
    roles: approvedSetup.roles, providers: state.providers.map(({ id, name }) => ({ id, name })), part: null, operations: [] };
  tracePanel.hidden = false; tracePanel.open = true; renderTrace();
  $('progress-footnote').textContent = 'Current app operation is shown below. Teaching and optional complete audio are separate; speech requires a second confirmation after the exact inventory is ready.';
}
function tracePart(current, total) {
  let index = current - 1;
  for (let n = 0; n < materials.items.length; n++) {
    const item = materials.items[n];
    if (index < item.partCount) return { current, total, material: n + 1, kind: item.kind, materialPart: index + 1, materialParts: item.partCount };
    index -= item.partCount;
  }
  return { current, total };
}
function operationStart(path, body, method) {
  const speech = /^\/audio\/plans\/[^/]+\/clips\/[^/]+$/.test(path) && method === 'POST';
  const video = /^\/video\/plans\/[a-f0-9]{64}\/clips\/[a-f0-9]{64}$/.test(path) && method === 'POST';
  if (!busy || !lessonTrace || (!speech && !video && !traceStages[path])) return null;
  const trace = lessonTrace, roleName = speech ? 'speech' : video ? 'video' : path === '/transcribe' ? 'transcription' : 'primary';
  const role = speech ? activeAudio?.approvedSetup.roles.speech : trace.roles[roleName];
  const entry = { number: (trace.operationCount = (trace.operationCount || 0) + 1), stage: speech ? 'speech_generation' : video ? 'video_analysis' : traceStages[path], role: roleName, part: speech || path === '/lessons' ? null : trace.part,
    startedAt: new Date().toISOString(), provider: trace.providers.find(p => p.id === role?.providerId)?.name || 'Configured provider', model: role?.model,
    apiMode: path === '/transcribe' ? (role?.api === 'gemini' ? 'gemini.generateContent' : 'audio/transcriptions') : role?.api, thinking: path === '/transcribe' ? undefined : role?.reasoningEffort || 'default',
    appEndpoint: speech ? '/audio/plans/{plan}/clips/{clip}' : video ? '/video/plans/{plan}/clips/{clip}' : path, status: 'Waiting', input: speech || video ? { clips: 1 } : path === '/audio/extract' ? { images: 1 } : { textCharacters: body?.text?.length || 0, images: body?.images?.length || 0,
      audioBytesApprox: body?.dataUrl ? Math.floor((body.dataUrl.split(',')[1]?.length || 0) * .75) : 0 } };
  if (video) { entry.apiMode = 'gemini.generateContent'; delete entry.thinking; }
  if (roleName === 'primary' || video) entry.timeoutMs = (role?.timeoutSeconds ?? 300) * 1000;
  if (speech) { entry.provider = role?.engine === 'kokoro' ? 'Built-in Kokoro' : activeAudio?.approvedSetup.speechProvider || 'Configured speech provider'; entry.apiMode = role?.engine === 'kokoro' ? 'local' : 'audio/speech'; delete entry.thinking; }
  if (trace.operations.length >= 520) trace.operations.shift();
  trace.operations.push(entry); $('progress-title').textContent = entry.stage + (entry.part ? ` · part ${entry.part.current} of ${entry.part.total}` : ''); renderTrace();
  const operation = { trace, entry, started: Date.now() };
  if (video) { operation.videoPath = path; videoActivity.set(path, operation); }
  return operation;
}
function operationFinish(operation, error, result) {
  if (!operation) return;
  const { trace, entry, started } = operation;
  if (operation.videoPath && !error && ['failed', 'damaged'].includes(result?.status)) error = { diagnostics: result.diagnostics || {} };
  entry.elapsedMs = Date.now() - started; entry.status = error ? error.name === 'AbortError' ? 'Stopped; upstream outcome unknown' : 'Failed' : 'Completed';
  if (operation.videoPath && !error && result?.status !== 'complete') entry.status = result?.working ? 'Background work running; poll only' : result?.status === 'checkpoint_failed' ? 'Accepted result needs local checkpoint repair' : 'Accepted; outcome pending';
  if (operation.videoPath && (error || result?.status === 'complete' || (result?.status === 'checkpoint_failed' && !result.working))) videoActivity.delete(operation.videoPath);
  if (!error && entry.appEndpoint === '/materials/summarize' && result?.preparationMode === 'verbatim') {
    entry.execution = 'local'; entry.role = 'local'; entry.apiMode = 'local';
    delete entry.provider; delete entry.model; delete entry.thinking; delete entry.timeoutMs;
  }
  if (error) {
    if (error.status) entry.appStatus = error.status;
    if (/^[a-f0-9-]{36}$/.test(error.requestId || '')) entry.appRequestId = error.requestId;
    const d = error.diagnostics || {};
    if (Number.isFinite(d.elapsedMs)) entry.providerElapsedMs = d.elapsedMs;
    if (Number.isSafeInteger(d.timeoutMs) && d.timeoutMs >= 1 && d.timeoutMs <= 600000) entry.timeoutMs = d.timeoutMs;
    if (['response_headers', 'response_body'].includes(d.timeoutPhase)) entry.timeoutPhase = d.timeoutPhase;
    // Keep a fixed schema, not arbitrary server fields or error prose.
    for (const key of ['stage', 'provider', 'model', 'apiMode', 'thinking', 'category', 'endpoint', 'upstreamStatus', 'contentType', 'responseBytes', 'providerCode', 'providerRequestId', 'automaticRetry', 'responseBodyOmitted', 'validationReason', 'outputCharacters', 'notesCharacters', 'warningCount', 'warningCharacters', 'maxOutputTokens', 'completionStatus', 'outputTokens', 'reasoningTokens']) {
      if (Object.hasOwn(d, key) && ['string', 'number', 'boolean'].includes(typeof d[key])) {
        // Audio endpoints can contain IDs. Never copy arbitrary endpoint/error text into reports.
        if (entry.role === 'speech' && ['endpoint', 'stage', 'provider', 'model', 'apiMode'].includes(key)) continue;
        entry[key] = typeof d[key] === 'string' ? d[key].slice(0, 200) : d[key];
      }
    }
  }
  trace.cachedResults = materials.cache.size;
  if (lessonTrace === trace) renderTrace();
}
async function api(path, options = {}) {
  const operation = operationStart(path, options.body, options.method);
  const activity = operation || ((!options.method || options.method === 'GET') ? videoActivity.get(path) : null);
  try { const result = await apiRequest(path, options, operation); operationFinish(activity, null, result); return result; }
  catch (error) { operationFinish(activity, error); throw error; }
}
async function apiRequest(path, options = {}, operation = null) {
  let response;
  try {
    response = await fetch('/api' + path, { ...options, headers: { 'X-LearnLens-Token': token, ...(options.raw ? { 'Content-Type': 'application/octet-stream' } : options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers }, credentials: 'same-origin', cache: 'no-store', body: options.raw || (options.body ? JSON.stringify(options.body) : undefined) });
  } catch (cause) { if (cause.name === 'AbortError') throw cause; const error = new Error('Could not reach LearnLens. Check your connection. An AI request already sent may still incur charges; it will not be retried automatically.'); error.network = true; throw error; }
  if (operation) { operation.entry.appStatus = response.status; const id = response.headers.get('X-LearnLens-Request-Id'); if (/^[a-f0-9-]{36}$/.test(id || '')) operation.entry.appRequestId = id; }
  let result;
  try { result = await response.json(); } catch (cause) { if (cause.name === 'AbortError') throw cause; const error = new Error('LearnLens returned an unreadable response. Check the server connection.'); error.network = cause instanceof TypeError; error.status = response.status; error.requestId = response.headers.get('X-LearnLens-Request-Id'); throw error; }
  if (!response.ok) {
    if (response.status === 409 && ['/transcribe', '/materials/summarize', '/audio/extract', '/lessons'].includes(path)) {
      ready = false; cancelWork();
      $('connection-banner').hidden = false; $('connection-message').textContent = 'AI setup changed after confirmation. Processing stopped without switching providers. Refresh setup, then confirm again; your completed draft work remains intact.';
    }
    if ([401, 403].includes(response.status)) {
      cancelWork(true); ready = false; $('connection-banner').hidden = false; $('connection-message').textContent = 'Your session changed or expired. Download your lesson or copy your draft before reloading.'; $('reload-session').hidden = false; updateStatus();
    }
    const error = new Error(result.error || `Request failed (HTTP ${response.status}).`); error.status = response.status; error.requestId = result.requestId; error.diagnostics = result.diagnostics; throw error;
  }
  return result;
}

function stopPreviewAudio() { $('lesson-frame').contentWindow?.postMessage({ type: 'learnlens-stop-audio' }, '*'); }
function navigate(next, focus = false) {
  if (next === 'providers' || state.locked) stopPreviewAudio();
  page = next === 'providers' ? 'providers' : 'lesson';
  $('login-panel').hidden = !state.locked;
  $('lesson-page').hidden = state.locked || page !== 'lesson';
  $('providers-page').hidden = state.locked || page !== 'providers';
  $('breadcrumb-current').textContent = state.locked ? 'Unlock workspace' : page === 'lesson' ? 'New lesson' : 'AI providers';
  document.title = `${state.locked ? 'Unlock workspace' : page === 'lesson' ? 'New lesson' : 'AI providers'} · LearnLens`;
  $$('.nav-item').forEach(button => { const active = button.dataset.page === page; button.classList.toggle('is-active', active); if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current'); });
  if (focus) $(state.locked ? 'login-title' : page + '-page-title').focus({ preventScroll: true });
}
function tab(which) {
  if (which !== 'preview') stopPreviewAudio();
  for (const name of ['compose', 'preview']) { const active = name === which; $('tab-' + name).setAttribute('aria-selected', String(active)); $('tab-' + name).tabIndex = active ? 0 : -1; $(name + '-panel').hidden = !active; }
}

async function refreshState(rebuild = true) {
  try {
    state = await api('/state'); ready = true;
    $('connection-banner').hidden = true; $('reload-session').hidden = true;
    if (rebuild) { roleDrafts = structuredClone(state.roles); dismissRecommendations(); renderProviders(); renderRoles(); }
    updateStatus(); navigate(page);
  } catch (error) { ready = false; $('connection-banner').hidden = false; $('connection-message').textContent = error.message; updateStatus(); }
}

function updateStatus() {
  const assigned = Object.values(state.roles).filter(Boolean).length;
  $('setup-count').textContent = `${assigned}/4`; $('mini-count').textContent = `${assigned}/4`;
  $('saved-role-count').textContent = assigned;
  $('setup-label').textContent = !ready ? 'Connection unavailable' : state.locked ? 'Unlock workspace' : state.roles.primary ? 'AI setup ready' : 'Connect your AI';
  $('setup-dot').classList.toggle('pending', !state.roles.primary);
  $('clear-session').disabled = !ready || settingsBusy || Boolean(recording) || micPending || confirming;
  const usable = ready && !state.locked && !busy && !settingsBusy && !confirming && !materials.busy && !micPending;
  const editable = usable && !recording, sourceBlocked = Boolean(pendingAudioSources());
  $('retry-preview').disabled = !editable;
  materials.setLocked(busy || settingsBusy || confirming || !ready || state.locked || Boolean(recording) || micPending || sourceBlocked);
  $('dropzone').disabled = !editable || sourceBlocked; $('material-input').disabled = !editable || sourceBlocked;
  for (const id of ['source-url', 'source-mode', 'import-url']) $(id).disabled = !editable || sourceBlocked;
  $('learning-goal').disabled = !editable;
  for (const id of ['subject', 'level', 'language']) $(id).disabled = !editable;
  $('custom-subject').disabled = !editable || $('subject').value !== 'custom';
  $('custom-language').disabled = !editable || $('language').value !== 'custom';
  $$('[data-goal]').forEach(button => button.disabled = !editable);
  $('material-list').setAttribute('aria-busy', String(materials.busy));
  $('import-status').hidden = !materials.busy;
  $('import-status').textContent = materials.busy ? materials.items.find(item => item.status === 'preparing')?.progress || 'Preparing local material previews… No AI request.' : '';
  $('generate-button').disabled = !editable || sourceBlocked;
  $('generate-label').textContent = busy ? 'Creating lesson…' : materials.busy ? 'Preparing materials locally…' : state.roles.primary ? 'Create my lesson' : 'Connect a primary model';
  $('generation-helper').textContent = sourceBlocked ? 'Finish or discard remaining audio sources before changing attachments or starting another lesson.' : state.roles.primary ? `Using ${state.roles.primary.model}` : 'One primary model is all you need to start.';
  $('audio-mode').disabled = !editable;
  $('speech-note').textContent = state.roles.speech?.engine === 'kokoro' ? 'Native Kokoro supports English only (US/UK voices), runs locally and needs no API key. Audio is included in the download.' : state.roles.speech ? `English speech via ${providerFor(state.roles.speech)?.name} · potentially billable per unique clip. You confirm the exact count before speech starts.` : 'Audio preference is saved. If English audio is needed, the text lesson is kept while you configure a speech role and continue audio.';
  $('speech-setup-link').hidden = Boolean(state.roles.speech);
  $('provider-fields').disabled = !usable;
  $$('.provider-remove,.provider-edit,.discover-button').forEach(button => button.disabled = !usable);
  $('roles-fields').disabled = !usable;
  $('save-roles').disabled = !usable;
  $('settings-lock-note').hidden = !busy;
  $$('[data-action="demo"]').forEach(button => button.disabled = !usable || sourceBlocked);
  $('record-button').disabled = ((!usable || sourceBlocked) && !recording) || !navigator.mediaDevices?.getUserMedia || !window.MediaRecorder;
  for (const id of ['mini-roles', 'setup-role-list']) {
    const root = $(id); root.replaceChildren();
    for (const [key, label] of [['primary', 'Lesson model'], ['transcription', 'Audio input'], ['video', 'Whole-video analysis'], ['speech', 'Complete English audio']]) {
      const row = element('div'); const name = element('span', label); const value = element('span', state.roles[key]?.model || (key === 'primary' ? 'Needed' : 'Optional')); value.title = value.textContent; row.append(name, value); root.append(row);
    }
  }
  const unique = new Set(Object.values(state.roles).filter(Boolean).map(r => (r.engine || r.providerId) + '/' + r.model)).size;
  $('mini-setup-description').textContent = `${assigned} role${assigned === 1 ? '' : 's'} assigned across ${unique} distinct model${unique === 1 ? '' : 's'}. One primary is required. Add native video or audio roles only for sources/features that need them.`;
  for (const view of Object.values(roleViews)) view.refreshChecks();
  updateAdvisorControls(usable);
  updateSummary(); renderAudioStatus(); renderGenerationCheckpoint();
}
function updateSummary() {
  $('summary-material').textContent = materials.items.length ? `${materials.items.length} attachment(s) · ${materials.partCount} automatic part(s)${materials.busy ? ' · preparing locally' : ''}` : $('learning-goal').value.trim() ? 'Question / instructions only' : 'Nothing added yet';
  $('summary-subject').textContent = chosenSubject() === 'Auto' ? 'Auto-detect' : chosenSubject() || 'Choose a subject';
  $('summary-level').textContent = $('level').value === 'Auto' ? 'Match the material' : $('level').value;
  $('summary-language').textContent = chosenLanguage() || 'Choose a language';
  const audio = audioDecision($('audio-mode').value, chosenSubject());
  $('summary-audio').textContent = $('audio-mode').value === 'auto' ? audio === null ? 'Auto · English-subject lessons only' : audio ? 'Auto · English audio included' : 'Auto · no audio for this subject' : audio ? 'On · complete English words + sentences' : 'Off · text-only lesson';
  $('summary-goal').textContent = $('learning-goal').value.trim() || 'Let the material guide the lesson.';
  $('vision-warning').hidden = !materials.hasVisuals || !state.roles.primary || checkOf(state.roles.primary, 'vision')?.status === 'verified';
  $('vision-warning-text').textContent = 'Image understanding is unverified for your primary model. You can run an optional paid vision test, or generate and carefully check the result.';
}

async function confirmAction({ title, description, detail = '', paid = false, accept = 'Continue' }) {
  const dialog = $('confirm-dialog'); if (dialog.open) return false;
  $('confirm-title').textContent = title; $('confirm-description').textContent = description; $('confirm-detail').textContent = detail; $('confirm-detail').hidden = !detail;
  $('confirm-consent-row').hidden = !paid; $('confirm-consent').checked = false; $('confirm-accept').textContent = accept; $('confirm-accept').disabled = paid;
  $('confirm-consent').onchange = () => $('confirm-accept').disabled = paid && !$('confirm-consent').checked;
  return new Promise(resolve => {
    const finish = value => { dialog.close(); resolve(value); };
    $('confirm-accept').onclick = () => finish(true); $('confirm-cancel').onclick = () => finish(false); $('confirm-close').onclick = () => finish(false);
    dialog.oncancel = event => { event.preventDefault(); finish(false); };
    dialog.showModal();
  });
}

function dismissRecommendations() {
  recommendations = null; $('recommend-results').hidden = true; $('recommend-cards').replaceChildren();
}
function updateAdvisorControls(usable) {
  const primary = roleViews.primary?.readDraft();
  $('use-starter').disabled = !usable || !state.starter;
  $('starter-hint').textContent = state.starter ? state.starter.reason : 'Discover models first. If no known starter is listed, select a general-purpose text/image model below; we will not guess from an unfamiliar name.';
  $('recommend-models').disabled = !usable || !primary?.model;
  $('recommend-scope').disabled = !usable;
  $('apply-recommendations').disabled = !usable || !recommendations;
}
function renderRecommendations(result) {
  recommendations = result; $('recommend-results').hidden = false; $('recommend-summary').textContent = result.summary;
  $('recommend-warnings').replaceChildren(...result.warnings.map(warning => element('li', warning)));
  const root = $('recommend-cards'); root.replaceChildren();
  for (const item of result.suggestions) {
    const card = element('article', undefined, 'recommend-card');
    const title = element('label', undefined, 'recommend-choice');
    const box = element('input'); box.type = 'checkbox'; box.dataset.role = item.role;
    box.disabled = !item.selection; box.checked = Boolean(item.selection && !roleDrafts[item.role]?.model);
    const name = rolesConfig[item.role].title;
    title.append(box, element('strong', name));
    const selection = item.selection;
    const selected = selection ? `${selection.engine === 'kokoro' ? 'Built-in Kokoro' : providerFor(selection)?.name || 'Provider'} / ${selection.model}${item.role === 'transcription' ? ' · ' + transcriptionMode(selection) : ''}` : 'No confident choice · keep your current selection';
    card.append(title, element('p', selected, 'recommend-model'), element('p', item.reason));
    if (item.caveat) card.append(element('p', item.caveat, 'field-hint'));
    const existing = roleDrafts[item.role];
    if (existing?.model) card.append(element('p', `Form choice when this advice arrived: ${existing.model}. Check this box only if you want to replace it.`, 'field-hint'));
    root.append(card);
  }
}
async function suggestModels() {
  const primary = roleViews.primary?.readDraft();
  if (!primary?.model || busy || settingsBusy) return;
  const scope = $('recommend-scope').value;
  if (!await confirmAction({ title: 'Ask your primary model for setup advice?', description: `This may use paid credits. Sends ${scope === 'all' ? 'all connected providers’' : 'the primary provider’s'} model IDs, display names and sample-check results to your chosen primary provider, plus Kokoro availability if configured. No API keys, base URLs, recordings or lesson material are included. Suggestions are not saved automatically.`, detail: `${providerFor(primary)?.name} · ${primary.model} · thinking: ${primary.reasoningEffort || 'model default'}\n${primaryWait(primary)}`,  paid: true, accept: 'Get model suggestions' })) return;
  settingsBusy = true; dismissRecommendations(); updateStatus(); message('recommend-message', 'Asking your primary model to explain suitable choices…');
  try { const result = await api('/roles/recommend', { method: 'POST', body: { primary, scope, consent: true } }); renderRecommendations(result); message('recommend-message', 'Review the suggestions. Nothing has been changed or capability-tested.'); }
  catch (error) { message('recommend-message', error.message + ' You can continue selecting models manually below.', 'error'); }
  finally { settingsBusy = false; updateStatus(); }
}
function resetProviderForm(preset = 'openai') {
  editingProviderId = null; $('provider-preset').value = preset;
  $('provider-name').value = preset === 'openai' ? 'OpenAI' : ''; $('provider-url').value = preset === 'openai' ? 'https://api.openai.com/v1' : '';
  $('provider-key').value = ''; $('provider-key').type = 'password'; $('toggle-key').setAttribute('aria-pressed', 'false'); $('toggle-key').setAttribute('aria-label', 'Show API key');
  $('provider-key-hint').textContent = 'Write-only and kept in memory. This field is cleared after saving. A key is optional for local providers.';
  $('save-provider').querySelector('span').textContent = 'Save provider'; $('cancel-provider-edit').hidden = true;
}

function renderProviders() {
  const root = $('provider-list'); root.replaceChildren();
  $('provider-empty').hidden = state.providers.length > 0;
  $('provider-count').textContent = `${state.providers.length} connected`;
  for (const provider of state.providers) {
    const card = $('provider-card-template').content.firstElementChild.cloneNode(true);
    card.querySelector('.provider-mark').textContent = provider.name.slice(0, 1).toUpperCase();
    card.querySelector('.provider-name').textContent = provider.name;
    card.querySelector('.provider-url').textContent = provider.baseUrl;
    card.querySelector('.provider-key-state').textContent = provider.hasKey ? 'Key in memory' : 'No key · local';
    card.querySelector('.provider-model-count').textContent = `${provider.models.length} listed models`;
    const list = card.querySelector('.model-id-list');
    provider.models.forEach(model => list.append(element('li', model.id)));
    card.querySelector('.model-list-details').hidden = !provider.models.length;
    card.querySelector('.provider-edit').onclick = () => {
      if (busy || settingsBusy) return;
      editingProviderId = provider.id; $('provider-preset').value = 'custom';
      $('provider-name').value = provider.name; $('provider-url').value = provider.baseUrl; $('provider-key').value = '';
      $('provider-key').type = 'password'; $('toggle-key').setAttribute('aria-pressed', 'false'); $('toggle-key').setAttribute('aria-label', 'Show API key');
      $('provider-key-hint').textContent = 'Leave the key blank to keep it ONLY when the URL is unchanged. Changing the URL requires re-entering a key for remote providers. Model IDs are kept but checks and the model list reset when the endpoint/key changes.';
      $('save-provider').querySelector('span').textContent = 'Save changes'; $('cancel-provider-edit').hidden = false;
      $('provider-add').open = true; $('provider-url').focus(); message('provider-form-message');
    };
    const remove = card.querySelector('.provider-remove'); remove.setAttribute('aria-label', `Remove ${provider.name}`);
    remove.onclick = async () => {
      if (busy || settingsBusy) return;
      if (!await confirmAction({ title: 'Remove this provider?', description: 'Its key and any associated model roles will be cleared from this browser session.', detail: provider.name, accept: 'Remove provider' })) return;
      settingsBusy = true; updateStatus();
      try { await api('/providers/' + provider.id, { method: 'DELETE' }); await refreshState(); toast('Provider removed.'); }
      catch (error) { message(card.querySelector('.provider-message'), error.message, 'error'); }
      finally { settingsBusy = false; updateStatus(); }
    };
    card.querySelector('.discover-button').onclick = async () => {
      if (busy || settingsBusy) return;
      settingsBusy = true; updateStatus(); const button = card.querySelector('.discover-button'); button.disabled = true;
      message(card.querySelector('.provider-message'), 'Requesting the provider’s model list…');
      try { const result = await api('/providers/' + provider.id + '/discover', { method: 'POST', body: {} }); await refreshState(false); renderProviders(); renderRoles(); toast(result.models.length ? `${result.models.length} models listed. Capabilities remain untested.` : 'No models listed. You can still enter an exact model ID.'); }
      catch (error) { message(card.querySelector('.provider-message'), error.message + ' You can still enter model IDs manually below.', 'error'); }
      finally { settingsBusy = false; updateStatus(); button.disabled = false; }
    };
    root.append(card);
  }
}
const rolesConfig = {
  primary: { title: 'Primary lesson model', icon: 'book', description: 'Understands material, identifies subjects, and creates lessons.', kinds: ['text', 'vision'] },
  transcription: { title: 'Speech-to-text', icon: 'mic', description: 'Transcribes audio-only sources; whole videos use the separate native-video role.', kinds: ['transcription'] },
  video: { title: 'Whole-video analysis', icon: 'book', description: 'Analyzes complete audiovisual clips, including speech, screen text, diagrams and motion.', kinds: ['video'] },
  speech: { title: 'Natural speech', icon: 'headphones', description: 'Creates complete English word and sentence audio from sources and the lesson.', kinds: ['speech'] },
};
function renderRoles() {
  $('role-cards').replaceChildren(); roleViews = {};
  for (const [name, config] of Object.entries(rolesConfig)) {
    const card = $('role-card-template').content.firstElementChild.cloneNode(true); card.dataset.role = name;
    card.querySelector('.role-icon').append(icon(config.icon)); card.querySelector('[data-role-title]').textContent = config.title;
    card.querySelector('.role-requirement').textContent = name === 'primary' ? 'Required' : 'Optional'; card.querySelector('.role-description').textContent = config.description;
    const fields = Object.fromEntries(['provider', 'model', 'manual', 'api', 'voice', 'effort', 'engine', 'timeout', 'fps'].map(key => [key, card.querySelector(`[data-field="${key}"]`)]));
    for (const [key, field] of Object.entries(fields)) { field.id = `role-${name}-${key}`; card.querySelector(`[data-for="${key}"]`).htmlFor = field.id; if (field.tagName === 'INPUT') field.maxLength = 200; }
    for (const provider of state.providers) fields.provider.add(new Option(provider.name, provider.id));
    if (name === 'transcription') {
      fields.api.replaceChildren(new Option('OpenAI multipart', 'auto'), new Option('Gemini-native audio', 'gemini'));
      card.querySelector('[data-for="api"]').textContent = 'Transcription API';
    }
    if (name === 'video') {
      fields.api.replaceChildren(new Option('Gemini-native video · explicit compatibility required', 'gemini'));
      card.querySelector('.timeout-field .field-hint').textContent = '30–600 seconds per video-analysis request; default 300. Independent of primary, transcription and speech. No automatic retry; providers/proxies may stop sooner.';
    }
    const draft = roleDrafts[name]; fields.provider.value = draft?.providerId || ''; fields.api.value = name === 'video' ? 'gemini' : name === 'transcription' ? (draft?.api === 'gemini' ? 'gemini' : 'auto') : draft?.api || 'auto'; fields.voice.value = draft?.voice || ''; fields.effort.value = draft?.reasoningEffort || 'default'; fields.engine.value = draft?.engine || 'provider'; fields.timeout.value = draft?.timeoutSeconds ?? 300; fields.fps.value = draft?.fps ?? 24;
    card.querySelector('.api-field').hidden = !['primary', 'transcription', 'video'].includes(name); card.querySelector('.effort-field').hidden = name !== 'primary'; card.querySelector('.timeout-field').hidden = !['primary', 'video'].includes(name); card.querySelector('.fps-field').hidden = name !== 'video'; card.querySelector('.voice-field').hidden = name !== 'speech'; card.querySelector('.engine-field').hidden = name !== 'speech';
    fields.engine.querySelector('[value="kokoro"]').disabled = !state.speechServices?.kokoro?.available;
    card.querySelector('.kokoro-hint').textContent = state.speechServices?.kokoro?.available ? (state.speechServices.kokoro.languages?.length === 1 && state.speechServices.kokoro.languages[0] === 'en' ? 'Included native Kokoro supports English only (US/UK voices). Default: af_heart. Complete-audio matching uses English/Latin text heuristics, not reliable language identification. No API key or automatic cloud fallback.' : 'Included speech runs on this server. Complete audio covers English word/sentence targets; native Kokoro supports English only. English voice af_heart is the default. No API key or automatic cloud fallback.') : 'Built-in speech is unavailable on this server. You can use an online provider or contact the workspace administrator. No learner-side installation is required.';
    function readDraft() {
      if (name === 'speech' && fields.engine.value === 'kokoro') return { engine: 'kokoro', model: state.speechServices.kokoro.model, api: 'auto', voice: fields.voice.value.trim() || state.speechServices.kokoro.voice };
      if (!fields.provider.value) return null;
      return { providerId: fields.provider.value, model: fields.model.value === '__manual__' ? fields.manual.value.trim() : fields.model.value, api: fields.api.value, ...(['primary', 'video'].includes(name) ? { timeoutSeconds: Number(fields.timeout.value) } : {}), ...(name === 'video' ? { fps: Number(fields.fps.value) } : {}), ...(name === 'primary' && fields.effort.value !== 'default' ? { reasoningEffort: fields.effort.value } : {}), ...(name === 'speech' ? { voice: fields.voice.value.trim() || 'alloy' } : {}) };
    }
    function refreshEngine() {
      const local = name === 'speech' && fields.engine.value === 'kokoro';
      card.querySelector('.provider-field').hidden = local; card.querySelector('.model-field').hidden = local;
      card.querySelector('.manual-model-field').hidden = local || fields.model.value !== '__manual__';
      fields.voice.placeholder = local ? state.speechServices.kokoro.voice : 'A voice your provider supports';
    }
    function populateModel(model = '') {
      const provider = state.providers.find(p => p.id === fields.provider.value);
      fields.model.replaceChildren(new Option(provider ? 'Select a model…' : 'Choose a provider first', ''));
      if (provider) { for (const entry of provider.models) fields.model.add(new Option(entry.id, entry.id)); fields.model.add(new Option('Enter model ID manually…', '__manual__')); }
      fields.model.disabled = !provider;
      fields.model.value = provider?.models.some(m => m.id === model) ? model : provider && (model || !provider.models.length) ? '__manual__' : '';
      fields.manual.value = model;
      card.querySelector('.manual-model-field').hidden = fields.model.value !== '__manual__';
    }
    function refreshChecks() {
      const role = readDraft(); const provider = providerFor(role); const checks = card.querySelector('.check-badges'); checks.replaceChildren();
      for (const kind of config.kinds) {
        const check = checkOf(role, kind); const badge = element('span', `${kind}: ${check?.status === 'verified' ? 'Verified' : check?.status === 'failed' ? 'Test failed' : 'Untested'}`, 'badge ' + (check?.status === 'verified' ? 'verified' : check?.status === 'failed' ? 'failed' : 'neutral')); badge.title = check?.detail || 'No verified capability test yet.'; checks.append(badge);
      }
      const help = role?.engine === 'kokoro' ? 'Uses the included Kokoro engine, never the online speech provider. Changing voices requires another check. Listen to judge language coverage and naturalness.' : name === 'primary' ? 'Auto tries Responses, then Chat only for missing endpoints. Thinking levels are model-dependent; Default is safest. Vision checks one synthetic image, not handwriting accuracy.' : name === 'video' ? 'Requires native MP4 audiovisual input via this provider’s Gemini generateContent endpoint. Audio/image support or a model name is not proof of compatibility. No automatic protocol fallback. Complete clips are sent only after AI consent; valid output is not proof that every detail was understood.' : name === 'speech' ? 'Requires /audio/speech compatibility. A Realtime-only model will not work here. Voice defaults to alloy; set a voice your provider supports.' : role?.api === 'gemini' ? 'Uses inline WAV audio via models.generateContent on this same provider. A /v1 base becomes /v1beta; native bases are also supported. Gateway audio support needs a real transcription check. No automatic fallback or retry. Primary API mode stays unchanged.' : 'Requires multipart /audio/transcriptions support, not just audio understanding. Gemini-native audio is a separate explicit option; it is never selected from a model name. Verification comes from an actual recording.';
      card.querySelector('.role-check-help').textContent = help;
      card.querySelectorAll('.probe-buttons button').forEach(button => button.disabled = !role?.model || (!provider && role?.engine !== 'kokoro') || busy || settingsBusy);
    }
    populateModel(draft?.model || ''); refreshEngine();
    const update = () => { roleDrafts[name] = readDraft(); refreshEngine(); refreshChecks(); updateAdvisorControls(ready && !state.locked && !busy && !settingsBusy); };
    fields.engine.onchange = () => { fields.voice.value = fields.engine.value === 'kokoro' ? state.speechServices.kokoro.voice : ''; update(); };
    fields.provider.onchange = () => { populateModel(); update(); };
    fields.model.onchange = () => { card.querySelector('.manual-model-field').hidden = fields.model.value !== '__manual__'; update(); };
    for (const key of ['manual', 'api', 'voice', 'effort', 'timeout', 'fps']) fields[key].addEventListener(['api', 'effort'].includes(key) ? 'change' : 'input', update);
    if (!['transcription', 'video'].includes(name)) for (const kind of config.kinds) {
      const button = element('button', `Test ${kind}`, 'btn secondary small'); button.type = 'button';
      button.onclick = async () => {
        const role = readDraft(); if (!role?.model || busy || settingsBusy) return;
        const provider = providerFor(role);
        const local = role.engine === 'kokoro';
        if (!await confirmAction({ title: `Run a ${kind} capability test?`, description: local ? 'Generate a short synthetic clip using built-in speech. No lesson material is included and no cloud speech provider will be called.' : 'This sends a synthetic request to your selected provider. It may use paid credits; higher thinking levels can increase cost. No learning material is included.', detail: `${local ? 'Built-in Kokoro' : provider.name} · ${role.model}${kind === 'speech' ? ' · voice: ' + role.voice : ''}${name === 'primary' ? '\n' + primaryWait(role) : ''}`, paid: !local, accept: local ? 'Test Kokoro' : 'Run paid test' })) return;
        settingsBusy = true; updateStatus(); refreshChecks(); message(card.querySelector('.role-feedback'), 'Testing this capability…');
        try { const result = await api(local ? '/speech/kokoro/probe' : `/providers/${provider.id}/probe`, { method: 'POST', body: { ...role, kind, consent: true } }); await refreshState(false); message(card.querySelector('.role-feedback'), result.check.detail, result.check.status === 'failed' ? 'error' : ''); }
        catch (error) { message(card.querySelector('.role-feedback'), error.message, 'error'); }
        finally { settingsBusy = false; updateStatus(); refreshChecks(); }
      };
      card.querySelector('.probe-buttons').append(button);
    }
    refreshChecks(); roleViews[name] = { card, readDraft, refreshChecks }; $('role-cards').append(card);
  }
}

async function confirmUrlImport(url, { mode = 'auto' } = {}) {
  if (busy || settingsBusy || confirming || recording || micPending || !ready || state.locked || pendingAudioSources()) return false;
  let citation;
  try { const parsed = new URL(url); if (parsed.protocol !== 'https:' || parsed.username || parsed.password || (parsed.port && parsed.port !== '443')) throw new Error(); citation = parsed.origin + parsed.pathname; }
  catch { message('upload-message', 'Use a public HTTPS URL without credentials, on port 443.', 'error'); return false; }
  const epoch = sessionEpoch; confirming = true; updateStatus();
  try {
    return await confirmAction({ title: 'Fetch this public source?', description: 'The app server will contact this site and any permitted redirects, then retain a private temporary snapshot. The site can see the request and query parameters. No AI request is made. No login, browser cookies or DRM bypass. Review the snapshot before separately approving AI processing.',
      detail: citation + '\nSource type: ' + mode + '\nStatic pages may omit dynamic content, images and embeds. Videos require all audiovisual intervals; unavailable or over-quota content fails rather than silently shrinking coverage. Query tokens are excluded from citations, but origin/path sharing still needs your review. Imports expire with this session.',
      accept: 'Fetch private snapshot' }) && epoch === sessionEpoch;
  } finally { confirming = false; updateStatus(); }
}
async function addUrlSource() {
  const url = $('source-url').value.trim(), mode = $('source-mode').value;
  if (!url || materials.busy || !await confirmUrlImport(url, { mode })) return;
  try { const issues = await materials.addUrl(url, { mode }); if (!issues.length) $('source-url').value = ''; message('upload-message', issues.length ? issues.join(' ') : 'Review the retained source before creating a lesson. No AI request was made.', issues.length ? 'error' : ''); }
  catch (error) { if (error.name !== 'AbortError') message('upload-message', error.message, 'error'); }
}
async function addFiles(files) {
  if (busy || settingsBusy || confirming || recording || micPending || !ready || state.locked || pendingAudioSources()) return;
  try { const issues = await materials.add(files); message('upload-message', issues.join(' '), issues.length ? 'error' : ''); }
  catch (error) { if (error.name !== 'AbortError') message('upload-message', error.message, 'error'); }
}

function renderAudioStatus() {
  const context = currentLesson?.audio;
  $('switch-previous').hidden = lessonHistory.length < 2;
  $('switch-previous').disabled = busy || settingsBusy || confirming;
  $('audio-progress-panel').hidden = !context;
  if (!context) return;
  const summary = context.manifest?.summary;
  $('audio-count').textContent = summary ? `${summary.completedClips}/${summary.totalClips} unique clips complete · ${summary.status}` : context.sourcePending ? 'Original audio sources pending · text lesson retained' : 'Exact clip count pending local inventory';
  $('audio-uncertainties').textContent = summary ? `Source recognition/coverage uncertainty: ${summary.sourceUncertainties || 0} source(s). Clip completion does not verify source recognition.` : 'Source recognition/coverage uncertainty count pending local inventory.';
  $('audio-retained').textContent = context.discarded ? 'Remaining audio discarded. The last retained HTML is still available to download; it has not been replaced or regenerated.' : context.exportedComplete ? 'Complete audio HTML retained on this page. Download to keep it.' : `Text lesson retained. ${currentLesson.audioSummary ? 'Latest available audio export also retained.' : 'The current download is text-only; completed server clips are added by a successful local export.'} Unfinished audio sources stay in this page/session; reload or server restart can lose them.`;
  $('audio-operation').textContent = context.operation;
  message('audio-message', context.notice, context.notice ? 'warning' : '');
  const usable = ready && !state.locked && !busy && !settingsBusy && !confirming && !context.unavailable;
  $('continue-audio').disabled = !usable;
  $('continue-audio').hidden = context.exportedComplete || context.discarded;
  $('download-partial').disabled = !usable || !audioExportable(context);
  $('download-partial').hidden = context.exportedComplete || context.discarded;
  $('discard-audio').hidden = context.exportedComplete || context.discarded;
  $('discard-audio').disabled = busy || settingsBusy || confirming || Boolean(recording) || micPending;
  $('stop-audio').hidden = activeAudio !== context || !busy;
}
async function cleanCompletedAudio(signal) {
  for (const lesson of lessonHistory) {
    const context = lesson.audio;
    if (!context?.exportedComplete || context.unavailable || context.manifest?.summary.status !== 'complete') continue;
    try { await api(audioPath(context), { method: 'DELETE', body: {}, signal }); }
    catch (error) { if (error.status !== 404) throw error; }
    context.unavailable = true; context.operation = 'Finished HTML retained; completed server plan released for the next lesson.';
  }
}
async function retainAudioExport(lesson, signal) {
  const result = await exportAudioPlan(api, lesson.audio, signal);
  // Keep recovery snapshots only while unfinished; completed HTML is retained before releasing them.
  Object.assign(lesson, { html: result.html, title: result.title, lesson: result.lesson, warnings: result.warnings, audioSummary: result.audioSummary });
  if (lesson.audio.exportedComplete) releaseAudioSnapshots(lesson.audio);
  if (lesson === currentLesson) displayLesson();
}
async function runLessonAudio(lesson, { resume = false, signal, revision, sourceApproval } = {}) {
  const context = lesson.audio; activeAudio = context; context.notice = ''; context.paused = false; renderAudioStatus();
  try {
    if (context.sourcePending) {
      if (!sourceApproval || !Number.isInteger(sourceApproval.revision)) throw new Error('Confirm the remaining audio-source preparation before continuing.');
      if (context.sourceMaterials !== materialSignature() || !materials.checkpointInfo().available) throw new Error('The original audio-source checkpoint is unavailable or attachments changed. Keep the text lesson; no preparation was replayed.');
      if (!sourceApproval.roles.speech) throw new Error('Assign a speech role in AI providers, then Continue audio. The text lesson and acknowledged preparation are retained; teaching will not repeat.');
      context.operation = 'Checking local audio readiness'; renderAudioStatus();
      await api('/audio/preflight', { method: 'POST', body: {}, signal });
      if (signal.aborted || context.unavailable) throw new DOMException('Audio source preparation stopped. Text is retained.', 'AbortError');
      context.operation = 'Preparing original English audio sources'; renderAudioStatus();
      const sources = await materials.upgradeAudioSources({ consent: true, resume, roles: sourceApproval.roles, expectedSetupRevision: sourceApproval.revision,
        progress: text => { context.operation = text; const part = /^Collecting audio sources · part (\d+) of (\d+)/.exec(text); if (lessonTrace) { lessonTrace.part = part ? tracePart(Number(part[1]), Number(part[2])) : null; lessonTrace.cachedResults = materials.cache.size; lessonTrace.checkpoint = checkpointMetadata(); renderTrace(); } renderAudioStatus(); } });
      // Transfer complete sources before releasing the pinned preparation job.
      if (context.unavailable) throw new DOMException('The session changed. Audio cannot resume.', 'AbortError');
      context.sources = sources; context.sourcePending = false; context.sourceMaterials = null;
      context.approvedSetup = structuredClone(sourceApproval); context.revision = revision = sourceApproval.revision;
      materials.discardCheckpoint();
    }
    const manifest = await prepareAudioPlan(api, context, { resume, revision, signal, changed: renderAudioStatus });
    if (signal.aborted) throw new DOMException('Audio stopped. Text is retained.', 'AbortError');
    const speech = manifest.speech || context.approvedSetup.roles.speech;
    const local = speech.engine === 'kokoro';
    const failures = manifest.clips.filter(clip => RETRYABLE_AUDIO.has(clip.status)).length;
    const needsWork = manifest.clips.some(clip => clip.status !== 'complete');
    if (needsWork) {
      context.operation = 'Awaiting exact-count speech confirmation'; renderAudioStatus();
      const consent = await confirmAction({ title: resume ? 'Continue complete English audio?' : 'Generate complete English audio?',
        description: `${manifest.summary.totalClips} unique clips exactly: all matched English word targets and sentences from the uploaded sources AND generated lesson, not just AI keywords. ${manifest.summary.completedClips} already complete and reused. English/Latin matching is not reliable language identification. OCR/transcription can miss or misrecognize content; audio completeness refers to the extracted inventory, not guaranteed recognition of every original mark.`,
        detail: `Speech role: ${local ? 'Built-in native Kokoro · local, English-only · no cloud speech charge' : 'Remote/compatible provider · potentially billable: ' + context.approvedSetup.speechProvider}\nModel: ${speech.model} · voice: ${speech.voice || (local ? 'af_heart' : 'alloy')}\n${manifest.summary.totalClips - manifest.summary.completedClips} clips remaining; ${failures} failed/damaged/encoding-failed clip(s). ${resume ? 'This is renewed consent for pending/unknown attempts and retrying these failed clips. Prior unknown attempts may already have been billed.' : 'No failed clip will be retried automatically.'}\n${manifest.summary.sourceUncertainties || 0} source(s) have recognition/coverage uncertainty; ${manifest.warnings?.length || 0} plan warning(s) apply. Teaching language is unchanged. Cancel keeps this text lesson and audio context.`,
        paid: !local, accept: resume ? 'Continue audio with consent' : 'Generate these clips' });
      if (signal.aborted) throw new DOMException('Audio stopped. Text is retained.', 'AbortError');
      if (!consent) { context.notice = 'Speech cancelled. New text lesson and all audio sources are retained. Use Continue audio when ready; teaching and source preparation will not be repeated.'; return; }
      await generateAudioClips(api, context, { consent: true, retryFailed: resume, signal, changed: renderAudioStatus });
    }
    context.operation = 'Exporting available audio locally'; renderAudioStatus();
    await retainAudioExport(lesson, signal);
    context.paused = !context.exportedComplete;
    context.operation = context.exportedComplete ? 'Complete English audio exported and retained' : 'Partial audio export retained';
    announce(context.exportedComplete ? 'Complete English audio is ready to download.' : 'Available audio is retained; some clips remain unfinished.');
  } catch (error) {
    context.paused = true;
    context.operation = error.name === 'AbortError' ? 'Stopped; checking only local retained status' : 'Audio paused; no automatic paid retry';
    context.notice = error.message + (context.sourcePending ? ' The text lesson and acknowledged preparation are retained. Continue audio reuses transcripts and successful recognition; only missing/failed source recognition may require new paid confirmation. Keep the original attachments until this inventory finishes or is explicitly discarded.' : ' The teaching result and previous lessons are retained. Continue audio never repeats teaching, OCR or transcription.');
    // A fresh bounded LOCAL status/export is safe after Stop. Never call speech here.
    if (ready && !state.locked && !context.unavailable && context.createAttempted) {
      try { await retainAudioExport(lesson, AbortSignal.timeout(8000)); }
      catch (exportError) {
        context.notice += context.unavailable ? ' ' + exportError.message : ' A fresh partial export is not available now (the server may still be processing). The last retained HTML is unchanged.';
      }
    }
    if (lessonTrace) { lessonTrace.status = 'Text retained; audio paused'; renderTrace(); tracePanel.open = true; }
  } finally {
    if (context.operation === 'Awaiting exact-count speech confirmation') context.operation = 'Audio not dispatched; text retained';
    activeAudio = null; renderAudioStatus();
  }
}
async function continueLessonAudio({ exportOnly = false } = {}) {
  const lesson = currentLesson, context = lesson?.audio;
  if (!context || context.unavailable || busy || settingsBusy || confirming || !ready || state.locked) return;
  const epoch = sessionEpoch;
  let sourceApproval;
  if (!exportOnly) {
    confirming = true; updateStatus();
    let consent;
    try {
      if (context.sourcePending) {
        // Show the CURRENT primary/speech settings before approving unfinished OCR.
        await refreshState(false);
        if (!ready || state.locked || epoch !== sessionEpoch) return;
        sourceApproval = approvedAudioSetup();
        const primary = sourceApproval.roles.primary;
        consent = await confirmAction({ title: 'Prepare remaining English audio sources?', description: 'Keep the saved lesson and reuse acknowledged transcripts and recognition. Only missing/failed image recognition may make new primary-model requests; no video analysis, transcription, digests or teaching will repeat. Failed/unknown attempts may already have been billed. After the inventory, confirm the exact unique speech count separately.',
          detail: `Primary: ${providerFor(primary)?.name || 'Not configured'} / ${primary?.model || 'needed only for unfinished images'}\nThinking: ${primary?.reasoningEffort || 'model default'}\n${primaryWait(primary)}\nSpeech: ${sourceApproval.roles.speech?.model || 'Not configured — configure it before continuing'}\nKeep the original attachments until this source inventory finishes or is explicitly discarded.`, paid: materials.hasVisuals, accept: 'Prepare remaining sources' });
      } else consent = await confirmAction({ title: 'Resume this retained lesson’s audio?', description: 'Refresh local setup/status and restore the existing plan only. Teaching, video analysis, OCR and transcription will NOT run again. A second confirmation will show the exact speech count and any failed/unknown attempts before potentially billable speech. Provider/model/voice identity must still match the original plan; changing settings never silently retargets audio.', accept: 'Check retained audio' });
    } finally { confirming = false; updateStatus(); }
    if (!consent || epoch !== sessionEpoch) return;
  }
  busy = true; generationController = new AbortController(); const signal = generationController.signal; updateStatus();
  try {
    if (exportOnly) {
      await retainAudioExport(lesson, signal); context.notice = 'Available clips exported locally. Unfinished clips have not been generated or retried.';
      $('download-lesson').click();
    } else {
      await refreshState(false);
      if (!ready || state.locked || epoch !== sessionEpoch || signal.aborted) return;
      if (!Number.isInteger(state.setupRevision)) throw new Error('The current setup revision is unavailable. No speech request was made.');
      if (sourceApproval && sourceApproval.revision !== state.setupRevision) throw new Error('AI settings changed after confirmation. Confirm remaining audio sources again; no provider request was made.');
      beginTrace(sourceApproval || context.approvedSetup);
      await runLessonAudio(lesson, { resume: true, revision: state.setupRevision, signal, sourceApproval });
    }
  } catch (error) { context.notice = error.message; }
  finally { busy = false; generationController = null; updateStatus(); }
}

function canRetainNextLesson() {
  if (pendingAudioSources()) {
    const text = 'Finish or explicitly discard the retained lesson’s remaining audio sources before starting another lesson or replacing attachments. The saved text lesson remains available; no paid request was made.';
    message('generation-error', text, 'error'); toast(text); return false;
  }
  if (!lessonRetentionBlocker(lessonHistory)) return true;
  const text = 'New lesson paused: only two lessons are retained, and the oldest has unfinished audio (even if its plan expired). Open Lesson preview, switch previous lesson if needed, then finish or explicitly Discard remaining audio first. Download any HTML you want to keep. No paid generation was started.';
  message('generation-error', text, 'error'); toast(text); return false;
}
async function discardLessonAudio() {
  const context = currentLesson?.audio;
  if (!context || context.discarded || busy || settingsBusy || confirming || recording || micPending) return;
  confirming = true; updateStatus();
  let consent;
  try { consent = await confirmAction({ title: 'Discard remaining audio?', description: 'Keep the current retained HTML exactly as it is, but permanently remove this lesson’s audio continuation and full source/input snapshots. This makes no paid request and does NOT export more clips. If you want available server clips first, cancel and use Download available audio. A local DELETE will remove the plan when reachable; if disconnected/locked, server cleanup cannot be confirmed and temporary data may remain until session expiry.', accept: 'Discard remaining audio' }); }
  finally { confirming = false; updateStatus(); }
  if (!consent) return;
  busy = true; updateStatus();
  try {
    const pendingSources = context.sourcePending;
    await discardAudioContext(api, context, { consent: true, canContact: ready && !state.locked, signal: AbortSignal.timeout(8000) });
    if (pendingSources) { materials.discardCheckpoint(); if (generationCheckpoint?.lesson === currentLesson) generationCheckpoint = null; }
    message('generation-error');
  }
  catch (error) { context.notice = 'Audio was not discarded: ' + error.message + ' Source snapshots remain intact. Wait for running audio to finish, or retry local cleanup later.'; }
  finally { busy = false; updateStatus(); }
}

async function preview(kind, request, approvedSetup, { resume = false } = {}) {
  if (busy || settingsBusy || materials.busy || confirming || recording || !ready) return;
  if (!canRetainNextLesson()) return;
  const epoch = sessionEpoch; generationController = new AbortController();
  const signal = generationController.signal;
  const check = () => { if (epoch !== sessionEpoch || signal.aborted) throw new DOMException('Stopped. Your draft and completed preparation remain on this page.', 'AbortError'); };
  let checkpoint;
  if (kind === 'demo' && generationCheckpoint?.phase === 'retained') generationCheckpoint = null;
  if (kind !== 'demo') {
    if (resume) {
      checkpoint = generationCheckpoint;
      if (!checkpoint || checkpoint.unavailable || checkpoint.materials !== materialSignature()) { message('generation-error', 'The saved checkpoint is unavailable or attachments changed. No AI request was made.', 'error'); return; }
    } else {
      materials.discardCheckpoint();
      checkpoint = generationCheckpoint = { request: structuredClone(request), materials: materialSignature(), phase: 'preparation', prepared: null, unavailable: false,
        completeAudioPreparation: request.includeAudio && Boolean(approvedSetup.roles.speech) };
    }
    checkpoint.approvedSetup = approvedSetup;
  }
  busy = true; lastRequest = { kind, request }; stopPreviewAudio(); navigate('lesson'); tab('preview'); updateStatus();
  $('preview-empty').hidden = true; $('preview-error').hidden = true; $('preview-result').hidden = true; $('preview-loading').hidden = false;
  $('request-kind').textContent = kind === 'demo' ? 'LOCAL EXAMPLE' : 'CREATING YOUR LESSON';
  $('progress-title').textContent = kind === 'demo' ? 'Opening the example' : resume ? 'Continuing from your retained checkpoint' : 'Preparing your materials';
  $('progress-description').textContent = kind === 'demo' ? 'No AI credits are used.' : resume ? 'Completed preparation is reused. Only unfinished requests run after your renewed confirmation.' : 'Successful preparation is checkpointed on this page. A failed model response never triggers an automatic retry.';
  if (kind === 'demo') { lessonTrace = null; tracePanel.hidden = true; $('retry-preview').textContent = 'Try again'; } else beginTrace(approvedSetup, resume);
  const started = Date.now(); const tick = () => $('progress-elapsed').textContent = duration(Math.floor((Date.now() - started) / 1000)) + ' elapsed'; tick(); clock = setInterval(tick, 1000);
  try {
    let payload = request, audioSources = [];
    // Release fully exported server plans before their retained result could be evicted, including text-only/demo paths.
    await cleanCompletedAudio(signal); check();
    if (kind !== 'demo') {
      if (checkpoint.completeAudioPreparation) {
        $('progress-title').textContent = 'Checking local audio readiness and session capacity';
        await api('/audio/preflight', { method: 'POST', body: {}, signal }); check();
      }
      let prepared = checkpoint.prepared;
      if (!prepared) {
        const resumePreparation = resume && checkpoint.preparationStarted;
        checkpoint.preparationStarted = true;
        prepared = await materials.prepare({ consent: true, resume: Boolean(resumePreparation), completeAudio: checkpoint.completeAudioPreparation, goal: request.goal, roles: approvedSetup.roles, expectedSetupRevision: approvedSetup.revision, progress: text => { check(); const part = /^Processing part (\d+) of (\d+)/.exec(text); if (lessonTrace) { lessonTrace.part = part ? tracePart(Number(part[1]), Number(part[2])) : null; lessonTrace.cachedResults = materials.cache.size; renderGenerationCheckpoint(); renderTrace(); } $('progress-title').textContent = text; } });
      }
      if (checkpoint.unavailable) check();
      checkpoint.prepared = prepared; checkpoint.phase = 'lesson';
      renderGenerationCheckpoint(); check();
      // Complete source text travels one descriptor at a time, NEVER inside /lessons.
      const { audioSources: sources = [], ...lessonInput } = prepared; audioSources = sources;
      payload = { ...request, ...lessonInput, consent: true, includeAudio: false };
      $('progress-title').textContent = checkpoint.teachingResult ? 'Restoring the received text lesson locally' : 'Creating the final text lesson';
      $('progress-description').textContent = 'Sending bounded source notes and representative images. Complete English audio has a separate confirmation after the text is retained.';
    }
    check();
    const result = kind === 'demo' ? await api('/demo', { signal }) : checkpoint.teachingResult || await api('/lessons', { method: 'POST', body: payload, signal });
    if (checkpoint?.unavailable) check();
    // Pin acknowledged teaching before any local retention/rendering operation.
    // A local failure must never turn an accepted result into a new paid retry.
    if (checkpoint) checkpoint.teachingResult = result;
    // Retain a received teaching result BEFORE any subsequent local operation or error.
    currentLesson = { ...result, sample: kind === 'demo', sourceDescription: kind === 'demo' ? 'Hand-authored English sample · no uploaded material' : `${materials.items.length} original attachment(s) · ${materials.partCount} parts processed · ${payload.images.length} representative image(s)` };
    retainLesson(lessonHistory, currentLesson);
    if (kind !== 'demo' && audioDecision(request.audioMode, request.subject, result.lesson)) {
      currentLesson.audio = createAudioContext({ sources: audioSources, approvedSetup, input: payload, result });
      currentLesson.audio.sourcePending = !checkpoint.completeAudioPreparation;
      if (currentLesson.audio.sourcePending) currentLesson.audio.sourceMaterials = checkpoint.materials;
    }
    if (checkpoint) { checkpoint.phase = 'retained'; checkpoint.lesson = currentLesson; checkpoint.prepared = null; checkpoint.teachingResult = null; if (!currentLesson.audio?.sourcePending) materials.discardCheckpoint(); }
    displayLesson(); announce('Your text lesson is retained and ready to download.');
    if (currentLesson.audio) await runLessonAudio(currentLesson, { signal, sourceApproval: approvedSetup });
    if (lessonTrace) { lessonTrace.status = currentLesson.audio?.exportedComplete ? 'Complete audio retained' : currentLesson.audio ? 'Text retained; see audio status' : 'Completed'; lessonTrace.cachedResults = materials.cache.size; renderTrace(); tracePanel.open = Boolean(currentLesson.audio?.paused && !currentLesson.audio?.exportedComplete); }
    await refreshState(false);
  } catch (error) {
    if (lessonTrace) { lessonTrace.status = error.name === 'AbortError' ? 'Stopped' : 'Failed'; if (lessonTrace.operations.at(-1)?.status === 'Completed' || !lessonTrace.operations.length) lessonTrace.failedAt = { stage: 'Local preparation', part: lessonTrace.part, appStatus: error.status }; lessonTrace.cachedResults = materials.cache.size; renderTrace(); tracePanel.open = true; }
    $('preview-error').hidden = false;
    const failedStage = lessonTrace?.operations.at(-1);
    $('preview-error-message').textContent = (failedStage?.status === 'Failed' ? stageLabel(failedStage.stage) + ': ' : '') + error.message;
    $('preview-error-note').textContent = checkpoint?.unavailable ? 'The session changed. This checkpoint cannot resume; your draft and any retained HTML remain. No automatic paid retry was made.' : 'Your attachments, saved instructions, previous lesson and successful preparation checkpoints remain intact. Continue generation retries the unfinished step with renewed consent—not successful transcription, recognition or notes. A failed or unknown request may already have been billed. Keep this page open.';
    $('show-previous').hidden = !currentLesson; announce('Processing stopped. Your draft is intact.');
  } finally { clearInterval(clock); busy = false; generationController = null; $('preview-loading').hidden = true; updateStatus(); }
}
function displayLesson() {
  const result = currentLesson; if (!result) return;
  stopPreviewAudio();
  $('preview-result').hidden = false; $('preview-error').hidden = true; $('preview-empty').hidden = true; $('preview-loading').hidden = true;
  $('result-kind').textContent = result.sample ? 'HAND-AUTHORED EXAMPLE · NO AI CALL' : 'YOUR AI-ASSISTED LESSON';
  $('result-title').textContent = result.title;
  $('result-meta').replaceChildren(...[result.lesson.subject, result.lesson.level, result.lesson.language, 'Offline HTML'].map(text => element('span', text)));
  $('result-source').textContent = result.sourceDescription;
  $('warning-list').replaceChildren(...result.warnings.map(text => element('li', text))); $('result-warnings').hidden = !result.warnings.length;
  $('lesson-frame').srcdoc = result.html;
  if (downloadUrl) URL.revokeObjectURL(downloadUrl); downloadUrl = URL.createObjectURL(new Blob([result.html], { type: 'text/html;charset=utf-8' }));
  $('download-lesson').href = downloadUrl;
  $('download-lesson').download = 'LearnLens-' + result.title.replace(/[^\p{L}\p{N} _-]/gu, '').slice(0, 70).trim().replace(/\s+/g, '-') + '.html';
  $('preview-dot').hidden = false;
  $('review-note-text').textContent = 'This HTML includes styles, exercises, source images and audio included in the latest successful export. It needs no internet. Open in a browser rather than a file-manager preview. Review AI explanations and answers.';
  renderAudioStatus(); renderGenerationCheckpoint();
}
async function generate(event, { resume = false } = {}) {
  event?.preventDefault(); message('generation-error');
  if (busy || settingsBusy || confirming || materials.busy || !ready || micPending) return;
  const saved = generationCheckpoint;
  // Audio-only continuation retains no new lesson and does not need a primary
  // role. Every attempt that might retain another teaching result needs capacity.
  if (resume && saved?.phase === 'retained') {
    if (saved.unavailable || saved.materials !== materialSignature()) { message('generation-error', 'This checkpoint is unavailable or attachments changed. No AI request was made.', 'error'); return; }
    currentLesson = saved.lesson; displayLesson(); if (currentLesson.audio) await continueLessonAudio(); return;
  }
  if (!canRetainNextLesson()) return;
  if (!state.roles.primary) { navigate('providers', true); toast('Connect a provider and assign a primary lesson model.'); return; }
  if (recording) { message('generation-error', 'Stop recording before generating a lesson.', 'error'); return; }
  const audioMode = $('audio-mode').value;
  const draft = { language: chosenLanguage(), level: $('level').value, subject: chosenSubject(), goal: $('learning-goal').value.trim(), audioMode, includeAudio: audioDecision(audioMode, chosenSubject()) === true };
  // The ordinary create button also recognizes an unchanged interrupted request.
  if (!resume && saved && saved.phase !== 'retained' && !saved.unavailable && saved.materials === materialSignature() && requestSignature(saved.request) === requestSignature(draft)) resume = true;
  if (resume && (!saved || saved.unavailable || saved.materials !== materialSignature())) { message('generation-error', 'This checkpoint is unavailable or attachments changed. No AI request was made. Restore the attachments or explicitly start a new lesson.', 'error'); return; }
  const request = resume ? structuredClone(saved.request) : draft;
  if (!request.goal && !materials.items.length) { message('generation-error', 'Add material or ask a question in Instructions.', 'error'); $('learning-goal').focus(); return; }
  if (!request.language || !request.subject) { message('generation-error', 'Enter your chosen language and subject, or choose automatic detection.', 'error'); return; }
  if (materials.items.some(item => item.status !== 'ready')) { message('generation-error', 'Resume failed local imports before creating the lesson.', 'error'); return; }
  if (!resume && materials.needsTranscription && !state.roles.transcription) { message('generation-error', 'Assign a transcription role in AI providers for audio-only sources.', 'error'); return; }
  if (!resume && materials.needsVideoAnalysis && !state.roles.video) { message('generation-error', 'Assign an explicitly compatible native-video role in AI providers before analyzing whole videos.', 'error'); return; }
  if (!Number.isInteger(state.setupRevision)) { message('generation-error', 'Refresh AI setup before confirming: the server did not provide its setup revision.', 'error'); return; }
  const approvedSetup = approvedAudioSetup();
  request.expectedSetupRevision = approvedSetup.revision;
  const epoch = sessionEpoch; confirming = true; updateStatus();
  let consent;
  try {
    const info = resume ? checkpointMetadata() : null;
    const replace = !resume && saved && saved.phase !== 'retained' && !saved.unavailable;
    consent = await confirmAction({ title: resume ? 'Continue generation from the last checkpoint?' : replace ? 'Start a new lesson instead of continuing?' : 'Process all parts and create your lesson?', description: resume ? 'Reuse successful native-video analysis, transcription, image recognition and preparation notes. Only the failed/unknown step and remaining work can make new billable requests. The saved instructions/options are used; current form edits are not applied. Current confirmed model settings apply only to unfinished steps; earlier successful results may come from a previous model. Incomplete model output is not treated as a successful checkpoint.' : (replace ? 'Starting this changed request replaces the unfinished checkpoint and may repeat paid preparation. Cancel and use Continue generation to keep the saved request. ' : '') + 'Extracted text and images go to your primary provider; audio-only parts go to your transcription provider. Complete audiovisual analysis copies go to the separate video provider. Acquired originals remain private on this server. Redacted citation origins/paths may be shared with providers and included in the lesson; private fetch query tokens are omitted. This can make multiple billable calls. AI digests are lossy, not guaranteed verbatim; only representative preview images are embedded. Remove sensitive material before continuing.', detail: (resume ? `${info.completedCalls} successful preparation call(s) retained; ${info.completedParts}/${info.totalParts} parts prepared. ${info.preparationComplete ? 'Preparation is complete: retry only final lesson generation.' : 'Resume the unfinished preparation step, then generate the final lesson.'}\nNo successful checkpoint is evicted to make room for another request; quotas stop before new paid work. Failed/unknown attempts may already have been billed.\n` : '') + materials.describe({ completeAudio: request.includeAudio, roles: approvedSetup.roles }) + videoDisclosure(approvedSetup.roles) + '\nPrimary: ' + providerFor(approvedSetup.roles.primary)?.name + ' / ' + approvedSetup.roles.primary.model + '\nThinking: ' + (approvedSetup.roles.primary.reasoningEffort || 'model default') + '\n' + primaryWait(approvedSetup.roles.primary) + (materials.needsTranscription && approvedSetup.roles.transcription ? '\nSpeech-to-text: ' + providerFor(approvedSetup.roles.transcription)?.name + ' / ' + approvedSetup.roles.transcription.model + '\nTranscription API: ' + transcriptionMode(approvedSetup.roles.transcription) : '') + (audioDecision(request.audioMode, request.subject) !== false ? '\n' + (request.audioMode === 'auto' ? 'Automatic English audio: only for an English-learning subject, not merely English explanations. With Subject Auto, the normal teaching response classifies the lesson (not independently verified); other subjects skip extra audio recognition and speech. ' : 'Complete English audio requested. ') + 'Local encoder readiness/capacity is checked before source-audio recognition; managed assets may download, but preflight uses no AI. If English audio is selected, one potentially paid primary-model OCR call per extracted still/image may follow. Whole-video speech and visible words reuse accepted native analyses, never repeat video analysis, transcription or still OCR. This confirmation authorizes those conditional recognition requests. Missing speech setup keeps the text lesson while you configure it. After the source inventory, a separate confirmation shows the exact unique word/sentence clip count and speech provider/voice. All English word targets and sentences from both sources and the generated lesson are included, not just AI keywords. English/Latin matching is not reliable language identification; OCR/transcription may miss or misrecognize content. Native Kokoro is English-only. Your teaching language stays unchanged.' : '\nAudio is off for this request: no extra audio recognition or speech. Transcription needed to understand uploaded recordings is separate.'), paid: true, accept: resume ? 'Continue from checkpoint' : replace ? 'Replace checkpoint & create' : 'Process all parts & create' });
  } finally { confirming = false; updateStatus(); }
  if (consent && epoch === sessionEpoch) await preview('generate', request, approvedSetup, { resume });
}

async function toggleRecording() {
  if (recording) { recording.stop(); return; }
  if (busy || settingsBusy || confirming || materials.busy || micPending || !ready || state.locked || pendingAudioSources()) return;
  const epoch = sessionEpoch; micPending = true; updateStatus(); message('voice-message');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (epoch !== sessionEpoch) { stream.getTracks().forEach(track => track.stop()); return; }
    micStream = stream;
    const type = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus'].find(mime => MediaRecorder.isTypeSupported(mime));
    if (!type) throw new Error('No supported recording format. Upload an audio file instead.');
    recording = new MediaRecorder(stream, { mimeType: type }); const chunks = []; let recordingBytes = 0;
    const recorder = recording;
    recorder.ondataavailable = event => { if (event.data.size && epoch === sessionEpoch) { chunks.push(event.data); recordingBytes += event.data.size; if (recordingBytes > 1020 * 1024 * 1024 && recorder.state === 'recording') recorder.stop(); } };
    recorder.onstop = () => {
      stream.getTracks().forEach(track => track.stop()); micStream = null; recording = null; clearInterval(recordTimer);
      $('record-label').textContent = 'Record material'; $('recording-time').hidden = true; updateStatus();
      if (epoch === sessionEpoch) {
        const mime = type.split(';')[0]; const file = new File(chunks, `recording-${Date.now()}.${mime.split('/')[1]}`, { type: mime });
        addFiles([file]); message('voice-message', 'Recording added as material. Speech is automatically split; transcription requires confirmation when creating.');
      }
    };
    recorder.onerror = () => { message('voice-message', 'Recording failed. Upload an audio file instead.', 'error'); if (recorder.state !== 'inactive') recorder.stop(); stream.getTracks().forEach(track => track.stop()); };
    recorder.start(1000); $('record-label').textContent = 'Stop recording'; $('recording-time').hidden = false; $('recording-time').textContent = '0:00';
    const started = Date.now(); recordTimer = setInterval(() => { const seconds = Math.floor((Date.now() - started) / 1000); $('recording-time').textContent = duration(seconds); if (seconds > 0 && seconds % 300 === 0) void api('/state').catch(() => {}); if (seconds >= 14395 && recorder.state === 'recording') recorder.stop(); }, 1000);
  } catch (error) { micStream?.getTracks().forEach(track => track.stop()); recording = null; micStream = null; message('voice-message', error.name === 'NotAllowedError' ? 'Microphone access was declined. Upload audio or type your request.' : error.message, 'error'); }
  finally { micPending = false; updateStatus(); }
}

// Navigation and dialogs.
$$('[data-page]').forEach(button => button.addEventListener('click', event => { event.preventDefault(); navigate(button.dataset.page, true); }));
$$('[data-action="demo"]').forEach(button => button.onclick = () => preview('demo'));
for (const name of ['compose', 'preview']) { $('tab-' + name).onclick = () => tab(name); $('tab-' + name).onkeydown = event => { if (['ArrowLeft', 'ArrowRight'].includes(event.key)) { event.preventDefault(); const next = name === 'compose' ? 'preview' : 'compose'; tab(next); $('tab-' + next).focus(); } }; }
for (const id of ['empty-back-draft', 'error-back-draft', 'back-to-draft']) $(id).onclick = () => tab('compose');
$('show-previous').onclick = displayLesson;
$('switch-previous').onclick = () => {
  if (busy || settingsBusy || confirming || lessonHistory.length < 2) return;
  const index = lessonHistory.indexOf(currentLesson);
  currentLesson = lessonHistory[(index - 1 + lessonHistory.length) % lessonHistory.length];
  displayLesson();
};
$('continue-audio').onclick = () => continueLessonAudio();
$('download-partial').onclick = () => continueLessonAudio({ exportOnly: true });
$('stop-audio').onclick = () => cancelWork();
$('discard-audio').onclick = discardLessonAudio;
$('retry-preview').onclick = () => { if (lastRequest?.kind === 'demo') preview('demo'); else generate(undefined, { resume: true }); };
generationContinue.onclick = () => generate(undefined, { resume: true });
$('stop-processing').onclick = () => cancelWork();
$('dismiss-toast').onclick = () => $('toast').hidden = true;
$('retry-state').onclick = () => refreshState();
$('reload-session').onclick = async () => { if (await confirmAction({ title: 'Reload your session?', description: 'Download any finished lesson and copy your draft first. Reloading clears the current draft.', accept: 'Reload' })) location.reload(); };
$('clear-session').onclick = async () => {
  if (!await confirmAction({ title: 'Clear this browser’s session?', description: 'Your provider keys and custom model assignments will be removed. Included speech returns to its default where available. Your current draft stays on this page, but generation and audio continuation checkpoints become unavailable. Keep any downloaded lessons. Already submitted AI requests cannot be undone.', accept: 'Clear session' })) return;
  cancelWork(true);
  try { await api('/logout', { method: 'POST', body: {} }); lessonTrace = null; tracePanel.hidden = true; resetProviderForm(); await refreshState(); toast('Your provider settings were cleared.'); } catch (error) { toast(error.message); }
};
$('login-form').onsubmit = async event => {
  event.preventDefault(); $('login-button').disabled = true; message('login-message');
  try { await api('/login', { method: 'POST', body: { password: $('access-password').value } }); $('access-password').value = ''; await refreshState(); }
  catch (error) { message('login-message', error.message, 'error'); }
  finally { $('login-button').disabled = false; }
};
$('recommend-models').onclick = suggestModels;
$('dismiss-recommendations').onclick = () => { dismissRecommendations(); message('recommend-message'); updateStatus(); };
$('use-starter').onclick = async () => {
  if (!state.starter || busy || settingsBusy) return;
  if (roleDrafts.primary?.model && !await confirmAction({ title: 'Replace the primary model in your form?', description: state.starter.reason, accept: 'Use starter' })) return;
  roleDrafts.primary = { ...structuredClone(state.starter.role), timeoutSeconds: Number($('role-primary-timeout').value) }; renderRoles(); updateStatus();
  message('roles-message', 'Starter filled in, not saved or tested. You can now ask it for suggestions or save your model roles.');
};
$('apply-recommendations').onclick = () => {
  if (!recommendations || busy || settingsBusy) return;
  let count = 0;
  for (const item of recommendations.suggestions) {
    const checked = document.querySelector(`#recommend-cards input[data-role="${item.role}"]`)?.checked;
    if (checked && item.selection) { roleDrafts[item.role] = structuredClone(item.selection); count++; }
  }
  if (!count) { message('recommend-message', 'Check the model roles you want to use first.', 'warning'); return; }
  renderRoles(); updateStatus(); message('roles-message', `${count} suggestion(s) filled into the form. Review or change any field, then Save model roles.`);
  message('recommend-message', 'Suggestions copied to the form only. Your saved roles have not changed.');
};
$('cancel-provider-edit').onclick = () => { resetProviderForm(); message('provider-form-message'); };
$('provider-preset').onchange = () => {
  const id = editingProviderId, preset = $('provider-preset').value;
  if (!id) resetProviderForm(preset);
  else { $('provider-name').value = preset === 'openai' ? 'OpenAI' : ''; $('provider-url').value = preset === 'openai' ? 'https://api.openai.com/v1' : ''; $('provider-key').value = ''; }
  message('provider-form-message', 'Preset updated. Check the destination and enter a key for that provider. No connection has been made.');
};
$('toggle-key').onclick = () => { const show = $('provider-key').type === 'password'; $('provider-key').type = show ? 'text' : 'password'; $('toggle-key').setAttribute('aria-pressed', String(show)); $('toggle-key').setAttribute('aria-label', show ? 'Hide API key' : 'Show API key'); };
$('provider-form').onsubmit = async event => {
  event.preventDefault(); if (busy || settingsBusy) return; message('provider-form-message');
  const body = { name: $('provider-name').value.trim(), baseUrl: $('provider-url').value.trim(), apiKey: $('provider-key').value.trim() };
  if (!body.name || !body.baseUrl) { message('provider-form-message', 'Enter a provider name and API base URL.', 'error'); return; }
  settingsBusy = true; updateStatus();
  try { await api(editingProviderId ? '/providers/' + editingProviderId : '/providers', { method: editingProviderId ? 'PUT' : 'POST', body }); resetProviderForm(); await refreshState(); message('provider-form-message', 'Provider saved. Discover its models, use a starter primary if available, or enter an exact model ID below.'); toast('Provider saved. No inference request was made.'); }
  catch (error) { message('provider-form-message', error.message, 'error'); }
  finally { body.apiKey = ''; settingsBusy = false; updateStatus(); }
};
$('roles-form').onsubmit = async event => {
  event.preventDefault(); if (busy || settingsBusy) return; message('roles-message');
  const roles = Object.fromEntries(Object.entries(roleViews).map(([key, view]) => [key, view.readDraft()]));
  if (Object.values(roles).some(role => role && !role.model)) { message('roles-message', 'Choose a model ID for each selected provider, or leave that role unassigned.', 'error'); return; }
  settingsBusy = true; updateStatus();
  try { await api('/roles', { method: 'PUT', body: roles }); await refreshState(); message('roles-message', 'Model roles saved. Capability tests are optional.'); toast('Your model roles have been saved.'); }
  catch (error) { message('roles-message', error.message, 'error'); }
  finally { settingsBusy = false; updateStatus(); }
};
$('import-url').onclick = addUrlSource;
$('source-url').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); void addUrlSource(); } });
$('dropzone').onclick = () => { if (!$('dropzone').disabled) $('material-input').click(); };
$('material-input').onchange = async event => { await addFiles(event.target.files); event.target.value = ''; };
for (const type of ['dragenter', 'dragover']) $('dropzone').addEventListener(type, event => { event.preventDefault(); $('dropzone').classList.add('dragover'); });
for (const type of ['dragleave', 'drop']) $('dropzone').addEventListener(type, event => { event.preventDefault(); $('dropzone').classList.remove('dragover'); if (type === 'drop') addFiles(event.dataTransfer.files); });
window.addEventListener('dragover', event => event.preventDefault()); window.addEventListener('drop', event => event.preventDefault());
document.addEventListener('paste', event => {
  if (page !== 'lesson' || state.locked || busy || settingsBusy || confirming || recording || micPending || !ready || $('confirm-dialog').open || event.target.closest('input,textarea,[contenteditable="true"]')) return;
  const files = [...(event.clipboardData?.files || [])]; const text = event.clipboardData?.getData('text/plain');
  if (files.length || text?.trim()) { event.preventDefault(); addFiles(files.length ? files : [new File([text], 'Pasted notes.txt', { type: 'text/plain' })]); }
});
$('subject').onchange = () => { const custom = $('subject').value === 'custom'; $('custom-subject-field').hidden = !custom; $('custom-subject').disabled = !custom; updateSummary(); };
$('language').onchange = () => { const custom = $('language').value === 'custom'; $('custom-language-field').hidden = !custom; $('custom-language').disabled = !custom; updateSummary(); };
for (const id of ['learning-goal', 'custom-language', 'custom-subject', 'level', 'audio-mode']) $(id).addEventListener('input', updateSummary);
$$('[data-goal]').forEach(button => button.onclick = () => { const value = button.dataset.goal; const current = $('learning-goal').value; if (!current.includes(value)) $('learning-goal').value = (current + (current ? '\n' : '') + value).slice(0, 2000); button.setAttribute('aria-pressed', 'true'); updateSummary(); });
$('lesson-form').onsubmit = generate;
$('record-button').onclick = toggleRecording;
window.addEventListener('pagehide', () => { stopPreviewAudio(); cancelWork(); if (recording?.state === 'recording') recording.stop(); micStream?.getTracks().forEach(track => track.stop()); });
window.addEventListener('beforeunload', event => { if (busy || recording || materials.busy || lessonHistory.some(lesson => unfinishedAudio(lesson.audio))) { event.preventDefault(); event.returnValue = ''; } });
if (/Mac|iPhone|iPad/.test(navigator.platform)) $('paste-shortcut').textContent = '⌘ V';
if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) message('voice-message', 'Recording is unavailable here. Use HTTPS and a supported browser, or upload an audio file.');
await refreshState();
