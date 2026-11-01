// Continuous local video preparation, not sparse screenshots. No provider calls.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { ensureMediaTools } from '../deploy/media-assets.mjs';
import { mediaInputArguments, runMediaProcess, validateMediaFile, MediaImportError } from './native-media.mjs';

export const VIDEO_CLIP_SECONDS = 30;
export const VIDEO_CLIP_MAX_BYTES = 8 * 1024 * 1024;
const MAX_DURATION = 4 * 60 * 60;
const MIN_TAIL = 0.5;
const PROCESSING_TIMEOUT_MS = 120000;
const PACKET_MAX_BYTES = 128 * 1024 * 1024;
const PACKET_MAX_COUNT = 2_000_000;
const TIMING_MAX_BYTES = 8192;
const TIMING_PROFILE = 1;
// Session-only authentication survives the material store's structuredClone,
// unlike a WeakSet/Symbol brand. Neither HTTP metadata nor edited timing can mint
// an attestation. No global per-source registry or retained packet arrays.
const timingKey = randomBytes(32);
const AAC_FRAME_SECONDS = 1024 / 48000;
const SCALE = "scale=w='max(2,trunc(iw*min(1,min(1920/iw,1080/ih))/2)*2)':h='max(2,trunc(ih*min(1,min(1920/iw,1080/ih))/2)*2)'";
const WARNINGS = Object.freeze([
  'Whole-video preparation encodes continuous intervals at the source frame rate; it does not extract sparse screenshots. The provider may sample the video separately, so this does not guarantee that every frame is evaluated or every detail perceived.',
  'Only the analysis copy is resized, if needed, to at most 1920×1080 with even dimensions and lossy H.264 encoding. Audio, when present, is encoded as 48 kHz stereo AAC at 64 kbps per track. The private original is unchanged.',
  'Clip bounds use the original recording timeline. Encoded timestamps are local to each clip; frame boundaries and AAC priming/padding can cause small timing differences. Audio and video retain their relative timing, including unequal stream lengths.',
]);
const fail = message => { throw new MediaImportError(message); };
const abortError = () => new DOMException('Media operation cancelled.', 'AbortError');

function validInfo(info) {
  if (!info || typeof info.duration !== 'number' || !Number.isFinite(info.duration) || info.duration <= 0 || info.duration > MAX_DURATION || typeof info.hasAudio !== 'boolean' || info.hasVideo !== true) {
    fail('Whole-video preparation requires valid video inspection information within the four-hour limit. Inspect the file again.');
  }
}
function countParts(duration) {
  const count = Math.ceil(duration / VIDEO_CLIP_SECONDS);
  const tail = duration - (count - 1) * VIDEO_CLIP_SECONDS;
  return count > 1 && tail < MIN_TAIL ? count - 1 : count;
}
export function videoClipPlan(info) {
  validInfo(info);
  const { duration, hasAudio, hasVideo } = info;
  const partCount = countParts(duration);
  const warnings = [...WARNINGS];
  if (!hasAudio) warnings.push('This recording has no audio soundtrack. Only continuous video is available.');
  if (partCount < Math.ceil(duration / VIDEO_CLIP_SECONDS)) warnings.push('A final tail shorter than 0.5 seconds is merged into the preceding clip instead of making a padding-sized fragment.');
  const sourceTiming = info.sourceTiming === undefined ? undefined : checkedTiming(info.sourceTiming, info).metadata;
  return Object.freeze({ version: 1, mode: 'whole-video', duration, partCount, hasAudio, hasVideo, warnings: Object.freeze(warnings), ...(sourceTiming ? { sourceTiming } : {}) });
}
export function videoClipBounds(index, plan) {
  validInfo(plan);
  if (plan.version !== 1 || plan.mode !== 'whole-video' || plan.partCount !== countParts(plan.duration)) fail('Whole-video clip plan is invalid. Prepare the plan again.');
  if (!Number.isInteger(index) || index < 0 || index >= plan.partCount) fail('Video clip index is outside the recording.');
  const start = index * VIDEO_CLIP_SECONDS;
  const end = index === plan.partCount - 1 ? plan.duration : start + VIDEO_CLIP_SECONDS;
  if (!(end > start) || end - start > VIDEO_CLIP_SECONDS + MIN_TAIL) fail('Video clip bounds exceed the safety limit.');
  return { start, end };
}

// One clock covers acquisition, all subprocesses, private writes and validation.
// Abort reasons are deliberately never surfaced (they can contain source data).
function deadline(parent, timeoutMs) {
  const controller = new AbortController();
  const expires = performance.now() + timeoutMs;
  let expired = false;
  const cancel = () => controller.abort();
  const timer = setTimeout(() => { expired = true; cancel(); }, timeoutMs);
  parent?.addEventListener('abort', cancel, { once: true });
  if (parent?.aborted) cancel();
  const check = () => {
    if (parent?.aborted) throw abortError();
    if (expired || performance.now() >= expires) {
      expired = true; cancel();
      fail('Video preparation exceeded its processing deadline. No provider request was made.');
    }
    if (controller.signal.aborted) throw abortError();
  };
  return {
    signal: controller.signal, check,
    remaining() { check(); return Math.max(1, Math.ceil(expires - performance.now())); },
    close() { clearTimeout(timer); parent?.removeEventListener('abort', cancel); },
  };
}

function probeArguments(filePath, extension, output = false) {
  return [
    ...mediaInputArguments(extension),
    ...(output ? ['-count_frames'] : []),
    '-show_entries', 'format=format_name,duration,start_time:stream=index,codec_type,codec_name,width,height,duration,start_time,avg_frame_rate,r_frame_rate,time_base,pix_fmt,channels,sample_rate,nb_read_frames:stream_disposition=attached_pic',
    '-of', 'json', '-i', filePath,
  ];
}
function packetArguments(filePath, extension) {
  return [
    ...mediaInputArguments(extension), '-err_detect', 'explode',
    // Numeric fields only. Explicitly suppress tags and side-data payloads; the
    // compact writer may still append an empty trailing | for Opus skip samples.
    '-show_entries', 'packet=stream_index,pts_time,duration_time:packet_side_data=',
    '-of', 'compact=p=1:nk=0', '-i', filePath,
  ];
}
function encodeArguments(filePath, extension, bounds, hasAudio) {
  return [
    ...mediaInputArguments(extension), '-nostdin', '-xerror', '-err_detect', 'explode',
    '-filter_threads', '1', '-filter_complex_threads', '1',
    '-ss', String(bounds.start), '-i', filePath, '-t', String(bounds.end - bounds.start),
    // Source verification rejects multiple substantive tracks before encoding.
    // Audio is mandatory if inspection says it exists; never use an optional map.
    '-map', '0:V:0', ...(hasAudio ? ['-map', '0:a:0'] : ['-an']),
    '-sn', '-dn', '-map_metadata', '-1', '-map_chapters', '-1',
    '-vf', SCALE, '-c:v', 'libopenh264', '-pix_fmt', 'yuv420p',
    '-b:v', '1200000', '-maxrate:v', '1500000', '-bufsize:v', '3000000',
    '-rc_mode:v', 'bitrate', '-allow_skip_frames:v', '0', '-threads:v', '2',
    '-fps_mode:v', 'passthrough', '-enc_time_base:v', 'demux',
    ...(hasAudio ? ['-c:a', 'aac', '-b:a', '64000', '-ar', '48000', '-ac', '2', '-threads:a', '1'] : []),
    // A bounded pipe, NOT -fs (which can report success after truncating a clip).
    // No -shortest: a late soundtrack must survive a shorter video stream.
    '-avoid_negative_ts', 'make_zero',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1',
  ];
}
function decodeArguments(filePath, hasAudio) {
  return [
    ...mediaInputArguments('mp4'), '-nostdin', '-xerror', '-err_detect', 'explode',
    '-filter_threads', '1', '-filter_complex_threads', '1', '-i', filePath,
    '-map', '0:V', ...(hasAudio ? ['-map', '0:a'] : ['-an']),
    '-sn', '-dn', '-map_metadata', '-1', '-map_chapters', '-1',
    '-threads', '2', '-fps_mode:v', 'passthrough', '-f', 'null', '-',
    '-progress', 'pipe:1', '-nostats',
  ];
}

function number(value) {
  return (typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')) && Number.isFinite(Number(value)) ? Number(value) : NaN;
}
function framePeriod(stream) {
  for (const value of [stream.avg_frame_rate, stream.r_frame_rate]) {
    if (typeof value !== 'string' || !/^\d+\/\d+$/.test(value)) continue;
    const [numerator, denominator] = value.split('/').map(Number);
    if (Number.isFinite(numerator) && Number.isFinite(denominator) && numerator > 0 && denominator > 0 && Number.isFinite(denominator / numerator)) return denominator / numerator;
  }
  return null;
}
function timingTolerance(stream) {
  // At most one ordinary video frame plus an AAC frame. Do not excuse large
  // missing tails, even for extremely low-frame-rate or malformed recordings.
  return (stream.codec_type === 'video' ? Math.min(0.5, framePeriod(stream) ?? 1 / 25) : AAC_FRAME_SECONDS) + AAC_FRAME_SECONDS + 0.005;
}
function parseProbe(bytes, extension) {
  let data;
  try { data = JSON.parse(bytes.toString('utf8')); } catch { fail('Video inspection returned invalid data.'); }
  const args = mediaInputArguments(extension);
  const format = args[args.indexOf('-f') + 1];
  if (typeof data?.format?.format_name !== 'string' || !data.format.format_name.split(',').includes(format) || !Array.isArray(data.streams) || data.streams.length > 32) fail('Video container or stream information is invalid.');
  const streams = data.streams.filter(s => s && (s.codec_type === 'audio' || (s.codec_type === 'video' && !s.disposition?.attached_pic)));
  if (!streams.some(s => s.codec_type === 'video') || streams.some(s => typeof s.codec_name !== 'string' || !s.codec_name || s.codec_name === 'unknown')) fail('Video contains no supported playable video stream.');
  const indices = new Set();
  for (const stream of streams) {
    if (!Number.isInteger(stream.index) || stream.index < 0 || stream.index >= 32 || indices.has(stream.index)) fail('Video stream index is invalid.');
    indices.add(stream.index);
    if (stream.codec_type === 'video' && (!Number.isInteger(stream.width) || !Number.isInteger(stream.height) || stream.width < 1 || stream.height < 1 || stream.width * stream.height > 16 * 1024 * 1024)) fail('Video exceeds the supported frame-size limit.');
  }
  const durations = [data.format.duration, ...streams.map(s => s.duration)].map(number).filter(n => n > 0);
  const duration = durations.length ? Math.max(...durations) : null;
  if (duration !== null && duration > MAX_DURATION) fail('Video exceeds the four-hour safety limit.');
  const origin = number(data.format.start_time);
  return { streams, duration, origin: Number.isFinite(origin) ? origin : 0 };
}
function verifySourceShape(source, plan) {
  const videos = source.streams.filter(s => s.codec_type === 'video');
  const audio = source.streams.filter(s => s.codec_type === 'audio');
  if (videos.length !== 1 || audio.length > 1) fail('Whole-video preparation requires one playable video track and at most one audio track. Multiple tracks cannot be silently omitted.');
  if (Boolean(audio.length) !== plan.hasAudio) fail('Video soundtrack information changed. Inspect the original again.');
  if (source.duration !== null && Math.abs(source.duration - plan.duration) > 0.1) fail('Video duration does not match its clip plan. Inspect the original again.');
}
function verifySource(source, plan) {
  verifySourceShape(source, plan);
  const selected = {};
  for (const stream of source.streams) {
    const timestampStart = number(stream.start_time), duration = number(stream.duration);
    // Do not infer full-track coverage from container duration alone. In
    // particular, an audio track may start late or stop well before the video.
    if (!Number.isFinite(timestampStart) || !(duration > 0)) fail('Complete source track timestamps are unavailable. Whole-video coverage cannot be verified safely.');
    const start = timestampStart - source.origin, end = start + duration;
    const tolerance = timingTolerance(stream);
    if (Math.abs(start) > tolerance || Math.abs(end - plan.duration) > tolerance) fail('Source video and audio do not cover the complete recording timeline. Meaningful missing track content cannot be treated as whole-video coverage.');
    selected[stream.codec_type] = {
      index: stream.index, codec: stream.codec_name, timestampStart,
      start, end, duration, tolerance,
      ...(stream.codec_type === 'video'
        ? { width: stream.width, height: stream.height, framePeriod: framePeriod(stream) }
        : { sampleRate: Number.isFinite(number(stream.sample_rate)) ? number(stream.sample_rate) : null }),
    };
  }
  return selected;
}
function expectedRange(stream, source, bounds, plan) {
  const startTime = number(stream.start_time);
  const start = Number.isFinite(startTime) ? startTime - source.origin : 0;
  const streamDuration = number(stream.duration);
  const end = Math.min(plan.duration, streamDuration > 0 ? start + streamDuration : plan.duration);
  const first = Math.max(bounds.start, start, 0), last = Math.min(bounds.end, end);
  if (last <= first) fail('This interval has no samples for an expected video or audio track. It cannot be prepared without dropping a track.');
  return { start: first - bounds.start, end: last - bounds.start };
}
function verifyOutput(output, source, plan, bounds) {
  const durations = [];
  for (const type of ['video', 'audio']) {
    const originals = source.streams.filter(s => s.codec_type === type);
    const copies = output.streams.filter(s => s.codec_type === type);
    if (copies.length !== originals.length) fail('Prepared video is missing an expected video or audio track.');
    for (let i = 0; i < originals.length; i++) {
      const copy = copies[i], expected = expectedRange(originals[i], source, bounds, plan);
      const start = number(copy.start_time), duration = number(copy.duration);
      const tolerance = timingTolerance(originals[i]);
      if (copy.codec_name !== (type === 'video' ? 'h264' : 'aac') || !Number.isSafeInteger(number(copy.nb_read_frames)) || !(number(copy.nb_read_frames) > 0)) fail('Prepared video contains an empty or unsupported track.');
      if (type === 'video' && (copy.width > 1920 || copy.height > 1080 || copy.width % 2 || copy.height % 2)) fail('Prepared video dimensions exceed the analysis-copy limit.');
      if (!Number.isFinite(start) || !(duration > 0) || Math.abs(start - expected.start) > tolerance || Math.abs(start + duration - expected.end) > tolerance || Math.abs(duration - (expected.end - expected.start)) > tolerance) fail('Prepared video has incomplete or implausible track timestamps. The full interval could not be preserved.');
      // Our encoder emits AAC-LC at 48 kHz (1024 samples/frame). Counted,
      // decoded audio frames must substantiate the duration, not just a header.
      if (type === 'audio' && (number(copy.sample_rate) !== 48000 || Math.abs(number(copy.nb_read_frames) * AAC_FRAME_SECONDS - duration) > 2 * AAC_FRAME_SECONDS + 0.005)) fail('Prepared audio did not decode for its complete timestamp range.');
      durations.push({ type, start, duration, end: start + duration, tolerance });
    }
  }
  const tolerance = Math.max(...durations.map(s => s.tolerance));
  if (!(output.duration > 0) || Math.abs(output.duration - (bounds.end - bounds.start)) > tolerance) fail('Prepared video duration does not cover the requested interval.');
  return durations;
}
function verifyDecode(bytes, duration, tolerance, frameCount) {
  const text = bytes.toString('utf8');
  const times = [...text.matchAll(/^out_time_us=(\d+)\r?$/gm)].map(m => Number(m[1]) / 1000000);
  if (!/^progress=end\r?$/m.test(text) || !times.length || Math.abs(Math.max(...times) - duration) > tolerance) fail('Prepared video did not completely decode through the interval tail.');
  const counts = [...text.matchAll(/^frame=(\d+)\r?$/gm)].map(m => Number(m[1]));
  if (frameCount !== undefined && (!counts.length || Math.max(...counts) !== frameCount)) fail('Prepared video did not decode all of its frames.');
}

const digest = value => createHash('sha256').update(value).digest('hex');
const hexDigest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function videoExtension(extension) {
  mediaInputArguments(extension);
  const key = extension.toLowerCase().replace(/^\./, '');
  if (!['mp4', 'webm'].includes(key)) fail('Whole-video preparation requires MP4 or WebM.');
  return key;
}
const timingSeal = payload => createHmac('sha256', timingKey).update(payload).digest('hex');
function checkedTiming(value, plan) {
  if (!value || value.version !== 1 || Object.keys(value).length !== 3 || typeof value.payload !== 'string' || value.payload.length > TIMING_MAX_BYTES || Buffer.byteLength(value.payload) > TIMING_MAX_BYTES || !hexDigest(value.seal) ||
      !timingSafeEqual(Buffer.from(value.seal, 'hex'), Buffer.from(timingSeal(value.payload), 'hex'))) fail('Private source timing is invalid. Inspect the original again.');
  let data;
  try { data = JSON.parse(value.payload); } catch { fail('Private source timing is invalid. Inspect the original again.'); }
  // Only this module mints the bounded, authenticated payload. Its lifetime is
  // the private in-memory snapshot's lifetime, never a durable/public manifest.
  if (data.profile !== TIMING_PROFILE || data.duration !== plan.duration || data.hasAudio !== plan.hasAudio || data.hasVideo !== plan.hasVideo) fail('Private source timing does not match its clip profile or interval. Inspect the original again.');
  return { data, metadata: Object.freeze({ version: 1, payload: value.payload, seal: value.seal }) };
}
function sourceProfile(source) {
  const text = value => {
    if (value === undefined) return null;
    if (typeof value !== 'string' || value.length > 64) fail('Source stream profile is invalid.');
    return value;
  };
  const numeric = value => Number.isFinite(number(value)) ? number(value) : null;
  return JSON.stringify({ origin: source.origin, duration: source.duration, streams: source.streams.map(s => ({
    index: s.index, type: s.codec_type, codec: text(s.codec_name), width: numeric(s.width), height: numeric(s.height),
    start: numeric(s.start_time), duration: numeric(s.duration), avgRate: text(s.avg_frame_rate), realRate: text(s.r_frame_rate),
    timeBase: text(s.time_base), pixelFormat: text(s.pix_fmt), sampleRate: numeric(s.sample_rate), channels: numeric(s.channels),
  })) });
}
async function fileIdentity(filePath, clock) {
  clock.check();
  const s = await lstat(filePath, { bigint: true });
  clock.check();
  if (!s.isFile() || s.size <= 0n || s.size > 1024n * 1024n * 1024n) fail('Video requires a regular private original within the 1 GiB limit.');
  return { pathHash: digest(resolve(filePath)), dev: String(s.dev), ino: String(s.ino), size: String(s.size),
    mtime: String(s.mtimeNs), ctime: String(s.ctimeNs) };
}
async function verifyTimingIdentity(data, filePath, extension, sourceHash, clock) {
  if (data.extension !== videoExtension(extension) || (sourceHash !== undefined && sourceHash !== data.sourceHash) ||
      JSON.stringify(data.identity) !== JSON.stringify(await fileIdentity(filePath, clock))) fail('Video source identity changed. Inspect the original again.');
}
async function hashOriginal(filePath, clock) {
  const hash = createHash('sha256');
  let count = 0;
  for await (const bytes of createReadStream(filePath, { signal: clock.signal, highWaterMark: 256 * 1024 })) {
    clock.check(); count += bytes.length;
    if (count > 1024 * 1024 * 1024) fail('Video exceeds the 1 GiB original-file limit.');
    hash.update(bytes);
  }
  clock.check(); return hash.digest('hex');
}
async function readPacketTiming(bytes, source, clock) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > PACKET_MAX_BYTES) fail('Source packet timing exceeded its inspection limit.');
  const tracks = new Map(source.streams.map(s => [s.index, { min: Infinity, max: -Infinity, count: 0 }]));
  let offset = 0, count = 0;
  // Parse one bounded line at a time, not split()/JSON.parse() of millions of
  // objects. The existing runner caps stdout while the child runs and awaits its
  // exit. 128 MiB / 2M packets allow ordinary four-hour 60fps + 50Hz Opus inputs;
  // denser inputs fail closed instead of silently accepting a partial scan.
  while (offset < bytes.length) {
    const newline = bytes.indexOf(10, offset);
    if (newline < 0 || newline - offset > 192 || ++count > PACKET_MAX_COUNT) fail('Source packet timing is incomplete or exceeds the packet limit.');
    const line = bytes.toString('utf8', offset, newline).replace(/\r$/, '');
    offset = newline + 1;
    const match = /^packet\|stream_index=(\d{1,2})\|pts_time=(-?\d{1,12}(?:\.\d{1,9})?|N\/A)\|duration_time=(\d{1,12}(?:\.\d{1,9})?|N\/A)\|?$/.exec(line);
    if (!match || Number(match[1]) >= 32) fail('Source packet timing is missing or unsupported. Whole-video coverage cannot be verified safely.');
    const track = tracks.get(Number(match[1]));
    if (track) {
      const pts = Number(match[2]), duration = Number(match[3]);
      // PTS is presentation order. DTS, packet order, DURATION tags, frame-rate
      // estimates and container duration cannot establish a missing packet end.
      if (!Number.isFinite(pts) || !(duration > 0) || duration > MAX_DURATION || Math.abs(pts - source.origin) > MAX_DURATION + 1) fail('Source packet timing is missing or outside the four-hour limit.');
      track.min = Math.min(track.min, pts);
      track.max = Math.max(track.max, pts + duration);
      track.count++;
    }
    if (count % 8192 === 0) {
      await new Promise(resolve => setImmediate(resolve));
      clock.check();
    }
  }
  clock.check();
  return source.streams.map(s => {
    const track = tracks.get(s.index), tolerance = timingTolerance(s);
    if (!track.count || !(track.max > track.min) || track.max - track.min > MAX_DURATION + tolerance || track.max - source.origin > MAX_DURATION + tolerance) fail('Source packet timing does not cover a supported complete track.');
    const start = number(s.start_time), duration = number(s.duration);
    if ((Number.isFinite(start) && Math.abs(start - track.min) > tolerance) || (duration > 0 && Math.abs(duration - (track.max - track.min)) > tolerance)) fail('Source packet timing conflicts with its stream timestamps.');
    return { index: s.index, timestampStart: track.min, duration: track.max - track.min, packets: track.count };
  });
}
function restoreTiming(source, data) {
  if (sourceProfile(source) !== data.sourceProfile) fail('Video source stream profile changed. Inspect the original again.');
  return { ...source, streams: source.streams.map(s => {
    const timing = data.tracks.find(t => t.index === s.index);
    if (!timing) fail('Video source timing is missing an expected track.');
    return { ...s, start_time: timing.timestampStart, duration: timing.duration };
  }) };
}

async function inspectSource(filePath, extension, info, { signal, sourceHash } = {}, {
  acquire = ensureMediaTools, run = runMediaProcess, timeoutMs = PROCESSING_TIMEOUT_MS,
} = {}) {
  if (signal?.aborted) throw abortError();
  const clock = deadline(signal, timeoutMs);
  try {
    // Snapshot the host-provided inspection before the first asynchronous step.
    info = { ...info };
    validInfo(info);
    extension = videoExtension(extension);
    if (sourceHash !== undefined && !hexDigest(sourceHash)) fail('Video source hash is invalid.');
    await validateMediaFile(filePath, clock.signal);
    const identity = await fileIdentity(filePath, clock);
    const tools = await acquire({ signal: clock.signal, offline: true });
    const invoke = (args, maxBytes) => run(tools.ffprobe, args, { signal: clock.signal, maxBytes, timeoutMs: clock.remaining() });
    const source = parseProbe(await invoke(probeArguments(filePath, extension), 256 * 1024), extension);
    verifySourceShape(source, info);
    const actualHash = await hashOriginal(filePath, clock);
    if (sourceHash !== undefined && actualHash !== sourceHash) fail('Video source identity changed. Inspect the original again.');
    const missingTiming = source.streams.some(s => !Number.isFinite(number(s.start_time)) || !(number(s.duration) > 0));
    const tracks = missingTiming
      ? await readPacketTiming(await invoke(packetArguments(filePath, extension), PACKET_MAX_BYTES), source, clock)
      : source.streams.map(s => ({ index: s.index, timestampStart: number(s.start_time), duration: number(s.duration), packets: null }));
    const data = { profile: TIMING_PROFILE, duration: info.duration, hasAudio: info.hasAudio, hasVideo: true,
      extension, sourceHash: actualHash, identity, sourceProfile: sourceProfile(source), tracks };
    verifySource(restoreTiming(source, data), info);
    await verifyTimingIdentity(data, filePath, extension, sourceHash, clock);
    const payload = JSON.stringify(data);
    if (Buffer.byteLength(payload) > TIMING_MAX_BYTES) fail('Private source timing exceeds its metadata limit.');
    const sourceTiming = Object.freeze({ version: 1, payload, seal: timingSeal(payload) });
    // Preserve native inspectMedia's partCount for the unchanged sampled-stills
    // contract. videoClipPlan computes its own chronological 30-second count.
    return { ...info, sourceTiming };
  } catch (error) {
    clock.check();
    if (error instanceof MediaImportError) throw error;
    fail('Could not inspect complete private video timing. Check the media file and local tools.');
  } finally {
    clock.close(); clock.check();
  }
}

// Called ONCE by material finish, before freezing info/videoPlan. The caller must
// retain this result only in the private snapshot, never in HTTP source metadata.
export async function inspectWholeVideoSource(filePath, extension, info, options = {}) {
  return inspectSource(filePath, extension, info, options);
}

// Dependency seam is only exported under __testing. Public callers cannot replace
// the managed toolchain, output cap, file validation or single processing clock.
async function prepareClip(filePath, extension, index, plan, { signal, sourceHash } = {}, {
  acquire = ensureMediaTools, run = runMediaProcess, timeoutMs = PROCESSING_TIMEOUT_MS,
} = {}) {
  if (signal?.aborted) throw abortError();
  const clock = deadline(signal, timeoutMs);
  let temporary;
  try {
    const bounds = videoClipBounds(index, plan);
    // Snapshot validated primitives, never echo caller-supplied warnings/metadata.
    const checkedPlan = videoClipPlan(plan);
    mediaInputArguments(extension);
    await validateMediaFile(filePath, clock.signal);
    const tools = await acquire({ signal: clock.signal, offline: true });
    const invoke = (executable, args, maxBytes) => run(executable, args, { signal: clock.signal, maxBytes, timeoutMs: clock.remaining() });
    const retained = checkedPlan.sourceTiming ? checkedTiming(checkedPlan.sourceTiming, checkedPlan).data : null;
    if (retained) await verifyTimingIdentity(retained, filePath, extension, sourceHash, clock);
    const probed = parseProbe(await invoke(tools.ffprobe, probeArguments(filePath, extension), 256 * 1024), extension);
    const source = retained ? restoreTiming(probed, retained) : probed;
    const sourceStreams = verifySource(source, checkedPlan);
    for (const stream of source.streams) expectedRange(stream, source, bounds, checkedPlan);
    const video = await invoke(tools.ffmpeg, encodeArguments(filePath, extension, bounds, checkedPlan.hasAudio), VIDEO_CLIP_MAX_BYTES);
    clock.check();
    if (!video.length || video.length > VIDEO_CLIP_MAX_BYTES) fail('Prepared video is empty or exceeds the 8 MiB clip limit. No partial clip will be used.');
    // A seekable, private file lets ffprobe inspect every stream and FFmpeg decode
    // the complete bounded result. It is always removed before this call settles.
    temporary = await mkdtemp(join(dirname(filePath), '.learnlens-video-'));
    const copy = join(temporary, 'clip.mp4');
    await writeFile(copy, video, { flag: 'wx', mode: 0o600, signal: clock.signal });
    const output = parseProbe(await invoke(tools.ffprobe, probeArguments(copy, 'mp4', true), 256 * 1024), 'mp4');
    const tracks = verifyOutput(output, source, checkedPlan, bounds);
    const decoded = await invoke(tools.ffmpeg, decodeArguments(copy, checkedPlan.hasAudio), 256 * 1024);
    // FFmpeg's null-output progress follows its first mapped video, NOT the
    // longest stream. Comparing it to the container would reject intact late
    // audio. All tracks are fully decoded without -t; probe counts substantiate
    // audio duration independently, including audio beyond the video's end.
    const firstVideo = tracks.find(s => s.type === 'video');
    const frameCount = number(output.streams.find(s => s.codec_type === 'video').nb_read_frames);
    verifyDecode(decoded, firstVideo.end, firstVideo.tolerance, frameCount);
    if (retained) await verifyTimingIdentity(retained, filePath, extension, sourceHash, clock);
    clock.check();
    const warnings = [...checkedPlan.warnings];
    if (Math.abs(source.origin) > 0.001) warnings.push('A common source timestamp offset is normalized to the recording start; returned bounds remain relative to that recording start.');
    return {
      video: `data:video/mp4;base64,${video.toString('base64')}`,
      ...bounds, videoSha256: createHash('sha256').update(video).digest('hex'),
      analysisMode: 'whole-video', hasAudio: checkedPlan.hasAudio, hasVideo: true,
      images: [], text: '', warnings,
      byteLength: video.length, encodedDuration: output.duration, tracks,
      sourceStreams, sourceTimestampOrigin: source.origin,
      index, partCount: checkedPlan.partCount, sourceDuration: checkedPlan.duration,
    };
  } catch (error) {
    clock.check();
    if (error instanceof MediaImportError) throw error;
    fail('Could not prepare the private local video clip. Check the media file and available local storage.');
  } finally {
    try {
      if (temporary) await rm(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch { fail('Could not remove the private temporary video copy. Check local storage permissions.'); }
    finally { clock.close(); }
    // Cancellation/deadline during cleanup must not publish an apparently good clip.
    clock.check();
  }
}

export async function prepareVideoClip(filePath, extension, index, plan, options = {}) {
  return prepareClip(filePath, extension, index, plan, options);
}
export const __testing = Object.freeze({
  countParts, probeArguments, packetArguments, encodeArguments, decodeArguments, parseProbe,
  verifySource, verifyOutput, verifyDecode, timingTolerance, prepareClip, inspectSource, readPacketTiming,
  MAX_DURATION, MIN_TAIL, PROCESSING_TIMEOUT_MS, PACKET_MAX_BYTES, PACKET_MAX_COUNT,
});
