import http from 'node:http';
import { demoLesson } from '../lib/lesson.mjs';

// One second of a quiet test tone. This is deliberately not presented as AI narration.
export const wav = Buffer.alloc(44 + 16000 * 2);
wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(32000, 40);
for (let i = 0; i < 16000; i++) wav.writeInt16LE(Math.round(Math.sin(i / 16000 * Math.PI * 2 * 440) * 1000), 44 + i * 2);

export function createQAProvider() {
  const config = { status: 200 }, calls = [];
  const lesson = structuredClone(demoLesson);
  lesson.title = 'Browser integration test';
  lesson.summary = 'Mock-provider output for testing, not AI tutoring.';
  lesson.audio = [{ text: 'This is a test audio clip.', translation: '测试音频' }];
  lesson.warnings = ['QA mock provider — audio is a test tone, not a human-like generated voice.'];
  const server = http.createServer(async (req, res) => {
    const parts = [];
    for await (const part of req) parts.push(part);
    const raw = Buffer.concat(parts).toString();
    let body; try { body = JSON.parse(raw); } catch { /* Multipart or GET. */ }
    calls.push({ path: req.url, body });
    res.setHeader('Content-Type', 'application/json');
    if (config.status !== 200) { res.statusCode = config.status; res.end('{}'); return; }
    if (req.url === '/v1/models') res.end(JSON.stringify({ data: ['test/vision', 'test/speech', 'test/transcribe', 'gpt-5.4-mini'].map(id => ({ id })) }));
    else if (req.url === '/v1/responses') {
      const input = JSON.parse(raw), prompt = JSON.stringify(input.input);
      let text;
      if (input.instructions.includes('model setup advisor')) {
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
