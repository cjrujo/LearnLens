import { crc32, deflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';

export const namespaces = {
  w: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  p: 'http://schemas.openxmlformats.org/presentationml/2006/main',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
};
const office = 'application/vnd.openxmlformats-officedocument.';
export const relationship = (id, type, target, mode = '') => `<Relationship Id="${id}" Type="${namespaces.r}/${type}" Target="${target}"${mode ? ` TargetMode="${mode}"` : ''}/>`;
export const rels = entries => `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${entries.join('')}</Relationships>`;
export const types = entries => `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>${entries.map(([name, type]) => `<Override PartName="/${name}" ContentType="${office}${type}"/>`).join('')}</Types>`;
export const word = text => `<w:document xmlns:w="${namespaces.w}" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><w:body>${text}</w:body></w:document>`;
export const paragraph = text => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
export function docxEntries(body = paragraph('Hello DOCX')) {
  return [
    ['[Content_Types].xml', types([['word/document.xml', 'wordprocessingml.document.main+xml'], ['word/footnotes.xml', 'wordprocessingml.footnotes+xml']])],
    ['_rels/.rels', rels([relationship('main', 'officeDocument', 'word/document.xml')])],
    ['word/document.xml', word(body)],
    ['word/_rels/document.xml.rels', rels([relationship('foot', 'footnotes', 'footnotes.xml')])],
    ['word/footnotes.xml', `<w:footnotes xmlns:w="${namespaces.w}"><w:footnote w:id="1">${paragraph('Footnote evidence')}</w:footnote></w:footnotes>`],
  ];
}
export function pptxEntries() {
  const slide = text => `<p:sld xmlns:p="${namespaces.p}" xmlns:a="${namespaces.a}"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
  return [
    ['[Content_Types].xml', types([['ppt/presentation.xml', 'presentationml.presentation.main+xml'], ['ppt/slides/slide1.xml', 'presentationml.slide+xml'], ['ppt/slides/slide2.xml', 'presentationml.slide+xml'], ['ppt/notesSlides/notesSlide1.xml', 'presentationml.notesSlide+xml']])],
    ['_rels/.rels', rels([relationship('main', 'officeDocument', 'ppt/presentation.xml')])],
    ['ppt/presentation.xml', `<p:presentation xmlns:p="${namespaces.p}" xmlns:r="${namespaces.r}"><p:sldIdLst><p:sldId id="256" r:id="second"/><p:sldId id="257" r:id="first"/></p:sldIdLst></p:presentation>`],
    ['ppt/_rels/presentation.xml.rels', rels([relationship('first', 'slide', 'slides/slide1.xml'), relationship('second', 'slide', 'slides/slide2.xml')])],
    ['ppt/slides/slide1.xml', slide('Lexical first, displayed second')],
    ['ppt/slides/slide2.xml', slide('Lexical second, displayed first')],
    ['ppt/slides/_rels/slide2.xml.rels', rels([relationship('notes', 'notesSlide', '../notesSlides/notesSlide1.xml'), relationship('web', 'hyperlink', 'https://example.invalid/private', 'External')])],
    ['ppt/notesSlides/notesSlide1.xml', `<p:notes xmlns:p="${namespaces.p}" xmlns:a="${namespaces.a}"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Speaker note evidence</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>`],
  ];
}

export function pptxManyEntries(count) {
  const entries = [
    ['[Content_Types].xml', types([['ppt/presentation.xml', 'presentationml.presentation.main+xml'], ...Array.from({ length: count }, (_, i) => [`ppt/slides/slide${i + 1}.xml`, 'presentationml.slide+xml'])])],
    ['_rels/.rels', rels([relationship('main', 'officeDocument', 'ppt/presentation.xml')])],
    ['ppt/presentation.xml', `<p:presentation xmlns:p="${namespaces.p}" xmlns:r="${namespaces.r}"><p:sldIdLst>${Array.from({ length: count }, (_, i) => `<p:sldId id="${256 + i}" r:id="s${i + 1}"/>`).join('')}</p:sldIdLst></p:presentation>`],
    ['ppt/_rels/presentation.xml.rels', rels(Array.from({ length: count }, (_, i) => relationship(`s${i + 1}`, 'slide', `slides/slide${i + 1}.xml`)))],
  ];
  for (let i = 1; i <= count; i++) entries.push([`ppt/slides/slide${i}.xml`, `<p:sld xmlns:p="${namespaces.p}" xmlns:a="${namespaces.a}"><a:p><a:r><a:t>Ordered slide ${i}</a:t></a:r></a:p></p:sld>`]);
  return entries;
}

// Small real ZIP writer, using only Node built-ins. Options deliberately enable
// inconsistent metadata for decompression-boundary and encryption tests.
export function zip(entries) {
  const locals = [], central = [];
  let offset = 0;
  for (const [name, value, options = {}] of entries) {
    const data = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const encoded = Buffer.from(name);
    const flags = options.flags ?? 0x800;
    let payload = options.deflate ? deflateRawSync(data) : data;
    if (flags & 1) payload = Buffer.concat([Buffer.alloc(12), payload]);
    const method = options.deflate ? 8 : 0;
    const checksum = options.crc ?? crc32(data);
    const size = options.size ?? data.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4);
    local.writeUInt16LE(options.localFlags ?? flags, 6); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(checksum, 14); local.writeUInt32LE(payload.length, 18); local.writeUInt32LE(size, 22);
    local.writeUInt16LE(encoded.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(flags, 8); entry.writeUInt16LE(method, 10);
    entry.writeUInt32LE(checksum, 16); entry.writeUInt32LE(payload.length, 20); entry.writeUInt32LE(size, 24);
    entry.writeUInt16LE(encoded.length, 28); entry.writeUInt32LE(offset, 42);
    locals.push(local, encoded, payload); central.push(entry, encoded);
    offset += local.length + encoded.length + payload.length;
  }
  const dir = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}
function md5(buffer) { return createHash('md5').update(buffer).digest(); }
function rc4(key, input) {
  const state = Array.from({ length: 256 }, (_, i) => i);
  let j = 0;
  for (let i = 0; i < 256; i++) { j = (j + state[i] + key[i % key.length]) & 255; [state[i], state[j]] = [state[j], state[i]]; }
  let i = 0; j = 0;
  return Buffer.from(input, 0, input.length).map(byte => {
    i = (i + 1) & 255; j = (j + state[i]) & 255;
    [state[i], state[j]] = [state[j], state[i]];
    return byte ^ state[(state[i] + state[j]) & 255];
  });
}
export function pdf({ text = 'Hello PDF', pages = 1, scan = false, blank = false, blankPages = [], encrypted = false, password = 'secret', fontSize = 18 } = {}) {
  const objects = [], pageIds = [];
  const font = 3;
  let encryption, fileKey;
  const id = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
  if (encrypted) {
    const padding = Buffer.from('28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e8022f0ca9fe6453697a', 'hex');
    const pad = value => Buffer.concat([Buffer.from(value), padding]).subarray(0, 32);
    const owner = rc4(md5(pad('owner')).subarray(0, 5), pad(password));
    const permission = Buffer.alloc(4); permission.writeInt32LE(-4);
    fileKey = md5(Buffer.concat([pad(password), owner, permission, id])).subarray(0, 5);
    const user = rc4(fileKey, padding);
    encryption = `<< /Filter /Standard /V 1 /R 2 /Length 40 /O <${owner.toString('hex')}> /U <${user.toString('hex')}> /P -4 >>`;
  }
  objects.push('<< /Type /Catalog /Pages 2 0 R >>', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  for (let index = 0; index < pages; index++) {
    const pageId = objects.length + 1, streamId = pageId + 1;
    pageIds.push(pageId);
    const imageResource = scan ? `/XObject << /Im1 ${streamId + 1} 0 R >>` : '';
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 ${font} 0 R >> ${imageResource} >> /Contents ${streamId} 0 R >>`);
    const pageText = typeof text === 'function' ? text(index + 1) : text;
    let content = Buffer.from(blank || blankPages.includes(index + 1) ? '' : scan ? 'q 120 0 0 80 20 30 cm /Im1 Do Q' : `BT /F1 ${fontSize} Tf 20 120 Td (${pageText.replace(/[\\()]/g, '\\$&')}) Tj ET`);
    if (encrypted) {
      const objectId = Buffer.from([streamId & 255, (streamId >> 8) & 255, 0, 0, 0]);
      content = rc4(md5(Buffer.concat([fileKey, objectId])).subarray(0, 10), content);
    }
    objects.push(Buffer.concat([Buffer.from(`<< /Length ${content.length} >>\nstream\n`), content, Buffer.from('\nendstream')]));
    if (scan) objects.push(Buffer.concat([Buffer.from('<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length 12 >>\nstream\n'), Buffer.from([20, 40, 180, 200, 40, 20, 10, 180, 40, 100, 100, 100]), Buffer.from('\nendstream')]));
  }
  objects[1] = `<< /Type /Pages /Count ${pages} /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] >>`;
  if (encrypted) objects.push(encryption);
  const parts = [Buffer.from('%PDF-1.4\n')], offsets = [0];
  let offset = parts[0].length;
  objects.forEach((object, i) => {
    offsets.push(offset);
    const bytes = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), Buffer.from(object), Buffer.from('\nendobj\n')]);
    parts.push(bytes); offset += bytes.length;
  });
  const encryptionTrailer = encrypted ? ` /Encrypt ${objects.length} 0 R /ID [<${id.toString('hex')}> <${id.toString('hex')}>]` : '';
  parts.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${encryptionTrailer} >>\nstartxref\n${offset}\n%%EOF\n`));
  return Buffer.concat(parts);
}
