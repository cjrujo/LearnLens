// Current-UI browser regression with real createApp HTTP APIs and local synthetic provider.
// Run ONLY through: node artifacts/run-url-video-browser.mjs
// Does not launch/locate browsers, inspect profiles, read .env, or contact a real URL/AI.
// Media bytes are transport-signature fixtures with trusted injected inspection/clipping.
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import dns from 'node:dns';
import dnsPromises from 'node:dns/promises';
import { mkdir, mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { startApp, mockProvider, lessonSpec, WAV } from './helpers.mjs';
import { videoClipBounds } from '../lib/video-clips.mjs';
import { syntheticVideoLoader } from './video-test-fixtures.mjs';
import { prepareAudioEncoder } from '../lib/audio-encode.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const evidence=process.env.LEARNLENS_URL_VIDEO_EVIDENCE;
const endpoint=process.env.LEARNLENS_OWNED_CDP_WS;
assert.ok(evidence && resolve(evidence).startsWith(resolve(root,'artifacts/url-video-browser')+ '/'.replaceAll('/',process.platform==='win32'?'\\':'/')), 'An owned evidence directory is required');
assert.ok(endpoint,'Run the owned runner; never autodiscover Chrome');
const cdpURL=new URL(endpoint);
assert.equal(cdpURL.protocol,'ws:');assert.equal(cdpURL.hostname,'127.0.0.1');assert.equal(cdpURL.port,'9333');
process.env.LEARNLENS_MEDIA_OFFLINE='1';
const MP4=Buffer.from('000000186674797069736f6d0000020069736f6d69736f32','hex');
const sha=data=>createHash('sha256').update(data).digest('hex');
const SOURCE='https://example.com/synthetic-lesson.mp4?signature=PRIVATE_QUERY#PRIVATE_FRAGMENT';
const CITATION='https://example.com/synthetic-lesson.mp4';
const hooks=[], t={mock,after:fn=>hooks.push(fn)};
const allowedPorts=new Set([9333]);
const networkBlocks=[], events=[], results=[], contexts=[], fixtures=[], runtimeErrors=[];
const controls={failDownload:false,downloadGate:null,failVideoAt:0,failWriteAt:0,videoCalls:0,writeCalls:0,downloadCalls:0,clipCalls:0,videoDelay:0,dropVideoAck:false,dropUrlAck:false};
const originalFetch=globalThis.fetch;
mock.method(globalThis,'fetch',(input,options)=>{const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);assert.equal(url.protocol,'http:');assert.equal(url.hostname,'127.0.0.1');assert.ok(allowedPorts.has(Number(url.port)),'Only explicit fixture ports are allowed');return originalFetch(input,options);});
const lookup=(host,options)=>{assert.equal(host,'127.0.0.1','DNS and non-loopback hosts are forbidden');return options?.all?[{address:host,family:4}]:{address:host,family:4};};
mock.method(dnsPromises,'lookup',async(host,options)=>lookup(host,options));
mock.method(dns,'lookup',(host,...args)=>{const options=args.length>1?args[0]:undefined,callback=args.at(-1),value=lookup(host,options);queueMicrotask(()=>options?.all?callback(null,value):callback(null,value.address,value.family));});
const directory=await mkdtemp(join(root,'artifacts/url-video-browser/owned-store-'));
const lesson=lessonSpec({title:'Cat',subject:'English',englishLearning:true,language:'Chinese (Simplified)',summary:'Cat.',objectives:['Read cat.'],sections:[{type:'example',title:'Read',body:'Cat.',items:[],question:'',answer:'',translation:'猫',source:'Synthetic video'}],audio:[],warnings:[]});
let provider,app,fixtureMP3=null,encoderFailure=null;
let ws,seq=0;const pending=new Map();
let activeSession;
function pass(name,detail={}){results.push({name,status:'PASS',...detail});console.log('PASS: '+name);}
function kind(call){if(call.path.endsWith(':generateContent'))return'video';if(call.path.endsWith('/audio/speech'))return'speech';if(call.path.endsWith('/audio/transcriptions'))return'transcription';if(JSON.stringify(call.json).includes('LEARNLENS_SOURCE_DIGEST'))return'digest';if(JSON.stringify(call.json).includes('LEARNLENS_AUDIO'))return'audio-extract';return'lesson';}
function counts(from=0){return Object.fromEntries(['video','lesson','digest','audio-extract','transcription','speech'].map(k=>[k,provider.calls.slice(from).filter(c=>kind(c)===k).length]));}
function call(method,params={},sessionId){return new Promise((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout: '+method));},15000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params,sessionId}));});}
async function evaluate(session,expression){const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true},session);if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;}
async function wait(session,expression,timeout=18000){const start=Date.now();while(!await evaluate(session,expression)){if(Date.now()-start>timeout)throw Error('Timed out: '+expression+'\n'+JSON.stringify(await evaluate(session,'({error:document.getElementById("preview-error-message")?.textContent,generation:document.getElementById("generation-error")?.textContent,audio:document.getElementById("audio-message")?.textContent,import:document.getElementById("upload-message")?.textContent,dialog:document.getElementById("confirm-title")?.textContent})')));await delay(40);}}
async function click(session,selector){await evaluate(session,`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n)throw Error('Missing control');if(n.disabled)throw Error('Disabled control '+${JSON.stringify(selector)});n.click()})()`);}
async function byText(session,label){await evaluate(session,`(()=>{const b=[...document.querySelectorAll('#material-list button')].find(b=>b.textContent===${JSON.stringify(label)});if(!b||b.disabled)throw Error('Missing/enabled '+${JSON.stringify(label)});b.click()})()`);}
async function set(session,id,value){await evaluate(session,`(()=>{const e=document.getElementById(${JSON.stringify(id)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input'));e.dispatchEvent(new Event('change'))})()`);}
async function api(session,path,body,method=body===undefined?'GET':'POST'){return evaluate(session,`(async()=>{const r=await fetch('/api'+${JSON.stringify(path)},{method:${JSON.stringify(method)},headers:{'content-type':'application/json','x-learnlens-token':document.querySelector('meta[name="learnlens-token"]').content},${body===undefined?'':`body:JSON.stringify(${JSON.stringify(body)}),`}});return{status:r.status,json:await r.json()}})()`);}
function ok(response,status){assert.equal(response.status,status,JSON.stringify(response.json));return response.json;}
async function screenshot(session,name){const {data}=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false},session);await writeFile(join(evidence,name+'.png'),Buffer.from(data,'base64'));}
async function attach(targetId){const {sessionId}=await call('Target.attachToTarget',{targetId,flatten:true});await call('Runtime.enable',{},sessionId);await call('Page.enable',{},sessionId);await call('Fetch.enable',{patterns:[{urlPattern:'*',requestStage:'Request'},{urlPattern:'*/api/video/plans/*/clips/*',requestStage:'Response'},{urlPattern:'*/api/materials/from-url',requestStage:'Response'}]},sessionId);return sessionId;}
async function newTab(url,context){const {targetId}=await call('Target.createTarget',{url:'about:blank',browserContextId:context});const session=await attach(targetId);await call('Page.navigate',{url},session);return session;}
async function fixture({speech=true,video=true}={}){const {browserContextId}=await call('Target.createBrowserContext');contexts.push(browserContextId);const session=await newTab(app.url,browserContextId);activeSession=session;await wait(session,'document.getElementById("setup-label")?.textContent==="Connect your AI"');const p=ok(await api(session,'/providers',{name:'Synthetic loopback QA',baseUrl:provider.baseUrl,apiKey:'synthetic-not-a-real-secret'}),201).provider;const roles={primary:{providerId:p.id,model:'fixture-primary',api:'chat',timeoutSeconds:90},transcription:null,video:video?{providerId:p.id,model:'fixture-video',api:'gemini',fps:24,timeoutSeconds:300}:null,speech:speech?{providerId:p.id,model:'fixture-speech',api:'auto',voice:'alloy'}:null};ok(await api(session,'/roles',roles,'PUT'),200);await click(session,'#retry-state');await wait(session,'document.getElementById("setup-label").textContent==="AI setup ready"');await click(session,'[data-page="lesson"]');await click(session,'#tab-compose');await set(session,'learning-goal','Read cat.');await set(session,'language','Chinese (Simplified)');const f={session,context:browserContextId,roles,providerId:p.id,from:provider.calls.length,eventFrom:events.length};fixtures.push(f);return f;}
async function refreshSetup(session){await evaluate(session,'window.__oldVideoField=document.getElementById("role-video-fps")');await click(session,'#retry-state');await wait(session,'document.getElementById("role-video-fps")!==window.__oldVideoField && !document.getElementById("roles-fields").disabled');}
async function saveRoles(f,change,{refresh=true}={}){f.roles={...f.roles,...change};ok(await api(f.session,'/roles',f.roles,'PUT'),200);if(refresh){await refreshSetup(f.session);assert.equal(await evaluate(f.session,'Number(document.getElementById("role-video-fps").value)'),f.roles.video?.fps??24);}}
async function release(f){ok(await api(f.session,'/logout',{}),200);f.released=true;await call('Target.disposeBrowserContext',{browserContextId:f.context});contexts.splice(contexts.indexOf(f.context),1);activeSession=null;}
async function dialog(session){await wait(session,'document.getElementById("confirm-dialog").open');return evaluate(session,'({title:document.getElementById("confirm-title").textContent,description:document.getElementById("confirm-description").textContent,detail:document.getElementById("confirm-detail").textContent,disabled:document.getElementById("confirm-accept").disabled})');}
async function consent(session,{paid=false,cancel=false}={}){await dialog(session);if(paid){assert.equal(await evaluate(session,'document.getElementById("confirm-accept").disabled'),true);if(!cancel)await click(session,'#confirm-consent');}await click(session,cancel?'#confirm-cancel':'#confirm-accept');}
async function openImport(f){await set(f.session,'source-url',SOURCE);await set(f.session,'source-mode','video');await click(f.session,'#import-url');const d=await dialog(f.session);assert.equal(d.title,'Fetch this public source?');assert.ok(d.detail.includes(CITATION));assert.doesNotMatch(d.detail,/PRIVATE_QUERY|PRIVATE_FRAGMENT/);assert.equal(d.disabled,false);return d;}
async function materialReady(f){await wait(f.session,'document.getElementById("material-list").getAttribute("aria-busy")==="false" && document.querySelectorAll("#material-list details").length===1 && !document.querySelector("#material-list .error")');const posts=events.filter(e=>e.session===f.session&&e.method==='POST'&&e.path==='/api/materials/from-url');const id=posts.at(-1).body.id;const material=ok(await api(f.session,'/materials/'+id),200);assert.equal(material.status,'ready');assert.equal(material.analysisMode,'whole-video');assert.equal(material.duration,31);assert.equal(material.partCount,2);assert.equal(material.provenance.citationUrl,CITATION);assert.doesNotMatch(JSON.stringify(material),/PRIVATE_QUERY|PRIVATE_FRAGMENT/);return f.material=material;}
async function importReady(f){await openImport(f);await consent(f.session);return materialReady(f);}
async function create(f,{mode='off',cancel=false}={}){await set(f.session,'audio-mode',mode);await evaluate(f.session,'document.getElementById("lesson-form").requestSubmit()');const d=await dialog(f.session);assert.match(d.title,/Process all parts|Continue generation/);assert.match(d.detail,/Gemini|gemini|native|Native/);await consent(f.session,{paid:true,cancel});return d;}
async function textReady(f){await wait(f.session,'!document.getElementById("preview-result").hidden && document.getElementById("preview-loading").hidden');assert.equal(await evaluate(f.session,'document.getElementById("preview-error").hidden'),true);const html=await evaluate(f.session,'document.getElementById("lesson-frame").srcdoc');assert.match(html,/Cat/);assert.doesNotMatch(html,/PRIVATE_QUERY|PRIVATE_FRAGMENT/);return html;}
async function errorIdle(f){await wait(f.session,'!document.getElementById("preview-error").hidden && !document.getElementById("retry-preview").disabled');return evaluate(f.session,'document.getElementById("preview-error-message").textContent');}
async function continueGeneration(f,{cancel=false}={}){await click(f.session,'#retry-preview');assert.match((await dialog(f.session)).title,/Continue generation/);await consent(f.session,{paid:true,cancel});}
const forSession=f=>events.filter(e=>e.session===f.session);
const audioEvents=f=>forSession(f).filter(e=>e.path.startsWith('/api/audio/'));
async function planAndReceipts(f){const plan=ok(await api(f.session,'/materials/'+f.material.id+'/video-plan?fps=24'),200);assert.equal(plan.clips.length,2);assert.deepEqual(plan.clips.map(c=>[c.start,c.end]),[[0,30],[30,31]]);const receipts=[];for(const clip of plan.clips)receipts.push(ok(await api(f.session,`/video/plans/${plan.id}/clips/${clip.id}`),200));return{plan,receipts};}
async function offline(f,html,name){const path=join(evidence,name+'.html');await writeFile(path,html);const session=await newTab(pathToFileURL(path).href,f.context);await wait(session,'document.readyState==="complete"');await call('Emulation.setDeviceMetricsOverride',{width:320,height:700,deviceScaleFactor:1,mobile:true},session);await delay(50);assert.equal(await evaluate(session,'document.documentElement.scrollWidth<=innerWidth'),true,'Offline HTML fits 320px');assert.deepEqual(await evaluate(session,'performance.getEntriesByType("resource").filter(r=>/^https?:/.test(r.name)).map(r=>r.name)'),[]);await screenshot(session,name+'-320px');return session;}

try {
  provider=await mockProvider(t,{lesson,outputText:call=>JSON.stringify(JSON.stringify(call.json).includes('LEARNLENS_SOURCE_DIGEST')?{notes:'Recognized speech: Cat. Recognized screen text: Dog. Derived observation: a toy moves.',warnings:[]}:lesson),beforeResponse:async call=>{
    if(kind(call)==='video'){
      controls.videoCalls++;call.syntheticVideoNumber=controls.videoCalls;
      const text=call.json.contents[0].parts[0].text,windows=JSON.parse(/Required windows: (\[.*?\])\./.exec(text)[1]);
      call.syntheticBounds=windows;await delay(controls.videoDelay);
      provider.config.geminiStatus=controls.failVideoAt===controls.videoCalls?503:200;
      provider.config.geminiResponse={candidates:[{content:{role:'model',parts:[{text:JSON.stringify({version:1,windows:windows.map(bounds=>({...bounds,transcript:'Cat.',visibleText:'Dog.',observations:'A toy moves.',audioCoverage:'complete',visualCoverage:'complete'})),warnings:[]})}]},finishReason:'STOP'}]};
    }
  }});
  allowedPorts.add(Number(new URL(provider.url).port));
  // No fallback: if cached offline encoder is unavailable, audio playback is explicitly NOT TESTED.
  try {fixtureMP3=await(await prepareAudioEncoder())({buffer:WAV,mime:'audio/wav'});await writeFile(join(evidence,'synthetic-tone.mp3'),fixtureMP3);}catch(error){encoderFailure=error.message;}
  app=await startApp(t,{
    audioEncoderFactory:async()=>{if(!fixtureMP3)throw Error('Synthetic MP3 unavailable');return async raw=>{assert.equal(raw.mime,'audio/wav');assert.deepEqual(raw.buffer,WAV);return Buffer.from(fixtureMP3);};},
    audioPlanStoreOptions:{directory},
    materialStoreOptions:{directory,videoLoader:syntheticVideoLoader,limits:{minFreeBytes:0,mediaBytes:1024*1024},downloader:async options=>{
      controls.downloadCalls++;await controls.downloadGate?.promise;
      if(controls.failDownload)throw Error('Synthetic unavailable source; PRIVATE_QUERY');
      const file=join(options.directory,'synthetic-source.mp4');await writeFile(file,MP4,{flag:'wx',mode:0o600});options.onProgress?.({receivedBytes:MP4.length,totalBytes:MP4.length});
      return{file,extension:'mp4',size:MP4.length,kind:'media',name:'Synthetic source.mp4',provenance:{type:'direct-media',citationUrl:SOURCE,title:'Synthetic video',importedAt:'2026-10-31T00:00:00.000Z'},warnings:['Synthetic transport fixture: media inspection and clipping are injected; not a playable original.']};
    },mediaLoader:async()=>({inspectMedia:async()=>({duration:31,hasAudio:true,hasVideo:true,partCount:2,width:640,height:360})})},
    videoPlanStoreOptions:{directory,clipper:async(file,extension,index,plan)=>{controls.clipCalls++;assert.equal(extension,'mp4');assert.deepEqual(await readFile(file),MP4);return{video:'data:video/mp4;base64,'+MP4.toString('base64'),...videoClipBounds(index,plan),hasVideo:true,hasAudio:true,analysisMode:'whole-video',videoSha256:sha(MP4)};},writeResult:async(...args)=>{controls.writeCalls++;if(controls.failWriteAt&&controls.videoCalls>=controls.failWriteAt)throw Error('Synthetic local checkpoint write failure');return writeFile(...args);}},
  });
  allowedPorts.add(Number(new URL(app.url).port));assert.notEqual(new URL(app.url).port,'3210');
  await writeFile(join(evidence,'fixture.json'),JSON.stringify({source:CITATION,transportBytes:MP4.length,transportSHA256:sha(MP4),syntheticDuration:31,injected:['URL downloader','media inspector','native clipper','checkpoint writer fault','audio encoder replays one verified synthetic MP3'],appOrigin:app.url,providerOrigin:provider.url,mp3SHA256:fixtureMP3?sha(fixtureMP3):null,encoderFailure},null,2));
  ws=new WebSocket(endpoint);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
  ws.onmessage=event=>{const m=JSON.parse(event.data);if(pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);return;}
    if(m.method==='Runtime.exceptionThrown')runtimeErrors.push(m.params.exceptionDetails.exception?.description||m.params.exceptionDetails.text);
    if(m.method==='Fetch.requestPaused'){
      const {request,requestId,responseStatusCode}=m.params;const url=new URL(request.url);const allowed=['about:','data:','blob:','file:'].includes(url.protocol)||(url.protocol==='http:'&&url.hostname==='127.0.0.1'&&allowedPorts.has(Number(url.port))&&url.port!=='9333');
      if(!allowed)networkBlocks.push({protocol:url.protocol,host:url.hostname,path:url.pathname});
      let drop=false;
      if(responseStatusCode&&request.method==='POST'&&responseStatusCode===202){if(controls.dropVideoAck&&/\/video\/plans\/.*\/clips\//.test(url.pathname)){controls.dropVideoAck=false;drop=true;}if(controls.dropUrlAck&&url.pathname==='/api/materials/from-url'){controls.dropUrlAck=false;drop=true;}}
      if(!responseStatusCode){let body;try{body=JSON.parse(request.postData);}catch{}events.push({order:events.length,session:m.sessionId,path:url.pathname,method:request.method,body});}
      if(drop)events.push({order:events.length,session:m.sessionId,path:url.pathname,method:'LOST_ACK',responseStatusCode});
      void call(allowed&&!drop?'Fetch.continueRequest':'Fetch.failRequest',{requestId,...(allowed&&!drop?{}:{errorReason:drop?'ConnectionClosed':'BlockedByClient'})},m.sessionId).catch(()=>{});
    }
  };

  // 1. Fresh current UI, explicit four-role compatibility, URL cancel and source locks.
  {
    const f=await fixture();const s=f.session;
    assert.equal(await evaluate(s,'document.querySelectorAll("#role-cards .role-card").length'),4);
    assert.deepEqual(await evaluate(s,'({api:[...document.getElementById("role-video-api").options].map(o=>o.value),fps:[document.getElementById("role-video-fps").min,document.getElementById("role-video-fps").max],wait:[document.getElementById("role-video-timeout").min,document.getElementById("role-video-timeout").max]})'),{api:['gemini'],fps:['1','24'],wait:['30','600']});
    for(const [fps,timeoutSeconds] of [[1,30],[24,600]])ok(await api(s,'/roles',{...f.roles,video:{...f.roles.video,fps,timeoutSeconds}},'PUT'),200);
    for(const patch of [{fps:0},{fps:25},{timeoutSeconds:29},{timeoutSeconds:601},{api:'chat'}])ok(await api(s,'/roles',{...f.roles,video:{...f.roles.video,...patch}},'PUT'),400);
    await saveRoles(f,{});assert.equal(provider.calls.length,f.from);
    await click(s,'[data-page="providers"]');await screenshot(s,'four-role-cards');await click(s,'[data-page="lesson"]');
    const before=controls.downloadCalls;await openImport(f);await screenshot(s,'url-fetch-consent');await consent(s,{cancel:true});assert.equal(controls.downloadCalls,before);assert.equal(forSession(f).filter(e=>e.path==='/api/materials/from-url').length,0);
    let release;controls.downloadGate={promise:new Promise(r=>{release=r}),release:()=>release()};controls.dropUrlAck=true;
    await openImport(f);await consent(s);await wait(s,'document.getElementById("material-list").getAttribute("aria-busy")==="true"');
    assert.equal(await evaluate(s,'["source-url","source-mode","import-url","generate-button","material-input","dropzone","record-button"].every(id=>document.getElementById(id).disabled)'),true,'Pending source locks all entry points');
    assert.equal(provider.calls.length,f.from);controls.downloadGate.release();controls.downloadGate=null;
    await materialReady(f);assert.equal(controls.downloadCalls,before+1);assert.equal(forSession(f).filter(e=>e.path==='/api/materials/from-url'&&e.method==='POST').length,1);
    await evaluate(s,'document.querySelector("#material-list details").open=true;document.querySelector("#material-list select").value="1"');await byText(s,'Load local preview');await wait(s,'document.getElementById("material-list").getAttribute("aria-busy")==="false"');assert.equal(controls.downloadCalls,before+1);assert.equal(provider.calls.length,f.from);await screenshot(s,'readonly-source-review');
    const d=await create(f,{cancel:true});assert.match(d.detail,/No|no|never/);assert.equal(provider.calls.length,f.from);assert.equal(forSession(f).some(e=>e.path.startsWith('/api/video/')),false);
    await create(f);await textReady(f);await wait(s,'!document.getElementById("generate-button").disabled');
    const {plan,receipts}=await planAndReceipts(f);assert.equal(plan.summary.completedClips,2);for(const r of receipts){assert.equal(r.status,'complete');assert.equal(r.result.fps,24);assert.equal(r.result.coverageBasis,'model_reported');for(const w of r.result.windows){assert.equal(w.transcript,'Cat.');assert.equal(w.visibleText,'Dog.');assert.equal(w.observations,'A toy moves.');}}
    assert.deepEqual(receipts.map(r=>r.result.windows.map(w=>[w.sourceStart,w.sourceEnd])),[[[0,5],[5,10],[10,15],[15,20],[20,25],[25,30]],[[30,31]]]);
    assert.equal(counts(f.from).video,2);assert.equal(counts(f.from).lesson,1);assert.equal(counts(f.from).transcription,0);assert.equal(counts(f.from)['audio-extract'],0);assert.equal(audioEvents(f).length,0);
    await writeFile(join(evidence,'accepted-video-receipts.json'),JSON.stringify({plan,receipts},null,2));const html=await textReady(f);await offline(f,html,'text-offline');
    await call('Emulation.setDeviceMetricsOverride',{width:320,height:700,deviceScaleFactor:1,mobile:true},s);await click(s,'#tab-compose');assert.equal(await evaluate(s,'document.documentElement.scrollWidth<=innerWidth'),true,'Composer fits 320px');await screenshot(s,'composer-320px');
    pass('URL cancel 0 POST; accepted/lost-ack one fetch; readonly review; paid create gate; whole-video Off; separated receipts; offline 320px',{counts:counts(f.from)});await release(f);
  }
  // 2. Failed URL status checks never refetch; explicit reimport creates a fresh ID.
  {
    const f=await fixture({speech:false}),s=f.session;controls.failDownload=true;const downloads=controls.downloadCalls;await openImport(f);await consent(s);await wait(s,'!!document.querySelector("#material-list .error") && document.getElementById("material-list").getAttribute("aria-busy")==="false"');
    const first=forSession(f).find(e=>e.path==='/api/materials/from-url'&&e.method==='POST').body.id;const eventStart=events.length;
    await byText(s,'Check / resume local snapshot');await wait(s,'document.getElementById("material-list").getAttribute("aria-busy")==="false"');
    assert.equal(controls.downloadCalls,downloads+1);assert.ok(events.slice(eventStart).some(e=>e.path==='/api/materials/'+first&&e.method==='GET'));assert.equal(events.slice(eventStart).filter(e=>e.path==='/api/materials/from-url').length,0);
    await byText(s,'Reimport URL…');await consent(s,{cancel:true});await wait(s,'document.getElementById("material-list").getAttribute("aria-busy")==="false"');assert.equal(controls.downloadCalls,downloads+1);
    controls.failDownload=false;await byText(s,'Reimport URL…');await consent(s);await materialReady(f);assert.notEqual(f.material.id,first);assert.equal(controls.downloadCalls,downloads+2);assert.equal(provider.calls.length,f.from);await screenshot(s,'url-reimport-new-snapshot');pass('Unavailable URL: GET recovery only; cancelled reimport is free; explicit reimport allocates new ID');await release(f);
  }
  // 3. Lost native ACK is GET-only polling; same attempt is idempotent.
  {
    const f=await fixture({speech:false});await importReady(f);controls.dropVideoAck=true;controls.videoDelay=900;await create(f);await textReady(f);await wait(f.session,'!document.getElementById("generate-button").disabled');controls.videoDelay=0;
    const native=forSession(f).filter(e=>/\/video\/plans\/.*\/clips\//.test(e.path));assert.equal(native.filter(e=>e.method==='POST').length,2);assert.equal(native.filter(e=>e.method==='LOST_ACK').length,1);assert.ok(native.filter(e=>e.method==='GET').length>=4);
    const first=native.find(e=>e.method==='POST'),before=provider.calls.length;const replay=ok(await api(f.session,first.path.slice(4),first.body),202);assert.equal(replay.status,'complete');assert.equal(provider.calls.length,before);assert.equal(counts(f.from).video,2);pass('Native lost acknowledgement polls GET without replay; same-attempt real API replay reuses complete receipt',{counts:counts(f.from)});await release(f);
  }
  // 4. First clip retained, second failure stops teaching. FPS is immutable across Continue.
  {
    const f=await fixture({speech:false});await importReady(f);controls.failVideoAt=controls.videoCalls+2;await create(f);await errorIdle(f);let saved=await planAndReceipts(f);assert.equal(saved.receipts[0].status,'complete');assert.equal(saved.receipts[1].status,'failed');assert.equal(counts(f.from).video,2);assert.equal(counts(f.from).lesson,0);await delay(900);assert.equal(counts(f.from).video,2);await screenshot(f.session,'second-clip-failed-checkpoint');
    await saveRoles(f,{video:{...f.roles.video,fps:12}});await continueGeneration(f);const fpsError=await errorIdle(f);assert.match(fpsError,/FPS|sampling|profile/i);assert.equal(counts(f.from).video,2);assert.equal(counts(f.from).lesson,0);await screenshot(f.session,'fps-change-blocked');
    await saveRoles(f,{video:{...f.roles.video,fps:24}});await continueGeneration(f,{cancel:true});assert.equal(counts(f.from).video,2);
    controls.failVideoAt=0;await continueGeneration(f);await textReady(f);await wait(f.session,'!document.getElementById("generate-button").disabled');saved=await planAndReceipts(f);assert.deepEqual(saved.receipts.map(r=>r.attempts),[1,2]);assert.equal(counts(f.from).video,3);assert.equal(counts(f.from).lesson,1);pass('Second clip failure: no teaching/automatic retry; first receipt cached; FPS change blocks resume; explicit Continue only retries second',{counts:counts(f.from)});await release(f);
  }
  // 5. Provider success with local disk failure: role removal must not block local repair.
  {
    const f=await fixture({speech:false});await importReady(f);controls.failWriteAt=controls.videoCalls+2;await create(f);await errorIdle(f);const saved=await planAndReceipts(f);assert.deepEqual(saved.receipts.map(r=>r.status),['complete','checkpoint_failed']);assert.equal(counts(f.from).video,2);assert.equal(counts(f.from).lesson,0);
    controls.failWriteAt=0;await saveRoles(f,{video:null,transcription:null});await continueGeneration(f);await textReady(f);await wait(f.session,'!document.getElementById("generate-button").disabled');assert.equal(counts(f.from).video,2);assert.equal(counts(f.from).lesson,1);assert.deepEqual((await planAndReceipts(f)).receipts.map(r=>r.status),['complete','complete']);pass('Accepted native receipt local repair works after video/STT role removal, without new inference',{counts:counts(f.from)});await release(f);
  }
  // 6. Auto classifies via teaching first. Missing speech retains text and locks sources.
  {
    const f=await fixture({speech:false});await importReady(f);await create(f,{mode:'auto'});const original=await textReady(f);await wait(f.session,'!document.getElementById("continue-audio").hidden && !document.getElementById("continue-audio").disabled');
    assert.equal(counts(f.from).video,2);assert.equal(counts(f.from).lesson,1);assert.equal(audioEvents(f).length,0,'Auto missing speech makes no preflight/inventory/speech call');
    assert.equal(await evaluate(f.session,'["source-url","source-mode","import-url","material-input","dropzone","record-button","generate-button"].every(id=>document.getElementById(id).disabled)&&[...document.querySelectorAll("#material-list button,[data-action=demo]")].every(n=>n.disabled)'),true);
    await evaluate(f.session,'document.getElementById("lesson-form").requestSubmit()');assert.equal(await evaluate(f.session,'document.getElementById("confirm-dialog").open'),false);assert.equal(await evaluate(f.session,'document.getElementById("lesson-frame").srcdoc'),original);await screenshot(f.session,'auto-missing-speech-text-retained');
    if(fixtureMP3){
      // Change real API setup without refreshing the lesson tab; Continue must refresh itself.
      await saveRoles(f,{video:null,transcription:null,speech:{providerId:f.providerId,model:'fixture-speech',api:'auto',voice:'alloy'}},{refresh:false});
      const before=provider.calls.length;await click(f.session,'#continue-audio');assert.equal((await dialog(f.session)).title,'Prepare remaining English audio sources?');await consent(f.session,{cancel:true});assert.equal(provider.calls.length,before);await click(f.session,'#continue-audio');await consent(f.session);
      const d=await dialog(f.session);assert.match(d.title,/complete English audio/);const exact=Number(d.description.match(/(\d+) unique clips exactly/)[1]);assert.ok(exact>0);assert.equal(counts(f.from).speech,0);assert.equal(counts(f.from).video,2);assert.equal(counts(f.from).transcription,0);assert.equal(counts(f.from)['audio-extract'],0);assert.equal(counts(f.from).lesson,1);
      const planRequest=audioEvents(f).find(e=>e.path==='/api/audio/plans'&&e.method==='POST');assert.ok(planRequest);const sourceRequests=audioEvents(f).filter(e=>e.path.endsWith('/sources')&&e.method==='POST').map(e=>e.body.source);assert.deepEqual(sourceRequests.map(source=>source.key),planRequest.body.expectedSources);const sources=JSON.stringify(sourceRequests);assert.match(sources,/Cat/);assert.match(sources,/Dog/);assert.doesNotMatch(sources,/A toy moves/,'Derived observations must not masquerade as original source speech/screen words');await writeFile(join(evidence,'auto-source-inventory.json'),JSON.stringify(sourceRequests,null,2));
      const lessonIndex=forSession(f).find(e=>e.path==='/api/lessons').order;assert.ok(audioEvents(f).every(e=>e.order>lessonIndex));assert.ok(forSession(f).some(e=>e.order>lessonIndex&&e.path.endsWith('/parts')),'Deferred source inventory rereads immutable local references');
      await screenshot(f.session,'exact-speech-count-consent');await consent(f.session,{paid:true,cancel:true});await wait(f.session,'!document.getElementById("continue-audio").disabled');assert.equal(counts(f.from).speech,0);assert.equal(await evaluate(f.session,'document.getElementById("lesson-frame").srcdoc'),original);
      await click(f.session,'#continue-audio');await consent(f.session);await dialog(f.session);await consent(f.session,{paid:true});await wait(f.session,'document.getElementById("continue-audio").hidden && !document.getElementById("generate-button").disabled',30000);assert.equal(counts(f.from).speech,exact);const speech=provider.calls.slice(f.from).filter(c=>kind(c)==='speech').map(c=>c.json.input);assert.equal(new Set(speech).size,exact);
      const html=await textReady(f);assert.match(html,/data:audio\/mpeg;base64,/);const playback=await offline(f,html,'audio-offline');
      const played=await call('Runtime.evaluate',{expression:'window.__audioProbe={durations:[],ended:0};const p=document.getElementById("course-player");p.addEventListener("loadedmetadata",()=>window.__audioProbe.durations.push(p.duration));p.addEventListener("ended",()=>window.__audioProbe.ended++);document.querySelector(".word-play:not(:disabled)").click();true',returnByValue:true,userGesture:true},playback);assert.ok(!played.exceptionDetails);await wait(playback,'window.__audioProbe.ended>0 && document.getElementById("audio-status").textContent==="Finished."');const duration=await evaluate(playback,'window.__audioProbe.durations.find(n=>Number.isFinite(n)&&n>0)');assert.equal(await evaluate(playback,'document.getElementById("course-player").paused && !document.getElementById("course-player").hasAttribute("src")'),true);assert.ok(Number.isFinite(duration)&&duration>0);pass('Auto English: deferred inventory reuses native speech/screen receipts with video role removed; source locks; exact speech consent; verified MP3 finite playback offline',{counts:counts(f.from),exact,duration});
    }else results.push({name:'Auto English inventory and speech playback',status:'NOT TESTED',reason:encoderFailure});
    await release(f);
  }
  // 7. Explicit On collects accepted source receipts without STT/still OCR.
  if(fixtureMP3){const f=await fixture();await importReady(f);await create(f,{mode:'on'});await textReady(f);const d=await dialog(f.session);assert.match(d.title,/complete English audio/);assert.equal(counts(f.from).video,2);assert.equal(counts(f.from).lesson,1);assert.equal(counts(f.from).transcription,0);assert.equal(counts(f.from)['audio-extract'],0);assert.equal(counts(f.from).speech,0);assert.ok(audioEvents(f).find(e=>e.path==='/api/audio/preflight').order<forSession(f).find(e=>e.path==='/api/lessons').order);await consent(f.session,{paid:true,cancel:true});pass('Explicit On: native receipts reused for source inventory; separate exact-count gate before any speech',{counts:counts(f.from)});await release(f);}else results.push({name:'Explicit On source inventory',status:'NOT TESTED',reason:encoderFailure});
  assert.deepEqual(networkBlocks,[]);assert.deepEqual(runtimeErrors,[]);pass('No forbidden browser request and no unhandled browser runtime exception');
}catch(error){results.push({name:'Suite interruption',status:'FAIL',error:error.stack});console.error(error.stack);if(activeSession)try{await screenshot(activeSession,'failure');await writeFile(join(evidence,'failure-dom.txt'),await evaluate(activeSession,'document.body.innerText'));}catch{}process.exitCode=1;}
finally{
  controls.downloadGate?.release();controls.downloadGate=null;controls.failWriteAt=0;controls.failDownload=false;controls.videoDelay=0;
  for(const f of fixtures)if(!f.released)try{ok(await api(f.session,'/logout',{}),200);f.released=true;}catch(error){results.push({name:'Owned session cleanup',status:'FAIL',error:error.message});process.exitCode=1;}
  for(const context of contexts)try{await call('Target.disposeBrowserContext',{browserContextId:context});}catch{}
  ws?.close();for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error('Owned QA shutting down'));}pending.clear();
  for(const hook of hooks.reverse())try{await hook();}catch(error){results.push({name:'Owned server cleanup',status:'FAIL',error:error.message});process.exitCode=1;}
  const remaining=await readdir(directory);await rm(directory,{recursive:true,force:true,maxRetries:20,retryDelay:50});
  await writeFile(join(evidence,'results.json'),JSON.stringify({results,networkBlocks,runtimeErrors,cleanup:{allSessionsLoggedOut:fixtures.every(f=>f.released),remainingStoreEntriesBeforeRemoval:remaining},controls:{downloadCalls:controls.downloadCalls,clipCalls:controls.clipCalls,videoCalls:controls.videoCalls,writeCalls:controls.writeCalls}},null,2));
  await writeFile(join(evidence,'requests.json'),JSON.stringify(events.map(({body,...e})=>({...e,...(body?{bodySummary:Object.fromEntries(['id','mode','fps','attemptId','retry','includeAudio','consent','publicFetchConsent'].filter(k=>k in body).map(k=>[k,body[k]]))}: {})})),null,2));
  await writeFile(join(evidence,'provider-calls.json'),JSON.stringify(provider?.calls.map(c=>({kind:kind(c),method:c.method,path:c.path,model:c.json?.model,videoNumber:c.syntheticVideoNumber,windows:c.syntheticBounds,inlineVideo:c.json?.contents?.[0]?.parts?.some(p=>p.inlineData?.mimeType==='video/mp4')}))||[],null,2));
  await writeFile(join(evidence,'report.md'),'# URL/native-video browser QA\n\n'+results.map(r=>`- **${r.status}** ${r.name}${r.reason?': '+r.reason:''}${r.error?'\n\n```\n'+r.error+'\n```':''}`).join('\n')+'\n\n## Boundaries\nReal current UI and createApp APIs; synthetic loopback provider only. The downloader, 31-second media inspection and clipper are trusted injections. Signature bytes are not a decodable video, and no claim is made about FFmpeg audiovisual quality. No real web retrieval, YouTube helper, paid AI, model perception, credentialed session, user app3210 or Chrome9222 was tested/touched. Audio uses a verified cached-offline MP3 encoding of synthetic PCM WAV, not real speech or Kokoro.\n\n## Legacy browser-smoke updates required (not edited or run)\n- Update setup counts from /3 to /4.\n- Configure an explicit Gemini-native video role, FPS1..24 and wait30..600.\n- video-source-consent must stop expecting legacy separate STT/still OCR for uploaded MP4/WebM: current UI submits whole-video snapshots/native plans. Assert native receipt reuse for audio instead.\n- Use source-url/source-mode/import-url selectors; independently gate URL retrieval and paid analysis.\n\n## NOT TESTED\nReal external URL/YouTube retrieval; real native video encoding/stream fidelity; actual AI recognition; paid provider behavior; native Kokoro; long 30–600-second timeout accuracy; process-restart persistence. Cases after an interrupted suite are NOT TESTED, not presumed passing.\n\nAsset SHA-256, exact runner/Chrome commands, synthetic request ledger and screenshots are alongside this report. Re-run if production hashes change.\n');
  mock.restoreAll();
}
