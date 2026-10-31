import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rename, open, rm, statfs } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppError } from './provider.mjs';
import { validateLesson, validateLessonInput } from './lesson.mjs';
import { buildSpeechBlock, lessonSpeechBlocks, speechWords } from './speech-inventory.mjs';
import { renderLesson } from './render.mjs';

const MiB = 1024 * 1024;
export const AUDIO_LIMITS = Object.freeze({ audioBytes: 128 * MiB, metadataBytes: 64 * MiB, markupBytes: 64 * MiB, instanceAudioBytes: 512 * MiB, clipBytes: 2 * MiB, ownerPlans: 2 });
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const hash = value => createHash('sha256').update(value).digest('hex');
const bytes = value => Buffer.byteLength(JSON.stringify(value));
const safeWarnings = value => {
  if (!Array.isArray(value) || value.length > 100 || value.some(w => typeof w !== 'string' || w.length > 1000)) throw new AppError('Invalid audio coverage warnings.');
  return [...new Set(value)];
};
const sourceKey = value => { if (typeof value !== 'string' || !value || value.length > 200 || /[\p{Cc}\p{Cf}]/u.test(value) || value.startsWith('lesson.')) throw new AppError('Invalid audio source identifier.'); return value; };
const safeFailure = error => error instanceof AppError ? error : new AppError(error?.name === 'MediaImportError' ? error.message + ' The successful speech result is retained for local encoding recovery.' : 'Local audio preparation failed. Completed clips and the text lesson remain available.', 422);

// Private temporary files are NOT a durable account/job store. No keys are persisted.
export function createAudioPlanStore({ directory = tmpdir(), limits: overrides = {}, removeDirectory = path => rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) } = {}) {
  const limits = { ...AUDIO_LIMITS, ...overrides };
  const plans = new Map(); let rootPromise, reserved = 0, closed = false, exporting = false;
  const root = () => rootPromise ||= mkdtemp(join(directory, 'learnlens-audio-'));
  const get = (owner, id) => { const plan = plans.get(id); if (closed || !plan || plan.deleting || plan.owner !== owner) throw new AppError('Audio plan not found or expired. The downloaded lesson is unaffected.', 404); return plan; };
  const alive = plan => { if (closed || plan.deleting || plans.get(plan.id) !== plan || plan.controller.signal.aborted) throw new AppError('Audio workspace closed. No further speech request was made.', 409); };
  async function atomic(plan, filename, value) {
    alive(plan);
    const target = join(plan.directory, filename), temporary = target + '.tmp';
    await writeFile(temporary, value, { mode: 0o600 }); alive(plan); await rename(temporary, target); alive(plan);
  }
  function capacity(owner) {
    if (closed) throw new AppError('Audio workspace is stopping.', 503);
    if ([...plans.values()].filter(p => p.owner === owner).length >= limits.ownerPlans || reserved + limits.audioBytes > limits.instanceAudioBytes) throw new AppError('Temporary audio workspace quota reached. Download or remove an unused audio plan before starting another. No content was truncated.', 413);
  }
  function summary(plan) {
    const values = [...plan.clips.values()], completedClips = values.filter(c => c.status === 'complete').length;
    return { status: !plan.sealed ? 'collecting' : completedClips === values.length ? 'complete' : values.some(c => ['failed', 'encoding_failed', 'damaged'].includes(c.status)) ? 'partial' : 'ready',
      totalClips: values.length, completedClips, totalUnits: plan.units.length, sourceCount: plan.sources.size, expectedSources: plan.expectedSources.size, bytes: plan.audioBytes,
      sourceUncertainties: [...plan.sources.values()].filter(s => s.coverage !== 'complete' || s.extraction === 'vision' || s.extraction === 'transcription').length };
  }
  const clipView = clip => ({ id: clip.id, status: clip.status, attempts: clip.attempts, ...(clip.error ? { error: clip.error } : {}) });
  function status(owner, id) {
    const plan = get(owner, id);
    return { id, setupRevision: plan.setupRevision, speech: plan.speech, summary: summary(plan), clips: [...plan.clips.values()].map(clipView), sourceKeys: [...plan.sources.keys()], warnings: [...plan.warnings] };
  }
  function clipStatus(owner, id, clipId) {
    const plan = get(owner, id), clip = plan.clips.get(clipId);
    if (!clip) throw new AppError('Audio clip not found.', 404);
    return { clip: clipView(clip), summary: summary(plan) };
  }
  function addInventory(plan, inventory, additionalBytes = 0) {
    const newClips = inventory.clips.filter(c => !plan.clips.has(c.id));
    const cost = bytes({ block: inventory.block, units: inventory.units, clips: newClips }) + additionalBytes;
    // Conservative upper bound on escaped text, per-word controls and sentence controls.
    const markup = Buffer.byteLength(inventory.block.text) * 20 + speechWords(inventory.block.text).length * 512 + inventory.units.filter(u => u.kind === 'sentence').length * 512 + 4096;
    if (plan.metadataBytes + cost > limits.metadataBytes || plan.markupBytes + markup > limits.markupBytes) throw new AppError('Interactive audio text/markup storage quota reached. No source was silently truncated; completed work remains available. Ask the host for more capacity.', 413);
    plan.blocks.push(inventory.block); plan.units.push(...inventory.units);
    for (const c of newClips) plan.clips.set(c.id, { ...c, status: 'pending', attempts: 0 });
    inventory.warnings.forEach(w => plan.warnings.add(w));
    plan.metadataBytes += cost; plan.markupBytes += markup;
  }
  async function create(owner, body, { speech, setupRevision, speechIdentity }) {
    if (!uuid(body.id)) throw new AppError('Audio plan ID must be a UUID.');
    const lesson = validateLesson(body.lesson);
    const input = validateLessonInput({ text: body.sourceText || 'Generated lesson', images: body.images || [] });
    const warnings = safeWarnings(body.warnings || []);
    if (!Array.isArray(body.expectedSources) || body.expectedSources.length > 100000) throw new AppError('Invalid expected audio source list.');
    const keys = body.expectedSources.map(sourceKey);
    if (new Set(keys).size !== keys.length) throw new AppError('Duplicate expected audio source identifier.');
    const definition = { lesson, images: input.images, sourceText: body.sourceText ? input.text : '', warnings, expectedSources: keys, speech, speechIdentity };
    const fingerprint = hash(JSON.stringify(definition));
    if (plans.has(body.id)) {
      const old = get(owner, body.id);
      if (old.fingerprint !== fingerprint) throw new AppError('Audio plan identifier already has different content.', 409);
      if (!old.directory || old.creating) throw new AppError('Audio plan creation is still in progress. Read its status before continuing.', 409);
      return status(owner, body.id);
    }
    capacity(owner);
    const plan = { id: body.id, owner, fingerprint, lesson, images: input.images, sourceText: definition.sourceText, speech: structuredClone(speech), speechIdentity, setupRevision,
      expectedSources: new Set(keys), sources: new Map(), blocks: [], units: [], clips: new Map(), attempts: new Map(), warnings: new Set(warnings), metadataBytes: bytes(definition), markupBytes: 16384,
      audioBytes: 0, sealed: false, creating: true, writing: false, running: false, controller: new AbortController(), raw: null };
    if (plan.metadataBytes > limits.metadataBytes) throw new AppError('Audio metadata storage quota reached.', 413);
    for (const block of lessonSpeechBlocks(lesson)) addInventory(plan, buildSpeechBlock(block));
    // Reserve synchronously, before disk awaits, including plans currently being created.
    plans.set(plan.id, plan); reserved += limits.audioBytes;
    try {
      const base = await root(); alive(plan);
      const space = await statfs(base); alive(plan);
      if (space.bavail * space.bsize < limits.audioBytes + limits.metadataBytes + 256 * MiB) throw new AppError('Not enough temporary disk space for a full audio plan.', 507);
      // Unique physical directories prevent old cleanup from touching a reused logical ID.
      plan.directoryPromise = mkdtemp(join(base, plan.id + '-'));
      plan.directory = await plan.directoryPromise; alive(plan);
      await atomic(plan, 'plan.json', JSON.stringify({ version: 1, id: plan.id, ...definition, speechIdentity: undefined, setupRevision }));
      plan.creating = false;
      return status(owner, plan.id);
    } catch (error) { await remove(owner, plan.id); if (plan.directory) await rm(plan.directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); throw safeFailure(error); }
  }
  function assertSetup(owner, id, revision) {
    const plan = get(owner, id);
    if (plan.setupRevision !== revision) throw new AppError('Audio setup changed. Review the current speech settings and confirm audio continuation again. No automatic retry was made.', 409);
    return plan.speech;
  }
  async function reconfirm(owner, id, { setupRevision, speechIdentity }) {
    const plan = get(owner, id);
    if (plan.speechIdentity !== speechIdentity) throw new AppError('This audio plan uses a different speech model, provider or voice. Keep its download; changing voices requires a new audio plan, not replaying this one.', 409);
    if (plan.running || plan.writing) throw new AppError('Wait for the current audio operation to finish.', 409);
    plan.setupRevision = setupRevision;
    return status(owner, id);
  }
  async function addSource(owner, id, source) {
    const plan = get(owner, id);
    if (!source || typeof source !== 'object' || Array.isArray(source)) throw new AppError('Expected an audio source descriptor.');
    const key = sourceKey(source.key);
    if (!plan.expectedSources.has(key)) throw new AppError('Audio source was not declared by this plan.', 409);
    if (!['text', 'transcription', 'vision', 'unavailable'].includes(source.extraction) || !['complete', 'uncertain', 'no_english', 'unavailable'].includes(source.coverage)) throw new AppError('Invalid source extraction coverage.');
    const warnings = safeWarnings(source.warnings || []);
    const descriptor = { key, text: source.text, source: source.source, origin: 'uploaded', extraction: source.extraction, coverage: source.coverage, warnings };
    const digest = hash(JSON.stringify(descriptor)), prior = plan.sources.get(key);
    if (prior) { if (prior.digest !== digest) throw new AppError('Audio source identifier already has different content.', 409); return { summary: summary(plan), key }; }
    if (plan.sealed || plan.writing || plan.creating) throw new AppError('Audio source inventory is sealed or busy.', 409);
    const inventory = buildSpeechBlock(descriptor);
    // Validate budgets without modifying the plan, before committing a source file.
    const candidate = { ...plan, blocks: [], units: [], clips: new Map(plan.clips), warnings: new Set(plan.warnings) };
    addInventory(candidate, inventory, bytes(descriptor));
    plan.writing = true;
    try {
      await atomic(plan, 'source-' + hash(key) + '.json', JSON.stringify(descriptor));
      addInventory(plan, inventory, bytes(descriptor));
      plan.sources.set(key, { digest, extraction: descriptor.extraction, coverage: descriptor.coverage });
      warnings.forEach(w => plan.warnings.add(w));
      if (descriptor.extraction === 'vision') plan.warnings.add('Source images were read by AI. Audio completion covers the extracted text, not independently verified recognition of every original word. Compare it with the source images.');
      if (descriptor.extraction === 'transcription') plan.warnings.add('Source recordings were automatically transcribed. Words or names may be missing or incorrect; audio completion is not transcription or pronunciation verification.');
      if (descriptor.coverage === 'uncertain' || descriptor.coverage === 'unavailable') plan.warnings.add('Some source extraction is uncertain or unavailable. All retained targets are listed, but complete recognition of the uploaded originals is not established.');
      return { summary: summary(plan), key };
    } finally { plan.writing = false; }
  }
  async function seal(owner, id) {
    const plan = get(owner, id);
    if (plan.writing || plan.creating) throw new AppError('Audio inventory is still being written.', 409);
    if (plan.sources.size !== plan.expectedSources.size) throw new AppError('Audio source inventory is incomplete. Add every declared source before narration.', 409);
    if (!plan.sealed) {
      plan.writing = true;
      try { await atomic(plan, 'inventory.json', JSON.stringify({ version: 1, sources: [...plan.sources], clips: [...plan.clips.keys()], summary: summary(plan) })); plan.sealed = true; }
      finally { plan.writing = false; }
    }
    return status(owner, id);
  }
  async function synthesize(owner, id, clipId, { attemptId, retry = false, generate, encode, checkCurrent = () => {} }) {
    const plan = get(owner, id), clip = plan.clips.get(clipId);
    if (!clip || !uuid(attemptId)) throw new AppError('Invalid audio clip or attempt ID.');
    const prior = plan.attempts.get(attemptId);
    if (prior) {
      if (prior !== clipId) throw new AppError('Audio attempt ID already belongs to another clip.', 409);
      return clipStatus(owner, id, clipId); // Never dispatch a repeated attempt ID.
    }
    if (clip.status === 'complete') return clipStatus(owner, id, clipId);
    if (!plan.sealed || plan.creating || plan.writing || plan.running) throw new AppError('Audio plan is not ready or another clip is still running.', 409);
    if (clip.status !== 'pending' && retry !== true) throw new AppError('Failed or unknown audio requires explicit retry confirmation with a new attempt ID.', 409);
    if (plan.raw && plan.raw.clipId !== clipId) throw new AppError('Finish encoding the saved speech clip before requesting another. No provider request was made.', 409);
    // Reserve the worst allowed clip size BEFORE any possibly billable operation.
    if (plan.audioBytes - (clip.bytes || 0) + limits.clipBytes > limits.audioBytes || plan.metadataBytes + 512 > limits.metadataBytes) throw new AppError('Audio storage quota reached. Completed clips are preserved; no new speech request was made.', 413);
    plan.running = true; plan.attempts.set(attemptId, clipId); plan.metadataBytes += 512; clip.attempts++; clip.status = 'processing'; delete clip.error;
    try {
      await atomic(plan, clipId + '.json', JSON.stringify({ ...clipView(clip), attemptId }));
      alive(plan); checkCurrent();
      if (!plan.raw) {
        const raw = await generate(clip.text); alive(plan); checkCurrent();
        if (!raw || !Buffer.isBuffer(raw.buffer) || !raw.buffer.length || raw.buffer.length > 8 * MiB) throw new AppError('Speech returned invalid or oversized audio.', 502);
        plan.raw = { ...raw, clipId }; // Keep a successful paid result if local encoding fails.
      }
      const data = await encode(plan.raw, { signal: plan.controller.signal }); alive(plan); checkCurrent();
      if (!Buffer.isBuffer(data) || !data.length || data.length > limits.clipBytes) throw new AppError('Encoded speech exceeded the per-clip storage budget; no audio was truncated.', 413);
      await atomic(plan, clipId + '.mp3', data);
      plan.audioBytes += data.length - (clip.bytes || 0); clip.bytes = data.length; clip.sha256 = hash(data); clip.status = 'complete';
      await atomic(plan, clipId + '.json', JSON.stringify({ ...clipView(clip), bytes: clip.bytes, sha256: clip.sha256, attemptId }));
      plan.raw = null;
      return clipStatus(owner, id, clipId);
    } catch (error) {
      if (plans.get(id) === plan && !plan.deleting) {
        clip.status = plan.raw?.clipId === clipId ? 'encoding_failed' : 'failed'; clip.error = safeFailure(error).message;
        await atomic(plan, clipId + '.json', JSON.stringify({ ...clipView(clip), attemptId })).catch(() => {});
      }
      throw safeFailure(error);
    } finally { plan.running = false; }
  }
  async function exportLesson(owner, id) {
    const plan = get(owner, id);
    if (exporting || plan.writing || plan.running || plan.creating) throw new AppError('An audio operation or export is running. Wait before exporting.', 409);
    exporting = true;
    try {
      const clips = [];
      for (const clip of plan.clips.values()) {
        let dataUrl;
        if (clip.status === 'complete') {
          try {
            const file = await open(join(plan.directory, clip.id + '.mp3'), 'r'); let data;
            try {
              if ((await file.stat()).size !== clip.bytes || clip.bytes > limits.clipBytes) throw new Error('Integrity');
              const buffer = Buffer.alloc(clip.bytes + 1); let count = 0;
              while (count < buffer.length) { const result = await file.read(buffer, count, buffer.length - count, count); if (!result.bytesRead) break; count += result.bytesRead; }
              data = buffer.subarray(0, count);
            } finally { await file.close(); }
            alive(plan);
            if (data.length !== clip.bytes || hash(data) !== clip.sha256) throw new Error('Integrity');
            dataUrl = 'data:audio/mpeg;base64,' + data.toString('base64');
          } catch (error) { alive(plan); clip.status = 'damaged'; clip.error = 'Cached audio failed integrity verification. Explicit regeneration is required.'; plan.audioBytes -= clip.bytes || 0; clip.bytes = 0; plan.warnings.add(clip.error); }
        }
        clips.push({ id: clip.id, text: clip.text, ...(dataUrl ? { dataUrl } : {}) });
      }
      const audioSummary = summary(plan), warnings = [...plan.warnings];
      if (audioSummary.status !== 'complete') warnings.unshift('Audio is incomplete. Missing targets remain visible; use Continue audio in the original workspace. Reloading or restarting clears session-only recovery.');
      warnings.push('Full audio targets English/Latin-script text, including all detected words rather than selected keywords. Latin script is not language detection; English voices may mispronounce other languages. Non-Latin translations remain readable but are not narrated.');
      const html = renderLesson(plan.lesson, { images: plan.images, sourceText: plan.sourceText, warnings,
        audioCourse: { blocks: plan.blocks, units: plan.units, clips, summary: audioSummary, warnings: [] } });
      if (Buffer.byteLength(html) > 256 * MiB) throw new AppError('Single-file HTML exceeds the export memory budget. Audio clips are retained; no partial file was presented as complete.', 413);
      alive(plan);
      return { id, title: plan.lesson.title, lesson: plan.lesson, html, warnings, audioSummary };
    } finally { exporting = false; }
  }
  async function remove(owner, id) {
    const plan = plans.get(id); if (!plan) return;
    if (plan.owner !== owner) throw new AppError('Audio plan not found.', 404);
    plan.deleting = true; plan.controller.abort(); plan.raw = null;
    if (plan.removal) return plan.removal;
    plan.retryCleanupAfter = Date.now() + 60000;
    plan.removal = (async () => {
      // Keep ownership + reservation until actual deletion succeeds. A failed
      // cleanup remains retryable by DELETE, logout, expiry or normal shutdown.
      const directory = plan.directory || (plan.directoryPromise ? await plan.directoryPromise.catch(() => null) : null);
      if (directory) await removeDirectory(directory);
      if (plans.get(id) === plan) { plans.delete(id); reserved -= limits.audioBytes; }
    })();
    try { await plan.removal; } finally { plan.removal = null; }
  }
  async function clearOwner(owner) { await Promise.all([...plans.values()].filter(p => p.owner === owner).map(p => remove(owner, p.id))); }
  async function retryCleanup(now = Date.now()) {
    // Maintenance is independent of live/authenticated sessions. One bounded
    // filesystem cleanup per retired plan per minute; never any provider work.
    await Promise.allSettled([...plans.values()].filter(p => p.deleting && !p.removal && p.retryCleanupAfter <= now).map(p => remove(p.owner, p.id)));
  }
  async function close() { closed = true; await Promise.all([...plans.values()].map(p => remove(p.owner, p.id))); if (rootPromise) await rm(await rootPromise, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
  return { create, capacity, status, clipStatus, assertSetup, reconfirm, addSource, seal, synthesize, exportLesson, remove, clearOwner, retryCleanup, close, limits };
}
