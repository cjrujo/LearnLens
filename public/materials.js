// Local originals never go to a provider. Only bounded extracted parts do, after consent.
import { AudioSourceCollector, isContiguousAudioText, validateVisionExtraction, TRANSCRIPTION_WARNING } from './audio-sources.js';
// Mirror lib/material-digest.mjs: decoded UTF-16 defensive cap, not the 2200
// soft prompt target/local passthrough threshold. Retain accepted text exactly.
const MODEL_DIGEST_NOTE_MAX_CHARS = 8000;
// Two SHA-256 hex strings (stable identity -> pinned identity), counted as UTF-16.
const SOURCE_INDEX_ENTRY_BYTES = 256;
const orderedParts = items => JSON.stringify(items.map(item => [item.id, item.partCount]));
const el = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; };
const bytesOf = url => Math.ceil((url.split(',')[1]?.length || 0) * .75);
const split = (text, size = 20000) => {
  const parts = [];
  for (let start = 0; start < text.length;) { let end = Math.min(text.length, start + size); if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--; parts.push(text.slice(start, end)); start = end; }
  return parts;
};
async function readText(file) {
  const reader = file.stream().getReader(); let decoder, text = '';
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      decoder ||= new TextDecoder(value[0] === 255 && value[1] === 254 ? 'utf-16le' : value[0] === 254 && value[1] === 255 ? 'utf-16be' : 'utf-8', { fatal: true });
      text += decoder.decode(value, { stream: true });
      if (text.length > 2000000) throw new Error('Text exceeds this workspace’s two-million-character processing quota.');
    }
    text += decoder?.decode() || ''; return text;
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
const asDataUrl = blob => new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('Could not read file.')); reader.readAsDataURL(blob); });
async function hash(value) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(n => n.toString(16).padStart(2, '0')).join(''); }
async function normalizeImage(dataUrl, name) {
  const image = new Image(); image.src = dataUrl; await image.decode();
  if (bytesOf(dataUrl) <= 4 * 1024 * 1024 && image.width * image.height <= 25000000) return { name, dataUrl };
  const scale = Math.min(1, 2400 / Math.max(image.width, image.height));
  const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(image.width * scale)); canvas.height = Math.max(1, Math.round(image.height * scale));
  const context = canvas.getContext('2d'); context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return { name, dataUrl: canvas.toDataURL('image/jpeg', .8) };
}
export class MaterialWorkspace {
  constructor({ list, api, changed }) {
    this.list = list; this.api = api; this.changed = changed; this.items = []; this.epoch = 0; this.locked = false; this.pending = 0; this.queue = Promise.resolve(); this.controllers = new Set(); this.cache = new Map(); this.cacheBytes = 0; this.checkpoint = null; this.preparing = false;
  }
  get busy() { return this.pending > 0; }
  get partCount() { return this.items.reduce((n, item) => n + (item.partCount || 0), 0); }
  // Preview images are disposable (opening another attachment clears them).
  // OCR consent must instead remember video capability from the durable manifest;
  // unknown media is conservative, while a known audio-only file stays false.
  get hasVisuals() { return this.items.some(item => item.kind === 'image' || item.kind === 'document' || (item.kind === 'media' && item.manifest?.hasVideo !== false) || item.preview?.images?.length); }
  get needsTranscription() { return this.items.some(item => item.kind === 'media' && item.manifest?.hasAudio !== false); }
  setLocked(value) { this.locked = value; this.list.querySelectorAll('button,select').forEach(node => node.disabled = value || this.busy); }
  check(epoch) { if (epoch !== this.epoch) throw new DOMException('Stopped. Your draft and completed work remain on this page.', 'AbortError'); }
  cancelPending({ session = false } = {}) {
    this.epoch++; for (const controller of this.controllers) controller.abort();
    if (session) this.discardCheckpoint();
    else if (this.checkpoint) this.checkpointProgress(this.checkpoint);
    for (const item of this.items) {
      if (item.status === 'preparing') { item.status = 'error'; item.error = 'Import stopped. Resume local import to continue.'; }
      if (session && item.remote) item.needsUpload = true;
    }
    this.render();
  }
  async local(path, options, epoch) {
    this.check(epoch); const controller = new AbortController(); this.controllers.add(controller);
    try { const result = await this.api(path, { ...options, signal: controller.signal }); this.check(epoch); return result; }
    finally { this.controllers.delete(controller); }
  }
  note(item, value) { for (const warning of value || []) if (!item.warnings.includes(String(warning)) && item.warnings.length < 30) item.warnings.push(String(warning).slice(0, 500)); }
  async upload(item, epoch) {
    if (item.needsUpload) { item.remoteId = crypto.randomUUID(); item.manifest = null; item.createAttempted = false; item.needsUpload = false; }
    const base = '/materials/' + item.remoteId;
    let manifest = item.manifest;
    if (!manifest) {
      // A previous create acknowledgement may have been lost; check its stable ID before creating again.
      if (item.createAttempted) {
        try { manifest = await this.local(base, {}, epoch); }
        catch (error) { if (error.status !== 404) throw error; }
      }
      if (!manifest) { item.createAttempted = true; manifest = await this.local('/materials', { method: 'POST', body: { id: item.remoteId, name: item.name, size: item.file.size } }, epoch); }
    } else manifest = await this.local(base, {}, epoch);
    item.manifest = manifest;
    let offset = manifest.received || 0;
    while (offset < item.file.size) {
      const end = Math.min(offset + 4194304, item.file.size); let attempts = 0;
      for (;;) {
        this.check(epoch); item.progress = `Uploading locally · ${Math.floor(offset / item.file.size * 100)}%`; this.render();
        try { manifest = await this.local(base + '/content?offset=' + offset, { method: 'PUT', raw: item.file.slice(offset, end) }, epoch); break; }
        catch (error) {
          this.check(epoch); if (!error.network || attempts++ >= 2) throw error;
          // Only local upload requests may be replayed. A status check resolves a lost acknowledgement.
          const status = await this.local(base, {}, epoch);
          if (status.received >= end) { manifest = status; break; }
          if (status.received < offset || status.received > end) throw new Error('Unexpected upload offset. Resume local import.');
          offset = status.received;
        }
      }
      if (!Number.isInteger(manifest.received) || manifest.received <= offset || manifest.received > item.file.size) throw new Error('Upload did not advance. Resume local import.');
      offset = manifest.received; item.manifest = manifest;
    }
    item.progress = 'Preparing automatic parts locally… The first cached media engine setup may take several minutes.'; this.render();
    if (manifest.status !== 'ready') {
      for (let attempt = 0; ; attempt++) {
        try { manifest = await this.local(base + '/finish', { method: 'POST', body: {} }, epoch); break; }
        catch (error) {
          this.check(epoch); if (!error.network || attempt >= 2) throw error;
          manifest = await this.local(base, {}, epoch);
          if (manifest.status === 'ready') break;
        }
      }
    }
    if (manifest.status !== 'ready' || !Number.isInteger(manifest.partCount) || manifest.partCount < 1) throw new Error(manifest.error || 'Local preparation is not ready. Resume local import.');
    item.manifest = manifest; item.partCount = manifest.partCount; item.kind = manifest.kind; this.note(item, manifest.warnings);
  }
  enqueue(work) {
    this.pending++; this.changed();
    const next = this.queue.then(work); this.queue = next.catch(() => {});
    return next.finally(() => { this.pending--; this.render(); });
  }
  add(files) {
    if (this.locked) return Promise.reject(new Error('Wait for the current request before adding materials.'));
    const epoch = this.epoch, selected = [...files];
    return this.enqueue(async () => {
      const errors = [];
      for (const file of selected) {
        this.check(epoch);
        const signature = `${file.name}:${file.size}:${file.lastModified}`;
        if (this.items.some(item => item.signature === signature)) continue;
        const item = { id: crypto.randomUUID(), remoteId: crypto.randomUUID(), signature, file, name: (file.name || 'Pasted material').slice(0, 180), status: 'preparing', warnings: [] };
        this.items.push(item); this.render();
        try { await this.importItem(item, epoch); }
        catch (error) { this.check(epoch); item.status = 'error'; item.error = error.message; errors.push(item.name + ': ' + error.message); }
        this.render();
      }
      return errors;
    });
  }
  async importItem(item, epoch) {
    item.status = 'preparing'; item.error = ''; this.render();
    if (!item.file.size) throw new Error('This file is empty.');
    const ext = item.name.split('.').pop().toLowerCase();
    if (['txt', 'md', 'markdown'].includes(ext)) {
      item.kind = 'text'; item.text = await readText(item.file); this.check(epoch);
      if (!item.text.trim()) throw new Error('No text was found.');
      item.textParts = split(item.text); item.partCount = item.textParts.length; delete item.text;
    } else if (['png', 'jpg', 'jpeg', 'webp'].includes(ext) || /^image\/(png|jpeg|webp)$/.test(item.file.type)) {
      item.kind = 'image'; item.partCount = 1;
    } else if (['pdf', 'docx', 'pptx', 'mp3', 'mp4', 'webm', 'wav', 'ogg'].includes(ext)) {
      item.remote = true; await this.upload(item, epoch);
    } else throw new Error('Supported: images, TXT/MD, PDF, DOCX, PPTX, MP3, MP4, WebM, WAV and OGG.');
    this.check(epoch);
    await this.loadPreview(item, 0, epoch); this.check(epoch); item.status = 'ready';
  }
  async part(item, index, epoch) {
    this.check(epoch);
    if (item.remote) return this.local('/materials/' + item.remoteId + '/parts', { method: 'POST', body: { index } }, epoch);
    if (item.kind === 'text') return { text: item.textParts[index], images: [], label: `Text part ${index + 1}` };
    const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' }[item.name.split('.').pop().toLowerCase()] || item.file.type;
    const original = await asDataUrl(item.file.slice(0, item.file.size, mime)); const image = await normalizeImage(original, item.name); this.check(epoch);
    if (original !== image.dataUrl) this.note(item, ['Image was resized locally for provider input; fine detail may be lost.']);
    return { text: '', images: [image], label: 'Image' };
  }
  async loadPreview(item, index, epoch) {
    const part = await this.part(item, index, epoch); this.check(epoch);
    // No audio is retained; only one review part at a time, with a global visual preview budget.
    for (const other of this.items) if (other !== item && other.preview) other.preview.images = [];
    const images = []; let size = 0;
    for (const image of part.images || []) { if (images.length === 5 || size + bytesOf(image.dataUrl) > 8 * 1024 * 1024) break; images.push(image); size += bytesOf(image.dataUrl); }
    item.preview = { index, label: part.label, text: (part.text || '').slice(0, 40000), images, audio: Boolean(part.audio), truncated: (part.text || '').length > 40000 || images.length < (part.images || []).length };
    this.note(item, part.warnings);
  }
  resume(item) {
    if (this.locked || this.busy) return;
    const epoch = this.epoch;
    this.enqueue(async () => { try { await this.importItem(item, epoch); } catch (error) { if (epoch === this.epoch) { item.status = 'error'; item.error = error.message; } } }).catch(() => {});
  }
  async remove(item) {
    if (this.locked || this.busy) return;
    const epoch = this.epoch;
    await this.enqueue(async () => {
      try {
        if (item.remote && !item.needsUpload && item.createAttempted) await this.local('/materials/' + item.remoteId, { method: 'DELETE' }, epoch);
        this.check(epoch); this.items = this.items.filter(other => other !== item);
      } catch (error) { if (epoch === this.epoch && error.status === 404) this.items = this.items.filter(other => other !== item); else if (epoch === this.epoch) item.error = 'Could not clean up original: ' + error.message; }
    });
  }
  describe({ completeAudio = false } = {}) {
    const audioParts = this.items.filter(item => item.kind === 'media' && item.manifest?.hasAudio !== false).reduce((n, item) => n + item.partCount, 0);
    const estimate = 1 + audioParts + (this.partCount > 1 ? this.partCount : 0);
    return this.items.map(item => `${item.name}: ${item.partCount || '?'} automatic part(s)${item.kind === 'media' && item.manifest?.hasAudio !== false ? ', speech transcription per part' : ''}`).join('\n') + `\nEstimated base: about ${estimate} billable request(s) before cache reuse, merges, dense text/image batches or spoken examples. Work: ${this.partCount} part(s), ${this.needsTranscription ? 'one transcription per media part, ' : ''}${this.partCount > 1 ? 'one or more AI digests per part plus possible merge digests, ' : 'digests only if needed, '}then one final lesson request. Spoken examples may add calls. Actual calls depend on content; no fixed price is implied. Successful cached work is reused. Preparation stops at 512 calls.` + (completeAudio ? '\nFull English audio also extracts English text from every source image, with potentially billable primary-model calls per image (not just representative previews). Full source text can require many narration clips and additional billable speech calls. Extraction/transcription may omit or misread content; neither complete coverage nor an exact call count is guaranteed.' : '');
  }
  cachePut(key, value) {
    const size = JSON.stringify(value).length * 2;
    if (size > 8 * 1024 * 1024) return;
    while (this.cache.size && (this.cacheBytes + size > 8 * 1024 * 1024 || this.cache.size >= 1024)) { const first = this.cache.keys().next().value; this.cacheBytes -= this.cache.get(first).size; this.cache.delete(first); }
    this.cache.set(key, { value, size }); this.cacheBytes += size;
  }
  checkpointInfo() {
    const job = this.checkpoint;
    // Count/status only: complete still describes ordinary preparation, not the later inventory.
    if (!job || job.invalidated) return { available: false, complete: false, audioSourceStarted: false, audioSourceComplete: false, completedCalls: 0, completedParts: 0, totalParts: 0, stage: 'unavailable', unavailable: true };
    return { available: true, complete: Boolean(job.result), audioSourceStarted: Boolean(job.completeAudio || job.audioWork), audioSourceComplete: Array.isArray(job.completeAudio ? job.result?.audioSources : job.audioWork?.result), completedCalls: job.pinned.size, completedParts: job.completedParts.size, totalParts: job.totalParts, stage: job.stage,
      ...(job.part === undefined ? {} : { part: job.part }), ...(job.failed ? { failed: true } : {}), ...(job.unavailable ? { unavailable: true } : {}) };
  }
  discardCheckpoint() {
    const job = this.checkpoint;
    if (!job) return;
    job.invalidated = true; job.pinned.clear(); job.pinnedBytes = 0; job.sourceIndex.clear(); job.sourceIndexBytes = 0; job.generator = null; job.pending = null; job.accepted = undefined; job.result = null;
    if (job.audioWork) {
      // Drop our references, never clear a source array already transferred to the caller.
      job.audioWork.generator = null; job.audioWork.pending = null; job.audioWork.accepted = undefined; job.audioWork.result = null; job.audioWork.completedParts.clear(); job.audioWork = null;
    }
    this.checkpoint = null;
    this.checkpointProgress(job, 'Saved preparation discarded.');
  }
  checkpointProgress(job, message = job.message) {
    job.message = message;
    // A display callback must not turn an accepted paid result into lost work.
    try { job.progress?.(message, this.checkpointInfo()); } catch {}
  }
  checkPreparation(job) {
    if (job.invalidated || this.checkpoint !== job) throw new DOMException('Saved preparation was discarded. Start a new request.', 'AbortError');
    this.check(job.epoch);
    if (job.upgrading) this.checkAudioInputs(job);
  }
  checkAudioInputs(job) {
    if (job.itemInputs !== orderedParts(this.items) || job.itemInputs !== orderedParts(job.items)) throw new Error('Audio sources require the same ordered materials and part counts as the completed lesson. Start a new lesson after changing attachments.');
    if (this.busy || [...this.items, ...job.items].some(item => item.status !== 'ready' || item.needsUpload)) throw new Error('The retained local material session is not ready or was lost. Restore materials and start a new lesson.');
  }
  pinPreparation(job, key, result, sourceKey = null) {
    const added = !job.pinned.has(key), indexed = sourceKey && !job.sourceIndex.has(sourceKey);
    const size = added ? JSON.stringify(result).length * 2 : 0;
    const indexSize = indexed ? SOURCE_INDEX_ENTRY_BYTES : 0;
    if (size > 1024 * 1024 || (added && job.pinned.size >= 4096) || (indexed && job.sourceIndex.size >= 4096) || job.pinnedBytes + job.sourceIndexBytes + size + indexSize > 64 * 1024 * 1024) {
      job.unavailable = true;
      throw new Error('Preparation checkpoint quota exceeded (64 MiB, 4096 results/index entries, 1 MiB per result). Earlier successes remain saved; no further paid calls were made.');
    }
    if (added) { job.pinned.set(key, result); job.pinnedBytes += size; }
    // No body, image, filename or raw stable identity is retained in this bounded index.
    if (sourceKey) { job.sourceIndex.set(sourceKey, key); job.sourceIndexBytes += indexSize; }
  }
  async indexedSourceResult(job, path, stable) {
    this.checkPreparation(job);
    const sourceKey = await hash(JSON.stringify([path, stable]));
    this.checkPreparation(job);
    const key = job.sourceIndex.get(sourceKey);
    if (!key) return undefined;
    if (!job.pinned.has(key)) throw new Error('A saved source result is missing. No replacement request was dispatched; start a new lesson.');
    return job.pinned.get(key);
  }
  async preparationRequest(job, request) {
    this.checkPreparation(job);
    const [key, sourceKey] = await Promise.all([
      hash(JSON.stringify([request.path, request.stable, request.body])),
      request.path === '/transcribe' || request.path === '/audio/extract' ? hash(JSON.stringify([request.path, request.stable])) : null
    ]);
    this.checkPreparation(job);
    if (job.pinned.has(key)) {
      const result = job.pinned.get(key); this.pinPreparation(job, key, result, sourceKey); return result;
    }
    if (!job.roles?.[request.role]) throw new Error(request.role === 'transcription' ? 'Assign a transcription model for attached audio or video.' : 'Assign a primary model for unfinished material preparation.');
    // Consent and current revision are attached only at dispatch, never captured by a suspended yield.
    const body = request.path === '/materials/summarize'
      ? { consent: true, expectedSetupRevision: job.revision, ...request.body }
      : { ...request.body, consent: true, expectedSetupRevision: job.revision };
    const cacheKey = await hash(JSON.stringify([request.stable, job.roles[request.role], body]));
    this.checkPreparation(job);
    const cached = this.cache.get(cacheKey);
    if (cached) {
      this.pinPreparation(job, key, cached.value, sourceKey); this.checkpointProgress(job);
      this.checkPreparation(job); return cached.value;
    }
    // Reserve worst-case response space before incurring any new billable request. Never evict a checkpoint.
    const indexSize = sourceKey && !job.sourceIndex.has(sourceKey) ? SOURCE_INDEX_ENTRY_BYTES : 0;
    if (job.pinned.size >= 4096 || (indexSize && job.sourceIndex.size >= 4096) || job.pinnedBytes + job.sourceIndexBytes + indexSize + 1024 * 1024 > 64 * 1024 * 1024) {
      job.unavailable = true;
      throw new Error('Preparation checkpoint quota reached (64 MiB / 4096 results/index entries). Earlier successes remain saved; no further paid calls were made.');
    }
    if (job.calls >= 512) throw new Error('The automatic preparation safety budget of 512 calls was reached. Completed work is saved in this page. Review with your app administrator before continuing.');
    job.calls++;
    const controller = new AbortController(); this.controllers.add(controller);
    try {
      // Unlike local imports, an acknowledged success is saved even if ordinary Stop raced its response.
      const result = await this.api(request.path, { method: 'POST', body, signal: controller.signal });
      if (job.invalidated || this.checkpoint !== job) this.checkPreparation(job);
      if (request.path === '/audio/extract') validateVisionExtraction(result);
      else if (typeof result?.text !== 'string' || !result.text.trim() || (request.path.endsWith('/summarize') && result.text.length > MODEL_DIGEST_NOTE_MAX_CHARS)) throw new Error('The provider returned an invalid preparation result. No further paid calls were made.');
      this.pinPreparation(job, key, result, sourceKey);
      this.cachePut(cacheKey, result);
      this.checkpointProgress(job);
      this.checkPreparation(job);
      return result;
    } finally { this.controllers.delete(controller); }
  }
  async prepare({ consent, goal, roles, expectedSetupRevision, progress = () => {}, completeAudio = false, resume = false }) {
    if (this.preparing) throw new Error('A preparation request is already running. Stop or wait before continuing.');
    if (!consent) throw new Error('Explicit paid consent is required.');
    if (!Number.isInteger(expectedSetupRevision)) throw new Error('A confirmed AI setup revision is required. Refresh setup and confirm again.');
    const inputs = JSON.stringify([goal, completeAudio, this.items.map(item => [item.id, item.partCount])]);
    if (resume && (!this.checkpoint || this.checkpoint.inputs !== inputs)) throw new Error('No matching preparation checkpoint. The goal, audio option and ordered materials must match; start a new request.');
    if (this.busy) throw new Error('Wait for local imports to finish.');
    if (this.items.some(item => item.status !== 'ready')) throw new Error('Resume failed local imports before creating the lesson.');
    const approvedRoles = structuredClone(roles);
    if (!resume) {
      this.discardCheckpoint();
      this.checkpoint = { inputs, itemInputs: orderedParts(this.items), items: [...this.items], goal, completeAudio, totalParts: this.partCount, pinned: new Map(), pinnedBytes: 0, sourceIndex: new Map(), sourceIndexBytes: 0, completedParts: new Set(), stage: 'starting', message: 'Preparing materials…' };
    }
    const job = this.checkpoint;
    Object.assign(job, { epoch: this.epoch, roles: approvedRoles, revision: expectedSetupRevision, progress, calls: 0, failed: false, unavailable: false });
    this.preparing = true;
    try {
      this.checkpointProgress(job);
      this.checkPreparation(job);
      if (job.result) return job.result;
      const result = await this.drivePreparation(job, job);
      this.checkPreparation(job); return result;
    } catch (error) {
      if (!job.invalidated) { job.failed = true; this.checkpointProgress(job); }
      throw error;
    } finally {
      this.preparing = false;
      // Keep no approved setup or callback closure in a dormant checkpoint.
      job.roles = null; job.progress = null;
    }
  }
  /**
   * Post-teaching inventory only; the caller owns subject policy, consent and UI locking.
   * Returns AudioSource[] without replacing or amending job.result. Requires the completed
   * checkpoint and its unchanged ordered attachments/local session; never creates a new job.
   * Held STT/OCR ignores current roles. Only unfinished OCR uses approved primary/revision.
   * resume:false shares prepare's remaining 512-call allowance. After interruption,
   * resume:true explicitly renews consent/allowance and continues the suspended yield;
   * it may also initialize audioWork after a renewed confirmation before the first upgrade.
   * checkpointInfo.audioSourceStarted/Complete are content-free status flags (including
   * eager completeAudio preparation); ordinary complete/completedParts keep their meaning.
   */
  async upgradeAudioSources({ consent, roles, expectedSetupRevision, progress = () => {}, resume = false }) {
    if (this.preparing) throw new Error('A preparation request is already running. Stop or wait before continuing.');
    if (!consent) throw new Error('Explicit paid consent is required.');
    if (!Number.isInteger(expectedSetupRevision)) throw new Error('A confirmed AI setup revision is required. Refresh setup and confirm again.');
    const job = this.checkpoint;
    if (!job || job.invalidated || !job.result) throw new Error('A completed preparation checkpoint is required to upgrade audio sources. Start or finish lesson preparation first.');
    this.checkAudioInputs(job);
    if (job.completeAudio && Array.isArray(job.result.audioSources)) return job.result.audioSources;
    if (job.audioWork && !job.audioWork.result && !resume) throw new Error('Audio source work was interrupted. Confirm consent and explicitly resume to continue; no automatic retry was made.');
    const approvedRoles = structuredClone(roles);
    const work = job.audioWork ||= { generator: null, pending: null, accepted: undefined, result: null, completedParts: new Set() };
    Object.assign(job, { epoch: this.epoch, roles: approvedRoles, revision: expectedSetupRevision, progress, calls: resume ? 0 : job.calls, failed: false, unavailable: false, upgrading: true });
    this.preparing = true;
    try {
      this.checkpointProgress(job, work.pending ? job.message : 'Collecting full audio sources…');
      this.checkPreparation(job);
      if (work.result) return work.result;
      const result = await this.drivePreparation(job, work, true);
      this.checkPreparation(job); return result;
    } catch (error) {
      if (!job.invalidated) { job.failed = true; this.checkpointProgress(job); }
      throw error;
    } finally {
      this.preparing = false; job.upgrading = false; job.roles = null; job.progress = null;
    }
  }
  async drivePreparation(job, work, audio = false) {
    for (;;) {
      this.checkPreparation(job);
      if (!work.pending) {
        work.generator ||= audio ? this.audioSourceSteps(job, work) : this.preparationSteps(job);
        let step;
        try { step = await work.generator.next(work.accepted); }
        catch (error) {
          // Local failures close generators. Rebuild collectors from pinned successes, never paid replay.
          work.generator = null; work.accepted = undefined;
          throw error;
        }
        work.accepted = undefined;
        if (job.invalidated || this.checkpoint !== job) this.checkPreparation(job);
        if (step.done) {
          work.result = step.value; work.generator = null; job.stage = 'complete';
          this.checkpointProgress(job, audio ? 'Audio source inventory complete.' : 'Material preparation complete.');
          this.checkPreparation(job); return work.result;
        }
        // Save the yielded position before checking an ordinary Stop race.
        work.pending = step.value;
        this.checkPreparation(job);
      }
      job.stage = work.pending.stage; this.checkpointProgress(job);
      const result = await this.preparationRequest(job, work.pending);
      this.checkPreparation(job);
      work.pending = null; work.accepted = result;
    }
  }
  async * audioSourceSteps(job, work) {
    const collector = new AudioSourceCollector();
    let processed = 0;
    for (const item of job.items) {
      this.checkPreparation(job);
      const key = await hash(item.id); this.checkPreparation(job);
      collector.beginItem({ key, source: item.name, contiguous: isContiguousAudioText(item) });
      for (let index = 0; index < item.partCount; index++) {
        job.part = ++processed; job.stage = 'audio-reading';
        this.checkpointProgress(job, `Collecting audio sources · part ${processed} of ${job.totalParts}`);
        const part = await this.part(item, index, job.epoch); this.checkPreparation(job);
        const stable = item.id + ':' + index;
        const source = `${item.name} · ${part.label || `part ${index + 1}`} (${index + 1}/${item.partCount})`;
        const warnings = [...item.warnings, ...(part.warnings || [])];
        collector.addPart({ index, text: part.text || '', source, warnings, hasAlternativeExtraction: Boolean(part.audio || part.images?.length) });
        if (part.audio) {
          // An upgrade must NEVER retranscribe, even if the general cache was evicted or STT removed.
          const result = await this.indexedSourceResult(job, '/transcribe', stable + ':transcription');
          if (!result) throw new Error('The saved transcription needed for full audio is unavailable. No transcription was dispatched. Start a new lesson to prepare the original again.');
          collector.addTranscription({ index, text: result.text, source: source + ' · speech', warnings: [...warnings, ...(result.warnings || [])] });
          delete part.audio;
        }
        for (let imageIndex = 0; imageIndex < (part.images || []).length; imageIndex++) {
          const original = part.images[imageIndex];
          const image = await normalizeImage(original.dataUrl, (source.slice(0, 200) + ' · ' + original.name).slice(0, 180)); this.checkPreparation(job);
          const imageStable = stable + ':audio-extract:' + imageIndex;
          const held = await this.indexedSourceResult(job, '/audio/extract', imageStable);
          const result = held ?? (yield { path: '/audio/extract', body: { image }, stable: imageStable, role: 'primary', stage: 'extraction' });
          collector.addVision({ index, imageIndex, result, source: `Image ${imageIndex + 1} · ${source} · ${original.name || 'visual'}`, warnings: [...warnings, ...(image.dataUrl !== original.dataUrl ? ['Some extracted visuals were resized; fine detail may be lost.'] : [])] });
        }
        this.checkPreparation(job); work.completedParts.add(processed); this.checkpointProgress(job);
      }
      collector.endItem();
    }
    this.checkPreparation(job);
    return collector.finish();
  }
  async * preparationSteps(job) {
    const { goal, completeAudio } = job;
    let processed = 0, visualCount = 0, digested = false;
    const representatives = [], warnings = [], notes = [];
    const audioCollector = completeAudio ? new AudioSourceCollector() : null;
    const progress = message => this.checkpointProgress(job, message);
    const completePart = () => { job.completedParts.add(processed); this.checkpointProgress(job); };
    const warn = value => { const text = String(value).slice(0, 500); if (!warnings.includes(text) && warnings.length < 29) warnings.push(text); };
    const digest = async function* (text, images, source, stable) {
      const result = yield { path: '/materials/summarize', body: { text, images, goal, source: source.slice(0, 200) }, stable, role: 'primary', stage: stable === 'merge' ? 'merge' : 'digest' };
      if (result.preparationMode !== 'verbatim') digested = true;
      for (const warning of result.warnings || []) warn(source + ': ' + warning);
      return `[Source: ${source.slice(0, 200)}]\n${result.text}`;
    };
    for (const item of job.items) {
      this.checkPreparation(job);
      if (item.needsUpload) { progress('Restoring local original: ' + item.name); await this.upload(item, job.epoch); }
      if (audioCollector) { const key = await hash(item.id); this.checkPreparation(job); audioCollector.beginItem({ key, source: item.name, contiguous: isContiguousAudioText(item) }); }
      for (let index = 0; index < item.partCount; index++) {
        job.part = ++processed; job.stage = 'reading';
        progress(`Processing part ${processed} of ${job.totalParts} · ${item.name}`);
        const part = await this.part(item, index, job.epoch); this.checkPreparation(job);
        const source = `${item.name} · ${part.label || `part ${index + 1}`} (${index + 1}/${item.partCount})`.slice(0, 200), stable = item.id + ':' + index;
        for (const warning of [...item.warnings, ...(part.warnings || [])]) warn(item.name + ': ' + warning);
        let text = part.text || '';
        const audioSource = `${item.name} · ${part.label || `part ${index + 1}`} (${index + 1}/${item.partCount})`;
        const extractionWarnings = [...item.warnings, ...(part.warnings || [])];
        audioCollector?.addPart({ index, text, source: audioSource, warnings: extractionWarnings, hasAlternativeExtraction: Boolean(part.audio || part.images?.length) });
        if (part.audio) {
          const result = yield { path: '/transcribe', body: { dataUrl: part.audio, name: source.slice(0, 180) }, stable: stable + ':transcription', role: 'transcription', stage: 'transcription' };
          audioCollector?.addTranscription({ index, text: result.text, source: audioSource + ' · speech', warnings: [...extractionWarnings, ...(result.warnings || [])] });
          text = [text, result.text].filter(Boolean).join('\n'); delete part.audio;
          warn(item.name + ': ' + TRANSCRIPTION_WARNING);
        }
        const visuals = [];
        for (const original of part.images || []) {
          const image = await normalizeImage(original.dataUrl, (source + ' · ' + original.name).slice(0, 180)); this.checkPreparation(job); visuals.push(image); visualCount++;
          const resizeWarning = 'Some extracted visuals were resized; fine detail may be lost.';
          if (image.dataUrl !== original.dataUrl) warn(item.name + ': ' + resizeWarning);
          if (audioCollector) {
            const imageIndex = visuals.length - 1;
            const result = yield { path: '/audio/extract', body: { image }, stable: stable + ':audio-extract:' + imageIndex, role: 'primary', stage: 'extraction' };
            audioCollector.addVision({ index, imageIndex, result, source: `Image ${imageIndex + 1} · ${audioSource} · ${original.name || 'visual'}`, warnings: [...extractionWarnings, ...(image.dataUrl !== original.dataUrl ? [resizeWarning] : [])] });
            for (const warning of result.warnings) warn(source + ': ' + warning);
          }
          if (representatives.length < 5 && representatives.reduce((n, entry) => n + bytesOf(entry.dataUrl), 0) + bytesOf(image.dataUrl) <= 8 * 1024 * 1024) representatives.push(image);
        }
        if (!text.trim() && !visuals.length) { warn(source + ': No readable text, speech or visuals were extracted.'); completePart(); continue; }
        const mustDigest = job.totalParts > 1 || text.length + source.length + 12 > 35000 || visuals.length > 5 || visuals.reduce((n, image) => n + bytesOf(image.dataUrl), 0) > 8 * 1024 * 1024;
        if (!mustDigest) { notes.push(text ? `[Source: ${source}]\n${text}` : ''); completePart(); continue; }
        const pieces = split(text); const batches = []; let batch = [], size = 0;
        for (const image of visuals) { if (batch.length === 5 || size + bytesOf(image.dataUrl) > 8 * 1024 * 1024) { batches.push(batch); batch = []; size = 0; } batch.push(image); size += bytesOf(image.dataUrl); }
        if (batch.length) batches.push(batch);
        for (let p = 0; p < Math.max(pieces.length, batches.length); p++) notes.push(yield* digest(pieces[p] || '', batches[p] || [], source, stable + ':digest:' + p));
        completePart();
      }
      audioCollector?.endItem();
    }
    if (!audioCollector && job.items.length && !notes.some(text => text.trim()) && !representatives.length) throw new Error('No readable material was extracted. Review the local previews; your attachments remain intact.');
    let merged = notes.filter(Boolean);
    while (merged.join('\n\n').length > 35000) {
      const groups = []; let group = [];
      for (const note of merged) { if ([...group, note].join('\n\n').length > 30000 && group.length) { groups.push(group.join('\n\n')); group = []; } group.push(note); }
      if (group.length) groups.push(group.join('\n\n'));
      const next = [];
      for (let i = 0; i < groups.length; i++) { progress(`Merging source notes ${i + 1} of ${groups.length}`); next.push(yield* digest(groups[i], [], 'Merged source notes (retain source labels)', 'merge')); }
      if (next.join('\n\n').length >= merged.join('\n\n').length) throw new Error('AI notes did not become shorter. Completed work is saved; no further calls were made.');
      merged = next;
    }
    this.checkPreparation(job);
    if (digested) warnings.unshift('AI digests are lossy and are not guaranteed verbatim. All extracted parts were processed; verify important details against the originals.');
    if (visualCount > representatives.length) warnings.unshift(`All ${visualCount} extracted visuals were processed, but only ${representatives.length} representative preview images are embedded in the lesson.`);
    if (warnings.length >= 29) warnings.splice(29, Infinity, 'Additional source limitations may be shown in the local material review.');
    return { text: merged.join('\n\n') || (!representatives.length ? goal : ''), images: representatives, sourceWarnings: warnings, ...(audioCollector ? { audioSources: audioCollector.finish() } : {}) };
  }
  render() {
    const open = new Set([...this.list.querySelectorAll('details[open]')].map(node => node.dataset.id));
    this.list.replaceChildren(); this.list.hidden = !this.items.length;
    for (const item of this.items) {
      const li = el('li', undefined, 'material-card'), heading = el('div', undefined, 'material-heading');
      const remove = el('button', 'Remove', 'btn quiet small'); remove.type = 'button'; remove.setAttribute('aria-label', 'Remove ' + item.name); remove.onclick = () => this.remove(item);
      heading.append(el('strong', item.name), remove); li.append(heading);
      li.append(el('p', item.error || (item.status === 'preparing' ? item.progress || 'Reading locally…' : `${item.partCount} automatic part(s) · original not sent to AI`), item.error ? 'inline-message error' : 'field-hint'));
      if (item.status === 'error') { const retry = el('button', 'Resume local import', 'btn secondary small'); retry.type = 'button'; retry.onclick = () => this.resume(item); li.append(retry); }
      if (item.preview) {
        const review = el('details', undefined, 'material-review'); review.dataset.id = item.id; review.open = open.has(item.id); review.append(el('summary', 'Optional review · read-only local preview'));
        const label = el('label', 'Preview part'), select = el('select'); select.id = 'part-' + item.id; label.htmlFor = select.id;
        for (let i = 0; i < item.partCount; i++) { const option = el('option', `Part ${i + 1} of ${item.partCount}`); option.value = String(i); select.append(option); }
        select.value = String(item.preview.index);
        const load = el('button', 'Load local preview', 'btn secondary small'); load.type = 'button'; load.onclick = () => {
          if (this.locked || this.busy) return; const epoch = this.epoch, index = Number(select.value);
          this.enqueue(async () => { try { if (item.needsUpload) await this.upload(item, epoch); await this.loadPreview(item, index, epoch); item.error = ''; } catch (error) { if (epoch === this.epoch) item.error = error.message; } }).catch(() => {});
        };
        review.append(label, select, load, el('p', 'Read-only preview; all parts are processed automatically during creation. This is not a partial source editor.', 'field-hint'));
        if (item.preview.audio) review.append(el('p', 'Audio is prepared locally. Transcription happens only after paid consent during creation.', 'field-hint'));
        if (item.preview.text) review.append(el('pre', item.preview.text, 'material-text-preview'));
        if (item.preview.truncated) review.append(el('p', 'Preview shortened for display only; creation processes the full part.', 'field-hint'));
        const visuals = el('div', undefined, 'material-visuals'); for (const image of item.preview.images) { const img = el('img'); img.src = image.dataUrl; img.alt = image.name || item.name; img.loading = 'lazy'; visuals.append(img); } review.append(visuals);
        if (!item.preview.images.length && item.kind !== 'text') review.append(el('p', 'Use Load local preview to refresh visuals. Only the most recently loaded visual preview is retained.', 'field-hint'));
        const warnings = el('ul', undefined, 'import-warnings'); for (const warning of item.warnings) warnings.append(el('li', warning)); review.append(warnings); li.append(review);
      }
      this.list.append(li);
    }
    this.setLocked(this.locked); this.changed();
  }
  dispose() { this.cancelPending(); }
}
