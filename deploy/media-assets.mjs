// Application-local, pinned upstream tools. Never search PATH for FFmpeg or use "latest".
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, lstat, readFile, writeFile, rename, rm, chmod } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import childProcess from 'node:child_process';
import yauzl from 'yauzl';

export class MediaImportError extends Error {
  constructor(message) { super(message); this.name = 'MediaImportError'; }
}

const RELEASE = 'autobuild-2026-10-30-13-01';
const BASE = `https://github.com/BtbN/FFmpeg-Builds/releases/download/${RELEASE}/`;
const DEFAULT_CACHE = fileURLToPath(new URL('../.cache/media/', import.meta.url));
const PINS = Object.freeze({
  win32: Object.freeze({ file: 'ffmpeg-n8.1.3-27-g8dca1586f4-win64-lgpl-8.1.zip', size: 167778749, sha256: 'bf346925ea085c262d15a5ceacd521ccbde52f4e3fc6a97f1bf273685fc1a539' }),
  linux: Object.freeze({ file: 'ffmpeg-n8.1.3-27-g8dca1586f4-linux64-lgpl-8.1.tar.xz', size: 135182360, sha256: '223c160e95ecf4e204c81f6e69649b6380b2609514f31773a38d9be4a70231b1' }),
});
const flights = new Map();
const abortError = () => new DOMException('Media operation cancelled.', 'AbortError');
function checkAbort(signal) { if (signal?.aborted) throw abortError(); }

// Allowlist, not a copy of process.env: no credentials, NODE_OPTIONS, LD_PRELOAD,
// FFREPORT, proxy configuration, or dynamic loader search paths reach children.
export function mediaChildEnvironment(source = process.env, platform = process.platform) {
  const env = { LANG: 'C', LC_ALL: 'C', OMP_NUM_THREADS: '2' };
  if (platform === 'win32') {
    const root = source.SystemRoot || source.SYSTEMROOT || 'C:\\Windows';
    env.SystemRoot = root;
    env.WINDIR = root;
    env.PATH = `${root}\\System32`;
  } else env.PATH = '/usr/bin:/bin';
  return env;
}
function pinFor(platform = process.platform, arch = process.arch) {
  if (arch !== 'x64' || !PINS[platform]) throw new MediaImportError('Managed media tools support Windows x64 and Linux x64 only. No system FFmpeg installation is used.');
  return PINS[platform];
}
function rootName(pin) { return pin.file.replace(/\.(zip|tar\.xz)$/, ''); }
function binaryNames(platform) { return platform === 'win32' ? ['ffmpeg.exe', 'ffprobe.exe'] : ['ffmpeg', 'ffprobe']; }
function safeMember(name) {
  return typeof name === 'string' && name.length < 300 && !/[\\:\x00-\x1f\x7f]/.test(name) && !name.startsWith('/') && name.split('/').every(p => p && p !== '.' && p !== '..');
}
function selectedMember(name, pin, platform) {
  const root = `${rootName(pin)}/`;
  if (!safeMember(name) || !name.startsWith(root)) return false;
  const local = name.slice(root.length);
  return binaryNames(platform).some(n => local === `bin/${n}`) || /^(LICENSE|COPYING|NOTICE|README)(\.[A-Za-z0-9_-]+)?$/i.test(local) || /^(doc\/licenses|licenses)\/[A-Za-z0-9_.\/-]+$/i.test(local);
}
async function checksum(file, signal) {
  checkAbort(signal);
  const info = await lstat(file);
  if (!info.isFile()) throw new MediaImportError('Media cache contains a non-regular file.');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file, { signal })) { checkAbort(signal); hash.update(chunk); }
  return { size: info.size, sha256: hash.digest('hex') };
}
async function matches(file, expected, signal) {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.size !== expected.size) return false;
    const actual = await checksum(file, signal);
    return actual.sha256 === expected.sha256;
  } catch (error) { checkAbort(signal); if (error.code === 'ENOENT') return false; throw error; }
}
async function validCache(directory, pin, platform, signal) {
  try {
    if (!(await lstat(directory)).isDirectory()) return false;
    const manifestPath = join(directory, 'manifest.json');
    const ms = await lstat(manifestPath);
    if (!ms.isFile() || ms.size > 65536) return false;
    const m = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (m.version !== 1 || m.release !== RELEASE || m.archive?.sha256 !== pin.sha256 || m.archive?.size !== pin.size || m.archive?.file !== pin.file || !Array.isArray(m.files) || m.files.length > 200) return false;
    const names = new Set(m.files.map(f => f.path));
    if (names.size !== m.files.length || !binaryNames(platform).every(n => names.has(`${rootName(pin)}/bin/${n}`)) || !names.has(`${rootName(pin)}/LICENSE.txt`)) return false;
    if (!await matches(join(directory, pin.file), pin, signal)) return false;
    for (const f of m.files) {
      if (!selectedMember(f.path, pin, platform) || !Number.isSafeInteger(f.size) || f.size <= 0 || f.size > 256 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(f.sha256)) return false;
      if (!await matches(join(directory, f.path), f, signal)) return false;
    }
    return true;
  } catch { checkAbort(signal); return false; }
}
async function download(pin, target, signal) {
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(600000)]);
  let url = BASE + pin.file;
  let response;
  try {
    for (let redirects = 0; redirects <= 5; redirects++) {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || !['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(parsed.hostname)) throw new MediaImportError('Media download redirect was not an approved upstream host.');
      response = await fetch(url, { signal: bounded, redirect: 'manual', headers: { 'Accept-Encoding': 'identity' } });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location || redirects === 5) throw new MediaImportError('Media download exceeded the redirect limit.');
        url = new URL(location, url).href;
      } else break;
    }
    if (!response.ok || !response.body) { await response.body?.cancel(); throw new MediaImportError('Pinned upstream media release is unavailable. Retry online; no alternate release or checksum will be substituted.'); }
    const length = response.headers.get('content-length');
    if (length !== null && Number(length) !== pin.size) { await response.body.cancel(); throw new MediaImportError('Media archive size verification failed.'); }
    const hash = createHash('sha256'); let size = 0;
    const verify = new Transform({ transform(chunk, encoding, callback) {
      size += chunk.length;
      if (size > pin.size) return callback(new MediaImportError('Media archive exceeded its pinned size.'));
      hash.update(chunk); callback(null, chunk);
    } });
    await pipeline(response.body, verify, createWriteStream(target, { flags: 'wx', mode: 0o600 }), { signal: bounded });
    if (size !== pin.size || hash.digest('hex') !== pin.sha256) throw new MediaImportError('Media archive checksum verification failed. No alternate checksum will be accepted.');
  } catch (error) {
    checkAbort(signal);
    if (bounded.aborted) throw new MediaImportError('Media tools download timed out. Retry while online.');
    throw error;
  }
}
async function extractZip(archive, directory, pin, signal) {
  const zip = await yauzl.openPromise(archive, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true });
  const files = [], seen = new Set(); let expanded = 0;
  try {
    if (zip.entryCount > 5000) throw new MediaImportError('Media archive contains too many entries.');
    await new Promise((resolvePromise, reject) => {
      const abort = () => { zip.close(); reject(abortError()); };
      signal.addEventListener('abort', abort, { once: true });
      const fail = error => { signal.removeEventListener('abort', abort); zip.close(); reject(error); };
      zip.on('error', fail);
      zip.on('end', () => { signal.removeEventListener('abort', abort); resolvePromise(); });
      zip.on('entry', entry => {
        (async () => {
          checkAbort(signal);
          const name = entry.fileName;
          if (!safeMember(name.replace(/\/$/, ''))) throw new MediaImportError('Media archive contains an unsafe path.');
          if (selectedMember(name, pin, 'win32')) {
            const type = (entry.externalFileAttributes >>> 16) & 0o170000;
            if ((type && type !== 0o100000) || (entry.generalPurposeBitFlag & 1) || seen.has(name.toLowerCase())) throw new MediaImportError('Media archive contains an unsupported entry.');
            seen.add(name.toLowerCase());
            expanded += entry.uncompressedSize;
            if (entry.uncompressedSize > 256 * 1024 * 1024 || expanded > 600 * 1024 * 1024 || files.length >= 200) throw new MediaImportError('Media archive extraction limit exceeded.');
            const target = join(directory, name);
            await mkdir(dirname(target), { recursive: true, mode: 0o700 });
            const stream = await zip.openReadStreamPromise(entry);
            let bytes = 0;
            const limit = new Transform({ transform(chunk, encoding, cb) {
              bytes += chunk.length;
              cb(bytes > entry.uncompressedSize ? new MediaImportError('Media archive entry exceeded its size.') : null, chunk);
            } });
            await pipeline(stream, limit, createWriteStream(target, { flags: 'wx', mode: 0o600 }), { signal });
            if (bytes !== entry.uncompressedSize) throw new MediaImportError('Media archive entry size mismatch.');
            files.push(name);
          }
          zip.readEntry();
        })().catch(fail);
      });
      if (signal.aborted) abort(); else zip.readEntry();
    });
  } finally { zip.close(); }
  return files;
}
async function extractTar(archive, directory, pin, signal) {
  // Hash-verified upstream archive only; no wildcards, archive-supplied command,
  // directory recursion, or user-selected members are passed to system tar.
  const root = rootName(pin);
  const files = [`${root}/bin/ffmpeg`, `${root}/bin/ffprobe`, `${root}/LICENSE.txt`];
  checkAbort(signal);
  await new Promise((resolvePromise, reject) => {
    let failure, bytes = 0;
    const child = childProcess.spawn('/usr/bin/tar', ['--extract', '--xz', '--no-same-owner', '--no-same-permissions', '--no-recursion', '--file', archive, '--directory', directory, '--', ...files], { shell: false, windowsHide: true, env: mediaChildEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] });
    const stop = error => { failure ||= error; child.kill('SIGKILL'); };
    const abort = () => stop(abortError());
    const timer = setTimeout(() => stop(new MediaImportError('Media tools extraction timed out.')), 120000);
    signal.addEventListener('abort', abort, { once: true });
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); };
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { bytes += chunk.length; if (bytes > 1024 * 1024) stop(new MediaImportError('Media tools extraction output limit exceeded.')); });
    child.on('error', () => { cleanup(); reject(new MediaImportError('System tar with xz support is required to unpack managed media tools.')); });
    child.on('close', code => { cleanup(); failure ? reject(failure) : code === 0 ? resolvePromise() : reject(new MediaImportError('Could not unpack the pinned media tools with system tar.')); });
    if (signal.aborted) abort();
  });
  return files;
}
async function install(directory, pin, platform, signal, offline) {
  if (await validCache(directory, pin, platform, signal)) return;
  if (offline) throw new MediaImportError('Managed media cache is missing or damaged. Disable LEARNLENS_MEDIA_OFFLINE and prepare media tools online before importing media.');
  await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
  const staging = `${directory}.${randomUUID()}.partial`;
  await mkdir(staging, { mode: 0o700 });
  try {
    await download(pin, join(staging, pin.file), signal);
    const files = platform === 'win32'
      ? await extractZip(join(staging, pin.file), staging, pin, signal)
      : await extractTar(join(staging, pin.file), staging, pin, signal);
    const required = [...binaryNames(platform).map(n => `${rootName(pin)}/bin/${n}`), `${rootName(pin)}/LICENSE.txt`];
    if (!required.every(n => files.includes(n))) throw new MediaImportError('Pinned media archive is missing required executables or license notices.');
    const records = [];
    for (const path of files) records.push({ path, ...await checksum(join(staging, path), signal) });
    if (platform === 'linux') for (const path of required.slice(0, 2)) await chmod(join(staging, path), 0o700);
    await writeFile(join(staging, 'manifest.json'), JSON.stringify({ version: 1, release: RELEASE, archive: pin, files: records, provenance: {
      download: BASE + pin.file,
      buildProject: 'https://github.com/BtbN/FFmpeg-Builds',
      release: `https://github.com/BtbN/FFmpeg-Builds/releases/tag/${RELEASE}`,
      ffmpegSource: 'https://github.com/FFmpeg/FFmpeg/tree/8dca1586f4',
      notices: 'Original upstream archive retained intact, including all bundled license notices and source references.',
      retention: 'Upstream-only distribution; releases may be removed. No binary or corresponding-source mirror is provided. Preserve this verified cache; unavailable pins fail closed.',
    } }, null, 2), { mode: 0o600, flag: 'wx' });
    checkAbort(signal);
    // Another process may have completed the identical immutable installation.
    if (await validCache(directory, pin, platform, signal)) return;
    await rm(directory, { recursive: true, force: true });
    await rename(staging, directory);
  } finally { await rm(staging, { recursive: true, force: true }); }
}

export async function ensureMediaTools({ signal, offline = false, cacheDir = DEFAULT_CACHE } = {}) {
  checkAbort(signal);
  const platform = process.platform, pin = pinFor();
  offline = Boolean(offline || process.env.LEARNLENS_MEDIA_OFFLINE === '1');
  const directory = join(resolve(cacheDir), `${RELEASE}-${platform}-x64`);
  // Offline callers never join a downloading flight. Subscribers cancel independently;
  // the shared operation is aborted only when its last subscriber leaves.
  const key = `${directory}:${offline}`;
  let flight = flights.get(key);
  if (!flight) {
    const controller = new AbortController();
    flight = { controller, users: 0 };
    flight.promise = install(directory, pin, platform, controller.signal, offline).then(() => {
      const [ffmpeg, ffprobe] = binaryNames(platform).map(n => join(directory, rootName(pin), 'bin', n));
      return { ffmpeg, ffprobe };
    }).finally(() => { if (flights.get(key) === flight) flights.delete(key); });
    flights.set(key, flight);
  }
  flight.users++;
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      if (--flight.users === 0) {
        flight.controller.abort();
        if (flights.get(key) === flight) flights.delete(key);
      }
      error ? reject(error) : resolvePromise(value);
    };
    const abort = () => finish(abortError());
    signal?.addEventListener('abort', abort, { once: true });
    flight.promise.then(value => finish(null, value), error => finish(error));
    if (signal?.aborted) abort();
  });
}

export const __testing = Object.freeze({ pinFor, PINS, RELEASE, selectedMember, safeMember, validCache, download, extractZip, extractTar });
