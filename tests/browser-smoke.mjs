// Run against a disposable headless Chromium debugging instance on :9333.
// Starts its own app + mock provider. No credentials, external services or paid AI.
import assert from 'node:assert/strict';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApp } from '../server.mjs';
import { probeImage } from '../lib/provider.mjs';
import { createQAProvider, wav, listen, close } from './browser-fixtures.mjs';
const version = await (await fetch('http://127.0.0.1:9333/json/version', { signal: AbortSignal.timeout(5000) })).json();
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let seq = 0, browserContextId; const pending = new Map(), errors = [], targets = [];
ws.onmessage = event => {
  const msg = JSON.parse(event.data);
  if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.text + ': ' + msg.params.exceptionDetails.exception?.description);
  if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') errors.push(msg.params.entry.text + (msg.params.entry.url ? ' [' + msg.params.entry.url + ']' : ''));
  if (pending.has(msg.id)) { const item = pending.get(msg.id); pending.delete(msg.id); clearTimeout(item.timer); msg.error ? item.reject(new Error(msg.error.message)) : item.resolve(msg.result); }
};
function call(method, params = {}, sessionId) { return new Promise((resolve, reject) => { const id = ++seq; const timer = setTimeout(() => { pending.delete(id); reject(new Error('Timeout: ' + method)); }, 15000); pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params, sessionId })); }); }
async function tab(url) { const { targetId } = await call('Target.createTarget', { url, browserContextId }); targets.push(targetId); const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true }); await call('Runtime.enable', {}, sessionId); await call('Log.enable', {}, sessionId); await call('Page.enable', {}, sessionId); return sessionId; }
async function evaluate(session, expression) { const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, session); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text); return result.result.value; }
async function wait(session, expression) { const start = Date.now(); while (!await evaluate(session, expression)) { if (Date.now() - start > 15000) throw new Error('Condition timed out: ' + expression); await new Promise(resolve => setTimeout(resolve, 80)); } }
async function shot(session, name) { const { data } = await call('Page.captureScreenshot', { format: 'png' }, session); await writeFile(resolve('artifacts', name), Buffer.from(data, 'base64')); }
async function upload(session, selector, files) { const { root } = await call('DOM.getDocument', {}, session); const { nodeId } = await call('DOM.querySelector', { nodeId: root.nodeId, selector }, session); await call('DOM.setFileInputFiles', { nodeId, files: files.map(file => resolve(file)) }, session); }
const provider = createQAProvider(), kokoro = createQAProvider(), gated = createApp({ accessPassword: 'test-private-beta-password' }).server;
let app;
try {
  const providerOrigin = await listen(provider.server), kokoroOrigin = await listen(kokoro.server);
  app = createApp({ kokoroBaseUrl: kokoroOrigin + '/v1', kokoroBuiltin: true, kokoroFormat: 'wav', kokoroLanguages: ['en'] }).server;
  const origin = await listen(app), gatedOrigin = await listen(gated);
  ({ browserContextId } = await call('Target.createBrowserContext'));
  await mkdir('artifacts', { recursive: true });
  await writeFile('artifacts/test-screenshot.png', Buffer.from(probeImage().dataUrl.split(',')[1], 'base64'));
  await writeFile('artifacts/test-audio.wav', wav);
  await writeFile('artifacts/test-notes.md', 'A short Markdown source file.');
  const downloads = resolve('artifacts', 'downloads-' + Date.now());
  await mkdir(downloads);
  await call('Browser.setDownloadBehavior', { behavior: 'allow', browserContextId, downloadPath: downloads });
  const s = await tab(origin);
  await wait(s, 'document.getElementById("setup-label")?.textContent === "Connect your AI"');
  await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }, s);
  assert.equal(await evaluate(s, 'document.getElementById("provider-url").value'), 'https://api.openai.com/v1');
  assert.equal(await evaluate(s, 'document.getElementById("role-speech-engine").value'), 'kokoro', 'Built-in speech needs no learner setup');
  assert.equal(await evaluate(s, 'document.getElementById("role-speech-voice").value'), 'af_heart');
  await shot(s, 'app-desktop.png');
  await evaluate(s, `document.querySelector('[data-action="demo"]').click()`);
  await wait(s, '!document.getElementById("preview-result").hidden');
  assert.match(await evaluate(s, 'document.getElementById("result-kind").textContent'), /HAND-AUTHORED/);
  await new Promise(resolve => setTimeout(resolve, 300));
  const frameTree = await call('Page.getFrameTree', {}, s);
  const childFrame = frameTree.frameTree.childFrames?.[0]?.frame;
  if (childFrame) {
    const world = await call('Page.createIsolatedWorld', { frameId: childFrame.id, worldName: 'learnlens-qa' }, s);
    const frameResult = await call('Runtime.evaluate', { expression: '({title:document.title,text:document.body?.innerText?.slice(0,300)})', contextId: world.executionContextId, returnByValue: true }, s);
    assert.match(frameResult.result.value.text || '', /Small habits/, 'Sandboxed preview renders lesson content');
  } else {
    const { targetInfos } = await call('Target.getTargets');
    const iframe = targetInfos.find(t => t.type === 'iframe' && t.browserContextId === browserContextId);
    assert.ok(iframe, 'Sandboxed iframe target exists');
    const { sessionId: child } = await call('Target.attachToTarget', { targetId: iframe.targetId, flatten: true });
    await call('Log.enable', {}, child);
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
  await evaluate(s, `document.querySelector('[data-page="lesson"]').click();document.getElementById('tab-compose').click();document.getElementById('material-text').value='Explain this screenshot with examples.';document.getElementById('material-text').dispatchEvent(new Event('input'));document.getElementById('include-audio').checked=true;document.getElementById('include-audio').dispatchEvent(new Event('input'))`);
  await upload(s, '#material-input', ['artifacts/test-screenshot.png', 'artifacts/test-notes.md']);
  await wait(s, 'document.querySelectorAll("#image-list li").length === 1');
  await wait(s, 'document.getElementById("material-text").value.includes("Markdown source")');
  await evaluate(s, 'document.getElementById("voice-panel").open=true');
  await upload(s, '#audio-input', ['artifacts/test-audio.wav']);
  await wait(s, '!document.getElementById("transcribe-button").disabled');
  await evaluate(s, 'document.getElementById("transcribe-button").click()');
  await wait(s, 'document.getElementById("confirm-dialog").open');
  await evaluate(s, 'document.getElementById("confirm-consent").click();document.getElementById("confirm-accept").click()');
  await wait(s, 'document.getElementById("material-text").value.includes("Newton") && !document.getElementById("generate-button").disabled');
  await evaluate(s, 'document.getElementById("lesson-form").requestSubmit()');
  await wait(s, 'document.getElementById("result-title").textContent === "Browser integration test" && !document.getElementById("preview-result").hidden');
  assert.match(await evaluate(s, 'document.getElementById("download-lesson").href'), /^blob:/);
  const html = await evaluate(s, 'document.getElementById("lesson-frame").srcdoc');
  assert.match(html, /data:audio\/wav;base64/);
  assert.match(html, /data:image\/png;base64/);
  assert.doesNotMatch(html, /src="https?:/);
  await call('Runtime.evaluate', { expression: 'document.getElementById("download-lesson").click()', userGesture: true }, s);
  const downloadedPath = resolve(downloads, 'LearnLens-Browser-integration-test.html');
  let downloaded;
  for (let i = 0; i < 100; i++) { try { downloaded = await readFile(downloadedPath, 'utf8'); break; } catch { await new Promise(resolve => setTimeout(resolve, 50)); } }
  assert.equal(downloaded, html, 'Actual browser download matches the preview document');
  await writeFile('artifacts/browser-export.html', downloaded);
  await new Promise(resolve => setTimeout(resolve, 300));
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
  await wait(s, '!document.getElementById("preview-result").hidden && document.getElementById("preview-loading").hidden');
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
  await wait(s, '!document.getElementById("preview-error").hidden');
  assert.match(await evaluate(s, 'document.getElementById("preview-error-message").textContent'), /Provider/);
  assert.equal(await evaluate(s, 'document.getElementById("show-previous").hidden'), false);
  await evaluate(s, 'document.getElementById("show-previous").click()');
  assert.equal(await evaluate(s, 'document.getElementById("preview-result").hidden'), false);
  const login = await tab(gatedOrigin);
  await wait(login, '!document.getElementById("login-panel").hidden');
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
  assert.deepEqual(errors.filter(error => !/Failed to load resource:.*502/.test(error)), [], 'Unexpected browser console/CSP errors');
  console.log('PASS: 1440/390/320px layouts; sandbox; discovery/roles/consented probe; image + MD upload; consented transcription; generation/failure recovery; actual download; OpenAI preset; consented model advisor + thinking controls; online/Kokoro speech routing; password gate; offline audio playback/speed/answers.');
} finally {
  for (const targetId of targets) await call('Target.closeTarget', { targetId }).catch(() => {});
  if (browserContextId) await call('Target.disposeBrowserContext', { browserContextId });
  ws.close();
  await Promise.all([app, provider.server, kokoro.server, gated].filter(Boolean).map(close));
}
