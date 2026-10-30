// Private, authenticated adapter for the managed Node/ONNX speech worker.
// Deliberately not a public OpenAI server: only the parent app receives its token.
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';

export function pcmWav(audio, rate = 24000) {
  if (!(audio instanceof Float32Array) || !audio.length || audio.length > (8 * 1024 * 1024 - 44) / 2) throw new Error('Speech audio exceeds the output limit.');
  if (!Number.isInteger(rate) || rate < 8000 || rate > 96000) throw new Error('Invalid speech sample rate.');
  const wav = Buffer.alloc(44 + audio.length * 2);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(audio.length * 2, 40);
  for (let i = 0; i < audio.length; i++) {
    const value = Number.isFinite(audio[i]) ? Math.max(-1, Math.min(1, audio[i])) : 0;
    wav.writeInt16LE(Math.round(value * (value < 0 ? 32768 : 32767)), 44 + i * 2);
  }
  return wav;
}

export function createNativeSpeechServer({ token, voices, generate, maxJobs = 8 }) {
  if (typeof token !== 'string' || token.length < 32) throw new Error('A private speech token is required.');
  const expected = Buffer.from(`Bearer ${token}`), queue = [];
  let busy = false;
  function json(response, status, message) {
    if (!response.destroyed) { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify({ error: { message } })); }
  }
  async function drain() {
    if (busy) return;
    busy = true;
    while (queue.length) {
      const { response, input, voice } = queue.shift();
      if (response.destroyed) continue;
      try {
        const audio = await generate(input, voice);
        const wav = pcmWav(audio.audio, audio.sampling_rate);
        if (!response.destroyed) { response.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': wav.length, 'Cache-Control': 'no-store' }); response.end(wav); }
      } catch { json(response, 500, 'Local speech synthesis failed. Try shorter English text or an online speech provider.'); }
    }
    busy = false;
  }
  const server = http.createServer(async (request, response) => {
    try {
      const auth = Buffer.from(request.headers.authorization || '');
      const host = `127.0.0.1:${server.address().port}`;
      if (request.headers.host !== host || request.headers.origin || request.headers['sec-fetch-site'] === 'cross-site') return json(response, 403, 'Private speech endpoint.');
      if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) return json(response, 401, 'Private speech authorization required.');
      if (request.method !== 'POST' || request.url !== '/v1/audio/speech') return json(response, 404, 'Unknown speech endpoint.');
      if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] || '')) return json(response, 415, 'JSON is required.');
      const chunks = []; let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 16384) { response.setHeader('Connection', 'close'); json(response, 413, 'Speech request is too large.'); return; }
        chunks.push(chunk);
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return json(response, 400, 'Invalid JSON.'); }
      if (!body || Array.isArray(body) || body.model !== 'kokoro' || body.response_format !== 'wav' || !voices.includes(body.voice)) return json(response, 400, 'Choose the Kokoro model, WAV output and a supported English voice.');
      if (typeof body.input !== 'string' || !body.input.trim() || body.input.length > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(body.input)) return json(response, 400, 'Speech needs 1–2000 characters of text.');
      if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Cyrillic}\p{Script=Arabic}\p{Script=Devanagari}]/u.test(body.input)) return json(response, 400, 'This native Kokoro runtime supports English. Choose an online speech provider for other languages.');
      if (queue.length + Number(busy) >= maxJobs) return json(response, 503, 'Local speech is busy. Try again shortly.');
      queue.push({ response, input: body.input.trim(), voice: body.voice });
      void drain();
    } catch { json(response, 400, 'Could not read the speech request.'); }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000; server.maxConnections = 24;
  return server;
}
