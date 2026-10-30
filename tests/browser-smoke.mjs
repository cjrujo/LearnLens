// Run against a disposable headless Chromium debugging instance on :9333.
// Starts its own app + mock provider. No credentials, external services or paid AI.
import assert from 'node:assert/strict';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApp } from '../server.mjs';
import { probeImage } from '../lib/provider.mjs';
import { createQAProvider, wav, listen, close, importFixtures } from './browser-fixtures.mjs';
const publicDirectory = resolve(process.env.LEARNLENS_TEST_UI || 'public');
process.env.LEARNLENS_MEDIA_OFFLINE = '1';
// Node-side provider calls and tool acquisition must stay loopback/offline.
const realFetch = globalThis.fetch;
globalThis.fetch = (input, options) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('Browser smoke forbids non-loopback network');
  return realFetch(input, options);
};
const testLog = [];
function passed(message) { testLog.push('PASS: ' + message); console.log('PASS: ' + message); }
let downloadComplete;
const downloadFinished = new Promise(resolve => { downloadComplete = resolve; });
const version = await (await fetch('http://127.0.0.1:9333/json/version', { signal: AbortSignal.timeout(5000) })).json();
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let seq = 0, browserContextId; const pending = new Map(), errors = [], targets = [];
ws.onmessage = event => {
  const msg = JSON.parse(event.data);
  if (msg.method === 'Browser.downloadProgress' && msg.params.state === 'completed') downloadComplete();
  if (msg.method === 'Fetch.requestPaused') {
    const url = new URL(msg.params.request.url);
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
async function created(session) {
  await wait(session, 'document.getElementById("preview-loading").hidden && (!document.getElementById("preview-result").hidden || !document.getElementById("preview-error").hidden) && !document.getElementById("generate-button").disabled');
  assert.equal(await evaluate(session, 'document.getElementById("preview-error").hidden'), true, await evaluate(session, 'document.getElementById("preview-error-message").textContent'));
}
async function attachments(session, count) {
  await wait(session, `document.querySelectorAll('#material-list > li').length === ${count} && document.getElementById('material-list').getAttribute('aria-busy') === 'false'`);
  assert.equal(await evaluate(session, 'document.querySelectorAll("#material-list .inline-message.error").length'), 0, await evaluate(session, 'document.getElementById("material-list").innerText'));
}
async function shot(session, name) { await call('Page.bringToFront', {}, session); const { data } = await call('Page.captureScreenshot', { format: 'png' }, session); await writeFile(resolve('artifacts', name), Buffer.from(data, 'base64')); }
async function upload(session, selector, files) { const { root } = await call('DOM.getDocument', {}, session); const { nodeId } = await call('DOM.querySelector', { nodeId: root.nodeId, selector }, session); await call('DOM.setFileInputFiles', { nodeId, files: files.map(file => resolve(file)) }, session); }
const provider = createQAProvider(), kokoro = createQAProvider(), gated = createApp({ publicDirectory, accessPassword: 'test-private-beta-password' }).server;
let app;
try {
  const providerOrigin = await listen(provider.server), kokoroOrigin = await listen(kokoro.server);
  app = createApp({ publicDirectory, kokoroBaseUrl: kokoroOrigin + '/v1', kokoroBuiltin: true, kokoroFormat: 'wav', kokoroLanguages: ['en'] }).server;
  const origin = await listen(app), gatedOrigin = await listen(gated);
  ({ browserContextId } = await call('Target.createBrowserContext'));
  await mkdir('artifacts', { recursive: true });
  await writeFile('artifacts/test-screenshot.png', Buffer.from(probeImage().dataUrl.split(',')[1], 'base64'));
  await writeFile('artifacts/test-audio.wav', wav);
  await writeFile('artifacts/test-notes.md', 'A short Markdown source file.');
  const downloads = resolve('artifacts', 'downloads-' + Date.now());
  await mkdir(downloads);
  await call('Browser.setDownloadBehavior', { behavior: 'allow', browserContextId, downloadPath: downloads, eventsEnabled: true });
  const s = await tab(origin);
  await wait(s, 'document.getElementById("setup-label")?.textContent === "Connect your AI"');
  await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }, s);
  assert.equal(await evaluate(s, 'document.getElementById("provider-url").value'), 'https://api.openai.com/v1');
  assert.equal(await evaluate(s, 'document.getElementById("role-speech-engine").value'), 'kokoro', 'Built-in speech needs no learner setup');
  assert.equal(await evaluate(s, 'document.getElementById("role-speech-voice").value'), 'af_heart');
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
  await evaluate(s, 'document.getElementById("use-starter").click()');
  assert.equal(await evaluate(s, 'document.getElementById("role-primary-model").value'), 'gpt-5.4-mini');
  await evaluate(s, 'document.getElementById("role-primary-effort").value="high";document.getElementById("role-primary-effort").dispatchEvent(new Event("change"));document.getElementById("recommend-models").click()');
  await wait(s, 'document.getElementById("confirm-dialog").open');
  assert.equal(provider.calls.filter(c => c.path === '/v1/responses').length, 0, 'No inference before explicit advisor consent');
  await evaluate(s, 'document.getElementById("confirm-consent").click();document.getElementById("confirm-accept").click()');
  await wait(s, '!document.getElementById("recommend-results").hidden');
  assert.equal(provider.calls.at(-1).body.reasoning.effort, 'high');
  assert.equal(await evaluate(s, 'document.getElementById("setup-count").textContent'), '1/3', 'Advice cannot save roles');
  await evaluate(s, 'document.querySelector("#recommend-cards input[data-role=primary]").click();document.querySelector("#recommend-cards input[data-role=speech]").click();document.getElementById("apply-recommendations").click()');
  assert.equal(await evaluate(s, 'document.getElementById("role-primary-model").value'), 'test/vision');
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
  await evaluate(s, `document.getElementById('confirm-consent').click();document.getElementById('confirm-accept').click()`);
  await wait(s, `document.querySelector('[data-role="primary"] .check-badges').textContent.includes('vision: Verified')`);
  await shot(s, 'app-providers.png');
  await evaluate(s, `document.querySelector('[data-page="lesson"]').click();document.getElementById('tab-compose').click();document.getElementById('learning-goal').value='Explain this screenshot with examples.';document.getElementById('learning-goal').dispatchEvent(new Event('input'));document.getElementById('include-audio').checked=true;document.getElementById('include-audio').dispatchEvent(new Event('input'))`);
  const beforeUpload = provider.calls.length;
  await upload(s, '#material-input', ['artifacts/test-screenshot.png', 'artifacts/test-notes.md', 'artifacts/test-audio.wav']);
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
  assert.ok(provider.calls.slice(beforeUpload).some(c=>c.kind==='transcription'), 'Attached WAV transcribed only after creation consent');
  assert.ok(provider.calls.slice(beforeUpload).filter(c=>c.kind==='digest').length >= 3, 'Every material enters paid digest preparation');
  assert.ok(provider.calls.slice(beforeUpload).filter(c=>['lesson','digest'].includes(c.kind)).every(c=>c.body.model==='test/vision'), 'Primary role handles sources and final lesson');
  assert.equal(await evaluate(s, 'document.getElementById("learning-goal").value'), 'Explain this screenshot with examples.', 'Transcription never overwrites instructions');
  passed('unified image/Markdown/WAV input; no upload/local-preparation calls; cancelled consent sends nothing; role-routed paid creation');
  assert.match(await evaluate(s, 'document.getElementById("download-lesson").href'), /^blob:/);
  const html = await evaluate(s, 'document.getElementById("lesson-frame").srcdoc');
  assert.match(html, /data:audio\/wav;base64/);
  assert.match(html, /data:image\/png;base64/);
  assert.doesNotMatch(html, /src="https?:/);
  assert.doesNotMatch(html, /<script>window\.__learnlensExportInjection=true<\/script>/, 'Provider text cannot inject executable export markup');
  await call('Runtime.evaluate', { expression: 'document.getElementById("download-lesson").click()', userGesture: true }, s);
  const downloadedPath = resolve(downloads, 'LearnLens-Browser-integration-test.html');
  let downloadTimer;
  try { await Promise.race([downloadFinished, new Promise((_, reject) => { downloadTimer = setTimeout(()=>reject(new Error('Download did not complete')), 15000); })]); }
  finally { clearTimeout(downloadTimer); }
  const downloaded = await readFile(downloadedPath, 'utf8');
  assert.equal(downloaded, html, 'Actual browser download matches the preview document');
  await writeFile('artifacts/browser-export.html', downloaded);
  await shot(s, 'app-generated.png');
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
  const fixtures = await importFixtures(resolve('artifacts/browser-import-fixtures'), { media: process.env.LEARNLENS_MEDIA_INTEGRATION === '1' });
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
  const recordingPath = resolve('artifacts/browser-import-fixtures/browser-recording.webm');
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
  for (let slide=1;slide<=6;slide++) assert.ok(digestText.includes('Ordered slide ' + slide), 'Digest includes slide ' + slide);
  for (const card of cards.slice(3)) for (let part=1;part<=card.parts;part++) {
    assert.ok(documentCalls.some(c=>c.kind==='digest' && JSON.stringify(c.body.input).includes(card.name) && JSON.stringify(c.body.input).includes('(' + part + '/' + card.parts + ')')), 'Every automatic part reaches primary: ' + card.name + ' part ' + part);
  }
  assert.equal(documentCalls.filter(c=>c.kind==='transcription').length, cards.find(c=>c.name==='browser-recording.webm').parts, 'Browser recording transcribed after consent');
  const completedPaid = provider.calls.filter(c=>['digest','transcription'].includes(c.kind)).length;
  provider.config.failKind = null;
  await evaluate(s, 'document.getElementById("retry-preview").click()');
  await consent(s); await created(s);
  assert.equal(provider.calls.filter(c=>['digest','transcription'].includes(c.kind)).length, completedPaid, 'Explicit retry reuses every finished digest/transcription');
  const finalInput = JSON.stringify(provider.calls.findLast(c=>c.kind==='lesson').body.input);
  for (const card of cards) for (let part=1;part<=card.parts;part++) assert.ok(finalInput.includes(card.name) && finalInput.includes('(' + part + '/' + card.parts + ')'), 'Final lesson includes prepared source ' + card.name + ' part ' + part);
  passed('all document pages/Office chunks reach primary digests and final lesson; final failure retains attachments/previous lesson; retry does not repeat finished paid preparation');
  // A separate draft exercises digest/STT failures without disturbing prior cached work.
  const diagnosticTab = await tab(origin);
  await wait(diagnosticTab, 'document.getElementById("setup-count")?.textContent === "3/3"');
  await upload(diagnosticTab, '#material-input', ['artifacts/test-notes.md', 'artifacts/test-audio.wav']);
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
    assert.doesNotMatch(JSON.stringify(report), /Markdown source|Teach me about Newton|test-notes|test-audio|data:audio|Bearer/);
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
    for (const card of mediaCards) for (let part=1;part<=card.parts;part++) assert.ok(mediaCalls.some(c=>c.kind==='digest' && JSON.stringify(c.body.input).includes(card.name) && JSON.stringify(c.body.input).includes('(' + part + '/' + card.parts + ')')), 'Every native media part reaches a digest');
    await shot(s, 'app-native-media.png');
    // A fresh draft in the same private cookie session, with STT deliberately removed.
    await evaluate(s, 'document.querySelector("[data-page=providers]").click();document.getElementById("role-transcription-provider").value="";document.getElementById("role-transcription-provider").dispatchEvent(new Event("change"));document.getElementById("roles-form").requestSubmit()');
    await wait(s, 'document.getElementById("setup-count").textContent === "2/3" && !document.getElementById("roles-fields").disabled');
    const silent = await tab(origin);
    await wait(silent, 'document.getElementById("setup-count")?.textContent === "2/3"');
    const beforeSilent = provider.calls.length;
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
  for (const speed of [1, 0.75, 0.5]) {
    await evaluate(offline, `document.querySelector('[data-speed="${speed}"]').click();document.querySelector('audio').load()`);
    await wait(offline, 'document.querySelector("audio").readyState >= 1');
    assert.equal(await evaluate(offline, 'document.querySelector("audio").playbackRate'), speed, 'Offline playback rate survives media reload');
  }
  await evaluate(offline, `document.querySelector('[data-speed="0.5"]').click();document.querySelector('summary').click();document.querySelector('audio').load()`);
  assert.equal(await evaluate(offline, 'document.querySelector("audio").playbackRate'), 0.5);
  assert.equal(await evaluate(offline, 'document.querySelector("details").open'), true);
  await wait(offline, 'document.querySelector("audio").readyState >= 1');
  assert.equal(await evaluate(offline, 'document.querySelector("audio").duration'), 1);
  assert.deepEqual(await evaluate(offline, 'performance.getEntriesByType("resource").filter(r=>/^https?:/.test(r.name)).map(r=>r.name)'), []);
  const playing = await call('Runtime.evaluate', { expression: 'document.querySelector("audio").play().then(()=>true)', awaitPromise: true, returnByValue: true, userGesture: true }, offline);
  assert.equal(playing.result.value, true, 'Offline audio starts playback');
  await wait(offline, 'document.querySelector("audio").currentTime > 0.1');
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
    console.log('PASS: real native Kokoro WAV decoded and played offline; 1×/0.75×/0.5× rates survive reload; answers work; no HTTP(S) resources.');
  }
  passed('gated login/logout; direct offline HTML script escaping, actual audio playback, 1×/0.75×/0.5× rates and revealable answers with no HTTP(S) resources');
  assert.deepEqual(errors.filter(error => !/Failed to load resource:.*502/.test(error)), [], 'Unexpected browser console/CSP errors');
  passed('1440/390/320px layouts; sandbox; discovery/roles/consented probe; unified imports; generation/failure recovery; actual download; OpenAI preset; consented model advisor + thinking controls; online/Kokoro speech routing; password gate; offline audio playback/speed/answers.');
} catch (error) {
  testLog.push('FAIL: ' + error.message);
  throw error;
} finally {
  await writeFile(resolve('artifacts/browser-smoke.log'), testLog.join('\n') + '\n');
  for (const targetId of targets) await call('Target.closeTarget', { targetId }).catch(() => {});
  if (browserContextId) await call('Target.disposeBrowserContext', { browserContextId });
  ws.close();
  await Promise.all([app, provider.server, kokoro.server, gated].filter(Boolean).map(close));
}
