// Reviewed official pins; NEVER discover latest, install globally, or run an
// executable before verifying it. Standalone yt-dlp bundles Python + EJS 0.8.0.
// Distribution must carry GPLv3+ standalone / EJS dependency license notices.
import fs from 'node:fs';
import { mkdir, lstat, open, chmod, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve, isAbsolute, parse } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import yauzl from 'yauzl';
import { downloadSourceFile } from '../lib/source-fetch.mjs';
import { AppError } from '../lib/provider.mjs';

export const YTDLP_VERSION = '2026.10.26';
export const DENO_VERSION = '2.9.8';
const official = (repo, version, name) => `https://github.com/${repo}/releases/download/${version}/${name}`;
export const YOUTUBE_ASSETS = Object.freeze({
  win32: Object.freeze({
    ytdlp: Object.freeze({ name: 'yt-dlp.exe', size: 23575744, sha256: 'f5389d3698ecde4ef06f4e6b1ce0294fe9ac1396228c8990b8d3416d6d177a7d', url: official('yt-dlp/yt-dlp', YTDLP_VERSION, 'yt-dlp.exe') }),
    deno: Object.freeze({ name: 'deno-x86_64-pc-windows-msvc.zip', executable: 'deno.exe', size: 42917472, sha256: 'cba84b26e0df5ae7f74fc66b86a95b866872a86292ebd84fa1e959927edd93bf', url: official('denoland/deno', `v${DENO_VERSION}`, 'deno-x86_64-pc-windows-msvc.zip') }),
  }),
  linux: Object.freeze({
    ytdlp: Object.freeze({ name: 'yt-dlp_linux', size: 41166968, sha256: '767ba9dce7052aa196f8b12652f433d76de128ba168966fa84b6394d5e6c6795', url: official('yt-dlp/yt-dlp', YTDLP_VERSION, 'yt-dlp_linux') }),
    deno: Object.freeze({ name: 'deno-x86_64-unknown-linux-gnu.zip', executable: 'deno', size: 41963064, sha256: 'e890975bc2549807bbcc0b584ffafda72cc7c93349dd99c80483dd784f6c4609', url: official('denoland/deno', `v${DENO_VERSION}`, 'deno-x86_64-unknown-linux-gnu.zip') }),
  }),
});
const defaultRoot = fileURLToPath(new URL('../.cache/youtube/', import.meta.url));
const unavailable = () => new AppError('Verified YouTube helper assets are unavailable. Upload the video instead.', 503);
function check(signal) { if (signal?.aborted) throw new AppError('YouTube asset preparation was cancelled.', 499); }

export async function verifyYouTubeAsset(file, asset) {
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== asset.size) return false;
    const hash = createHash('sha256');
    for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
    return hash.digest('hex') === asset.sha256;
  } catch (error) { if (error.code === 'ENOENT') return false; throw unavailable(); }
}

async function privateDirectory(directory) {
  // Reject symlink/junction ancestors, including an existing cache root. Cache
  // paths are application-chosen; no user/global home or installation is used.
  const absolute = resolve(directory), root = parse(absolute).root;
  let current = root;
  for (const component of absolute.slice(root.length).split(/[\\/]/).filter(Boolean)) {
    current = join(current, component);
    try { await mkdir(current, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw unavailable();
  }
}

/** Extract precisely ONE root-level executable from an already SHA-verified
 * ZIP. No shell/unzip, symlinks, path traversal, alternate streams, extra files,
 * encrypted entries or unbounded inflation. The output is exclusive and 0700.
 */
export async function extractDenoArchive(archive, destination, executable, { signal } = {}) {
  if (!['deno', 'deno.exe'].includes(executable)) throw unavailable();
  check(signal);
  const zip = await new Promise((accept, reject) => yauzl.open(archive,
    { lazyEntries: true, autoClose: false, strictFileNames: true, validateEntrySizes: true },
    (error, value) => error ? reject(unavailable()) : accept(value)));
  let output, created = false, input, written = 0, zipError;
  const hash = createHash('sha256');
  // Observe errors for the complete ZIP lifetime. Do not race file opens/writes
  // against abort: every writer is awaited before cleanup may remove its file.
  zip.on('error', () => { zipError = unavailable(); input?.destroy(zipError); });
  const abort = () => input?.destroy(unavailable());
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const entry = await new Promise((accept, reject) => {
      let selected;
      zip.on('error', () => reject(unavailable()));
      zip.on('end', () => selected ? accept(selected) : reject(unavailable()));
      zip.on('entry', item => {
        const mode = (item.externalFileAttributes >>> 16) & 0xf000;
        if (selected || item.fileName !== executable || item.generalPurposeBitFlag & 1 ||
          ![0, 0x8000].includes(mode) || ![0, 8].includes(item.compressionMethod) ||
          !Number.isSafeInteger(item.uncompressedSize) || item.uncompressedSize < 1 || item.uncompressedSize > 200 * 1024 * 1024) {
          reject(unavailable()); return;
        }
        selected = item; zip.readEntry();
      });
      zip.readEntry();
    });
    check(signal); if (zipError) throw zipError;
    input = await new Promise((yes, no) => zip.openReadStream(entry, (err, stream) => err ? no(unavailable()) : yes(stream)));
    input.on('error', () => {});
    check(signal);
    output = await open(destination, 'wx', 0o700); created = true;
    check(signal);
    for await (const chunk of input) {
      check(signal); if (zipError) throw zipError;
      written += chunk.length;
      if (written > entry.uncompressedSize) throw unavailable();
      hash.update(chunk); await output.writeFile(chunk);
    }
    if (written !== entry.uncompressedSize || zipError) throw unavailable();
    await output.close(); output = null;
    check(signal);
    return { size: written, sha256: hash.digest('hex') };
  } catch { if (output) { await output.close(); output = null; } if (created) await rm(destination, { force: true }); throw unavailable(); }
  finally { signal?.removeEventListener('abort', abort); input?.destroy(); zip.close(); }
}

const inFlight = new Map();
/** Trusted deployment/test factory. It is NOT populated by URL/HTTP input.
 * Imports default to offline verification; online installation is an explicit
 * packaging action. Even official assets obey the existing public-IP guard.
 */
export function createYouTubeAssetLoader({ download = downloadSourceFile, manifests = YOUTUBE_ASSETS,
  platform = process.platform, arch = process.arch } = {}) {
  return async function prepare({ cacheRoot = defaultRoot, offline = true, signal } = {}) {
    if (!isAbsolute(cacheRoot) || arch !== 'x64' || !manifests[platform]) throw unavailable();
    if (platform === 'linux' && process.platform === 'linux' && !process.report.getReport().header.glibcVersionRuntime) throw unavailable();
    check(signal);
    const directory = join(cacheRoot, `yt-${YTDLP_VERSION}-deno-${DENO_VERSION}-${platform}-${arch}`);
    // No concurrent extraction/replacement in this process. Waiters retain their
    // own cancellation checks; each installer owns its own temporary files.
    while (inFlight.has(directory)) {
      const prior = inFlight.get(directory);
      await prior.catch(() => {}); check(signal);
      // The owner removes its completed slot in finally before another waiter
      // can claim it. Recheck in case a preceding waiter claimed a new slot.
      if (inFlight.get(directory) === prior) inFlight.delete(directory);
    }
    const work = (async () => {
      const pins = manifests[platform];
      await privateDirectory(directory); check(signal);
      async function asset(pin) {
        const file = join(directory, pin.name);
        if (await verifyYouTubeAsset(file, pin)) { check(signal); return file; }
        if (offline) throw unavailable();
        const temporary = join(directory, `${randomUUID()}.partial`);
        try {
          await download(pin.url, temporary, { signal, maxBytes: pin.size, timeoutMs: 480_000,
            allowUrl: url => url.href === pin.url ||
              (url.protocol === 'https:' && !url.username && !url.password && !url.port &&
                ['release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(url.hostname)),
            limitForHeaders: ({ contentLength }) => {
              if (contentLength !== null && contentLength !== pin.size) throw unavailable();
              return pin.size;
            },
          });
          check(signal);
          if (!await verifyYouTubeAsset(temporary, pin)) throw unavailable();
          await rename(temporary, file);
          return file;
        } finally { await rm(temporary, { force: true }); }
      }
      const ytdlp = await asset(pins.ytdlp), archive = await asset(pins.deno);
      const deno = join(directory, pins.deno.executable), temporary = join(directory, `${randomUUID()}.extracted`);
      try {
        const expected = await extractDenoArchive(archive, temporary, pins.deno.executable, { signal });
        check(signal);
        // Derive extracted integrity from the verified official ZIP every time;
        // never trust a mutable adjacent checksum/manifest for executable reuse.
        if (!await verifyYouTubeAsset(deno, expected)) await rename(temporary, deno);
        await chmod(ytdlp, 0o700); await chmod(deno, 0o700);
        check(signal);
        return Object.freeze({ ytdlp, deno, ytdlpVersion: YTDLP_VERSION, denoVersion: DENO_VERSION });
      } finally { await rm(temporary, { force: true }); }
    })();
    inFlight.set(directory, work);
    try { return await work; } catch { throw unavailable(); }
    finally { if (inFlight.get(directory) === work) inFlight.delete(directory); }
  };
}
export const prepareYouTubeAssets = createYouTubeAssetLoader();
