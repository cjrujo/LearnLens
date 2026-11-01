import childProcess from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { ensureMediaTools, mediaChildEnvironment, MediaImportError } from '../deploy/media-assets.mjs';

export { MediaImportError } from '../deploy/media-assets.mjs';
export const MEDIA_SEGMENT_SECONDS = 180;
const MiB = 1024 * 1024;
const MAX_DURATION = 4 * 60 * 60;
const MAX_PIXELS = 16 * 1024 * 1024;
const DEMUXERS = Object.freeze({ mp3: 'mp3', mp4: 'mov', webm: 'matroska', wav: 'wav', ogg: 'ogg' });
const abortError = () => new DOMException('Media operation cancelled.', 'AbortError');
function checkAbort(signal) { if (signal?.aborted) throw abortError(); }
const fail = message => { throw new MediaImportError(message); };

// All metadata and stderr are untrusted. Never interpolate either into exceptions.
function runProcess(executable, args, { signal, maxBytes, timeoutMs }) {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = childProcess.spawn(executable, args, {
        shell: false, windowsHide: true, env: mediaChildEnvironment(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch { reject(new MediaImportError('Could not start the managed media processor.')); return; }
    const chunks = []; let bytes = 0, diagnosticBytes = 0, failure, settled = false;
    const stop = error => { failure ||= error; child.kill('SIGKILL'); };
    const abort = () => stop(abortError());
    const timer = setTimeout(() => stop(new MediaImportError('Media processing exceeded its time limit. Check workspace CPU capacity or retry local preparation; no provider request was made.')), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      error ? reject(error) : resolve(value);
    };
    child.stdout.on('data', chunk => {
      if (failure) return;
      bytes += chunk.length;
      if (bytes > maxBytes) stop(new MediaImportError('Media processing exceeded its output limit.'));
      else chunks.push(chunk);
    });
    child.stderr.on('data', chunk => {
      diagnosticBytes += chunk.length;
      if (diagnosticBytes > 64 * 1024) stop(new MediaImportError('Media processing produced too many decoding errors.'));
    });
    child.on('error', () => finish(failure || new MediaImportError('Could not start the managed media processor.')));
    child.on('close', code => {
      if (failure) finish(failure);
      else if (code !== 0) finish(new MediaImportError('Media could not be decoded. The file may be damaged or use an unsupported codec.'));
      else finish(null, Buffer.concat(chunks, bytes));
    });
    if (signal?.aborted) abort();
  });
}
function extensionKey(extension) {
  const ext = typeof extension === 'string' ? extension.toLowerCase().replace(/^\./, '') : '';
  if (!Object.hasOwn(DEMUXERS, ext)) fail('Unsupported media type. Use MP3, MP4, WebM, WAV, or OGG.');
  return ext;
}
function inputArguments(extension) {
  const ext = extensionKey(extension), demuxer = DEMUXERS[ext];
  return [
    '-hide_banner', '-v', 'error', '-max_alloc', String(64 * MiB),
    '-threads', '2', '-max_pixels', String(MAX_PIXELS),
    '-protocol_whitelist', 'file,pipe', '-format_whitelist', demuxer,
    '-probesize', String(5 * MiB), '-analyzeduration', '10000000',
    '-max_streams', '32', '-f', demuxer,
    ...(ext === 'mp4' ? ['-enable_drefs', '0', '-use_absolute_path', '0'] : []),
  ];
}
async function validateFile(filePath, signal) {
  checkAbort(signal);
  if (typeof filePath !== 'string' || !isAbsolute(filePath) || filePath.includes('\0')) fail('Media requires a private local file.');
  const info = await lstat(filePath);
  checkAbort(signal);
  if (!info.isFile() || info.size <= 0) fail('Media file is empty or is not a regular file.');
  if (info.size > 1024 * MiB) fail('Media exceeds the 1 GiB original-file limit.');
}
function readProbe(bytes, extension, fallbackDuration = 0) {
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); }
  catch { fail('Media inspection returned invalid data.'); }
  const ext = extensionKey(extension);
  const formats = typeof value?.format?.format_name === 'string' ? value.format.format_name.split(',') : [];
  if (!formats.includes(DEMUXERS[ext]) || !Array.isArray(value.streams) || value.streams.length > 32) fail('Media container does not match its file type.');
  const streams = value.streams.filter(s => s && (s.codec_type === 'audio' || (s.codec_type === 'video' && !s.disposition?.attached_pic)));
  const hasAudio = streams.some(s => s.codec_type === 'audio');
  const hasVideo = streams.some(s => s.codec_type === 'video');
  if (!hasAudio && !hasVideo) fail('Media contains no playable audio or video.');
  if (streams.some(s => !s.codec_name || s.codec_name === 'unknown')) fail('Media uses an unsupported codec.');
  for (const stream of streams.filter(s => s.codec_type === 'video')) {
    if (!Number.isInteger(stream.width) || !Number.isInteger(stream.height) || stream.width <= 0 || stream.height <= 0 || stream.width * stream.height > MAX_PIXELS) fail('Video exceeds the supported frame-size limit.');
  }
  const times = [fallbackDuration, value.format.duration, ...streams.map(s => s.duration)].map(Number).filter(n => Number.isFinite(n) && n > 0);
  const duration = Math.max(0, ...times);
  if (!duration) { const error = new MediaImportError('Media duration could not be determined from its timestamps.'); error.code = 'MISSING_DURATION'; throw error; }
  if (duration > MAX_DURATION) fail('Media exceeds the four-hour safety limit.');
  return { duration, hasAudio, hasVideo, partCount: Math.ceil(duration / MEDIA_SEGMENT_SECONDS) };
}

export async function inspectMedia(filePath, extension, { signal } = {}) {
  checkAbort(signal);
  const ext = extensionKey(extension);
  await validateFile(filePath, signal);
  // Tool acquisition and integrity verification must complete before any untrusted
  // media is parsed. The server can also call ensureMediaTools ahead of uploads.
  const { ffprobe, ffmpeg } = await ensureMediaTools({ signal });
  const output = await runProcess(ffprobe, [
    ...inputArguments(ext),
    '-show_entries', 'format=duration,format_name:stream=codec_type,codec_name,width,height,duration:stream_disposition=attached_pic',
    '-of', 'json', '-i', filePath,
  ], { signal, maxBytes: 256 * 1024, timeoutMs: 45000 });
  checkAbort(signal);
  try { return readProbe(output, ext); }
  catch (error) {
    if (error.code !== 'MISSING_DURATION') throw error;
    // Browser MediaRecorder WebM commonly omits duration headers. Scan/copy
    // timestamps automatically; do not decode an entire recording into memory.
    const progress = await runProcess(ffmpeg, [
      ...inputArguments(ext), '-nostdin', '-i', filePath, '-map', '0:a:0?', '-map', '0:V:0?',
      '-c', 'copy', '-sn', '-dn', '-map_metadata', '-1', '-f', 'null', '-', '-progress', 'pipe:1', '-nostats',
    ], { signal, maxBytes: 256 * 1024, timeoutMs: 90000 });
    const times = [...progress.toString('utf8').matchAll(/^out_time_us=(\d+)$/gm)].map(match => Number(match[1]) / 1000000);
    return readProbe(output, ext, Math.max(0, ...times));
  }
}
function partBounds(index, info) {
  if (!info || !Number.isFinite(info.duration) || info.duration <= 0 || info.duration > MAX_DURATION || typeof info.hasAudio !== 'boolean' || typeof info.hasVideo !== 'boolean' || (!info.hasAudio && !info.hasVideo) || info.partCount !== Math.ceil(info.duration / MEDIA_SEGMENT_SECONDS)) fail('Media inspection information is invalid. Inspect the file again.');
  if (!Number.isInteger(index) || index < 0 || index >= info.partCount) fail('Media part index is outside the recording.');
  const start = index * MEDIA_SEGMENT_SECONDS;
  return { start, end: Math.min(info.duration, start + MEDIA_SEGMENT_SECONDS) };
}
function pcmWav(pcm) {
  // Pipe WAV muxers use unknown-length headers. Build a canonical, independently
  // playable PCM WAV instead, after collecting only this bounded 3-minute part.
  if (pcm.length % 2 || pcm.length + 44 > 6 * MiB) fail('Audio part exceeded its supported size.');
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(pcm.length + 36, 4);
  header.write('WAVEfmt ', 8); header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export async function prepareMediaPart(filePath, extension, index, info, { signal } = {}) {
  checkAbort(signal);
  const ext = extensionKey(extension);
  const { start, end } = partBounds(index, info);
  await validateFile(filePath, signal);
  const { ffmpeg } = await ensureMediaTools({ signal });
  const result = { text: '', images: [], warnings: [], start, end };
  const duration = end - start;
  const input = time => [
    ...inputArguments(ext), '-nostdin', '-xerror',
    '-filter_threads', '1', '-filter_complex_threads', '1',
    '-ss', String(time), '-i', filePath,
  ];
  if (info.hasAudio) {
    const pcm = await runProcess(ffmpeg, [
      ...input(start), '-t', String(duration), '-map', '0:a:0',
      '-vn', '-sn', '-dn', '-map_metadata', '-1', '-map_chapters', '-1',
      '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-threads', '1',
      '-f', 's16le', 'pipe:1',
    ], { signal, maxBytes: Math.ceil(duration * 16000) * 2 + 4096, timeoutMs: 90000 });
    if (pcm.length) result.audio = `data:audio/wav;base64,${pcmWav(pcm).toString('base64')}`;
    else result.warnings.push('This part contains no decodable soundtrack samples.');
  } else result.warnings.push('This recording has no audio soundtrack. Only video frames are available.');
  if (info.hasVideo) {
    // Seek the original file for each sample; never decode the whole recording
    // or keep an unbounded frame stream in memory. Attached cover art is excluded.
    const sampleTimes = [start, start + duration / 2];
    for (let n = 0; n < sampleTimes.length; n++) {
      checkAbort(signal);
      const jpeg = await runProcess(ffmpeg, [
        ...input(sampleTimes[n]), '-t', String(end - sampleTimes[n]),
        '-map', '0:V:0', '-an', '-sn', '-dn', '-map_metadata', '-1', '-map_chapters', '-1',
        '-frames:v', '1', '-vf', "scale=w='min(1280,iw)':h='min(1280,ih)':force_original_aspect_ratio=decrease,setsar=1",
        '-c:v', 'mjpeg', '-q:v', '4', '-threads', '1', '-f', 'image2pipe', 'pipe:1',
      ], { signal, maxBytes: 2 * MiB, timeoutMs: 45000 });
      if (jpeg.length) {
        if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8 || jpeg.at(-2) !== 0xff || jpeg.at(-1) !== 0xd9) fail('Media processor returned an invalid video thumbnail.');
        result.images.push({ name: `part-${index + 1}-frame-${n + 1}.jpg`, dataUrl: `data:image/jpeg;base64,${jpeg.toString('base64')}` });
      }
    }
    if (!result.images.length) result.warnings.push('No video frames were available in this part.');
  }
  checkAbort(signal);
  return result;
}

// Explicit aliases let local video preparation share the same hardened limits.
// Keep the original names and __testing surface unchanged for legacy callers.
export { inputArguments as mediaInputArguments, runProcess as runMediaProcess, validateFile as validateMediaFile };

export const __testing = Object.freeze({ inputArguments, readProbe, partBounds, pcmWav, runProcess, MAX_DURATION, MAX_PIXELS });
