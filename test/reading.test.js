'use strict';
// Reading evidence files without AI: dates, field rules and file types.
const test = require('node:test'), assert = require('node:assert'), os = require('os'), fs = require('fs'), path = require('path');
process.env.NODE_ENV = 'test';
process.env.AEGIS_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-reading-'));
const { normDate } = require('../server/lib/util');
const docread = require('../server/lib/docread');
const { heuristicExtract } = require('../server/evidence');

test('dates are read the way they are written, without moving a day', () => {
  const cases = {
    '12/31/2027': '2027-12-31', // US
    '31/12/2027': '2027-12-31', // day first: 31 cannot be a month
    '31.12.2027': '2027-12-31', '31-12-2027': '2027-12-31', '2027-12-31': '2027-12-31', '2027/12/31': '2027-12-31',
    'December 31, 2027': '2027-12-31', 'Dec 31 2027': '2027-12-31', '31 December 2027': '2027-12-31', '31-Dec-2027': '2027-12-31', '1st March 2026': '2026-03-01',
    '03/2027': '2027-03-31', '02/2028': '2028-02-29', 'March 2027': '2027-03-31', // month and year: end of the month
    '12/31/27': '2027-12-31', 46387: '2026-12-31', // two-digit year, spreadsheet serial
    '13/13/2027': null, '02/30/2027': null, '2027-02-30': null, '13/2027': null, nonsense: null, '': null,
  };
  for (const [input, want] of Object.entries(cases)) assert.equal(normDate(input), want, input);
});

test('field rules find the holder, not the training center, and the right dates', () => {
  const card = ['American Heart Association', 'BLS Provider', 'Training Center Name: City Hospital', 'Name: Priya Sharma',
    'Issue Date: 03/15/2025', 'Recommended Renewal Date: 03/2027', 'eCard Code: 2350ABCD1234', 'Date of Birth: 1990-05-02'].join('\n');
  const { fields: f } = heuristicExtract(card);
  assert.equal(f.holder_name, 'Priya Sharma');
  assert.equal(f.issued_on, '2025-03-15');
  assert.equal(f.expires_on, '2027-03-31');
  assert.equal(f.doc_number, '2350ABCD1234');
  assert.equal(f.doc_type, 'bls_card');

  const cert = 'Certificate of Completion\nThis certifies that PRIYA SHARMA has successfully completed\nBasic Life Support\nExpiration Date: 31 March 2027';
  const c = heuristicExtract(cert);
  assert.equal(c.fields.holder_name, 'PRIYA SHARMA'); assert.equal(c.confidence.holder_name, 0.8, 'a name from a sentence is never certain');
  assert.equal(c.fields.expires_on, '2027-03-31');

  const license = 'STATE OF CALIFORNIA\nBoard of Registered Nursing\nRegistered Nurse License\nLicensee: Maria Lopez\tLicense Number: RN 845221\nState: California\nExpires: 2027-06-30\nBirth Date: 1985-01-01';
  const l = heuristicExtract(license).fields;
  assert.equal(l.holder_name, 'Maria Lopez'); assert.equal(l.state, 'CA'); assert.equal(l.expires_on, '2027-06-30');
  assert.equal(l.issued_on, undefined, 'a birth date is not an issue date');
  assert.equal(l.doc_type, 'professional_license');

  // A table with labels in one column and values in the next, no colons (as PDFs from Word or a browser read).
  const table = heuristicExtract(['Professional License Record', 'Sarah Jenkins, RN', 'Document type\tProfessional license - Registered Nurse',
    'Name on document\tSarah Jenkins, RN', 'Document number\tRN-748291 (sample)', 'Issued\t15-01-2025', 'Expires\t31-12-2027',
    'State\tCA - California (sample)', 'Company\tExample Healthcare Staffing LLC (fictional)', 'Employee\tYes'].join('\n')).fields;
  assert.deepEqual(table, { holder_name: 'Sarah Jenkins, RN', doc_number: 'RN-748291', issued_on: '2025-01-15', expires_on: '2027-12-31', state: 'CA', entity_name: 'Example Healthcare Staffing LLC (fictional)', doc_type: 'professional_license' });

  const sameLine = heuristicExtract('Name: Jane Doe Issue Date: 01/05/2026 Expiration Date: 01/05/2028').fields;
  assert.equal(sameLine.holder_name, 'Jane Doe'); assert.equal(sameLine.issued_on, '2026-01-05'); assert.equal(sameLine.expires_on, '2028-01-05');
});

test('every document type is recognised by the words people title it with', () => {
  const titles = {
    'Professional license': 'professional_license', 'BLS card': 'bls_card', 'ACLS card': 'acls_card', 'TB screening': 'tb_screening',
    'Flu vaccination': 'flu_vaccine', 'Influenza vaccine record': 'flu_vaccine', 'Flu shot': 'flu_vaccine', 'Flu immunization': 'flu_vaccine',
    'Facility orientation': 'facility_orientation', 'Handbook acknowledgment': 'handbook_ack', 'Security training': 'security_training',
    'I-9 record': 'i9_record', 'Work authorization': 'work_authorization', 'Work Authorisation': 'work_authorization', 'Employment Authorization Document': 'work_authorization',
    'W-4': 'w4', 'Payroll filing receipt': 'payroll_filing_receipt',
  };
  for (const [title, want] of Object.entries(titles)) {
    const r = heuristicExtract(`SAMPLE DOCUMENT RECORD\n${title}\nName on document\tAva Thompson`);
    assert.equal(r.fields.doc_type, want, title); assert.equal(r.confidence.doc_type, 0.9, `${title}: only one type is named`);
  }
  assert.equal(heuristicExtract('Fluid balance chart').fields.doc_type, undefined, '"flu" must be a whole word');
});

test('uncertain readings are marked uncertain', () => {
  const ambiguous = heuristicExtract('ACLS Provider\nExpiration Date: 03/04/2027');
  assert.equal(ambiguous.fields.expires_on, '2027-03-04'); assert.ok(ambiguous.confidence.expires_on < 0.9);
  const twoTypes = heuristicExtract('Facility orientation checklist\nIncludes a BLS refresher');
  assert.equal(twoTypes.fields.doc_type, 'facility_orientation'); assert.ok(twoTypes.confidence.doc_type < 0.9);
});

test('file types: Word, web pages and unreadable files', async () => {
  const html = await docread.read(Buffer.from('<html><head><style>x{}</style></head><body><p>Name: Jane&nbsp;Doe</p><table><tr><td>Expires:</td><td>2027-01-01</td></tr></table></body></html>'), 'text/html', 'page.html');
  assert.equal(html.kind, 'html'); assert.match(html.text, /Name: Jane Doe/); assert.doesNotMatch(html.text, /<|style/);
  for (const [name, mime] of [['old.doc', 'application/msword'], ['photo.heic', 'image/heic'], ['x.zip', 'application/zip']]) {
    const r = await docread.read(Buffer.from('xx'), mime, name);
    assert.equal(r.kind, 'unsupported', name); assert.ok(r.note, name);
  }
  assert.equal((await docread.read(Buffer.from('not really a docx'), '', 'broken.docx')).kind, 'unsupported');
  const photo = await docread.read(Buffer.from([255, 216, 255]), 'application/octet-stream', 'card.JPG');
  assert.deepEqual([photo.kind, photo.images[0].mediaType], ['image', 'image/jpeg'], 'a picture the converter cannot open is sent as it is');
  assert.equal(docread.usable('ÿþ\u0001\u0002 ¤¤ ¤¤ ¤¤ ab'), '', 'font codes are not text');
});

test('real files saved from Word and from a browser are read the same way', async () => {
  const want = { holder_name: 'Sarah Jenkins, RN', doc_number: 'RN-748291', issued_on: '2025-01-15', expires_on: '2027-12-31', state: 'CA', doc_type: 'professional_license' };
  for (const name of ['license-table.docx', 'license-table-browser.pdf', 'license-table-word.pdf']) {
    const doc = await docread.read(fs.readFileSync(path.join(__dirname, 'fixtures', name)), '', name);
    assert.ok(doc.text.length > 200, name);
    const { fields } = heuristicExtract(doc.text);
    for (const [k, v] of Object.entries(want)) assert.equal(fields[k], v, `${name}: ${k}`);
  }
  const pages = await docread.pageImages(fs.readFileSync(path.join(__dirname, 'fixtures', 'license-table-browser.pdf')), 1);
  assert.equal(pages.length, 1); assert.equal(pages[0].subarray(0, 2).toString('hex'), 'ffd8', 'a page drawn as a JPEG');
});

// ---- Every file type people send ----
const zlib = require('zlib');
const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name));
const SARAH = { holder_name: 'Sarah Jenkins, RN', doc_number: 'RN-748291', issued_on: '2025-01-15', expires_on: '2027-12-31', state: 'CA', doc_type: 'professional_license' };
function zipOf(files) { // [{ name, data, flags }] -> a .zip
  const locals = [], centrals = []; let offset = 0;
  for (const { name, data, flags = 0x800 } of files) {
    const nb = Buffer.from(name), comp = zlib.deflateRawSync(data), crc = zlib.crc32(data);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(flags, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nb.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(flags, 8); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nb.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, nb, comp); centrals.push(ch, nb); offset += 30 + nb.length + comp.length;
  }
  const cd = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
const assertSarah = (text, label) => { const { fields } = heuristicExtract(text); for (const [k, v] of Object.entries(SARAH)) assert.equal(fields[k], v, `${label}: ${k}`); };

test('old Word .doc, RTF and OpenDocument files are read like .docx', async () => {
  for (const name of ['license-table.doc', 'license-table.rtf', 'license-table.odt']) {
    const doc = await docread.read(fixture(name), '', name);
    assert.equal(doc.kind, 'word', name);
    assertSarah(doc.text, name);
  }
  assert.equal(docread.rtfText("{\\rtf1{\\fonttbl{\\f0 Arial;}}\\pard Name:\\tab Ana \\'e9\\u8211?x\\par}"), 'Name:\tAna é–x');
});

test('photos and scans become upright pictures: sideways phone photos, TIFF faxes', async () => {
  const sharp = require('sharp');
  const [page] = await docread.pageImages(fixture('license-table-browser.pdf'), 1);
  const sideways = await sharp(page).rotate(90).withMetadata({ orientation: 8 }).jpeg().toBuffer();
  const fax = await sharp(page).greyscale().tiff().toBuffer();
  for (const [name, buf] of [['phone.jpg', sideways], ['fax.tiff', fax], ['shot.png', await sharp(page).png().toBuffer()], ['web.webp', await sharp(page).webp().toBuffer()]]) {
    const doc = await docread.read(buf, '', name);
    assert.equal(doc.kind, 'image', name);
    const meta = await sharp(doc.images[0].data).metadata();
    assert.equal(meta.format, 'jpeg', name);
    assert.ok(meta.height > meta.width, `${name} is upright`);
    assert.ok(Math.max(meta.width, meta.height) <= 2000, `${name} is small enough for every AI`);
  }
  const broken = await docread.read(Buffer.from('not a picture'), 'image/heic', 'photo.HEIC');
  assert.equal(broken.kind, 'unsupported'); assert.match(broken.note, /could not be opened/);
});

test('Apple Pages files are read from the preview inside them', async () => {
  const withPdf = await docread.read(zipOf([{ name: 'Index/Document.iwa', data: Buffer.from('x') }, { name: 'QuickLook/Preview.pdf', data: fixture('license-table-browser.pdf') }]), '', 'license.pages');
  assert.equal(withPdf.kind, 'pdf'); assert.match(withPdf.note, /preview/); assertSarah(withPdf.text, 'pages');
  const [page] = await docread.pageImages(fixture('license-table-browser.pdf'), 1);
  assert.equal((await docread.read(zipOf([{ name: 'preview.jpg', data: page }]), '', 'new.pages')).kind, 'image');
  assert.equal((await docread.read(zipOf([{ name: 'Index/Document.iwa', data: Buffer.from('x') }]), '', 'bare.pages')).kind, 'unsupported');
});

test('a zip folder is opened into its documents, leaving out clutter, locked and oversized files', async () => {
  const box = await docread.unpack(zipOf([
    { name: 'license/sarah.pdf', data: fixture('license-table-browser.pdf') }, { name: 'sarah.docx', data: fixture('license-table.docx') },
    { name: '__MACOSX/license/._sarah.pdf', data: Buffer.from('mac') }, { name: 'Thumbs.db', data: Buffer.from('win') },
    { name: 'locked.pdf', data: Buffer.from('secret'), flags: 0x801 }, { name: 'signature.p7s', data: Buffer.from('sig') },
  ]), 'application/zip', 'docs.zip');
  assert.equal(box.from, 'zip');
  assert.deepEqual(box.files.map((f) => [f.name, f.mime]), [['sarah.pdf', 'application/pdf'], ['sarah.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']]);
  assert.deepEqual(box.skipped, ['signature.p7s']);
  assert.equal(await docread.unpack(fixture('license-table.docx'), '', 'license-table.docx'), null, 'a .docx is a zip inside, but it is one document');
  await assert.rejects(docread.unpack(Buffer.from('PK\u0003\u0004 broken'), '', 'broken.zip'), /could not be opened/);
  const bomb = zipOf([{ name: 'huge.txt', data: Buffer.alloc(20 * 1024 * 1024, 32) }]);
  assert.deepEqual((await docread.unpack(bomb, '', 'bomb.zip')).files, [], 'a file that unpacks past the limit is left out');
});

test('emails: attachments are the documents; logos and invites are left out; a plain email is its own text', async () => {
  const pdf = fixture('license-table-browser.pdf');
  const eml = ['From: Sarah <s@example.test>', `Subject: =?UTF-8?B?${Buffer.from('My RN license – Sarah').toString('base64')}?=`, 'Content-Type: multipart/mixed; boundary="b1"', '',
    '--b1', 'Content-Type: multipart/related; boundary="b2"', '', '--b2', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: quoted-printable', '', 'Attached =E2=80=93 Sarah', '',
    '--b2', 'Content-Type: image/png', 'Content-ID: <logo>', 'Content-Disposition: inline; filename="logo.png"', 'Content-Transfer-Encoding: base64', '', Buffer.alloc(900, 1).toString('base64'), '--b2--',
    '--b1', 'Content-Type: application/pdf; name="Sarah License.pdf"', "Content-Disposition: attachment; filename*=UTF-8''Sarah%20License.pdf", 'Content-Transfer-Encoding: base64', '', pdf.toString('base64').replace(/.{76}/g, '$&\r\n'),
    '--b1', 'Content-Type: text/calendar', 'Content-Disposition: attachment; filename="invite.ics"', '', 'BEGIN:VCALENDAR', '--b1--', ''].join('\r\n');
  const box = await docread.unpack(Buffer.from(eml, 'latin1'), 'message/rfc822', 'license.eml');
  assert.deepEqual(box.files.map((f) => f.name), ['Sarah License.pdf']);
  assert.ok(box.files[0].data.equals(pdf), 'the attachment arrives byte for byte');
  assert.deepEqual(box.skipped.sort(), ['invite.ics', 'logo.png']);

  const plain = await docread.unpack(Buffer.from('Subject: Details for Sarah\r\nContent-Type: text/plain\r\n\r\nName: Sarah Jenkins, RN\r\nLicense Number: RN-748291\r\n'), '', 'note.eml');
  assert.equal(plain.files[0].name, 'Details for Sarah.txt');
  assert.equal(heuristicExtract((await docread.read(plain.files[0].data, 'text/plain', plain.files[0].name)).text).fields.holder_name, 'Sarah Jenkins, RN');

  const msg = await docread.unpack(fixture('license-email.msg'), '', 'license-email.msg');
  assert.deepEqual(msg.files.map((f) => f.name), ['Sarah_Jenkins_RN_License.pdf']);
  assertSarah((await docread.read(msg.files[0].data, msg.files[0].mime, msg.files[0].name)).text, 'msg attachment');
});

test('the review screen preview: the first page as a picture, or the text that was read', async () => {
  assert.equal(docread.previewKind('application/pdf', 'a.pdf'), 'image');
  assert.equal(docread.previewKind('', 'scan.TIFF'), 'image');
  assert.equal(docread.previewKind('', 'letter.rtf'), 'text');
  assert.equal(docread.previewKind('application/zip', 'x.zip'), null);
  const page = await docread.preview(fixture('license-table-word.pdf'), 'application/pdf', 'l.pdf');
  assert.equal(page.type, 'image'); assert.equal(page.data.subarray(0, 2).toString('hex'), 'ffd8');
  const text = await docread.preview(fixture('license-table.odt'), '', 'l.odt');
  assert.equal(text.type, 'text'); assert.match(text.text, /Name on document\tSarah Jenkins, RN/);
});

test('names: the same person, a possible match for a person to check, or a different person', () => {
  const { nameMatch } = require('../server/lib/util');
  const cases = {
    same: ['Alex Patel', 'ALEX PATEL', 'Alex J. Patel', 'Patel, Alex', 'Patel, Alex J.', 'Alex Patel, RN', 'Dr. Alex Patel', 'Alëx Patel'],
    possible: ['Alex', 'Patel', 'A. Patel', 'Alexander Patel', 'Al Patel', 'Alex Patel-Shah', 'Patel Alex'],
    different: ['Jordan Patel', 'Alex Smith', 'Jordan Example', ''],
  };
  for (const [want, names] of Object.entries(cases)) for (const n of names) assert.equal(nameMatch(n, 'Alex Patel'), want, JSON.stringify(n));
  assert.equal(nameMatch('Robert Lee', 'Bob Lee'), 'possible', 'a common short form');
  assert.equal(nameMatch('Jenkins, Sarah', 'Sarah Jenkins, RN'), 'same', 'surname first, credential on the record');
  assert.equal(nameMatch('Jordan Example', 'Alex Example'), 'different', 'same surname, different first name');
  assert.equal(nameMatch('Alex', 'ALEX'), 'same', 'one name read the same way twice');
});
