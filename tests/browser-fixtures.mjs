import http from 'node:http';
import { demoLesson } from '../lib/lesson.mjs';
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pdf, zip, docxEntries, paragraph, pptxManyEntries } from './document-fixtures.mjs';

export function callKind(call) {
  if (call.path === '/v1/audio/transcriptions') return 'transcription';
  if (call.path === '/v1/audio/speech') return 'speech';
  if (call.path !== '/v1/responses') return 'discovery';
  const instructions = call.body?.instructions || '';
  return instructions.includes('LEARNLENS_SOURCE_DIGEST') ? 'digest' : instructions.includes('model setup advisor') ? 'advisor' : instructions.includes('LearnLens') ? 'lesson' : 'probe';
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
      ['movie.mp4', [...video, ...sound, '-t', '2.25', '-c:v', 'mpeg4', '-q:v', '8', '-c:a', 'aac']],
      ['recording.webm', [...video, ...sound, '-t', '2.25', '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-c:a', 'libopus']],
      ['silent.mp4', [...video, '-t', '2.25', '-c:v', 'mpeg4', '-q:v', '8', '-an']],
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

export function createQAProvider() {
  const config = { status: 200, failKind: null }, calls = [];
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
      call.model = /name="model"\r\n\r\n([^\r]+)/.exec(raw)?.[1];
    }
    calls.push(call);
    res.setHeader('Content-Type', 'application/json');
    if (config.status !== 200 || config.failKind === call.kind) { call.failed = true; res.statusCode = config.status !== 200 ? config.status : 500; res.end('{}'); return; }
    if (req.url === '/v1/models') res.end(JSON.stringify({ data: ['test/vision', 'test/speech', 'test/transcribe', 'gpt-5.4-mini'].map(id => ({ id })) }));
    else if (req.url === '/v1/responses') {
      const input = JSON.parse(raw), prompt = JSON.stringify(input.input);
      let text;
      if (input.instructions.includes('LEARNLENS_SOURCE_DIGEST')) {
        text = JSON.stringify({ notes: 'Fixture digest of the supplied source part. This is synthetic QA, not real AI.', warnings: [] });
      } else if (input.instructions.includes('model setup advisor')) {
        const catalog = JSON.parse(input.input[0].content[0].text).candidates;
        const roles = Object.fromEntries(Object.entries({ primary: 'test/vision', speech: 'test/speech', transcription: 'test/transcribe' }).map(([role, model]) => [role, { candidateId: catalog.find(c => c.model === model)?.candidateId ?? null, reason: 'QA fixture recommendation.', caveat: 'This is not real model advice.' }]));
        text = JSON.stringify({ summary: 'Mock setup advice', roles, warnings: ['Mock advisor; verify compatibility.'] });
      } else text = input.instructions.includes('LearnLens') ? JSON.stringify(lesson) : prompt.includes('dominant color') ? 'green' : 'READY';
      res.end(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text }] }] }));
    } else if (req.url === '/v1/audio/speech') { res.setHeader('Content-Type', 'audio/wav'); res.end(wav); }
    else if (req.url === '/v1/audio/transcriptions') res.end(JSON.stringify({ text: 'Teach me about Newton’s laws in English.' }));
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
