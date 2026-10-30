import yauzl from 'yauzl';
import { SaxesParser } from 'saxes';
import { crc32 } from 'node:zlib';
import { createRequire } from 'node:module';
import { dirname, join, posix } from 'node:path';

const MiB = 1024 * 1024;
const MAX_TEXT = 2000000;
const MAX_PIXELS = 1500000;
const MAX_SOURCE_PIXELS = 12000000;
const MAX_CANVAS_PIXELS = 16000000;
const W = new Set(['http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'http://purl.oclc.org/ooxml/wordprocessingml/main']);
const A = new Set(['http://schemas.openxmlformats.org/drawingml/2006/main', 'http://purl.oclc.org/ooxml/drawingml/main']);
const P = new Set(['http://schemas.openxmlformats.org/presentationml/2006/main', 'http://purl.oclc.org/ooxml/presentationml/main']);
const R = new Set(['http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'http://purl.oclc.org/ooxml/officeDocument/relationships']);
const M = new Set(['http://schemas.openxmlformats.org/officeDocument/2006/math', 'http://purl.oclc.org/ooxml/officeDocument/math']);
const CT = 'http://schemas.openxmlformats.org/package/2006/content-types';
const REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const OFFICE = 'application/vnd.openxmlformats-officedocument.';

export class DocumentImportError extends Error {
  constructor(message) { super(message); this.name = 'DocumentImportError'; }
}
const fail = message => { throw new DocumentImportError(message); };
function warn(result, message) { if (!result.warnings.includes(message)) result.warnings.push(message); }
function textSink(result) {
  return value => {
    if (value.length > MAX_TEXT - result.text.length) fail('Document text exceeds the workspace resource limit of 2,000,000 characters.');
    result.text += value;
  };
}

function decodeXml(buffer) {
  let encoding = 'utf-8';
  if ((buffer[0] === 0xff && buffer[1] === 0xfe) || (buffer[0] === 0x3c && buffer[1] === 0)) encoding = 'utf-16le';
  if ((buffer[0] === 0xfe && buffer[1] === 0xff) || (buffer[0] === 0 && buffer[1] === 0x3c)) encoding = 'utf-16be';
  try { return new TextDecoder(encoding, { fatal: true }).decode(buffer); }
  catch { fail('Office XML has an invalid text encoding.'); }
}
function xml(buffer, handlers = {}) {
  const parser = new SaxesParser({ xmlns: true, position: false });
  let depth = 0, count = 0;
  parser.on('error', () => fail('Office XML is malformed or contains unsupported entities.'));
  parser.on('doctype', () => fail('Office XML must not contain a DOCTYPE or custom entities.'));
  parser.on('processinginstruction', () => fail('Office XML processing instructions and external references are not supported.'));
  parser.on('opentag', node => {
    if (++depth > 80) fail('Office XML exceeds the nesting limit of 80.');
    if (++count > 250000) fail('Office XML contains too many elements.');
    handlers.open?.(node, depth);
  });
  parser.on('closetag', node => { handlers.close?.(node, depth); depth--; });
  parser.on('text', value => handlers.text?.(value));
  parser.on('cdata', value => handlers.text?.(value));
  const decoded = decodeXml(buffer);
  // Chunking also bounds text events supplied to consumers.
  for (let i = 0; i < decoded.length; i += 16384) parser.write(decoded.slice(i, i + 16384));
  parser.close();
}
function attr(node, name, namespaces) {
  return Object.values(node.attributes).find(a => a.local === name && (namespaces ? namespaces.has(a.uri) : !a.uri))?.value;
}
function safePath(name) {
  if (!name || /[\\\x00-\x1f\x7f:%?#]/.test(name) || name.startsWith('/') || name.split('/').some(p => p === '.' || p === '..' || !p)) {
    fail('Office archive contains an unsafe or ambiguous path.');
  }
  return name;
}

async function officeParts(buffer) {
  let zip;
  try {
    zip = await yauzl.fromBufferPromise(buffer, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true });
    if (zip.entryCount > 2000) fail('Office archive exceeds the 2,000-entry limit.');
    const parts = new Map(), names = new Set();
    let expanded = 0, actualTotal = 0, xmlExpanded = 0, actualXml = 0, count = 0;
    await new Promise((resolve, reject) => {
      let stopped = false, active;
      const stop = error => { if (stopped) return; stopped = true; active?.destroy(); reject(error); };
      zip.on('error', () => stop(new DocumentImportError('Office archive is damaged or contains unsafe paths.')));
      zip.on('end', resolve);
      zip.on('entry', entry => {
        (async () => {
          if (++count > 2000) fail('Office archive exceeds the 2,000-entry limit.');
          const name = entry.fileName;
          safePath(name.endsWith('/') ? name.slice(0, -1) : name);
          const key = name.replace(/\/$/, '').toLowerCase();
          if (names.has(key)) fail('Office archive contains duplicate or ambiguous entries.');
          names.add(key);
          if (entry.generalPurposeBitFlag & 0x41) fail('Encrypted Office files are not supported. Save an unencrypted copy.');
          if (/vbaproject|vbadata/i.test(name)) fail('Macro-enabled Office files are not supported.');
          if (![0, 8].includes(entry.compressionMethod)) fail('Office archive uses unsupported compression.');
          const isXml = /\.(xml|rels)$/i.test(name);
          expanded += entry.uncompressedSize;
          if (expanded > 1024 * MiB) fail('Office archive exceeds the 1 GiB expanded-size workspace resource limit.');
          if (isXml) {
            if (entry.uncompressedSize > 8 * MiB) fail('Office XML part exceeds the 8 MiB limit.');
            xmlExpanded += entry.uncompressedSize;
            if (xmlExpanded > 40 * MiB) fail('Office XML exceeds the 40 MiB aggregate workspace resource limit.');
          }
          if (entry.uncompressedSize > Math.max(1, entry.compressedSize) * 250) fail('Office archive exceeds the 250:1 expansion-ratio limit.');
          const local = await zip.readLocalFileHeaderPromise(entry);
          if (local.generalPurposeBitFlag & 0x41) fail('Encrypted Office files are not supported. Save an unencrypted copy.');
          if (local.generalPurposeBitFlag !== entry.generalPurposeBitFlag || local.compressionMethod !== entry.compressionMethod || local.fileName.toString('utf8') !== name) fail('Office archive has inconsistent entry headers.');
          active = await zip.openReadStreamPromise(entry);
          let size = 0, checksum = 0;
          const chunks = [];
          for await (const chunk of active) {
            size += chunk.length; actualTotal += chunk.length;
            if (isXml) actualXml += chunk.length;
            if (size > entry.uncompressedSize || actualTotal > 1024 * MiB || actualXml > 40 * MiB || (isXml && size > 8 * MiB) || size > Math.max(1, entry.compressedSize) * 250) fail('Office archive decompression exceeded its safety limits.');
            checksum = crc32(chunk, checksum);
            if (isXml) chunks.push(chunk);
          }
          active = null;
          if (size !== entry.uncompressedSize || checksum !== entry.crc32) fail('Office archive has damaged entry data.');
          if (isXml) {
            const data = Buffer.concat(chunks);
            xml(data); // Validate even unreferenced XML; no DTDs or malformed hidden parts.
            parts.set(name, data);
          }
          if (!stopped) zip.readEntry();
        })().catch(stop);
      });
      zip.readEntry();
    });
    return parts;
  } finally { zip?.close(); }
}
function required(parts, name) {
  const data = parts.get(name);
  if (!data) fail('Office document is missing a required part.');
  return data;
}
function contentTypes(parts) {
  const overrides = new Map(), defaults = new Map();
  xml(required(parts, '[Content_Types].xml'), { open(node, depth) {
    if (depth === 1 && (node.local !== 'Types' || node.uri !== CT)) fail('Invalid Office content-types manifest.');
    if (depth !== 2 || node.uri !== CT) return;
    const type = attr(node, 'ContentType');
    if (!type) fail('Office content type is missing.');
    if (/macroenabled|vbaProject|ms-office\.activeX/i.test(type)) fail('Macro-enabled or active-content Office files are not supported.');
    if (node.local === 'Override') {
      const part = attr(node, 'PartName');
      if (!part?.startsWith('/')) fail('Invalid Office content-type path.');
      const name = safePath(part.slice(1));
      if (overrides.has(name)) fail('Duplicate Office content-type declaration.');
      overrides.set(name, type);
    } else if (node.local === 'Default') {
      const ext = attr(node, 'Extension');
      if (!ext || defaults.has(ext.toLowerCase())) fail('Invalid Office default content type.');
      defaults.set(ext.toLowerCase(), type);
    }
  } });
  return name => overrides.get(name) || defaults.get(name.split('.').pop().toLowerCase());
}
function relationships(parts, source, result, mandatory = false) {
  const path = source ? posix.join(posix.dirname(source), '_rels', posix.basename(source) + '.rels') : '_rels/.rels';
  const data = mandatory ? required(parts, path) : parts.get(path);
  const rels = new Map();
  if (!data) return rels;
  xml(data, { open(node, depth) {
    if (depth === 1 && (node.uri !== REL || node.local !== 'Relationships')) fail('Invalid Office relationships part.');
    if (depth !== 2 || node.uri !== REL || node.local !== 'Relationship') return;
    const id = attr(node, 'Id'), type = attr(node, 'Type'), target = attr(node, 'Target'), mode = attr(node, 'TargetMode');
    if (!id || !type || !target || rels.has(id)) fail('Office relationships are incomplete or duplicated.');
    if (mode === 'External') {
      warn(result, 'External Office relationships were ignored; no linked content was fetched.');
      rels.set(id, { type, external: true });
      return;
    }
    if (mode && mode !== 'Internal') fail('Office relationship has an unsupported target mode.');
    if (/[\\\x00-\x20\x7f:%?#]/.test(target) || target.startsWith('/')) fail('Office relationship contains an unsafe target.');
    const resolved = posix.normalize(posix.join(source ? posix.dirname(source) : '', target));
    safePath(resolved);
    rels.set(id, { type, target: resolved });
  } });
  return rels;
}
function relType(rel, suffix) { return rel && [...R].some(ns => rel.type === ns + '/' + suffix); }
function officeText(buffer, namespaces, add, result, expectedRoot) {
  const stack = [];
  let content = false;
  xml(buffer, {
    open(node, depth) {
      const rootNamespaces = ['sld', 'notes'].includes(expectedRoot) ? P : namespaces;
      if (depth === 1 && (!rootNamespaces.has(node.uri) || node.local !== expectedRoot)) fail('Office content part has an invalid root element.');
      stack.push(node);
      if (M.has(node.uri)) warn(result, 'Formula text is an approximation; mathematical notation and layout may be lost. Add a screenshot for accurate formulas.');
      if (namespaces.has(node.uri) && (node.local === 'br' || node.local === 'tab')) add(node.local === 'tab' ? '\t' : '\n');
    },
    text(value) {
      const node = stack.at(-1);
      if (node?.local === 't' && (namespaces.has(node.uri) || M.has(node.uri))) {
        if (value.trim()) content = true;
        add(value);
      }
    },
    close(node) {
      if (namespaces.has(node.uri) && ['p', 'tr'].includes(node.local)) add('\n');
      if (namespaces.has(node.uri) && node.local === 'tc') add('\t');
      stack.pop();
    }
  });
  return content;
}
async function extractOffice(buffer, extension, result) {
  if (buffer.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) fail('Encrypted or legacy Office files are not supported. Save an unencrypted DOCX or PPTX copy.');
  if (buffer.length < 4 || buffer.readUInt32LE(0) !== 0x04034b50) fail('The file is not a valid DOCX/PPTX ZIP document.');
  const parts = await officeParts(buffer), type = contentTypes(parts), add = textSink(result);
  const main = extension === 'docx' ? 'word/document.xml' : 'ppt/presentation.xml';
  const mainType = OFFICE + (extension === 'docx' ? 'wordprocessingml.document.main+xml' : 'presentationml.presentation.main+xml');
  if (type(main) !== mainType) fail('Office document type does not match its extension; renamed and macro-enabled files are not supported.');
  const roots = [...relationships(parts, '', result, true).values()].filter(r => relType(r, 'officeDocument'));
  if (roots.length !== 1 || roots[0].external || roots[0].target !== main) fail('Office document has an invalid main-part relationship.');
  warn(result, 'Office visuals, charts, embedded objects and page/slide layout are not rendered in v1. Add screenshots for visual content.');
  const mainRels = relationships(parts, main, result);
  let content = false;
  if (extension === 'docx') {
    content = officeText(required(parts, main), W, add, result, 'document');
    for (const kind of ['footnotes', 'endnotes']) {
      for (const rel of mainRels.values()) {
        if (!relType(rel, kind) || rel.external) continue;
        if (!rel.target.startsWith('word/') || type(rel.target) !== OFFICE + 'wordprocessingml.' + kind + '+xml') fail('Office notes have an invalid part type or path.');
        add('\n[' + (kind === 'footnotes' ? 'Footnotes' : 'Endnotes') + ']\n');
        content = officeText(required(parts, rel.target), W, add, result, kind) || content;
      }
    }
  } else {
    const ids = [], stack = [];
    xml(required(parts, main), { open(node, depth) {
      if (depth === 1 && (node.local !== 'presentation' || !P.has(node.uri))) fail('Invalid PowerPoint presentation part.');
      if (P.has(node.uri) && node.local === 'sldId' && stack.at(-1)?.local === 'sldIdLst') {
        const id = attr(node, 'id', R);
        if (!id || ids.includes(id)) fail('Presentation has invalid or duplicate slide relationships.');
        ids.push(id);
        if (ids.length > 1000) fail('Presentation exceeds the 1,000-slide limit.');
      }
      stack.push(node);
    }, close() { stack.pop(); } });
    result.slides = ids.length;
    for (const [index, id] of ids.entries()) {
      const rel = mainRels.get(id);
      if (!relType(rel, 'slide') || rel.external || !rel.target.startsWith('ppt/slides/') || type(rel.target) !== OFFICE + 'presentationml.slide+xml') fail('Presentation has a missing or invalid slide relationship.');
      add(`\n[Slide ${index + 1}]\n`);
      content = officeText(required(parts, rel.target), A, add, result, 'sld') || content;
      for (const note of relationships(parts, rel.target, result).values()) {
        if (!relType(note, 'notesSlide') || note.external) continue;
        if (!note.target.startsWith('ppt/notesSlides/') || type(note.target) !== OFFICE + 'presentationml.notesSlide+xml') fail('Presentation has an invalid speaker-notes relationship.');
        add('\n[Speaker notes]\n');
        content = officeText(required(parts, note.target), A, add, result, 'notes') || content;
      }
    }
  }
  if (!content || !result.text.trim()) fail('No readable text was found. Office visuals are not rendered; add screenshots instead.');
}

async function extractPdf(buffer, result, options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) fail('PDF options must be an object.');
  const { startPage = 1, pageCount = 3 } = options;
  if (!Number.isSafeInteger(startPage) || startPage < 1) fail('PDF startPage must be a positive integer.');
  if (!Number.isSafeInteger(pageCount) || pageCount < 1 || pageCount > 3) fail('PDF pageCount must be an integer from 1 to 3.');
  if (!buffer.subarray(0, 5).equals(Buffer.from('%PDF-'))) fail('The file does not have a valid PDF signature.');
  const require = createRequire(import.meta.url);
  const pdfPath = require.resolve('pdfjs-dist/legacy/build/pdf.mjs');
  const root = join(dirname(pdfPath), '..', '..');
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  // Cap scratch canvases too, not just the final raster; no document-supplied URLs.
  const canvasModule = createRequire(pdfPath)('@napi-rs/canvas');
  class LimitedCanvasFactory {
    pixels = 0;
    allocations = new WeakMap();
    create(width, height) {
      width = Math.ceil(width); height = Math.ceil(height);
      const pixels = width * height;
      if (!(width > 0 && height > 0 && width <= 16384 && height <= 16384 && pixels <= MAX_SOURCE_PIXELS && this.pixels + pixels <= MAX_CANVAS_PIXELS)) fail('PDF rendering exceeds the image safety limit.');
      const canvas = canvasModule.createCanvas(width, height);
      const pair = { canvas, context: canvas.getContext('2d') };
      this.pixels += pixels; this.allocations.set(pair, pixels);
      return pair;
    }
    reset(pair, width, height) {
      const replacement = this.create(width, height);
      this.destroy(pair);
      pair.canvas = replacement.canvas; pair.context = replacement.context;
      this.allocations.set(pair, this.allocations.get(replacement)); this.allocations.delete(replacement);
    }
    destroy(pair) {
      this.pixels -= this.allocations.get(pair) || 0; this.allocations.delete(pair);
      if (pair.canvas) { pair.canvas.width = 0; pair.canvas.height = 0; }
      pair.canvas = null; pair.context = null;
    }
  }
  let task, doc;
  try {
    task = pdfjs.getDocument({
      data: Uint8Array.from(buffer), isEvalSupported: false, enableXfa: false,
      useWorkerFetch: false, useSystemFonts: false, disableFontFace: true,
      cMapUrl: join(root, 'cmaps') + '/', cMapPacked: true,
      standardFontDataUrl: join(root, 'standard_fonts') + '/', wasmUrl: join(root, 'wasm') + '/',
      // Source scans may be larger than the downscaled output (up to 12 MP).
      maxImageSize: MAX_SOURCE_PIXELS, canvasMaxAreaInBytes: MAX_PIXELS * 4,
      CanvasFactory: LimitedCanvasFactory, verbosity: 0, disableAutoFetch: true,
      disableStream: true, disableRange: true,
    });
    doc = await task.promise;
    if (await doc.getPermissions() !== null) fail('Encrypted or password-protected PDFs are not supported. Save an unencrypted copy.');
    if (doc.numPages > 1000) fail('PDF exceeds the 1,000-page limit.');
    if (startPage > doc.numPages) fail('PDF startPage exceeds the document page count.');
    const endPage = Math.min(doc.numPages, startPage + pageCount - 1);
    result.pages = doc.numPages;
    result.startPage = startPage;
    result.nextPage = endPage < doc.numPages ? endPage + 1 : null;
    result.partCount = Math.ceil(doc.numPages / 3);
    const add = textSink(result);
    let readable = false, imageBytes = 0, noText = 0, renderFailed = false;
    for (let number = startPage; number <= endPage; number++) {
      const page = await doc.getPage(number);
      let pageText = false;
      try {
        add(`\n[Page ${number}]\n`);
        const reader = page.streamTextContent().getReader();
        let items = 0;
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            for (const item of value.items) {
              if (++items > 100000) fail('PDF page contains too many text items.');
              if (typeof item.str !== 'string') continue;
              if (item.str.trim()) { readable = true; pageText = true; }
              add(item.str + (item.hasEOL ? '\n' : ' '));
            }
          }
        } catch (error) {
          try { await reader.cancel(error); } catch { /* Preserve the extraction error. */ }
          throw error;
        } finally { reader.releaseLock(); }
        if (!pageText) noText++;
        {
          let pair;
          try {
            const base = page.getViewport({ scale: 1 });
            if (!(base.width > 0 && base.height > 0 && Number.isFinite(base.width * base.height))) throw new Error('Invalid dimensions');
            const scale = Math.min(1.5, Math.sqrt(MAX_PIXELS / (base.width * base.height)), 16384 / base.width, 16384 / base.height);
            const viewport = page.getViewport({ scale });
            pair = doc.canvasFactory.create(Math.max(1, Math.floor(viewport.width)), Math.max(1, Math.floor(viewport.height)));
            await page.render({ canvasContext: pair.context, viewport, annotationMode: pdfjs.AnnotationMode.DISABLE, background: 'rgb(255,255,255)' }).promise;
            const pixels = pair.context.getImageData(0, 0, pair.canvas.width, pair.canvas.height).data;
            let marked = false;
            for (let i = 0; i < pixels.length; i += 4) if (pixels[i] < 250 || pixels[i + 1] < 250 || pixels[i + 2] < 250) { marked = true; break; }
            if (marked) {
              const image = pair.canvas.toBuffer('image/jpeg', 80);
              if (image.length > 4 * MiB || imageBytes + image.length > 6 * MiB) throw new Error('Image limit');
              imageBytes += image.length;
              result.images.push({ name: `Page ${number}`, dataUrl: 'data:image/jpeg;base64,' + image.toString('base64') });
            }
          } catch { renderFailed = true; warn(result, 'Some PDF page visuals could not be rendered within safety limits. Add screenshots for those pages.'); }
          finally { if (pair) doc.canvasFactory.destroy(pair); }
        }
      } finally { page.cleanup(); }
    }
    if (noText) warn(result, 'Some PDF pages have no extractable text and may be scans. No local OCR is performed; a vision-capable model is needed for page images.');
    if (!readable && !result.images.length) {
      if (startPage > 1 || endPage < doc.numPages) {
        result.text = '';
        warn(result, 'No readable text or usable page visuals were found in this PDF range; other pages may still be usable.');
      } else if (renderFailed) fail('PDF visuals could not be rendered and no readable text remains. Add screenshots instead.');
      else fail('No readable text or usable page visuals were found in this PDF.');
    }
  } catch (error) {
    if (error?.name === 'PasswordException') fail('Encrypted or password-protected PDFs are not supported. Save an unencrypted copy.');
    throw error;
  } finally {
    // Destroy even failed loading tasks; never leave PDF worker/resources alive.
    try { if (doc) await doc.destroy(); else if (task) await task.destroy(); } catch { /* Preserve safe extraction outcome. */ }
  }
}

export async function extractDocument(buffer, extension, options = {}) {
  if (!Buffer.isBuffer(buffer) && !(buffer instanceof Uint8Array)) fail('Document input must be binary data.');
  if (!buffer.byteLength) fail('The document is empty.');
  if (buffer.byteLength > 100 * MiB) fail('Document exceeds the 100 MiB input workspace resource limit.');
  if (!['pdf', 'docx', 'pptx'].includes(extension)) fail('Only PDF, DOCX and PPTX documents are supported.');
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const result = { kind: 'document', text: '', images: [], warnings: [] };
  try {
    if (extension === 'pdf') await extractPdf(buffer, result, options);
    else await extractOffice(buffer, extension, result);
    result.text = result.text.trim();
    return result;
  } catch (error) {
    if (error instanceof DocumentImportError) throw error;
    fail(extension === 'pdf' ? 'This PDF could not be read. It may be damaged or contain unsupported content.' : 'This Office document could not be read. It may be damaged or contain unsupported content.');
  }
}
