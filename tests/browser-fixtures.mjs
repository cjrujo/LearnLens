import http from 'node:http';
import assert from 'node:assert/strict';
import { videoWindows } from '../lib/video-analysis.mjs';
import { demoLesson } from '../lib/lesson.mjs';
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pdf, zip, docxEntries, paragraph, pptxManyEntries } from './document-fixtures.mjs';

export function callKind(call) {
  if (/^\/v1beta\/models\/[^/]+:generateContent$/.test(call.path)) {
    const nativeVideo = call.body?.systemInstruction?.parts?.some(part => part.text?.includes('LEARNLENS_WHOLE_VIDEO_V1')) || call.body?.contents?.some(content => content.parts?.some(part => part.inlineData?.mimeType?.startsWith('video/')));
    return nativeVideo ? 'video' : 'transcription';
  }
  if (call.path === '/v1/audio/transcriptions') return 'transcription';
  if (call.path === '/v1/audio/speech') return 'speech';
  if (call.path !== '/v1/responses') return 'discovery';
  const instructions = call.body?.instructions || '';
  return instructions.includes('LEARNLENS_AUDIO_SOURCE') ? 'audio-extract' : instructions.includes('LEARNLENS_SOURCE_DIGEST') ? 'digest' : instructions.includes('model setup advisor') ? 'advisor' : instructions.includes('LearnLens') ? 'lesson' : 'probe';
}

// Real file bytes, not renamed text masquerading as office/media containers.
export async function importFixtures(directory, { media = false } = {}) {
  await mkdir(directory, { recursive: true });
  const documents = [
    ['five-pages.pdf', pdf({ pages: 5, text: n => `PDF page ${n} evidence` })],
    ['long-source.docx', zip(docxEntries(paragraph('DOCX_BEGIN ' + 'Detailed office source evidence. '.repeat(1800) + ' DOCX_END')))],
    ['six-slides.pptx', zip(pptxManyEntries(6))],
  ];
  const files = [];
  for (const [name, bytes] of documents) { const path = resolve(directory, name); await writeFile(path, bytes); files.push(path); }
  const mediaFiles = [];
  if (media) {
    const { ensureMediaTools } = await import('../deploy/media-assets.mjs');
    const { __testing: native } = await import('../lib/native-media.mjs');
    // Never acquire tools from the network in browser QA. Missing cache fails explicitly.
    const tools = await ensureMediaTools({ offline: true });
    const sound = ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000'];
    const video = ['-f', 'lavfi', '-i', 'color=c=blue:size=320x180:rate=2'];
    const specs = [
      ['long-recording.mp3', [...sound, '-t', '181.25', '-c:a', 'libmp3lame', '-b:a', '32k']],
      ['movie.mp4', [...video, ...sound, '-t', '2.5', '-c:v', 'mpeg4', '-q:v', '8', '-c:a', 'aac']],
      ['recording.webm', [...video, ...sound, '-t', '2.5', '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-c:a', 'libopus']],
      ['silent.mp4', [...video, '-t', '2.5', '-c:v', 'mpeg4', '-q:v', '8', '-an']],
    ];
    for (const [name, args] of specs) {
      const path = resolve(directory, name);
      await native.runProcess(tools.ffmpeg, ['-hide_banner', '-v', 'error', '-nostdin', '-y', '-filter_threads', '1', ...args, '-threads', '2', path], { maxBytes: 1024, timeoutMs: 90000 });
      mediaFiles.push(path);
    }
  }
  return { documents: files, media: mediaFiles };
}

// One second of a quiet test tone. This is deliberately not presented as AI narration.
export const wav = Buffer.alloc(44 + 16000 * 2);
wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(32000, 40);
for (let i = 0; i < 16000; i++) wav.writeInt16LE(Math.round(Math.sin(i / 16000 * Math.PI * 2 * 440) * 1000), 44 + i * 2);

// Stable original-source tails prove that the full inventory is not the old eight-clip sample.
export const sourceText = 'A short Markdown source file. ' + 'Careful readers retain every original English sentence. '.repeat(12) + 'Original text final sentinel survives.';
export const transcriptText = 'Teach me about Newton’s laws in English. The recording final sentinel survives.';
export const ocrText = 'Original screenshot English, not a source digest. Screenshot final sentinel survives.';
// More than 500 characters, one sentence: exercises sequenced sentence pieces.
export const longSentence = 'A ' + 'careful reader follows the original source and learns each word '.repeat(12) + 'until the long sentence final sentinel.';
// Entirely invented teaching material. Explicit metadata, not English-looking text,
// decides Auto audio; slash pauses must change speech input without changing display.
export const readingFixtures = Object.freeze({
  body: 'We read / with care.', spokenBody: 'We read, with care.',
  question: 'Why read / with care?', spokenQuestion: 'Why read, with care?',
  answer: 'We learn / together.', spokenAnswer: 'We learn, together.',
  audio: 'Speak slowly / and clearly.', spokenAudio: 'Speak slowly, and clearly.',
  meaningful: 'Choose and / or for alternatives. Compare 3/4 and m/s.',
  uploaded: 'Uploaded words / are not reading markup.',
});
export function englishAudioLesson(overrides = {}) {
  return {
    title: '合成英语阅读练习', subject: 'Language learning', englishLearning: true,
    level: 'Primary', language: 'Chinese (Simplified)', summary: '用中文理解英语阅读。此内容只用于隔离测试。',
    objectives: ['练习英语阅读并保留原始断句标记。'],
    sections: [
      { type: 'explanation', title: '阅读与停顿', body: readingFixtures.body, items: [], translation: '认真阅读。', readingPauses: true },
      { type: 'quiz', title: '独立练习', body: 'Read the sentence.', items: [], question: readingFixtures.question, answer: readingFixtures.answer, readingPauses: true },
      { type: 'example', title: '有意义的斜线不是停顿标记', body: readingFixtures.meaningful, items: [] },
    ].map(section => ({ question: '', answer: '', translation: '', source: '', ...section })),
    audio: [{ text: readingFixtures.audio, translation: '放慢语速，清楚表达。', readingPauses: true }],
    warnings: ['Synthetic QA output; the generated audio is a test tone, not natural narration.'],
    ...overrides,
  };
}
export function mathAudioLesson() {
  return {
    title: 'Synthetic mathematics lesson', subject: 'Mathematics', englishLearning: false,
    level: 'Primary', language: 'English', summary: 'Learn addition using English explanations, not English language study.',
    objectives: ['Add small numbers.'],
    sections: [{ type: 'quiz', title: 'Addition', body: 'Three plus four is seven.', items: [], question: 'What is two plus three?', answer: 'The answer is five.', translation: '', source: '' }],
    audio: [], warnings: ['Invented mathematics fixture; no real learner material.'],
  };
}
// Invented recognition output, not a claim that the tone/solid-color fixture
// contains speech or screen words. Native decoding remains the app's real path.
export function wholeVideoFixtureResponse(body) {
  assert.ok(body?.systemInstruction?.parts?.some(part => part.text?.includes('LEARNLENS_WHOLE_VIDEO_V1')), 'Native video requires the whole-video marker');
  const parts = body.contents?.[0]?.parts;
  assert.equal(parts?.[1]?.inlineData?.mimeType, 'video/mp4');
  assert.ok(parts[1].inlineData.data, 'Native video has attached clip bytes');
  const requested = /^Analyze every interval in this native audiovisual clip\. Required windows: (\[.*\])\. Clip duration: ([\d.]+) seconds\. A soundtrack (is present|is absent)\b/.exec(parts[0]?.text || '');
  assert.ok(requested, 'Use the actual requested clip windows/duration and soundtrack metadata');
  const windows = JSON.parse(requested[1]), duration = Number(requested[2]), hasAudio = requested[3] === 'is present';
  assert.deepEqual(windows, videoWindows(duration), 'No fixed one-window or truncated-tail fixture');
  const result = { version: 1, windows: windows.map(bounds => ({
    ...bounds,
    transcript: hasAudio ? `Mock native speech from ${bounds.start} to ${bounds.end} seconds / stays verbatim.` : '',
    visibleText: `Mock screen words from ${bounds.start} to ${bounds.end} seconds / stay original.`,
    observations: `Derived visual interpretation from ${bounds.start} to ${bounds.end} seconds is not original speech.`,
    audioCoverage: hasAudio ? 'complete' : 'no_audio', visualCoverage: 'complete',
  })), warnings: ['Invented QA recognition output, not evidence of real speech, screen text or model accuracy.'] };
  return { candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ text: 'Excluded fixture thinking', thought: true }, { text: JSON.stringify(result) }] } }] };
}

export function createQAProvider({ lesson: suppliedLesson } = {}) {
  const config = { lesson: suppliedLesson && structuredClone(suppliedLesson), status: 200, failKind: null, failAfter: null, audioExtractFailAt: null, speechDelay: 0, lessonDelay: 0, flushLessonHeaders: false, digestNotes: null, digestFaultAt: null, digestFaultRepeat: false, digestFault: 'oversized-notes' }, calls = [];
  const lesson = structuredClone(demoLesson);
  lesson.title = 'Browser integration test';
  lesson.summary = 'Mock-provider output for testing, not AI tutoring. <script>window.__learnlensExportInjection=true</script>';
  lesson.audio = [{ text: 'This is a test audio clip.', translation: '测试音频' }];
  lesson.warnings = ['QA mock provider — audio is a test tone, not a human-like generated voice.'];
  const server = http.createServer(async (req, res) => {
    const parts = [];
    for await (const part of req) parts.push(part);
    const raw = Buffer.concat(parts).toString();
    let body; try { body = JSON.parse(raw); } catch { /* Multipart or GET. */ }
    const call = { path: req.url, body };
    call.kind = callKind(call);
    // Retain only synthetic fixture metadata; no request headers, cookies or keys.
    if (call.kind === 'transcription') {
      call.filename = /filename="([^"]+)"/.exec(raw)?.[1];
      call.model = /name="model"\r\n\r\n([^\r]+)/.exec(raw)?.[1] || /^\/v1beta\/models\/([^/]+):generateContent$/.exec(req.url)?.[1];
    }
    calls.push(call);
    res.setHeader('Content-Type', 'application/json');
    if (call.kind === 'lesson' && config.lessonDelay) {
      call.startedAt = Date.now();
      if (config.flushLessonHeaders) { res.flushHeaders(); call.headersFlushedAt = Date.now(); }
      await new Promise(resolve => {
        const timer = setTimeout(done, config.lessonDelay);
        function done() { clearTimeout(timer); res.off('close', done); resolve(); }
        res.once('close', done);
      });
      call.elapsedMs = Date.now() - call.startedAt;
      call.disconnected = res.destroyed;
      if (res.destroyed) return;
    }
    if (call.kind === 'speech' && config.speechDelay) await new Promise(resolve => setTimeout(resolve, config.speechDelay));
    if (config.status !== 200 || config.failKind === call.kind || (call.kind === 'audio-extract' && config.audioExtractFailAt !== null && calls.filter(c => c.kind === 'audio-extract').length === config.audioExtractFailAt) || (call.kind === 'speech' && config.failAfter !== null && calls.filter(c => c.kind === 'speech').length > config.failAfter)) { call.failed = true; res.statusCode = config.status !== 200 ? config.status : 500; res.end('{}'); return; }
    if (req.url === '/v1/models') res.end(JSON.stringify({ data: ['test/vision', 'test/speech', 'test/transcribe', 'gpt-5.4-mini'].map(id => ({ id })) }));
    else if (req.url === '/v1/responses') {
      const input = JSON.parse(raw), prompt = JSON.stringify(input.input);
      let text;
      if (input.instructions.includes('LEARNLENS_AUDIO_SOURCE')) {
        text = JSON.stringify({ text: ocrText, coverage: 'complete', warnings: [] });
      } else if (input.instructions.includes('LEARNLENS_SOURCE_DIGEST')) {
        const ordinal = calls.filter(c => c.kind === 'digest').length;
        const malformed = config.digestFaultAt !== null && (ordinal === config.digestFaultAt || (config.digestFaultRepeat && ordinal > config.digestFaultAt));
        if (malformed) { call.malformed = true; text = config.digestFault === 'invalid-json' ? '{not valid JSON' : JSON.stringify({ notes: 'x'.repeat(8001), warnings: [] }); }
        else text = JSON.stringify({ notes: config.digestNotes ?? 'Fixture digest of the supplied source part. This is synthetic QA, not real AI.', warnings: [] });
      } else if (input.instructions.includes('model setup advisor')) {
        const catalog = JSON.parse(input.input[0].content[0].text).candidates;
        const roles = Object.fromEntries(Object.entries({ primary: 'test/vision', speech: 'test/speech', transcription: 'test/transcribe' }).map(([role, model]) => [role, { candidateId: catalog.find(c => c.model === model)?.candidateId ?? null, reason: 'QA fixture recommendation.', caveat: 'This is not real model advice.' }]));
        text = JSON.stringify({ summary: 'Mock setup advice', roles, warnings: ['Mock advisor; verify compatibility.'] });
      } else text = input.instructions.includes('LearnLens') ? JSON.stringify(config.lesson ?? lesson) : prompt.includes('dominant color') ? 'green' : 'READY';
      res.end(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text }] }] }));
    } else if (req.url === '/v1/audio/speech') { res.setHeader('Content-Type', 'audio/wav'); res.end(wav); }
    else if (req.url === '/v1/audio/transcriptions') res.end(JSON.stringify({ text: config.transcriptText ?? transcriptText }));
    else if (call.kind === 'video') {
      try { res.end(JSON.stringify(wholeVideoFixtureResponse(body))); }
      catch (error) { call.failed = true; res.statusCode = 500; res.end(JSON.stringify({ error: error.message })); }
    }
    else if (/^\/v1beta\/models\/[^/]+:generateContent$/.test(req.url)) res.end(JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ text: 'Excluded fixture thinking', thought: true }, { text: 'Gemini-native synthetic transcript about Newton’s laws.' }] } }] }));
    else { res.statusCode = 404; res.end('{}'); }
  });
  return { server, config, calls };
}

export async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return `http://127.0.0.1:${server.address().port}`;
}
export async function close(server) {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
