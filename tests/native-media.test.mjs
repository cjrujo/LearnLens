import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import { ensureMediaTools, mediaChildEnvironment, MediaImportError, __testing as assets } from '../deploy/media-assets.mjs';
import { inspectMedia, prepareMediaPart, MEDIA_SEGMENT_SECONDS, __testing as media } from '../lib/native-media.mjs';

const integration = process.env.LEARNLENS_MEDIA_INTEGRATION === '1';
const aborted = () => { const controller = new AbortController(); controller.abort(new Error('secret abort reason')); return controller.signal; };
const probe = overrides => Buffer.from(JSON.stringify({ format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '251.25' }, streams: [{ codec_type: 'audio', codec_name: 'aac', duration: '251.25' }, { codec_type: 'video', codec_name: 'mpeg4', width: 1920, height: 1080 }], ...overrides }));

// The lightweight suite never downloads tools and requires no system FFmpeg.
test('pins are immutable, exact and support only Windows/Linux x64', () => {
  assert.equal(assets.RELEASE, 'autobuild-2026-10-30-13-01');
  assert.equal(assets.PINS.win32.size, 167778749);
  assert.equal(assets.PINS.win32.sha256, 'bf346925ea085c262d15a5ceacd521ccbde52f4e3fc6a97f1bf273685fc1a539');
  assert.equal(assets.PINS.linux.size, 135182360);
  assert.equal(assets.PINS.linux.sha256, '223c160e95ecf4e204c81f6e69649b6380b2609514f31773a38d9be4a70231b1');
  for (const [platform, arch] of [['darwin', 'x64'], ['linux', 'arm64'], ['win32', 'ia32']]) assert.throws(() => assets.pinFor(platform, arch), MediaImportError);
});

test('child environment is a strict allowlist, including on Windows', () => {
  const poison = { SystemRoot: 'C:\\Windows', NODE_OPTIONS: '--require secret', OPENAI_API_KEY: 'secret', PATH: '/evil', LD_PRELOAD: '/evil', FFREPORT: 'file=secret', HTTP_PROXY: 'secret', HOME: '/secret' };
  const win = mediaChildEnvironment(poison, 'win32');
  assert.deepEqual(win, { LANG: 'C', LC_ALL: 'C', OMP_NUM_THREADS: '2', SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows', PATH: 'C:\\Windows\\System32' });
  assert.deepEqual(mediaChildEnvironment(poison, 'linux'), { LANG: 'C', LC_ALL: 'C', OMP_NUM_THREADS: '2', PATH: '/usr/bin:/bin' });
});

test('every supported extension forces a demuxer and restricted input options', () => {
  for (const [ext, demuxer] of Object.entries({ mp3: 'mp3', mp4: 'mov', webm: 'matroska', wav: 'wav', ogg: 'ogg' })) {
    const args = media.inputArguments(ext);
    const value = flag => args[args.indexOf(flag) + 1];
    assert.equal(value('-f'), demuxer);
    assert.equal(value('-format_whitelist'), demuxer);
    assert.equal(value('-protocol_whitelist'), 'file,pipe');
    assert.equal(value('-threads'), '2');
    assert.equal(value('-max_alloc'), '67108864');
    assert.equal(value('-max_pixels'), '16777216');
    assert.equal(value('-max_streams'), '32');
    if (ext === 'mp4') { assert.equal(value('-enable_drefs'), '0'); assert.equal(value('-use_absolute_path'), '0'); }
    else assert.equal(args.includes('-enable_drefs'), false);
  }
  assert.deepEqual(media.inputArguments('.MP4'), media.inputArguments('mp4'));
  for (const ext of ['m3u8', 'concat', 'https', '__proto__']) assert.throws(() => media.inputArguments(ext), MediaImportError);
});

test('probe interpretation preserves remainders and truthfully identifies soundtrack/cover art', () => {
  const info = media.readProbe(probe(), 'mp4');
  assert.deepEqual(info, { duration: 251.25, hasAudio: true, hasVideo: true, partCount: 2 });
  assert.equal(MEDIA_SEGMENT_SECONDS, 180);
  assert.deepEqual(media.partBounds(0, info), { start: 0, end: 180 });
  assert.deepEqual(media.partBounds(1, info), { start: 180, end: 251.25 });
  const silent = media.readProbe(probe({ streams: [{ codec_type: 'video', codec_name: 'mpeg4', width: 10, height: 10 }] }), 'mp4');
  assert.equal(silent.hasAudio, false);
  const cover = media.readProbe(probe({ streams: [{ codec_type: 'audio', codec_name: 'aac' }, { codec_type: 'video', codec_name: 'mjpeg', disposition: { attached_pic: 1 } }] }), 'mp4');
  assert.equal(cover.hasVideo, false);
  for (const index of [-1, 2, 0.5, NaN]) assert.throws(() => media.partBounds(index, info), MediaImportError);
  assert.throws(() => media.partBounds(0, { ...info, partCount: 3 }), MediaImportError);
});

test('probe rejects invalid containers, missing streams, oversized frames and over-four-hour recordings', () => {
  for (const bytes of [Buffer.from('private metadata, not JSON'), Buffer.from('null'), probe({ streams: [] }), probe({ format: { format_name: 'hls', duration: '1' } }), probe({ format: { format_name: 'mov', duration: '14400.01' } }), probe({ streams: [{ codec_type: 'video', codec_name: 'mpeg4', width: 32768, height: 32768 }] }), probe({ streams: [{ codec_type: 'audio', codec_name: 'unknown' }] })]) {
    assert.throws(() => media.readProbe(bytes, 'mp4'), error => error instanceof MediaImportError && !error.message.includes('private metadata'));
  }
  const exact = media.readProbe(probe({ format: { format_name: 'mov', duration: '14400' }, streams: [{ codec_type: 'audio', codec_name: 'aac' }] }), 'mp4');
  assert.equal(exact.partCount, 80);
});

test('PCM is wrapped in an independent, correctly sized mono 16kHz WAV', () => {
  const pcm = Buffer.alloc(180 * 16000 * 2);
  const wav = media.pcmWav(pcm);
  assert.equal(wav.length, 5760044);
  assert.ok(wav.length < 6 * 1024 * 1024);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.readUInt32LE(4), wav.length - 8);
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(24), 16000);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.readUInt32LE(40), pcm.length);
  assert.throws(() => media.pcmWav(Buffer.alloc(3)), MediaImportError);
});

test('archive selection rejects traversal, alternate binaries and unsafe paths', () => {
  const pin = assets.PINS.win32, root = pin.file.slice(0, -4);
  assert.equal(assets.selectedMember(`${root}/bin/ffmpeg.exe`, pin, 'win32'), true);
  assert.equal(assets.selectedMember(`${root}/LICENSE.txt`, pin, 'win32'), true);
  for (const path of [`${root}/bin/ffplay.exe`, `${root}/../ffmpeg.exe`, `${root}/bin/evil.exe`, `C:/${root}/bin/ffmpeg.exe`, `${root}\\bin\\ffmpeg.exe`, `${root}/licenses/../../bad`]) assert.equal(assets.selectedMember(path, pin, 'win32'), false);
});

test('offline missing cache gives a safe actionable error and never fetches', async t => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'learnlens-media-offline-'));
  t.after(() => rm(cacheDir, { recursive: true, force: true }));
  t.mock.method(globalThis, 'fetch', () => { assert.fail('offline must not fetch'); });
  await assert.rejects(ensureMediaTools({ offline: true, cacheDir }), error => error instanceof MediaImportError && /missing or damaged/.test(error.message));
  const oldOffline = process.env.LEARNLENS_MEDIA_OFFLINE;
  t.after(() => { if (oldOffline === undefined) delete process.env.LEARNLENS_MEDIA_OFFLINE; else process.env.LEARNLENS_MEDIA_OFFLINE = oldOffline; });
  process.env.LEARNLENS_MEDIA_OFFLINE = '1';
  await assert.rejects(ensureMediaTools({ cacheDir }), /missing or damaged/);
});

test('cache validation rejects malformed or tampered manifests', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'learnlens-media-manifest-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const text of ['not JSON', JSON.stringify({ version: 1, release: 'latest', files: [] }), JSON.stringify({ version: 1, release: assets.RELEASE, archive: assets.PINS.win32, files: [{ path: '../bad', size: 2, sha256: '0'.repeat(64) }] })]) {
    await writeFile(join(dir, 'manifest.json'), text);
    assert.equal(await assets.validCache(dir, assets.PINS.win32, 'win32', new AbortController().signal), false);
  }
});

test('cache verifies archive and extracted-file checksums, not just presence', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'learnlens-media-checksums-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const digest = bytes => ({ size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  const archive = Buffer.from('test-only archive'), executable = Buffer.from('test-only executable');
  const pin = { file: assets.PINS.win32.file, ...digest(archive) }, root = pin.file.slice(0, -4);
  await mkdir(join(dir, root, 'bin'), { recursive: true });
  const files = ['bin/ffmpeg.exe', 'bin/ffprobe.exe', 'LICENSE.txt'].map(name => ({ path: root + '/' + name, ...digest(executable) }));
  for (const f of files) await writeFile(join(dir, f.path), executable);
  await writeFile(join(dir, pin.file), archive);
  await writeFile(join(dir, 'manifest.json'), JSON.stringify({ version: 1, release: assets.RELEASE, archive: pin, files }));
  const valid = () => assets.validCache(dir, pin, 'win32', new AbortController().signal);
  assert.equal(await valid(), true);
  await writeFile(join(dir, files[0].path), Buffer.alloc(executable.length, 1));
  assert.equal(await valid(), false);
  await writeFile(join(dir, files[0].path), executable);
  await writeFile(join(dir, pin.file), Buffer.alloc(archive.length, 1));
  assert.equal(await valid(), false);
});

test('Linux tar extraction uses only exact trusted members and a sanitized environment', async t => {
  let invocation;
  t.mock.method(childProcess, 'spawn', (executable, args, options) => {
    invocation = { executable, args, options };
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => true;
    queueMicrotask(() => child.emit('close', 0));
    return child;
  });
  const pin = assets.PINS.linux, root = pin.file.replace(/\.tar\.xz$/, '');
  const files = await assets.extractTar('/private/archive.tar.xz', '/private/staging', pin, new AbortController().signal);
  assert.deepEqual(files, [root + '/bin/ffmpeg', root + '/bin/ffprobe', root + '/LICENSE.txt']);
  assert.equal(invocation.executable, '/usr/bin/tar');
  assert.deepEqual(invocation.args.slice(invocation.args.indexOf('--') + 1), files);
  assert.ok(invocation.args.includes('--no-recursion'));
  assert.ok(invocation.args.includes('--no-same-owner'));
  assert.equal(invocation.options.shell, false);
  assert.equal(invocation.options.env.NODE_OPTIONS, undefined);
  assert.equal(invocation.options.env.TAR_OPTIONS, undefined);
});

test('bounded streaming download verifies exact bytes/hash and rejects changed upstream or redirects', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'learnlens-media-download-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const data = Buffer.from('pinned bytes'), pin = { file: assets.PINS.win32.file, size: data.length, sha256: createHash('sha256').update(data).digest('hex') };
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls++;
    assert.equal(url, `https://github.com/BtbN/FFmpeg-Builds/releases/download/${assets.RELEASE}/${pin.file}`);
    assert.equal(options.redirect, 'manual');
    assert.ok(options.signal);
    return new Response(data);
  });
  await assets.download(pin, join(dir, 'good'), new AbortController().signal);
  assert.deepEqual(await readFile(join(dir, 'good')), data);
  await assert.rejects(assets.download({ ...pin, sha256: '0'.repeat(64) }, join(dir, 'wrong-hash'), new AbortController().signal), /checksum/);
  await assert.rejects(assets.download({ ...pin, size: data.length - 1 }, join(dir, 'too-large'), new AbortController().signal), /pinned size/);
  await assert.rejects(assets.download({ ...pin, size: data.length + 1 }, join(dir, 'too-small'), new AbortController().signal), /checksum/);
  assert.equal(calls, 4);
  globalThis.fetch.mock.mockImplementation(async () => new Response(null, { status: 302, headers: { location: 'https://attacker.example/binary' } }));
  await assert.rejects(assets.download(pin, join(dir, 'redirect'), new AbortController().signal), /approved upstream/);
  globalThis.fetch.mock.mockImplementation(async () => new Response('not found', { status: 404 }));
  await assert.rejects(assets.download(pin, join(dir, 'unavailable'), new AbortController().signal), /no alternate release/);
});

test('single flight shares acquisition, independent cancellation, and cleans partial installs', async t => {
  const oldOffline = process.env.LEARNLENS_MEDIA_OFFLINE;
  t.after(() => { if (oldOffline === undefined) delete process.env.LEARNLENS_MEDIA_OFFLINE; else process.env.LEARNLENS_MEDIA_OFFLINE = oldOffline; });
  delete process.env.LEARNLENS_MEDIA_OFFLINE;
  const cacheDir = await mkdtemp(join(tmpdir(), 'learnlens-media-flight-'));
  t.after(() => rm(cacheDir, { recursive: true, force: true }));
  let calls = 0, release, started;
  const ready = new Promise(resolve => { started = resolve; });
  t.mock.method(globalThis, 'fetch', async () => {
    calls++; started();
    await new Promise(resolve => { release = resolve; });
    return new Response('gone', { status: 404 });
  });
  const first = new AbortController();
  const a = ensureMediaTools({ cacheDir, signal: first.signal });
  const b = ensureMediaTools({ cacheDir });
  const rejected = assert.rejects(a, { name: 'AbortError' });
  await ready; first.abort(); await rejected;
  release();
  await assert.rejects(b, /unavailable/);
  assert.equal(calls, 1);
  assert.deepEqual(await readdir(cacheDir), []);
  await assert.rejects(ensureMediaTools({ cacheDir, offline: true }), /missing or damaged/);
});

test('public APIs honor pre-aborted signals without leaking abort reasons or touching tools', async () => {
  for (const run of [signal => ensureMediaTools({ signal }), signal => inspectMedia('/private', 'mp4', { signal }), signal => prepareMediaPart('/private', 'mp4', 0, {}, { signal })]) {
    await assert.rejects(run(aborted()), error => error.name === 'AbortError' && !error.message.includes('secret'));
  }
});

test('subprocess arguments are shell-free; stderr is never surfaced', async t => {
  let invocation;
  t.mock.method(childProcess, 'spawn', (executable, args, options) => {
    invocation = { executable, args, options };
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true;
    queueMicrotask(() => { child.stderr.write('SECRET metadata and filename'); child.emit('close', 1); });
    return child;
  });
  const args = ['-i', 'private & $(secret).mp4'];
  await assert.rejects(media.runProcess('managed-ffmpeg', args, { maxBytes: 10, timeoutMs: 1000 }), error => error instanceof MediaImportError && !error.message.includes('SECRET'));
  assert.equal(invocation.options.shell, false);
  assert.equal(invocation.options.windowsHide, true);
  assert.deepEqual(invocation.args, args);
  assert.equal(invocation.options.env.NODE_OPTIONS, undefined);
  assert.equal(invocation.options.env.OPENAI_API_KEY, undefined);
});

test('subprocess cancellation, output caps and deadlines kill and await child close', async t => {
  for (const mode of ['abort', 'stdout', 'stderr', 'deadline']) {
    let killed = false, closed = false;
    const controller = new AbortController();
    const mock = t.mock.method(childProcess, 'spawn', () => {
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.kill = signal => { assert.equal(signal, 'SIGKILL'); killed = true; queueMicrotask(() => { closed = true; child.emit('close', null); }); return true; };
      queueMicrotask(() => {
        if (mode === 'abort') controller.abort();
        if (mode === 'stdout') child.stdout.write(Buffer.alloc(11));
        if (mode === 'stderr') child.stderr.write(Buffer.alloc(65537));
      });
      return child;
    });
    await assert.rejects(media.runProcess('managed-tool', [], { signal: controller.signal, maxBytes: 10, timeoutMs: 5 }), error => mode === 'abort' ? error.name === 'AbortError' : error instanceof MediaImportError);
    assert.equal(killed, true); assert.equal(closed, true);
    mock.mock.restore();
  }
});

// Opt in: LEARNLENS_MEDIA_INTEGRATION=1 node --test tests/native-media.test.mjs
// Uses ONLY the checksum-verified managed binaries, and synthetic locally generated
// fixtures. First run may download the pinned upstream archive into .cache/media.
test('managed real media: >4-minute MP3, MP4/AAC, WebM/Opus, WAV/OGG, silent video, invalid input and cancellation', { skip: !integration, timeout: 240000 }, async t => {
  const tools = await ensureMediaTools();
  const dir = await mkdtemp(join(tmpdir(), 'learnlens-media-real-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const generate = async (name, args) => {
    const path = join(dir, name);
    await media.runProcess(tools.ffmpeg, ['-hide_banner', '-v', 'error', '-nostdin', '-y', '-filter_threads', '1', ...args, '-threads', '2', path], { maxBytes: 1024, timeoutMs: 90000 });
    return path;
  };
  const sound = ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000'];
  const video = ['-f', 'lavfi', '-i', 'color=c=blue:size=1920x1080:rate=2'];
  const mp3 = await generate('long.mp3', [...sound, '-t', '251.25', '-c:a', 'libmp3lame', '-b:a', '32k']);
  const info = await inspectMedia(mp3, 'mp3');
  assert.equal(info.partCount, 2); assert.ok(info.duration > 250); assert.equal(info.hasAudio, true); assert.equal(info.hasVideo, false);
  let covered = 0;
  for (let index = 0; index < info.partCount; index++) {
    const part = await prepareMediaPart(mp3, 'mp3', index, info);
    const wav = Buffer.from(part.audio.split(',')[1], 'base64');
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF'); assert.equal(wav.readUInt32LE(40), wav.length - 44);
    assert.ok(wav.length <= 6 * 1024 * 1024); assert.equal(wav.readUInt32LE(24), 16000); assert.equal(wav.readUInt16LE(22), 1);
    assert.equal(part.start, index * 180); assert.equal(part.end, Math.min((index + 1) * 180, info.duration));
    covered += (wav.length - 44) / 32000;
    assert.deepEqual(part.images, []); assert.equal(part.text, '');
    // Independent WAV decoding is tested, not just header inspection.
    const wavPath = join(dir, `part-${index}.wav`); await writeFile(wavPath, wav);
    const wavInfo = await inspectMedia(wavPath, 'wav');
    assert.ok(Math.abs(wavInfo.duration - (wav.length - 44) / 32000) < 0.001);
  }
  assert.ok(Math.abs(covered - 251.25) < 0.15, `covered ${covered} seconds`);
  t.diagnostic(`Synthetic 251.25-second MP3: duration=${info.duration}, parts=${info.partCount}, final interval=180..${info.duration}, decoded audio=${covered} seconds.`);
  const mp4 = await generate('av.mp4', [...video, ...sound, '-t', '2.25', '-c:v', 'mpeg4', '-q:v', '8', '-c:a', 'aac']);
  const webm = await generate('av.webm', ['-f', 'lavfi', '-i', 'color=c=red:size=320x180:rate=2', ...sound, '-t', '2.25', '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-c:a', 'libopus']);
  const silent = await generate('silent.mp4', [...video, '-t', '2.25', '-c:v', 'mpeg4', '-q:v', '8', '-an']);
  for (const [path, ext, hasAudio] of [[mp4, 'mp4', true], [webm, 'webm', true], [silent, 'mp4', false]]) {
    const inspected = await inspectMedia(path, ext);
    assert.equal(inspected.hasAudio, hasAudio); assert.equal(inspected.hasVideo, true);
    const part = await prepareMediaPart(path, ext, 0, inspected);
    assert.equal(Boolean(part.audio), hasAudio); assert.equal(part.images.length, 2); assert.equal(part.end, inspected.duration);
    if (!hasAudio) assert.match(part.warnings.join(' '), /no audio soundtrack/);
    for (const [index, frame] of part.images.entries()) {
      const jpg = Buffer.from(frame.dataUrl.split(',')[1], 'base64');
      assert.ok(jpg.length < 2 * 1024 * 1024); assert.equal(jpg.readUInt16BE(0), 0xffd8);
      const imagePath = join(dir, `${ext}-${hasAudio}-${index}.jpg`); await writeFile(imagePath, jpg);
      const metadata = JSON.parse((await media.runProcess(tools.ffprobe, ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'json', imagePath], { maxBytes: 65536, timeoutMs: 10000 })).toString());
      assert.ok(metadata.streams[0].width <= 1280 && metadata.streams[0].height <= 1280);
    }
  }
  for (const [ext, codec] of [['wav', 'pcm_s16le'], ['ogg', 'libvorbis']]) {
    const path = await generate(`short.${ext}`, [...sound, '-t', '1.25', '-c:a', codec]);
    const inspected = await inspectMedia(path, ext);
    assert.equal(inspected.hasAudio, true);
    assert.ok((await prepareMediaPart(path, ext, 0, inspected)).audio);
  }
  const bad = join(dir, 'private-name.mp4'); await writeFile(bad, 'PRIVATE raw metadata, not media');
  await assert.rejects(inspectMedia(bad, 'mp4'), error => error instanceof MediaImportError && !/PRIVATE|private-name/.test(error.message));
  await assert.rejects(inspectMedia(mp3, 'mp4'), MediaImportError);
  const controller = new AbortController();
  const originalSpawn = childProcess.spawn;
  let killed = false;
  const spawnMock = t.mock.method(childProcess, 'spawn', (...args) => {
    const child = originalSpawn(...args), originalKill = child.kill.bind(child);
    child.kill = (...killArgs) => { killed = true; return originalKill(...killArgs); };
    queueMicrotask(() => controller.abort());
    return child;
  });
  await assert.rejects(prepareMediaPart(mp3, 'mp3', 0, info, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(killed, true);
  spawnMock.mock.restore();
  assert.deepEqual(await ensureMediaTools({ offline: true }), tools);
});
