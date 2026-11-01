// Explicit CI-only public-network verification. No provider/AI request or login.
// Uses this repository's authored fixtures plus example.com; optional YouTube
// trial uses yt-dlp's public test video. No retries, DNS overrides or proxy secrets.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createMaterialStore } from '../lib/material-store.mjs';
import { prepareVideoClip } from '../lib/video-clips.mjs';

const youtube = process.argv.includes('--youtube');
const sha = process.env.GITHUB_SHA;
if (process.env.LEARNLENS_PUBLIC_URL_TEST !== '1' || !/^[a-f0-9]{40}$/.test(sha || '')) {
  throw Error('Public URL smoke requires explicit LEARNLENS_PUBLIC_URL_TEST=1 and an exact public GITHUB_SHA.');
}
const directory = await mkdtemp(join(tmpdir(), 'learnlens-public-smoke-'));
const materials = createMaterialStore({ directory, limits: { minFreeBytes: 0, mediaBytes: 64 * 1024 * 1024 } });
const report = { commit: sha, platform: process.platform, startedAt: new Date().toISOString(), aiRequests: 0, automaticRetries: 0, checks: [] };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function acquire(url, mode) {
  const id = randomUUID(); await materials.startImport('public-smoke', { id, url, mode });
  const deadline = Date.now() + 240000;
  let result;
  while (Date.now() < deadline) {
    result = materials.status('public-smoke', id);
    if (['ready', 'error'].includes(result.status)) break;
    await delay(50);
  }
  assert.equal(result.status, 'ready', result.error || 'Public import did not settle');
  assert.equal(result.snapshotReady, true);
  return { id, result };
}
try {
  const sources = youtube
    ? [{ name: 'youtube-public-test', url: 'https://www.youtube.com/watch?v=BaW_jenozKc', mode: 'video' }]
    : [
      { name: 'static-public-html', url: 'https://example.com/', mode: 'webpage' },
      ...['txt', 'wav', 'mp4'].map(extension => ({ name: `authored-${extension}`, extension,
        url: `https://raw.githubusercontent.com/cjrujo/LearnLens/${sha}/tests/fixtures/url-public.${extension}`, mode: extension === 'wav' ? 'audio' : extension === 'mp4' ? 'video' : 'webpage' })),
    ];
  for (const source of sources) {
    const { id, result } = await acquire(source.url, source.mode);
    const check = { name: source.name, status: 'PASS', bytes: result.size, parts: result.partCount, sourceHash: result.sourceHash };
    if (source.extension) {
      const expected = await readFile(new URL(`./fixtures/url-public.${source.extension}`, import.meta.url));
      assert.equal(result.sourceHash, digest(expected)); assert.equal(result.size, expected.length);
      await materials.withSnapshot('public-smoke', id, async snapshot => assert.deepEqual(await readFile(snapshot.file), expected));
    }
    if (source.mode === 'webpage') {
      const part = await materials.part('public-smoke', id, 0);
      assert.match(part.text, source.extension ? /END_OF_COMPLETE_SOURCE/ : /Example Domain/i);
    } else if (source.mode === 'audio') {
      assert.equal(result.hasVideo, false); assert.equal(result.hasAudio, true);
      const part = await materials.part('public-smoke', id, 0); assert.match(part.audio, /^data:audio\/wav;base64,/);
    } else {
      assert.equal(result.analysisMode, 'whole-video'); assert.equal(result.hasVideo, true); assert.equal(result.hasAudio, true);
      check.clips = [];
      await materials.withSnapshot('public-smoke', id, async snapshot => {
        for (let index = 0; index < result.partCount; index++) {
          const clip = await prepareVideoClip(snapshot.file, snapshot.extension, index, snapshot.videoPlan,
            { signal: snapshot.signal, sourceHash: snapshot.sourceHash });
          check.clips.push({ start: clip.start, end: clip.end, bytes: clip.byteLength, sha256: clip.videoSha256 });
        }
        assert.equal(digest(await readFile(snapshot.file)), result.sourceHash);
      });
    }
    report.checks.push(check); await materials.remove('public-smoke', id);
  }
  report.status = 'PASS';
} catch (error) {
  report.status = 'FAILED_OR_BLOCKED'; report.error = error.message;
  process.exitCode = 1;
} finally {
  await materials.close(); await rm(directory, { recursive: true, force: true });
  report.finishedAt = new Date().toISOString();
  await mkdir(new URL('../artifacts/', import.meta.url), { recursive: true });
  await writeFile(new URL(`../artifacts/${youtube ? 'youtube-public-smoke' : 'url-public-smoke'}-${process.platform}.json`, import.meta.url), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}
