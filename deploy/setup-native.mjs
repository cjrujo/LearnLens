import { loadProjectEnv } from './native-start.mjs';
import { launchNativeSpeech } from './native-runtime.mjs';
loadProjectEnv();
const worker = launchNativeSpeech();
process.once('SIGINT', () => { void worker.stop(); });
process.once('SIGTERM', () => { void worker.stop(); });
try {
  await worker.waitReady();
  console.log('Native Kokoro assets verified and real English synthesis passed. Ready for offline speech startup.');
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { await worker.stop(); }
