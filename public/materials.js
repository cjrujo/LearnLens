// Originals stay local. Only bounded extracted parts/native video clips go to AI after consent.
import { AudioSourceCollector, isContiguousAudioText, validateVisionExtraction, TRANSCRIPTION_WARNING } from './audio-sources.js';
import { VideoAnalysisClient, videoFps, videoSourceNotes, validateVideoAnalysis, waitForVideoPoll } from './video-client.js';
// Mirror lib/material-digest.mjs: decoded UTF-16 defensive cap, not the 2200
// soft prompt target/local passthrough threshold. Retain accepted text exactly.
const MODEL_DIGEST_NOTE_MAX_CHARS = 8000;
// Two SHA-256 hex strings (stable identity -> pinned identity), counted as UTF-16.
const SOURCE_INDEX_ENTRY_BYTES = 256;
const snapshotOf = item => item.manifest?.snapshotId || item.snapshotId || null;
const sourceIdentity = item => snapshotOf(item) ? JSON.stringify([item.id, item.remoteId, snapshotOf(item)]) : item.id;
const wholeVideo = item => item.manifest?.analysisMode === 'whole-video' && item.manifest?.hasVideo !== false;
const orderedParts = items => JSON.stringify(items.map(item => [item.id, item.remoteId || null, snapshotOf(item), item.partCount]));
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
  constructor({ list, api, changed, confirmUrlImport, wait }) {
    this.list = list; this.api = api; this.changed = changed; this.confirmUrlImport = confirmUrlImport; this.wait = wait; this.items = []; this.epoch = 0; this.locked = false; this.pending = 0; this.queue = Promise.resolve(); this.controllers = new Set(); this.cache = new Map(); this.cacheBytes = 0; this.checkpoint = null; this.preparing = false;
  }
  // Lazy: legacy/non-video work does not initialize a native-video transport.
  get videoClient() { return this._videoClient ||= new VideoAnalysisClient({ api: (...args) => this.api(...args), ...(this.wait ? { wait: this.wait } : {}) }); }
  get busy() { return this.pending > 0; }
  get partCount() { return this.items.reduce((n, item) => n + (item.partCount || 0), 0); }
  // Preview images are disposable (opening another attachment clears them).
  // OCR consent must instead remember video capability from the durable manifest;
  // unknown media is conservative, while a known audio-only file stays false.
  get hasVisuals() { return this.items.some(item => !wholeVideo(item) && (item.kind === 'image' || item.kind === 'document' || (item.kind === 'media' && item.manifest?.hasVideo !== false) || item.preview?.images?.length)); }
  get needsTranscription() { return this.items.some(item => !wholeVideo(item) && item.kind === 'media' && item.manifest?.hasAudio !== false); }
  get needsVideoAnalysis() { return this.items.some(item => wholeVideo(item) && (item.videoReceiptSnapshot !== snapshotOf(item) || item.videoReceipts?.size !== item.partCount)); }
  setLocked(value) { this.locked = value; this.list.querySelectorAll('button,select').forEach(node => node.disabled = value || this.preparing || (this.busy && node.dataset?.action !== 'cancel-url')); }
  check(epoch) { if (epoch !== this.epoch) throw new DOMException('Stopped. Your draft and completed work remain on this page.', 'AbortError'); }
  cancelPending({ session = false } = {}) {
    this.epoch++; for (const controller of this.controllers) controller.abort();
    if (session) this.discardCheckpoint();
    else if (this.checkpoint) this.checkpointProgress(this.checkpoint);
    for (const item of this.items) {
      if (item.status === 'preparing') {
        item.status = 'error'; item.error = 'Import stopped. Resume local import to continue.';
        if (item.sourceType === 'url') { item.error = 'URL import cancelled. Explicitly reimport to fetch a new snapshot.'; this.cancelUrlImport(item); }
      }
      if (session && item.remote) {
        item.needsUpload = true; item.videoReceipts = null; item.videoPlan = null;
        item.status = 'error';
        item.error = item.sourceType === 'url' ? 'The private snapshot session was lost. Explicitly reimport this URL; no external refetch was made.' : 'The local material session was lost. Resume local import to restore the retained upload before starting a new lesson.';
      }
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
    if (item.sourceType === 'url') throw new Error('A URL snapshot cannot be uploaded or fetched automatically. Explicitly reimport it.');
    if (item.needsUpload) { item.remoteId = crypto.randomUUID(); item.manifest = null; item.snapshotId = null; item.videoPlan = null; item.videoReceipts = null; item.createAttempted = false; item.needsUpload = false; }
    const base = '/materials/' + item.remoteId;
    let manifest = item.manifest;
    if (!manifest) {
      // A previous create acknowledgement may have been lost; check its stable ID before creating again.
      if (item.createAttempted) {
        try { manifest = await this.local(base, {}, epoch); }
        catch (error) { if (error.status !== 404) throw error; }
      }
      if (!manifest) { item.createAttempted = true; manifest = await this.local('/materials', { method: 'POST', body: { id: item.remoteId, name: item.name, size: item.file.size, ...(/\.(mp4|webm)$/i.test(item.name) ? { analysisMode: 'whole-video' } : {}) } }, epoch); }
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
    this.acceptManifest(item, manifest);
  }
  enqueue(work) {
    this.pending++; this.changed();
    const next = this.queue.then(work); this.queue = next.catch(() => {});
    return next.finally(() => { this.pending--; this.render(); });
  }
  add(files) {
    if (this.locked || this.busy || this.preparing) return Promise.reject(new Error('Wait for the current request before adding materials.'));
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
  acceptManifest(item, manifest) {
    if (item.sourceType === 'url' && (manifest.snapshotReady !== true || typeof manifest.snapshotId !== 'string' || !manifest.snapshotId)) throw new Error('The URL source has no sealed immutable snapshot. No external refetch was made.');
    if (item.snapshotId && manifest.snapshotId && item.snapshotId !== manifest.snapshotId) throw new Error('The immutable source snapshot changed. Start a new import.');
    if (manifest.status !== 'ready' || !Number.isInteger(manifest.partCount) || manifest.partCount < 1) throw new Error('Local source preparation is not ready.');
    item.manifest = manifest; item.snapshotId = manifest.snapshotId || null; item.partCount = manifest.partCount; item.kind = manifest.kind;
    if (item.sourceType === 'url' && manifest.name) item.name = String(manifest.name).slice(0, 180);
    this.note(item, manifest.warnings);
  }
  async waitForImport(epoch) {
    const controller = new AbortController(); this.controllers.add(controller);
    try { await (this.wait || waitForVideoPoll)(controller.signal); this.check(epoch); }
    finally { this.controllers.delete(controller); }
  }
  addUrl(url, { mode = 'auto' } = {}) {
    if (this.locked || this.busy || this.preparing) return Promise.reject(new Error('Wait for the current request before adding materials.'));
    let parsed;
    try { parsed = new URL(url); } catch { return Promise.reject(new Error('Enter a public HTTPS source URL.')); }
    if (typeof url !== 'string' || url.length > 8192 || parsed.protocol !== 'https:' || parsed.username || parsed.password || !['auto', 'webpage', 'video', 'audio'].includes(mode)) return Promise.reject(new Error('Use a public HTTPS URL without credentials and a supported import mode.'));
    // Allocate synchronously so Stop before the queued POST still tombstones this exact ID.
    const epoch = this.epoch;
    const item = { id: crypto.randomUUID(), remoteId: crypto.randomUUID(), sourceType: 'url', sourceUrl: url.trim(), mode, name: 'URL source', remote: true, status: 'preparing', warnings: [] };
    this.items.push(item);
    return this.enqueue(async () => {
      try { await this.importUrl(item, epoch, { create: true }); return []; }
      catch (error) { this.check(epoch); item.status = 'error'; item.error = 'URL import did not complete. Check local status, or explicitly reimport to fetch a new snapshot.'; return [item.error]; }
    });
  }
  async importUrl(item, epoch, { create = false } = {}) {
    this.check(epoch);
    if (item.cancelled || item.needsUpload) throw new Error('This URL snapshot was cancelled or its session was lost. Explicitly reimport; no external refetch was made.');
    const base = '/materials/' + item.remoteId;
    item.status = 'preparing'; item.error = ''; item.progress = 'Importing a public source into a private local snapshot…'; this.render();
    let manifest;
    if (create && !item.createAttempted) {
      item.createAttempted = true;
      try { manifest = await this.local('/materials/from-url', { method: 'POST', body: { id: item.remoteId, url: item.sourceUrl, mode: item.mode, publicFetchConsent: true } }, epoch); }
      catch (error) { this.check(epoch); if (!error.network) throw new Error('URL import was not accepted. Check local status before explicitly reimporting.'); manifest = await this.local(base, {}, epoch); }
    } else manifest = await this.local(base, {}, epoch); // Lost acknowledgement / resume NEVER recreates or refetches.
    let finished = false;
    for (;;) {
      this.check(epoch); item.manifest = manifest;
      if (manifest.status === 'ready') break;
      if (manifest.status === 'error') {
        if (!create && !finished && manifest.snapshotReady === true) {
          finished = true;
          try { manifest = await this.local(base + '/finish', { method: 'POST', body: {} }, epoch); }
          catch (error) { this.check(epoch); if (!error.network) throw new Error('Local snapshot preparation failed. No external refetch was made.'); manifest = await this.local(base, {}, epoch); }
          continue;
        }
        throw new Error(manifest.snapshotReady ? 'The snapshot is saved. Resume local import to retry processing only.' : 'The URL fetch failed. Explicitly reimport to fetch a new snapshot.');
      }
      if (!['initializing', 'fetching', 'preparing', 'uploading'].includes(manifest.status)) throw new Error('URL import status is unavailable. No external refetch was made.');
      item.progress = manifest.status === 'preparing' ? 'Preparing the saved snapshot locally…' : 'Fetching the public source once…'; this.render();
      await this.waitForImport(epoch); manifest = await this.local(base, {}, epoch);
    }
    this.acceptManifest(item, manifest);
    await this.loadPreview(item, 0, epoch); this.check(epoch); item.status = 'ready';
  }
  cancelUrlImport(item) {
    item.cancelled = true;
    if (item.deletePending) return item.deletePending;
    const id = item.remoteId, epoch = this.epoch;
    const work = Promise.resolve().then(() => this.api('/materials/' + id, { method: 'DELETE' })).catch(error => {
      if (error.status !== 404 && epoch === this.epoch && item.remoteId === id && this.items.includes(item)) item.error = 'URL cancellation cleanup is pending. Remove the source to retry cleanup; no external refetch was made.';
    }).finally(() => { if (item.remoteId === id) item.deletePending = null; if (epoch === this.epoch && this.items.includes(item)) this.render(); });
    item.deletePending = work; return work;
  }
  cancelUrl(item) {
    if (this.locked || this.preparing || !this.items.includes(item) || item.sourceType !== 'url' || item.status !== 'preparing') return;
    this.cancelPending(); return item.deletePending;
  }
  reimportUrl(item) {
    if (this.locked || this.busy || this.preparing || !this.items.includes(item) || item.sourceType !== 'url') return Promise.resolve(false);
    if (!this.confirmUrlImport) return Promise.reject(new Error('Explicit URL reimport confirmation is required.'));
    const epoch = this.epoch;
    return this.enqueue(async () => {
      const confirmed = await this.confirmUrlImport(item.sourceUrl, { mode: item.mode });
      this.check(epoch); if (confirmed !== true || this.locked || this.preparing || !this.items.includes(item)) return false;
      item.status = 'preparing'; item.progress = 'Replacing the private snapshot after confirmed reimport…'; this.render();
      try {
        // A new fetch always has a NEW material ID. Remove the old snapshot/ledger first.
        try { await this.local('/materials/' + item.remoteId, { method: 'DELETE' }, epoch); } catch (error) { if (error.status !== 404) throw error; }
        this.check(epoch); this.discardCheckpoint();
        Object.assign(item, { remoteId: crypto.randomUUID(), snapshotId: null, manifest: null, videoPlan: null, videoReceipts: null, preview: null, partCount: 0, warnings: [], needsUpload: false, createAttempted: false, cancelled: false });
        await this.importUrl(item, epoch, { create: true }); return true;
      } catch (error) { this.check(epoch); item.status = 'error'; item.error = 'URL reimport did not complete. Check local status before explicitly fetching again.'; return false; }
    });
  }
  async importItem(item, epoch) {
    if (item.sourceType === 'url') return this.importUrl(item, epoch);
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
    if (item.remote) {
      const part = await this.local('/materials/' + item.remoteId + '/parts', { method: 'POST', body: { index } }, epoch);
      if (wholeVideo(item)) this.checkVideoPart(item, part, index);
      return part;
    }
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
    if (this.locked || this.busy || this.preparing || !this.items.includes(item)) return;
    const epoch = this.epoch;
    return this.enqueue(async () => { try { await this.importItem(item, epoch); } catch (error) { if (epoch === this.epoch) { item.status = 'error'; item.error = item.sourceType === 'url' ? 'The saved URL snapshot is unavailable or still needs local preparation. Explicitly reimport if the fetch failed or the session was lost; no external refetch was made.' : error.message; } } }).catch(() => {});
  }
  async remove(item) {
    if (this.locked || this.busy || this.preparing || !this.items.includes(item)) return;
    const epoch = this.epoch;
    await this.enqueue(async () => {
      try {
        if (item.sourceType === 'url' || (item.remote && !item.needsUpload && item.createAttempted)) await this.local('/materials/' + item.remoteId, { method: 'DELETE' }, epoch);
        this.check(epoch); this.items = this.items.filter(other => other !== item);
      } catch (error) { if (epoch === this.epoch && error.status === 404) this.items = this.items.filter(other => other !== item); else if (epoch === this.epoch) item.error = item.sourceType === 'url' ? 'Could not clean up the private URL snapshot. Try Remove again.' : 'Could not clean up original: ' + error.message; }
    });
  }
  describe({ completeAudio = false, roles } = {}) {
    const audioParts = this.items.filter(item => !wholeVideo(item) && item.kind === 'media' && item.manifest?.hasAudio !== false).reduce((n, item) => n + item.partCount, 0);
    const videos = this.items.filter(wholeVideo), videoParts = videos.reduce((n, item) => n + item.partCount, 0);
    const estimate = 1 + audioParts + videoParts + (this.partCount > 1 ? this.partCount : 0);
    return this.items.map(item => wholeVideo(item)
      ? `${item.name}: ${item.partCount} native audiovisual clip(s), about 30 seconds each, ${roles?.video ? videoFps(roles.video) : item.videoPlan?.fps || 24} requested FPS${item.manifest?.width && item.manifest?.height ? `, original ${item.manifest.width}×${item.manifest.height}` : ''}; full timeline, speech and screen content together`
      : `${item.name}: ${item.partCount || '?'} automatic part(s)${item.kind === 'media' && item.manifest?.hasAudio !== false ? ', speech transcription per part' : ''}`).join('\n') + `\nEstimated base: about ${estimate} billable request(s) before cache reuse, merges, dense text/image batches or spoken examples. Work: ${this.partCount} part(s), ${this.needsTranscription ? 'one transcription per non-whole-video media part, ' : ''}${videoParts ? 'one native video analysis per unfinished clip (no additional STT or still-image OCR), ' : ''}${this.partCount > 1 ? 'one or more AI digests per part plus possible merge digests, ' : 'digests only if needed, '}then one final lesson request. Spoken examples may add calls. Actual calls depend on content; no fixed price is implied. Successful cached work is reused. Preparation stops at 512 calls.` + (videoParts ? '\nNative video requires an explicitly configured Gemini-compatible video role. Compatibility is not established by audio/image support and is not guaranteed for every gateway/model. Clip counts and requested FPS are cost indicators, not a price. Analysis copies may be resized; sampling and model-reported coverage cannot guarantee every frame or word is understood. FPS is frozen per plan; changing it requires a new generation. Continue may retry failed/unknown clips with renewed paid consent; completed receipts are reused.' : '') + (completeAudio ? '\nFull English audio also extracts English text from every source image outside whole-video materials, with potentially billable primary-model calls per image (not just representative previews). Whole-video audio uses the same saved native receipts, never additional video, STT or image OCR. Full source text can require many narration clips and additional billable speech calls. Extraction/transcription may omit or misread content; neither complete coverage nor an exact call count is guaranteed.' : '');
  }
  checkVideoPart(item, part, index) {
    const ref = part?.videoRef;
    if (!ref || !snapshotOf(item) || ref.materialId !== item.remoteId || ref.snapshotId !== snapshotOf(item) || ref.index !== index || part.analysisMode !== 'whole-video' || !Number.isFinite(part.start) || !Number.isFinite(part.end) || part.start < 0 || part.end <= part.start || part.end - part.start > 30.5 || part.audio || part.video || part.dataUrl || part.text || part.images?.length) throw new Error('The native video part does not match its immutable snapshot. No fallback transcription or image analysis was requested.');
  }
  partStable(job, item, index) { return sourceIdentity(item) + ':' + index + (wholeVideo(item) ? ':video-fps:' + job.videoProfiles.get(sourceIdentity(item)) : ''); }
  async ensureVideoPlan(job, item) {
    this.checkPreparation(job);
    const identity = sourceIdentity(item), prior = job.videoPlans.get(identity);
    if (prior) return prior;
    const controller = new AbortController(); this.controllers.add(controller);
    try {
      const plan = await this.videoClient.plan({ materialId: item.remoteId, snapshotId: snapshotOf(item), fps: job.videoProfiles.get(identity), partCount: item.partCount, duration: item.manifest.duration, sourceHash: item.manifest.sourceHash }, { signal: controller.signal, check: () => this.checkPreparation(job) });
      this.checkPreparation(job); job.videoPlans.set(identity, plan);
      if (item.videoPlan?.id !== plan.id) item.videoReceipts = new Set();
      item.videoPlan = plan; item.videoReceiptSnapshot = snapshotOf(item);
      return plan;
    } finally { this.controllers.delete(controller); }
  }
  reservePreparation(job, sourceKey) {
    const indexSize = sourceKey && !job.sourceIndex.has(sourceKey) ? SOURCE_INDEX_ENTRY_BYTES : 0;
    if (job.pinned.size >= 4096 || (indexSize && job.sourceIndex.size >= 4096) || job.pinnedBytes + job.sourceIndexBytes + indexSize + 1024 * 1024 > 64 * 1024 * 1024) {
      job.unavailable = true;
      throw new Error('Preparation checkpoint quota reached (64 MiB / 4096 results/index entries). Earlier successes remain saved; no further paid calls were made.');
    }
    if (job.calls >= 512) throw new Error('The automatic preparation safety budget of 512 calls was reached. Completed work is saved in this page. Review with your app administrator before continuing.');
    job.calls++;
  }
  async videoPreparationRequest(job, request, key, sourceKey) {
    const controller = new AbortController(); this.controllers.add(controller);
    try {
      return await this.videoClient.analyze({ plan: request.plan, index: request.index, state: request.attempt ||= {}, role: job.roles?.video, consent: true, expectedSetupRevision: job.revision, renewedConsent: job.renewedConsent, signal: controller.signal,
        check: () => this.checkPreparation(job), beforeDispatch: () => this.reservePreparation(job, sourceKey),
        accept: result => {
          if (job.invalidated || this.checkpoint !== job) this.checkPreparation(job);
          this.pinPreparation(job, key, result, sourceKey); this.cachePut(key, result);
          request.item.videoReceipts ||= new Set(); request.item.videoReceipts.add(request.index);
          this.checkpointProgress(job); return result;
        } });
    } finally { this.controllers.delete(controller); }
  }
  cachePut(key, value) {
    const size = JSON.stringify(value).length * 2;
    if (size > 8 * 1024 * 1024) return;
    if (this.cache.has(key)) { this.cacheBytes -= this.cache.get(key).size; this.cache.delete(key); }
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
    if (job.itemInputs !== undefined && (job.itemInputs !== orderedParts(this.items) || job.itemInputs !== orderedParts(job.items))) throw new Error('The ordered materials or immutable snapshots changed. Start a new lesson.');
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
      ['/transcribe', '/audio/extract', '/video/analyze'].includes(request.path) ? hash(JSON.stringify([request.path, request.stable])) : null
    ]);
    this.checkPreparation(job);
    if (job.pinned.has(key)) {
      const result = job.pinned.get(key); this.pinPreparation(job, key, result, sourceKey); return result;
    }
    // /video/analyze is an internal index identity, NEVER an HTTP route.
    if (request.path === '/video/analyze') return this.videoPreparationRequest(job, request, key, sourceKey);
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
    this.reservePreparation(job, sourceKey);
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
    const videoProfiles = this.items.filter(wholeVideo).map(item => [sourceIdentity(item), roles?.video ? videoFps(roles.video) : (resume ? this.checkpoint?.videoProfiles.get(sourceIdentity(item)) : undefined) ?? item.videoPlan?.fps ?? 24]);
    const inputs = JSON.stringify([goal, completeAudio, orderedParts(this.items), videoProfiles]);
    if (resume && (!this.checkpoint || this.checkpoint.inputs !== inputs)) throw new Error('No matching preparation checkpoint. The goal, audio option, ordered material snapshots and video FPS must match; start a new request.');
    if (this.busy) throw new Error('Wait for local imports to finish.');
    if (this.items.some(item => item.status !== 'ready' || item.needsUpload)) throw new Error('Resume failed local imports before creating the lesson.');
    const approvedRoles = structuredClone(roles);
    if (!resume) {
      this.discardCheckpoint();
      this.checkpoint = { inputs, itemInputs: orderedParts(this.items), items: [...this.items], goal, completeAudio, videoProfiles: new Map(videoProfiles), videoPlans: new Map(), totalParts: this.partCount, pinned: new Map(), pinnedBytes: 0, sourceIndex: new Map(), sourceIndexBytes: 0, completedParts: new Set(), stage: 'starting', message: 'Preparing materials…' };
    }
    const job = this.checkpoint;
    Object.assign(job, { epoch: this.epoch, roles: approvedRoles, revision: expectedSetupRevision, progress, renewedConsent: resume === true, calls: 0, failed: false, unavailable: false });
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
      const key = await hash(sourceIdentity(item)); this.checkPreparation(job);
      collector.beginItem({ key, source: item.name, contiguous: isContiguousAudioText(item) });
      for (let index = 0; index < item.partCount; index++) {
        job.part = ++processed; job.stage = 'audio-reading';
        this.checkpointProgress(job, `Collecting audio sources · part ${processed} of ${job.totalParts}`);
        const part = await this.part(item, index, job.epoch); this.checkPreparation(job);
        const stable = this.partStable(job, item, index);
        const source = `${item.name} · ${part.label || `part ${index + 1}`} (${index + 1}/${item.partCount})`;
        const warnings = [...item.warnings, ...(part.warnings || [])];
        collector.addPart({ index, text: part.text || '', source, warnings, hasAlternativeExtraction: Boolean(wholeVideo(item) || part.audio || part.images?.length) });
        if (wholeVideo(item)) {
          this.checkVideoPart(item, part, index);
          const result = await this.indexedSourceResult(job, '/video/analyze', stable + ':video');
          if (!result) throw new Error('The saved native-video receipt needed for full audio is unavailable. No video, transcription or OCR request was made. Start a new lesson.');
          validateVideoAnalysis(result, { start: part.start, end: part.end, fps: job.videoProfiles.get(sourceIdentity(item)), hasAudio: item.manifest.hasAudio });
          collector.addVideoAnalysis({ index, result, source, warnings });
          this.checkPreparation(job); work.completedParts.add(processed); this.checkpointProgress(job); continue;
        }
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
      const plan = wholeVideo(item) ? await this.ensureVideoPlan(job, item) : null;
      if (audioCollector) { const key = await hash(sourceIdentity(item)); this.checkPreparation(job); audioCollector.beginItem({ key, source: item.name, contiguous: isContiguousAudioText(item) }); }
      for (let index = 0; index < item.partCount; index++) {
        job.part = ++processed; job.stage = 'reading';
        progress(`Processing part ${processed} of ${job.totalParts} · ${item.name}`);
        const part = await this.part(item, index, job.epoch); this.checkPreparation(job);
        const source = `${item.name} · ${part.label || `part ${index + 1}`} (${index + 1}/${item.partCount})`.slice(0, 200), stable = this.partStable(job, item, index);
        for (const warning of [...item.warnings, ...(part.warnings || [])]) warn(item.name + ': ' + warning);
        let text = part.text || '';
        const audioSource = `${item.name} · ${part.label || `part ${index + 1}`} (${index + 1}/${item.partCount})`;
        const extractionWarnings = [...item.warnings, ...(part.warnings || [])];
        audioCollector?.addPart({ index, text, source: audioSource, warnings: extractionWarnings, hasAlternativeExtraction: Boolean(plan || part.audio || part.images?.length) });
        if (plan) {
          this.checkVideoPart(item, part, index);
          const clip = plan.clips[index];
          if (clip.start !== part.start || clip.end !== part.end) throw new Error('Native-video clip bounds changed. No analysis was requested.');
          const result = yield { path: '/video/analyze', body: { videoRef: part.videoRef, planId: plan.id, clipId: clip.id, fps: plan.fps }, stable: stable + ':video', role: 'video', stage: 'video-analysis', plan, index, item };
          text = videoSourceNotes(result);
          audioCollector?.addVideoAnalysis({ index, result, source: audioSource, warnings: extractionWarnings });
          for (const warning of result.warnings) warn(source + ': ' + warning);
        }
        if (!plan && part.audio) {
          const result = yield { path: '/transcribe', body: { dataUrl: part.audio, name: source.slice(0, 180) }, stable: stable + ':transcription', role: 'transcription', stage: 'transcription' };
          audioCollector?.addTranscription({ index, text: result.text, source: audioSource + ' · speech', warnings: [...extractionWarnings, ...(result.warnings || [])] });
          text = [text, result.text].filter(Boolean).join('\n'); delete part.audio;
          warn(item.name + ': ' + TRANSCRIPTION_WARNING);
        }
        const visuals = [];
        for (const original of (plan ? [] : part.images || [])) {
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
    const videoPlans = [...job.videoPlans.values()].map(plan => ({ materialId: plan.materialId, snapshotId: plan.snapshotId, planId: plan.id }));
    return { text: merged.join('\n\n') || (!representatives.length ? goal : ''), images: representatives, sourceWarnings: warnings, ...(videoPlans.length ? { videoPlans } : {}), ...(audioCollector ? { audioSources: audioCollector.finish() } : {}) };
  }
  render() {
    const open = new Set([...this.list.querySelectorAll('details[open]')].map(node => node.dataset.id));
    this.list.replaceChildren(); this.list.hidden = !this.items.length;
    for (const item of this.items) {
      const li = el('li', undefined, 'material-card'), heading = el('div', undefined, 'material-heading');
      const remove = el('button', 'Remove', 'btn quiet small'); remove.type = 'button'; remove.setAttribute('aria-label', 'Remove ' + item.name); remove.onclick = () => this.remove(item);
      heading.append(el('strong', item.name), remove); li.append(heading);
      li.append(el('p', item.error || (item.status === 'preparing' ? item.progress || 'Reading locally…' : `${item.partCount} automatic part(s) · original not sent to AI`), item.error ? 'inline-message error' : 'field-hint'));
      if (item.status === 'error' && !item.cancelled && !(item.sourceType === 'url' && item.needsUpload)) { const retry = el('button', item.sourceType === 'url' ? 'Check / resume local snapshot' : 'Resume local import', 'btn secondary small'); retry.type = 'button'; retry.onclick = () => this.resume(item); li.append(retry); }
      if (item.sourceType === 'url') {
        if (item.status === 'preparing') { const cancel = el('button', 'Cancel URL import', 'btn secondary small'); cancel.type = 'button'; cancel.dataset.action = 'cancel-url'; cancel.onclick = () => this.cancelUrl(item); li.append(cancel); }
        else { const reimport = el('button', 'Reimport URL…', 'btn secondary small'); reimport.type = 'button'; reimport.onclick = () => this.reimportUrl(item).catch(() => {}); li.append(reimport); }
        li.append(el('p', 'Private source snapshot. Status checks and local preparation never refetch this URL. Reimport requires confirmation and creates a new snapshot.', 'field-hint'));
      }
      if (wholeVideo(item)) li.append(el('p', Number.isInteger(item.partCount) && item.partCount > 0 ? `${item.partCount} native audiovisual clips · about 30 seconds per clip · ${item.videoPlan?.fps || 24} requested FPS. No separate speech transcription or still-image OCR. Analysis copies may be resized; full timeline submission is not a guarantee of word/frame-perfect recognition.` : 'Whole-video clip count is unavailable until local inspection succeeds.', 'field-hint'));
      if (item.preview) {
        const review = el('details', undefined, 'material-review'); review.dataset.id = item.id; review.open = open.has(item.id); review.append(el('summary', 'Optional review · read-only local preview'));
        const label = el('label', 'Preview part'), select = el('select'); select.id = 'part-' + item.id; label.htmlFor = select.id;
        for (let i = 0; i < item.partCount; i++) { const option = el('option', `Part ${i + 1} of ${item.partCount}`); option.value = String(i); select.append(option); }
        select.value = String(item.preview.index);
        const load = el('button', 'Load local preview', 'btn secondary small'); load.type = 'button'; load.onclick = () => {
          if (this.locked || this.busy || this.preparing || !this.items.includes(item)) return; const epoch = this.epoch, index = Number(select.value);
          this.enqueue(async () => { try { if (item.needsUpload) { if (item.sourceType === 'url') throw new Error('Explicitly reimport the lost URL snapshot; no external refetch was made.'); await this.upload(item, epoch); } await this.loadPreview(item, index, epoch); item.error = ''; } catch (error) { if (epoch === this.epoch) item.error = error.message; } }).catch(() => {});
        };
        review.append(label, select, load, el('p', 'Read-only preview; all parts are processed automatically during creation. This is not a partial source editor.', 'field-hint'));
        if (item.preview.audio) review.append(el('p', 'Audio is prepared locally. Transcription happens only after paid consent during creation.', 'field-hint'));
        if (item.preview.text) review.append(el('pre', item.preview.text, 'material-text-preview'));
        if (item.preview.truncated) review.append(el('p', 'Preview shortened for display only; creation processes the full part.', 'field-hint'));
        const visuals = el('div', undefined, 'material-visuals'); for (const image of item.preview.images) { const img = el('img'); img.src = image.dataUrl; img.alt = image.name || item.name; img.loading = 'lazy'; visuals.append(img); } review.append(visuals);
        if (!item.preview.images.length && item.kind !== 'text' && !wholeVideo(item)) review.append(el('p', 'Use Load local preview to refresh visuals. Only the most recently loaded visual preview is retained.', 'field-hint'));
        const warnings = el('ul', undefined, 'import-warnings'); for (const warning of item.warnings) warnings.append(el('li', warning)); review.append(warnings); li.append(review);
      }
      this.list.append(li);
    }
    this.setLocked(this.locked); this.changed();
  }
  dispose() { this.cancelPending(); }
}
