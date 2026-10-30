import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { extractDocument, DocumentImportError } from '../lib/document-extract.mjs';
import { pdf, zip, docxEntries, pptxEntries, pptxManyEntries, word, paragraph, rels, relationship, namespaces } from './document-fixtures.mjs';

const rejected = (buffer, extension, pattern, options) => assert.rejects(extractDocument(buffer, extension, options), error => {
  assert.ok(error instanceof DocumentImportError);
  assert.equal(error.name, 'DocumentImportError');
  assert.doesNotMatch(error.message, /PRIVATE_SECRET|<w:|<p:|DOCTYPE secret|https:\/\//);
  if (pattern) assert.match(error.message, pattern);
  return true;
});
function replace(entries, name, value, options) {
  return entries.map(entry => entry[0] === name ? [name, value, options] : entry);
}

test('real xref PDF yields bounded text and a decodable nonempty JPEG', async () => {
  const result = await extractDocument(pdf(), 'pdf');
  assert.equal(result.kind, 'document'); assert.equal(result.pages, 1);
  assert.match(result.text, /\[Page 1\][\s\S]*Hello PDF/);
  assert.equal(result.images.length, 1);
  assert.equal(result.images[0].name, 'Page 1');
  assert.match(result.images[0].dataUrl, /^data:image\/jpeg;base64,/);
  const bytes = Buffer.from(result.images[0].dataUrl.split(',')[1], 'base64');
  assert.equal(bytes.readUInt16BE(), 0xffd8); assert.ok(bytes.length < 4 * 1024 * 1024);
  const require = createRequire(import.meta.url);
  const canvas = createRequire(require.resolve('pdfjs-dist/legacy/build/pdf.mjs'))('@napi-rs/canvas');
  const image = await canvas.loadImage(bytes);
  assert.ok(image.width > 0 && image.height > 0 && image.width * image.height <= 1500000);
});

test('PDF renders/extracts only the requested range with absolute labels and continuation metadata', async () => {
  const source = pdf({ pages: 7, text: n => `Evidence from page ${n}` });
  for (const [options, expected, nextPage] of [[{}, [1, 2, 3], 4], [{ startPage: 4 }, [4, 5, 6], 7], [{ startPage: 7 }, [7], null], [{ startPage: 4, pageCount: 2 }, [4, 5], 6]]) {
    const result = await extractDocument(source, 'pdf', options);
    assert.equal(result.pages, 7); assert.equal(result.startPage, expected[0]);
    assert.equal(result.nextPage, nextPage); assert.equal(result.partCount, 3);
    assert.deepEqual(result.images.map(image => image.name), expected.map(n => `Page ${n}`));
    assert.deepEqual([...result.text.matchAll(/\[Page (\d+)\]/g)].map(match => Number(match[1])), expected);
    for (let n = 1; n <= 7; n++) assert.equal(result.text.includes(`Evidence from page ${n}`), expected.includes(n));
    assert.ok(!result.warnings.some(w => /first 3|text only/.test(w)));
    assert.ok(result.images.reduce((n, image) => n + Buffer.from(image.dataUrl.split(',')[1], 'base64').length, 0) <= 6 * 1024 * 1024);
  }
  const six = await extractDocument(pdf({ pages: 6 }), 'pdf', { startPage: 4 });
  assert.equal(six.nextPage, null); assert.equal(six.partCount, 2);
  assert.deepEqual(six.images.map(image => image.name), ['Page 4', 'Page 5', 'Page 6']);
});

test('blank local ranges do not abort other usable PDF ranges', async () => {
  const source = pdf({ pages: 7, blankPages: [1, 2, 3, 7] });
  for (const startPage of [1, 7]) {
    const result = await extractDocument(source, 'pdf', { startPage });
    assert.equal(result.text, ''); assert.deepEqual(result.images, []);
    assert.equal(result.nextPage, startPage === 1 ? 4 : null);
    assert.ok(result.warnings.some(w => /other pages may still be usable/.test(w)));
  }
  const middle = await extractDocument(source, 'pdf', { startPage: 4 });
  assert.equal(middle.images.length, 3);
  assert.ok(!middle.warnings.some(w => /no extractable text/.test(w)));
});

test('PDF range options reject invalid types, values and out-of-bounds starts', async () => {
  const source = pdf();
  for (const startPage of [0, -1, 1.5, '1', null, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) await rejected(source, 'pdf', /startPage/, { startPage });
  for (const pageCount of [0, -1, 4, 1.5, '3', null, NaN, Infinity]) await rejected(source, 'pdf', /pageCount/, { pageCount });
  for (const options of [null, [], 'range', 1]) await rejected(source, 'pdf', /options/, options);
  await rejected(source, 'pdf', /page count/, { startPage: 2 });
});

test('image-only PDF explicitly needs vision and does not claim OCR', async () => {
  const result = await extractDocument(pdf({ scan: true }), 'pdf');
  assert.equal(result.images.length, 1);
  assert.ok(result.warnings.some(w => /No local OCR.*vision-capable/.test(w)));
});

test('render failures permit text fallback but reject image-only documents', async t => {
  const require = createRequire(import.meta.url);
  const canvas = createRequire(require.resolve('pdfjs-dist/legacy/build/pdf.mjs'))('@napi-rs/canvas');
  t.mock.method(canvas, 'createCanvas', () => { throw new Error('PRIVATE_SECRET native rendering error'); });
  const result = await extractDocument(pdf(), 'pdf');
  assert.match(result.text, /Hello PDF/); assert.deepEqual(result.images, []);
  assert.ok(result.warnings.some(w => /could not be rendered/.test(w)));
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SECRET/);
  await rejected(pdf({ scan: true }), 'pdf', /no readable text remains/);
});

test('PDF retains text above 35k and errors honestly at the workspace text limit', async () => {
  const result = await extractDocument(pdf({ text: 'word '.repeat(8000), fontSize: 0.001 }), 'pdf');
  assert.ok(result.text.length > 35000);
  assert.ok(!result.warnings.some(w => /truncated/.test(w)));
  await rejected(pdf({ text: 'word '.repeat(400001), fontSize: 0.00001 }), 'pdf', /workspace resource limit of 2,000,000/);
});

test('empty PDF, page limit, invalid signature, damaged PDF and password protection', async () => {
  await rejected(pdf({ blank: true }), 'pdf', /No readable text/);
  await rejected(pdf({ pages: 1001 }), 'pdf', /1,000-page/);
  const last = await extractDocument(pdf({ pages: 1000 }), 'pdf', { startPage: 1000 });
  assert.equal(last.pages, 1000); assert.equal(last.partCount, 334); assert.equal(last.nextPage, null);
  assert.match(last.text, /\[Page 1000\]/);
  await rejected(Buffer.from('PRIVATE_SECRET'), 'pdf', /signature/);
  await rejected(Buffer.from('%PDF-1.7\nPRIVATE_SECRET broken'), 'pdf', /could not be read/);
  await rejected(pdf({ encrypted: true }), 'pdf', /Encrypted|password/);
  await rejected(pdf({ encrypted: true, password: '' }), 'pdf', /Encrypted|password/);
});

test('DOCX paragraphs, tables, notes and formula approximations', async () => {
  const body = paragraph('Hello DOCX') + `<w:tbl><w:tr><w:tc>${paragraph('Cell one')}</w:tc><w:tc>${paragraph('Cell two')}</w:tc></w:tr></w:tbl><m:oMath><m:r><m:t>x + 1</m:t></m:r></m:oMath>`;
  const result = await extractDocument(zip(docxEntries(body)), 'docx');
  assert.match(result.text, /Hello DOCX[\s\S]*Cell one[\s\S]*Cell two[\s\S]*x \+ 1[\s\S]*Footnote evidence/);
  assert.deepEqual(result.images, []);
  assert.ok(result.warnings.some(w => /Office visuals.*screenshots/.test(w)));
  assert.ok(result.warnings.some(w => /Formula text is an approximation/.test(w)));
});

test('PPTX true presentation order, safe local speaker notes and ignored external links', async () => {
  const result = await extractDocument(zip(pptxEntries()), 'pptx');
  assert.equal(result.slides, 2);
  assert.match(result.text, /\[Slide 1\][\s\S]*Lexical second, displayed first[\s\S]*\[Speaker notes\][\s\S]*Speaker note evidence[\s\S]*\[Slide 2\][\s\S]*Lexical first, displayed second/);
  assert.doesNotMatch(result.text, /example\.invalid/);
  assert.ok(result.warnings.some(w => /External.*ignored/.test(w)));
});

test('Office retains all text above 35k; labels alone never make an empty document usable', async () => {
  const long = 'Retained evidence '.repeat(4000);
  const result = await extractDocument(zip(docxEntries(paragraph(long))), 'docx');
  assert.ok(result.text.startsWith(long)); assert.match(result.text, /Footnote evidence$/);
  const slides = pptxEntries().map(([name, value]) => [name, value.replace('Lexical second, displayed first', long)]);
  const presentation = await extractDocument(zip(slides), 'pptx');
  assert.ok(presentation.text.includes(long));
  assert.match(presentation.text, /Speaker note evidence[\s\S]*\[Slide 2\][\s\S]*Lexical first, displayed second/);
  assert.ok(![...result.warnings, ...presentation.warnings].some(w => /truncated/.test(w)));
  await rejected(zip(docxEntries('').filter(([name]) => !name.includes('footnotes') && !name.includes('document.xml.rels'))), 'docx', /No readable text/);
  const empty = pptxEntries().map(([name, value]) => [name, value.replace(/Lexical first, displayed second|Lexical second, displayed first|Speaker note evidence/g, '')]);
  await rejected(zip(empty), 'pptx', /No readable text/);
});

test('Office text cap returns a workspace resource error, never partial success', async () => {
  const bodyOnly = body => docxEntries(body).filter(([name]) => !name.includes('footnotes') && !name.includes('document.xml.rels'));
  const boundary = await extractDocument(zip(bodyOnly(paragraph('a'.repeat(1999999)))), 'docx');
  assert.equal(boundary.text.length, 1999999); // The paragraph separator is the 2,000,000th character.
  await rejected(zip(bodyOnly(paragraph('a'.repeat(2000000)))), 'docx', /workspace resource limit of 2,000,000/);
  const slides = pptxEntries().map(([name, value]) => [name, value.replace('Lexical second, displayed first', 'a'.repeat(2000001))]);
  await rejected(zip(slides), 'pptx', /workspace resource limit of 2,000,000/);
});

test('media above 40 MiB is streamed and CRC-checked separately from aggregate XML', async () => {
  const media = Buffer.alloc(41 * 1024 * 1024, 42);
  const result = await extractDocument(zip([...docxEntries(), ['word/media/image.bin', media]]), 'docx');
  assert.match(result.text, /Hello DOCX/);
  await rejected(zip([...docxEntries(), ['word/media/image.bin', media, { crc: 0 }]]), 'docx', /damaged entry/);
  const xml = Buffer.from('<x>' + ' '.repeat(8 * 1024 * 1024 - 7) + '</x>');
  await rejected(zip([...docxEntries(), ...Array.from({ length: 5 }, (_, i) => [`unused${i}.xml`, xml])]), 'docx', /40 MiB aggregate/);
});

test('input validation and renamed or macro-enabled files', async () => {
  await rejected(Buffer.alloc(0), 'pdf', /empty/);
  await rejected(Buffer.alloc(100 * 1024 * 1024 + 1), 'pdf', /100 MiB/);
  await rejected('PRIVATE_SECRET', 'docx', /binary/);
  await rejected(Buffer.from('x'), 'exe', /Only PDF/);
  await rejected(Buffer.from('PRIVATE_SECRET'), 'docx', /ZIP/);
  await rejected(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), 'docx', /Encrypted or legacy/);
  await rejected(zip(docxEntries()), 'pptx', /does not match/);
  const macro = docxEntries().map(([name, value]) => [name, value.replace('wordprocessingml.document.main+xml', 'wordprocessingml.document.macroEnabled.main+xml')]);
  await rejected(zip(macro), 'docx', /Macro-enabled/);
  await rejected(zip([...docxEntries(), ['word/vbaProject.bin', 'x']]), 'docx', /Macro-enabled/);
});

test('archive traversal, absolute paths, backslashes, duplicates and encryption', async () => {
  for (const name of ['../PRIVATE_SECRET.xml', '/PRIVATE_SECRET.xml', 'C:/PRIVATE_SECRET.xml', 'word\\PRIVATE_SECRET.xml', 'word/./PRIVATE_SECRET.xml', 'word/%2e%2e/private.xml']) {
    await rejected(zip([...docxEntries(), [name, '<x/>']]), 'docx', /unsafe|damaged/);
  }
  await rejected(zip([...docxEntries(), docxEntries()[2]]), 'docx', /duplicate/);
  await rejected(zip([...docxEntries(), ['WORD/document.xml', '<x/>']]), 'docx', /duplicate/);
  await rejected(zip(replace(docxEntries(), 'word/document.xml', word(paragraph('PRIVATE_SECRET')), { flags: 0x801 })), 'docx', /Encrypted/);
  await rejected(zip(replace(docxEntries(), 'word/document.xml', word(paragraph('PRIVATE_SECRET')), { localFlags: 0x801 })), 'docx', /Encrypted/);
});

test('ZIP limits: entry count, XML size, total expanded size, ratio and forged actual decompression', async () => {
  await rejected(zip(Array.from({ length: 2001 }, (_, i) => [`entry${i}`, ''])), 'docx', /2,000-entry/);
  await rejected(zip([...docxEntries(), ['big.xml', '<x/>', { deflate: true, size: 8 * 1024 * 1024 + 1 }]]), 'docx', /8 MiB/);
  await rejected(zip([...docxEntries(), ['big.bin', 'x', { deflate: true, size: 1024 * 1024 * 1024 + 1 }]]), 'docx', /1 GiB/);
  await rejected(zip([...docxEntries(), ['bomb.bin', 'a'.repeat(1000000), { deflate: true }]]), 'docx', /250:1/);
  await rejected(zip([...docxEntries(), ['liar.bin', 'a'.repeat(100000), { deflate: true, size: 100 }]]), 'docx');
  await rejected(zip([...docxEntries(), ['bad.bin', 'data', { crc: 0 }]]), 'docx', /damaged entry/);
  await rejected(zip(docxEntries()).subarray(0, 50), 'docx', /could not be read/);
});

test('strict SAX rejects malformed XML, DTD/entities, external processing and excessive nesting, including unused parts', async () => {
  const bad = [
    ['<w:document xmlns:w="' + namespaces.w + '"><w:t>PRIVATE_SECRET</w:document>', /malformed/],
    ['<!DOCTYPE secret [<!ENTITY x "PRIVATE_SECRET">]><x>&x;</x>', /DOCTYPE/],
    ['<!DOCTYPE secret SYSTEM "https://example.invalid/PRIVATE_SECRET"><x/>', /DOCTYPE/],
    ['<x>&PRIVATE_SECRET;</x>', /entities/],
    ['<?xml-stylesheet href="https://example.invalid/PRIVATE_SECRET"?><x/>', /external references/],
    ['<x>'.repeat(81) + '</x>'.repeat(81), /nesting/],
  ];
  for (const [data, pattern] of bad) await rejected(zip([...docxEntries(), ['unused.xml', data]]), 'docx', pattern);
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('<!DOCTYPE secret><x/>', 'utf16le')]);
  await rejected(zip([...docxEntries(), ['unused.xml', utf16]]), 'docx', /DOCTYPE/);
});

test('main relationships and content types are required, and local relationship traversal is rejected', async () => {
  await rejected(zip(docxEntries().filter(([name]) => name !== '[Content_Types].xml')), 'docx', /missing/);
  await rejected(zip(replace(docxEntries(), '_rels/.rels', rels([relationship('main', 'officeDocument', 'word/document.xml', 'External')]))), 'docx', /main-part/);
  await rejected(zip(replace(docxEntries(), 'word/_rels/document.xml.rels', rels([relationship('evil', 'footnotes', '../../PRIVATE_SECRET.xml')]))), 'docx', /unsafe/);
  await rejected(zip(replace(pptxEntries(), 'ppt/_rels/presentation.xml.rels', rels([relationship('second', 'slide', 'https://example.invalid/PRIVATE_SECRET')]))), 'pptx', /unsafe/);
});

test('PPTX accepts 1000 ordered slides and rejects more or invalid slide relationships', async () => {
  const result = await extractDocument(zip(pptxManyEntries(1000)), 'pptx');
  assert.equal(result.slides, 1000);
  assert.deepEqual([...result.text.matchAll(/Ordered slide (\d+)/g)].map(match => Number(match[1])), Array.from({ length: 1000 }, (_, i) => i + 1));
  await rejected(zip(pptxManyEntries(1001)), 'pptx', /1,000-slide/);
  await rejected(zip(replace(pptxEntries(), 'ppt/_rels/presentation.xml.rels', rels([]))), 'pptx', /invalid slide/);
});
