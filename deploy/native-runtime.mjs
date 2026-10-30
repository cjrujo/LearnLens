import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
export const projectRoot = fileURLToPath(new URL('../', import.meta.url));

export function nativeSpeechEnvironment(base, token) {
  const env = Object.fromEntries(['PATH', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'LOCALAPPDATA'].filter(key => base[key] !== undefined).map(key => [key, base[key]]));
  const threads = Number(base.LEARNLENS_SPEECH_THREADS || 2);
  if (!Number.isInteger(threads) || threads < 1 || threads > 8) throw new Error('LEARNLENS_SPEECH_THREADS must be 1–8.');
  return { ...env,
    LEARNLENS_INTERNAL_SPEECH_TOKEN: token,
    LEARNLENS_SPEECH_CACHE: resolve(projectRoot, base.LEARNLENS_SPEECH_CACHE || '.cache/speech'),
    LEARNLENS_SPEECH_OFFLINE: base.LEARNLENS_SPEECH_OFFLINE === '1' ? '1' : '0',
    LEARNLENS_SPEECH_THREADS: String(threads),
    DO_NOT_TRACK: '1', HF_HUB_DISABLE_TELEMETRY: '1',
  };
}

export function launchNativeSpeech({ env = process.env, workerFile = new URL('./native-worker.mjs', import.meta.url), execArgv = [], timeoutMs = 600000 } = {}) {
  const token = randomBytes(32).toString('hex');
  const workerEnv = nativeSpeechEnvironment(env, token);
  const child = spawn(process.execPath, [...execArgv, fileURLToPath(workerFile)], { cwd: projectRoot, env: workerEnv, stdio: ['ignore', 'inherit', 'inherit', 'ipc'], windowsHide: true });
  let ready = false, stopped = false, exited = false, timeout, resolveReady, rejectReady;
  const readyPromise = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  readyPromise.catch(() => {}); // Startup cancellation may precede the caller's waitReady().
  const closed = new Promise(resolve => {
    child.once('error', () => { exited = true; clearTimeout(timeout); rejectReady(new Error('Native speech process could not start.')); resolve(); });
    child.once('exit', () => { exited = true; clearTimeout(timeout); if (!ready) rejectReady(new Error('Native speech stopped before becoming ready. See the startup message above.')); resolve(); });
  });
  child.on('message', message => {
    if (stopped || ready || message?.type !== 'ready') return;
    if (!Number.isInteger(message.port) || message.port < 1 || message.port > 65535) return;
    ready = true; clearTimeout(timeout);
    resolveReady({ baseUrl: `http://127.0.0.1:${message.port}/v1`, apiKey: token, voices: message.voices || [] });
  });
  timeout = setTimeout(() => { rejectReady(new Error('Native speech startup timed out. Check downloads or run npm run setup:speech before restarting.')); void stop(); }, timeoutMs);
  async function stop() {
    if (exited) return;
    stopped = true; clearTimeout(timeout);
    if (child.connected) child.send({ type: 'stop' }, () => {});
    const force = setTimeout(() => { if (!exited) child.kill('SIGKILL'); }, 5000);
    await closed; clearTimeout(force);
  }
  return { child, waitReady: () => readyPromise, stop };
}
