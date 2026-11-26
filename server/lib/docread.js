'use strict';
// Turns an uploaded evidence file into something Aegis can read: text, a PDF, or page images.
//
//   Text is taken out by code:  PDF (pdfjs-dist), Word .docx (mammoth), Word .doc (word-extractor),
//                               RTF, OpenDocument .odt, web pages, plain text.
//   Pictures are made by code:  photos (JPEG, PNG, WebP, GIF), iPhone HEIC (heic-convert), TIFF scans
//                               and faxes (sharp), scanned PDF pages, Apple Pages previews.
//   Containers are opened:      .zip folders, emails (.eml, Outlook .msg). Each document inside is
//                               read as its own upload (see unpack).
// The AI reads the text, the PDF or the pictures; see evidence.js.
const path = require('path'), zlib = require('zlib');

const MAX_TEXT = 20000;
const MAX_PAGES = 3;
const PHOTO_TYPES = { jpg: 'image/jpeg', jpeg: 'image/jpeg', jfif: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };
const AI_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const extOf = (name) => (/\.([a-z0-9]+)$/i.exec(String(name || ''))?.[1] || '').toLowerCase();
const unsupported = (note) => ({ kind: 'unsupported', text: '', note });
const NOT_READABLE = 'This file type cannot be read. Upload a PDF, Word, OpenDocument or RTF document, a photo or scan (JPEG, PNG, HEIC, TIFF), a text file, an email or a .zip of these.';

// ---------- PDF ----------
let pdfjsPromise = null;
const pdfjs = () => (pdfjsPromise ||= import('pdfjs-dist/legacy/build/pdf.mjs'));
// pdfjs wants its data folders as a path with forward slashes and a trailing slash, also on Windows.
const pdfjsDir = (sub) => `${path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), sub).replace(/\\/g, '/')}/`;
async function openPdf(buf) {
  const lib = await pdfjs();
  return lib.getDocument({
    data: new Uint8Array(buf), isEvalSupported: false, verbosity: 0, useSystemFonts: false,
    standardFontDataUrl: pdfjsDir('standard_fonts'), cMapUrl: pdfjsDir('cmaps'), cMapPacked: true,
  });
}

// Lines in reading order. Pieces on the same line far apart (table columns) are joined with a tab,
// so a label in one column is not read together with the value of the next.
// scanPages lists the pages that are pictures with no text of their own (a scanned page inside an
// otherwise typed PDF), so what is read from them can be confirmed by a person.
async function pdfjsText(buf) {
  const task = await openPdf(buf), lib = await pdfjs();
  const IMAGE_OPS = new Set([lib.OPS.paintImageXObject, lib.OPS.paintInlineImageXObject, lib.OPS.paintImageXObjectRepeat, lib.OPS.paintImageMaskXObject]);
  try {
    const doc = await task.promise, lines = [], scanPages = [];
    for (let n = 1; n <= Math.min(doc.numPages, 20); n++) {
      const page = await doc.getPage(n), { items } = await page.getTextContent();
      const letters = items.reduce((sum, it) => sum + ((it.str || '').match(/\p{L}/gu) || []).length, 0);
      if (letters < 15 && (await page.getOperatorList()).fnArray.some((op) => IMAGE_OPS.has(op))) scanPages.push(n);
      let line = '', lastY = null, lastEnd = null;
      for (const it of items) {
        if (typeof it.str !== 'string') continue;
        if (!it.str.trim() && !it.hasEOL) continue; // spacing pieces: the gap is measured from real text
        const [, , , size, x, y] = it.transform, h = Math.abs(size) || 10;
        if (lastY !== null && Math.abs(y - lastY) > h * 0.5) { lines.push(line); line = ''; lastEnd = null; }
        if (lastEnd !== null && it.str) line += x - lastEnd > h * 2 ? '\t' : x - lastEnd > h * 0.15 && !/\s$/.test(line) && !/^\s/.test(it.str) ? ' ' : '';
        line += it.str;
        if (it.str) { lastY = y; lastEnd = x + (it.width || 0); }
        if (it.hasEOL) { lines.push(line); line = ''; lastY = null; lastEnd = null; }
      }
      if (line) lines.push(line);
      lines.push('');
      page.cleanup();
    }
    return { text: lines.map((l) => l.replace(/[  ]+/g, ' ').trimEnd()).join('\n').replace(/\n{3,}/g, '\n\n').trim(), pages: doc.numPages, scanPages };
  } finally { await task.destroy(); }
}

// The old simple reader, kept for broken PDFs that pdfjs refuses to open.
function simplePdfText(buf) {
  let s = buf.toString('latin1');
  for (const m of s.matchAll(/stream\r?\n([\s\S]*?)endstream/g)) { try { s += zlib.inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1'); } catch { /* not compressed */ } }
  const unescape = (x) => x.replace(/\\([0-7]{1,3}|[nrtbf()\\])/g, (_, c) => (/^[0-7]/.test(c) ? String.fromCharCode(parseInt(c, 8)) : { n: '\n', r: '\r', t: '\t', b: '', f: '' }[c] ?? c));
  const parts = [];
  for (const m of s.matchAll(/\(((?:[^()\\]|\\.)*)\)\s*Tj|\[((?:[^\]\\]|\\.)*)\]\s*TJ/g)) {
    parts.push(m[1] !== undefined ? unescape(m[1]) : [...m[2].matchAll(/\(((?:[^()\\]|\\.)*)\)/g)].map((x) => unescape(x[1])).join(''));
  }
  return parts.join('\n');
}

async function readPdf(buf, note) {
  let text = '', pages = 0, scanPages = [], opened = false;
  try { ({ text, pages, scanPages } = await pdfjsText(buf)); opened = true; } catch { /* damaged or unusual PDF */ }
  if (!usable(text)) text = simplePdfText(buf);
  text = usable(text).slice(0, MAX_TEXT);
  // Not a PDF at all, only named .pdf (a PDF says so in its first bytes). A real PDF that will not
  // open here is still kept, because the AI may read it.
  if (!opened && !text && !buf.subarray(0, 1024).includes('%PDF-')) return unsupported('This file is named .pdf but is not a PDF, so it cannot be opened. Save or export it as PDF again and upload it again.');
  // scanPages only matters when other pages have text; with no text at all the whole PDF is a scan.
  return { kind: 'pdf', text, pdf: buf, pages, scanPages: text ? scanPages : [], ...(note ? { note } : {}) };
}

// Draws the first pages of a PDF as JPEG images, for an AI that reads images but not PDFs and for
// the preview on the review screen. Returns [] when the PDF cannot be drawn.
async function pageImages(buf, maxPages = MAX_PAGES, only = null) {
  let task;
  try {
    task = await openPdf(buf);
    const doc = await task.promise, out = [];
    const wanted = (only?.length ? only : Array.from({ length: doc.numPages }, (_, i) => i + 1)).filter((n) => n <= doc.numPages).slice(0, maxPages);
    for (const n of wanted) {
      const page = await doc.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: Math.min(2, 1800 / Math.max(base.width, base.height)) });
      const { canvas, context } = doc.canvasFactory.create(Math.ceil(viewport.width), Math.ceil(viewport.height));
      context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: context, viewport, canvas }).promise;
      out.push(canvas.toBuffer('image/jpeg', 85));
      page.cleanup();
    }
    return out;
  } catch { return []; } finally { if (task) await task.destroy().catch(() => {}); }
}

// ---------- Pictures ----------
// Every picture becomes an upright JPEG no larger than 2000 pixels, which every AI provider accepts
// (phone photos can be 10 MB and sideways). TIFF scans and faxes can have several pages.
// Windows BMP pictures, which the image library cannot open: the uncompressed kinds that scanners
// and Paint save (1, 4, 8, 24 and 32 bits per pixel), turned into plain pixels. Compressed ones return null.
function bmpPixels(buf) {
  if (buf.length < 54 || buf.toString('latin1', 0, 2) !== 'BM') return null;
  const start = buf.readUInt32LE(10), header = buf.readUInt32LE(14), width = buf.readInt32LE(18), rawHeight = buf.readInt32LE(22);
  const bits = buf.readUInt16LE(28), compression = buf.readUInt32LE(30), height = Math.abs(rawHeight);
  if (header < 40 || width <= 0 || !height || width * height > 120e6 || ![1, 4, 8, 24, 32].includes(bits)) return null;
  if (!(compression === 0 || (compression === 3 && bits === 32))) return null; // RLE and other packed kinds
  const colors = bits <= 8 ? (buf.readUInt32LE(46) || 2 ** bits) : 0, palette = 14 + header;
  const stride = Math.ceil((width * bits) / 32) * 4;
  if (start + stride * height > buf.length) return null;
  const out = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    const row = start + stride * (rawHeight > 0 ? height - 1 - y : y); // most BMPs are stored bottom row first
    for (let x = 0; x < width; x++) {
      let at;
      if (bits === 24) at = row + x * 3;
      else if (bits === 32) at = row + x * 4;
      else {
        const index = (buf[row + ((x * bits) >> 3)] >> (8 - bits - ((x * bits) & 7))) & ((1 << bits) - 1);
        if (index >= colors) return null;
        at = palette + index * 4;
      }
      const o = (y * width + x) * 3;
      out[o] = buf[at + 2]; out[o + 1] = buf[at + 1]; out[o + 2] = buf[at]; // stored blue, green, red
    }
  }
  return { data: out, info: { width, height, channels: 3 } };
}
async function toJpegs(buf, maxPages = MAX_PAGES) {
  const sharp = require('sharp');
  const bmp = bmpPixels(buf);
  if (bmp) return [await sharp(bmp.data, { raw: bmp.info }).resize({ width: 2000, height: 2000, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer()];
  const opts = { failOn: 'none', limitInputPixels: 120e6 };
  const pages = Math.max(1, Math.min((await sharp(buf, opts).metadata()).pages || 1, maxPages));
  const out = [];
  for (let page = 0; page < pages; page++) {
    out.push(await sharp(buf, { ...opts, page }).rotate().flatten({ background: '#ffffff' })
      .resize({ width: 2000, height: 2000, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer());
  }
  return out;
}
async function readPicture(buf, mediaType, note) {
  try {
    let src = buf;
    if (mediaType === 'image/heic') src = Buffer.from(await require('heic-convert')({ buffer: buf, format: 'JPEG', quality: 0.92 }));
    const images = await toJpegs(src);
    return { kind: 'image', text: '', images: images.map((data) => ({ data, mediaType: 'image/jpeg' })), ...(note ? { note } : {}) };
  } catch {
    // A picture the converter cannot open is sent as it is when the AI accepts that type.
    if (AI_IMAGE_TYPES.has(mediaType)) return { kind: 'image', text: '', images: [{ data: buf, mediaType }], ...(note ? { note } : {}) };
    return unsupported('This picture could not be opened. It may be damaged. Save it again as JPEG, PNG or PDF.');
  }
}

// ---------- Text documents ----------
// Text worth reading: enough letters, and mostly ordinary characters rather than font codes.
function usable(text) {
  const t = String(text || '').trim();
  const letters = (t.match(/\p{L}/gu) || []).length;
  const plain = (t.match(/[\p{L}\p{N}\s.,:;'"()/#&@%+\-•|]/gu) || []).length;
  return letters >= 15 && plain / t.length >= 0.75 ? t : '';
}
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decodeEntities = (s) => s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => (e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : +e.slice(1)) : ENTITIES[e.toLowerCase()] ?? m));
const tidy = (s) => s.replace(/[  ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
// Table cells become tabs and rows become lines, so "Name on document | Sarah Jenkins" stays together.
function htmlText(html) {
  return tidy(decodeEntities(String(html)
    .replace(/<(script|style|head|noscript|template)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/p>\s*<\/t([dh])>/gi, '</t$1>')
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h[1-6]|table|section|article)>/gi, '\n')
    .replace(/<\/t[dh]>/gi, '\t')
    .replace(/<[^>]+>/g, '')));
}
function odfText(xml) {
  return tidy(decodeEntities(String(xml)
    .replace(/<text:s(?:\s+text:c="(\d+)")?\s*\/>/g, (_, n) => ' '.repeat(+n || 1))
    .replace(/<text:tab\s*\/>/g, '\t').replace(/<text:line-break\s*\/>/g, '\n')
    .replace(/<\/text:(?:p|h)>\s*<\/table:table-cell>/g, '</table:table-cell>')
    .replace(/<\/text:(?:p|h)>/g, '\n').replace(/<\/table:table-cell>/g, '\t').replace(/<\/table:table-row>/g, '\n')
    .replace(/<[^>]+>/g, '')));
}
// RTF to text. Skips fonts, colours, styles, pictures and field codes; keeps paragraphs and table cells.
const RTF_SKIP = new Set(['fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'object', 'header', 'headerl', 'headerr', 'headerf', 'footer', 'footerl', 'footerr', 'footerf', 'xmlnstbl', 'listtable', 'listoverridetable', 'rsidtbl', 'generator', 'themedata', 'colorschememapping', 'latentstyles', 'datastore', 'fldinst', 'mmathPr', 'pgdsctbl', 'filetbl', 'revtbl', 'bkmkstart', 'bkmkend']);
const RTF_CHARS = { par: '\n', line: '\n', row: '\n', sect: '\n', page: '\n', tab: '\t', cell: '\t', emdash: '—', endash: '–', bullet: '•', lquote: '‘', rquote: '’', ldblquote: '“', rdblquote: '”', emspace: ' ', enspace: ' ', qmspace: ' ' };
function rtfText(rtf) {
  const s = String(rtf), cp1252 = new TextDecoder('windows-1252');
  let out = '', skip = false, uc = 1, pending = 0;
  const stack = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '{') { stack.push({ skip, uc }); continue; }
    if (c === '}') { ({ skip, uc } = stack.pop() || { skip: false, uc: 1 }); continue; }
    if (c === '\r' || c === '\n') continue;
    if (c !== '\\') { if (pending) pending--; else if (!skip) out += c; continue; }
    const next = s[i + 1];
    if (next === '\\' || next === '{' || next === '}') { i++; if (!skip) out += next; continue; }
    if (next === "'") { const hex = s.substr(i + 2, 2); i += 3; if (pending) pending--; else if (!skip) out += cp1252.decode(Buffer.from([parseInt(hex, 16)])); continue; }
    if (next === '*') { i++; skip = true; continue; }
    if (next === '~') { i++; if (!skip) out += ' '; continue; }
    if (next === '_' || next === '-') { i++; if (!skip && next === '_') out += '-'; continue; }
    const m = /^([a-z]{1,32})(-?\d{1,10})? ?/i.exec(s.slice(i + 1, i + 45));
    if (!m) { i++; continue; }
    i += m[0].length;
    const [, word, arg] = m;
    if (RTF_SKIP.has(word)) skip = true;
    else if (word === 'uc') uc = +arg || 0;
    else if (word === 'u') { if (!skip) out += String.fromCharCode(+arg < 0 ? +arg + 65536 : +arg); pending = uc; }
    else if (!skip && RTF_CHARS[word]) out += RTF_CHARS[word];
  }
  return tidy(out.replace(/\t+\n/g, '\n'));
}

// ---------- Zip (also inside .docx, .odt, .pages) ----------
// Reads the zip directory only; each file is inflated when asked for, with size limits, so a zip
// bomb cannot fill the memory. Encrypted and ZIP64 entries are left out.
function zipEntries(buf) {
  let i = buf.length - 22;
  const stop = Math.max(0, buf.length - 22 - 65535);
  while (i >= stop && buf.readUInt32LE(i) !== 0x06054b50) i--;
  if (i < stop) return null;
  const count = buf.readUInt16LE(i + 10), entries = [];
  let p = buf.readUInt32LE(i + 16);
  for (let k = 0; k < Math.min(count, 500) && p + 46 <= buf.length && buf.readUInt32LE(p) === 0x02014b50; k++) {
    const flags = buf.readUInt16LE(p + 8), method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nl = buf.readUInt16LE(p + 28), xl = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const name = buf.toString(flags & 0x800 ? 'utf8' : 'latin1', p + 46, p + 46 + nl).replace(/\\/g, '/');
    p += 46 + nl + xl + cl;
    if (name.endsWith('/') || flags & 1 || [csize, usize, off].includes(0xffffffff) || ![0, 8].includes(method)) continue;
    entries.push({ name, size: usize, read(limit = 30 * 1024 * 1024) {
      if (usize > limit || off + 30 > buf.length) throw new Error('too large');
      const start = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
      const data = buf.subarray(start, start + csize);
      return method === 0 ? Buffer.from(data) : zlib.inflateRawSync(data, { maxOutputLength: limit });
    } });
  }
  return entries;
}
const isZip = (buf) => buf.length > 22 && buf.readUInt32LE(0) === 0x04034b50;

async function readPages(buf) {
  const entries = zipEntries(buf) || [];
  const find = (re) => entries.filter((e) => re.test(e.name)).sort((a, b) => b.size - a.size)[0];
  const preview = 'Read from the preview Apple Pages keeps inside the file. Check it against the original.';
  const pdf = find(/(^|\/)QuickLook\/Preview\.pdf$/i);
  if (pdf) return readPdf(pdf.read(), preview);
  const jpg = find(/(^|\/)(preview(-web)?\.jpg|QuickLook\/Thumbnail\.jpg)$/i);
  if (jpg) return readPicture(jpg.read(), 'image/jpeg', preview);
  return unsupported('This Apple Pages file has no preview Aegis can read. In Pages, choose File > Export To > PDF and upload the PDF.');
}

// ---------- One document ----------
// { kind: 'pdf' | 'image' | 'word' | 'html' | 'text' | 'unsupported', text, pdf, images, note }
// text is '' when the file has no readable text (a scan, a photo). images are { data, mediaType }.
async function read(buf, mime = '', name = '') {
  mime = String(mime || '').toLowerCase();
  const ext = extOf(name), head = buf.subarray(0, 8);
  if (/pdf/.test(mime) || ext === 'pdf' || head.toString('latin1', 0, 5) === '%PDF-') return readPdf(buf);
  if (ext === 'heic' || ext === 'heif' || /image\/hei[cf]/.test(mime)) return readPicture(buf, 'image/heic');
  if (ext === 'tif' || ext === 'tiff' || mime === 'image/tiff') return readPicture(buf, 'image/tiff');
  if (PHOTO_TYPES[ext] || AI_IMAGE_TYPES.has(mime)) return readPicture(buf, AI_IMAGE_TYPES.has(mime) ? mime : PHOTO_TYPES[ext]);
  if (ext === 'bmp' || mime === 'image/bmp' || ext === 'avif' || mime === 'image/avif') return readPicture(buf, mime || `image/${ext}`);
  if (ext === 'pages') return readPages(buf);
  if (ext === 'docx' || /wordprocessingml/.test(mime)) {
    try {
      const { value } = await require('mammoth').convertToHtml({ buffer: buf });
      return { kind: 'word', text: htmlText(value).slice(0, MAX_TEXT) };
    } catch { return unsupported('This Word file could not be opened. It may be damaged or password-protected. Save it again as .docx or PDF.'); }
  }
  if (ext === 'doc' || /msword/.test(mime)) {
    try {
      const doc = await new (require('word-extractor'))().extract(buf);
      const text = [doc.getHeaders?.({ includeFooters: false }), doc.getBody(), doc.getFootnotes?.()].filter(Boolean).join('\n');
      return { kind: 'word', text: tidy(text.replace(/\r/g, '\n')).slice(0, MAX_TEXT) };
    } catch { return unsupported('This Word .doc file could not be opened. It may be damaged or password-protected. Save it again as .docx or PDF.'); }
  }
  if (ext === 'rtf' || /rtf/.test(mime) || head.toString('latin1', 0, 5) === '{\\rtf') return { kind: 'word', text: rtfText(buf.toString('latin1')).slice(0, MAX_TEXT) };
  if (ext === 'odt' || /opendocument\.text/.test(mime)) {
    const content = isZip(buf) && (zipEntries(buf) || []).find((e) => e.name === 'content.xml');
    if (!content) return unsupported('This OpenDocument file could not be opened. Save it again as .odt, .docx or PDF.');
    return { kind: 'word', text: odfText(content.read().toString('utf8')).slice(0, MAX_TEXT) };
  }
  if (/html/.test(mime) || ext === 'html' || ext === 'htm' || ext === 'xhtml') return { kind: 'html', text: htmlText(buf.toString('utf8')).slice(0, MAX_TEXT) };
  if (/^text\//.test(mime) || ['txt', 'csv', 'md', 'text', 'log'].includes(ext)) return { kind: 'text', text: buf.toString('utf8').replace(/^﻿/, '').replace(/\r\n?/g, '\n').slice(0, MAX_TEXT) };
  return unsupported(NOT_READABLE);
}

// ---------- Containers: zip folders and emails ----------
const MIME_BY_EXT = { pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', doc: 'application/msword', rtf: 'application/rtf', odt: 'application/vnd.oasis.opendocument.text', pages: 'application/vnd.apple.pages', txt: 'text/plain', csv: 'text/csv', html: 'text/html', htm: 'text/html', eml: 'message/rfc822', msg: 'application/vnd.ms-outlook', zip: 'application/zip', heic: 'image/heic', heif: 'image/heif', tif: 'image/tiff', tiff: 'image/tiff', bmp: 'image/bmp', ...PHOTO_TYPES };
const mimeFor = (name, given) => MIME_BY_EXT[extOf(name)] || given || 'application/octet-stream';
// Parts of an email that are not documents: signatures, calendar invites, contact cards, logos.
const NOT_A_DOCUMENT = /\.(p7s|p7m|asc|sig|ics|vcf|vcs|eml\.txt)$|^(smime|signature)\./i;
const isContainer = (mime, name, buf) => {
  const ext = extOf(name);
  if (['docx', 'odt', 'pages', 'xlsx', 'pptx'].includes(ext)) return false;
  return ext === 'zip' || ext === 'eml' || ext === 'msg' || /zip|message\/rfc822|ms-outlook/.test(String(mime))
    || (!ext && isZip(buf));
};

function decodeWords(s) { // =?UTF-8?B?...?= and =?UTF-8?Q?...?= in email headers
  // Encoded words next to each other are one piece of text: the space between them is not part of it.
  return String(s || '').replace(/(=\?[^?]+\?[bq]\?[^?]*\?=)\s+(?==\?)/gi, '$1').replace(/=\?([^?]+)\?([bq])\?([^?]*)\?=/gi, (_, cs, enc, txt) => {
    const bytes = enc.toLowerCase() === 'b' ? Buffer.from(txt, 'base64') : Buffer.from(txt.replace(/_/g, ' ').replace(/=([0-9a-f]{2})/gi, (m, h) => String.fromCharCode(parseInt(h, 16))), 'latin1');
    try { return new TextDecoder(cs.toLowerCase()).decode(bytes); } catch { return bytes.toString('utf8'); }
  });
}
const param = (header, key) => {
  const star = new RegExp(`${key}\\*=(?:[^']*'[^']*')?("?)([^";]+)\\1`, 'i').exec(header || '');
  if (star) { try { return decodeURIComponent(star[2]); } catch { return star[2]; } }
  const m = new RegExp(`${key}=("([^"]*)"|[^;\\s]+)`, 'i').exec(header || '');
  return m ? decodeWords(m[2] ?? m[1]) : '';
};
function parseMime(raw, depth = 0) {
  const split = /\r?\n\r?\n/.exec(raw);
  const headText = split ? raw.slice(0, split.index) : raw, body = split ? raw.slice(split.index + split[0].length) : '';
  const headers = {};
  for (const line of headText.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const m = /^([\w-]+):\s*(.*)$/.exec(line);
    if (m) headers[m[1].toLowerCase()] = m[2];
  }
  const type = (headers['content-type'] || 'text/plain').split(';')[0].trim().toLowerCase();
  if (type.startsWith('multipart/') && depth < 8) {
    const boundary = param(headers['content-type'], 'boundary');
    const parts = boundary ? body.split(`--${boundary}`).slice(1).filter((p) => !p.startsWith('--')) : [];
    return { headers, type, parts: parts.map((p) => parseMime(p.replace(/^\r?\n/, ''), depth + 1)) };
  }
  const encoding = (headers['content-transfer-encoding'] || '').toLowerCase().trim();
  const data = encoding === 'base64' ? Buffer.from(body.replace(/\s+/g, ''), 'base64')
    : encoding === 'quoted-printable' ? Buffer.from(body.replace(/=\r?\n/g, '').replace(/=([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))), 'latin1')
      : Buffer.from(body, 'latin1');
  return { headers, type, data };
}
function emailFromEml(buf) {
  const root = parseMime(buf.toString('latin1'));
  const leaves = [], walk = (n) => (n.parts ? n.parts.forEach(walk) : leaves.push(n));
  walk(root);
  const textOf = (n) => { const cs = param(n.headers['content-type'], 'charset') || 'utf-8'; try { return new TextDecoder(cs).decode(n.data); } catch { return n.data.toString('utf8'); } };
  const attachments = [];
  let plain = '', html = '';
  for (const n of leaves) {
    const disp = n.headers['content-disposition'] || '';
    const name = param(disp, 'filename') || param(n.headers['content-type'], 'name');
    if (n.type === 'message/rfc822') { attachments.push({ name: `${name || 'attached-email'}.eml`.replace(/\.eml\.eml$/, '.eml'), data: n.data, inline: false }); continue; }
    if (name || /^attachment/i.test(disp)) attachments.push({ name: name || `attachment.${n.type.split('/')[1] || 'bin'}`, mime: n.type, data: n.data, inline: /^inline/i.test(disp) || !!n.headers['content-id'] });
    else if (n.type === 'text/plain' && !plain) plain = textOf(n);
    else if (n.type === 'text/html' && !html) html = htmlText(textOf(n));
  }
  const h = root.headers;
  return { subject: decodeWords(h.subject), from: decodeWords(h.from), date: h.date || '', body: plain || html, attachments };
}
function emailFromMsg(buf) {
  const MsgReader = require('@kenjiuno/msgreader').default;
  const reader = new MsgReader(buf), info = reader.getFileData();
  if (info.error) throw new Error(info.error);
  const attachments = (info.attachments || []).map((a) => {
    const got = reader.getAttachment(a);
    return { name: got.fileName || a.fileName || a.name || 'attachment', mime: a.attachMimeTag, data: Buffer.from(got.content), inline: !!(a.attachmentHidden || a.pidContentId) };
  });
  return { subject: info.subject || '', from: info.senderName || info.senderEmail || '', date: info.messageDeliveryTime || info.clientSubmitTime || '', body: info.body || htmlText(info.bodyHtml || ''), attachments };
}

// Opens a .zip folder or an email. Returns null for an ordinary file, or
// { from: 'zip' | 'email', files: [{ name, mime, data }], skipped: [names] }.
// An email with no attached documents becomes one text document of the email itself.
async function unpack(buf, mime = '', name = '') {
  if (!isContainer(mime, name, buf)) return null;
  const ext = extOf(name), files = [], skipped = [];
  const add = (n, data, given) => {
    const base = String(n).split('/').pop();
    if (!base || base.startsWith('.') || /^__MACOSX\//.test(n) || /^(thumbs\.db|desktop\.ini)$/i.test(base)) return;
    if (NOT_A_DOCUMENT.test(base)) { skipped.push(base); return; }
    files.push({ name: base, mime: mimeFor(base, given), data });
  };
  if (ext === 'zip' || /zip/.test(mime) || (!ext && isZip(buf))) {
    const entries = zipEntries(buf);
    if (!entries) throw new Error('This .zip file could not be opened. It may be damaged.');
    let total = 0;
    for (const e of entries) {
      if (files.length >= 20) { skipped.push(e.name.split('/').pop()); continue; }
      try {
        const data = e.read(15 * 1024 * 1024);
        total += data.length;
        if (total > 60 * 1024 * 1024) { skipped.push(e.name.split('/').pop()); continue; }
        add(e.name, data);
      } catch { skipped.push(e.name.split('/').pop()); }
    }
    if (!files.length && entries.length === 0) throw new Error('This .zip file is empty, or its files are password-protected.');
    return { from: 'zip', files, skipped };
  }
  const mail = ext === 'msg' || /ms-outlook/.test(mime) ? emailFromMsg(buf) : emailFromEml(buf);
  for (const a of mail.attachments) {
    // Small pictures shown inside the email body are logos and signatures, not evidence.
    if (a.inline && /^image\//.test(mimeFor(a.name, a.mime)) && a.data.length < 40 * 1024) { skipped.push(a.name); continue; }
    if (files.length < 20) add(a.name, a.data, a.mime); else skipped.push(a.name);
  }
  if (!files.length) {
    const text = [`Subject: ${mail.subject}`, `From: ${mail.from}`, mail.date && `Date: ${mail.date}`, '', mail.body].filter((x) => x !== false).join('\n');
    files.push({ name: `${(mail.subject || 'email').replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 80) || 'email'}.txt`, mime: 'text/plain', data: Buffer.from(text, 'utf8') });
  }
  return { from: 'email', files, skipped };
}

// ---------- Preview for the review screen ----------
// 'image' for anything that looks like a page (PDF, photo, scan), 'text' for documents made of text.
function previewKind(mime, name) {
  const ext = extOf(name); mime = String(mime || '').toLowerCase();
  if (ext === 'pdf' || /pdf|^image\//.test(mime) || ['heic', 'heif', 'tif', 'tiff', 'bmp', 'avif', 'pages'].includes(ext) || PHOTO_TYPES[ext]) return 'image';
  if (['docx', 'doc', 'rtf', 'odt', 'html', 'htm', 'txt', 'csv', 'md'].includes(ext) || /^text\/|wordprocessingml|msword|rtf|opendocument/.test(mime)) return 'text';
  return null;
}
// Pages one under another in a single JPEG, with a grey gap between them.
async function stack(pages) {
  if (pages.length < 2) return pages[0];
  const sharp = require('sharp'), gap = 16;
  const sizes = await Promise.all(pages.map((p) => sharp(p).metadata()));
  const width = Math.max(...sizes.map((s) => s.width));
  let top = 0;
  const layers = pages.map((input, i) => { const layer = { input, top, left: Math.round((width - sizes[i].width) / 2) }; top += sizes[i].height + gap; return layer; });
  return sharp({ create: { width, height: top - gap, channels: 3, background: '#d9dee3' } }).composite(layers).jpeg({ quality: 82 }).toBuffer();
}
// The first pages as one picture (up to three, so a scanned page 2 is seen too), or the text Aegis
// read, so a reviewer can compare it with the fields.
async function preview(buf, mime, name) {
  const doc = await read(buf, mime, name);
  if (doc.kind === 'pdf') { const pages = await pageImages(doc.pdf, MAX_PAGES); if (pages.length) return { type: 'image', data: await stack(pages), pages: pages.length }; }
  if (doc.kind === 'image' && doc.images?.length) {
    if (doc.images.length === 1) return { type: 'image', data: doc.images[0].data, mediaType: doc.images[0].mediaType, pages: 1 };
    return { type: 'image', data: await stack(doc.images.map((i) => i.data)), pages: doc.images.length };
  }
  if (doc.text) return { type: 'text', text: doc.text };
  return null;
}

module.exports = { read, unpack, pageImages, preview, previewKind, usable, htmlText, rtfText, odfText };
