import { mkdtemp, mkdir, open, readFile, writeFile, rm, statfs } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { AppError } from './provider.mjs';
import { importDocument } from './document-import.mjs';
export const UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024;
const MiB = 1024 * 1024, DOCS = ['pdf', 'docx', 'pptx'], MEDIA = ['mp3', 'mp4', 'webm', 'wav', 'ogg'];
export function splitMaterialText(text, size = 20000) {
  const chunks = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(text.length, start + size);
    if (end < text.length) { const line = text.lastIndexOf('\n', end); if (line > start + size / 2) end = line + 1; if (/[\uD800-\uDBFF]/.test(text[end - 1])) end--; }
    chunks.push(text.slice(start, end)); start = end;
  }
  return chunks.length ? chunks : [''];
}
const safeError = error => error instanceof AppError ? error : error?.name === 'MediaImportError' ? new AppError(error.message, 422) : new AppError('Material processing failed. Check the app installation, available disk space and resource limits.', 422);
export function createMaterialStore({ importDoc = importDocument, mediaLoader = () => import('./native-media.mjs'), directory = tmpdir() } = {}) {
  const entries = new Map(); let rootPromise, reserved = 0, closed = false;
  const root = () => rootPromise ||= mkdtemp(join(directory, 'learnlens-materials-'));
  const get = (owner, id) => { const item = entries.get(id); if (!item || item.owner !== owner) throw new AppError('Material not found or expired. Re-add the original file.', 404); item.touched = Date.now(); return item; };
  const publicItem = item => ({ id: item.id, name: item.name, size: item.size, received: item.received, status: item.status, kind: item.kind, partCount: item.partCount || 0, duration: item.info?.duration, hasAudio: item.info?.hasAudio, hasVideo: item.info?.hasVideo, pages: item.pages, warnings: item.warnings || [], error: item.error || null, chunkSize: UPLOAD_CHUNK_BYTES });
  async function create(owner, body) {
    const { id, name, size } = body;
    if (closed) throw new AppError('Workspace is stopping.', 503);
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw new AppError('Invalid material ID.');
    if (typeof name !== 'string' || !name.length || name.length > 180 || /[\\/\x00-\x1f\x7f]/.test(name)) throw new AppError('Invalid material filename.');
    const extension = name.split('.').pop().toLowerCase();
    if (![...DOCS, ...MEDIA].includes(extension)) throw new AppError('Use PDF, DOCX, PPTX, MP3, MP4, WebM, WAV or OGG.');
    const max = DOCS.includes(extension) ? 100 * MiB : 1024 * MiB;
    if (!Number.isSafeInteger(size) || size < 1 || size > max) throw new AppError(`This workspace supports ${DOCS.includes(extension) ? '100 MB documents' : '1 GB media files'}. This is a host storage quota, not a model segment limit.`, 413);
    if (entries.has(id)) { const item = get(owner, id); if (item.name !== name || item.size !== size) throw new AppError('Material ID already belongs to another upload.', 409); return publicItem(item); }
    const owned = [...entries.values()].filter(item => item.owner === owner);
    if (owned.length >= 10 || owned.reduce((sum, item) => sum + item.size, 0) + size > 1024 * MiB || reserved + size > 4096 * MiB) throw new AppError('Temporary workspace storage quota reached. Remove unused attachments or ask the host for more capacity.', 413);
    // Reserve before awaiting disk operations, so concurrent creates cannot bypass quotas.
    const item = { id, owner, name, size, extension, kind: DOCS.includes(extension) ? 'document' : 'media', received: 0, chunks: new Map(), status: 'uploading', controller: new AbortController(), touched: Date.now(), pendingParts: new Map() };
    entries.set(id, item); reserved += size;
    try {
      const base = await root(); const space = await statfs(base);
      if (item.controller.signal.aborted || closed) throw new AppError('Upload was cancelled.', 409);
      if (space.bavail * space.bsize < size + 256 * MiB) throw new AppError('Not enough temporary disk space on this workspace.', 507);
      item.directory = join(base, id); await mkdir(item.directory, { mode: 0o700 }); item.file = join(item.directory, 'source.' + extension);
      await writeFile(item.file, '', { mode: 0o600, flag: 'wx' });
      if (item.controller.signal.aborted || closed) throw new AppError('Upload was cancelled.', 409);
      return publicItem(item);
    } catch (error) { await remove(owner, id); if (item.directory) await rm(item.directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); throw safeError(error); }
  }
  async function append(owner, id, offset, data) {
    const item = get(owner, id);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Buffer.isBuffer(data) || !data.length || data.length > UPLOAD_CHUNK_BYTES) throw new AppError('Invalid upload chunk.');
    const hash = createHash('sha256').update(data).digest('hex'), old = item.chunks.get(offset);
    if (old && old.length === data.length && old.hash === hash) return publicItem(item);
    if (item.writing || item.status !== 'uploading' || offset !== item.received || offset + data.length > item.size) throw new AppError('Upload position changed. Read its current status before continuing.', 409);
    item.writing = true; let handle;
    try {
      handle = await open(item.file, 'r+'); let written = 0;
      while (written < data.length) { if (item.controller.signal.aborted) throw new AppError('Upload was cancelled.', 409); const result = await handle.write(data, written, data.length - written, offset + written); if (!result.bytesWritten) throw new Error('Short write'); written += result.bytesWritten; }
      item.received += data.length; item.chunks.set(offset, { length: data.length, hash }); return publicItem(item);
    } catch (error) { await handle?.truncate(item.received).catch(() => {}); throw safeError(error); }
    finally { await handle?.close(); item.writing = false; }
  }
  async function finish(owner, id) {
    const item = get(owner, id);
    if (item.status === 'ready') return publicItem(item);
    if (item.preparing) return item.preparing;
    if (item.writing || item.received !== item.size) throw new AppError('Wait for the upload to finish.', 409);
    item.status = 'preparing'; item.error = null;
    item.preparing = (async () => {
      try {
        if (item.kind === 'document') {
          const result = await importDoc(await readFile(item.file), item.extension, { signal: item.controller.signal, timeoutMs: 120000 });
          item.pages = result.pages; item.warnings = result.warnings || [];
          if (item.extension === 'pdf') { item.partCount = Math.ceil(result.pages / 3); await cachePart(item, 0, result); }
          else {
            const chunks = splitMaterialText(result.text); item.partCount = chunks.length;
            for (let i = 0; i < chunks.length; i++) await cachePart(item, i, { text: chunks[i], images: [], warnings: result.warnings || [] });
          }
        } else {
          const media = await mediaLoader(); item.info = await media.inspectMedia(item.file, item.extension, { signal: item.controller.signal });
          item.partCount = item.info.partCount; item.warnings = ['Long recordings are automatically processed in chronological segments. Video uses sampled stills, not every frame.'];
        }
        if (item.controller.signal.aborted) throw new AppError('Material processing cancelled.', 409);
        item.status = 'ready'; return publicItem(item);
      } catch (error) { const failure = safeError(error); item.status = 'error'; item.error = failure.message; throw failure; }
      finally { item.preparing = null; }
    })();
    return item.preparing;
  }
  async function cachePart(item, index, result) {
    if (item.controller.signal.aborted) throw new AppError('Material processing cancelled.', 409);
    const label = item.extension === 'pdf' ? `pages ${index * 3 + 1}–${Math.min(item.pages, index * 3 + 3)}` : result.start !== undefined ? `${result.start}–${result.end} seconds` : `part ${index + 1}`;
    const value = { ...result, index, label, source: `${item.name} · ${label}` };
    await writeFile(join(item.directory, `part-${index}.json`), JSON.stringify(value), { mode: 0o600 });
    // Keep only the first preview and latest large raster/audio part. Old parts
    // can be regenerated locally; do not accumulate hours of decoded audio.
    if (item.extension === 'pdf' || item.kind === 'media') {
      if (item.lastCached > 0 && item.lastCached !== index) await rm(join(item.directory, `part-${item.lastCached}.json`), { force: true });
      if (index > 0) item.lastCached = index;
    }
    return value;
  }
  async function part(owner, id, index) {
    const item = get(owner, id);
    if (item.status !== 'ready' || !Number.isInteger(index) || index < 0 || index >= item.partCount) throw new AppError('Invalid material part.');
    try { return JSON.parse(await readFile(join(item.directory, `part-${index}.json`), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw safeError(error); }
    if (item.pendingParts.has(index)) return item.pendingParts.get(index);
    const work = (async () => {
      try {
        const result = item.extension === 'pdf'
          ? await importDoc(await readFile(item.file), 'pdf', { signal: item.controller.signal, timeoutMs: 120000, options: { startPage: index * 3 + 1, pageCount: 3 } })
          : await (await mediaLoader()).prepareMediaPart(item.file, item.extension, index, item.info, { signal: item.controller.signal });
        return await cachePart(item, index, result);
      } catch (error) { throw safeError(error); }
      finally { item.pendingParts.delete(index); }
    })(); item.pendingParts.set(index, work); return work;
  }
  async function remove(owner, id) {
    const item = entries.get(id); if (!item || item.owner !== owner) return;
    entries.delete(id); reserved -= item.size; item.controller.abort();
    await Promise.allSettled([item.preparing, ...item.pendingParts.values()].filter(Boolean));
    if (item.directory) await rm(item.directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
  async function clearOwner(owner) { await Promise.all([...entries.values()].filter(item => item.owner === owner).map(item => remove(owner, item.id))); }
  async function close() { closed = true; await Promise.all([...entries.values()].map(item => remove(item.owner, item.id))); if (rootPromise) await rm(await rootPromise, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
  return { create, append, finish, part, remove, clearOwner, close, status: (owner, id) => publicItem(get(owner, id)) };
}
