// Default cross-platform entrypoint. No Docker, Python or administrator install.
import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApp, deploymentConfig } from '../server.mjs';
import { launchNativeSpeech, projectRoot } from './native-runtime.mjs';

export function loadProjectEnv() {
  try { loadEnvFile(resolve(projectRoot, '.env')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

export async function startNativeApplication({ env = process.env, signal, launchSpeech = launchNativeSpeech, onFailure = () => {} } = {}) {
  const config = deploymentConfig(env); // Reject unsafe hosting before any model download.
  const mode = env.LEARNLENS_SPEECH_MODE || 'native';
  if (!['native', 'disabled'].includes(mode)) throw new Error('LEARNLENS_SPEECH_MODE must be native or disabled.');
  let worker, server, stopping = false, failure = null, stopPromise;
  const stop = () => {
    if (stopPromise) return stopPromise;
    stopping = true;
    stopPromise = (async () => {
      if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
      await worker?.stop();
    })();
    return stopPromise;
  };
  const abort = () => { void stop(); };
  signal?.throwIfAborted(); signal?.addEventListener('abort', abort, { once: true });
  try {
    config.options.kokoroBuiltin = false;
    if (mode === 'disabled') { config.options.kokoroBaseUrl = undefined; config.options.kokoroApiKey = undefined; }
    else if (!config.options.kokoroBaseUrl) {
      console.log('Starting native Kokoro. First startup prepares project-local model assets; later starts reuse them.');
      worker = launchSpeech({ env });
      worker.child.once('exit', () => {
        if (stopping) return;
        failure = new Error('Built-in speech stopped. Restart LearnLens to recover.');
        void stop().then(() => onFailure(failure));
      });
      const speech = await worker.waitReady();
      if (failure) throw failure;
      if (!speech.voices.includes(config.options.kokoroVoice || 'af_heart')) throw new Error('KOKORO_VOICE must be an installed native English voice, such as af_heart or bf_emma.');
      Object.assign(config.options, { kokoroBaseUrl: speech.baseUrl, kokoroApiKey: speech.apiKey, kokoroBuiltin: true, kokoroModel: 'kokoro', kokoroFormat: 'wav', kokoroLanguages: ['en'], kokoroVoices: speech.voices });
    }
    signal?.throwIfAborted();
    if (stopping || failure) throw failure || new Error('Startup cancelled.');
    ({ server } = createApp(config.options));
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.port, config.host, () => { server.removeListener('error', reject); resolve(); });
    });
    if (stopping || failure) throw failure || new Error('Startup cancelled.');
    const origin = config.options.publicOrigin || `http://${config.host === '::1' ? '[::1]' : config.host}:${server.address().port}`;
    console.log(`LearnLens ready at ${origin}\n${worker ? 'Built-in Kokoro is ready (native CPU, English, WAV). ' : ''}Press Ctrl+C to stop.`);
    return { server, worker, origin, stop: async () => { signal?.removeEventListener('abort', abort); await stop(); } };
  } catch (error) { signal?.removeEventListener('abort', abort); await stop(); throw error; }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const abort = new AbortController();
  let app;
  const shutdown = async () => { abort.abort(); await app?.stop(); };
  process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
  try {
    loadProjectEnv();
    app = await startNativeApplication({ signal: abort.signal, onFailure: error => { console.error(error.message); process.exitCode = 1; } });
  } catch (error) { if (!abort.signal.aborted) { console.error(error.message); process.exitCode = 1; } }
}
