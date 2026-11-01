import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ensureMediaTools } from '../deploy/media-assets.mjs';
import { runMediaProcess } from '../lib/native-media.mjs';
import * as video from '../lib/video-clips.mjs';
import { createMaterialStore } from '../lib/material-store.mjs';
import { createVideoPlanStore } from '../lib/video-plans.mjs';

test('real WebM import seals private timing once and prepares a clip without exposing the proof', { skip: process.env.LEARNLENS_MEDIA_INTEGRATION !== '1', timeout: 180000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'learnlens-video-store-native-'));
  let inspected = 0;
  const materials = createMaterialStore({ directory, limits: { minFreeBytes: 0 }, videoLoader: async () => ({ ...video,
    inspectWholeVideoSource: async (...args) => { inspected++; assert.match(args[3].sourceHash, /^[a-f0-9]{64}$/); return video.inspectWholeVideoSource(...args); } }) });
  const plans = createVideoPlanStore({ directory, materials });
  t.after(async () => { await plans.close(); await materials.close(); await rm(directory, { recursive: true, force: true }); });
  const tools = await ensureMediaTools({ offline: true }), source = join(directory, 'synthetic.webm');
  await runMediaProcess(tools.ffmpeg, ['-v', 'error', '-nostdin', '-f', 'lavfi', '-i', 'color=white:s=160x90:r=8:d=1.25',
    '-an', '-c:v', 'libvpx-vp9', '-threads', '2', '-f', 'webm', source], { maxBytes: 1024 * 1024, timeoutMs: 120000 });
  const original = await readFile(source), id = randomUUID();
  await materials.create('owner', { id, name: 'synthetic.webm', size: original.length, analysisMode: 'whole-video' });
  await materials.append('owner', id, 0, original);
  const manifest = await materials.finish('owner', id);
  assert.equal(manifest.status, 'ready'); assert.equal(manifest.analysisMode, 'whole-video');
  await materials.finish('owner', id); await materials.part('owner', id, 0); assert.equal(inspected, 1);
  const plan = await plans.create('owner', id, { fps: 24 });
  assert.doesNotMatch(JSON.stringify([manifest, plan]), /sourceTiming|pathHash|mtime|"seal"/);
  await materials.withSnapshot('owner', id, async snapshot => {
    assert.ok(snapshot.info.sourceTiming); assert.equal(snapshot.videoPlan.sourceTiming.seal, snapshot.info.sourceTiming.seal);
    const prepared = await video.prepareVideoClip(snapshot.file, snapshot.extension, 0, snapshot.videoPlan, { signal: snapshot.signal, sourceHash: snapshot.sourceHash });
    assert.equal(prepared.hasAudio, false); assert.equal(prepared.hasVideo, true); assert.equal(prepared.tracks[0].type, 'video'); assert.equal(prepared.end, 1.25); assert.equal(prepared.tracks[0].duration, 1.25);
    assert.deepEqual(await readFile(snapshot.file), original);
  });
  assert.equal(inspected, 1); assert.deepEqual(await readFile(source), original);
});
