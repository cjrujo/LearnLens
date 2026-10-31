import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { ensureMediaTools, mediaChildEnvironment, MediaImportError } from '../deploy/media-assets.mjs';
import { generateSpeech, generateSpeechBytes, sniffMedia, AppError } from '../lib/provider.mjs';
import { prepareAudioEncoder, __testing as audio } from '../lib/audio-encode.mjs';

const MiB = 1024 * 1024;
const provider = { baseUrl: 'https://fixture.invalid/v1', apiKey: 'SECRET-key' };
const role = { model: 'fixture-model' };
const mp3Fixture = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(29)]);
const progress = Buffer.from('out_time_us=1200000\nprogress=end\n');
const aborted = () => { const c = new AbortController(); c.abort(new Error('SECRET-reason')); return c.signal; };
const loadTools = async () => ({ ffmpeg: process.execPath });
function wav(seconds = 0.2, rate = 24000) {
  const size = Math.round(seconds * rate) * 2, buffer = Buffer.alloc(44 + size);
  buffer.write('RIFF'); buffer.writeUInt32LE(size + 36, 4); buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24); buffer.writeUInt32LE(rate * 2, 28);
  buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36); buffer.writeUInt32LE(size, 40);
  for (let i = 0; i < size / 2; i++) buffer.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 440 / rate) * 4000), 44 + i * 2);
  return buffer;
}
const input = () => ({ buffer: wav(), mime: 'audio/wav' });
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.inputs = []; child.kills = 0; child.closed = false;
  child.stdin = new Writable({ write(chunk, _encoding, callback) { child.inputs.push(chunk); callback(); } });
  child.close = code => { child.closed = true; child.stdout.end(); child.stderr.end(); child.emit('close', code); };
  child.kill = signal => { assert.equal(signal, 'SIGKILL'); child.kills++; queueMicrotask(() => child.close(null)); return true; };
  return child;
}
function stubEncoder(t, behavior = () => {}) {
  const calls = [];
  t.mock.method(childProcess, 'spawn', (executable, args, options) => {
    const child = fakeChild(); calls.push({ executable, args, options, child });
    queueMicrotask(() => {
      if (behavior(child, args, calls.length) === false) return;
      child.stdout.write(args.includes('libmp3lame') ? mp3Fixture : progress);
      child.close(0);
    });
    return child;
  });
  return calls;
}

// All lightweight tests are local fixtures: no provider or tool-download network.
test('binary speech transport preserves wire options, sniffing and exact legacy return shape', async t => {
  const bytes = wav(); let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls++;
    assert.equal(url, provider.baseUrl + '/audio/speech');
    assert.deepEqual(JSON.parse(options.body), { model: role.model, voice: 'alloy', input: 'fixture words', response_format: 'mp3' });
    return new Response(bytes, { headers: { 'content-type': 'text/plain' } });
  });
  const binary = await generateSpeechBytes(provider, role, 'fixture words');
  assert.deepEqual(Object.keys(binary).sort(), ['buffer', 'mime']);
  assert.ok(Buffer.isBuffer(binary.buffer)); assert.deepEqual(binary.buffer, bytes); assert.equal(binary.mime, 'audio/wav');
  assert.deepEqual(await generateSpeech(provider, role, 'fixture words'), { dataUrl: `data:audio/wav;base64,${bytes.toString('base64')}`, bytes: bytes.length });
  assert.equal(calls, 2);
});

test('speech bytes preserve configured format/voice, 8 MiB boundary and safe existing errors', async t => {
  let response;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.voice, 'fixture-voice'); assert.equal(body.response_format, 'wav');
    return response();
  });
  const run = fn => fn({ ...provider, speechFormat: 'wav' }, { ...role, voice: 'fixture-voice' }, 'SECRET-source');
  const bytes = Buffer.alloc(8 * MiB); wav().copy(bytes);
  response = () => new Response(bytes);
  assert.equal((await run(generateSpeechBytes)).buffer.length, 8 * MiB);
  for (const fn of [generateSpeechBytes, generateSpeech]) {
    response = () => new Response('SECRET-source');
    await assert.rejects(run(fn), error => error instanceof AppError && error.status === 502 && error.message === 'Speech provider did not return a supported audio file.');
    response = () => new Response('SECRET-source', { headers: { 'content-length': String(8 * MiB + 1) } });
    await assert.rejects(run(fn), /Provider response is too large/);
    response = () => new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.enqueue(Buffer.alloc(1)); controller.close(); } }));
    await assert.rejects(run(fn), /Provider response is too large/);
    response = () => new Response('{"error":{"message":"SECRET-source"}}', { status: 429 });
    await assert.rejects(run(fn), error => error.status === 502 && error.providerStatus === 429 && !error.message.includes('SECRET'));
  }
});

test('preparation awaits managed loader with offline flag before returning an encoder', async t => {
  const old = process.env.LEARNLENS_MEDIA_OFFLINE;
  t.after(() => { if (old === undefined) delete process.env.LEARNLENS_MEDIA_OFFLINE; else process.env.LEARNLENS_MEDIA_OFFLINE = old; });
  const controller = new AbortController(); let released, ready = false, calls = 0;
  process.env.LEARNLENS_MEDIA_OFFLINE = '1';
  const preparing = prepareAudioEncoder({ signal: controller.signal, loadTools: async options => {
    calls++; assert.deepEqual(options, { signal: controller.signal, offline: true });
    await new Promise(resolve => { released = resolve; });
    return loadTools();
  } }).then(value => { ready = true; return value; });
  assert.equal(ready, false); released();
  assert.equal(typeof await preparing, 'function'); assert.equal(calls, 1);
  process.env.LEARNLENS_MEDIA_OFFLINE = '0';
  await prepareAudioEncoder({ loadTools: async options => { assert.equal(options.offline, false); return loadTools(); } });
  await assert.rejects(prepareAudioEncoder({ loadTools: async () => { throw new Error('SECRET-loader'); } }), error => error instanceof MediaImportError && !error.message.includes('SECRET'));
  for (const ffmpeg of ['ffmpeg', 'https://fixture.invalid/ffmpeg', process.execPath + '\0']) {
    await assert.rejects(prepareAudioEncoder({ loadTools: async () => ({ ffmpeg }) }), /path is invalid/);
  }
});

test('strict demuxers, pipe-only protocols, no external references or truncation', () => {
  assert.equal(audio.MAX_INPUT_BYTES, 8 * MiB); assert.equal(audio.MAX_OUTPUT_BYTES, 2 * MiB); assert.equal(audio.TIMEOUT_MS, 60_000);
  for (const [mime, demuxer] of Object.entries({ 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/mp4': 'mov', 'audio/webm': 'matroska', 'audio/ogg': 'ogg' })) {
    const args = audio.inputArguments(mime), value = flag => args[args.indexOf(flag) + 1];
    assert.equal(value('-f'), demuxer); assert.equal(value('-format_whitelist'), demuxer);
    assert.equal(value('-protocol_whitelist'), 'pipe'); assert.equal(value('-i'), 'pipe:0');
    assert.equal(value('-map'), '0:a:0'); assert.equal(value('-err_detect'), 'explode');
    assert.ok(args.includes('-xerror'));
    for (const option of ['-t', '-to', '-fs', '-ss', '-frames:a']) assert.equal(args.includes(option), false);
    if (mime === 'audio/mp4') { assert.equal(value('-enable_drefs'), '0'); assert.equal(value('-use_absolute_path'), '0'); }
  }
  for (const mime of ['application/vnd.apple.mpegurl', 'concat', '__proto__', 'audio/aac', 'audio/flac', 'http', 'file']) assert.throws(() => audio.inputArguments(mime), MediaImportError);
});

test('encoder writes only bytes, returns an MP3 Buffer after full decode, and filters environment', async t => {
  const calls = stubEncoder(t);
  const encode = await prepareAudioEncoder({ loadTools });
  const original = input();
  assert.deepEqual(await encode(original), mp3Fixture);
  assert.equal(calls.length, 2);
  assert.deepEqual(Buffer.concat(calls[0].child.inputs), original.buffer);
  assert.deepEqual(Buffer.concat(calls[1].child.inputs), mp3Fixture);
  for (const call of calls) {
    assert.equal(call.executable, process.execPath); assert.equal(call.options.shell, false);
    assert.equal(call.options.windowsHide, true); assert.deepEqual(call.options.env, mediaChildEnvironment());
    assert.deepEqual(call.options.stdio, ['pipe', 'pipe', 'pipe']);
    assert.equal(call.child.stdin.destroyed, true);
    for (let i = 0; i < call.args.length; i++) if (call.args[i] === '-protocol_whitelist') assert.equal(call.args[i + 1], 'pipe');
    assert.equal(call.args.at(-1), 'pipe:1');
    for (const flag of ['-t', '-fs', '-to', '-frames:a']) assert.equal(call.args.includes(flag), false);
  }
  const args = calls[0].args, value = flag => args[args.indexOf(flag) + 1];
  assert.equal(value('-c:a'), 'libmp3lame'); assert.equal(value('-ac'), '1');
  assert.equal(value('-ar'), '24000'); assert.equal(value('-b:a'), '48k');
  assert.equal(calls[1].args[calls[1].args.lastIndexOf('-f') + 1], 'null');
  assert.ok(calls[1].args.includes('pcm_s16le'));
});

test('rejects invalid/oversized/mismatched input before spawn, accepts exact 8 MiB', async t => {
  const calls = stubEncoder(t), encode = await prepareAudioEncoder({ loadTools });
  for (const value of [undefined, {}, { buffer: new Uint8Array(12), mime: 'audio/mpeg' }, { buffer: Buffer.alloc(0), mime: 'audio/mpeg' }, { buffer: Buffer.alloc(8 * MiB + 1), mime: 'audio/wav' }, { buffer: wav(), mime: 'audio/mpeg' }, { buffer: wav(), mime: '__proto__' }, { buffer: Buffer.from('#EXTM3U\nhttps://SECRET.invalid/a'), mime: 'audio/mpeg' }]) {
    await assert.rejects(encode(value), MediaImportError);
  }
  assert.equal(calls.length, 0);
  const buffer = Buffer.alloc(8 * MiB); wav().copy(buffer);
  await encode({ buffer, mime: 'audio/wav' }); assert.equal(calls.length, 2);
});

test('decoder must finish and report positive samples; encode/decode failures never expose stderr', async t => {
  for (const mode of ['empty', 'bad-mp3', 'no-time', 'unfinished', 'negative-time', 'decode-fails', 'encode-fails']) {
    const mock = t.mock.method(childProcess, 'spawn', (_file, args) => {
      const child = fakeChild();
      queueMicrotask(() => {
        const encoding = args.includes('libmp3lame');
        child.stderr.write('SECRET-source and credential');
        if (encoding) child.stdout.write(mode === 'empty' ? Buffer.alloc(0) : mode === 'bad-mp3' ? Buffer.from('SECRET-source') : mp3Fixture);
        else child.stdout.write(mode === 'no-time' ? 'out_time_us=0\nprogress=end\n' : mode === 'unfinished' ? 'out_time_us=1000\nprogress=continue\n' : mode === 'negative-time' ? 'out_time_us=-1\nprogress=end\n' : progress);
        child.close((encoding && mode === 'encode-fails') || (!encoding && mode === 'decode-fails') ? 1 : 0);
      });
      return child;
    });
    await assert.rejects((await prepareAudioEncoder({ loadTools }))(input()), error => error instanceof MediaImportError && !error.message.includes('SECRET'));
    mock.mock.restore();
  }
});

test('pre-abort avoids tool acquisition and spawn; preparation signal remains effective', async t => {
  await assert.rejects(prepareAudioEncoder({ signal: aborted(), loadTools: () => assert.fail('must not load') }), { name: 'AbortError' });
  const controller = new AbortController();
  const calls = stubEncoder(t), encode = await prepareAudioEncoder({ signal: controller.signal, loadTools });
  await assert.rejects(encode(input(), { signal: aborted() }), error => error.name === 'AbortError' && !error.message.includes('SECRET'));
  controller.abort(new Error('SECRET-reason'));
  await assert.rejects(encode(input()), { name: 'AbortError' }); assert.equal(calls.length, 0);
});

test('abort at either stage kills and awaits close, stops stdin, and removes signal listener', async t => {
  for (const stage of [1, 2]) {
    const controller = new AbortController();
    const add = t.mock.method(controller.signal, 'addEventListener');
    const remove = t.mock.method(controller.signal, 'removeEventListener');
    const calls = stubEncoder(t, (_child, _args, index) => {
      if (index === stage) { controller.abort(new Error('SECRET-reason')); return false; }
    });
    await assert.rejects((await prepareAudioEncoder({ loadTools }))(input(), { signal: controller.signal }), { name: 'AbortError' });
    assert.equal(calls.length, stage);
    const child = calls.at(-1).child;
    assert.equal(child.kills, 1); assert.equal(child.closed, true); assert.equal(child.stdin.destroyed, true);
    assert.equal(add.mock.callCount(), remove.mock.callCount());
    t.mock.restoreAll();
  }
});

test('bounded process kills on stdout/stderr overflow, deadline and stream errors, but accepts exact limit', async t => {
  for (const mode of ['stdout', 'stderr', 'deadline', 'stdin-error', 'spawn-error', 'exact']) {
    let child;
    const mock = t.mock.method(childProcess, 'spawn', () => {
      child = fakeChild();
      queueMicrotask(() => {
        if (mode === 'stdout' || mode === 'stderr') child[mode].write(Buffer.alloc(2 * MiB + 1));
        if (mode === 'stdin-error') child.stdin.emit('error', new Error('SECRET-EPIPE'));
        if (mode === 'spawn-error') child.emit('error', new Error('SECRET-spawn'));
        if (mode === 'exact') { child.stdout.write(Buffer.alloc(2 * MiB)); child.stderr.write(Buffer.alloc(2 * MiB)); child.close(0); }
      });
      return child;
    });
    const result = audio.runPipe(process.execPath, [], Buffer.alloc(8 * MiB), { timeoutMs: 10 });
    if (mode === 'exact') assert.equal((await result).length, 2 * MiB);
    else await assert.rejects(result, error => error instanceof MediaImportError && !error.message.includes('SECRET'));
    assert.equal(child.closed, true); assert.equal(child.stdin.destroyed, true);
    assert.equal(child.kills, mode === 'exact' ? 0 : 1);
    // Late errors are handled; no asynchronous stdin writer survives settlement.
    child.stdin.emit('error', new Error('SECRET-late'));
    mock.mock.restore();
  }
});

test('encoding and validation share a 60-second deadline', async t => {
  let nowCalls = 0;
  t.mock.method(Date, 'now', () => nowCalls++ ? 59_999 : 0);
  const calls = stubEncoder(t, (_child, _args, index) => index === 2 ? false : undefined);
  await assert.rejects((await prepareAudioEncoder({ loadTools }))(input()), /time limit/);
  assert.equal(calls.length, 2); assert.equal(calls[1].child.kills, 1); assert.equal(calls[1].child.closed, true);
});

test('spawn exceptions and early child exit are safe failures', async t => {
  let mock = t.mock.method(childProcess, 'spawn', () => { throw new Error('SECRET-path'); });
  await assert.rejects(audio.runPipe(process.execPath, [], wav()), error => !error.message.includes('SECRET'));
  mock.mock.restore();
  mock = t.mock.method(childProcess, 'spawn', () => { const child = fakeChild(); queueMicrotask(() => child.close(1)); return child; });
  await assert.rejects(audio.runPipe(process.execPath, [], wav()), MediaImportError);
});

// Explicit opt-in, cached checksum-verified tools ONLY; never acquire assets.
// Synthetic tones test decoding/format, not speech content or pronunciation.
test('offline real FFmpeg: WAV to MP3, MP3 roundtrip, full decode, bad input, limits and abort', {
  skip: process.env.LEARNLENS_MEDIA_INTEGRATION !== '1', timeout: 180_000,
}, async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('integration must not access the network'));
  const tools = await ensureMediaTools({ offline: true });
  const encode = await prepareAudioEncoder({ loadTools: options => ensureMediaTools({ ...options, offline: true }) });
  const first = await encode({ buffer: wav(1.25), mime: 'audio/wav' });
  const roundtrip = await encode({ buffer: first, mime: 'audio/mpeg' });
  for (const buffer of [first, roundtrip]) {
    assert.ok(Buffer.isBuffer(buffer)); assert.equal(sniffMedia(buffer), 'audio/mpeg'); assert.ok(buffer.length < 2 * MiB);
    const info = JSON.parse((await audio.runPipe(tools.ffprobe, [
      '-v', 'error', '-protocol_whitelist', 'pipe', '-format_whitelist', 'mp3', '-f', 'mp3', '-i', 'pipe:0',
      '-show_entries', 'stream=codec_name,sample_rate,channels,bit_rate', '-of', 'json',
    ], buffer)).toString());
    assert.equal(info.streams[0].codec_name, 'mp3'); assert.equal(info.streams[0].sample_rate, '24000');
    assert.equal(info.streams[0].channels, 1); assert.equal(info.streams[0].bit_rate, '48000');
    const pcm = await audio.runPipe(tools.ffmpeg, [
      ...audio.inputArguments('audio/mpeg'), '-c:a', 'pcm_s16le', '-f', 's16le', 'pipe:1',
    ], buffer);
    assert.ok(pcm.length / 48000 >= 1.25 && pcm.length / 48000 < 1.5, 'all tone samples survive, allowing MP3 padding');
  }
  // More than 2 MiB of decoded PCM must not hit the encoded-output budget:
  // validation scans the whole MP3 without collecting its PCM or truncating it.
  const long = await encode({ buffer: wav(50, 8000), mime: 'audio/wav' });
  const decoded = await audio.runPipe(tools.ffmpeg, [
    ...audio.inputArguments('audio/mpeg'), '-c:a', 'pcm_s16le', '-progress', 'pipe:1',
    '-f', 'null', 'pipe:1',
  ], long);
  const times = [...decoded.toString().matchAll(/^out_time_us=(\d+)/gm)].map(match => Number(match[1]));
  assert.ok(Math.max(...times) >= 50_000_000 && Math.max(...times) < 50_500_000);
  await assert.rejects(encode({ buffer: mp3Fixture, mime: 'audio/mpeg' }), MediaImportError);
  const damaged = wav(); damaged.write('NOPE', 36);
  await assert.rejects(encode({ buffer: damaged, mime: 'audio/wav' }), MediaImportError);
  // 360s at 48kbps exceeds 2 MiB. Reject rather than silently cutting the tail.
  await assert.rejects(encode({ buffer: wav(360, 8000), mime: 'audio/wav' }), /output limit/);
  const originalSpawn = childProcess.spawn; let killed = false, closed = false;
  const controller = new AbortController();
  t.mock.method(childProcess, 'spawn', (...args) => {
    const child = originalSpawn(...args), kill = child.kill.bind(child);
    child.kill = (...values) => { killed = true; return kill(...values); };
    child.once('close', () => { closed = true; });
    queueMicrotask(() => controller.abort(new Error('SECRET-reason')));
    return child;
  });
  await assert.rejects(encode(input(), { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(killed, true); assert.equal(closed, true);
});
