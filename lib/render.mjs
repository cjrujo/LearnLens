import { createHash } from 'node:crypto';
import { speechWords } from './speech-inventory.mjs';

export const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const script = `document.querySelectorAll('[data-speed]').forEach(button=>button.addEventListener('click',()=>{const rate=Number(button.dataset.speed);document.querySelectorAll('audio').forEach(audio=>{audio.defaultPlaybackRate=rate;audio.playbackRate=rate;audio.preservesPitch=true;});document.querySelectorAll('[data-speed]').forEach(item=>item.setAttribute('aria-pressed',String(item===button)));}));document.querySelectorAll('audio').forEach(audio=>audio.addEventListener('play',()=>{document.querySelectorAll('audio').forEach(other=>{if(other!==audio)other.pause();});}));`;
export const renderScriptHash = `sha256-${createHash('sha256').update(script).digest('base64')}`;

// The course runtime is static: lesson data lives only in escaped DOM attributes.
const courseScript = `(()=>{
const player=document.getElementById('course-player');
const status=document.getElementById('audio-status');
const assets=new Map(Array.from(document.getElementById('audio-assets').content.querySelectorAll('[data-asset]'),node=>[node.dataset.asset,node.getAttribute('src')]));
document.querySelectorAll('audio[data-legacy-asset]').forEach(audio=>{const src=assets.get(audio.dataset.legacyAsset);if(src)audio.src=src;});
let token=0,chunk=0,queue=[],position=0,rate=1,repeats=1,active=null,removeListeners=()=>{};
function stop(message='Stopped.'){
  token++;removeListeners();removeListeners=()=>{};queue=[];position=0;
  player.pause();player.removeAttribute('src');player.load();
  if(active)active.removeAttribute('aria-current');active=null;status.textContent=message;
}
function playChunk(run){
  if(run!==token)return;
  if(position>=queue.length){stop('Finished.');return;}
  const src=assets.get(queue[position]);
  if(!src){stop('Audio unavailable.');return;}
  const currentChunk=++chunk;
  removeListeners();player.src=src;player.load();player.defaultPlaybackRate=rate;player.playbackRate=rate;player.preservesPitch=true;
  const ended=()=>{if(run!==token||currentChunk!==chunk||!player.ended)return;removeListeners();position++;playChunk(run);};
  const failed=()=>{if(run===token&&currentChunk===chunk)stop('Audio unavailable. Try another clip.');};
  player.addEventListener('ended',ended);player.addEventListener('error',failed);
  removeListeners=()=>{player.removeEventListener('ended',ended);player.removeEventListener('error',failed);};
  status.textContent='Playing '+(position+1)+' / '+queue.length+'.';
  try{const promise=player.play();if(promise)promise.catch(failed);}catch{failed();}
}
document.querySelectorAll('[data-audio-unit]').forEach(button=>button.addEventListener('click',()=>{
  stop('');if(button.disabled)return;
  const ids=button.dataset.clips.split(' ').filter(Boolean);
  if(!ids.length||ids.some(id=>!assets.has(id))){stop('Audio unavailable.');return;}
  document.querySelectorAll('audio[controls]').forEach(audio=>audio.pause());
  active=button;active.setAttribute('aria-current','true');queue=Array.from({length:repeats},()=>ids).flat();position=0;playChunk(token);
}));
document.querySelectorAll('[data-speed]').forEach(button=>button.addEventListener('click',()=>{rate=Number(button.dataset.speed);}));
document.querySelectorAll('[data-repeat]').forEach(button=>button.addEventListener('click',()=>{
  repeats=Number(button.dataset.repeat);
  document.querySelectorAll('[data-repeat]').forEach(item=>item.setAttribute('aria-pressed',String(item===button)));
}));
document.getElementById('audio-stop').addEventListener('click',()=>{stop();document.querySelectorAll('audio[controls]').forEach(audio=>audio.pause());});
document.querySelectorAll('audio[controls]').forEach(audio=>audio.addEventListener('play',()=>stop('')));
document.querySelectorAll('details').forEach(details=>details.addEventListener('toggle',()=>{if(!details.open){if(active&&details.contains(active))stop();details.querySelectorAll('audio[controls]').forEach(audio=>audio.pause());}}));
window.addEventListener('pagehide',()=>{stop();document.querySelectorAll('audio[controls]').forEach(audio=>audio.pause());});
document.addEventListener('visibilitychange',()=>{if(document.hidden){stop();document.querySelectorAll('audio[controls]').forEach(audio=>audio.pause());}});
window.addEventListener('message',event=>{if(event.source===parent&&event.data&&event.data.type==='learnlens-stop-audio'){stop();document.querySelectorAll('audio[controls]').forEach(audio=>audio.pause());}});
})();`;

// Parent pages embedding this document with srcdoc must allow this hash too.
export const fullAudioRenderScriptHash = `sha256-${createHash('sha256').update(script + courseScript).digest('base64')}`;

function supportedAudio(value) {
  if (typeof value !== 'string') return false;
  const prefix = /^data:audio\/(?:mpeg|mp3|wav|x-wav|wave|ogg|webm|mp4|aac|flac);base64,/.exec(value);
  if (!prefix) return false;
  const payload = value.slice(prefix[0].length);
  return payload.length > 0 && payload.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(payload);
}

function prepareCourse(course) {
  const e = escapeHtml;
  const blocks = new Map((course.blocks || []).map(block => [block.key, block]));
  const byBlock = new Map();
  for (const unit of course.units || []) {
    if (!byBlock.has(unit.blockKey)) byBlock.set(unit.blockKey, []);
    byBlock.get(unit.blockKey).push(unit);
  }
  const clips = new Map(), assets = new Map();
  for (const clip of course.clips || []) {
    if (typeof clip.id !== 'string' || !/^[a-f0-9]+$/i.test(clip.id) || clips.has(clip.id)) continue;
    if (!supportedAudio(clip.dataUrl)) { clips.set(clip.id, null); continue; }
    if (!assets.has(clip.dataUrl)) assets.set(clip.dataUrl, `a${assets.size}`);
    clips.set(clip.id, assets.get(clip.dataUrl));
  }
  const button = unit => {
    const ids = Array.isArray(unit.clipIds) ? unit.clipIds.map(id => clips.get(id)) : [];
    const ready = ids.length > 0 && ids.every(Boolean);
    return `<button type="button" class="audio-trigger ${unit.kind === 'word' ? 'word-play' : 'sentence-play'}" data-audio-unit="${unit.kind === 'word' ? 'word' : 'sentence'}"${ready ? ` data-clips="${ids.join(' ')}"` : ' disabled'} aria-label="${e(`${ready ? 'Play' : 'Audio not ready for'} ${unit.kind === 'word' ? 'word' : 'sentence'}: ${unit.text}`)}" title="${ready ? 'Listen' : 'Audio not generated yet'}">${unit.kind === 'word' ? e(unit.text) : ''}</button>`;
  };
  function annotate(key, value, answer = false) {
    const text = String(value), block = blocks.get(key);
    if (!block || block.text !== text || (block.answer && !answer)) return e(text);
    const units = (byBlock.get(key) || []).filter(unit => !unit.answer || answer);
    const words = new Map(units.filter(unit => unit.kind === 'word').map(unit => [unit.text, unit]));
    const spans = [];
    // Share inventory token boundaries; match exact case-sensitive word forms.
    let tokens = [];
    try { tokens = speechWords(text); } catch { /* Invalid inventory text remains plain, escaped text. */ }
    for (const token of tokens) {
      const unit = words.get(token.text);
      if (unit) spans.push({ start: token.start, end: token.end, html: button(unit) });
    }
    let cursor = 0;
    for (const unit of units.filter(unit => unit.kind === 'sentence')) {
      if (typeof unit.text !== 'string' || !unit.text.length) continue;
      let start = unit.start, end = unit.end;
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || text.slice(start, end) !== unit.text) {
        start = text.indexOf(unit.text, cursor); end = start + unit.text.length;
      }
      if (start < 0 || end > text.length) continue;
      cursor = end;
      spans.push({ start: end, end, html: button(unit) });
    }
    let result = '', last = 0;
    // Word replacements and zero-width sentence controls share one ordered stream.
    // Reject overlapping spans rather than nesting controls or duplicating text.
    for (const span of spans.sort((a, b) => a.start - b.start || a.end - b.end)) {
      if (span.start < last) continue;
      result += e(text.slice(last, span.start)) + span.html;
      last = span.end;
    }
    return result + e(text.slice(last));
  }
  const required = new Set(clips.keys());
  for (const unit of course.units || []) for (const id of unit.clipIds || []) required.add(id);
  const declared = Number.isSafeInteger(course.summary?.totalClips) && course.summary.totalClips >= 0 ? course.summary.totalClips : 0;
  const total = Math.max(required.size, declared);
  const completed = [...required].filter(id => clips.get(id)).length;
  const allUnitsReady = (course.units || []).every(unit => unit.clipIds?.length && unit.clipIds.every(id => clips.get(id)));
  const complete = course.summary?.status === 'complete' && completed === total && allUnitsReady && !(course.summary?.totalUnits > (course.units || []).length);
  const groups = new Map();
  for (const block of blocks.values()) {
    if (block.origin !== 'uploaded') continue;
    const source = String(block.source || 'Uploaded material');
    if (!groups.has(source)) groups.set(source, []);
    groups.get(source).push(block);
  }
  const sources = groups.size ? `<section class="source-reading"><div class="section-kicker">READ YOUR SOURCES</div><h2>All retained source text</h2>${[...groups].map(([source, entries]) => `<details><summary>${e(source)}</summary>${entries.map(block => block.answer ? `<details><summary>Reveal answer & explanation</summary><p>${annotate(block.key, block.text, true)}</p></details>` : `<p>${annotate(block.key, block.text)}</p>`).join('')}</details>`).join('')}</section>` : '';
  const controls = `<section class="audio-section course-controls" aria-label="English audio controls"><h2>English audio</h2><p class="audio-coverage">English audio coverage: ${completed} / ${total} clips completed. ${complete ? 'Complete.' : 'Incomplete — some English audio may not be available yet.'}</p><div class="audio-toolbar"><div class="speed" role="group" aria-label="Audio playback speed">${[1, .75, .5].map(rate => `<button type="button" data-speed="${rate}" aria-pressed="${rate === 1}">${rate}×</button>`).join('')}</div><div class="speed" role="group" aria-label="Audio repetitions">${[1, 3, 5].map(count => `<button type="button" data-repeat="${count}" aria-pressed="${count === 1}">Repeat ${count}</button>`).join('')}</div><button type="button" id="audio-stop">Stop</button></div><p id="audio-status" role="status" aria-live="polite">Click an underlined word or a sentence play button to listen.</p><p class="recognition-note">${Number.isSafeInteger(course.summary?.sourceUncertainties) ? course.summary.sourceUncertainties : 0} source(s) have uncertain or unverified automatic recognition. Clip completion is not proof of accurate transcription or pronunciation.</p><audio id="course-player" preload="none"></audio></section>`;
  const assetFor = src => {
    if (!assets.has(src)) assets.set(src, `a${assets.size}`);
    return assets.get(src);
  };
  return { annotate, sources, controls, blocks, assetFor, get assetHtml() {
    return `<template id="audio-assets">${[...assets].map(([src, id]) => `<audio data-asset="${id}" src="${e(src)}" preload="none"></audio>`).join('')}</template>`;
  } };
}

export function renderLesson(lesson, { images = [], sourceText = '', audio = [], warnings = [], sample = false, audioCourse } = {}) {
  const e = escapeHtml;
  const course = audioCourse ? prepareCourse(audioCourse) : null;
  const field = (key, value, answer = false) => course ? course.annotate(key, value, answer) : e(value);
  const activeScript = course ? script + courseScript : script;
  const activeHash = course ? fullAudioRenderScriptHash : renderScriptHash;
  const allWarnings = [...warnings, ...(audioCourse?.warnings || [])];
  const isAnswerLine = text => course && typeof text === 'string' && text.trim() && lesson.sections.some(section => section.answer?.trim() && (section.answer.includes(text.trim()) || text.includes(section.answer.trim())));
  const rtl = /arabic|hebrew|persian|urdu|العربية|עברית|فارسی|اردو/i.test(lesson.language);
  const languageCode = /chinese|中文|简体|繁體/.test(lesson.language.toLowerCase()) ? 'zh' : /spanish|español/i.test(lesson.language) ? 'es' : /french|français/i.test(lesson.language) ? 'fr' : /german|deutsch/i.test(lesson.language) ? 'de' : /japanese|日本語/i.test(lesson.language) ? 'ja' : /arabic|العربية/i.test(lesson.language) ? 'ar' : 'en';
  const audioSection = audio.length ? `<section class="audio-section"><div class="section-kicker">LISTEN & REPEAT</div><h2>Make the words your own.</h2><p>Natural AI-generated speech. Listen, pause, and repeat at your own pace.</p><div class="speed" role="group" aria-label="Audio playback speed">${[1, 0.75, 0.5].map(rate => `<button data-speed="${rate}" aria-pressed="${rate === 1}">${rate}×</button>`).join('')}</div>${audio.map((a, i) => { const hidden = isAnswerLine(a.text) || course?.blocks.get(`lesson.audio.${i}.text`)?.answer; return `${hidden ? '<details><summary>Reveal answer & explanation</summary>' : ''}<article class="audio-line"><span class="number">${String(i + 1).padStart(2, '0')}</span><div><p class="spoken">${e(a.text)}</p>${a.translation ? `<p class="translation">${e(a.translation)}</p>` : ''}${supportedAudio(a.dataUrl) ? `<audio controls preload="none" aria-label="Sentence ${i + 1}" ${course ? `data-legacy-asset="${course.assetFor(a.dataUrl)}"` : `src="${e(a.dataUrl)}"`}></audio>` : '<p>Audio unavailable.</p>'}</div></article>${hidden ? '</details>' : ''}`; }).join('')}</section>` : '';
  return `<!doctype html>
<html lang="${languageCode}" dir="${rtl ? 'rtl' : 'ltr'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; media-src data:; style-src 'unsafe-inline'; script-src '${activeHash}'; connect-src 'none'; base-uri 'none'; form-action 'none'"><title>${e(lesson.title)} · LearnLens</title><style>
*{box-sizing:border-box}body{margin:0;background:#f5f3ed;color:#233d36;font:17px/1.75 system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}main{max-width:900px;margin:auto;padding:42px 28px 64px}.brand{font-weight:800;letter-spacing:-.8px;font-size:23px;display:flex;align-items:center;gap:10px}.mark{width:28px;height:28px;border:7px solid #28594b;border-radius:50%;position:relative}.mark:after{content:'';width:12px;height:5px;background:#dc9060;position:absolute;transform:rotate(45deg);right:-12px;bottom:-6px;border-radius:3px}.topline{display:flex;justify-content:space-between;gap:20px;align-items:center;border-bottom:1px solid #d6ded4;padding-bottom:22px;font-size:12px}.tag{background:#e5ede3;border-radius:30px;padding:5px 13px;font-weight:600}.hero{padding:42px 0 30px}.eyebrow,.section-kicker{font-size:11px;font-weight:800;letter-spacing:1.8px;text-transform:uppercase;color:#537365}h1{font-family:Georgia,'Times New Roman',serif;font-weight:500;line-height:1.13;letter-spacing:-1.5px;font-size:clamp(32px,6vw,56px);margin:17px 0 20px}h2{font-size:24px;line-height:1.35;letter-spacing:-.5px;margin:8px 0 18px}p{margin:10px 0;white-space:pre-wrap;overflow-wrap:anywhere}.lede{color:#5b6c65;font-size:19px}.meta{display:flex;gap:8px;flex-wrap:wrap;margin-top:22px;font-size:12px}.objectives{border-left:3px solid #d38e5e;padding:6px 0 6px 22px;margin:15px 0 35px}.objectives strong{font-size:13px;text-transform:uppercase;letter-spacing:1px}ul,ol{padding-inline-start:24px}li{margin:8px 0;white-space:pre-wrap;overflow-wrap:anywhere}.lesson-section{border:1px solid #dde2d9;background:#fffefa;padding:30px;border-radius:16px;margin:18px 0}.type-quiz{background:#eaf0e7;border-color:#d1ddcc}.type-example{border-top:3px solid #d7986e}.number{font-size:12px;font-weight:700;color:#668170;letter-spacing:1px}.translation{color:#617166;border-inline-start:2px solid #cdd9c7;padding-inline-start:14px}.source{font-size:12px;color:#788276;border-top:1px solid #e5e8df;padding-top:12px;margin-top:20px}.question{font-size:19px;font-weight:600}details{margin-top:18px}summary{cursor:pointer;color:#2e6654;font-size:14px;font-weight:700;padding:10px 0}details p{border-top:1px solid #cbdac5;padding-top:14px}.audio-section{background:#213e34;color:#f8f7ec;padding:30px;border-radius:16px;margin:28px 0}.audio-section .section-kicker{color:#a6c6b3}.audio-section .translation{color:#bfd1c5}.speed{display:flex;gap:8px;margin:20px 0}.speed button{border:1px solid #70877a;color:white;background:transparent;padding:8px 18px;border-radius:30px;cursor:pointer;font:inherit;font-size:13px}.speed button[aria-pressed=true]{background:#e5edd8;color:#213e34;border-color:#e5edd8}.audio-line{display:grid;grid-template-columns:30px 1fr;gap:10px;border-top:1px solid #496253;padding:18px 0}.audio-line .number{color:#b3c9b7}audio{width:100%;max-width:580px;margin-top:8px}.spoken{font-size:20px}.notices{font-size:13px;color:#776348;border:1px solid #e6d9bd;border-radius:12px;padding:16px 22px;background:#fff8e8;margin:24px 0}.source-images img{max-width:100%;height:auto;border:1px solid #dde2d9;border-radius:8px}.source-images figure{margin:22px 0}figcaption{font-size:12px;color:#68796c}.source-text{max-height:420px;overflow:auto;font-size:13px}footer{font-size:12px;color:#7a857b;border-top:1px solid #d7dfd2;margin-top:38px;padding-top:20px;display:flex;justify-content:space-between;gap:20px}button:focus-visible,summary:focus-visible,audio:focus-visible{outline:3px solid #e5ad76;outline-offset:4px}@media(max-width:600px){main{padding:20px 16px 40px}.lesson-section,.audio-section{padding:22px}.topline{flex-wrap:wrap}.hero{padding-top:28px}footer{display:block}}@media print{body{background:white;color:black}main{max-width:none}audio,.speed{display:none}details>*{display:block}summary{display:none}.lesson-section{break-inside:avoid}footer{color:#444}}
${course ? `.word-play{display:inline;appearance:none;margin:0;padding:0;border:0;background:none;color:inherit;font:inherit;line-height:inherit;letter-spacing:inherit;text-align:inherit;white-space:inherit;text-decoration:underline dotted #8ca696;text-underline-offset:.16em;cursor:pointer}.word-play:disabled{color:inherit;opacity:1;text-decoration:none;cursor:text}.word-play:not(:disabled):hover,.word-play[aria-current=true]{background:#e5ede3;text-decoration-color:currentColor}.sentence-play{display:inline-block;vertical-align:middle;width:28px;height:24px;margin:0 3px;padding:0;border:1px solid #b2c7b6;border-radius:12px;background:#edf3e8;color:#234d3d;cursor:pointer;font:12px/1 system-ui;letter-spacing:normal}.sentence-play:before{content:'▶'}.sentence-play:disabled{opacity:.45;cursor:not-allowed}.sentence-play[aria-current=true]{background:#28594b;color:white}.source-reading{margin:28px 0}.source-reading p{white-space:pre-wrap;overflow-wrap:anywhere}.source-reading summary{overflow-wrap:anywhere}.course-controls{padding:14px 18px;margin:18px 0;font-size:13px;line-height:1.5}.course-controls h2{font-size:16px;margin:0}.course-controls p{margin:6px 0}.audio-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:8px 16px}.course-controls .speed{flex-wrap:wrap;gap:6px;margin:0}.course-controls .speed button{padding:4px 10px}.course-controls #audio-stop{font:inherit;padding:4px 12px;border-radius:8px;border:1px solid #b2c7b6;cursor:pointer}.course-controls audio{display:none}@media print{.sentence-play,.course-controls{display:none}.word-play{color:inherit;background:none;text-decoration:none}}` : ''}
</style></head><body><main><header class="topline"><div class="brand"><span class="mark" aria-hidden="true"></span>LearnLens</div><span class="tag">${sample ? 'Hand-authored example' : 'Your personal lesson'} · ${course ? 'Offline file' : 'Offline ready'}</span></header><div class="hero"><div class="eyebrow">${e(lesson.subject)}</div><h1>${field('lesson.title', lesson.title)}</h1><p class="lede">${field('lesson.summary', lesson.summary)}</p><div class="meta"><span class="tag">${e(lesson.level)}</span><span class="tag">${e(lesson.language)}</span></div></div><aside class="objectives"><strong>What you’ll learn</strong><ul>${lesson.objectives.map((o, i) => `<li>${field(`lesson.objectives.${i}`, o)}</li>`).join('')}</ul></aside>${course?.controls || ''}${lesson.sections.map((section, index) => `<section class="lesson-section type-${e(section.type)}"><span class="number">${String(index + 1).padStart(2, '0')} / ${e(section.type)}</span><h2>${field(`lesson.sections.${index}.title`, section.title)}</h2>${section.question ? `<p class="question">${field(`lesson.sections.${index}.question`, section.question)}</p>` : ''}${section.body ? `<p>${field(`lesson.sections.${index}.body`, section.body)}</p>` : ''}${section.items.length ? `<${section.type === 'steps' ? 'ol' : 'ul'}>${section.items.map((item, i) => `<li>${field(`lesson.sections.${index}.items.${i}`, item)}</li>`).join('')}</${section.type === 'steps' ? 'ol' : 'ul'}>` : ''}${section.translation ? `<p class="translation">${field(`lesson.sections.${index}.translation`, section.translation)}</p>` : ''}${section.answer ? `<details><summary>Reveal answer & explanation</summary><p>${field(`lesson.sections.${index}.answer`, section.answer, true)}</p></details>` : ''}${section.source ? `<p class="source">Source reference: ${e(section.source)}</p>` : ''}</section>`).join('')}${course?.sources || ''}${course ? (lesson.audio || []).map((line, index) => { const key = `lesson.audio.${index}.text`; const block = course.blocks.get(key); const hidden = !!block?.answer || isAnswerLine(line.text); const content = `<p>${field(key, line.text, hidden)}</p>${line.translation ? `<p class="translation">${e(line.translation)}</p>` : ''}`; return hidden ? `<details><summary>Reveal answer & explanation</summary>${content}</details>` : `<div class="course-line">${content}</div>`; }).join('') : ''}${audioSection}${allWarnings.length ? `<aside class="notices"><strong>Learning notes</strong><ul>${allWarnings.map(w => `<li>${e(w)}</li>`).join('')}</ul></aside>` : ''}${images.length || sourceText ? `<details class="source-images"><summary>${course ? 'Preparation notes & representative images' : 'Your original material'}</summary>${images.map(image => `<figure><img src="${e(image.dataUrl)}" alt="${e(image.name)}" loading="lazy"><figcaption>${e(image.name)}</figcaption></figure>`).join('')}${sourceText ? `<p class="source-text">${e(sourceText)}</p>` : ''}</details>` : ''}<footer><span>LearnLens · See it. Hear it. Understand it.</span><span>${sample ? 'Sample lesson' : 'AI-assisted content · Review important facts with your teacher.'}</span></footer></main>${course?.assetHtml || ''}<script>${activeScript}</script></body></html>`;
}
