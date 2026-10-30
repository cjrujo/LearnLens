// Image-build step. Populate language/model caches before offline runtime.
import { launchKokoro } from './kokoro-runtime.mjs';
const worker = launchKokoro({ offline: false, timeoutMs: 300000 });
try {
  await worker.waitReady();
  const response = await fetch('http://127.0.0.1:8880/v1/audio/speech', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'kokoro', voice: 'af_heart', input: 'Welcome to LearnLens. Speech is included.', response_format: 'wav' }),
    signal: AbortSignal.timeout(120000),
  });
  if (!response.ok) throw new Error(`Built-in speech image warmup failed (HTTP ${response.status}).`);
  const audio = Buffer.from(await response.arrayBuffer());
  if (audio.length <= 44 || audio.toString('ascii', 0, 4) !== 'RIFF' || audio.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Image warmup returned no playable WAV.');
  console.log(`Built-in English speech warmed and cached (${audio.length} audio bytes).`);
} finally { await worker.stop(); }
