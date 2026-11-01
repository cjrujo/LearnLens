import fs from 'node:fs';
import { rm } from 'node:fs/promises';
import { join, isAbsolute, resolve } from 'node:path';
import { normalizeSourceUrl, downloadSourceFile } from './source-fetch.mjs';
import { createSourceProxy } from './source-proxy.mjs';
import { prepareYouTubeAssets } from '../deploy/youtube-assets.mjs';
import { runOwnedProcess, youtubeChildEnvironment, HELPER_OUTPUT_LIMIT } from '../deploy/owned-process.mjs';
import { AppError } from './provider.mjs';

const ID = /^[A-Za-z0-9_-]{11}$/;
const safeErrors = new WeakSet();
function safeError(message, status) { const error = new AppError(message, status); safeErrors.add(error); return error; }
const unsupported = () => safeError('YouTube import requires one public, finished video with a supported direct HTTPS audio-and-video format. Playlists, live, DRM, login and separate-stream formats are unsupported. Upload the video instead.', 422);
const failed = () => new AppError('YouTube import failed or public access is unavailable. No captions, audio-only, credentials or external fallback were used. Upload the video instead.', 502);
const cancelled = () => new AppError('YouTube import was cancelled.', 499);
function check(signal) { if (signal?.aborted) throw cancelled(); }

/** Recognize locally; never follow a shortener or feed arbitrary input to an
 * extractor. Benign tracking/time/fragment data is discarded, not executed.
 * Watch-with-playlist is intentionally rejected rather than silently choosing.
 */
export function youtubeVideoUrl(value) {
  const normalized = normalizeSourceUrl(value);
  const url = new URL(normalized), host = url.hostname;
  if (!/(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/.test(host)) return null;
  if (!['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'].includes(host)) throw unsupported();
  const rawPath = /^https:\/\/[^/?#]+([^?#]*)/i.exec(value)?.[1] || '/';
  if (rawPath !== url.pathname) throw unsupported();
  for (const key of url.searchParams.keys()) if (/^(list|index|playlist|start_radio)$/i.test(key)) throw unsupported();
  let id;
  if (host === 'youtu.be') {
    if (url.searchParams.has('v')) throw unsupported();
    id = url.pathname.slice(1);
  } else if (url.pathname === '/watch') {
    if (url.searchParams.getAll('v').length !== 1) throw unsupported();
    id = url.searchParams.get('v');
  } else if (url.pathname.startsWith('/shorts/')) {
    if (url.searchParams.has('v')) throw unsupported();
    id = url.pathname.slice(8);
  } else throw unsupported();
  if (!ID.test(id || '')) throw unsupported();
  return `https://www.youtube.com/watch?v=${id}`;
}

export function youtubeMetadataArguments(url, deno, proxyUrl) {
  // All arguments are constants or application-owned values. No config, auth,
  // plugin, custom args, remote EJS, Node/Bun fallback, downloader or ffmpeg work.
  return [
    '--ignore-config', '--no-config-locations', '--no-plugin-dirs', '--no-remote-components',
    '--no-update', '--no-cache-dir', '--no-cookies', '--no-cookies-from-browser',
    '--use-extractors', '^youtube$', '--default-search', 'error', '--no-playlist',
    '--no-wait-for-video', '--no-live-from-start', '--no-exec', '--fixup', 'never',
    '--no-write-comments', '--no-write-thumbnail', '--no-write-info-json', '--no-write-subs', '--no-write-auto-subs',
    '--simulate', '--dump-single-json', '--no-check-formats', '--ignore-no-formats-error',
    '--no-js-runtimes', '--js-runtimes', `deno:${deno}`,
    '--extractor-args', 'youtube:skip=hls,dash,translated_subs;fetch_pot=never',
    '--socket-timeout', '15', '--retries', '0', '--extractor-retries', '0', '--fragment-retries', '0',
    '--file-access-retries', '0', '--concurrent-fragments', '1', '--abort-on-error', '--no-progress',
    '--proxy', proxyUrl, '--', url,
  ];
}

function mediaUrl(value, extension) {
  let url;
  try { url = new URL(normalizeSourceUrl(value instanceof URL ? value.href : value)); } catch { return false; }
  if (!/^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.googlevideo\.com$/.test(url.hostname) || url.pathname !== '/videoplayback') return false;
  // No client-selected fragments, ranges or start-time clipping. An expired or
  // denied signed URL fails; never fetch again/re-extract with other clients.
  for (const key of url.searchParams.keys()) if (/^(range|begin|end|start|offset|sq|live)$/i.test(key)) return false;
  if (/live|manifest/i.test(url.searchParams.get('source') || '')) return false;
  const mime = url.searchParams.get('mime');
  if (mime && (!['video/mp4', 'video/webm'].includes(mime) || (extension && mime !== `video/${extension}`))) return false;
  return true;
}

function selectFormat(info, id, maxBytes) {
  if (!info || typeof info !== 'object' || Array.isArray(info) || (info._type !== undefined && info._type !== 'video') ||
    info.id !== id || info.extractor_key !== 'Youtube' || info.entries !== undefined ||
    info.live_status !== 'not_live' || info.is_live || info.was_live || info.is_upcoming ||
    !['public', 'unlisted'].includes(info.availability) || info.has_drm ||
    !Number.isFinite(info.duration) || info.duration <= 0 || info.duration > 7200 ||
    info.playlist != null || info.playlist_id != null || info.section_start != null || info.section_end != null ||
    !Array.isArray(info.formats) || !info.formats.length || info.formats.length > 500) throw unsupported();
  const candidates = info.formats.filter(format => {
    if (!format || typeof format !== 'object' || format.protocol !== 'https' || format.has_drm !== false ||
      !['mp4', 'webm'].includes(format.ext) || format.manifest_url != null || format.fragments != null ||
      format.fragment_base_url != null || format.requested_formats != null || format.request_data != null ||
      format.section_start != null || format.section_end != null ||
      !mediaUrl(format.url, format.ext) || !Number.isSafeInteger(format.width) || format.width < 1 || format.width > 3840 ||
      !Number.isSafeInteger(format.height) || format.height < 1 || format.height > 2160 ||
      !Number.isFinite(format.fps) || format.fps <= 0 || format.fps > 60 ||
      (format.filesize != null && (!Number.isSafeInteger(format.filesize) || format.filesize < 1 || format.filesize > maxBytes))) return false;
    if (format.ext === 'mp4') return /^avc1(?:\.[a-f\d]+)?$/i.test(format.vcodec || '') && /^mp4a(?:\.[a-f\d.]+)?$/i.test(format.acodec || '');
    return /^(vp8|vp9|vp09(?:\.[\d.]+)?|av01(?:\.[a-z\d.]+)?)$/i.test(format.vcodec || '') && /^(opus|vorbis)$/.test(format.acodec || '');
  });
  if (!candidates.length) throw unsupported();
  // Exactly one original resource, never merge/remux or prefer a silent stream.
  candidates.sort((a, b) => b.height - a.height || b.width - a.width || b.fps - a.fps);
  return candidates[0];
}
function titleText(value) {
  if (typeof value !== 'string') return 'YouTube video';
  return value.replace(/[\p{Cc}\p{Cf}\p{Cs}\\/<>]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 160).replace(/\p{Cs}/gu, '') || 'YouTube video';
}

/** Trusted constructor injection only; HTTP bodies cannot supply these hooks.
 * Pinned native binaries are trusted. Deno's exact bundled-provider flags are
 * default deny, but neither a CONNECT proxy nor a Job Object is an OS sandbox.
 * Local media validation/whole-video processing belongs to the material store;
 * this adapter never probes the network, downloads captions or invokes FFmpeg.
 */
export function createYouTubeSource({ loadAssets = prepareYouTubeAssets, run = runOwnedProcess,
  createProxy = createSourceProxy, download = downloadSourceFile } = {}) {
  async function acquireYouTubeVideo({ url, directory, maxBytes = 256 * 1024 * 1024, signal, onProgress } = {}) {
    const canonical = youtubeVideoUrl(url);
    if (!canonical) throw unsupported();
    if (!isAbsolute(directory || '') || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1024 * 1024 * 1024 ||
      (signal !== undefined && !(signal instanceof AbortSignal)) || (onProgress !== undefined && typeof onProgress !== 'function')) throw failed();
    check(signal);
    let job, proxy, info, format, file, completedFile = false;
    try {
      const stat = fs.lstatSync(directory), physical = fs.realpathSync(directory), expected = resolve(directory);
      const sameDirectory = process.platform === 'win32' ? physical.toLowerCase() === expected.toLowerCase() : physical === expected;
      if (!stat.isDirectory() || stat.isSymbolicLink() || !sameDirectory) throw failed();
      const assets = await loadAssets({ signal, offline: true }); check(signal);
      if (!isAbsolute(assets.ytdlp || '') || !isAbsolute(assets.deno || '')) throw failed();
      job = fs.mkdtempSync(join(directory, '.youtube-'));
      try {
        fs.chmodSync(job, 0o700);
        proxy = await createProxy({ signal }); check(signal);
        const helperSignal = AbortSignal.any([...(signal ? [signal] : []), proxy.signal]);
        const output = await run(assets.ytdlp, youtubeMetadataArguments(canonical, assets.deno, proxy.url), {
          cwd: job, env: youtubeChildEnvironment(job, proxy.url), signal: helperSignal,
          timeoutMs: 60_000, maxBytes: HELPER_OUTPUT_LIMIT,
        });
        check(signal); check(proxy.signal);
        if (!Buffer.isBuffer(output) || output.length > HELPER_OUTPUT_LIMIT) throw failed();
        try { info = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(output)); } catch { throw failed(); }
        format = selectFormat(info, new URL(canonical).searchParams.get('v'), maxBytes);
      } finally {
        let cleanupFailed = false;
        try { await proxy?.close(); } catch { cleanupFailed = true; }
        try { await rm(job, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); job = null; }
        catch { cleanupFailed = true; }
        if (cleanupFailed) throw safeError('YouTube helper cleanup could not be completed.', 500);
      }
      check(signal);
      file = join(directory, `source.${format.ext}`);
      const result = await download(format.url, file, { signal, maxBytes, onProgress, timeoutMs: 10 * 60 * 1000,
        allowUrl: target => mediaUrl(target, format.ext),
        limitForHeaders: ({ contentType, contentLength }) => {
          if (![format.ext === 'mp4' ? 'video/mp4' : 'video/webm', 'application/octet-stream'].includes(contentType) ||
            contentLength === 0 || (format.filesize != null && contentLength !== null && contentLength !== format.filesize)) throw unsupported();
          return maxBytes;
        },
      });
      completedFile = true; check(signal);
      const fileStat = fs.lstatSync(file);
      if (!fileStat.isFile() || fileStat.isSymbolicLink() || fileStat.size < 1 || fileStat.size > maxBytes ||
        fileStat.size !== result.size || (format.filesize != null && fileStat.size !== format.filesize)) throw failed();
      const title = titleText(info.title);
      return {
        file, extension: format.ext, size: fileStat.size, kind: 'media', name: `${title}.${format.ext}`,
        provenance: { type: 'youtube', citationUrl: canonical, title, importedAt: new Date().toISOString() },
        warnings: [
          `Whole video and soundtrack imported as one progressive ${format.ext.toUpperCase()} resource (${format.height}p). Separate streams and higher-quality manifest formats were not substituted.`,
          'Only public guest access, finished videos up to two hours, and supported AV codecs/resolutions are accepted. YouTube receives the video request and the server network address.',
        ],
      };
    } catch (error) {
      if (completedFile) {
        try { await rm(file, { force: true }); } catch { throw new AppError('YouTube import failed and its owned file could not be cleaned up.', 500); }
      }
      if (safeErrors.has(error)) throw error;
      if (signal?.aborted) throw cancelled();
      // Never leak helper stderr, tokens/signed CDN URLs, local paths or errors
      // from a transport/callback. Map known categories to fixed diagnostics.
      if (error?.status === 503) throw safeError('Verified YouTube helper assets are unavailable. Upload the video instead.', 503);
      if (error?.status === 413) throw safeError('YouTube import exceeded its byte or helper resource limit.', 413);
      if (error?.status === 504) throw safeError('YouTube import exceeded its deadline. No automatic retry was made.', 504);
      throw failed();
    }
  }
  return { acquireYouTubeVideo };
}
export const acquireYouTubeVideo = createYouTubeSource().acquireYouTubeVideo;
