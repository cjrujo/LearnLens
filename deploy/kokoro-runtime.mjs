import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

// Do not pass workspace passwords or provider credentials to the speech process.
export function speechEnvironment(base = process.env, offline = true) {
  const inherited = Object.fromEntries(['PATH', 'HOME', 'LANG', 'LC_ALL', 'LD_LIBRARY_PATH', 'SYSTEMROOT', 'TEMP', 'TMP'].filter(key => base[key] !== undefined).map(key => [key, base[key]]));
  return {
    ...inherited, PYTHONUNBUFFERED: '1', PYTHONPATH: '/app:/app/api',
    HOST: '127.0.0.1', PORT: '8880', USE_GPU: 'false', DEVICE: 'cpu',
    PHONEMIZER_ESPEAK_PATH: '/usr/bin', PHONEMIZER_ESPEAK_DATA: '/usr/share/espeak-ng-data', ESPEAK_DATA_PATH: '/usr/share/espeak-ng-data',
    API_LOG_LEVEL: 'WARNING', ENABLE_WEB_PLAYER: 'false', CORS_ENABLED: 'false',
    ENABLE_DEBUG_ENDPOINTS: 'false', ENABLE_INNO_TUNER: 'false', ALLOW_DEV_UNLOAD: 'false', ENABLE_VOICE_TAGS: 'false', ENABLE_SSML: 'false',
    MAX_INPUT_LENGTH: '2000', OMP_NUM_THREADS: '2', MKL_NUM_THREADS: '2',
    HF_HUB_DISABLE_TELEMETRY: '1', DO_NOT_TRACK: '1',
    ...(offline ? { HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' } : {}),
  };
}

export function launchService({ command, args = [], cwd, env, readyUrl, timeoutMs = 180000, intervalMs = 250, stdio = 'inherit' }) {
  const child = spawn(command, args, { cwd, env, stdio });
  let failure = null, exited = false, stopping = false;
  const closed = new Promise(resolve => {
    child.once('error', error => { failure = new Error(`Speech process could not start (${error.code || 'unknown error'}).`); exited = true; resolve(); });
    child.once('exit', (code, signal) => { exited = true; failure ||= new Error(`Speech process exited (${signal || code}).`); resolve(); });
  });
  async function waitReady() {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (failure || stopping) throw failure || new Error('Speech startup was cancelled.');
      try {
        const response = await fetch(readyUrl, { signal: AbortSignal.timeout(Math.min(2000, Math.max(1, deadline - Date.now()))) });
        if (response.ok) {
          const data = await response.json();
          if (data.status === 'healthy' && !failure && !stopping) return;
        } else await response.body?.cancel();
      } catch { /* startup may still be loading assets */ }
      await delay(intervalMs);
    }
    throw new Error('Built-in speech did not become ready before the startup deadline.');
  }
  async function stop() {
    if (exited) return;
    stopping = true; child.kill('SIGTERM');
    let timer;
    await Promise.race([closed, new Promise(resolve => { timer = setTimeout(() => { if (!exited) child.kill('SIGKILL'); resolve(); }, 5000); })]);
    clearTimeout(timer); await closed;
  }
  return { child, waitReady, stop };
}

export function launchKokoro({ offline = true, timeoutMs } = {}) {
  return launchService({ command: '/app/.venv/bin/python', args: ['-m', 'uvicorn', 'api.src.main:app', '--host', '127.0.0.1', '--port', '8880', '--log-level', 'warning', '--no-access-log'], cwd: '/app', env: speechEnvironment(process.env, offline), readyUrl: 'http://127.0.0.1:8880/health', timeoutMs });
}
