import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { ensureMediaTools, mediaChildEnvironment } from '../deploy/media-assets.mjs';
import { MediaImportError, inspectMedia, mediaInputArguments, runMediaProcess, validateMediaFile, __testing as legacy } from '../lib/native-media.mjs';
import { videoClipPlan, videoClipBounds, prepareVideoClip, VIDEO_CLIP_SECONDS, VIDEO_CLIP_MAX_BYTES, __testing as clips } from '../lib/video-clips.mjs';

const integration = process.env.LEARNLENS_MEDIA_INTEGRATION === '1';
const info = (duration = 61.25, hasAudio = true) => ({ duration, hasAudio, hasVideo: true });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const safeError = e => e instanceof MediaImportError && !/PRIVATE|secret|\.mp4|[A-Z]:\\|stderr/.test(e.message);
const jsonProbe = ({ duration = 30, audio = true, output = false, streams, ...format } = {}) => Buffer.from(JSON.stringify({
  format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', start_time: '0', duration: String(duration), ...format },
  streams: streams || [
    { index: 0, codec_type: 'video', codec_name: output ? 'h264' : 'mpeg4', width: 320, height: 180, start_time: '0', duration: String(duration), avg_frame_rate: '8/1', r_frame_rate: '8/1', nb_read_frames: String(duration * 8) },
    ...(audio ? [{ index: 1, codec_type: 'audio', codec_name: 'aac', start_time: '0', duration: String(duration), sample_rate: '48000', nb_read_frames: String(Math.ceil(duration * 48000 / 1024)) }] : []),
  ],
}));
const parse = options => clips.parseProbe(jsonProbe(options), 'mp4');
const progress = duration => Buffer.from(`frame=240\nout_time_us=${Math.round(duration * 1e6)}\nprogress=end\n`);
async function privateFixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'learnlens-video-unit-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'PRIVATE original & $(secret).mp4');
  await writeFile(file, 'synthetic test bytes, not a user original');
  return { dir, file };
}
function fakeTools(overrides = {}) {
  const calls = [], video = Buffer.from('bounded synthetic MP4 bytes');
  return {
    calls, video,
    acquire: async options => { assert.equal(options.offline, true); assert.ok(options.signal); return { ffmpeg: 'managed-ffmpeg', ffprobe: 'managed-ffprobe' }; },
    run: async (exe, args, options) => {
      calls.push({ exe, args, options });
      assert.ok(options.timeoutMs > 0 && options.timeoutMs <= clips.PROCESSING_TIMEOUT_MS);
      assert.ok(options.signal);
      if (exe === 'managed-ffprobe') return args.includes('-count_frames') ? jsonProbe({ output: true }) : jsonProbe();
      if (args.includes('-progress')) return progress(30);
      return video;
    },
    ...overrides,
  };
}

// Unit tests never acquire native tools or access the network.
test('whole-video plans cover the exact full timeline, including all four hours', () => {
  assert.equal(VIDEO_CLIP_SECONDS, 30);
  assert.equal(VIDEO_CLIP_MAX_BYTES, 8 * 1024 * 1024);
  for (const duration of [0.01, 0.499, 0.5, 29.9, 30, 30.000001, 30.499999, 30.5, 60, 60.25, 60.5, 61.25, 14399.999, 14400]) {
    const plan = videoClipPlan(info(duration));
    assert.equal(plan.version, 1); assert.equal(plan.mode, 'whole-video');
    assert.equal(plan.hasAudio, true); assert.equal(plan.hasVideo, true);
    let end = 0, total = 0;
    for (let index = 0; index < plan.partCount; index++) {
      const part = videoClipBounds(index, plan);
      assert.equal(part.start, end);
      assert.ok(part.end > part.start);
      assert.ok(part.end - part.start <= 30.5);
      if (index < plan.partCount - 1) assert.equal(part.end - part.start, 30);
      total += part.end - part.start; end = part.end;
    }
    assert.equal(end, duration); assert.equal(total, duration);
  }
  assert.equal(videoClipPlan(info(14400)).partCount, 480);
  assert.deepEqual(videoClipBounds(479, videoClipPlan(info(14400))), { start: 14370, end: 14400 });
  assert.deepEqual(videoClipBounds(2, videoClipPlan(info(61.25))), { start: 60, end: 61.25 });
});

test('tiny tails merge into the previous clip, but a 0.5-second tail remains', () => {
  const merged = videoClipPlan(info(60.125));
  assert.equal(merged.partCount, 2);
  assert.deepEqual(videoClipBounds(1, merged), { start: 30, end: 60.125 });
  assert.match(merged.warnings.join(' '), /merged/);
  assert.equal(videoClipPlan(info(60.5)).partCount, 3);
  assert.deepEqual(videoClipBounds(2, videoClipPlan(info(60.5))), { start: 60, end: 60.5 });
  assert.equal(videoClipPlan(info(0.125)).partCount, 1);
});

test('plans and bounds reject unsafe duration, booleans, version, count and indices', () => {
  const good = videoClipPlan(info());
  for (const duration of [0, -1, 14400.001, Infinity, -Infinity, NaN, '61.25', null, undefined, {}, true]) assert.throws(() => videoClipPlan({ ...info(), duration }), MediaImportError);
  for (const hasAudio of [0, 1, 'true', null, undefined]) assert.throws(() => videoClipPlan({ ...info(), hasAudio }), MediaImportError);
  for (const hasVideo of [false, 0, 1, 'true', null, undefined]) assert.throws(() => videoClipPlan({ ...info(), hasVideo }), MediaImportError);
  for (const bad of [null, {}, { ...good, version: 2 }, { ...good, mode: 'frames' }, { ...good, partCount: 2 }, { ...good, partCount: '3' }, { ...good, hasAudio: 1 }, { ...good, duration: 14401 }]) assert.throws(() => videoClipBounds(0, bad), MediaImportError);
  for (const index of [-1, 3, 0.1, Infinity, NaN, '0', null, undefined]) assert.throws(() => videoClipBounds(index, good), MediaImportError);
});

test('disclosures are honest and never echo caller warnings or source metadata', () => {
  const plan = videoClipPlan({ ...info(1, false), warnings: ['secret'], title: 'PRIVATE' });
  const warnings = plan.warnings.join(' ');
  assert.match(warnings, /source frame rate/);
  assert.match(warnings, /provider may sample/i);
  assert.match(warnings, /does not guarantee/);
  assert.match(warnings, /analysis copy.*1920×1080/);
  assert.match(warnings, /AAC.*timing/);
  assert.match(warnings, /no audio soundtrack/);
  assert.doesNotMatch(warnings, /secret|PRIVATE/);
});

test('safe helper aliases leave the entire legacy testing surface unchanged', () => {
  assert.equal(mediaInputArguments, legacy.inputArguments);
  assert.equal(runMediaProcess, legacy.runProcess);
  assert.equal(typeof validateMediaFile, 'function');
  assert.deepEqual(Object.keys(legacy).sort(), ['inputArguments', 'readProbe', 'partBounds', 'pcmWav', 'runProcess', 'MAX_DURATION', 'MAX_PIXELS'].sort());
});

test('command arguments preserve all tracks/FPS/timestamps, restrict IO and never truncate', () => {
  const source = 'C:/private/PRIVATE & $(secret).mp4';
  const args = clips.encodeArguments(source, '.MP4', { start: 30, end: 60.25 }, true);
  const at = flag => args[args.indexOf(flag) + 1];
  assert.equal(at('-ss'), '30'); assert.equal(at('-t'), '30.25');
  assert.equal(at('-i'), source);
  assert.equal(at('-protocol_whitelist'), 'file,pipe');
  assert.equal(at('-format_whitelist'), 'mov');
  assert.equal(at('-max_alloc'), '67108864'); assert.equal(at('-max_pixels'), '16777216');
  assert.equal(at('-max_streams'), '32'); assert.equal(at('-enable_drefs'), '0');
  assert.equal(at('-use_absolute_path'), '0');
  assert.equal(at('-c:v'), 'libopenh264'); assert.equal(at('-c:a'), 'aac');
  assert.equal(at('-b:v'), '1200000'); assert.equal(at('-maxrate:v'), '1500000');
  assert.equal(at('-b:a'), '64000'); assert.equal(at('-allow_skip_frames:v'), '0');
  assert.equal(at('-fps_mode:v'), 'passthrough'); assert.equal(at('-enc_time_base:v'), 'demux');
  assert.equal(at('-err_detect'), 'explode');
  assert.match(at('-vf'), /1920.*1080/); assert.doesNotMatch(at('-vf'), /fps|select|trim/);
  assert.deepEqual(args.flatMap((v, i) => v === '-map' ? [args[i + 1]] : []), ['0:V:0', '0:a:0']);
  for (const bad of ['-r', '-fs', '-shortest', '-frames:v', '-an', '-vn']) assert.equal(args.includes(bad), false);
  assert.deepEqual(args.slice(-3), ['-f', 'mp4', 'pipe:1']);
  assert.ok(clips.encodeArguments(source, 'mp4', { start: 0, end: 1 }, false).includes('-an'));
  for (const variant of [clips.probeArguments(source, 'mp4', true), clips.decodeArguments(source, true)]) {
    assert.ok(variant.includes('file,pipe'));
    for (const bad of ['-t', '-ss', '-shortest', '-frames:v']) assert.equal(variant.includes(bad), false);
  }
  assert.ok(clips.probeArguments(source, 'mp4', true).includes('-count_frames'));
});

test('probe and timeline validation fail closed, allowing only frame/AAC quantization', () => {
  for (const bytes of [Buffer.from('PRIVATE'), Buffer.from('null'), Buffer.from('{}'), jsonProbe({ format_name: 'hls' }), jsonProbe({ streams: [] }), jsonProbe({ duration: 14401 }), jsonProbe({ streams: [{ codec_type: 'video', codec_name: 'unknown', width: 2, height: 2 }] }), jsonProbe({ streams: [{ codec_type: 'video', codec_name: 'h264', width: 1e6, height: 1e6 }] })]) assert.throws(() => clips.parseProbe(bytes, 'mp4'), safeError);
  const plan = videoClipPlan(info(30));
  const source = parse(), output = parse({ output: true });
  const bounds = { start: 0, end: 30 };
  assert.equal(clips.verifyOutput(output, source, plan, bounds).length, 2);
  const quantized = structuredClone(output);
  for (const s of quantized.streams) { s.start_time = '0.021333'; s.duration = '30.016'; }
  quantized.duration = 30.037333;
  assert.doesNotThrow(() => clips.verifyOutput(quantized, source, plan, bounds));
  for (const mutate of [
    p => p.streams.pop(),
    p => { p.streams[0].duration = '29'; },
    p => { p.streams[1].duration = '28'; },
    p => { p.streams[0].start_time = '1'; },
    p => { p.streams[1].nb_read_frames = '0'; },
    p => { p.streams[1].nb_read_frames = '10'; },
    p => { p.streams[1].sample_rate = '44100'; },
    p => { p.streams[0].width = 1921; },
    p => { p.streams[0].height = 1082; },
    p => { p.streams[0].codec_name = 'mpeg4'; },
    p => { p.duration = 29; },
  ]) {
    const bad = structuredClone(output); mutate(bad);
    assert.throws(() => clips.verifyOutput(bad, source, plan, bounds), MediaImportError);
  }
  assert.throws(() => clips.verifySource(source, videoClipPlan(info(30, false))), /soundtrack/);
  assert.throws(() => clips.verifySource(source, videoClipPlan(info(28))), /duration/);
  assert.throws(() => clips.verifyDecode(Buffer.from('out_time_us=30000000\n'), 30, 0.1), /completely decode/);
  assert.throws(() => clips.verifyDecode(progress(29), 30, 0.1), /completely decode/);
  assert.doesNotThrow(() => clips.verifyDecode(progress(30.021333), 30, 0.1));
  assert.throws(() => clips.verifyDecode(progress(30), 30, 0.1, 241), /all of its frames/);
});

test('source validation rejects multiple tracks, missing timestamps and meaningful A/V gaps', () => {
  const plan = videoClipPlan(info(30));
  for (const mutate of [
    p => p.streams.push({ ...p.streams[0], index: 2 }),
    p => p.streams.push({ ...p.streams[1], index: 2 }),
    p => { p.streams[1].start_time = '1'; p.streams[1].duration = '29'; },
    p => { p.streams[0].duration = '28'; },
    p => { p.streams[1].duration = '28'; },
    p => { delete p.streams[1].duration; },
    p => { delete p.streams[0].start_time; },
  ]) {
    const source = parse(); mutate(source);
    assert.throws(() => clips.verifySource(source, plan), MediaImportError);
  }
  const offset = parse(); offset.origin = 10;
  for (const stream of offset.streams) stream.start_time = '10';
  const selected = clips.verifySource(offset, plan);
  assert.equal(selected.video.start, 0); assert.equal(selected.audio.start, 0);
  assert.equal(selected.video.end, 30); assert.equal(selected.audio.end, 30);
  const unknownFPS = parse(); unknownFPS.streams[0].avg_frame_rate = '9'.repeat(400) + '/1'; unknownFPS.streams[0].r_frame_rate = '0/0';
  assert.equal(clips.verifySource(unknownFPS, plan).video.framePeriod, null, 'do not invent a source frame rate');
  assert.ok(Number.isFinite(clips.timingTolerance(unknownFPS.streams[0])));
  const minor = parse(); minor.streams[0].duration = '29.875';
  assert.doesNotThrow(() => clips.verifySource(minor, plan), 'one frame of video quantization is allowed, not a meaningful gap');
  const artwork = JSON.parse(jsonProbe());
  artwork.streams.push({ index: 2, codec_type: 'video', codec_name: 'mjpeg', disposition: { attached_pic: 1 } });
  assert.doesNotThrow(() => clips.verifySource(clips.parseProbe(Buffer.from(JSON.stringify(artwork)), 'mp4'), plan));
});

test('output validation keeps relative timing and does not shorten a longer soundtrack', () => {
  const source = parse();
  source.streams[0].duration = '29';
  source.streams[1].start_time = '28'; source.streams[1].duration = '2'; source.streams[1].nb_read_frames = '94';
  const output = structuredClone(source); output.streams[0].codec_name = 'h264';
  assert.equal(clips.verifyOutput(output, source, videoClipPlan(info(30)), { start: 0, end: 30 }).length, 2);
  const dropped = structuredClone(output); dropped.streams[1].duration = '1'; dropped.duration = 29;
  assert.throws(() => clips.verifyOutput(dropped, source, videoClipPlan(info(30)), { start: 0, end: 30 }), /timestamps/);
});

test('public failures hide private paths, OS diagnostics and abort reasons before acquisition', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('unit tests must never fetch'));
  const controller = new AbortController(); controller.abort(new Error('secret'));
  await assert.rejects(prepareVideoClip('/PRIVATE.mp4', 'mp4', 0, videoClipPlan(info(30)), { signal: controller.signal }), e => e.name === 'AbortError' && !/secret/.test(e.message));
  for (const path of ['PRIVATE', join(tmpdir(), 'PRIVATE-does-not-exist.mp4')]) await assert.rejects(prepareVideoClip(path, 'mp4', 0, videoClipPlan(info(30))), safeError);
  await assert.rejects(prepareVideoClip('/PRIVATE.mp4', 'https', 0, videoClipPlan(info(30))), safeError);
});

test('bounded output is privately probed and completely decoded, hash matches, original stays unchanged', async t => {
  const { file, dir } = await privateFixture(t);
  const before = await readFile(file), beforeStat = await stat(file);
  const deps = fakeTools();
  const run = deps.run;
  deps.run = async (...args) => {
    if (args[1].includes('-count_frames') || args[1].includes('-progress')) {
      const temporary = args[1][args[1].indexOf('-i') + 1];
      assert.equal(dirname(dirname(temporary)), dir);
      assert.match(dirname(temporary), /\.learnlens-video-/);
      assert.deepEqual(await readFile(temporary), deps.video);
      if (process.platform !== 'win32') {
        assert.equal((await stat(temporary)).mode & 0o777, 0o600);
        assert.equal((await stat(dirname(temporary))).mode & 0o777, 0o700);
      }
    }
    return run(...args);
  };
  const result = await clips.prepareClip(file, 'mp4', 0, videoClipPlan(info(30)), {}, deps);
  assert.deepEqual(Buffer.from(result.video.split(',')[1], 'base64'), deps.video);
  assert.match(result.video, /^data:video\/mp4;base64,/);
  assert.equal(result.videoSha256, hash(deps.video)); assert.equal(result.byteLength, deps.video.length);
  assert.equal(result.analysisMode, 'whole-video'); assert.deepEqual(result.images, []); assert.equal(result.text, '');
  assert.equal(result.start, 0); assert.equal(result.end, 30);
  assert.equal(result.encodedDuration, 30); assert.equal(result.tracks.length, 2);
  assert.equal(result.hasAudio, true); assert.equal(result.hasVideo, true);
  assert.equal(result.sourceStreams.video.index, 0); assert.equal(result.sourceStreams.audio.index, 1);
  assert.equal(result.sourceStreams.video.framePeriod, 1 / 8);
  assert.equal(deps.calls.length, 4);
  assert.equal(deps.calls[1].options.maxBytes, VIDEO_CLIP_MAX_BYTES);
  for (let i = 1; i < deps.calls.length; i++) assert.ok(deps.calls[i].options.timeoutMs <= deps.calls[i - 1].options.timeoutMs);
  assert.deepEqual(await readdir(dir), [file.split(/[\\/]/).at(-1)]);
  assert.deepEqual(await readFile(file), before); assert.equal((await stat(file)).mtimeMs, beforeStat.mtimeMs);
});

test('overflow, missing tracks, malformed output, shortened tails and failed decoding never return a partial clip', async t => {
  const { file, dir } = await privateFixture(t);
  for (const fault of ['overflow', 'empty', 'missing-audio', 'bad-json', 'short-tail', 'decode-fail', 'decode-incomplete']) {
    const deps = fakeTools(), normal = deps.run;
    deps.run = async (exe, args, options) => {
      if (exe === 'managed-ffmpeg' && !args.includes('-progress')) {
        if (fault === 'overflow') return Buffer.alloc(VIDEO_CLIP_MAX_BYTES + 1);
        if (fault === 'empty') return Buffer.alloc(0);
      }
      if (args.includes('-count_frames')) {
        if (fault === 'missing-audio') return jsonProbe({ output: true, audio: false });
        if (fault === 'bad-json') return Buffer.from('PRIVATE source stderr');
        if (fault === 'short-tail') return jsonProbe({ output: true, duration: 29 });
      }
      if (args.includes('-progress')) {
        if (fault === 'decode-fail') throw new Error('PRIVATE path secret stderr');
        if (fault === 'decode-incomplete') return progress(28);
      }
      return normal(exe, args, options);
    };
    await assert.rejects(clips.prepareClip(file, 'mp4', 0, videoClipPlan(info(30)), {}, deps), safeError);
    assert.equal((await readdir(dir)).length, 1, `cleanup after ${fault}`);
  }
});

test('a shared deadline and cancellation await subprocess settlement and temporary cleanup', async t => {
  const { file, dir } = await privateFixture(t);
  for (const mode of ['cancel', 'deadline']) {
    const controller = new AbortController();
    const deps = fakeTools({ timeoutMs: mode === 'deadline' ? 300 : clips.PROCESSING_TIMEOUT_MS });
    const normal = deps.run; let stopped = false, settled = false;
    deps.run = async (exe, args, options) => {
      if (!args.includes('-progress')) return normal(exe, args, options);
      if (mode === 'cancel') queueMicrotask(() => controller.abort(new Error('PRIVATE secret')));
      await new Promise(resolve => {
        const finish = () => { stopped = true; setTimeout(() => { settled = true; resolve(); }, 5); };
        options.signal.addEventListener('abort', finish, { once: true });
        if (options.signal.aborted) finish();
      });
      throw new DOMException('PRIVATE', 'AbortError');
    };
    await assert.rejects(clips.prepareClip(file, 'mp4', 0, videoClipPlan(info(30)), { signal: controller.signal }, deps), e => mode === 'cancel' ? e.name === 'AbortError' && !/PRIVATE|secret/.test(e.message) : safeError(e) && /deadline/.test(e.message));
    assert.equal(stopped, true); assert.equal(settled, true);
    assert.equal((await readdir(dir)).length, 1);
  }
});

test('actual aliased subprocess runner enforces shell/env/output limits and awaits close', async t => {
  let killed = false, closed = false;
  const expected = mediaChildEnvironment();
  t.mock.method(childProcess, 'spawn', (_exe, args, options) => {
    assert.equal(options.shell, false); assert.equal(options.windowsHide, true);
    assert.deepEqual(options.env, expected);
    assert.equal(args.at(-1), 'pipe:1');
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => { killed = true; setImmediate(() => { closed = true; child.emit('close', 1); }); return true; };
    queueMicrotask(() => { child.stderr.write('PRIVATE secret stderr'); child.stdout.write(Buffer.alloc(VIDEO_CLIP_MAX_BYTES + 1)); });
    return child;
  });
  await assert.rejects(runMediaProcess('managed-ffmpeg', clips.encodeArguments('PRIVATE.mp4', 'mp4', { start: 0, end: 30 }, true), { maxBytes: VIDEO_CLIP_MAX_BYTES, timeoutMs: 1000 }), safeError);
  assert.equal(killed, true); assert.equal(closed, true);
});

// Opt in, offline ONLY. Every run synthesizes its own fixtures with cached,
// checksum-verified managed binaries. Never download, use PATH, or use originals.
test('offline native whole-video clips: full 61.25s AV, tail marker/tones, silent/unequal streams, corruption and cancellation', { skip: !integration, timeout: 240000 }, async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('native video tests are strictly offline'));
  const oldOffline = process.env.LEARNLENS_MEDIA_OFFLINE;
  process.env.LEARNLENS_MEDIA_OFFLINE = '1';
  t.after(() => { if (oldOffline === undefined) delete process.env.LEARNLENS_MEDIA_OFFLINE; else process.env.LEARNLENS_MEDIA_OFFLINE = oldOffline; });
  const tools = await ensureMediaTools({ offline: true });
  const dir = await mkdtemp(join(tmpdir(), 'learnlens-video-real-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const native = (exe, args, maxBytes = 256 * 1024) => runMediaProcess(exe, args, { maxBytes, timeoutMs: 90000 });
  const generate = async (name, args) => {
    const file = join(dir, name);
    await native(tools.ffmpeg, ['-hide_banner', '-v', 'error', '-nostdin', '-filter_threads', '1', '-filter_complex_threads', '1', ...args, '-threads', '2', '-y', file]);
    return file;
  };
  const av = await generate('synthetic-av.mp4', [
    '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=8:duration=61.25',
    '-f', 'lavfi', '-i', 'aevalsrc=0.15*sin(2*PI*440*t)+if(gte(t\\,60)\\,0.3*sin(2*PI*880*t)\\,0):s=48000:d=61.25',
    '-vf', "drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='gte(t,60)'",
    '-c:v', 'mpeg4', '-q:v', '5', '-c:a', 'aac', '-b:a', '96k',
  ]);
  const original = await readFile(av), originalStat = await stat(av);
  const plan = videoClipPlan(await inspectMedia(av, 'mp4'));
  assert.equal(plan.duration, 61.25); assert.equal(plan.partCount, 3);
  let frames = 0;
  for (let index = 0; index < plan.partCount; index++) {
    const result = await prepareVideoClip(av, 'mp4', index, plan);
    assert.deepEqual({ start: result.start, end: result.end }, videoClipBounds(index, plan));
    assert.deepEqual(result.images, []); assert.equal(result.text, ''); assert.equal(result.analysisMode, 'whole-video');
    assert.equal(result.hasAudio, true); assert.equal(result.sourceStreams.video.index, 0); assert.equal(result.sourceStreams.audio.index, 1);
    const bytes = Buffer.from(result.video.split(',')[1], 'base64');
    assert.ok(bytes.length <= VIDEO_CLIP_MAX_BYTES); assert.equal(result.videoSha256, hash(bytes));
    const output = join(dir, `checked-${index}.mp4`); await writeFile(output, bytes);
    const metadata = clips.parseProbe(await native(tools.ffprobe, clips.probeArguments(output, 'mp4', true)), 'mp4');
    const video = metadata.streams.find(s => s.codec_type === 'video');
    const audio = metadata.streams.find(s => s.codec_type === 'audio');
    assert.equal(video.codec_name, 'h264'); assert.equal(audio.codec_name, 'aac');
    assert.equal(video.r_frame_rate, '8/1');
    assert.ok(Math.abs(Number(video.duration) - (result.end - result.start)) < 0.15);
    assert.ok(Math.abs(Number(audio.duration) - (result.end - result.start)) < 0.05);
    // Independently decode every video frame, not just a thumbnail or header.
    const decoded = await native(tools.ffmpeg, [...mediaInputArguments('mp4'), '-nostdin', '-xerror', '-i', output, '-map', '0:V:0', '-an', '-fps_mode', 'passthrough', '-threads', '1', '-f', 'framemd5', 'pipe:1'], 1024 * 1024);
    const count = decoded.toString().split(/\r?\n/).filter(line => line && !line.startsWith('#')).length;
    assert.equal(count, Number(video.nb_read_frames)); frames += count;
    // Independently decode the complete soundtrack, including the terminal tone.
    const pcm = await native(tools.ffmpeg, [...mediaInputArguments('mp4'), '-nostdin', '-xerror', '-i', output, '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '48000', '-c:a', 'pcm_s16le', '-threads', '1', '-f', 's16le', 'pipe:1'], 4 * 1024 * 1024);
    assert.ok(Math.abs(pcm.length / 96000 - (result.end - result.start)) < 0.05);
    const sampleCount = 24000, offset = pcm.length / 2 - sampleCount;
    let sine = 0, cosine = 0;
    for (let i = 0; i < sampleCount; i++) {
      const value = pcm.readInt16LE((offset + i) * 2) / 32768;
      sine += value * Math.sin(2 * Math.PI * 880 * i / 48000);
      cosine += value * Math.cos(2 * Math.PI * 880 * i / 48000);
    }
    const lateTone = 2 * Math.hypot(sine, cosine) / sampleCount;
    if (index === 2) {
      assert.ok(lateTone > 0.1, `late 880Hz tone amplitude ${lateTone}`);
      const pixels = await native(tools.ffmpeg, [...mediaInputArguments('mp4'), '-nostdin', '-xerror', '-filter_threads', '1', '-i', output, '-an', '-vf', 'scale=1:1', '-pix_fmt', 'rgb24', '-fps_mode', 'passthrough', '-threads', '1', '-f', 'rawvideo', 'pipe:1']);
      assert.equal(pixels.length, 10 * 3);
      assert.ok([...pixels].every(value => value > 230), 'all ten tail frames retain the white visual marker');
    } else assert.ok(lateTone < 0.02);
    assert.deepEqual(await readFile(av), original); assert.equal((await stat(av)).mtimeMs, originalStat.mtimeMs);
    assert.ok(!(await readdir(dir)).some(name => name.startsWith('.learnlens-video-')));
    t.diagnostic(`Clip ${index + 1}: ${result.start}..${result.end}s, ${bytes.length} bytes, ${count} decoded video frames, ${(pcm.length / 96000).toFixed(6)}s decoded audio, SHA-256 ${result.videoSha256}.`);
  }
  assert.equal(frames, 490, 'all 490 source frames survive at 8fps, including 10 tail frames');

  const tiny = await generate('tiny-tail.mp4', [...mediaInputArguments('mp4'), '-i', av, '-t', '60.125', '-c', 'copy']);
  const tinyPlan = videoClipPlan(await inspectMedia(tiny, 'mp4'));
  assert.equal(tinyPlan.partCount, 2); assert.ok(tinyPlan.duration > 60 && tinyPlan.duration < 60.5);
  const merged = await prepareVideoClip(tiny, 'mp4', 1, tinyPlan);
  assert.equal(merged.end, tinyPlan.duration); assert.ok(merged.end - merged.start > 30);
  assert.match(merged.warnings.join(' '), /merged/);

  const silent = await generate('silent-large.mp4', ['-f', 'lavfi', '-i', 'color=c=blue:size=1922x1082:rate=8:duration=1.25', '-an', '-c:v', 'mpeg4', '-q:v', '8']);
  const silentBefore = hash(await readFile(silent));
  const silentPlan = videoClipPlan(await inspectMedia(silent, 'mp4'));
  assert.equal(silentPlan.hasAudio, false);
  const silentClip = await prepareVideoClip(silent, 'mp4', 0, silentPlan);
  assert.equal(silentClip.hasAudio, false); assert.equal(silentClip.sourceStreams.audio, undefined);
  assert.equal(silentClip.tracks.length, 1); assert.match(silentClip.warnings.join(' '), /no audio soundtrack/);
  assert.equal(hash(await readFile(silent)), silentBefore);
  const silentCopy = join(dir, 'checked-silent.mp4'); await writeFile(silentCopy, Buffer.from(silentClip.video.split(',')[1], 'base64'));
  const resized = clips.parseProbe(await native(tools.ffprobe, clips.probeArguments(silentCopy, 'mp4', true)), 'mp4').streams[0];
  assert.ok(resized.width <= 1920 && resized.height <= 1080); assert.equal(resized.width % 2, 0); assert.equal(resized.height % 2, 0);
  await assert.rejects(prepareVideoClip(silent, 'mp4', 0, videoClipPlan(info(silentPlan.duration, true))), /soundtrack/);

  const unequal = await generate('longer-audio.mp4', [
    '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=8:duration=2.125',
    '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=2.25',
    '-c:v', 'mpeg4', '-q:v', '5', '-c:a', 'aac',
  ]);
  const unequalPlan = videoClipPlan(await inspectMedia(unequal, 'mp4'));
  const unequalClip = await prepareVideoClip(unequal, 'mp4', 0, unequalPlan);
  const track = type => unequalClip.tracks.find(s => s.type === type);
  assert.ok(track('audio').end - track('video').end > 0.1, 'quantization-sized late audio beyond video end is not cut by -shortest');

  const gap = await generate('meaningful-video-gap.mp4', [
    '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=8:duration=2',
    '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=3',
    '-c:v', 'mpeg4', '-q:v', '5', '-c:a', 'aac',
  ]);
  await assert.rejects(prepareVideoClip(gap, 'mp4', 0, videoClipPlan(await inspectMedia(gap, 'mp4'))), /complete recording timeline/);
  const delayed = await generate('delayed-soundtrack.mp4', [
    '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=8:duration=3',
    '-itsoffset', '1', '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=2',
    '-c:v', 'mpeg4', '-q:v', '5', '-c:a', 'aac',
  ]);
  await assert.rejects(prepareVideoClip(delayed, 'mp4', 0, videoClipPlan(await inspectMedia(delayed, 'mp4'))), /complete recording timeline/);
  for (const type of ['audio', 'video']) {
    const multiple = await generate(`multiple-${type}.mp4`, [...mediaInputArguments('mp4'), '-i', av, '-map', '0:v:0', '-map', '0:a:0', '-map', type === 'audio' ? '0:a:0' : '0:v:0', '-c', 'copy']);
    await assert.rejects(prepareVideoClip(multiple, 'mp4', 0, plan), /Multiple tracks/);
  }

  const corrupt = join(dir, 'PRIVATE-corrupt.mp4'); await writeFile(corrupt, 'PRIVATE source is not video');
  await assert.rejects(prepareVideoClip(corrupt, 'mp4', 0, plan), safeError);

  const controller = new AbortController(); const originalSpawn = childProcess.spawn;
  let killed = false, closed = false;
  const mock = t.mock.method(childProcess, 'spawn', (...args) => {
    const child = originalSpawn(...args);
    if (args[1].includes('-progress')) {
      const kill = child.kill.bind(child);
      child.kill = (...values) => { killed = true; return kill(...values); };
      child.once('close', () => { closed = true; });
      queueMicrotask(() => controller.abort(new Error('PRIVATE abort reason')));
    }
    return child;
  });
  await assert.rejects(prepareVideoClip(av, 'mp4', 0, plan, { signal: controller.signal }), e => e.name === 'AbortError' && !/PRIVATE/.test(e.message));
  mock.mock.restore();
  assert.equal(killed, true); assert.equal(closed, true);
  assert.ok(!(await readdir(dir)).some(name => name.startsWith('.learnlens-video-')));
  assert.deepEqual(await readFile(av), original); assert.equal((await stat(av)).mtimeMs, originalStat.mtimeMs);
  t.diagnostic(`Silent analysis copy ${resized.width}×${resized.height}; merged-tail interval ${merged.start}..${merged.end}s; longer-audio output video=${track('video').end.toFixed(6)}s audio=${track('audio').end.toFixed(6)}s. Originals unchanged; native cancellation closed and cleaned.`);
});
