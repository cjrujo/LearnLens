import { fork } from 'node:child_process';
import { AppError } from './provider.mjs';
export const MAX_DOCUMENT_BYTES = 100 * 1024 * 1024;
export function documentEnvironment(base = process.env) {
  return Object.fromEntries(['PATH', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'LOCALAPPDATA'].filter(key => base[key] !== undefined).map(key => [key, base[key]]));
}
export function documentName(header) {
  let name;
  try { name = decodeURIComponent(header || ''); } catch { throw new AppError('Invalid document filename.'); }
  if (!name || name.length > 180 || /[\\/\\\\\x00-\x1f\x7f]/.test(name)) throw new AppError('Use a document filename of at most 180 characters, without paths.');
  const extension = name.split('.').pop().toLowerCase();
  if (!['pdf', 'docx', 'pptx'].includes(extension)) throw new AppError('Document import supports PDF, DOCX and PPTX.');
  return { name, extension };
}
export async function documentBody(request, signal, maxBytes = MAX_DOCUMENT_BYTES) {
  if (request.headers['content-type'] !== 'application/octet-stream') throw new AppError('Send the document as application/octet-stream.', 415);
  if (Number(request.headers['content-length']) > maxBytes) { request.resume(); throw new AppError('Upload exceeds the allowed transfer size.', 413); }
  return new Promise((resolve, reject) => {
    let parts = [], size = 0, finished = false;
    const finish = (error, buffer) => {
      if (finished) return;
      finished = true; parts = []; signal?.removeEventListener('abort', cancel);
      if (error) reject(error); else resolve(buffer);
    };
    const cancel = () => finish(new AppError('Document import was cancelled.', 409));
    signal?.addEventListener('abort', cancel, { once: true });
    request.on('data', chunk => {
      if (finished) return;
      size += chunk.length;
      if (size > maxBytes) finish(new AppError('Upload exceeds the allowed transfer size.', 413));
      else parts.push(chunk);
    });
    request.on('end', () => { if (!finished) finish(size ? null : new AppError('The document is empty.'), Buffer.concat(parts)); });
    request.on('error', () => finish(new AppError('Document upload was interrupted.')));
    if (signal?.aborted) cancel();
  });
}
export function importDocument(buffer, extension, { signal, timeoutMs = 120000, workerFile = new URL('./document-worker.mjs', import.meta.url), options = {} } = {}) {
  if (signal?.aborted) return Promise.reject(new AppError('Document import was cancelled.', 409));
  if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > MAX_DOCUMENT_BYTES) return Promise.reject(new AppError('Document exceeds this workspace’s 100 MB storage quota or is empty.', 413));
  return new Promise((resolve, reject) => {
    const child = fork(workerFile, [], { execArgv: ['--max-old-space-size=256'], env: documentEnvironment(), stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'advanced', windowsHide: true });
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', cancel);
      if (!child.killed) child.kill('SIGKILL');
      if (error) reject(error); else resolve(result);
    };
    const cancel = () => finish(new AppError('Document import was cancelled. Your other attachments remain available.', 409));
    const timer = setTimeout(() => finish(new AppError('Document extraction exceeded the workspace processing deadline. No AI request was made.', 422)), timeoutMs);
    signal?.addEventListener('abort', cancel, { once: true });
    child.once('error', () => finish(new AppError('The document parser could not start. Check the app installation.', 503)));
    child.once('exit', () => finish(new AppError('The document parser stopped or exceeded the workspace memory budget. No AI request was made.', 422)));
    child.on('message', message => {
      if (message?.error) finish(new AppError(message.error, 422));
      else if (message?.result) finish(null, message.result);
      else finish(new AppError('Document extraction returned an invalid result.', 502));
    });
    child.send({ buffer, extension, options }, error => { if (error) finish(new AppError('The document parser could not receive this file.', 503)); });
  });
}
