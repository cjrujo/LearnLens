import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { AppError } from '../lib/provider.mjs';

export const HELPER_OUTPUT_LIMIT = 4 * 1024 * 1024;
export const DENO_PROVIDER_ARGS = Object.freeze(['run', '--ext=js', '--no-code-cache', '--no-prompt', '--no-remote',
  '--no-lock', '--node-modules-dir=none', '--no-config', '--no-npm', '--cached-only', '-']);
const wrapper = fileURLToPath(new URL('./windows-job-wrapper.ps1', import.meta.url));
const error = (message, status = 502) => new AppError(message, status);
const failed = () => error('YouTube helper failed. No credentials or external fallback were used.');
const activeGroups = new Set();
process.once('exit', () => {
  for (const pid of activeGroups) { try { process.kill(-pid, 'SIGKILL'); } catch { /* Already gone. */ } }
});

/** Fresh allowlist, NOT a copy of process.env. Explicit proxies also defeat the
 * inspected CPython Windows registry-bypass fallback. Proxy nonce is job-local.
 * DENO_PERMISSION_BROKER_PATH, NODE_OPTIONS, loader/cert overrides, auth and all
 * user package/config/runtime settings are intentionally absent.
 */
export function youtubeChildEnvironment(directory, proxyUrl, { platform = process.platform } = {}) {
  if (!isAbsolute(directory) || directory.includes('\0')) throw failed();
  const env = {
    HOME: directory, USERPROFILE: directory, APPDATA: directory, LOCALAPPDATA: directory,
    XDG_CONFIG_HOME: directory, XDG_CACHE_HOME: directory, XDG_DATA_HOME: directory,
    TMPDIR: directory, TMP: directory, TEMP: directory,
    DENO_DIR: join(directory, 'deno-cache'), DENO_NO_UPDATE_CHECK: '1', DENO_NO_PACKAGE_JSON: '1',
    DENO_NO_PROMPT: '1', NO_COLOR: '1', YTDLP_NO_PLUGINS: '1',
    PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1', PYTHONUTF8: '1',
    LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8',
    // Empty PATH prevents opportunistic discovery of ffmpeg/Node/executables.
    PATH: '', HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, ALL_PROXY: proxyUrl, NO_PROXY: '',
  };
  if (platform === 'win32') {
    // Runtime system location is an OS necessity, not an executable search path.
    const root = process.env.SystemRoot || 'C:\\Windows';
    if (!/^[a-z]:[\\/][^\0\r\n]*$/i.test(root)) throw failed();
    env.SystemRoot = root; env.WINDIR = root;
  } else {
    env.http_proxy = proxyUrl; env.https_proxy = proxyUrl; env.all_proxy = proxyUrl; env.no_proxy = '';
  }
  return env;
}

// Managed caches are permission-free in Deno. This sampled storage ceiling is
// not a hard disk quota; job memory is also capped by the Windows Job Object.
// Each scan is bounded in entries and never follows symlinks.
function checkStorage(root, limit) {
  let size = 0, entries = 0;
  const walk = directory => {
    let listing;
    try { listing = fs.opendirSync(directory); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    try {
      let entry;
      while ((entry = listing.readSync())) {
        if (++entries > 2048) throw failed();
        const path = join(directory, entry.name);
        let stat;
        try { stat = fs.lstatSync(path); }
        catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw failed();
        size += stat.size;
        if (size > limit) throw failed();
        if (stat.isDirectory()) walk(path);
      }
    } finally { listing.closeSync(); }
  };
  walk(root);
}

/** Owned, shell-free process tree. On Windows the fixed PowerShell bootstrap
 * uses CreateProcess(SUSPENDED), assigns a no-breakaway kill-on-close Job Object,
 * then resumes; EOF of the parent's control pipe also kills the job. Linux uses
 * a dedicated process group (cooperative descendants, NOT a sandbox/cgroup).
 * All diagnostics are fixed; stderr is counted but never returned or logged.
 */
export async function runOwnedProcess(executable, args, { cwd, env, signal, input = Buffer.alloc(0),
  timeoutMs = 60_000, maxBytes = HELPER_OUTPUT_LIMIT, storageBytes = 256 * 1024 * 1024 } = {}) {
  if (!isAbsolute(executable) || !isAbsolute(cwd || '') || !Array.isArray(args) ||
    args.some(arg => typeof arg !== 'string' || arg.includes('\0')) || !env ||
    !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > HELPER_OUTPUT_LIMIT ||
    !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000 ||
    !Number.isSafeInteger(storageBytes) || storageBytes < 1 || storageBytes > 256 * 1024 * 1024 ||
    (signal !== undefined && !(signal instanceof AbortSignal)) ||
    !['win32', 'linux'].includes(process.platform)) throw failed();
  if (signal?.aborted) throw error('YouTube helper was cancelled.', 499);
  if (!Buffer.isBuffer(input)) input = Buffer.from(input);
  if (input.length > HELPER_OUTPUT_LIMIT) throw failed();
  const owned = [];
  let command = executable, commandArgs = args;
  if (process.platform === 'win32') {
    // Script arguments are only a generated JSON path. Never interpolate user
    // values into PowerShell or invoke cmd.exe/taskkill/a command shell.
    const nonce = randomUUID(), inputFile = join(cwd, `${nonce}.stdin`), specFile = join(cwd, `${nonce}.json`);
    try {
      fs.writeFileSync(inputFile, input, { flag: 'wx', mode: 0o600 }); owned.push(inputFile);
      fs.writeFileSync(specFile, JSON.stringify({ executable, args, cwd, env, inputFile }), { flag: 'wx', mode: 0o600 }); owned.push(specFile);
    } catch { for (const file of owned) fs.rmSync(file, { force: true }); throw failed(); }
    command = join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    commandArgs = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', wrapper, specFile];
  }
  try {
    return await new Promise((resolve, reject) => {
      let child, failure, deadline, escalation, storageTimer, bytes = 0, outputBytes = 0, settled = false;
      const chunks = [];
      function killGroup() {
        if (!child?.pid) return;
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already gone. */ }
      }
      function stop(reason) {
        if (settled) return;
        failure ||= reason;
        if (!child) return;
        if (process.platform === 'win32') {
          // Closing the control pipe requests TerminateJobObject and waits for
          // ActiveProcesses=0; fallback kill closes the job handle in the OS.
          child.stdin.end();
          escalation ||= setTimeout(() => child.kill('SIGKILL'), 1500);
        } else {
          try { process.kill(-child.pid, 'SIGTERM'); } catch { /* Already gone. */ }
          escalation ||= setTimeout(killGroup, 150);
        }
      }
      const abort = () => stop(error('YouTube helper was cancelled.', 499));
      try {
        child = spawn(command, commandArgs, { cwd, env, shell: false, windowsHide: true,
          detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
      } catch { reject(failed()); return; }
      if (process.platform !== 'win32' && child.pid) activeGroups.add(child.pid);
      child.stdin.on('error', () => {});
      if (process.platform !== 'win32') child.stdin.end(input);
      const consume = (chunk, stdout) => {
        if (failure) return;
        if (chunk.length > maxBytes - bytes) { stop(error('YouTube helper exceeded its output limit.', 413)); return; }
        bytes += chunk.length;
        if (stdout) { chunks.push(chunk); outputBytes += chunk.length; }
      };
      child.stdout.on('data', chunk => consume(chunk, true));
      child.stderr.on('data', chunk => consume(chunk, false));
      child.stdout.on('error', () => stop(failed())); child.stderr.on('error', () => stop(failed()));
      child.on('error', () => stop(failed()));
      child.once('exit', () => {
        if (process.platform !== 'win32') killGroup();
        clearTimeout(escalation); activeGroups.delete(child.pid);
      });
      child.once('close', code => {
        settled = true;
        clearTimeout(deadline); clearTimeout(escalation); clearInterval(storageTimer);
        signal?.removeEventListener('abort', abort);
        activeGroups.delete(child.pid);
        if (failure || code !== 0) reject(failure || failed());
        else resolve(Buffer.concat(chunks, outputBytes));
      });
      deadline = setTimeout(() => stop(error('YouTube helper exceeded its deadline.', 504)), timeoutMs);
      storageTimer = setInterval(() => {
        try { checkStorage(cwd, storageBytes); }
        catch { stop(error('YouTube helper exceeded its private storage budget or storage was unavailable.', 413)); }
      }, 500);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
  } finally {
    for (const file of owned) fs.rmSync(file, { force: true });
  }
}
