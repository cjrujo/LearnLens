import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, stat, readdir, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import childProcess from 'node:child_process';
import { ensureMediaTools } from '../deploy/media-assets.mjs';
import { inspectMedia, mediaInputArguments, runMediaProcess, MediaImportError } from '../lib/native-media.mjs';
import { inspectWholeVideoSource, prepareVideoClip, videoClipPlan, videoClipBounds, __testing as clips } from '../lib/video-clips.mjs';

const integration = process.env.LEARNLENS_MEDIA_INTEGRATION === '1';
const hash = value => createHash('sha256').update(value).digest('hex');
const info = (duration = 31.25, hasAudio = true) => ({ duration, hasAudio, hasVideo: true, partCount: Math.ceil(duration / 180) });
const safeError = e => e instanceof MediaImportError && !/PRIVATE|secret|\.webm|[A-Z]:\\|stderr/.test(e.message);
const packet = (index, pts, duration) => `packet|stream_index=${index}|pts_time=${pts}|duration_time=${duration}\n`;
const packets = (duration = 31.25) => Buffer.from(packet(1, '-0.007000', '0.020000') + packet(0, 0, 0.125) + packet(1, duration - 0.02, 0.02) + packet(0, duration - 0.125, 0.125));
function probe(duration = 31.25, audio = true, output = false) {
  return { format: { format_name: output ? 'mov,mp4,m4a,3gp,3g2,mj2' : 'matroska,webm', start_time: '0', duration: String(duration) }, streams: [
    { index: 0, codec_type: 'video', codec_name: output ? 'h264' : 'vp9', width: 160, height: 90, start_time: '0', avg_frame_rate: '8/1', r_frame_rate: '8/1', tags: { DURATION: '00:00:31.250000000' }, ...(output ? { duration: String(duration), nb_read_frames: String(duration * 8) } : {}) },
    ...(audio ? [{ index: 1, codec_type: 'audio', codec_name: output ? 'aac' : 'opus', start_time: '0', sample_rate: '48000', ...(output ? { duration: String(duration), nb_read_frames: String(Math.ceil(duration * 48000 / 1024)) } : {}) }] : []),
  ] };
}
const encoded = value => Buffer.from(JSON.stringify(value));
const isPacketScan = args => args.some(arg => arg.startsWith('packet=stream_index'));
const parse = value => clips.parseProbe(encoded(value), 'webm');
const clock = { check() {} };
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'learnlens-timing-unit-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'PRIVATE synthetic source.webm');
  const bytes = Buffer.from('synthetic source, never user media');
  await writeFile(file, bytes);
  return { dir, file, sourceHash: hash(bytes) };
}
function fakeTools(source = probe()) {
  const calls = []; let interval = 30;
  return {
    calls,
    acquire: async options => { assert.equal(options.offline, true); assert.ok(options.signal); return { ffprobe: 'managed-ffprobe', ffmpeg: 'managed-ffmpeg' }; },
    run: async (exe, args, options) => {
      calls.push({ exe, args, options });
      assert.ok(options.signal); assert.ok(options.timeoutMs > 0 && options.timeoutMs <= clips.PROCESSING_TIMEOUT_MS);
      if (isPacketScan(args)) return packets(Number(source.format.duration));
      if (exe === 'managed-ffprobe') return encoded(args.includes('-count_frames') ? probe(interval, source.streams.length === 2, true) : source);
      if (args.includes('-progress')) return Buffer.from(`frame=${interval * 8}\nout_time_us=${Math.round(interval * 1e6)}\nprogress=end\n`);
      interval = Number(args[args.indexOf('-t') + 1]);
      return Buffer.from('bounded synthetic MP4');
    },
  };
}

test('packet scan commands retain hardened IO and request actual numeric packet evidence only', () => {
  const args = clips.packetArguments('C:/PRIVATE.webm', 'webm');
  assert.equal(args[args.indexOf('-protocol_whitelist') + 1], 'file,pipe');
  assert.equal(args[args.indexOf('-format_whitelist') + 1], 'matroska');
  assert.equal(args[args.indexOf('-err_detect') + 1], 'explode');
  assert.equal(args[args.indexOf('-show_entries') + 1], 'packet=stream_index,pts_time,duration_time:packet_side_data=');
  for (const flag of ['-ss', '-t', '-read_intervals', '-count_frames', '-show_data', '-select_streams']) assert.equal(args.includes(flag), false);
  assert.doesNotMatch(args.join(' '), /DURATION|stream_tags/);
  const mp4 = clips.packetArguments('C:/PRIVATE.mp4', 'mp4');
  assert.ok(mp4.includes('-enable_drefs')); assert.ok(mp4.includes('-use_absolute_path'));
  assert.equal(clips.PACKET_MAX_BYTES, 128 * 1024 * 1024);
  assert.equal(clips.PACKET_MAX_COUNT, 2_000_000);
});

test('packet timing uses min PTS / max PTS+duration, not packet order, DTS or rounded seconds', async () => {
  const source = parse(probe(0.375));
  const bytes = Buffer.from(packet(1, '-0.007000', '0.020000') + packet(0, '0.000000', '0.125000') + packet(0, '0.250000', '0.125000') + packet(1, '0.354000', '0.020000') + packet(0, '0.125000', '0.125000'));
  const tracks = await clips.readPacketTiming(bytes, source, clock);
  assert.deepEqual(tracks[0], { index: 0, timestampStart: 0, duration: 0.375, packets: 3 });
  assert.equal(tracks[1].timestampStart, -0.007);
  assert.ok(Math.abs(tracks[1].duration - 0.381) < 1e-12);
  // Empty side-data sections on the first/last Opus packet are not timing data.
  const withSideSection = Buffer.from(bytes.toString().replaceAll('\n', '|\r\n'));
  assert.deepEqual(await clips.readPacketTiming(withSideSection, source, clock), tracks);
});

test('packet evidence rejects missing timing, non-derivable ends, missing tracks, malformed and oversized records', async () => {
  const source = parse(probe());
  for (const bytes of [
    Buffer.alloc(0), Buffer.from('DURATION=00:00:31.250000000\n'),
    Buffer.from(packet(0, 0, 0.125)),
    Buffer.from(packet(0, 'N/A', '0.125000') + packet(1, 0, 1)),
    Buffer.from(packet(0, 0, 'N/A') + packet(1, 0, 1)),
    Buffer.from(packet(0, 0, 0) + packet(1, 0, 1)),
    Buffer.from(packet(0, 0, -1) + packet(1, 0, 1)),
    Buffer.from(packet(0, 'NaN', 1) + packet(1, 0, 1)),
    Buffer.from(packet(0, 'Infinity', 1) + packet(1, 0, 1)),
    Buffer.from(packet(0, 14401, 1) + packet(1, 0, 1)),
    Buffer.from(packet(0, 0, 14401) + packet(1, 0, 1)),
    Buffer.from(packet(32, 0, 1)), Buffer.from('x'.repeat(193) + '\n'),
    Buffer.from(packets().toString().trimEnd()),
  ]) await assert.rejects(clips.readPacketTiming(bytes, source, clock), safeError);
  const wrongStart = parse(probe()); wrongStart.streams[0].start_time = '2';
  await assert.rejects(clips.readPacketTiming(packets(), wrongStart, clock), /conflicts/);
  const wrongEnd = parse(probe()); wrongEnd.streams[0].duration = '10';
  await assert.rejects(clips.readPacketTiming(packets(), wrongEnd, clock), /conflicts/);
});

test('import hook produces bounded immutable clone-safe timing and clips never rescan the original', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('unit tests are offline'));
  const { file, sourceHash } = await fixture(t), deps = fakeTools();
  const inspected = await clips.inspectSource(file, 'webm', info(), { sourceHash }, deps);
  assert.equal(inspected.partCount, 1, 'native-media 180s count is not changed');
  assert.ok(Object.isFrozen(inspected.sourceTiming));
  assert.ok(Buffer.byteLength(JSON.stringify(inspected.sourceTiming)) < 8192);
  assert.throws(() => { inspected.sourceTiming.payload = '{}'; }, TypeError);
  const plan = videoClipPlan(structuredClone(inspected));
  assert.equal(plan.partCount, 2); assert.ok(Object.isFrozen(plan.sourceTiming));
  assert.deepEqual(plan.sourceTiming, inspected.sourceTiming);
  const scans = () => deps.calls.filter(c => isPacketScan(c.args));
  assert.equal(scans().length, 1);
  assert.equal(scans()[0].options.maxBytes, clips.PACKET_MAX_BYTES);
  assert.ok(scans()[0].options.timeoutMs <= deps.calls[0].options.timeoutMs);
  for (let index = 0; index < plan.partCount; index++) {
    const result = await clips.prepareClip(file, 'webm', index, plan, { sourceHash }, deps);
    assert.deepEqual({ start: result.start, end: result.end }, videoClipBounds(index, plan));
    assert.equal(result.sourceStreams.audio.timestampStart, -0.007);
    assert.equal(result.sourceStreams.video.end, 31.25);
    assert.equal(result.sourceTiming, undefined);
    assert.equal(result.partCount, 2);
  }
  assert.equal(scans().length, 1, 'the two clips use retained timing, not additional whole-source scans');
  assert.equal(deps.calls.filter(c => c.args.includes('-progress')).length, 2, 'each output is still completely decoded');
  assert.equal(hash(await readFile(file)), sourceHash);
});

test('missing start timestamps are derived from packets; common offsets and the exact four-hour bound are retained', async t => {
  const { file } = await fixture(t), source = probe();
  source.streams.forEach(s => { delete s.start_time; });
  const deps = fakeTools(source);
  const plan = videoClipPlan(await clips.inspectSource(file, 'webm', info(), {}, deps));
  const result = await clips.prepareClip(file, 'webm', 1, plan, {}, deps);
  assert.equal(result.sourceStreams.audio.timestampStart, -0.007);
  assert.equal(result.sourceStreams.video.timestampStart, 0);
  const offset = parse(probe()); offset.origin = 10;
  offset.streams.forEach(s => { s.start_time = '10'; });
  const shifted = Buffer.from(packet(0, 10, 0.125) + packet(0, 41.125, 0.125) + packet(1, 9.993, 0.02) + packet(1, 41.23, 0.02));
  const tracks = await clips.readPacketTiming(shifted, offset, clock);
  const restored = { ...offset, streams: offset.streams.map(s => ({ ...s, start_time: tracks[s.index].timestampStart, duration: tracks[s.index].duration })) };
  const selected = clips.verifySource(restored, info());
  assert.equal(selected.video.start, 0); assert.equal(selected.video.end, 31.25);
  const full = parse(probe(14400, false));
  const complete = await clips.readPacketTiming(Buffer.from(packet(0, 0, 0.125) + packet(0, 14399.875, 0.125)), full, clock);
  assert.equal(complete[0].duration, 14400);
  await assert.rejects(clips.readPacketTiming(Buffer.from(packet(0, 0, 0.125) + packet(0, 14400, 1)), full, clock), /complete track/);
  const duplicate = probe(); duplicate.streams[1].index = 0;
  assert.throws(() => parse(duplicate), /index/);
});

test('complete stream timestamps skip packet scan; missing timestamps without retained evidence still fail', async t => {
  const { file, sourceHash } = await fixture(t);
  const source = probe(); source.streams.forEach(s => { s.duration = '31.25'; });
  const deps = fakeTools(source);
  const inspected = await clips.inspectSource(file, 'webm', info(), { sourceHash }, deps);
  assert.equal(deps.calls.length, 1);
  assert.equal(JSON.parse(inspected.sourceTiming.payload).tracks[0].packets, null);
  const uninspected = fakeTools();
  await assert.rejects(clips.prepareClip(file, 'webm', 0, videoClipPlan(info()), {}, uninspected), /timestamps are unavailable/);
  assert.equal(uninspected.calls.length, 1, 'do not opportunistically scan on every clip request');
});

test('forged/cloned-edited metadata, changed interval/profile/hash/file and track profiles fail closed', async t => {
  const { dir, file, sourceHash } = await fixture(t), deps = fakeTools();
  const inspected = await clips.inspectSource(file, 'webm', info(), { sourceHash }, deps);
  const plan = videoClipPlan(inspected);
  for (const sourceTiming of [null, {}, { version: 1, payload: '{}', seal: '0'.repeat(64) },
    { ...plan.sourceTiming, payload: plan.sourceTiming.payload.replace('31.25', '31.26') },
    { ...plan.sourceTiming, payload: 'x'.repeat(8193) }, { ...plan.sourceTiming, extra: true },
    { ...plan.sourceTiming, version: 2 },
  ]) assert.throws(() => videoClipPlan({ ...info(), sourceTiming }), safeError);
  for (const change of [{ duration: 31.5 }, { hasAudio: false }]) assert.throws(() => videoClipPlan({ ...inspected, ...change }), /clip profile or interval/);
  await assert.rejects(clips.prepareClip(file, 'webm', 0, plan, { sourceHash: '0'.repeat(64) }, deps), /identity changed/);
  await assert.rejects(clips.prepareClip(file, 'mp4', 0, plan, {}, deps), /identity changed/);
  const other = join(dir, 'other.webm'); await writeFile(other, await readFile(file));
  await assert.rejects(clips.prepareClip(other, 'webm', 0, plan, {}, deps), /identity changed/);
  for (const mutate of [
    p => { p.streams[0].width = 320; },
    p => { p.streams[0].codec_name = 'vp8'; },
    p => { p.streams[0].avg_frame_rate = '24/1'; },
    p => { p.streams[1].start_time = '1'; },
    p => { p.streams[1].sample_rate = '44100'; },
    p => { p.streams[0].index = 2; },
    p => { p.format.start_time = '1'; },
    p => { p.streams.pop(); },
  ]) {
    const changed = probe(); mutate(changed);
    await assert.rejects(clips.prepareClip(file, 'webm', 0, plan, {}, fakeTools(changed)), /profile changed/);
  }
  const previous = await stat(file); await utimes(file, previous.atime, new Date(previous.mtimeMs + 1000));
  await assert.rejects(clips.prepareClip(file, 'webm', 0, plan, {}, deps), /identity changed/);
});

test('source mutation during encode is detected before publishing even an otherwise valid output', async t => {
  const { file, sourceHash } = await fixture(t), deps = fakeTools();
  const plan = videoClipPlan(await clips.inspectSource(file, 'webm', info(), { sourceHash }, deps));
  const normal = deps.run;
  deps.run = async (...args) => {
    const result = await normal(...args);
    if (args[1].includes('-progress')) await writeFile(file, 'changed original, test fixture only');
    return result;
  };
  await assert.rejects(clips.prepareClip(file, 'webm', 0, plan, {}, deps), /identity changed/);
});

test('import rejects meaningful gaps, contradictory AV, multiple tracks and incorrect hashes rather than using DURATION tags', async t => {
  const { file, sourceHash } = await fixture(t);
  for (const mutate of [p => p.streams.push({ ...p.streams[0], index: 2 }), p => p.streams.push({ ...p.streams[1], index: 2 })]) {
    const source = probe(); mutate(source);
    const deps = fakeTools(source);
    await assert.rejects(clips.inspectSource(file, 'webm', info(), { sourceHash }, deps), /Multiple tracks/);
    assert.equal(deps.calls.length, 1);
  }
  await assert.rejects(clips.inspectSource(file, 'webm', info(31.25, false), {}, fakeTools()), /soundtrack/);
  await assert.rejects(clips.inspectSource(file, 'webm', info(), { sourceHash: '0'.repeat(64) }, fakeTools()), /identity changed/);
  await assert.rejects(clips.inspectSource(file, 'webm', info(), { sourceHash: 'PRIVATE' }, fakeTools()), safeError);
  for (const body of [
    packet(0, 0, 30) + packet(1, 0, 31.25),
    packet(0, 0, 31.25) + packet(1, 0, 30),
    packet(0, 0, 31.25) + packet(1, 1, 30.25),
  ]) {
    const deps = fakeTools(), normal = deps.run;
    deps.run = (exe, args, options) => isPacketScan(args) ? Buffer.from(body) : normal(exe, args, options);
    await assert.rejects(clips.inspectSource(file, 'webm', info(), { sourceHash }, deps), /complete recording timeline|conflicts/);
  }
});

test('one import deadline covers acquisition and packet scan; cancellation waits for the scan to settle', async t => {
  const { file } = await fixture(t);
  for (const mode of ['cancel', 'deadline']) {
    const controller = new AbortController(), deps = fakeTools();
    deps.timeoutMs = mode === 'deadline' ? 100 : clips.PROCESSING_TIMEOUT_MS;
    const normal = deps.run; let settled = false;
    deps.run = async (exe, args, options) => {
      if (!isPacketScan(args)) return normal(exe, args, options);
      if (mode === 'cancel') queueMicrotask(() => controller.abort(new Error('PRIVATE secret')));
      await new Promise(resolve => {
        const stop = () => setImmediate(() => { settled = true; resolve(); });
        options.signal.addEventListener('abort', stop, { once: true });
        if (options.signal.aborted) stop();
      });
      throw new DOMException('PRIVATE stderr', 'AbortError');
    };
    await assert.rejects(clips.inspectSource(file, 'webm', info(), { signal: controller.signal }, deps), error => mode === 'cancel' ? error.name === 'AbortError' && !/PRIVATE|secret/.test(error.message) : safeError(error) && /deadline/.test(error.message));
    assert.equal(settled, true);
  }
  const aborted = new AbortController(); aborted.abort('PRIVATE secret');
  await assert.rejects(inspectWholeVideoSource(file, 'webm', info(), { signal: aborted.signal }), error => error.name === 'AbortError' && !/PRIVATE|secret/.test(error.message));
});

// Large-buffer ceiling tests are opt-in alongside native tests, keeping routine
// unit runs light. Buffers are generated numeric fixtures, not retained originals.
test('hard packet and stdout ceilings reject oversized scans instead of returning partial timing', { skip: !integration, timeout: 30000 }, async () => {
  await assert.rejects(clips.readPacketTiming(Buffer.allocUnsafe(clips.PACKET_MAX_BYTES + 1), parse(probe()), clock), /inspection limit/);
  const body = Buffer.from(packet(2, 0, 1).repeat(clips.PACKET_MAX_COUNT + 1));
  assert.ok(body.length < clips.PACKET_MAX_BYTES, 'packet ceiling is independently enforced below the byte ceiling');
  await assert.rejects(clips.readPacketTiming(body, parse(probe()), clock), /packet limit/);
});

// Uses only checksum-verified cached tools, generated fixtures and private temp
// directories. Enabling this suite must never download, use PATH or touch originals.
test('offline real WebM: once-only packet scan, every clip/frame, final white marker and late tone, silent and rejection cases', { skip: !integration, timeout: 300000 }, async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('native WebM tests are strictly offline'));
  const oldOffline = process.env.LEARNLENS_MEDIA_OFFLINE; process.env.LEARNLENS_MEDIA_OFFLINE = '1';
  t.after(() => { if (oldOffline === undefined) delete process.env.LEARNLENS_MEDIA_OFFLINE; else process.env.LEARNLENS_MEDIA_OFFLINE = oldOffline; });
  const tools = await ensureMediaTools({ offline: true });
  const dir = await mkdtemp(join(tmpdir(), 'learnlens-timing-native-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const native = (exe, args, maxBytes = 256 * 1024) => runMediaProcess(exe, args, { maxBytes, timeoutMs: 90000 });
  const generate = async (name, args) => {
    const file = join(dir, name);
    await native(tools.ffmpeg, ['-hide_banner', '-v', 'error', '-nostdin', '-filter_threads', '1', '-filter_complex_threads', '1', ...args, '-threads', '2', '-y', file]);
    return file;
  };
  const bframes = await generate('reordered.mp4', ['-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=8:duration=1.25', '-an', '-c:v', 'mpeg4', '-bf', '2']);
  const reorderedSource = clips.parseProbe(await native(tools.ffprobe, clips.probeArguments(bframes, 'mp4')), 'mp4');
  const reorderedPackets = await native(tools.ffprobe, clips.packetArguments(bframes, 'mp4'));
  const presentationTimes = [...reorderedPackets.toString().matchAll(/pts_time=(-?[\d.]+)/g)].map(m => Number(m[1]));
  assert.ok(presentationTimes.some((pts, i) => i && pts < presentationTimes[i - 1]), 'real B-frame packet PTS are reordered');
  const reorderedTiming = await clips.readPacketTiming(reorderedPackets, reorderedSource, clock);
  assert.equal(reorderedTiming[0].timestampStart, 0); assert.equal(reorderedTiming[0].duration, 1.25);
  const videoCodec = ['-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-threads:v', '2'];
  const av = await generate('synthetic-av.webm', [
    '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=8:duration=61.25',
    '-f', 'lavfi', '-i', 'aevalsrc=0.15*sin(2*PI*440*t)+if(gte(t\\,60)\\,0.3*sin(2*PI*880*t)\\,0):s=48000:d=61.25',
    '-vf', "drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='gte(t,60)'",
    ...videoCodec, '-c:a', 'libopus', '-b:a', '96000',
  ]);
  const sourceHash = hash(await readFile(av)), before = await stat(av);
  const rawProbe = clips.parseProbe(await native(tools.ffprobe, clips.probeArguments(av, 'webm')), 'webm');
  assert.ok(rawProbe.streams.every(s => s.duration === undefined), 'actual WebM has no stream duration fields');
  const oldInfo = await inspectMedia(av, 'webm');
  await assert.rejects(prepareVideoClip(av, 'webm', 0, videoClipPlan(oldInfo)), /timestamps are unavailable/, 'real pre-fix failure reproduced');
  let scans = 0;
  const originalSpawn = childProcess.spawn;
  const observe = t.mock.method(childProcess, 'spawn', (exe, args, options) => {
    if (isPacketScan(args)) scans++;
    return originalSpawn(exe, args, options);
  });
  const inspected = await inspectWholeVideoSource(av, 'webm', oldInfo, { sourceHash });
  const plan = videoClipPlan(structuredClone(inspected));
  assert.equal(plan.partCount, 3); assert.equal(scans, 1);
  const retained = JSON.parse(plan.sourceTiming.payload);
  assert.equal(retained.sourceHash, sourceHash);
  assert.equal(retained.tracks[0].packets, 490);
  assert.ok(retained.tracks[1].timestampStart < 0, 'negative Opus codec-delay timestamp is retained');
  let frames = 0;
  for (let index = 0; index < plan.partCount; index++) {
    const result = await prepareVideoClip(av, 'webm', index, plan, { sourceHash });
    assert.deepEqual({ start: result.start, end: result.end }, videoClipBounds(index, plan));
    assert.equal(result.hasAudio, true); assert.equal(result.sourceStreams.video.codec, 'vp9');
    assert.equal(result.sourceStreams.audio.codec, 'opus');
    const bytes = Buffer.from(result.video.split(',')[1], 'base64');
    assert.equal(result.videoSha256, hash(bytes));
    const output = join(dir, `clip-${index}.mp4`); await writeFile(output, bytes);
    const metadata = clips.parseProbe(await native(tools.ffprobe, clips.probeArguments(output, 'mp4', true)), 'mp4');
    const video = metadata.streams.find(s => s.codec_type === 'video');
    assert.equal(video.codec_name, 'h264'); assert.equal(video.r_frame_rate, '8/1');
    const decoded = await native(tools.ffmpeg, [...mediaInputArguments('mp4'), '-nostdin', '-xerror', '-i', output, '-map', '0:V:0', '-an', '-fps_mode', 'passthrough', '-threads', '1', '-f', 'framemd5', 'pipe:1'], 1024 * 1024);
    const count = decoded.toString().split(/\r?\n/).filter(line => line && !line.startsWith('#')).length;
    assert.equal(count, Number(video.nb_read_frames)); assert.equal(count, index === 2 ? 10 : 240); frames += count;
    const pcm = await native(tools.ffmpeg, [...mediaInputArguments('mp4'), '-nostdin', '-xerror', '-i', output, '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '48000', '-c:a', 'pcm_s16le', '-threads', '1', '-f', 's16le', 'pipe:1'], 4 * 1024 * 1024);
    assert.ok(Math.abs(pcm.length / 96000 - (result.end - result.start)) < 0.05);
    const samples = 24000, offset = pcm.length / 2 - samples;
    let sine = 0, cosine = 0;
    for (let i = 0; i < samples; i++) {
      const value = pcm.readInt16LE((offset + i) * 2) / 32768;
      sine += value * Math.sin(2 * Math.PI * 880 * i / 48000);
      cosine += value * Math.cos(2 * Math.PI * 880 * i / 48000);
    }
    const amplitude = 2 * Math.hypot(sine, cosine) / samples;
    if (index === 2) {
      assert.ok(amplitude > 0.1, `late tone amplitude ${amplitude}`);
      const pixels = await native(tools.ffmpeg, [...mediaInputArguments('mp4'), '-nostdin', '-xerror', '-filter_threads', '1', '-i', output, '-an', '-vf', 'scale=1:1', '-pix_fmt', 'rgb24', '-fps_mode', 'passthrough', '-threads', '1', '-f', 'rawvideo', 'pipe:1']);
      assert.equal(pixels.length, 30);
      assert.ok([...pixels].every(value => value > 230), 'all ten terminal frames retain their white marker');
    } else assert.ok(amplitude < 0.02);
    assert.equal(hash(await readFile(av)), sourceHash); assert.equal((await stat(av)).mtimeMs, before.mtimeMs);
    t.diagnostic(`WebM clip ${index}: ${result.start}..${result.end}s; ${count} frames; ${(pcm.length / 96000).toFixed(6)}s audio; 880Hz amplitude ${amplitude.toFixed(6)}; ${bytes.length} bytes; SHA-256 ${result.videoSha256}.`);
  }
  assert.equal(frames, 490); assert.equal(scans, 1, 'three prepared intervals do not rescan the original');
  observe.mock.restore();
  const silent = await generate('silent.webm', ['-f', 'lavfi', '-i', 'color=c=blue:size=160x90:rate=8:duration=1.25', '-an', ...videoCodec]);
  const silentHash = hash(await readFile(silent));
  const silentInfo = await inspectMedia(silent, 'webm');
  const silentPlan = videoClipPlan(await inspectWholeVideoSource(silent, 'webm', silentInfo, { sourceHash: silentHash }));
  const silentClip = await prepareVideoClip(silent, 'webm', 0, silentPlan);
  assert.equal(silentClip.hasAudio, false); assert.equal(silentClip.tracks.length, 1);
  assert.equal(silentClip.sourceStreams.audio, undefined); assert.match(silentClip.warnings.join(' '), /no audio soundtrack/);
  assert.equal(hash(await readFile(silent)), silentHash);
  await assert.rejects(inspectWholeVideoSource(silent, 'webm', { ...silentInfo, hasAudio: true }), /soundtrack/);
  for (const variant of ['delayed-audio', 'short-audio', 'short-video']) {
    const file = await generate(`${variant}.webm`, [
      '-f', 'lavfi', '-i', `testsrc2=size=160x90:rate=8:duration=${variant === 'short-video' ? 2 : 3}`,
      ...(variant === 'delayed-audio' ? ['-itsoffset', '1'] : []),
      '-f', 'lavfi', '-i', `sine=frequency=880:sample_rate=48000:duration=${variant === 'short-video' ? 3 : 2}`,
      ...videoCodec, '-c:a', 'libopus',
    ]);
    const originalHash = hash(await readFile(file));
    await assert.rejects(inspectWholeVideoSource(file, 'webm', await inspectMedia(file, 'webm')), /complete recording timeline|conflicts/);
    assert.equal(hash(await readFile(file)), originalHash);
  }
  for (const type of ['audio', 'video']) {
    const file = await generate(`multiple-${type}.webm`, [...mediaInputArguments('webm'), '-i', av, '-map', '0:v:0', '-map', '0:a:0', '-map', type === 'audio' ? '0:a:0' : '0:v:0', '-c', 'copy']);
    await assert.rejects(inspectWholeVideoSource(file, 'webm', await inspectMedia(file, 'webm')), /Multiple tracks/);
  }
  assert.ok(!(await readdir(dir)).some(name => name.startsWith('.learnlens-video-')));
  assert.equal(hash(await readFile(av)), sourceHash);
  t.diagnostic(`Original WebM SHA-256 ${sourceHash}, unchanged; ${frames} frames retained; packet scans for three clips = ${scans}; silent SHA-256 ${silentHash}, unchanged.`);
});
