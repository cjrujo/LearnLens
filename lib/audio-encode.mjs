import childProcess from 'node:child_process';
import { isAbsolute } from 'node:path';
import { ensureMediaTools, mediaChildEnvironment, MediaImportError } from '../deploy/media-assets.mjs';
import { sniffMedia } from './provider.mjs';

const MiB = 1024 * 1024;
const MAX_INPUT_BYTES = 8 * MiB;
const MAX_OUTPUT_BYTES = 2 * MiB;
const TIMEOUT_MS = 60_000;
const DEMUXERS = Object.freeze({
  'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/mp4': 'mov',
  'audio/ogg': 'ogg', 'audio/webm': 'matroska',
});
const abortError = () => new DOMException('Audio encoding cancelled.', 'AbortError');
function checkAbort(signal) { if (signal?.aborted) throw abortError(); }
const failure = message => new MediaImportError(message);

// No files, URLs, auto-detected demuxers, or external MP4 data references.
function inputArguments(mime) {
  if (!Object.hasOwn(DEMUXERS, mime)) throw failure('Unsupported speech audio format.');
  const demuxer = DEMUXERS[mime];
  return [
    '-hide_banner', '-v', 'error', '-nostdin', '-xerror',
    '-max_alloc', String(64 * MiB), '-threads', '2',
    '-filter_threads', '1', '-filter_complex_threads', '1',
    '-protocol_whitelist', 'pipe', '-format_whitelist', demuxer,
    '-probesize', String(MAX_INPUT_BYTES), '-analyzeduration', '10000000',
    '-max_streams', '32', '-err_detect', 'explode', '-f', demuxer,
    ...(mime === 'audio/mp4' ? ['-enable_drefs', '0', '-use_absolute_path', '0'] : []),
    '-i', 'pipe:0', '-map', '0:a:0', '-vn', '-sn', '-dn',
    '-map_metadata', '-1', '-map_chapters', '-1', '-threads', '1',
  ];
}

// One bounded input write, owned by this child. On failure destroy stdin before
// killing, keep error listeners installed, and settle only once the child closes.
// Stderr is counted, never retained or returned (it can contain source material).
function runPipe(executable, args, input, { signal, timeoutMs = TIMEOUT_MS } = {}) {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = childProcess.spawn(executable, args, {
        shell: false, windowsHide: true, env: mediaChildEnvironment(),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch { reject(failure('Could not start the managed audio encoder.')); return; }
    const chunks = [];
    let outputBytes = 0, stderrBytes = 0, error, closed = false;
    const stop = reason => {
      if (closed || error) return;
      error = reason;
      child.stdin.destroy();
      child.kill('SIGKILL');
    };
    const abort = () => stop(abortError());
    const timer = setTimeout(() => stop(failure('Audio encoding exceeded its time limit.')), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    child.on('error', () => stop(failure('Could not run the managed audio encoder.')));
    child.stdin.on('error', () => stop(failure('Audio input could not be processed.')));
    child.stdout.on('error', () => stop(failure('Audio output could not be processed.')));
    child.stderr.on('error', () => stop(failure('Audio processing failed.')));
    child.stdout.on('data', chunk => {
      if (error) return;
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) stop(failure('Encoded audio exceeded the 2 MiB output limit.'));
      else chunks.push(chunk);
    });
    child.stderr.on('data', chunk => {
      if (error) return;
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_OUTPUT_BYTES) stop(failure('Audio processing exceeded its diagnostic limit.'));
    });
    child.once('close', code => {
      closed = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      child.stdin.destroy();
      if (error) reject(error);
      else if (code !== 0) reject(failure('Audio could not be decoded or encoded. It may be damaged or unsupported.'));
      else resolve(Buffer.concat(chunks, outputBytes));
    });
    if (signal?.aborted) abort();
    if (!error) {
      try { child.stdin.end(input); }
      catch { stop(failure('Audio input could not be processed.')); }
    }
  });
}

/**
 * Call and await this BEFORE any potentially billable speech request. The
 * default loader verifies the application-managed tools; it never uses PATH.
 * loadTools is a trusted dependency-injection seam for local unit fixtures only.
 */
export async function prepareAudioEncoder({ signal, loadTools = ensureMediaTools } = {}) {
  checkAbort(signal);
  let tools;
  try { tools = await loadTools({ signal, offline: process.env.LEARNLENS_MEDIA_OFFLINE === '1' }); }
  catch (error) {
    checkAbort(signal);
    if (error instanceof MediaImportError) throw error;
    throw failure('Could not prepare the managed audio encoder.');
  }
  checkAbort(signal);
  if (typeof tools?.ffmpeg !== 'string' || !isAbsolute(tools.ffmpeg) || tools.ffmpeg.includes('\0')) {
    throw failure('Managed audio encoder path is invalid.');
  }
  const ffmpeg = tools.ffmpeg;
  return async function encode(audio, { signal: encodeSignal } = {}) {
    const activeSignal = signal && encodeSignal ? AbortSignal.any([signal, encodeSignal]) : encodeSignal || signal;
    checkAbort(activeSignal);
    const { buffer, mime } = audio || {};
    if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > MAX_INPUT_BYTES) {
      throw failure('Speech audio must contain at most 8 MiB of nonempty binary data.');
    }
    if (typeof mime !== 'string' || !Object.hasOwn(DEMUXERS, mime) || sniffMedia(buffer) !== mime) {
      throw failure('Speech audio contents do not match a supported format.');
    }
    const deadline = Date.now() + TIMEOUT_MS;
    const mp3 = await runPipe(ffmpeg, [
      ...inputArguments(mime), '-ac', '1', '-ar', '24000', '-c:a', 'libmp3lame', '-b:a', '48k',
      '-write_xing', '0', '-protocol_whitelist', 'pipe', '-f', 'mp3', 'pipe:1',
    ], buffer, { signal: activeSignal });
    checkAbort(activeSignal);
    if (!mp3.length || sniffMedia(mp3) !== 'audio/mpeg') throw failure('Audio encoder returned no valid MP3 audio.');

    // Decode ALL output frames, not merely the header or a preview. PCM goes to
    // the null muxer, so memory stays bounded even for long clips; progress is a
    // small bounded pipe showing a completed decode with positive audio time.
    // This validates decodability, NOT spoken content or pronunciation.
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw failure('Audio encoding exceeded its time limit.');
    const decoded = await runPipe(ffmpeg, [
      ...inputArguments('audio/mpeg'), '-c:a', 'pcm_s16le',
      '-progress', 'pipe:1', '-nostats', '-protocol_whitelist', 'pipe', '-f', 'null', 'pipe:1',
    ], mp3, { signal: activeSignal, timeoutMs: remainingMs });
    checkAbort(activeSignal);
    const progress = decoded.toString('ascii');
    if (!/^progress=end\r?$/m.test(progress) || ![...progress.matchAll(/^out_time_us=(\d+)\r?$/gm)].some(match => Number(match[1]) > 0)) {
      throw failure('Encoded MP3 contained no completely decodable audio.');
    }
    return mp3;
  };
}

export const __testing = Object.freeze({ inputArguments, runPipe, MAX_INPUT_BYTES, MAX_OUTPUT_BYTES, TIMEOUT_MS });
