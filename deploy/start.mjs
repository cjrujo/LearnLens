// Container entrypoint: owns both processes and fails closed if either exits.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { launchKokoro } from './kokoro-runtime.mjs';
let worker, web, stopping = false;
async function shutdown(code) {
  if (stopping) return;
  stopping = true;
  if (web && web.exitCode === null && web.signalCode === null) {
    const closed = new Promise(resolve => web.once('exit', resolve));
    web.kill('SIGTERM');
    const timeout = setTimeout(() => web.kill('SIGKILL'), 5000);
    await closed; clearTimeout(timeout);
  }
  await worker?.stop();
  process.exit(code);
}
process.once('SIGTERM', () => shutdown(0));
process.once('SIGINT', () => shutdown(0));
try {
  const env = { ...process.env };
  // External/disabled modes are advanced operator choices, never learner setup.
  if (env.LEARNLENS_SPEECH_MODE === 'disabled') { delete env.KOKORO_BASE_URL; delete env.KOKORO_BUILTIN; }
  else if (!env.KOKORO_BASE_URL) {
    console.log('Starting included Kokoro speech on private loopback…');
    worker = launchKokoro();
    worker.child.once('exit', () => { if (!stopping) { console.error('Built-in speech stopped; restarting the app is required.'); shutdown(1); } });
    await worker.waitReady();
    env.KOKORO_BASE_URL = 'http://127.0.0.1:8880/v1'; env.KOKORO_BUILTIN = '1';
    env.KOKORO_MODEL = 'kokoro'; env.KOKORO_VOICE ||= 'af_heart'; delete env.KOKORO_API_KEY;
    console.log('Included speech is ready. Starting LearnLens…');
  }
  if (!stopping) {
    web = spawn(process.execPath, [fileURLToPath(new URL('../server.mjs', import.meta.url))], { env, stdio: 'inherit' });
    web.once('error', () => { console.error('LearnLens process could not start.'); web = null; shutdown(1); });
    web.once('exit', code => { if (!stopping) shutdown(code || 1); });
  }
} catch (error) { console.error(error.message); await shutdown(1); }
