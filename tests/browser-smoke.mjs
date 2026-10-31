// Run against a disposable headless Chromium debugging instance on :9333.
// Starts its own app + mock provider. No credentials, external services or paid AI.
import assert from 'node:assert/strict';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApp } from '../server.mjs';
import { probeImage } from '../lib/provider.mjs';
import { prepareAudioEncoder } from '../lib/audio-encode.mjs';
import { createQAProvider, wav, listen, close, importFixtures, sourceText, transcriptText, ocrText, longSentence, englishAudioLesson, mathAudioLesson, readingFixtures } from './browser-fixtures.mjs';
const publicDirectory = resolve(process.env.LEARNLENS_TEST_UI || 'public');
process.env.LEARNLENS_MEDIA_OFFLINE = '1';
// Node-side provider calls and tool acquisition must stay loopback/offline.
const realFetch = globalThis.fetch;
globalThis.fetch = (input, options) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('Browser smoke forbids non-loopback network');
  return realFetch(input, options);
};
const testLog = [], browserRequests = [], lifecycleFailures = [];
function passed(message) { testLog.push('PASS: ' + message); console.log('PASS: ' + message); }
let downloadComplete;
const downloadFinished = new Promise(resolve => { downloadComplete = resolve; });
const version = await (await fetch('http://127.0.0.1:9333/json/version', { signal: AbortSignal.timeout(5000) })).json();
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let seq = 0, browserContextId; const extraContexts = []; const pending = new Map(), errors = [], targets = [];
ws.onmessage = event => {
  const msg = JSON.parse(event.data);
  if (msg.method === 'Browser.downloadProgress' && msg.params.state === 'completed') downloadComplete();
  if (msg.method === 'Fetch.requestPaused') {
    const url = new URL(msg.params.request.url);
    const request = msg.params.request;
    browserRequests.push({ session: msg.sessionId, path: url.pathname, method: request.method, ...(url.pathname === '/api/lessons' && request.postData ? { includeAudio: JSON.parse(request.postData).includeAudio } : {}) });
    const allowed = ['about:', 'data:', 'blob:', 'file:'].includes(url.protocol) || ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if (!allowed) errors.push('Blocked unexpected non-loopback browser request');
    void call(allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest', { requestId: msg.params.requestId, ...(allowed ? {} : { errorReason: 'BlockedByClient' }) }, msg.sessionId).catch(() => {});
  }
  if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.text + ': ' + msg.params.exceptionDetails.exception?.description);
  if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') errors.push(msg.params.entry.text + (msg.params.entry.url ? ' [' + msg.params.entry.url + ']' : ''));
  if (pending.has(msg.id)) { const item = pending.get(msg.id); pending.delete(msg.id); clearTimeout(item.timer); msg.error ? item.reject(new Error(msg.error.message)) : item.resolve(msg.result); }
};
function call(method, params = {}, sessionId) { return new Promise((resolve, reject) => { const id = ++seq; const timer = setTimeout(() => { pending.delete(id); reject(new Error('Timeout: ' + method)); }, 15000); pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params, sessionId })); }); }
async function tab(url) { const { targetId } = await call('Target.createTarget', { url: 'about:blank', browserContextId }); targets.push(targetId); const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true }); await call('Runtime.enable', {}, sessionId); await call('Log.enable', {}, sessionId); await call('Page.enable', {}, sessionId); await call('Fetch.enable', { patterns: [{ urlPattern: '*' }] }, sessionId); await call('Page.navigate', { url }, sessionId); return sessionId; }
async function evaluate(session, expression, contextId) { const result = await call('Runtime.evaluate', { expression, contextId, returnByValue: true, awaitPromise: true }, session); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text); return result.result.value; }
async function wait(session, expression, timeout = 120000, contextId) { const start = Date.now(); while (!await evaluate(session, expression, contextId)) { if (Date.now() - start > timeout) throw new Error('Condition timed out: ' + expression); await new Promise(resolve => setTimeout(resolve, 80)); } }
async function consent(session) {
  await wait(session, 'document.getElementById("confirm-dialog").open');
  assert.equal(await evaluate(session, 'document.getElementById("confirm-accept").disabled'), true, 'Paid acceptance is disabled until consent');
  await evaluate(session, 'document.getElementById("confirm-consent").click();document.getElementById("confirm-accept").click()');
}
async function exactConsent(session, accept = true) {
  await wait(session, 'document.getElementById("confirm-dialog").open && /complete English audio/.test(document.getElementById("confirm-title").textContent)');
  assert.match(await evaluate(session, 'document.getElementById("confirm-description").textContent'), /\d+ unique clips exactly/);
  await evaluate(session, accept ? 'if(!document.getElementById("confirm-consent").closest("[hidden]"))document.getElementById("confirm-consent").click();document.getElementById("confirm-accept").click()' : 'document.getElementById("confirm-cancel").click()');
}
async function created(session) {
  await wait(session, 'document.getElementById("confirm-dialog").open || !document.getElementById("generate-button").disabled');
  if (await evaluate(session, 'document.getElementById("confirm-dialog").open')) await exactConsent(session);
  await wait(session, 'document.getElementById("preview-loading").hidden && (!document.getElementById("preview-result").hidden || !document.getElementById("preview-error").hidden) && !document.getElementById("generate-button").disabled');
  assert.equal(await evaluate(session, 'document.getElementById("preview-error").hidden'), true, await evaluate(session, 'document.getElementById("preview-error-message").textContent'));
}
async function attachments(session, count) {
  await wait(session, `document.querySelectorAll('#material-list > li').length === ${count} && document.getElementById('material-list').getAttribute('aria-busy') === 'false'`);
  assert.equal(await evaluate(session, 'document.querySelectorAll("#material-list .inline-message.error").length'), 0, await evaluate(session, 'document.getElementById("material-list").innerText'));
}
async function shot(session, name) { await call('Page.bringToFront', {}, session); const { data } = await call('Page.captureScreenshot', { format: 'png' }, session); await writeFile(resolve('artifacts/english-audio-browser', name), Buffer.from(data, 'base64')); }
async function upload(session, selector, files) { const { root } = await call('DOM.getDocument', {}, session); const { nodeId } = await call('DOM.querySelector', { nodeId: root.nodeId, selector }, session); await call('DOM.setFileInputFiles', { nodeId, files: files.map(file => resolve(file)) }, session); }
async function gesture(session, expression) {
  const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }, session);
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}
async function verifyFullPlayer(session, { synthetic = false } = {}) {
  await call('Page.bringToFront', {}, session);
  assert.equal(await evaluate(session, 'document.querySelectorAll("#course-player").length'), 1);
  assert.equal(await evaluate(session, 'document.getElementById("course-player").hasAttribute("src")'), false, 'No initial autoplay/source');
  assert.equal(await evaluate(session, '[...document.querySelectorAll("*")].some(n=>[...n.attributes].some(a=>/^on/i.test(a.name)))'), false, 'No injected handler attributes');
  assert.ok(await evaluate(session, '[...document.querySelectorAll("details")].some(d=>/answer/i.test(d.querySelector("summary")?.textContent)&&d.querySelector("[data-audio-unit]")&&!d.open)'), 'Answer controls are concealed in closed details');
  for (const speed of [1, .75, .5]) {
    await gesture(session, `document.querySelector('[data-speed="${speed}"]').click();document.querySelector('.word-play:not(:disabled)').click()`);
    await wait(session, 'document.getElementById("course-player").currentTime > .05');
    assert.equal(await evaluate(session, 'document.getElementById("course-player").playbackRate'), speed);
    assert.ok(await evaluate(session, 'document.getElementById("course-player").duration > 0'));
    await evaluate(session, 'document.getElementById("audio-stop").click()');
    assert.equal(await evaluate(session, 'document.getElementById("course-player").paused && !document.getElementById("course-player").hasAttribute("src")'), true);
  }
  for (const repeat of [1, 3, 5]) {
    await gesture(session, `document.querySelector('[data-speed="1"]').click();document.querySelector('[data-repeat="${repeat}"]').click();document.querySelector('.word-play:not(:disabled)').click()`);
    await wait(session, `document.getElementById('audio-status').textContent === 'Playing 1 / ${repeat}.'`);
    if (repeat > 1) await wait(session, `document.getElementById('audio-status').textContent === 'Playing 2 / ${repeat}.'`, 30000);
    if (synthetic) await wait(session, 'document.getElementById("audio-status").textContent === "Finished."', 30000);
    await evaluate(session, 'document.getElementById("audio-stop").click()');
  }
  await gesture(session, `document.querySelector('[data-repeat="5"]').click();document.querySelector('.sentence-play:not(:disabled)').click();document.querySelector('[data-repeat="1"]').click();document.querySelector('.word-play:not(:disabled)').click()`);
  assert.equal(await evaluate(session, 'document.getElementById("audio-status").textContent'), 'Playing 1 / 1.', 'Rapid new click cancels old repeated sentence queue');
  await evaluate(session, 'document.getElementById("audio-stop").click()');
  if (synthetic) {
    const pieces = await gesture(session, `(()=>{const b=[...document.querySelectorAll('.sentence-play')].find(b=>b.dataset.clips.split(' ').length>1);if(!b)throw Error('Long sentence missing');for(let p=b.parentElement;p;p=p.parentElement)if(p.tagName==='DETAILS')p.open=true;b.click();return b.dataset.clips.split(' ').length})()`);
    assert.ok(pieces > 1, '>500-character sentence split into sequenced clips');
    await wait(session, `document.getElementById('audio-status').textContent === 'Playing 2 / ${pieces}.'`, 10000);
    await wait(session, 'document.getElementById("audio-status").textContent === "Finished."', 20000);
  }
  await gesture(session, `(()=>{const d=[...document.querySelectorAll('details')].find(d=>/answer/i.test(d.querySelector('summary')?.textContent)&&d.querySelector('.word-play:not(:disabled)'));d.open=true;d.querySelector('.word-play:not(:disabled)').click()})()`);
  await wait(session, 'document.getElementById("course-player").currentTime > .05');
  await evaluate(session, 'document.querySelector("[aria-current=true]").closest("details").open=false');
  await wait(session, 'document.getElementById("course-player").paused && !document.getElementById("course-player").hasAttribute("src")');
  await call('Emulation.setDeviceMetricsOverride', { width: 320, height: 700, deviceScaleFactor: 1, mobile: true }, session);
  assert.equal(await evaluate(session, 'document.documentElement.scrollWidth <= innerWidth'), true, 'Full offline course fits 320px');
  assert.deepEqual(await evaluate(session, 'performance.getEntriesByType("resource").filter(r=>/^https?:/.test(r.name)).map(r=>r.name)'), []);
  passed('full offline player: actual MP3 decode/playback, single player, speeds, natural ended repeat progression, Stop/rapid replacement, hidden answers/collapse, long sentence pieces and 320px');
}
async function setAudioMode(session, mode) {
  await evaluate(session, `document.getElementById('audio-mode').value=${JSON.stringify(mode)};document.getElementById('audio-mode').dispatchEvent(new Event('input'));document.getElementById('audio-mode').dispatchEvent(new Event('change'))`);
  assert.equal(await evaluate(session, 'document.getElementById("audio-mode").value'), mode);
}
async function audioFixtureTab(origin, providerOrigin, { speech = true } = {}) {
  const original = browserContextId;
  ({ browserContextId } = await call('Target.createBrowserContext'));
  const context = browserContextId; extraContexts.push(context);
  let session;
  try { session = await tab(origin); } finally { browserContextId = original; }
  await wait(session, 'document.getElementById("setup-label")?.textContent === "Connect your AI"');
  assert.deepEqual(await evaluate(session, `(()=>{const n=document.getElementById('audio-mode');return [n.tagName,n.value,[...n.options].map(o=>o.value),document.getElementById('include-audio')===null]})()`), ['SELECT', 'auto', ['auto', 'on', 'off'], true]);
  await evaluate(session, `document.querySelector('[data-page="providers"]').click();document.getElementById('provider-name').value='English audio synthetic QA';document.getElementById('provider-url').value=${JSON.stringify(providerOrigin + '/v1')};document.getElementById('provider-form').requestSubmit()`);
  await wait(session, '!!document.querySelector(".provider-name")');
  await evaluate(session, 'document.querySelector(".discover-button").click()');
  await wait(session, 'document.querySelector(".provider-model-count")?.textContent === "4 listed models"');
  await evaluate(session, `document.getElementById('role-speech-engine').value='provider';document.getElementById('role-speech-engine').dispatchEvent(new Event('change'));for(const [role,model] of ${JSON.stringify([['primary','test/vision'], ['transcription','test/transcribe'], ...(speech ? [['speech','test/speech']] : [])])}){const p=document.getElementById('role-'+role+'-provider');p.selectedIndex=1;p.dispatchEvent(new Event('change'));const m=document.getElementById('role-'+role+'-model');m.value=model;m.dispatchEvent(new Event('change'))}document.getElementById('roles-form').requestSubmit()`);
  await wait(session, `document.getElementById('setup-count').textContent === '${speech ? 3 : 2}/3' && !document.getElementById('roles-fields').disabled`);
  await evaluate(session, 'document.querySelector("[data-page=lesson]").click();document.getElementById("tab-compose").click()');
  return { session, context };
}
async function tabInContext(origin, context) {
  const previous = browserContextId; browserContextId = context;
  try { return await tab(origin); } finally { browserContextId = previous; }
}
const audioCounts = qa => Object.fromEntries(['transcription', 'digest', 'lesson', 'audio-extract', 'speech'].map(kind => [kind, qa.calls.filter(c => c.kind === kind).length]));
const audioRequests = (session, from = 0) => browserRequests.slice(from).filter(r => r.session === session && /^\/api\/audio\//.test(r.path));
async function retainedAudioIdle(session) {
  await wait(session, '!document.getElementById("preview-result").hidden && document.getElementById("preview-loading").hidden && !document.getElementById("continue-audio").hidden && !document.getElementById("continue-audio").disabled && !document.getElementById("confirm-dialog").open');
  assert.equal(await evaluate(session, 'document.getElementById("preview-error").hidden'), true, 'An audio failure cannot discard the text lesson');
  assert.match(await evaluate(session, 'document.getElementById("download-lesson").href'), /^blob:/);
}
async function spyRetainedText(session, title) {
  // Passive observation only: forward the same request/arguments and unmodified response.
  await evaluate(session, `window.__audioDispatch=[];window.__audioOriginalFetch=window.fetch;window.fetch=function(input,options){const path=new URL(typeof input==='string'?input:input.url,location.href).pathname;if(path.startsWith('/api/audio/'))window.__audioDispatch.push({path,retained:!document.getElementById('preview-result').hidden&&document.getElementById('lesson-frame').srcdoc.includes(${JSON.stringify(title)})});return window.__audioOriginalFetch.call(this,input,options)}`);
}
async function initialAudioConsent(session, qa, requestStart) {
  const before = qa.calls.length;
  await evaluate(session, 'document.getElementById("lesson-form").requestSubmit()');
  await wait(session, 'document.getElementById("confirm-dialog").open');
  assert.equal(qa.calls.length, before, 'Opening initial consent dispatches no provider call');
  assert.deepEqual(audioRequests(session, requestStart), [], 'No audio preflight, extraction or plan before initial consent');
  await evaluate(session, 'document.getElementById("confirm-cancel").click()');
  await wait(session, '!document.getElementById("generate-button").disabled');
  assert.equal(qa.calls.length, before, 'Cancelling initial consent is AI-free');
  assert.deepEqual(audioRequests(session, requestStart), []);
  await evaluate(session, 'document.getElementById("lesson-form").requestSubmit()');
  await consent(session);
}
async function releaseAudioFixtureSession(session) {
  // Tests share an app instance with real global reservations: free this synthetic
  // session's finished plans/originals rather than raising production quota limits.
  await evaluate(session, 'document.getElementById("clear-session").click()');
  await wait(session, 'document.getElementById("confirm-dialog").open');
  await evaluate(session, 'document.getElementById("confirm-accept").click()');
  await wait(session, 'document.getElementById("setup-label").textContent === "Connect your AI" && !document.getElementById("confirm-dialog").open');
}
async function exactAudioCount(session) {
  const exactOpen = 'document.getElementById("confirm-dialog").open && /complete English audio/.test(document.getElementById("confirm-title").textContent)';
  await wait(session, `(${exactOpen}) || (!document.getElementById('confirm-dialog').open && !document.getElementById('preview-result').hidden && !document.getElementById('continue-audio').hidden && !document.getElementById('continue-audio').disabled && document.getElementById('audio-message').textContent.length>0)`);
  if (!await evaluate(session, exactOpen)) {
    const failure = await evaluate(session, '({notice:document.getElementById("audio-message").textContent,operation:document.getElementById("audio-operation").textContent,report:JSON.parse(document.getElementById("diagnostic-report").textContent)})');
    await writeFile(resolve('artifacts/english-audio-browser/exact-consent-failure.json'), JSON.stringify(failure, null, 2));
    await shot(session, 'exact-consent-failure.png');
    throw new Error('Expected exact-count consent; audio paused: ' + failure.notice);
  }
  assert.equal(await evaluate(session, 'document.getElementById("confirm-accept").disabled'), true, 'Remote exact-count consent is required before any clip');
  const description = await evaluate(session, 'document.getElementById("confirm-description").textContent');
  const count = Number(description.match(/(\d+) unique clips exactly/)?.[1]);
  assert.ok(Number.isSafeInteger(count) && count > 0, 'Exact unique clip count is displayed');
  return count;
}
async function checkSpeechCount(session, qa, count) {
  await wait(session, '!document.getElementById("generate-button").disabled && document.getElementById("continue-audio").hidden');
  const inputs = qa.calls.filter(c => c.kind === 'speech').map(c => c.body.input);
  assert.equal(inputs.length, count, 'Consent count equals actual speech request count');
  assert.equal(new Set(inputs).size, count, 'Every exact unique clip is sent once, including reused word forms');
  assert.match(await evaluate(session, 'document.getElementById("audio-count").textContent'), new RegExp(`^${count}/${count}.*complete`));
  return inputs;
}
async function assertSourceLock(session, qa) {
  const before = qa.calls.length, html = await evaluate(session, 'document.getElementById("lesson-frame").srcdoc');
  const ids = await evaluate(session, '[...document.querySelectorAll("#material-list details")].map(n=>n.dataset.id)');
  assert.equal(await evaluate(session, 'document.getElementById("generate-button").disabled && document.getElementById("material-input").disabled && document.getElementById("dropzone").disabled && document.getElementById("record-button").disabled'), true, 'Pending source inventory locks creation and attachment entry points');
  assert.equal(await evaluate(session, '[...document.querySelectorAll("#material-list button,[data-action=demo]")].every(n=>n.disabled)'), true, 'Pending source inventory locks remove/retry and demo');
  // requestSubmit bypasses a disabled submit button: the handler still must reject it.
  await evaluate(session, 'document.getElementById("lesson-form").requestSubmit();document.querySelector("[data-action=demo]").click();document.querySelector("#material-list button")?.click()');
  assert.equal(await evaluate(session, 'document.getElementById("confirm-dialog").open'), false);
  assert.equal(await evaluate(session, 'document.getElementById("lesson-frame").srcdoc'), html);
  assert.deepEqual(await evaluate(session, '[...document.querySelectorAll("#material-list details")].map(n=>n.dataset.id)'), ids);
  assert.equal(qa.calls.length, before, 'Blocked replacement makes no provider request');
}
async function verifyReadingPausesOffline(session, qa, count) {
  const inputs = qa.calls.filter(c => c.kind === 'speech').map(c => c.body.input);
  for (const [raw, spoken] of [[readingFixtures.body, readingFixtures.spokenBody], [readingFixtures.question, readingFixtures.spokenQuestion], [readingFixtures.answer, readingFixtures.spokenAnswer], [readingFixtures.audio, readingFixtures.spokenAudio]]) {
    assert.ok(inputs.includes(spoken), 'Actual speech wire contains normalized pause: ' + spoken);
    assert.ok(!inputs.includes(raw), 'Marked spaced slash is not sent to speech: ' + raw);
  }
  assert.ok(inputs.includes('Choose and / or for alternatives.'), 'Unmarked alternatives keep meaningful spaced slashes');
  assert.ok(inputs.includes('Compare 3/4 and m/s.'), 'Fractions and units remain unchanged on speech wire');
  assert.ok(inputs.includes(readingFixtures.uploaded), 'Uploaded slashes are not guessed to be reading markup');
  const html = await evaluate(session, 'document.getElementById("lesson-frame").srcdoc');
  const file = resolve('artifacts/english-audio-browser/english-auto-pauses-offline.html');
  await writeFile(file, html);
  const offline = await tab(pathToFileURL(file).href);
  await call('Network.enable', {}, offline);
  await call('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 }, offline);
  await call('Page.reload', {}, offline);
  await wait(offline, '!!document.getElementById("course-player")');
  assert.equal(await evaluate(offline, 'document.documentElement.lang'), 'zh', 'English-subject audio does not change Chinese explanation language');
  for (const raw of [readingFixtures.body, readingFixtures.question, readingFixtures.answer, readingFixtures.meaningful, readingFixtures.uploaded]) assert.equal(await evaluate(offline, `document.body.textContent.includes(${JSON.stringify(raw)})`), true, 'Offline display preserves original: ' + raw);
  const answerSelector = `.sentence-play[aria-label=${JSON.stringify('Play sentence: ' + readingFixtures.answer)}]`;
  const answerState = await evaluate(offline, `(()=>{const b=document.querySelector(${JSON.stringify(answerSelector)});return {exists:!!b,disabled:b?.disabled,open:b?.closest('details')?.open,visible:b?.checkVisibility()}})()`);
  assert.deepEqual(answerState, { exists: true, disabled: false, open: false, visible: false }, 'Answer and its playback remain concealed until reveal');
  assert.equal(await evaluate(offline, 'document.getElementById("course-player").hasAttribute("src")'), false, 'No autoplay');
  await gesture(offline, `const b=document.querySelector(${JSON.stringify(answerSelector)});b.closest('details').open=true;b.click()`);
  await wait(offline, 'document.getElementById("course-player").currentTime > .05');
  assert.ok(await evaluate(offline, 'document.getElementById("course-player").duration > 0'), 'Normalized sentence uses a decodable MP3');
  await evaluate(offline, `document.querySelector(${JSON.stringify(answerSelector)}).closest('details').open=false`);
  await wait(offline, 'document.getElementById("course-player").paused && !document.getElementById("course-player").hasAttribute("src")');
  for (const width of [390, 320]) {
    await call('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: true }, offline);
    assert.equal(await evaluate(offline, 'document.documentElement.scrollWidth <= innerWidth'), true, width + 'px reading pause/answer layout');
  }
  assert.deepEqual(await evaluate(offline, 'performance.getEntriesByType("resource").filter(r=>/^https?:/.test(r.name)).map(r=>r.name)'), []);
  await shot(offline, 'english-auto-pauses-offline.png');
  englishAudioEvidence.push({ case: 'reading-pauses-wire-offline', count, normalizedInputs: [readingFixtures.spokenBody, readingFixtures.spokenQuestion, readingFixtures.spokenAnswer, readingFixtures.spokenAudio], unmarkedInputs: [readingFixtures.uploaded, 'Choose and / or for alternatives.', 'Compare 3/4 and m/s.'], export: file });
  passed('reading pauses: marked sections/questions/answers/audio normalize actual provider input to commas; unmarked meaningful/uploaded slashes stay; original offline markers and concealed answers retained; MP3 playback/collapse, Chinese language and 320px');
}
async function verifyVideoSourceConsent(origin, textFile) {
  const fixtures = await importFixtures(resolve('artifacts/english-audio-browser/english-video-fixtures'), { media: true });
  const video = fixtures.media.find(file=>file.endsWith('movie.mp4'));
  assert.ok(video, 'Generic native video fixture exists');
  const qa = createQAProvider({ lesson: englishAudioLesson() }); englishAudioProviders.push(qa);
  const { session } = await audioFixtureTab(origin, await listen(qa.server));
  await upload(session, '#material-input', [video]); await attachments(session, 1);
  const visuals = await evaluate(session, 'document.querySelectorAll("#material-list > li:first-child .material-visuals img").length');
  assert.ok(visuals > 0, 'Video prepares real stills before text preview clears them');
  await upload(session, '#material-input', [textFile]); await attachments(session, 2);
  assert.equal(await evaluate(session, 'document.querySelectorAll("#material-list > li:first-child .material-visuals img").length'), 0, 'Loading text preview clears disposable video previews');
  const start = browserRequests.length;
  qa.config.audioExtractFailAt = 1;
  await initialAudioConsent(session, qa, start); await retainedAudioIdle(session);
  assert.deepEqual(audioCounts(qa), { transcription: 1, digest: 1, lesson: 1, 'audio-extract': 1, speech: 0 });
  await evaluate(session, 'document.getElementById("continue-audio").click()');
  await wait(session, 'document.getElementById("confirm-dialog").open');
  assert.equal(await evaluate(session, 'document.getElementById("confirm-title").textContent'), 'Prepare remaining English audio sources?');
  assert.equal(await evaluate(session, 'document.getElementById("confirm-consent").closest("[hidden]") === null && !document.getElementById("confirm-consent").checked && document.getElementById("confirm-accept").disabled'), true, 'Durable video manifest requires explicit paid OCR consent even with no retained preview images');
  const before = qa.calls.length;
  await evaluate(session, 'document.getElementById("confirm-accept").click()');
  assert.equal(await evaluate(session, 'document.getElementById("confirm-dialog").open'), true);
  assert.equal(qa.calls.length, before, 'Disabled acceptance cannot dispatch paid video OCR');
  await shot(session, 'video-text-cleared-preview-paid-consent.png');
  await evaluate(session, 'document.getElementById("confirm-cancel").click()'); await retainedAudioIdle(session);
  assert.equal(qa.calls.length, before);
  qa.config.audioExtractFailAt = null;
  await evaluate(session, 'document.getElementById("continue-audio").click()'); await consent(session);
  const count = await exactAudioCount(session);
  assert.deepEqual(audioCounts(qa), { transcription: 1, digest: 1, lesson: 1, 'audio-extract': visuals + 1, speech: 0 }, 'Only failed/remaining video OCR is dispatched after checkbox consent');
  await exactConsent(session, false); await retainedAudioIdle(session);
  englishAudioEvidence.push({ case: 'video-source-consent', originalVisualCount: visuals, previewVisualsAfterText: 0, paidCheckboxRequired: true, exactClips: count, counts: audioCounts(qa) });
  passed('video + text: clearing disposable video preview images cannot hide the paid pending-OCR checkbox; cancelled/unchecked consent dispatches nothing; only remaining OCR resumes, with no STT/digest/teaching replay');
  await releaseAudioFixtureSession(session);
}
async function verifyRetentionResumeGuard(origin) {
  const qa = createQAProvider({ lesson: englishAudioLesson({ title: 'First retained audio lesson' }) }); englishAudioProviders.push(qa);
  const { session } = await audioFixtureTab(origin, await listen(qa.server));
  await setAudioMode(session, 'on');
  await evaluate(session, 'document.getElementById("learning-goal").value="First retained audio fixture";document.getElementById("learning-goal").dispatchEvent(new Event("input"))');
  await initialAudioConsent(session, qa, browserRequests.length);
  const count = await exactAudioCount(session);
  await exactConsent(session, false); await retainedAudioIdle(session);
  const firstHtml = await evaluate(session, 'document.getElementById("lesson-frame").srcdoc');
  assert.deepEqual(audioCounts(qa), { transcription: 0, digest: 0, lesson: 1, 'audio-extract': 0, speech: 0 });
  await setAudioMode(session, 'off');
  qa.config.failKind = 'lesson';
  await evaluate(session, 'document.getElementById("tab-compose").click();document.getElementById("learning-goal").value="Second failed lesson fixture";document.getElementById("learning-goal").dispatchEvent(new Event("input"));document.getElementById("lesson-form").requestSubmit()');
  await consent(session);
  await wait(session, '!document.getElementById("preview-error").hidden && !document.getElementById("generate-button").disabled');
  assert.equal(audioCounts(qa).lesson, 2);
  qa.config.failKind = null; qa.config.lesson.title = 'Recovered second text lesson';
  await evaluate(session, 'document.querySelector("[data-action=demo]").click()'); await created(session);
  const demoHtml = await evaluate(session, 'document.getElementById("lesson-frame").srcdoc');
  assert.match(await evaluate(session, 'document.getElementById("result-kind").textContent'), /HAND-AUTHORED/);
  await wait(session, '!document.getElementById("continue-generation").hidden && !document.getElementById("continue-generation").disabled');
  const before = qa.calls.length, requests = browserRequests.length;
  for (let attempt = 0; attempt < 2; attempt++) {
    await evaluate(session, 'document.getElementById("continue-generation").click()');
    assert.equal(await evaluate(session, 'document.getElementById("confirm-dialog").open'), false, 'Retention guard blocks paid teaching resume before confirmation');
    assert.match(await evaluate(session, 'document.getElementById("generation-error").textContent'), /oldest.*unfinished audio/i);
    assert.equal(await evaluate(session, 'document.getElementById("lesson-frame").srcdoc'), demoHtml);
    assert.equal(qa.calls.length, before, 'Repeated Continue cannot pay for teaching that cannot be retained');
  }
  assert.equal(browserRequests.slice(requests).filter(r=>r.session===session && r.path==='/api/lessons').length, 0);
  await shot(session, 'retention-blocked-teaching-resume.png');
  await evaluate(session, 'document.getElementById("switch-previous").click()');
  assert.equal(await evaluate(session, 'document.getElementById("lesson-frame").srcdoc'), firstHtml);
  await evaluate(session, 'document.getElementById("continue-audio").click()');
  await wait(session, 'document.getElementById("confirm-dialog").open');
  assert.match(await evaluate(session, 'document.getElementById("confirm-title").textContent'), /Resume this retained/);
  await evaluate(session, 'document.getElementById("confirm-accept").click()');
  assert.equal(await exactAudioCount(session), count, 'Audio-only recovery is still allowed while new lesson retention is blocked');
  await exactConsent(session, false); await retainedAudioIdle(session);
  assert.equal(qa.calls.length, before);
  await evaluate(session, 'document.getElementById("discard-audio").click()');
  await wait(session, 'document.getElementById("confirm-dialog").open');
  await evaluate(session, 'document.getElementById("confirm-accept").click()');
  await wait(session, 'document.getElementById("continue-audio").hidden && !document.getElementById("generate-button").disabled');
  await evaluate(session, 'document.getElementById("continue-generation").click()');
  await wait(session, 'document.getElementById("confirm-dialog").open');
  assert.equal(await evaluate(session, 'document.getElementById("confirm-title").textContent'), 'Continue generation from the last checkpoint?');
  await consent(session); await created(session);
  assert.equal(await evaluate(session, 'document.getElementById("result-title").textContent'), 'Recovered second text lesson');
  assert.deepEqual(audioCounts(qa), { transcription: 0, digest: 0, lesson: 3, 'audio-extract': 0, speech: 0 }, 'After explicit discard, exactly one B teaching retry can be retained');
  englishAudioEvidence.push({ case: 'retention-resume-guard', blockedTeachingAttempts: 2, audioOnlyContinuationAllowed: true, counts: audioCounts(qa) });
  passed('retention guard: A unfinished audio + failed B + demo cannot pay for unretainable B on repeated Continue; A audio-only recovery remains allowed; Discard unlocks exactly one B teaching retry');
  await releaseAudioFixtureSession(session);
}
async function runEnglishAudioChecks(origin) {
  const selectedCases = (process.env.LEARNLENS_BROWSER_CASES || '').split(',').filter(Boolean);
  const wanted = name => !selectedCases.length || selectedCases.includes(name);
  const screenshot = resolve('artifacts/english-audio-browser/test-screenshot.png');
  const screenshot2 = resolve('artifacts/english-audio-browser/second-synthetic-image.png');
  const text = resolve('artifacts/english-audio-browser/reading-pauses-source.md');
  const audio = resolve('artifacts/english-audio-browser/test-audio.wav');
  await writeFile(text, readingFixtures.uploaded);
  const matrix = [
    { name: 'auto-english-chinese', lesson: englishAudioLesson(), mode: 'auto', subject: 'Auto', audio: true, deferred: true },
    { name: 'auto-math-english', lesson: mathAudioLesson(), mode: 'auto', subject: 'Auto', audio: false },
    { name: 'auto-legacy-muffin', lesson: { ...mathAudioLesson(), title: 'Synthetic baking lesson', subject: 'English muffin baking', englishLearning: undefined, summary: 'Learn to bake muffins, not study the English language.', objectives: ['Mix dough.'], sections: [{ type: 'steps', title: 'Mix dough', body: 'Mix flour and milk. Cook the shaped dough.', items: [], question: '', answer: '', translation: '', source: '' }] }, mode: 'auto', subject: 'Auto', audio: false },
    { name: 'on-nonenglish', lesson: mathAudioLesson(), mode: 'on', subject: 'Mathematics', audio: true },
    { name: 'off-english', lesson: englishAudioLesson(), mode: 'off', subject: 'English', audio: false },
    { name: 'selected-english-false-metadata', lesson: englishAudioLesson({ englishLearning: false, subject: 'Unclassified material' }), mode: 'auto', subject: 'English', audio: true },
    { name: 'selected-math-true-metadata', lesson: englishAudioLesson(), mode: 'auto', subject: 'Mathematics', audio: false },
  ];
  const allowed = [...matrix.map(c=>c.name), 'deferred-ocr-resume', 'missing-speech', 'pending-discard', 'video-source-consent', 'retention-resume-guard'];
  assert.ok(selectedCases.every(name=>allowed.includes(name)), 'Unknown LEARNLENS_BROWSER_CASES value');
  for (const spec of matrix.filter(c=>wanted(c.name))) {
    const qa = createQAProvider({ lesson: spec.lesson }); englishAudioProviders.push(qa);
    const providerOrigin = await listen(qa.server);
    const { session } = await audioFixtureTab(origin, providerOrigin);
    await setAudioMode(session, spec.mode);
    await evaluate(session, `document.getElementById('learning-goal').value='Synthetic subject policy evidence';document.getElementById('learning-goal').dispatchEvent(new Event('input'));document.getElementById('language').value=${JSON.stringify(spec.lesson.language)};document.getElementById('language').dispatchEvent(new Event('change'));${spec.subject === 'Auto' ? '' : `document.getElementById('subject').value='custom';document.getElementById('subject').dispatchEvent(new Event('change'));document.getElementById('custom-subject').value=${JSON.stringify(spec.subject)};document.getElementById('custom-subject').dispatchEvent(new Event('input'));`}`);
    await spyRetainedText(session, spec.lesson.title);
    const beforeUpload = qa.calls.length, requestStart = browserRequests.length;
    await upload(session, '#material-input', [screenshot, text, audio]); await attachments(session, 3);
    assert.equal(qa.calls.length, beforeUpload, 'Synthetic imports are AI-free');
    await initialAudioConsent(session, qa, requestStart);
    let clips = 0;
    if (spec.audio) {
      clips = await exactAudioCount(session);
      assert.equal(audioCounts(qa).speech, 0, 'All speech waits for exact unique clip consent');
      assert.equal(await evaluate(session, 'document.getElementById("preview-result").hidden'), false, 'Text retained before speech consent');
      assert.equal(audioCounts(qa)['audio-extract'], 1);
      if (spec.deferred) {
        assert.equal(qa.calls.slice(0, qa.calls.findIndex(c=>c.kind==='lesson')).filter(c=>c.kind==='audio-extract').length, 0, 'Subject Auto performs no extra OCR before normal teaching');
        const requests = browserRequests.slice(requestStart).filter(r=>r.session===session);
        const teachingIndex = requests.findIndex(r=>r.path==='/api/lessons');
        assert.ok(teachingIndex >= 0);
        assert.equal(requests.slice(0, teachingIndex).filter(r=>r.path.startsWith('/api/audio/')).length, 0, 'Auto has no preflight, extraction or plan before classification');
        assert.ok(requests.slice(teachingIndex + 1).some(r=>/\/parts$/.test(r.path)), 'Inventory-only upgrade rereads local media parts, while reusing the paid transcript');
        assert.equal(await evaluate(session, 'window.__audioDispatch.every(e=>e.retained)'), true, 'Every deferred audio request sees the retained text lesson');
      } else assert.ok(qa.calls.findIndex(c=>c.kind==='audio-extract') < qa.calls.findIndex(c=>c.kind==='lesson'), 'Manual On/selected English retains consented eager complete-audio preparation');
      await exactConsent(session); await checkSpeechCount(session, qa, clips);
      if (spec.name === 'auto-english-chinese') await verifyReadingPausesOffline(session, qa, clips);
    } else {
      await created(session);
      assert.deepEqual(audioRequests(session, requestStart), [], 'Off/non-English dispatches no audio preflight, OCR, plan or speech');
      assert.equal(await evaluate(session, 'document.getElementById("audio-progress-panel").hidden'), true);
    }
    assert.deepEqual({ ...audioCounts(qa), speech: 0 }, { transcription: 1, digest: 1, lesson: 1, 'audio-extract': spec.audio ? 1 : 0, speech: 0 }, 'Normal teaching preparation is neither skipped nor replayed');
    assert.equal(audioCounts(qa).speech, clips);
    const teachingRequests = browserRequests.slice(requestStart).filter(r=>r.session===session && r.path==='/api/lessons');
    assert.equal(teachingRequests.length, 1); assert.equal(teachingRequests[0].includeAudio, false);
    const teaching = qa.calls.find(c=>c.kind==='lesson').body.input[0].content[0].text;
    assert.ok(teaching.includes(spec.lesson.language), 'Explanation language reaches teaching independently');
    englishAudioEvidence.push({ case: spec.name, subject: spec.lesson.subject, ...(typeof spec.lesson.englishLearning === 'boolean' ? { englishLearning: spec.lesson.englishLearning } : { metadataAbsent: true }), counts: audioCounts(qa), uniqueClips: clips, includeAudio: teachingRequests[0].includeAudio });
    passed(spec.name + ': explicit subject/metadata/mode precedence, explanation-language independence, normal teaching once, paid consent and exact clip accounting');
    await releaseAudioFixtureSession(session);
  }
  for (const name of ['deferred-ocr-resume', 'missing-speech', 'pending-discard'].filter(wanted)) {
    const qa = createQAProvider({ lesson: englishAudioLesson() }); englishAudioProviders.push(qa);
    const providerOrigin = await listen(qa.server);
    const missing = name !== 'deferred-ocr-resume';
    const { session, context } = await audioFixtureTab(origin, providerOrigin, { speech: !missing });
    const secondImage = await evaluate(session, `(()=>{const canvas=document.createElement('canvas');canvas.width=16;canvas.height=16;const context=canvas.getContext('2d');context.fillStyle='#2345cd';context.fillRect(0,0,16,16);return canvas.toDataURL('image/png')})()`);
    await writeFile(screenshot2, Buffer.from(secondImage.split(',')[1], 'base64'));
    const requestStart = browserRequests.length;
    await spyRetainedText(session, qa.config.lesson.title);
    await evaluate(session, 'document.getElementById("learning-goal").value="Pinned synthetic inventory";document.getElementById("learning-goal").dispatchEvent(new Event("input"));document.getElementById("language").value="Chinese (Simplified)";document.getElementById("language").dispatchEvent(new Event("change"))');
    await upload(session, '#material-input', [audio, screenshot, screenshot2, text]); await attachments(session, 4);
    if (!missing) qa.config.audioExtractFailAt = 2;
    await initialAudioConsent(session, qa, requestStart); await retainedAudioIdle(session);
    const retained = await evaluate(session, 'document.getElementById("lesson-frame").srcdoc');
    assert.ok(retained.includes(qa.config.lesson.title)); assert.doesNotMatch(retained, /data:audio\//);
    assert.deepEqual(audioCounts(qa), { transcription: 1, digest: 2, lesson: 1, 'audio-extract': missing ? 0 : 2, speech: 0 });
    assert.equal(await evaluate(session, 'document.getElementById("audio-mode").value'), 'auto', 'Missing speech never coerces the user preference to Off');
    assert.equal(await evaluate(session, 'window.__audioDispatch.every(e=>e.retained)'), true);
    assert.equal(audioRequests(session, requestStart).filter(r=>r.path.startsWith('/api/audio/plans')).length, 0, 'Incomplete source inventory cannot create a plan');
    if (missing) assert.deepEqual(audioRequests(session, requestStart), [], 'Missing speech retains text before audio preflight or extra paid OCR');
    const pendingReport = await evaluate(session, 'JSON.parse(document.getElementById("diagnostic-report").textContent)');
    assert.doesNotMatch(JSON.stringify(pendingReport), /Pinned synthetic inventory|Uploaded words|Screenshot final|test-screenshot|second-synthetic-image|data:image|data:audio|Bearer/);
    if (!missing) {
      assert.equal(pendingReport.checkpoint.phase, 'audio_sources');
      assert.equal(pendingReport.checkpoint.preparationComplete, true);
      assert.equal(pendingReport.checkpoint.audioSourceStarted, true);
      assert.equal(pendingReport.checkpoint.audioSourceComplete, false);
      assert.equal(pendingReport.lastOperation.automaticRetry, false);
    }
    await assertSourceLock(session, qa);
    await shot(session, name + '-text-retained.png');
    if (name === 'pending-discard') {
      const before = qa.calls.length;
      await evaluate(session, 'document.getElementById("discard-audio").click()');
      await wait(session, 'document.getElementById("confirm-dialog").open');
      assert.equal(await evaluate(session, 'document.getElementById("confirm-title").textContent'), 'Discard remaining audio?');
      await evaluate(session, 'document.getElementById("confirm-accept").click()');
      await wait(session, '!document.getElementById("generate-button").disabled && !document.getElementById("material-input").disabled');
      assert.equal(await evaluate(session, 'document.getElementById("lesson-frame").srcdoc'), retained);
      assert.equal(qa.calls.length, before);
      assert.equal(await evaluate(session, '[...document.querySelectorAll("#material-list button,[data-action=demo]")].every(n=>!n.disabled)'), true);
      await evaluate(session, 'document.querySelector("[data-action=demo]").click()'); await created(session);
      assert.match(await evaluate(session, 'document.getElementById("result-kind").textContent'), /HAND-AUTHORED/);
      englishAudioEvidence.push({ case: name, counts: audioCounts(qa), discardedWithoutChangingText: true });
      passed('pending source inventory locks attachments/new lesson/demo; explicit Discard preserves HTML, makes no AI call and unlocks creation');
      await releaseAudioFixtureSession(session);
      continue;
    }
    // A second tab changes saved settings while the lesson tab intentionally stays stale.
    const settings = await tabInContext(origin, context);
    await wait(settings, '!!document.getElementById("role-primary-model") && !document.getElementById("roles-fields").disabled');
    const beforeSettings = qa.calls.length;
    await evaluate(settings, `document.querySelector('[data-page="providers"]').click();document.getElementById('role-primary-model').value='gpt-5.4-mini';document.getElementById('role-primary-model').dispatchEvent(new Event('change'));document.getElementById('role-primary-timeout').value='450';document.getElementById('role-primary-timeout').dispatchEvent(new Event('input'));document.getElementById('role-transcription-provider').value='';document.getElementById('role-transcription-provider').dispatchEvent(new Event('change'));${missing ? `document.getElementById('role-speech-engine').value='provider';document.getElementById('role-speech-engine').dispatchEvent(new Event('change'));document.getElementById('role-speech-provider').selectedIndex=1;document.getElementById('role-speech-provider').dispatchEvent(new Event('change'));document.getElementById('role-speech-model').value='test/speech';document.getElementById('role-speech-model').dispatchEvent(new Event('change'));` : ''}document.getElementById('roles-form').requestSubmit()`);
    await wait(settings, 'document.getElementById("roles-message").textContent.startsWith("Model roles saved") && !document.getElementById("roles-fields").disabled');
    assert.equal(qa.calls.length, beforeSettings, 'Setup changes never infer');
    assert.equal(await evaluate(session, 'document.getElementById("role-primary-model").value'), 'test/vision', 'Lesson tab is deliberately stale before Continue');
    const beforeContinue = browserRequests.length;
    await evaluate(session, 'document.getElementById("learning-goal").value="Edited after teaching - must not replay";document.getElementById("learning-goal").dispatchEvent(new Event("input"));document.getElementById("continue-audio").click()');
    await wait(session, 'document.getElementById("confirm-dialog").open');
    assert.equal(await evaluate(session, 'document.getElementById("confirm-title").textContent'), 'Prepare remaining English audio sources?');
    const detail = await evaluate(session, 'document.getElementById("confirm-detail").textContent');
    assert.match(detail, /gpt-5\.4-mini/); assert.match(detail, /Primary request wait: 450 seconds/); assert.match(detail, /test\/speech/);
    assert.ok(browserRequests.slice(beforeContinue).some(r=>r.session===session && r.path==='/api/state' && r.method==='GET'), 'Continue refreshed setup before rendering new paid OCR consent');
    assert.equal(qa.calls.length, beforeSettings, 'No missing OCR before renewed consent');
    await evaluate(session, 'document.getElementById("confirm-cancel").click()'); await retainedAudioIdle(session);
    assert.equal(qa.calls.length, beforeSettings, 'Cancelling source retry sends no AI request');
    qa.config.audioExtractFailAt = null;
    await evaluate(session, 'document.getElementById("continue-audio").click()');
    await wait(session, 'document.getElementById("confirm-dialog").open');
    assert.equal(await evaluate(session, 'document.getElementById("confirm-title").textContent'), 'Prepare remaining English audio sources?');
    await consent(session);
    const exact = await exactAudioCount(session);
    assert.deepEqual(audioCounts(qa), { transcription: 1, digest: 2, lesson: 1, 'audio-extract': missing ? 2 : 3, speech: 0 }, 'Only missing/failed OCR runs; pinned transcript survives role removal');
    const extracts = qa.calls.filter(c=>c.kind==='audio-extract');
    assert.deepEqual(extracts.map(c=>c.body.model), missing ? ['gpt-5.4-mini','gpt-5.4-mini'] : ['test/vision','test/vision','gpt-5.4-mini']);
    if (!missing) {
      assert.equal(extracts[1].failed, true);
      assert.deepEqual(extracts[2].body.input, extracts[1].body.input, 'Only failed second image repeats, not successful first OCR');
      assert.notDeepEqual(extracts[0].body.input, extracts[2].body.input);
    }
    await exactConsent(session, false); await retainedAudioIdle(session);
    assert.equal(await evaluate(session, 'document.getElementById("lesson-frame").srcdoc'), retained, 'Exact-count cancellation retains the original text result');
    assert.equal(await evaluate(session, 'document.getElementById("material-input").disabled'), false, 'Completed inventory releases attachment lock');
    const completeInventoryCounts = audioCounts(qa), inventoryRequests = browserRequests.length;
    await evaluate(session, 'document.getElementById("continue-audio").click()');
    await wait(session, 'document.getElementById("confirm-dialog").open');
    assert.match(await evaluate(session, 'document.getElementById("confirm-title").textContent'), /Resume this retained/);
    assert.deepEqual(audioCounts(qa), completeInventoryCounts, 'First ordinary audio confirmation does not repeat preparation');
    await evaluate(session, 'document.getElementById("confirm-accept").click()');
    assert.equal(await exactAudioCount(session), exact);
    assert.deepEqual(audioCounts(qa), completeInventoryCounts, 'Exact confirmation is still required after inventory completed');
    await exactConsent(session); await checkSpeechCount(session, qa, exact);
    assert.deepEqual({ ...audioCounts(qa), speech: 0 }, completeInventoryCounts, 'Audio-only continuation never reruns OCR/STT/digests/teaching');
    assert.equal(browserRequests.slice(inventoryRequests).filter(r=>r.session===session && (/^\/api\/(?:lessons|transcribe|materials\/summarize|audio\/extract|audio\/preflight)$/.test(r.path) || /\/parts$/.test(r.path))).length, 0, 'Completed inventory resume has no preparation or local source rereads');
    const textInput = qa.calls.find(c=>c.kind==='lesson').body.input[0].content[0].text;
    assert.ok(textInput.includes('Pinned synthetic inventory')); assert.ok(!textInput.includes('Edited after teaching'));
    const lessonRequests = browserRequests.slice(requestStart).filter(r=>r.session===session && r.path==='/api/lessons');
    assert.equal(lessonRequests.length, 1); assert.equal(lessonRequests[0].includeAudio, false);
    await shot(session, name + '-recovered.png');
    englishAudioEvidence.push({ case: name, counts: audioCounts(qa), uniqueClips: exact, refreshedConsent: detail, includesLessonReplay: false });
    passed(name + ': text/download retained, source locks, fresh setup before renewed OCR consent, pinned STT and successful OCR reused across model/role change, no teaching replay, ordinary two-confirmation exact-count audio continuation');
    await releaseAudioFixtureSession(session);
  }
  if (wanted('video-source-consent')) await verifyVideoSourceConsent(origin, text);
  if (wanted('retention-resume-guard')) await verifyRetentionResumeGuard(origin);
}

const englishAudioEvidence = [], englishAudioProviders = [];
const provider = createQAProvider(), kokoro = createQAProvider(), gated = createApp({ publicDirectory, accessPassword: 'test-private-beta-password' }).server;
let app, longWaitRun;
const longWaitProviders = [];
// Opt-in real wall-clock regression; production application transport is not mocked.
async function startLongWaitChecks(origin) {
  const sessions = [];
  for (const { phase, seconds } of [600, 30].flatMap(seconds => ['response_headers', 'response_body'].map(phase => ({ phase, seconds })))) {
    const slow = createQAProvider(); longWaitProviders.push(slow);
    slow.config.lessonDelay = seconds === 600 ? 305000 : 35000;
    slow.config.flushLessonHeaders = phase === 'response_body';
    const providerOrigin = await listen(slow.server);
    const originalContext = browserContextId;
    ({ browserContextId } = await call('Target.createBrowserContext')); extraContexts.push(browserContextId);
    const session = await tab(origin); browserContextId = originalContext;
    await wait(session, 'document.getElementById("setup-label")?.textContent === "Connect your AI"');
    await evaluate(session, `document.querySelector('[data-page="providers"]').click();document.getElementById('provider-name').value='Long wait ${phase}';document.getElementById('provider-url').value=${JSON.stringify(providerOrigin + '/v1')};document.getElementById('provider-form').requestSubmit()`);
    await wait(session, '!!document.querySelector(".provider-name")');
    await evaluate(session, `const p=document.getElementById('role-primary-provider');p.selectedIndex=1;p.dispatchEvent(new Event('change'));const m=document.getElementById('role-primary-model');m.value='__manual__';m.dispatchEvent(new Event('change'));document.getElementById('role-primary-manual').value='test/vision';document.getElementById('role-primary-manual').dispatchEvent(new Event('input'));document.getElementById('role-primary-timeout').value='${seconds}';document.getElementById('role-primary-timeout').dispatchEvent(new Event('input'));document.getElementById('roles-form').requestSubmit()`);
    await wait(session, '!document.getElementById("roles-fields").disabled && document.getElementById("roles-message").textContent.startsWith("Model roles saved")');
    await evaluate(session, `document.querySelector('[data-page="lesson"]').click();document.getElementById('learning-goal').value='Synthetic long wait lesson ${phase}';document.getElementById('learning-goal').dispatchEvent(new Event('input'));document.getElementById('audio-mode').value='off';document.getElementById('audio-mode').dispatchEvent(new Event('input'));document.getElementById('lesson-form').requestSubmit()`);
    await wait(session, 'document.getElementById("confirm-dialog").open');
    assert.match(await evaluate(session, 'document.getElementById("confirm-dialog").textContent'), new RegExp(`Primary request wait: ${seconds} seconds`));
    await consent(session);
    await wait(session, 'JSON.parse(document.getElementById("diagnostic-report").textContent).lastOperation?.status === "Waiting"');
    assert.equal(await evaluate(session, 'JSON.parse(document.getElementById("diagnostic-report").textContent).lastOperation.timeoutMs'), seconds * 1000);
    sessions.push({ session, phase, seconds, slow, startedAt: Date.now() });
  }
  // Return a wrapped promise so setup is awaited, not the five-minute checks.
  return { completion: Promise.all(sessions.map(async ({ session, phase, seconds, slow, startedAt }) => {
    await wait(session, '!document.getElementById("generate-button").disabled', 345000);
    if (seconds === 30) {
      assert.equal(await evaluate(session, 'document.getElementById("preview-error").hidden'), false);
      const report = JSON.parse(await evaluate(session, 'document.getElementById("diagnostic-report").textContent'));
      assert.equal(report.lastOperation.appStatus, 504);
      assert.equal(report.lastOperation.timeoutMs, 30000);
      assert.equal(report.lastOperation.timeoutPhase, phase);
      assert.equal(report.lastOperation.category, 'timeout');
      assert.equal(report.lastOperation.automaticRetry, false);
      assert.equal(report.lastOperation.responseBodyOmitted, true);
      assert.doesNotMatch(JSON.stringify(report), /Synthetic long wait lesson|Bearer|"(?:requestBody|responseBody|sourceText|goal)"/);
      const hint = await evaluate(session, 'document.getElementById("diagnostic-hint").textContent');
      assert.match(hint, /30-second waiting limit/);
      assert.match(hint, phase === 'response_body' ? /while reading the response body/ : /before receiving response headers/);
      assert.equal(slow.calls.length, 1, 'Timeout never automatically retries');
      await evaluate(session, 'document.getElementById("lesson-diagnostics").scrollIntoView({block:"start"})');
      await shot(session, 'timeout-error-' + phase + '.png');
      passed('real 30-second timeout: ' + phase + '; safe error trace, phase hint, exactly one provider request');
      return { phase, configuredMs: 30000, browserElapsedMs: Date.now() - startedAt, requests: slow.calls.length, expectedTimeout: true };
    }
    await created(session);
    assert.equal(slow.calls.length, 1, 'Exactly one provider request, no discovery/retry/fallback');
    const request = slow.calls[0];
    assert.equal(request.kind, 'lesson'); assert.equal(request.disconnected, false);
    assert.ok(request.elapsedMs >= 305000, 'Real wait exceeds the 300-second Undici cap');
    assert.equal(Boolean(request.headersFlushedAt), phase === 'response_body');
    assert.match(await evaluate(session, 'document.getElementById("lesson-frame").srcdoc'), /Browser integration test/);
    const report = JSON.parse(await evaluate(session, 'document.getElementById("diagnostic-report").textContent'));
    assert.equal(report.lastOperation.timeoutMs, 600000); assert.equal(report.lastOperation.status, 'Completed');
    assert.equal(report.lastOperation.timeoutPhase, undefined);
    await shot(session, 'long-wait-' + phase + '.png');
    const timing = { phase, configuredMs: 600000, providerElapsedMs: request.elapsedMs, browserElapsedMs: Date.now() - startedAt, requests: slow.calls.length };
    passed('real long wait ' + JSON.stringify(timing)); return timing;
  })).then(result => ({ result }), error => ({ error })) };
}
try {
  const providerOrigin = await listen(provider.server), kokoroOrigin = await listen(kokoro.server);
  // Synthetic codec fixture: encode the existing one-second tone once using cached OFFLINE tools.
  // Native synthesis/encoding is separately verified; this suite tests browser lifecycle/codec controls.
  const fixtureMP3 = await (await prepareAudioEncoder())({ buffer: wav, mime: 'audio/wav' });
  app = createApp({ publicDirectory, audioEncoderFactory: async () => async () => fixtureMP3, kokoroBaseUrl: kokoroOrigin + '/v1', kokoroBuiltin: true, kokoroFormat: 'wav', kokoroLanguages: ['en'] }).server;
  const origin = await listen(app), gatedOrigin = await listen(gated);
  ({ browserContextId } = await call('Target.createBrowserContext'));
  await mkdir('artifacts/english-audio-browser', { recursive: true });
  await writeFile('artifacts/english-audio-browser/test-screenshot.png', Buffer.from(probeImage().dataUrl.split(',')[1], 'base64'));
  await writeFile('artifacts/english-audio-browser/test-audio.wav', wav);
  await writeFile('artifacts/english-audio-browser/test-notes.md', sourceText + '\n' + longSentence);
  const downloads = resolve('artifacts/english-audio-browser', 'downloads-' + Date.now());
  await mkdir(downloads);
  await call('Browser.setDownloadBehavior', { behavior: 'allow', browserContextId, downloadPath: downloads, eventsEnabled: true });
  if (process.env.LEARNLENS_LONG_WAIT_TEST === '1') longWaitRun = (await startLongWaitChecks(origin)).completion;
  await runEnglishAudioChecks(origin);
  if (process.env.LEARNLENS_BROWSER_SUITE !== 'english-audio') {
  const s = await tab(origin);
  await wait(s, 'document.getElementById("setup-label")?.textContent === "Connect your AI"');
  await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }, s);
  assert.equal(await evaluate(s, 'document.getElementById("provider-url").value'), 'https://api.openai.com/v1');
  assert.equal(await evaluate(s, 'document.getElementById("role-speech-engine").value'), 'kokoro', 'Built-in speech needs no learner setup');
  assert.equal(await evaluate(s, 'document.getElementById("role-speech-voice").value'), 'af_heart');
  assert.deepEqual(await evaluate(s, `(()=>{const n=document.getElementById('role-primary-timeout');return [n.type,n.min,n.max,n.value]})()`), ['number','30','600','300']);
  assert.equal(await evaluate(s, `['speech','transcription'].every(role=>document.getElementById('role-'+role+'-timeout').closest('.timeout-field').hidden)`), true);
  await shot(s, 'app-desktop.png');
  await evaluate(s, `window.__previewLoaded=false;document.getElementById('lesson-frame').addEventListener('load',()=>{window.__previewLoaded=true},{once:true});document.querySelector('[data-action="demo"]').click()`);
  await wait(s, '!document.getElementById("preview-result").hidden');
  assert.match(await evaluate(s, 'document.getElementById("result-kind").textContent'), /HAND-AUTHORED/);
  await wait(s, 'window.__previewLoaded && document.getElementById("lesson-frame").srcdoc.includes("Small habits")');
  const frameTree = await call('Page.getFrameTree', {}, s);
  const childFrame = frameTree.frameTree.childFrames?.[0]?.frame;
  if (childFrame) {
    const world = await call('Page.createIsolatedWorld', { frameId: childFrame.id, worldName: 'learnlens-qa' }, s);
    await wait(s, 'document.body?.innerText.includes("Small habits")', 15000, world.executionContextId);
    assert.equal(await evaluate(s, '(function(){try{return Boolean(parent.document.body)}catch{return false}})()', world.executionContextId), false, 'Preview cannot read parent app DOM');
    const frameResult = await call('Runtime.evaluate', { expression: '({title:document.title,text:document.body?.innerText?.slice(0,300)})', contextId: world.executionContextId, returnByValue: true }, s);
    assert.match(frameResult.result.value.text || '', /Small habits/, 'Sandboxed preview renders lesson content');
  } else {
    const { targetInfos } = await call('Target.getTargets');
    const iframe = targetInfos.find(t => t.type === 'iframe' && t.browserContextId === browserContextId);
    assert.ok(iframe, 'Sandboxed iframe target exists');
    const { sessionId: child } = await call('Target.attachToTarget', { targetId: iframe.targetId, flatten: true });
    await call('Log.enable', {}, child);
    await wait(child, 'document.body?.innerText.includes("Small habits")', 15000);
    const contents = await evaluate(child, '({title:document.title,text:document.body?.innerText?.slice(0,500)})');
    assert.equal(await evaluate(child, '(function(){try{return Boolean(parent.document.body)}catch{return false}})()'), false, 'Preview cannot read parent app DOM');
    assert.match(contents.text || '', /Small habits/, 'Sandboxed preview renders lesson content');
    await call('Target.detachFromTarget', { sessionId: child });
  }
  await shot(s, 'app-preview.png');
  await evaluate(s, `document.querySelector('[data-page="providers"]').click();document.getElementById('provider-name').value='QA mock';document.getElementById('provider-url').value=${JSON.stringify(providerOrigin + '/v1')};document.getElementById('provider-form').requestSubmit()`);
  await wait(s, '!!document.querySelector(".provider-name")');
  await evaluate(s, 'document.querySelector(".discover-button").click()');
  await wait(s, 'document.querySelector(".provider-model-count")?.textContent === "4 listed models"');
  assert.equal(await evaluate(s, 'document.getElementById("role-primary-provider").value'), '', 'No primary provider selected before first Starter');
  assert.equal(await evaluate(s, 'document.getElementById("role-primary-model").value'), '', 'No primary model draft before first Starter');
  const beforeFirstStarter = provider.calls.length;
  await evaluate(s, `document.getElementById('role-primary-timeout').value='450';document.getElementById('role-primary-timeout').dispatchEvent(new Event('input'))`);
  assert.equal(await evaluate(s, 'document.getElementById("role-primary-provider").value'), '', 'Entering wait alone does not select a provider');
  await evaluate(s, 'document.getElementById("use-starter").click()');
  await wait(s, 'document.getElementById("role-primary-model").value === "gpt-5.4-mini"');
  assert.equal(await evaluate(s, 'document.getElementById("role-primary-timeout").value'), '450', 'First Starter preserves visible wait even when readDraft was null');
  assert.notEqual(await evaluate(s, 'document.getElementById("role-primary-provider").value'), '', 'Starter now fills the primary provider');
  assert.equal(provider.calls.length, beforeFirstStarter, 'Entering wait and applying first Starter sends no provider request');
  assert.equal(provider.calls.filter(c=>c.kind!=='discovery').length, 0, 'No inference before primary setup consent');
  await evaluate(s, 'document.getElementById("role-primary-timeout").scrollIntoView({block:"center"})');
  await shot(s, 'starter-visible-wait.png');
  passed('first Starter retains visible450sec before any primary provider/model selection; no provider request or inference');
  await evaluate(s, `document.getElementById('role-primary-timeout').value='450';document.getElementById('role-primary-timeout').dispatchEvent(new Event('input'));document.getElementById('use-starter').click()`);
  await wait(s, 'document.getElementById("confirm-dialog").open');
  await evaluate(s, 'document.getElementById("confirm-accept").click()');
  await wait(s, '!document.getElementById("confirm-dialog").open');
  assert.equal(await evaluate(s, 'document.getElementById("role-primary-timeout").value'), '450', 'Starter preserves draft wait');
  assert.equal(await evaluate(s, 'document.getElementById("role-primary-model").value'), 'gpt-5.4-mini');
  await evaluate(s, 'document.getElementById("role-primary-effort").value="high";document.getElementById("role-primary-effort").dispatchEvent(new Event("change"));document.getElementById("recommend-models").click()');
  await wait(s, 'document.getElementById("confirm-dialog").open');
  assert.match(await evaluate(s, 'document.getElementById("confirm-dialog").textContent'), /Primary request wait: 450 seconds/);
  assert.equal(provider.calls.filter(c => c.path === '/v1/responses').length, 0, 'No inference before explicit advisor consent');
  await evaluate(s, 'document.getElementById("confirm-consent").click();document.getElementById("confirm-accept").click()');
  await wait(s, '!document.getElementById("recommend-results").hidden');
  assert.equal(provider.calls.at(-1).body.reasoning.effort, 'high');
  assert.equal(await evaluate(s, 'document.getElementById("setup-count").textContent'), '1/3', 'Advice cannot save roles');
  await evaluate(s, 'document.querySelector("#recommend-cards input[data-role=primary]").click();document.querySelector("#recommend-cards input[data-role=speech]").click();document.getElementById("apply-recommendations").click()');
  assert.equal(await evaluate(s, 'document.getElementById("role-primary-model").value'), 'test/vision');
  assert.equal(await evaluate(s, 'document.getElementById("role-primary-timeout").value'), '450', 'Advisor preserves draft wait');
  assert.equal(await evaluate(s, 'document.getElementById("setup-count").textContent'), '1/3', 'Applying advice only changes the form');
  await evaluate(s, 'document.querySelector(".setup-advisor").scrollIntoView({block:"start"})');
  await shot(s, 'app-model-advisor.png');
  await call('Emulation.setDeviceMetricsOverride', { width: 320, height: 700, deviceScaleFactor: 1, mobile: true }, s);
  assert.equal(await evaluate(s, 'document.documentElement.scrollWidth <= innerWidth'), true, '320px recommendation review layout');
  await shot(s, 'app-advisor-mobile.png');
  await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }, s);
  await evaluate(s, 'document.getElementById("role-primary-effort").value="low";document.getElementById("role-primary-effort").dispatchEvent(new Event("change"));document.getElementById("roles-form").requestSubmit()');
  await wait(s, 'document.getElementById("setup-count").textContent === "3/3" && !document.getElementById("roles-fields").disabled');
  await evaluate(s, `document.querySelector('[data-role="primary"] .probe-buttons button:last-child').click()`);
  await wait(s, 'document.getElementById("confirm-dialog").open');
  assert.equal(await evaluate(s, 'document.getElementById("confirm-accept").disabled'), true);
  assert.match(await evaluate(s, 'document.getElementById("confirm-dialog").textContent'), /Primary request wait: 450 seconds/);
  await evaluate(s, `document.getElementById('confirm-consent').click();document.getElementById('confirm-accept').click()`);
  await wait(s, `document.querySelector('[data-role="primary"] .check-badges').textContent.includes('vision: Verified')`);
  await shot(s, 'app-providers.png');
  const beforeTimeoutSave = provider.calls.length;
  await evaluate(s, `document.getElementById('role-primary-timeout').value='600';document.getElementById('role-primary-timeout').dispatchEvent(new Event('input'));document.getElementById('roles-form').requestSubmit()`);
  await wait(s, '!document.getElementById("roles-fields").disabled');
  assert.match(await evaluate(s, 'document.querySelector("[data-role=primary] .check-badges").textContent'), /vision: Untested/);
  assert.equal(provider.calls.length, beforeTimeoutSave, 'Wait-only save never probes automatically');
  await call('Page.reload', {}, s);
  await wait(s, 'document.getElementById("role-primary-timeout")?.value === "600"');
  assert.equal(await evaluate(s, 'document.getElementById("role-primary-effort").value'), 'low', 'Wait changes preserve thinking');
  passed('primary wait number/default/bounds; hidden speech/STT; starter/advisor preserve wait; save/reload roundtrip; verification scoped to wait');
  await evaluate(s, `document.querySelector('[data-page="lesson"]').click();document.getElementById('tab-compose').click();document.getElementById('learning-goal').value='Explain this screenshot with examples.';document.getElementById('learning-goal').dispatchEvent(new Event('input'));document.getElementById('audio-mode').value='on';document.getElementById('audio-mode').dispatchEvent(new Event('input'))`);
  const beforeUpload = provider.calls.length;
  await upload(s, '#material-input', ['artifacts/english-audio-browser/test-screenshot.png', 'artifacts/english-audio-browser/test-notes.md', 'artifacts/english-audio-browser/test-audio.wav']);
  await attachments(s, 3);
  assert.equal(provider.calls.length, beforeUpload, 'Uploads and local preparation never call a provider');
  assert.match(await evaluate(s, 'document.querySelector("#material-list .material-text-preview").textContent'), /Markdown source/);
  assert.deepEqual(await evaluate(s, '[...document.querySelectorAll("#main-content textarea")].filter(n=>n.getClientRects().length&&!n.readOnly&&!n.disabled).map(n=>n.id)'), ['learning-goal']);
  await evaluate(s, 'document.getElementById("lesson-form").requestSubmit()');
  await wait(s, 'document.getElementById("confirm-dialog").open');
  assert.equal(provider.calls.length, beforeUpload, 'Opening paid consent sends nothing');
  await evaluate(s, 'document.getElementById("confirm-cancel").click()');
  await wait(s, '!document.getElementById("confirm-dialog").open && !document.getElementById("generate-button").disabled');
  assert.equal(provider.calls.length, beforeUpload, 'Cancelling consent sends nothing');
  await evaluate(s, 'document.getElementById("lesson-form").requestSubmit()');
  await consent(s);
  await created(s);
  assert.ok(browserRequests.some(r=>r.path==='/api/audio/preflight' && r.method==='POST'));
  assert.ok(browserRequests.filter(r=>r.path==='/api/lessons' && r.method==='POST').every(r=>r.includeAudio === false), 'Teaching endpoint receives includeAudio:false');
  assert.ok(provider.calls.slice(beforeUpload).some(c=>c.kind==='transcription'), 'Attached WAV transcribed only after creation consent');
  assert.equal(provider.calls.slice(beforeUpload).filter(c=>c.kind==='digest').length, 1, 'Only the image needs paid digest preparation');
  const initialReport = await evaluate(s, 'JSON.parse(document.getElementById("diagnostic-report").textContent)');
  assert.equal(initialReport.operations.filter(op=>op.appEndpoint==='/materials/summarize' && op.status==='Completed').length, 3, 'All three materials complete preparation');
  assert.deepEqual(initialReport.operations.filter(op=>op.execution==='local').map(op=>op.part.current), [2, 3], 'Markdown and WAV transcript are prepared locally');
  const initialTeachingText = provider.calls.findLast(c=>c.kind==='lesson').body.input[0].content[0].text;
  assert.ok(initialTeachingText.includes(sourceText + '\n' + longSentence)); assert.ok(initialTeachingText.includes(transcriptText));
  assert.ok(provider.calls.slice(beforeUpload).filter(c=>['lesson','digest'].includes(c.kind)).every(c=>c.body.model==='test/vision'), 'Primary role handles sources and final lesson');
  assert.equal(await evaluate(s, 'document.getElementById("learning-goal").value'), 'Explain this screenshot with examples.', 'Transcription never overwrites instructions');
  passed('unified image/Markdown/WAV input; no upload/local-preparation calls; cancelled consent sends nothing; role-routed paid creation');
  assert.match(await evaluate(s, 'document.getElementById("download-lesson").href'), /^blob:/);
  const html = await evaluate(s, 'document.getElementById("lesson-frame").srcdoc');
  assert.match(html, /data:audio\/mpeg;base64/);
  for (const tail of ['Original text final sentinel survives.', 'Screenshot final sentinel survives.', 'The recording final sentinel survives.', 'long sentence final sentinel.']) assert.ok(await evaluate(s, `new DOMParser().parseFromString(document.getElementById('lesson-frame').srcdoc,'text/html').body.textContent.includes(${JSON.stringify(tail)})`), 'Full export retains original source tail: ' + tail);
  assert.ok(provider.calls.slice(beforeUpload).filter(c => c.kind === 'speech').length > 8, 'Full inventory exceeds legacy eight clips');
  assert.equal(provider.calls.slice(beforeUpload).filter(c => c.kind === 'audio-extract').length, 1, 'Original screenshot extracted once by primary role');
  assert.doesNotMatch(html, /\son(?:click|error|load)\s*=/i, 'No inline executable handlers');
  assert.match(html, /data:image\/png;base64/);
  assert.doesNotMatch(html, /src="https?:/);
  assert.doesNotMatch(html, /<script>window\.__learnlensExportInjection=true<\/script>/, 'Provider text cannot inject executable export markup');
  // Exercise the shipped script in the opaque sandbox under the parent's full-audio CSP hash.
  await wait(s, 'document.getElementById("lesson-frame").srcdoc.includes("course-player")');
  await call('Page.bringToFront', {}, s);
  const fullTree = await call('Page.getFrameTree', {}, s);
  let sandboxSession = s, sandboxContext;
  if (fullTree.frameTree.childFrames?.[0]?.frame) {
    sandboxContext = (await call('Page.createIsolatedWorld', { frameId: fullTree.frameTree.childFrames[0].frame.id, worldName: 'full-audio-qa' }, s)).executionContextId;
  } else {
    const { targetInfos } = await call('Target.getTargets');
    const iframe = targetInfos.find(t => t.type === 'iframe' && t.browserContextId === browserContextId);
    assert.ok(iframe, 'Full audio sandbox target exists');
    sandboxSession = (await call('Target.attachToTarget', { targetId: iframe.targetId, flatten: true })).sessionId;
  }
  await wait(sandboxSession, '!!document.getElementById("course-player")', 15000, sandboxContext);
  assert.equal(await evaluate(sandboxSession, '(function(){try{return Boolean(parent.document.body)}catch{return false}})()', sandboxContext), false);
  await call('Runtime.evaluate', { expression: 'document.querySelector(".word-play:not(:disabled)").click()', userGesture: true, contextId: sandboxContext }, sandboxSession);
  await wait(sandboxSession, 'document.getElementById("course-player").currentTime > .05', 15000, sandboxContext);
  await evaluate(sandboxSession, 'document.getElementById("audio-stop").click()', sandboxContext);
  if (sandboxSession !== s) await call('Target.detachFromTarget', { sessionId: sandboxSession });
  passed('full-audio sandbox actual script plays MP3 under parent full hash; parent DOM remains inaccessible');
  await call('Runtime.evaluate', { expression: 'document.getElementById("download-lesson").click()', userGesture: true }, s);
  const downloadedPath = resolve(downloads, 'LearnLens-Browser-integration-test.html');
  let downloadTimer;
  try { await Promise.race([downloadFinished, new Promise((_, reject) => { downloadTimer = setTimeout(()=>reject(new Error('Download did not complete')), 15000); })]); }
  finally { clearTimeout(downloadTimer); }
  const downloaded = await readFile(downloadedPath, 'utf8');
  assert.equal(downloaded, html, 'Actual browser download matches the preview document');
  await writeFile('artifacts/english-audio-browser/browser-export.html', downloaded);
  await shot(s, 'app-generated.png');
  await shot(s, 'app-full-audio.png');
  assert.ok(provider.calls.some(c => c.path === '/v1/audio/speech'), 'Online speech method used');
  await evaluate(s, 'document.querySelector("[data-page=providers]").click();document.getElementById("role-speech-engine").value="kokoro";document.getElementById("role-speech-engine").dispatchEvent(new Event("change"));document.getElementById("roles-form").requestSubmit()');
  await wait(s, 'document.getElementById("role-speech-engine").value === "kokoro" && !document.getElementById("roles-fields").disabled');
  assert.equal(await evaluate(s, 'document.getElementById("role-speech-voice").value'), 'af_heart');
  await evaluate(s, 'document.querySelector("[data-role=speech] .probe-buttons button").click()');
  await wait(s, 'document.getElementById("confirm-dialog").open');
  await evaluate(s, 'document.getElementById("confirm-accept").click()');
  await wait(s, 'document.querySelector("[data-role=speech] .check-badges").textContent.includes("Verified")');
  const beforeCloud = provider.calls.filter(c => c.path === '/v1/audio/speech').length;
  await evaluate(s, 'document.querySelector("[data-page=lesson]").click();document.getElementById("lesson-form").requestSubmit()');
  await consent(s);
  await created(s);
  assert.ok(kokoro.calls.some(c => c.body?.model === 'kokoro' && c.body.voice === 'af_heart'));
  assert.equal(provider.calls.filter(c => c.path === '/v1/audio/speech').length, beforeCloud, 'Kokoro never silently calls cloud speech');
  // The rest of the legacy import suite exercises text-only creation; full-audio recovery is separate below.
  await evaluate(s, 'document.getElementById("audio-mode").value="off";document.getElementById("audio-mode").dispatchEvent(new Event("input"))');
  await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }, s);
  await evaluate(s, 'document.getElementById("tab-compose").click();scrollTo(0,0)');
  assert.equal(await evaluate(s, 'document.documentElement.scrollWidth <= innerWidth'), true, 'mobile horizontal overflow');
  await shot(s, 'app-mobile.png');
  await evaluate(s, 'document.querySelector("[data-page=providers]").click();scrollTo(0,0)');
  assert.equal(await evaluate(s, 'document.documentElement.scrollWidth <= innerWidth'), true, 'provider mobile horizontal overflow');
  await shot(s, 'app-providers-mobile.png');
  await call('Emulation.setDeviceMetricsOverride', { width: 320, height: 700, deviceScaleFactor: 1, mobile: true }, s);
  assert.equal(await evaluate(s, 'document.documentElement.scrollWidth <= innerWidth'), true, '320px provider layout');
  await evaluate(s, 'document.querySelector("[data-page=lesson]").click()');
  assert.equal(await evaluate(s, 'document.documentElement.scrollWidth <= innerWidth'), true, '320px composer layout');
  provider.config.status = 500;
  await evaluate(s, 'document.getElementById("lesson-form").requestSubmit()');
  await consent(s);
  await wait(s, '!document.getElementById("preview-error").hidden');
  assert.match(await evaluate(s, 'document.getElementById("preview-error-message").textContent'), /Provider/);
  assert.equal(await evaluate(s, 'document.getElementById("lesson-diagnostics").open && !document.getElementById("lesson-diagnostics").hidden'), true);
  const firstFailure = await evaluate(s, 'JSON.parse(document.getElementById("diagnostic-report").textContent)');
  assert.equal(firstFailure.lastOperation.stage, 'lesson_generation');
  assert.equal(firstFailure.lastOperation.upstreamStatus, 500);
  assert.equal(firstFailure.lastOperation.appStatus, 502);
  assert.match(firstFailure.lastOperation.appRequestId, /^[a-f0-9-]{36}$/);
  assert.equal(firstFailure.lastOperation.automaticRetry, false);
  assert.doesNotMatch(JSON.stringify(firstFailure), /Explain this screenshot|Markdown source|test-screenshot|data:audio|data:image|apiKey|Bearer/);
  assert.equal(await evaluate(s, 'document.documentElement.scrollWidth <= innerWidth'), true, '320px failure diagnostics have no horizontal overflow');
  await shot(s, 'app-provider-diagnostics.png');
  assert.equal(await evaluate(s, 'document.getElementById("show-previous").hidden'), false);
  await evaluate(s, 'document.getElementById("show-previous").click()');
  assert.equal(await evaluate(s, 'document.getElementById("preview-result").hidden'), false);
  provider.config.status = 200;
  await evaluate(s, 'document.getElementById("retry-preview").click()');
  await consent(s); await created(s);
  passed('provider failure preserves previous lesson and explicit retry succeeds');
  // Genuine PDF/Office originals and a native browser recording: all enter the
  // same file input, never an API-only import or a forged extension.
  const fixtures = await importFixtures(resolve('artifacts/english-audio-browser/browser-import-fixtures'), { media: process.env.LEARNLENS_MEDIA_INTEGRATION === '1' });
  const nativeRecording = await call('Runtime.evaluate', { userGesture: true, awaitPromise: true, returnByValue: true, expression: `(async()=>{
    if (!MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) throw new Error('Native WebM recording unsupported in this disposable Chromium');
    const context = new AudioContext(); await context.resume();
    const oscillator = context.createOscillator(), destination = context.createMediaStreamDestination();
    oscillator.frequency.value=440; oscillator.connect(destination);
    const recorder = new MediaRecorder(destination.stream, {mimeType:'audio/webm;codecs=opus'}), chunks=[];
    try {
      const stopped = new Promise((resolve,reject)=>{recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data)};recorder.onstop=resolve;recorder.onerror=()=>reject(new Error('Synthetic recording failed'))});
      recorder.start(); oscillator.onended=()=>recorder.stop(); oscillator.start(); oscillator.stop(context.currentTime+1);
      await stopped;
      return await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsDataURL(new Blob(chunks,{type:recorder.mimeType}))});
    } finally {destination.stream.getTracks().forEach(t=>t.stop());await context.close()}
  })()` }, s);
  assert.equal(nativeRecording.exceptionDetails, undefined, 'Microphone-free MediaRecorder fixture created');
  const recordingPath = resolve('artifacts/english-audio-browser/browser-import-fixtures/browser-recording.webm');
  await writeFile(recordingPath, Buffer.from(nativeRecording.result.value.split(',')[1], 'base64'));
  const beforeDocuments = provider.calls.length;
  await evaluate(s, 'document.getElementById("tab-compose").click()');
  await upload(s, '#material-input', [...fixtures.documents, recordingPath]);
  await attachments(s, 7);
  assert.equal(provider.calls.length, beforeDocuments, 'PDF/DOCX/PPTX/native MediaRecorder local preparation is AI-free');
  const cards = await evaluate(s, '[...document.querySelectorAll("#material-list > li")].map(li=>({name:li.querySelector("strong").textContent,parts:li.querySelectorAll("select option").length}))');
  assert.equal(cards.find(c=>c.name==='five-pages.pdf').parts, 2, 'Five-page PDF automatically prepares both page groups');
  assert.ok(cards.find(c=>c.name==='long-source.docx').parts >= 3, '>35k Office source automatically splits');
  assert.ok(cards.find(c=>c.name==='six-slides.pptx').parts >= 1, 'Genuine PPTX imported');
  assert.equal(cards.find(c=>c.name==='browser-recording.webm').parts, 1, 'Native MediaRecorder WebM without seekable duration is prepared');
  assert.equal(await evaluate(s, 'document.querySelectorAll("#material-list textarea,#material-list [contenteditable=true]").length'), 0, 'Source previews are read-only, not competing instruction editors');
  for (const width of [390, 320]) {
    await call('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: true }, s);
    await evaluate(s, 'document.querySelectorAll("#material-list details").forEach(n=>n.open=true)');
    assert.equal(await evaluate(s, 'document.documentElement.scrollWidth <= innerWidth'), true, width + 'px import/review layout');
    assert.deepEqual(await evaluate(s, '[...document.querySelectorAll("#main-content textarea")].filter(n=>n.getClientRects().length&&!n.readOnly).map(n=>n.id)'), ['learning-goal']);
    await shot(s, 'app-import-' + width + '.png');
  }
  passed('five-page PDF, >35k DOCX, six-slide PPTX and native oscillator/MediaRecorder WebM prepare locally; 390/320px read-only review; microphone permission never requested');
  const previousHtml = await evaluate(s, 'document.getElementById("lesson-frame").srcdoc');
  provider.config.failKind = 'lesson';
  await evaluate(s, 'document.getElementById("lesson-form").requestSubmit()');
  await consent(s);
  await wait(s, '!document.getElementById("preview-error").hidden && document.getElementById("preview-loading").hidden && !document.getElementById("retry-preview").disabled');
  assert.equal(await evaluate(s, 'document.querySelectorAll("#material-list > li").length'), 7, 'Final lesson failure retains every attachment');
  assert.equal(await evaluate(s, 'document.getElementById("learning-goal").value'), 'Explain this screenshot with examples.');
  await evaluate(s, 'document.getElementById("show-previous").click()');
  assert.equal(await evaluate(s, 'document.getElementById("lesson-frame").srcdoc'), previousHtml, 'Previous lesson survives completed paid prep followed by failure');
  const documentCalls = provider.calls.slice(beforeDocuments), digestText = JSON.stringify(documentCalls.filter(c=>c.kind==='digest').map(c=>c.body.input));
  for (let page=1;page<=5;page++) assert.ok(digestText.includes('PDF page ' + page + ' evidence'), 'Automatic digest includes PDF page ' + page);
  assert.ok(digestText.includes('DOCX_BEGIN') && digestText.includes('DOCX_END'), 'Both ends of long Office source reached digests');
  const documentTeachingText = documentCalls.findLast(c=>c.kind==='lesson').body.input[0].content[0].text;
  for (let slide=1;slide<=6;slide++) assert.ok(documentTeachingText.includes('Ordered slide ' + slide), 'Verbatim final input includes slide ' + slide);
  assert.ok(!documentCalls.some(c=>c.kind==='digest' && JSON.stringify(c.body.input).includes('six-slides.pptx')), 'Short PPTX stays local, without a lossy digest');
  for (const card of cards.slice(3)) for (let part=1;part<=card.parts;part++) {
    const expectedKind = ['six-slides.pptx', 'browser-recording.webm'].includes(card.name) ? 'lesson' : 'digest';
    assert.ok(documentCalls.some(c=>c.kind===expectedKind && JSON.stringify(c.body.input).includes(card.name) && JSON.stringify(c.body.input).includes('(' + part + '/' + card.parts + ')')), 'Every automatic part reaches primary via raw final input or digest: ' + card.name + ' part ' + part);
  }
  assert.equal(documentCalls.filter(c=>c.kind==='transcription').length, cards.find(c=>c.name==='browser-recording.webm').parts, 'Browser recording transcribed after consent');
  const completedPaid = provider.calls.filter(c=>['digest','transcription'].includes(c.kind)).length;
  provider.config.failKind = null;
  await evaluate(s, 'document.getElementById("retry-preview").click()');
  await consent(s); await created(s);
  assert.equal(provider.calls.filter(c=>['digest','transcription'].includes(c.kind)).length, completedPaid, 'Explicit retry reuses every finished digest/transcription');
  const finalInput = JSON.stringify(provider.calls.findLast(c=>c.kind==='lesson').body.input);
  for (const card of cards) for (let part=1;part<=card.parts;part++) assert.ok(finalInput.includes(card.name) && finalInput.includes('(' + part + '/' + card.parts + ')'), 'Final lesson includes prepared source ' + card.name + ' part ' + part);
  assert.ok(provider.calls.findLast(c=>c.kind==='lesson').body.input[0].content[0].text.includes(transcriptText), 'Full recording transcript including its tail survives local preparation');
  assert.ok(digestText.includes('Footnote evidence'), 'DOCX footnote tail is not omitted');
  passed('all document pages/Office chunks reach primary digests or raw final input with tails intact; final failure retains attachments/previous lesson; retry does not repeat finished paid preparation');
  // A private context isolates checkpoint accounting from successful-lesson caches/history.
  const checkpointOriginalContext = browserContextId;
  ({ browserContextId } = await call('Target.createBrowserContext')); extraContexts.push(browserContextId);
  const checkpointTab = await tab(origin);
  browserContextId = checkpointOriginalContext;
  await wait(checkpointTab, 'document.getElementById("setup-label")?.textContent === "Connect your AI"');
  await evaluate(checkpointTab, `document.querySelector('[data-page="providers"]').click();document.getElementById('provider-name').value='Checkpoint synthetic QA';document.getElementById('provider-url').value=${JSON.stringify(providerOrigin + '/v1')};document.getElementById('provider-form').requestSubmit()`);
  await wait(checkpointTab, '!!document.querySelector(".provider-name")');
  await evaluate(checkpointTab, 'document.querySelector(".discover-button").click()');
  await wait(checkpointTab, 'document.querySelector(".provider-model-count")?.textContent === "4 listed models"');
  await evaluate(checkpointTab, `for(const [role,model] of [['primary','test/vision'],['transcription','__manual__']]){const p=document.getElementById('role-'+role+'-provider');p.selectedIndex=1;p.dispatchEvent(new Event('change'));const m=document.getElementById('role-'+role+'-model');m.value=model;m.dispatchEvent(new Event('change'))}document.getElementById('role-transcription-manual').value='gemini-checkpoint-fixture';document.getElementById('role-transcription-manual').dispatchEvent(new Event('input'));document.getElementById('role-transcription-api').value='gemini';document.getElementById('role-transcription-api').dispatchEvent(new Event('change'));document.getElementById('roles-form').requestSubmit()`);
  await wait(checkpointTab, 'document.getElementById("setup-count")?.textContent === "3/3" && !document.getElementById("roles-fields").disabled');
  await evaluate(checkpointTab, 'document.querySelector("[data-page=lesson]").click();document.querySelector("[data-action=demo]").click()'); await created(checkpointTab);
  const checkpointPrevious = await evaluate(checkpointTab, 'document.getElementById("lesson-frame").srcdoc');
  const checkpointGoal = 'CHECKPOINT_PRIVATE_INSTRUCTIONS retain original science examples';
  await writeFile('artifacts/english-audio-browser/checkpoint-second.wav', wav);
  await evaluate(checkpointTab, `document.getElementById('tab-compose').click();document.getElementById('learning-goal').value=${JSON.stringify(checkpointGoal)};document.getElementById('learning-goal').dispatchEvent(new Event('input'));document.getElementById('audio-mode').value='on';document.getElementById('audio-mode').dispatchEvent(new Event('input'));document.getElementById('level').value='Primary'`);
  await upload(checkpointTab, '#material-input', ['artifacts/english-audio-browser/test-audio.wav', 'artifacts/english-audio-browser/test-screenshot.png', fixtures.documents[0], 'artifacts/english-audio-browser/test-notes.md', 'artifacts/english-audio-browser/checkpoint-second.wav']);
  await attachments(checkpointTab, 5);
  const checkpointAttachments = await evaluate(checkpointTab, '[...document.querySelectorAll("#material-list details")].map(n=>n.dataset.id)');
  const checkpointStart = provider.calls.length, checkpointRequests = browserRequests.length;
  const checkpointCalls = () => provider.calls.slice(checkpointStart).filter(c=>c.kind!=='discovery');
  const checkpointCounts = () => Object.fromEntries(['transcription','audio-extract','digest','lesson','speech'].map(kind=>[kind,checkpointCalls().filter(c=>c.kind===kind).length]));
  const assertCheckpointCounts = (digest, lesson = 0, transcription = 1) => assert.deepEqual(checkpointCounts(), { transcription, 'audio-extract': 6, digest, lesson, speech: 0 });
  const checkpointPartRequests = () => browserRequests.slice(checkpointRequests).filter(r=>/^\/api\/materials\/[^/]+\/parts$/.test(r.path));
  const checkpointFailed = async () => wait(checkpointTab, '!document.getElementById("preview-error").hidden && document.getElementById("preview-loading").hidden && !document.getElementById("generate-button").disabled');
  const checkpointDialog = async (accept = true) => {
    await wait(checkpointTab, 'document.getElementById("confirm-dialog").open');
    assert.equal(await evaluate(checkpointTab, 'document.getElementById("confirm-title").textContent'), 'Continue generation from the last checkpoint?');
    assert.equal(await evaluate(checkpointTab, 'document.getElementById("confirm-accept").textContent'), 'Continue from checkpoint');
    assert.equal(await evaluate(checkpointTab, 'document.getElementById("confirm-accept").disabled'), true, 'Every continuation requires fresh paid consent');
    if (accept) await consent(checkpointTab);
    else { await evaluate(checkpointTab, 'document.getElementById("confirm-cancel").click()'); await wait(checkpointTab, '!document.getElementById("confirm-dialog").open && !document.getElementById("generate-button").disabled'); }
  };
  const assertCheckpointPrivacy = async () => {
    const report = JSON.parse(await evaluate(checkpointTab, 'document.getElementById("diagnostic-report").textContent'));
    assert.doesNotMatch(JSON.stringify(report), /CHECKPOINT_PRIVATE|EDITED_PRIVATE|Markdown source|Gemini-native synthetic transcript|Screenshot final|test-audio|test-screenshot|five-pages|test-notes|checkpoint-second|data:audio|Bearer|"(?:requestBody|responseBody|filename|sourceText|goal)"/);
    assert.deepEqual(Object.keys(report.checkpoint).sort(), ['audioSourceComplete','audioSourceStarted','completedCalls','completedParts','phase','preparationComplete','totalParts']);
    assert.equal(typeof report.checkpoint.audioSourceStarted, 'boolean');
    assert.equal(typeof report.checkpoint.audioSourceComplete, 'boolean');
    return report;
  };
  const acceptedNote = 'NOTE_2473_BEGIN_' + 'n'.repeat(2443) + '_NOTE2473_END!';
  assert.equal(acceptedNote.length, 2473);
  provider.config.digestNotes = acceptedNote;
  provider.config.digestFaultAt = provider.calls.filter(c=>c.kind==='digest').length + 3;
  provider.config.digestFaultRepeat = true;
  await evaluate(checkpointTab, 'document.getElementById("lesson-form").requestSubmit()'); await consent(checkpointTab); await checkpointFailed();
  assertCheckpointCounts(3);
  assert.deepEqual(checkpointCalls().map(c=>c.kind), ['transcription','audio-extract','digest','audio-extract','audio-extract','audio-extract','digest','audio-extract','audio-extract','digest']);
  assert.equal(checkpointCalls()[0].path, '/v1beta/models/gemini-checkpoint-fixture:generateContent');
  const firstDigests = checkpointCalls().filter(c=>c.kind==='digest');
  for (const [index, name, part] of [[0,'test-screenshot.png','(1/1)'],[1,'five-pages.pdf','(1/2)'],[2,'five-pages.pdf','(2/2)']]) {
    assert.ok(JSON.stringify(firstDigests[index].body.input).includes(name));
    assert.ok(JSON.stringify(firstDigests[index].body.input).includes(part));
  }
  assert.equal(firstDigests[2].malformed, true, 'HTTP 200 invalid notes are not a successful checkpoint');
  assert.match(await evaluate(checkpointTab, 'document.getElementById("generation-checkpoint-summary").textContent'), /^10 successful preparation call\(s\) retained · 3\/6 parts prepared\./);
  assert.equal(await evaluate(checkpointTab, 'document.getElementById("retry-preview").textContent'), 'Continue generation');
  assert.equal(await evaluate(checkpointTab, 'document.getElementById("learning-goal").value'), checkpointGoal);
  assert.deepEqual(await evaluate(checkpointTab, '[...document.querySelectorAll("#material-list details")].map(n=>n.dataset.id)'), checkpointAttachments);
  const malformedReport = await assertCheckpointPrivacy();
  assert.equal(malformedReport.lastOperation.appStatus, 502);
  assert.equal(malformedReport.lastOperation.category, 'preparation_validation');
  assert.equal(malformedReport.lastOperation.validationReason, 'digest_notes_limit');
  assert.equal(malformedReport.lastOperation.notesCharacters, 8001);
  assert.equal(malformedReport.lastOperation.timeoutMs, 300000);
  assert.equal(malformedReport.lastOperation.upstreamStatus, 200);
  assert.equal(malformedReport.lastOperation.maxOutputTokens, 2000);
  assert.equal(malformedReport.lastOperation.completionStatus, 'unknown', 'Legacy mock omits completion status, never invent success');
  assert.ok(malformedReport.lastOperation.responseBytes > 8001);
  assert.equal(malformedReport.lastOperation.responseBodyOmitted, true);
  assert.equal(malformedReport.lastOperation.automaticRetry, false);
  const assertLocalPreparation = operation => {
    assert.equal(operation.execution, 'local'); assert.equal(operation.role, 'local'); assert.equal(operation.apiMode, 'local');
    assert.equal(operation.status, 'Completed');
    for (const key of ['provider', 'model', 'thinking', 'timeoutMs', 'timeoutPhase']) assert.equal(Object.hasOwn(operation, key), false, 'Local preparation has no ' + key);
  };
  const firstLocal = malformedReport.operations.filter(op=>op.execution==='local');
  assert.equal(firstLocal.length, 1); assert.equal(firstLocal[0].part.current, 1); assertLocalPreparation(firstLocal[0]);
  await shot(checkpointTab, 'app-preparation-validation.png');
  assert.equal(malformedReport.checkpoint.completedCalls, 10);
  assert.equal(malformedReport.checkpoint.completedParts, 3);
  await evaluate(checkpointTab, 'document.getElementById("show-previous").click()');
  assert.equal(await evaluate(checkpointTab, 'document.getElementById("lesson-frame").srcdoc'), checkpointPrevious);
  assert.equal(await evaluate(checkpointTab, 'document.getElementById("preview-error").hidden && !document.getElementById("generation-checkpoint").hidden && document.getElementById("continue-generation").getClientRects().length > 0'), true, 'Continuation is visible while the error panel is hidden');
  const failedPartFetches = checkpointPartRequests().length;
  await evaluate(checkpointTab, 'document.getElementById("continue-generation").click()'); await checkpointDialog(false);
  assertCheckpointCounts(3); assert.equal(checkpointPartRequests().length, failedPartFetches);
  // A timeout-only revision must retain every successful source operation and note.
  const beforeWaitRevision = provider.calls.length;
  await evaluate(checkpointTab, `document.querySelector('[data-page="providers"]').click();document.getElementById('role-primary-timeout').value='600';document.getElementById('role-primary-timeout').dispatchEvent(new Event('input'));document.getElementById('roles-form').requestSubmit()`);
  await wait(checkpointTab, '!document.getElementById("roles-fields").disabled');
  assert.equal(provider.calls.length, beforeWaitRevision);
  await evaluate(checkpointTab, 'document.querySelector("[data-page=lesson]").click()');
  // Ordinary Create on an unchanged failed draft must continue, not silently start over.
  await evaluate(checkpointTab, 'document.getElementById("tab-compose").click();document.getElementById("lesson-form").requestSubmit()'); await checkpointDialog(); await checkpointFailed();
  assertCheckpointCounts(4);
  assert.deepEqual(checkpointCalls().filter(c=>c.kind==='digest').at(-1).body.input, firstDigests[2].body.input, 'Repeated failure retries exactly the failed PDF part');
  assert.equal(checkpointPartRequests().length, failedPartFetches, 'Failed digest retry does not reread local source parts');
  assert.match(await evaluate(checkpointTab, 'document.getElementById("generation-checkpoint-summary").textContent'), /^10 successful preparation call\(s\) retained · 3\/6 parts prepared\./);
  const timeoutRevisionReport = await assertCheckpointPrivacy();
  assert.equal(timeoutRevisionReport.lastOperation.timeoutMs, 600000);
  assert.equal(timeoutRevisionReport.checkpoint.completedCalls, 10);
  assert.equal(timeoutRevisionReport.checkpoint.completedParts, 3);
  // Changed attachment identity/count blocks Continue before any provider access.
  await writeFile('artifacts/english-audio-browser/checkpoint-added.md', 'Synthetic attachment identity change.');
  await evaluate(checkpointTab, 'document.getElementById("error-back-draft").click()');
  await upload(checkpointTab, '#material-input', ['artifacts/english-audio-browser/checkpoint-added.md']); await attachments(checkpointTab, 6);
  assert.equal(await evaluate(checkpointTab, 'document.getElementById("continue-generation").disabled'), true);
  await evaluate(checkpointTab, 'document.getElementById("continue-generation").click();document.getElementById("lesson-form").requestSubmit()');
  await wait(checkpointTab, 'document.getElementById("confirm-dialog").open');
  assert.equal(await evaluate(checkpointTab, 'document.getElementById("confirm-title").textContent'), 'Start a new lesson instead of continuing?');
  assert.equal(await evaluate(checkpointTab, 'document.getElementById("confirm-accept").textContent'), 'Replace checkpoint & create');
  assertCheckpointCounts(4);
  await evaluate(checkpointTab, 'document.getElementById("confirm-cancel").click()');
  await wait(checkpointTab, '!document.getElementById("generate-button").disabled');
  await evaluate(checkpointTab, 'document.querySelector("#material-list > li:last-child button").click()'); await attachments(checkpointTab, 5);
  assert.deepEqual(await evaluate(checkpointTab, '[...document.querySelectorAll("#material-list details")].map(n=>n.dataset.id)'), checkpointAttachments);
  // Deterministically stop BEFORE the next provider request; no timing-dependent billable race.
  await evaluate(checkpointTab, `window.__checkpointFetch=window.fetch;window.__checkpointPaused=false;window.fetch=(input,options)=>String(input)==='/api/materials/summarize' ? new Promise((resolve,reject)=>{window.__checkpointPaused=true;options.signal.addEventListener('abort',()=>reject(new DOMException('Synthetic pre-dispatch stop','AbortError')),{once:true})}) : window.__checkpointFetch(input,options);document.getElementById('lesson-form').requestSubmit()`);
  await checkpointDialog(); await wait(checkpointTab, 'window.__checkpointPaused');
  await evaluate(checkpointTab, 'document.getElementById("stop-processing").click()'); await checkpointFailed();
  await evaluate(checkpointTab, 'window.fetch=window.__checkpointFetch;delete window.__checkpointFetch');
  assertCheckpointCounts(4); assert.equal(checkpointPartRequests().length, failedPartFetches);
  assert.match(await evaluate(checkpointTab, 'document.getElementById("generation-checkpoint-summary").textContent'), /^10 successful preparation call\(s\) retained · 3\/6 parts prepared\./);
  // A new setup revision/model is adopted only by unfinished steps after renewed consent.
  const beforeCheckpointSettings = provider.calls.length;
  await evaluate(checkpointTab, 'document.querySelector("[data-page=providers]").click();document.getElementById("role-primary-model").value="gpt-5.4-mini";document.getElementById("role-primary-model").dispatchEvent(new Event("change"));document.getElementById("roles-form").requestSubmit()');
  await wait(checkpointTab, 'document.getElementById("roles-message").textContent.startsWith("Model roles saved") && !document.getElementById("roles-fields").disabled');
  assert.equal(provider.calls.length, beforeCheckpointSettings);
  await evaluate(checkpointTab, 'document.querySelector("[data-page=lesson]").click();document.getElementById("tab-compose").click();document.getElementById("learning-goal").value="EDITED_PRIVATE_NOT_FOR_RESUME";document.getElementById("learning-goal").dispatchEvent(new Event("input"));document.getElementById("audio-mode").value="off";document.getElementById("audio-mode").dispatchEvent(new Event("input"));document.getElementById("level").value="College/University";document.getElementById("tab-preview").click();document.getElementById("retry-preview").click()');
  await checkpointDialog(false); assertCheckpointCounts(4);
  provider.config.digestFaultAt = null; provider.config.digestFaultRepeat = false; provider.config.failKind = 'lesson';
  await evaluate(checkpointTab, 'document.getElementById("retry-preview").click()'); await checkpointDialog(); await checkpointFailed();
  assertCheckpointCounts(5, 1, 2);
  const resumedDigests = checkpointCalls().filter(c=>c.kind==='digest').slice(4);
  assert.deepEqual(resumedDigests.map(c=>c.body.model), ['gpt-5.4-mini']);
  assert.ok(JSON.stringify(resumedDigests[0].body.input).includes('five-pages.pdf'));
  assert.deepEqual(resumedDigests[0].body.input, firstDigests[2].body.input);
  assert.ok(resumedDigests.every(c=>JSON.stringify(c.body.input).includes(checkpointGoal) && !JSON.stringify(c.body.input).includes('EDITED_PRIVATE')));
  assert.ok(firstDigests.every(c=>c.body.model==='test/vision'));
  const failedLessonInput = JSON.stringify(checkpointCalls().find(c=>c.kind==='lesson').body.input);
  assert.ok(failedLessonInput.includes(checkpointGoal)); assert.ok(failedLessonInput.includes('Primary')); assert.ok(!failedLessonInput.includes('EDITED_PRIVATE'));
  assert.match(await evaluate(checkpointTab, 'document.getElementById("generation-checkpoint-summary").textContent'), /^14 successful preparation call\(s\) retained · 6\/6 parts prepared\. Source preparation is complete/);
  const preparedReport = await assertCheckpointPrivacy();
  assert.equal(preparedReport.checkpoint.preparationComplete, true);
  const resumedLocals = preparedReport.operations.filter(op=>op.execution==='local');
  assert.deepEqual(resumedLocals.map(op=>op.part.current), [5, 6]); resumedLocals.forEach(assertLocalPreparation);
  const rawCheckpointInput = checkpointCalls().find(c=>c.kind==='lesson').body.input[0].content[0].text;
  assert.equal(rawCheckpointInput.split(acceptedNote).length - 1, 3, 'Three exact 2473-character notes survive repeated failure/resume without clipping');
  assert.equal(preparedReport.lastOperation.timeoutMs, 600000);
  provider.config.digestNotes = null;
  assert.ok(rawCheckpointInput.includes(sourceText + '\n' + longSentence), 'Entire original Markdown survives final teaching input');
  assert.equal(rawCheckpointInput.split('Gemini-native synthetic transcript about Newton’s laws.').length - 1, 2, 'Both raw Gemini transcripts survive without AI rewriting');
  const preparedPartFetches = checkpointPartRequests().length, preparedSources = checkpointCalls().filter(c=>c.kind!=='lesson').length;
  provider.config.failKind = null;
  await evaluate(checkpointTab, 'document.getElementById("retry-preview").click()'); await checkpointDialog();
  await exactConsent(checkpointTab, false); await created(checkpointTab);
  assertCheckpointCounts(5, 2, 2);
  assert.equal(checkpointCalls().filter(c=>c.kind!=='lesson').length, preparedSources);
  assert.equal(checkpointPartRequests().length, preparedPartFetches, 'Complete preparation snapshot retries only final teaching, never local source part reads');
  assert.deepEqual(checkpointCalls().filter(c=>c.kind==='lesson').map(c=>c.body.input), Array(2).fill(checkpointCalls().find(c=>c.kind==='lesson').body.input));
  assert.equal(await evaluate(checkpointTab, 'document.getElementById("generation-checkpoint").hidden && !document.getElementById("continue-audio").hidden'), true, 'Text retention releases source checkpoint and keeps the separate audio continuation');
  await assertCheckpointPrivacy();
  await shot(checkpointTab, 'app-generation-checkpoint-recovered.png');
  passed('checkpoint: exact 2473-character notes retained without clipping; 8001 rejected; timeout-only revision preserves successes; digests 3→4→5, teaching 1→2, STT 2, 14 retained operations/6 parts; cancellation/repeated failure; model change; saved source payload; no local rereads or diagnostic leakage');
  // Clearing a session invalidates an unfinished checkpoint, never silently recreates it.
  const checkpointPrivateContext = extraContexts.at(-1);
  browserContextId = checkpointPrivateContext;
  const clearedCheckpointTab = await tab(origin);
  browserContextId = checkpointOriginalContext;
  await wait(clearedCheckpointTab, 'document.getElementById("setup-count")?.textContent === "3/3"');
  provider.config.failKind = 'lesson';
  const beforeClearFailure = provider.calls.length;
  await evaluate(clearedCheckpointTab, 'document.getElementById("learning-goal").value="Synthetic clear-session checkpoint";document.getElementById("learning-goal").dispatchEvent(new Event("input"));document.getElementById("audio-mode").value="off";document.getElementById("audio-mode").dispatchEvent(new Event("input"));document.getElementById("lesson-form").requestSubmit()');
  await consent(clearedCheckpointTab);
  await wait(clearedCheckpointTab, '!document.getElementById("preview-error").hidden && !document.getElementById("generate-button").disabled');
  assert.deepEqual(provider.calls.slice(beforeClearFailure).map(c=>c.kind), ['lesson']);
  await evaluate(clearedCheckpointTab, 'document.getElementById("clear-session").click()');
  await wait(clearedCheckpointTab, 'document.getElementById("confirm-dialog").open');
  await evaluate(clearedCheckpointTab, 'document.getElementById("confirm-accept").click()');
  await wait(clearedCheckpointTab, 'document.getElementById("setup-label").textContent === "Connect your AI" && document.getElementById("setup-count").textContent === "1/3"');
  assert.equal(await evaluate(clearedCheckpointTab, 'document.getElementById("continue-generation").disabled'), true);
  assert.match(await evaluate(clearedCheckpointTab, 'document.getElementById("generation-checkpoint").textContent'), /cannot resume after a session change/);
  await evaluate(clearedCheckpointTab, 'document.getElementById("continue-generation").click();document.getElementById("retry-preview").click()');
  assert.equal(provider.calls.length, beforeClearFailure + 1, 'Session invalidation cannot trigger provider replay');
  provider.config.failKind = null;
  passed('checkpoint: attachment changes block continuation and require explicit replacement; Stop retains successful counts; session clear invalidates without silent provider replay');
  // A separate draft exercises digest/STT failures without disturbing prior cached work.
  const diagnosticTab = await tab(origin);
  await wait(diagnosticTab, 'document.getElementById("setup-count")?.textContent === "3/3"');
  const diagnosticSource = 'DIAGNOSTIC_PRIVATE_LONG_SOURCE ' + 'Synthetic bounded digest evidence. '.repeat(90) + ' DIAGNOSTIC_PRIVATE_TAIL';
  await setAudioMode(diagnosticTab, 'off');
  assert.ok(diagnosticSource.length > 2200);
  await writeFile('artifacts/english-audio-browser/diagnostic-long-source.md', diagnosticSource);
  await upload(diagnosticTab, '#material-input', ['artifacts/english-audio-browser/diagnostic-long-source.md', 'artifacts/english-audio-browser/test-audio.wav']);
  await attachments(diagnosticTab, 2);
  for (const [kind, stage, part] of [['digest', 'source_preparation', 1], ['transcription', 'transcription', 2]]) {
    provider.config.failKind = kind;
    const beforeFailure = provider.calls.filter(c => c.kind === kind).length;
    await evaluate(diagnosticTab, 'document.getElementById("lesson-form").requestSubmit()');
    await consent(diagnosticTab);
    await wait(diagnosticTab, '!document.getElementById("preview-error").hidden && !document.getElementById("generate-button").disabled');
    const report = await evaluate(diagnosticTab, 'JSON.parse(document.getElementById("diagnostic-report").textContent)');
    assert.equal(report.lastOperation.stage, stage);
    assert.equal(report.lastOperation.part.current, part);
    assert.equal(report.lastOperation.part.total, 2);
    assert.equal(report.lastOperation.upstreamStatus, 500);
    assert.equal(report.lastOperation.model, kind === 'digest' ? 'test/vision' : 'test/transcribe');
    assert.equal(provider.calls.filter(c => c.kind === kind).length - beforeFailure, 1, 'No automatic replay of the failed paid stage');
    assert.doesNotMatch(JSON.stringify(report), /DIAGNOSTIC_PRIVATE|diagnostic-long-source|Markdown source|Teach me about Newton|test-notes|test-audio|data:audio|Bearer/);
  }
  const callsBeforeCopy = provider.calls.length;
  await evaluate(diagnosticTab, 'Object.defineProperty(navigator,"clipboard",{configurable:true,value:{writeText:async text=>{window.__copiedReport=text}}});document.getElementById("copy-diagnostics").click()');
  await wait(diagnosticTab, 'typeof window.__copiedReport === "string"');
  assert.equal(await evaluate(diagnosticTab, 'window.__copiedReport === document.getElementById("diagnostic-report").textContent'), true);
  await evaluate(diagnosticTab, 'Object.defineProperty(navigator,"clipboard",{configurable:true,value:{writeText:async()=>{throw new Error("denied")}}});document.getElementById("copy-diagnostics").click()');
  await wait(diagnosticTab, 'getSelection().toString() === document.getElementById("diagnostic-report").textContent');
  assert.equal(provider.calls.length, callsBeforeCopy, 'Viewing/copying diagnostics is non-billable');
  provider.config.failKind = null;
  await evaluate(diagnosticTab, 'document.getElementById("error-back-draft").click();document.querySelector("#material-list button").click()');
  await wait(diagnosticTab, 'document.querySelectorAll("#material-list > li").length === 1 && !document.querySelector("#material-list button").disabled');
  await evaluate(diagnosticTab, 'document.querySelector("#material-list button").click()');
  await attachments(diagnosticTab, 0);
  passed('safe stage/part/model/status/timing diagnostics for digest, transcription and final failures; copy/fallback; no source/key leakage or automatic paid replay');
  // Two short parts force the checkpoint digest step; both must pass locally,
  // including the reported 2110-character transcript, not merely bypass preparation.
  const localTab = await tab(origin);
  await wait(localTab, 'document.getElementById("setup-count")?.textContent === "3/3"');
  const tinyTranscript = 'TINY_TRANSCRIPT_PRIVATE_BEGIN ' + 'a'.repeat(2052) + ' TINY_TRANSCRIPT_PRIVATE_END';
  assert.equal(tinyTranscript.length, 2110);
  provider.config.transcriptText = tinyTranscript;
  const beforeLocal = provider.calls.length;
  await upload(localTab, '#material-input', ['artifacts/english-audio-browser/test-audio.wav', 'artifacts/english-audio-browser/test-notes.md']); await attachments(localTab, 2);
  assert.equal(provider.calls.length, beforeLocal, 'Local imports never infer');
  await evaluate(localTab, 'document.getElementById("audio-mode").value="off";document.getElementById("audio-mode").dispatchEvent(new Event("input"));document.getElementById("lesson-form").requestSubmit()');
  await wait(localTab, 'document.getElementById("confirm-dialog").open');
  await evaluate(localTab, 'document.getElementById("confirm-cancel").click()');
  await wait(localTab, '!document.getElementById("generate-button").disabled');
  assert.equal(provider.calls.length, beforeLocal, '2110-character local preparation still requires consent');
  await evaluate(localTab, 'document.getElementById("lesson-form").requestSubmit()'); await consent(localTab); await created(localTab);
  const localCalls = provider.calls.slice(beforeLocal);
  assert.deepEqual(localCalls.map(c=>c.kind), ['transcription', 'lesson'], 'Zero provider digests for two bounded text parts');
  const localInput = localCalls[1].body.input[0].content[0].text;
  assert.ok(localInput.includes(tinyTranscript), 'All 2110 transcript characters survive verbatim');
  assert.ok(localInput.includes(sourceText + '\n' + longSentence), 'All short Markdown survives verbatim');
  assert.doesNotMatch(localInput, /AI digests are lossy/, 'Local preparation does not claim a lossy AI digest');
  const localReport = await evaluate(localTab, 'JSON.parse(document.getElementById("diagnostic-report").textContent)');
  const localOperations = localReport.operations.filter(op=>op.appEndpoint==='/materials/summarize');
  assert.equal(localOperations.length, 2); localOperations.forEach(assertLocalPreparation);
  assert.deepEqual(localOperations.map(op=>op.input.textCharacters), [2110, sourceText.length + 1 + longSentence.length]);
  assert.doesNotMatch(JSON.stringify(localReport), /TINY_TRANSCRIPT_PRIVATE|Markdown source|test-audio|test-notes|Bearer|data:audio/);
  provider.config.transcriptText = null;
  // Release this added case's temporary originals before the existing quota-sensitive media checks.
  await evaluate(localTab, 'document.getElementById("tab-compose").click();document.querySelector("#material-list button").click()');
  await attachments(localTab, 1);
  await wait(localTab, '!document.querySelector("#material-list button").disabled');
  await evaluate(localTab, 'document.querySelector("#material-list button").click()'); await attachments(localTab, 0);
  passed('2110-character transcript and short Markdown: two successful local preparation operations, zero provider digest calls, consent required, exact raw tails retained, no false lossy warning or diagnostic provider/model labels');
  if (fixtures.media.length) {
    const beforeMedia = provider.calls.length;
    await evaluate(s, 'document.getElementById("tab-compose").click()');
    await upload(s, '#material-input', fixtures.media.slice(0, 3));
    await attachments(s, 10);
    assert.equal(provider.calls.length, beforeMedia, 'Native MP3/MP4/WebM prepare with no provider calls');
    const mediaCards = await evaluate(s, '[...document.querySelectorAll("#material-list > li")].slice(-3).map(li=>({name:li.querySelector("strong").textContent,parts:li.querySelectorAll("select option").length}))');
    assert.equal(mediaCards[0].parts, 2, '181-second MP3 has automatic tail part');
    await evaluate(s, 'document.getElementById("lesson-form").requestSubmit()');
    await consent(s); await created(s);
    const mediaCalls = provider.calls.slice(beforeMedia);
    assert.equal(mediaCalls.filter(c=>c.kind==='transcription').length, mediaCards.reduce((sum,c)=>sum+c.parts,0), 'Every native audio part, including MP3 tail, transcribed');
    assert.ok(mediaCalls.filter(c=>c.kind==='transcription').every(c=>c.model==='test/transcribe'), 'Transcriptions use the assigned role');
    for (const card of mediaCards) for (let part=1;part<=card.parts;part++) {
      const expectedKind = card.name.endsWith('.mp3') ? 'lesson' : 'digest';
      assert.ok(mediaCalls.some(c=>c.kind===expectedKind && JSON.stringify(c.body.input).includes(card.name) && JSON.stringify(c.body.input).includes('(' + part + '/' + card.parts + ')')), 'Every native media part reaches a digest or verbatim final input');
    }
    assert.ok(mediaCalls.findLast(c=>c.kind==='lesson').body.input[0].content[0].text.includes(transcriptText), 'Short MP3 transcripts retain their final sentinel');
    await shot(s, 'app-native-media.png');
    // A fresh draft in the same private cookie session, with STT deliberately removed.
    await evaluate(s, 'document.querySelector("[data-page=providers]").click();document.getElementById("role-transcription-provider").value="";document.getElementById("role-transcription-provider").dispatchEvent(new Event("change"));document.getElementById("roles-form").requestSubmit()');
    await wait(s, 'document.getElementById("setup-count").textContent === "2/3" && !document.getElementById("roles-fields").disabled');
    const silent = await tab(origin);
    await wait(silent, 'document.getElementById("setup-count")?.textContent === "2/3"');
    const beforeSilent = provider.calls.length;
    await setAudioMode(silent, 'off');
    await upload(silent, '#material-input', [fixtures.media[3]]); await attachments(silent, 1);
    assert.equal(provider.calls.length, beforeSilent, 'Silent video local preparation is AI-free');
    await evaluate(silent, 'document.getElementById("learning-goal").value="Explain these video stills";document.getElementById("learning-goal").dispatchEvent(new Event("input"));document.getElementById("lesson-form").requestSubmit()');
    await consent(silent); await created(silent);
    assert.equal(provider.calls.slice(beforeSilent).filter(c=>c.kind==='transcription').length, 0, 'Silent video creates without a transcription role or STT call');
    passed('managed-cache MP3/MP4/WebM: every audio part transcribed, video stills digested, MP3 tail included; silent video creates without STT');
  } else {
    const note = 'SKIP: optional long MP3/MP4/WebM integration (set LEARNLENS_MEDIA_INTEGRATION=1); WAV and browser-native recording were tested. Real microphone permission/device remains unverified.';
    testLog.push(note); console.log(note);
  }
  // Native STT is explicit, independently verified, consented, and cache-scoped.
  // Run after other app-tab checks: these tabs intentionally share one fixture session.
  const nativeTab = await tab(origin);
  await wait(nativeTab, '!!document.getElementById("role-transcription-api") && !document.getElementById("roles-fields").disabled');
  const primaryBeforeNative = await evaluate(nativeTab, '["model","api","effort"].map(k=>document.getElementById("role-primary-"+k).value)');
  await setAudioMode(nativeTab, 'off');
  const setNativeMode = async (mode, model = null) => {
    await evaluate(nativeTab, `document.querySelector('[data-page="providers"]').click();${model ? `document.getElementById('role-transcription-provider').selectedIndex=1;document.getElementById('role-transcription-provider').dispatchEvent(new Event('change'));document.getElementById('role-transcription-model').value='__manual__';document.getElementById('role-transcription-model').dispatchEvent(new Event('change'));document.getElementById('role-transcription-manual').value=${JSON.stringify(model)};document.getElementById('role-transcription-manual').dispatchEvent(new Event('input'));` : ''}document.getElementById('role-transcription-api').value=${JSON.stringify(mode)};document.getElementById('role-transcription-api').dispatchEvent(new Event('change'))`);
    assert.match(await evaluate(nativeTab, 'document.querySelector("[data-role=transcription] .check-badges").textContent'), /Untested/, 'Other protocol sample check cannot verify this selection');
    const count = provider.calls.length;
    await evaluate(nativeTab, 'document.getElementById("roles-form").requestSubmit()');
    await wait(nativeTab, 'document.getElementById("roles-message").textContent.startsWith("Model roles saved") && !document.getElementById("roles-fields").disabled');
    assert.equal(provider.calls.length, count, 'Changing protocol does not make a provider call');
    assert.deepEqual(await evaluate(nativeTab, '["model","api","effort"].map(k=>document.getElementById("role-primary-"+k).value)'), primaryBeforeNative, 'Primary role is unchanged');
    await evaluate(nativeTab, 'document.querySelector("[data-page=lesson]").click();document.getElementById("tab-compose").click()');
  };
  const submitNative = async () => {
    await evaluate(nativeTab, 'document.getElementById("tab-compose").click();document.getElementById("lesson-form").requestSubmit()');
    await consent(nativeTab);
  };
  await setNativeMode('auto', 'gemini-audio-fixture');
  await upload(nativeTab, '#material-input', ['artifacts/english-audio-browser/test-audio.wav']); await attachments(nativeTab, 1);
  await submitNative(); await created(nativeTab);
  await setNativeMode('gemini');
  await evaluate(nativeTab, 'document.getElementById("lesson-form").requestSubmit()');
  await wait(nativeTab, 'document.getElementById("confirm-dialog").open');
  assert.match(await evaluate(nativeTab, 'document.getElementById("confirm-detail").textContent'), /Gemini-native audio \(generateContent\)/);
  const beforeNativeCancel = provider.calls.length;
  await evaluate(nativeTab, 'document.getElementById("confirm-cancel").click()');
  await wait(nativeTab, '!document.getElementById("confirm-dialog").open && !document.getElementById("generate-button").disabled');
  assert.equal(provider.calls.length, beforeNativeCancel);
  await submitNative(); await created(nativeTab);
  const nativeCalls = provider.calls.filter(c=>c.path === '/v1beta/models/gemini-audio-fixture:generateContent');
  assert.equal(nativeCalls.length, 1);
  assert.equal(nativeCalls[0].path, '/v1beta/models/gemini-audio-fixture:generateContent');
  assert.equal(nativeCalls[0].body.contents[0].parts[1].inlineData.mimeType, 'audio/wav');
  assert.match(await evaluate(nativeTab, 'document.querySelector("[data-role=transcription] .check-badges").textContent'), /Verified/);
  assert.ok(provider.calls.findLast(c=>c.kind==='lesson').body.input[0].content[0].text.includes('Gemini-native synthetic transcript'));
  assert.ok(!JSON.stringify(provider.calls.findLast(c=>c.kind==='lesson').body).includes('Excluded fixture thinking'));
  await evaluate(nativeTab, 'document.querySelector("[data-page=providers]").click();document.querySelector("[data-role=transcription]").scrollIntoView({block:"center"})');
  await call('Emulation.setDeviceMetricsOverride', { width: 320, height: 700, deviceScaleFactor: 1, mobile: true }, nativeTab);
  assert.equal(await evaluate(nativeTab, 'document.documentElement.scrollWidth <= innerWidth'), true, 'Native selector/help fit 320px');
  await evaluate(nativeTab, 'document.getElementById("role-transcription-api").scrollIntoView({block:"center"})');
  await shot(nativeTab, 'app-gemini-audio.png');
  await evaluate(nativeTab, 'document.querySelector("[data-page=lesson]").click()');
  await submitNative(); await created(nativeTab);
  assert.equal(provider.calls.filter(c=>c.path === '/v1beta/models/gemini-audio-fixture:generateContent').length, 1, 'Renewed consent reuses successful native transcription');
  await setNativeMode('auto');
  const beforeOpenAI = provider.calls.filter(c=>c.path==='/v1/audio/transcriptions').length;
  await submitNative(); await created(nativeTab);
  assert.equal(provider.calls.filter(c=>c.path==='/v1/audio/transcriptions').length, beforeOpenAI + 1, 'Different protocol never reuses native transcript');
  await setNativeMode('gemini'); provider.config.failKind = 'transcription';
  const beforeNativeFailure = provider.calls.length;
  await submitNative();
  await wait(nativeTab, '!document.getElementById("preview-error").hidden && !document.getElementById("generate-button").disabled');
  assert.equal(provider.calls.length, beforeNativeFailure + 1, 'Native failure never falls back or retries');
  const nativeReport = await evaluate(nativeTab, 'JSON.parse(document.getElementById("diagnostic-report").textContent)');
  assert.equal(nativeReport.lastOperation.apiMode, 'gemini.generateContent');
  assert.equal(nativeReport.lastOperation.endpoint, '/models/{model}:generateContent');
  assert.equal(nativeReport.lastOperation.automaticRetry, false);
  assert.doesNotMatch(JSON.stringify(nativeReport), /test-audio|Gemini-native synthetic transcript|inlineData|data:audio/);
  assert.equal(await evaluate(nativeTab, 'document.querySelectorAll("#material-list > li").length'), 1);
  assert.equal(await evaluate(nativeTab, 'document.getElementById("show-previous").hidden'), false);
  await evaluate(nativeTab, 'document.getElementById("show-previous").click()');
  await wait(nativeTab, '!document.getElementById("preview-result").hidden');
  provider.config.failKind = null;
  passed('explicit Gemini-native STT selector; scoped verification/cache; cancelled and renewed consent; unchanged primary; inline WAV; thought exclusion; safe failure without replay; prior lesson/draft preserved; 320px layout');
  // Focused complete-audio recovery uses its own draft, before shared-hostname gated logout.
  const originalContext = browserContextId;
  ({ browserContextId } = await call('Target.createBrowserContext')); extraContexts.push(browserContextId);
  const full = await tab(origin);
  browserContextId = originalContext;
  await wait(full, 'document.getElementById("setup-label")?.textContent === "Connect your AI"');
  await evaluate(full, `document.querySelector('[data-page="providers"]').click();document.getElementById('provider-name').value='Full audio QA';document.getElementById('provider-url').value=${JSON.stringify(providerOrigin+'/v1')};document.getElementById('provider-form').requestSubmit()`);
  await wait(full, '!!document.querySelector(".provider-name")');
  await evaluate(full, 'document.querySelector(".discover-button").click()');
  await wait(full, 'document.querySelector(".provider-model-count")?.textContent === "4 listed models"');
  await evaluate(full, `for(const [role,model] of [['primary','test/vision'],['transcription','test/transcribe']]){const p=document.getElementById('role-'+role+'-provider');p.selectedIndex=1;p.dispatchEvent(new Event('change'));const m=document.getElementById('role-'+role+'-model');m.value=model;m.dispatchEvent(new Event('change'))}document.getElementById('roles-form').requestSubmit()`);
  await wait(full, 'document.getElementById("setup-count")?.textContent === "3/3" && !document.getElementById("roles-fields").disabled');
  await evaluate(full, 'document.querySelector("[data-page=lesson]").click()');
  await evaluate(full, 'document.querySelector("[data-action=demo]").click()'); await created(full);
  const priorFull = await evaluate(full, 'document.getElementById("lesson-frame").srcdoc');
  await evaluate(full, 'document.getElementById("tab-compose").click();document.getElementById("audio-mode").value="on";document.getElementById("audio-mode").dispatchEvent(new Event("input"))');
  await upload(full, '#material-input', ['artifacts/english-audio-browser/test-notes.md', 'artifacts/english-audio-browser/test-screenshot.png', 'artifacts/english-audio-browser/test-audio.wav']); await attachments(full, 3);
  const beforeFull = provider.calls.length, beforeFullSpeech = kokoro.calls.filter(c=>c.kind==='speech').length;
  await evaluate(full, 'document.getElementById("lesson-form").requestSubmit()'); await consent(full); await exactConsent(full, false); await created(full);
  assert.equal(kokoro.calls.filter(c=>c.kind==='speech').length, beforeFullSpeech, 'Exact-count cancellation dispatches no TTS');
  const retainedText = await evaluate(full, 'document.getElementById("lesson-frame").srcdoc');
  assert.notEqual(retainedText, priorFull);
  await evaluate(full, 'document.getElementById("switch-previous").click()');
  assert.equal(await evaluate(full, 'document.getElementById("lesson-frame").srcdoc'), priorFull);
  await evaluate(full, 'document.getElementById("switch-previous").click()');
  assert.equal(await evaluate(full, 'document.getElementById("lesson-frame").srcdoc'), retainedText);
  const preparedFull = provider.calls.length;
  const resumeFull = async () => {
    await evaluate(full, 'document.getElementById("continue-audio").click()');
    await wait(full, 'document.getElementById("confirm-dialog").open');
    assert.match(await evaluate(full, 'document.getElementById("confirm-title").textContent'), /Resume this retained/);
    await evaluate(full, 'document.getElementById("confirm-accept").click()');
    await exactConsent(full);
    await wait(full, '!document.getElementById("generate-button").disabled');
  };
  kokoro.config.failAfter = beforeFullSpeech + 2;
  await resumeFull();
  assert.equal(provider.calls.length, preparedFull, 'Resume never re-runs primary/OCR/STT');
  assert.equal(kokoro.calls.filter(c=>c.kind==='speech').length, beforeFullSpeech + 3, 'Two clips complete, third fails once; no automatic retry');
  assert.match(await evaluate(full, 'document.getElementById("audio-count").textContent'), /^2\/\d+.*partial/);
  const partial = await evaluate(full, 'document.getElementById("lesson-frame").srcdoc');
  assert.match(partial, /data:audio\/mpeg;base64/); assert.match(partial, /Incomplete/);
  await writeFile('artifacts/english-audio-browser/browser-partial-audio.html', partial);
  const diagnostics = await evaluate(full, 'document.getElementById("diagnostic-report").textContent');
  assert.doesNotMatch(diagnostics, /Original text|Screenshot final|Newton|test-notes|test-screenshot|test-audio|data:audio|Bearer|"(?:requestBody|responseBody|filename|sourceText)"/);
  assert.deepEqual(JSON.parse(diagnostics).lastOperation.input, { clips: 1 }, 'Diagnostic input is counts only, never provider request body');
  assert.equal(JSON.parse(diagnostics).lastOperation.responseBodyOmitted, true);
  const totalFull = Number((await evaluate(full, 'document.getElementById("audio-count").textContent')).match(/\/(\d+)/)[1]);
  kokoro.config.failAfter = null;
  await resumeFull();
  assert.equal(kokoro.calls.filter(c=>c.kind==='speech').length, beforeFullSpeech + totalFull + 1, 'Explicit resume reuses both completed clips and only retries remaining');
  assert.equal(provider.calls.length, preparedFull, 'Recovery never repeats source/teaching calls');
  assert.match(await evaluate(full, 'document.getElementById("audio-count").textContent'), new RegExp('^'+totalFull+'/'+totalFull+'.*complete'));
  assert.ok(provider.calls.slice(beforeFull, preparedFull).some(c=>c.kind==='audio-extract'));
  passed('full audio: exact-count cancellation retains new text and previous lesson; two-step resume; mid-batch 500 partial export without auto-retry; completed clips reused; no teaching/OCR/STT replay or diagnostic source leakage');
  // Stop an in-flight speech request. A renewed explicit continuation polls GET status,
  // not a blind POST replay, while the original delayed provider operation finishes.
  kokoro.config.speechDelay = 5000;
  const stopSpeechBefore = kokoro.calls.filter(c=>c.kind==='speech').length;
  await evaluate(full, 'document.getElementById("tab-compose").click();document.getElementById("lesson-form").requestSubmit()');
  await consent(full); await exactConsent(full);
  const waitLocal = async predicate => { const start=Date.now(); while(!predicate()){ if(Date.now()-start>15000)throw Error('Local fixture condition timed out');await new Promise(r=>setTimeout(r,40)); } };
  await waitLocal(()=>kokoro.calls.filter(c=>c.kind==='speech').length===stopSpeechBefore+1);
  kokoro.config.speechDelay = 0;
  await evaluate(full, 'document.getElementById("stop-audio").click()');
  await wait(full, '!document.getElementById("generate-button").disabled');
  assert.equal(kokoro.calls.filter(c=>c.kind==='speech').length, stopSpeechBefore+1);
  const stoppedRequests = browserRequests.length, stoppedPreparation = provider.calls.length;
  await evaluate(full, 'document.getElementById("continue-audio").click()');
  await wait(full, 'document.getElementById("confirm-dialog").open');
  await evaluate(full, 'document.getElementById("confirm-accept").click()');
  await wait(full, 'document.getElementById("confirm-dialog").open || !document.getElementById("generate-button").disabled');
  if (!await evaluate(full, 'document.getElementById("confirm-dialog").open')) {
    const notice = await evaluate(full, 'document.getElementById("audio-message").textContent');
    const failure = 'Immediate Stop/Continue cannot reach exact-count consent or GET clip polling: ' + notice;
    lifecycleFailures.push(failure); testLog.push('FAIL: ' + failure);
    await writeFile('artifacts/english-audio-browser/full-audio-stop-failure.json', JSON.stringify({ notice, requests: browserRequests.slice(stoppedRequests) }, null, 2));
    await shot(full, 'app-full-audio-stop-failure.png');
  } else {
    await exactConsent(full);
    await waitLocal(()=>browserRequests.slice(stoppedRequests).some(r=>r.method==='GET' && /\/clips\//.test(r.path)));
    assert.equal(browserRequests.slice(stoppedRequests).filter(r=>r.method==='POST' && /\/clips\//.test(r.path)).length, 0, 'Unknown in-flight operation is GET-polled, never automatically replayed');
    await wait(full, '!document.getElementById("generate-button").disabled');
    assert.equal(provider.calls.length, stoppedPreparation);
    assert.equal(kokoro.calls.filter(c=>c.kind==='speech').length, stopSpeechBefore+totalFull, 'Stop/resume completes each clip exactly once');
    passed('Stop retains text; renewed consent resolves unknown in-flight speech with GET-only polling and no POST replay');
  }
  const login = await tab(gatedOrigin);
  await wait(login, 'document.getElementById("login-panel")?.hidden === false');
  await evaluate(login, 'document.getElementById("access-password").value="test-private-beta-password";document.getElementById("login-form").requestSubmit()');
  await wait(login, 'document.getElementById("login-panel").hidden');
  await evaluate(login, 'document.getElementById("clear-session").click()');
  await wait(login, 'document.getElementById("confirm-dialog").open');
  await evaluate(login, 'document.getElementById("confirm-accept").click()');
  await wait(login, '!document.getElementById("login-panel").hidden');
  const offline = await tab(pathToFileURL(downloadedPath).href);
  await call('Network.enable', {}, offline);
  await call('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 }, offline);
  await call('Page.reload', {}, offline);
  await wait(offline, '!!document.querySelector("[data-speed]")');
  assert.equal(await evaluate(offline, 'Boolean(window.__learnlensExportInjection)'), false, 'Direct offline HTML does not execute provider-supplied scripts');
  assert.ok(await evaluate(offline, 'document.body.textContent.includes("<script>window.__learnlensExportInjection=true</script>")'), 'Provider markup is rendered as inert text');
  await verifyFullPlayer(offline, { synthetic: true });
  await shot(offline, 'offline-full-audio.png');
  if (process.env.LEARNLENS_NATIVE_FULL_AUDIO_LESSON) {
    const nativeFullPath = resolve(process.env.LEARNLENS_NATIVE_FULL_AUDIO_LESSON);
    assert.match(await readFile(nativeFullPath, 'utf8'), /data:audio\/mpeg;base64,/);
    await call('Page.navigate', { url: pathToFileURL(nativeFullPath).href }, offline);
    await wait(offline, '!!document.getElementById("course-player")');
    await verifyFullPlayer(offline);
    await shot(offline, 'native-offline-full-audio.png');
    passed('supplied full MP3 export decoded and played offline with controls (fixture playback, not a new synthesis/voice-quality claim)');
  } else passed('optional real-native full export not supplied; synthetic MP3 fixture is not native voice verification');
  if (process.env.LEARNLENS_NATIVE_LESSON) {
    const nativePath = resolve(process.env.LEARNLENS_NATIVE_LESSON);
    assert.match(await readFile(nativePath, 'utf8'), /data:audio\/wav;base64,/);
    await call('Page.navigate', { url: pathToFileURL(nativePath).href }, offline);
    await wait(offline, '!!document.querySelector("audio")');
    await evaluate(offline, 'document.querySelector("audio").load()');
    await wait(offline, 'document.querySelector("audio")?.readyState >= 1');
    assert.ok(await evaluate(offline, 'document.querySelector("audio").duration > 1'), 'Real native speech decodes offline');
    for (const speed of [1, 0.75, 0.5]) {
      await evaluate(offline, `document.querySelector('[data-speed="${speed}"]').click();document.querySelector('audio').load()`);
      await wait(offline, 'document.querySelector("audio").readyState >= 1');
      assert.equal(await evaluate(offline, 'document.querySelector("audio").playbackRate'), speed);
    }
    await evaluate(offline, 'document.querySelector("summary").click()');
    assert.equal(await evaluate(offline, 'document.querySelector("details").open'), true);
    const nativePlaying = await call('Runtime.evaluate', { expression: 'document.querySelector("audio").play().then(()=>true)', awaitPromise: true, returnByValue: true, userGesture: true }, offline);
    assert.equal(nativePlaying.result.value, true);
    await wait(offline, 'document.querySelector("audio").currentTime > 0.1');
    assert.deepEqual(await evaluate(offline, 'performance.getEntriesByType("resource").filter(r=>/^https?:/.test(r.name)).map(r=>r.name)'), []);
    await shot(offline, 'native-offline-lesson.png');
    passed('supplied WAV export decoded and played offline; 1×/0.75×/0.5× rates survive reload; answers work; no HTTP(S) resources (no new synthesis)');
  }
  passed('gated login/logout; direct offline HTML script escaping, actual audio playback, 1×/0.75×/0.5× rates and revealable answers with no HTTP(S) resources');
  if (longWaitRun) {
    const outcome = await longWaitRun;
    if (outcome.error) throw outcome.error;
    await writeFile('artifacts/english-audio-browser/timeout-notes-long-wait.json', JSON.stringify(outcome.result, null, 2));
  }
  }
  assert.deepEqual(errors.filter(error => !/Failed to load resource:.*502/.test(error) && !(longWaitRun && /Failed to load resource:.*504.*\/api\/lessons/.test(error))), [], 'Unexpected browser console/CSP errors');
  assert.deepEqual(lifecycleFailures, [], 'Full audio lifecycle failures (recorded while allowing offline/native checks to finish)');
  passed(process.env.LEARNLENS_BROWSER_SUITE === 'english-audio' ? 'Targeted English-audio checks finished; legacy/full/native replay intentionally not run.' : '1440/390/320px layouts; sandbox; discovery/roles/consented probe; unified imports; generation/failure recovery; actual download; OpenAI preset; consented model advisor + thinking controls; online/Kokoro speech routing; password gate; offline audio playback/speed/answers.');
} catch (error) {
  testLog.push('FAIL: ' + error.message);
  throw error;
} finally {
  await writeFile(resolve('artifacts/english-audio-browser/english-audio-evidence.json'), JSON.stringify(englishAudioEvidence, null, 2));
  await writeFile(resolve('artifacts/english-audio-browser/browser-smoke.log'), testLog.join('\n') + '\n');
  await writeFile(resolve('artifacts/english-audio-browser/full-audio-browser.log'), testLog.join('\n') + '\n');
  await writeFile(resolve('artifacts/english-audio-browser/checkpoint-browser.log'), testLog.join('\n') + '\n');
  await writeFile(resolve('artifacts/english-audio-browser/preparation-browser.log'), testLog.join('\n') + '\n');
  for (const targetId of targets) await call('Target.closeTarget', { targetId }).catch(() => {});
  for (const context of [browserContextId, ...extraContexts].filter(Boolean)) await call('Target.disposeBrowserContext', { browserContextId: context });
  ws.close();
  await Promise.all([app, provider.server, kokoro.server, gated, ...longWaitProviders.map(p=>p.server), ...englishAudioProviders.map(p=>p.server)].filter(Boolean).map(close));
}
