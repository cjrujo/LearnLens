import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createYouTubeSource, youtubeVideoUrl } from '../lib/youtube-source.mjs';
import { HELPER_OUTPUT_LIMIT } from '../deploy/owned-process.mjs';

const ID = 'aB_12-cD3eF', URL = `https://www.youtube.com/watch?v=${ID}`;
const DIRECT = 'https://rr1---sn-public.googlevideo.com/videoplayback?expire=9999&sig=PRIVATE_TOKEN&mime=video%2Fmp4';
const ORIGINAL = Buffer.from('synthetic-whole-video-and-soundtrack');
const root = fileURLToPath(new globalThis.URL('../artifacts/', import.meta.url));
function scratch(t) {
  fs.mkdirSync(root, { recursive: true });
  const directory = fs.mkdtempSync(join(root, 'youtube-source-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true })); return directory;
}
function info() {
  return { _type: 'video', id: ID, extractor_key: 'Youtube', title: 'A whole lesson', duration: 90,
    availability: 'public', live_status: 'not_live', is_live: false,
    description: 'DO NOT USE ME AS LESSON CONTENT', subtitles: { en: [{ url: 'https://127.0.0.1/private' }] },
    formats: [{ format_id: '18', url: DIRECT, protocol: 'https', ext: 'mp4', has_drm: false,
      vcodec: 'avc1.42001E', acodec: 'mp4a.40.2', width: 640, height: 360, fps: 30, filesize: ORIGINAL.length }],
  };
}
function fixture({ metadata = info(), raw, run, download, loadAssets } = {}) {
  const calls = { loads: [], runs: [], downloads: [], proxies: [], events: [] };
  const source = createYouTubeSource({
    loadAssets: async options => { calls.loads.push(options); return loadAssets ? loadAssets(options) :
      { ytdlp: join(root, 'trusted-yt-dlp.exe'), deno: join(root, 'trusted-deno.exe') }; },
    createProxy: async options => {
      const controller = new AbortController();
      const proxy = { url: 'http://learnlens:PRIVATE_NONCE@127.0.0.1:12345', signal: controller.signal,
        close: async () => { calls.events.push('proxy-close'); controller.abort(); } };
      calls.proxies.push({ options, proxy, controller }); return proxy;
    },
    run: async (exe, args, options) => {
      calls.runs.push({ exe, args, options });
      if (run) return run(exe, args, options, calls);
      return raw ?? Buffer.from(JSON.stringify(metadata));
    },
    download: async (url, file, options) => {
      calls.downloads.push({ url, file, options }); calls.events.push('download');
      assert.equal(calls.events[0], 'proxy-close');
      assert.equal(fs.readdirSync(options.testDir || join(file, '..')).some(name => name.startsWith('.youtube-')), false);
      if (download) return download(url, file, options);
      assert.equal(await options.allowUrl(new globalThis.URL(url)), true);
      options.limitForHeaders({ contentType: 'video/mp4', contentLength: ORIGINAL.length });
      fs.writeFileSync(file, ORIGINAL, { flag: 'wx', mode: 0o600 });
      await options.onProgress?.({ receivedBytes: ORIGINAL.length, totalBytes: ORIGINAL.length });
      return { size: ORIGINAL.length, contentType: 'video/mp4' };
    },
  });
  return { ...source, calls };
}
async function safeReject(promise) {
  await assert.rejects(promise, error => {
    assert.ok(!/PRIVATE_|https?:\/\/|trusted-yt|\.youtube-/.test(`${error.message}\n${JSON.stringify(error)}`));
    assert.equal(error.cause, undefined); return true;
  });
}

test('single-video URL parsing is local, canonical, credential-free and never follows a shortener', () => {
  for (const value of [URL, `https://youtu.be/${ID}?si=discard#t=12`, `https://m.youtube.com/watch?v=${ID}&t=14s`,
    `https://youtube.com/shorts/${ID}?feature=share`, `${URL}#yt-dlp-smuggled-private-URL`]) assert.equal(youtubeVideoUrl(value), URL);
  for (const value of ['https://public-media.com/watch?v=hi', 'https://youtube.com.evil.com/']) assert.equal(youtubeVideoUrl(value), null);
  for (const value of [`${URL}&list=LIST`, `${URL}&index=1`, `${URL}&v=${ID}`, `${URL}&v=other`,
    'https://www.youtube.com/playlist?list=LIST', 'https://www.youtube.com/results?search_query=x',
    `https://www.youtube.com/live/${ID}`, `https://www.youtube.com/embed/${ID}`, `https://youtu.be/${ID}/x`,
    `https://www.youtube.com/watch?v=short`, `https://www.youtube.com/watch?v=${ID}%2f`,
    `https://www.youtube.com/a/../watch?v=${ID}`, `https://www.youtube.com/watch?v=${ID}&LIST=foo`,
    `https://youtu.be/${ID}?v=${ID}`, `https://evil.youtube.com/watch?v=${ID}`, `http://youtu.be/${ID}`,
    `https://user:PRIVATE_TOKEN@www.youtube.com/watch?v=${ID}`, `https://www.youtube.com:444/watch?v=${ID}`]) {
    assert.throws(() => youtubeVideoUrl(value), undefined, value);
  }
});

test('whole-video result retains one original and discloses format/privacy limits, never captions/description', async t => {
  const directory = scratch(t), fake = fixture(), progress = [];
  const result = await fake.acquireYouTubeVideo({ url: `https://youtu.be/${ID}?t=10`, directory, maxBytes: 100, onProgress: value => progress.push(value) });
  assert.equal(result.file, join(directory, 'source.mp4')); assert.equal(result.extension, 'mp4'); assert.equal(result.kind, 'media');
  assert.deepEqual(fs.readFileSync(result.file), ORIGINAL); assert.equal(result.size, ORIGINAL.length);
  assert.equal(result.provenance.citationUrl, URL); assert.equal(result.provenance.type, 'youtube');
  assert.equal(result.text, undefined); assert.ok(result.warnings.join(' ').includes('progressive'));
  assert.ok(!JSON.stringify(result).includes('PRIVATE_')); assert.ok(!JSON.stringify(result).includes('DO NOT USE'));
  assert.equal(fake.calls.runs.length, 1); assert.equal(fake.calls.downloads.length, 1); assert.equal(progress.length, 1);
  assert.deepEqual(fs.readdirSync(directory), ['source.mp4']);
  const { args, options } = fake.calls.runs[0];
  for (const flag of ['--simulate', '--dump-single-json', '--no-check-formats', '--ignore-config', '--no-config-locations',
    '--no-plugin-dirs', '--no-remote-components', '--no-cookies', '--no-cookies-from-browser', '--no-exec', '--no-js-runtimes',
    '--no-write-subs', '--no-write-auto-subs', '--no-cache-dir', '--no-update']) assert.ok(args.includes(flag), flag);
  assert.equal(args.at(-1), URL); assert.equal(args.at(-2), '--');
  assert.match(args[args.indexOf('--js-runtimes') + 1], /^deno:/); assert.ok(!args.some(a => /^(node|bun):/.test(a)));
  assert.equal(args[args.indexOf('--extractor-args') + 1], 'youtube:skip=hls,dash,translated_subs;fetch_pot=never');
  assert.equal(options.maxBytes, HELPER_OUTPUT_LIMIT); assert.equal(options.timeoutMs, 60000);
  assert.equal(options.env.HOME, options.cwd); assert.equal(options.env.TEMP, options.cwd);
  assert.equal(options.env.HTTP_PROXY, fake.calls.proxies[0].proxy.url); assert.equal(options.env.NO_PROXY, '');
  for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'DENO_PERMISSION_BROKER_PATH', 'DENO_V8_FLAGS', 'LD_PRELOAD', 'PYTHONPATH', 'OPENAI_API_KEY']) assert.equal(options.env[key], undefined);
  assert.equal(fake.calls.loads[0].offline, true);
});

test('metadata must be exact public ordinary VOD, not a playlist/live/DRM/restricted/unknown object', async t => {
  const directory = scratch(t);
  const changes = [{ _type: 'playlist' }, { entries: [] }, { id: 'differentID' }, { extractor_key: 'Generic' },
    { live_status: 'is_live' }, { live_status: 'was_live' }, { live_status: 'post_live' }, { live_status: null },
    { is_live: true }, { was_live: true }, { is_upcoming: true }, { duration: 0 }, { duration: 7201 },
    { duration: null }, { duration: '90' }, { availability: 'private' }, { availability: 'needs_auth' },
    { availability: null }, { has_drm: true }, { playlist_id: 'a' }, { section_start: 0 }, { section_end: 12 }, { formats: [] }];
  for (const patch of changes) {
    const fake = fixture({ metadata: { ...info(), ...patch } });
    await safeReject(fake.acquireYouTubeVideo({ url: URL, directory }));
    assert.equal(fake.calls.downloads.length, 0); assert.deepEqual(fs.readdirSync(directory), []);
  }
});

test('only one verified direct AV format; no audio/video-only, manifests/fragments/DRM/unsupported codec or range fallback', async t => {
  const directory = scratch(t);
  const changes = [{ protocol: 'm3u8_native' }, { protocol: 'http_dash_segments' }, { protocol: 'http' },
    { manifest_url: DIRECT }, { fragments: [] }, { fragment_base_url: DIRECT }, { has_drm: true }, { has_drm: undefined },
    { acodec: 'none' }, { vcodec: 'none' }, { ext: 'm4a' }, { vcodec: 'hev1.1.6.L93.B0' },
    { width: 4000 }, { height: 2400 }, { fps: 120 }, { filesize: 101 }, { filesize: -1 },
    { url: 'https://localhost/private' }, { url: 'https://googlevideo.com.evil.com/videoplayback' },
    { url: 'https://www.youtube.com/watch?v=other' }, { url: DIRECT + '&range=0-10' },
    { url: DIRECT + '&source=yt_live_broadcast' }, { url: DIRECT.replace('videoplayback', 'manifest.mpd') },
    { request_data: 'private' }, { requested_formats: [] }, { section_start: 2 }, { section_end: 3 },
    { url: DIRECT.replace('video%2Fmp4', 'video%2Fwebm') }];
  for (const patch of changes) {
    const metadata = info(); metadata.formats[0] = { ...metadata.formats[0], ...patch };
    const fake = fixture({ metadata });
    await safeReject(fake.acquireYouTubeVideo({ url: URL, directory, maxBytes: 100 }));
    assert.equal(fake.calls.downloads.length, 0); assert.deepEqual(fs.readdirSync(directory), []);
  }
});

test('top-level merged selection/URLs are ignored; selects highest permitted individual progressive AV resource', async t => {
  const directory = scratch(t), metadata = info();
  metadata.url = 'https://127.0.0.1/private'; metadata.requested_formats = [{ url: metadata.url }];
  metadata.formats.push({ ...metadata.formats[0], height: 720, width: 1280, url: DIRECT + '&itag=22' },
    { ...metadata.formats[0], height: 1080, width: 1920, acodec: 'none' });
  const fake = fixture({ metadata }); await fake.acquireYouTubeVideo({ url: URL, directory });
  assert.equal(fake.calls.downloads[0].url, DIRECT + '&itag=22');
  const { options } = fake.calls.downloads[0];
  for (const target of ['https://127.0.0.1/', 'https://public-media.com/video.mp4', DIRECT + '&begin=4',
    'https://evil.googlevideo.com.invalid/videoplayback', 'https://user:pass@rr.googlevideo.com/videoplayback'])
    assert.equal(options.allowUrl(new globalThis.URL(target)), false);
  for (const headers of [{ contentType: 'text/html', contentLength: ORIGINAL.length },
    { contentType: 'video/mp4', contentLength: 0 }, { contentType: 'video/mp4', contentLength: ORIGINAL.length - 1 }]) assert.throws(() => options.limitForHeaders(headers));
});

test('WebM AV and unknown metadata filesize remain original, capped transfers (no audio-only fallback)', async t => {
  const directory = scratch(t), metadata = info();
  metadata.formats[0] = { ...metadata.formats[0], ext: 'webm', vcodec: 'vp9', acodec: 'opus', filesize: null,
    url: DIRECT.replace('video%2Fmp4', 'video%2Fwebm') };
  const fake = fixture({ metadata, download: async (url, file, options) => {
    assert.equal(options.maxBytes, 99); assert.equal(options.allowUrl(new globalThis.URL(url)), true);
    assert.equal(options.allowUrl(new globalThis.URL(DIRECT)), false);
    assert.equal(options.limitForHeaders({ contentType: 'video/webm', contentLength: null }), 99);
    fs.writeFileSync(file, ORIGINAL, { flag: 'wx' }); return { size: ORIGINAL.length };
  } });
  const result = await fake.acquireYouTubeVideo({ url: URL, directory, maxBytes: 99 });
  assert.equal(result.extension, 'webm'); assert.deepEqual(fs.readFileSync(result.file), ORIGINAL);
  assert.deepEqual(fs.readdirSync(directory), ['source.webm']);
});

test('helper/parse/budget failures are redacted and cleaned without a second attempt', async t => {
  const directory = scratch(t);
  for (const options of [{ raw: Buffer.from('PRIVATE_TOKEN not JSON') }, { raw: Buffer.from([0xff]) },
    { raw: Buffer.alloc(HELPER_OUTPUT_LIMIT + 1) }, { raw: Buffer.from('[]') },
    { run: async () => { throw new Error('PRIVATE_TOKEN https://bad.url/?secret'); } },
    { loadAssets: async () => { throw new Error('PRIVATE_TOKEN .cache/path'); } }]) {
    const fake = fixture(options); await safeReject(fake.acquireYouTubeVideo({ url: URL, directory }));
    assert.equal(fake.calls.downloads.length, 0); assert.deepEqual(fs.readdirSync(directory), []);
    assert.ok(fake.calls.runs.length <= 1);
  }
});

test('cancellation awaits helper and proxy cleanup before deleting the private job', async t => {
  const directory = scratch(t), controller = new AbortController(); let settled = false;
  const fake = fixture({ run: async (_exe, _args, options) => {
    controller.abort();
    assert.equal(options.signal.aborted, true); assert.equal(fs.existsSync(options.cwd), true);
    await new Promise(resolve => setTimeout(resolve, 20)); settled = true; throw new Error('PRIVATE_TOKEN');
  } });
  await safeReject(fake.acquireYouTubeVideo({ url: URL, directory, signal: controller.signal }));
  assert.equal(settled, true); assert.deepEqual(fs.readdirSync(directory), []); assert.equal(fake.calls.downloads.length, 0);
});

test('post-download validation/cancel removes only a newly-owned original; existing destinations survive', async t => {
  const directory = scratch(t);
  let fake = fixture({ download: async (_url, file) => { fs.writeFileSync(file, ORIGINAL, { flag: 'wx' }); return { size: 999 }; } });
  await safeReject(fake.acquireYouTubeVideo({ url: URL, directory })); assert.deepEqual(fs.readdirSync(directory), []);
  const controller = new AbortController();
  fake = fixture({ download: async (_url, file) => { fs.writeFileSync(file, ORIGINAL, { flag: 'wx' }); controller.abort(); return { size: ORIGINAL.length }; } });
  await safeReject(fake.acquireYouTubeVideo({ url: URL, directory, signal: controller.signal })); assert.deepEqual(fs.readdirSync(directory), []);
  fs.writeFileSync(join(directory, 'source.mp4'), 'EXISTING PRIVATE FILE');
  fake = fixture(); await safeReject(fake.acquireYouTubeVideo({ url: URL, directory }));
  assert.equal(fs.readFileSync(join(directory, 'source.mp4'), 'utf8'), 'EXISTING PRIVATE FILE');
});

test('safe title/provenance carries neither controls/path separators nor an unsigned extraction URL', async t => {
  const directory = scratch(t), metadata = info(); metadata.title = '../../<b>\n\u202e' + 'x'.repeat(300);
  const result = await fixture({ metadata }).acquireYouTubeVideo({ url: URL, directory });
  assert.ok(result.name.length <= 180); assert.doesNotMatch(result.name, /[\\/\p{Cc}\p{Cf}<>]/u);
  assert.equal(result.provenance.citationUrl, URL);
});
