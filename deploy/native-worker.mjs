import net from 'node:net';
import { prepareNativeAssets } from './native-assets.mjs';
import { createNativeEngine } from './native-engine.mjs';
import { createNativeSpeechServer } from './native-http.mjs';

// The child cannot survive a killed parent, including on Windows.
process.on('disconnect', () => process.exit(0));
process.on('message', message => { if (message?.type === 'stop') process.exit(0); });
try {
  if (!process.send || !process.env.LEARNLENS_INTERNAL_SPEECH_TOKEN) throw new Error('Start managed speech with npm start, not native-worker directly.');
  const modelPath = await prepareNativeAssets(process.env.LEARNLENS_SPEECH_CACHE, { offline: process.env.LEARNLENS_SPEECH_OFFLINE === '1' });
  // All model downloads end before the engine starts. Inference can never fetch
  // a missing model, voice or phonemizer behind the learner's back.
  globalThis.fetch = async () => { throw new Error('Network access is disabled during native speech inference.'); };
  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    let options = args[0]; if (Array.isArray(options)) options = options[0];
    const host = options && typeof options === 'object' ? options.host || options.hostname || 'localhost' : typeof args[1] === 'string' ? args[1] : 'localhost';
    if (!['127.0.0.1', 'localhost', '::1'].includes(host)) throw new Error('External speech-worker networking is disabled.');
    return Reflect.apply(connect, this, args);
  };
  const engine = await createNativeEngine(modelPath, Number(process.env.LEARNLENS_SPEECH_THREADS || 2));
  const warmup = await engine.generate('Welcome to LearnLens.', 'af_heart');
  if (warmup.audio.length < 24000 || !warmup.audio.some(sample => Math.abs(sample) > 0.001)) throw new Error('Native speech warmup produced no audible output.');
  const server = createNativeSpeechServer({ token: process.env.LEARNLENS_INTERNAL_SPEECH_TOKEN, voices: engine.voices, generate: engine.generate });
  server.once('error', () => { console.error('Private speech listener failed.'); process.exit(1); });
  server.listen(0, '127.0.0.1', () => process.send({ type: 'ready', port: server.address().port, voices: engine.voices }));
} catch (error) { console.error(`Built-in speech startup failed: ${error.message}`); process.exit(1); }
