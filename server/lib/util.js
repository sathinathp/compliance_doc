'use strict';
const crypto = require('crypto'), zlib = require('zlib');

let offsetMs = 0;
const clock = {
  now: () => new Date(Date.now() + offsetMs),
  iso: () => clock.now().toISOString(),
  today: () => clock.iso().slice(0, 10),
  advanceDays: (d) => { offsetMs += d * 864e5; },
  reset: () => { offsetMs = 0; },
};
const id = (p) => `${p}_${crypto.randomBytes(6).toString('hex')}`;
const shortId = (p) => `${p}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
const sha256 = (x) => crypto.createHash('sha256').update(x).digest('hex');
const token = () => crypto.randomBytes(32).toString('base64url');
const addDays = (d, n) => new Date(new Date(d + 'T00:00:00Z').getTime() + n * 864e5).toISOString().slice(0, 10);
// US states and territories by name, and the two-letter code for a name or code ("Texas", "tx").
const US_STATES = { alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO', connecticut: 'CT', delaware: 'DE', 'district of columbia': 'DC', florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT', virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY', 'puerto rico': 'PR' };
const STATE_CODES = new Set(Object.values(US_STATES));
const stateCode = (v) => { const s = String(v || '').trim(); return STATE_CODES.has(s.toUpperCase()) && s.length === 2 ? s.toUpperCase() : US_STATES[s.toLowerCase()] || null; };
// A place name as people mean it: "  St. Jude   Medical " and "st. jude medical" are one place.
const placeKey = (v) => String(v || '').trim().replace(/\s+/g, ' ').toLowerCase();
// "1 day", "3 days": a count with its noun, never "day(s)".
const count = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const daysBetween = (a, b) => Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 864e5);
// ---- Comparing the name on a document with the name on the worker record ----
// Credentials and suffixes after a name ("Sarah Jenkins, RN") and titles before it ("Dr.") are not part of it.
const NAME_EXTRAS = new Set(['rn', 'lpn', 'lvn', 'np', 'aprn', 'crna', 'cna', 'cma', 'md', 'do', 'pa', 'pac', 'pt', 'dpt', 'ot', 'otr', 'rrt', 'bsn', 'msn', 'dnp', 'phd', 'pharmd', 'rph', 'emt', 'fnp', 'fnpc', 'ccrn', 'mph', 'mba', 'jr', 'sr', 'ii', 'iii', 'iv', 'esq']);
const TITLES = new Set(['mr', 'mrs', 'ms', 'miss', 'mx', 'dr', 'prof']);
// Common short forms of first names. Both directions count.
const NICKNAMES = [['al', 'alex', 'alexander', 'alexandra', 'alexis'], ['bob', 'rob', 'robbie', 'bobby', 'robert'], ['bill', 'will', 'billy', 'william', 'liam'], ['liz', 'beth', 'betty', 'eliza', 'elizabeth'], ['kate', 'katie', 'kathy', 'cathy', 'katherine', 'catherine', 'kathryn'], ['mike', 'mick', 'michael'], ['jim', 'jimmy', 'jamie', 'james'], ['tom', 'tommy', 'thomas'], ['dave', 'david'], ['chris', 'christopher', 'christine', 'christina'], ['jen', 'jenny', 'jennifer'], ['sam', 'samuel', 'samantha'], ['dan', 'danny', 'daniel'], ['joe', 'joey', 'joseph'], ['tony', 'anthony'], ['nick', 'nicholas'], ['matt', 'matthew'], ['ben', 'benjamin'], ['andy', 'drew', 'andrew'], ['steve', 'steven', 'stephen'], ['rick', 'rich', 'richard', 'dick'], ['ed', 'eddie', 'edward'], ['pat', 'patrick', 'patricia', 'trish'], ['sue', 'susan', 'suzanne'], ['meg', 'maggie', 'margaret', 'peggy'], ['vicky', 'victoria'], ['abby', 'abigail'], ['greg', 'gregory'], ['ken', 'kenneth'], ['jon', 'john', 'johnny', 'jonathan'], ['raj', 'rajesh'], ['ravi', 'ravindra']];
const NICK = new Map();
for (const group of NICKNAMES) for (const n of group) NICK.set(n, new Set([...(NICK.get(n) || []), ...group]));
// The words of a name, first name first. "Patel, Alex" is read as Alex Patel; "Alex Patel, RN" as Alex Patel.
function nameWords(raw) {
  const plain = String(raw || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  const words = (s) => s.replace(/[^\p{L}\s'-]/gu, ' ').split(/\s+/).map((w) => w.replace(/^['-]+|['-]+$/g, '')).filter(Boolean);
  const pieces = plain.split(',').map(words).filter((p) => p.length);
  const extra = (p) => p.every((w) => NAME_EXTRAS.has(w.replace(/-/g, '')));
  let out = pieces[0] || [];
  const after = pieces.slice(1).filter((p) => !extra(p));
  if (after.length && out.length) out = [...after.flat(), ...out]; // "Last, First Middle"
  while (out.length > 1 && TITLES.has(out[0])) out.shift();
  while (out.length > 1 && NAME_EXTRAS.has(out.at(-1).replace(/-/g, ''))) out.pop();
  return out;
}
const firstNamesFit = (p, q) => p === q || (p.length === 1 && q.startsWith(p)) || (q.length === 1 && p.startsWith(q))
  || (Math.min(p.length, q.length) >= 3 && (p.startsWith(q) || q.startsWith(p))) || !!NICK.get(p)?.has(q);
const lastNamesFit = (p, q) => p === q || p.split('-').includes(q) || q.split('-').includes(p);
// 'same'      first and last name agree (middle names, credentials, capitals and accents aside)
// 'possible'  only part of it fits: one name only, an initial, a short form (Alex / Alexander, Bob / Robert),
//             a double surname, or the names in reverse order. A person checks it.
// 'different' the names conflict (Jordan Example is not Alex Example). The document is not this worker's.
function nameMatch(onDocument, onRecord) {
  const x = nameWords(onDocument), y = nameWords(onRecord);
  if (!x.length || !y.length) return 'different';
  if (x.join(' ') === y.join(' ')) return 'same'; // also a one-word name read the same way twice
  if (x.length > 1 && y.length > 1 && x[0] === y[0] && x.at(-1) === y.at(-1)) return 'same';
  if (x.length === 1 || y.length === 1) {
    const [lone, full] = x.length === 1 ? [x[0], y] : [y[0], x];
    return lone === full.at(-1) || firstNamesFit(lone, full[0]) ? 'possible' : 'different';
  }
  if (x[0] === y.at(-1) && x.at(-1) === y[0]) return 'possible';
  return lastNamesFit(x.at(-1), y.at(-1)) && firstNamesFit(x[0], y[0]) ? 'possible' : 'different';
}
const sameName = (a, b) => nameMatch(a, b) === 'same';
const j = (s, d = null) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(pw, salt, 32).toString('hex')}`;
}
function checkPassword(pw, stored) {
  const [salt, h] = String(stored).split(':');
  if (!salt || !h) return false;
  return crypto.timingSafeEqual(Buffer.from(h, 'hex'), crypto.scryptSync(pw, salt, 32));
}

let key;
const setSecret = (s) => { key = crypto.createHash('sha256').update(s).digest(); };
function encrypt(buf) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const out = Buffer.concat([c.update(buf), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), out]);
}
function decrypt(buf) {
  const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]);
}

function parseCsv(text) {
  const rows = []; let row = [], cur = '', q = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (c !== '\r') cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => r.some((v) => v.trim()));
}

function readZip(buf) {
  let i = buf.length - 22;
  while (i >= 0 && buf.readUInt32LE(i) !== 0x06054b50) i--;
  if (i < 0) throw new Error('Not a valid .xlsx file');
  const n = buf.readUInt16LE(i + 10), files = {};
  let p = buf.readUInt32LE(i + 16);
  for (let k = 0; k < n; k++) {
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), nl = buf.readUInt16LE(p + 28),
      xl = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nl);
    const start = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
    const data = buf.subarray(start, start + csize);
    files[name] = method === 0 ? data : zlib.inflateRawSync(data, { maxOutputLength: 64 * 1024 * 1024 });
    p += 46 + nl + xl + cl;
  }
  return files;
}
const xmlText = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
function parseXlsx(buf) {
  const f = readZip(buf), shared = [];
  const ss = f['xl/sharedStrings.xml']?.toString('utf8') || '';
  for (const m of ss.matchAll(/<si>([\s\S]*?)<\/si>/g))
    shared.push([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => xmlText(t[1])).join(''));
  const sheet = f['xl/worksheets/sheet1.xml']?.toString('utf8');
  if (!sheet) throw new Error('The workbook has no first sheet');
  const rows = [];
  for (const r of sheet.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const row = [];
    for (const c of r[1].matchAll(/<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const col = /r="([A-Z]+)\d+"/.exec(c[1])?.[1] || 'A';
      const idx = [...col].reduce((a, ch) => a * 26 + ch.charCodeAt(0) - 64, 0) - 1;
      const t = /t="(\w+)"/.exec(c[1])?.[1], body = c[2] || '';
      const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1], inl = /<t[^>]*>([\s\S]*?)<\/t>/.exec(body)?.[1];
      row[idx] = t === 's' ? shared[+v] : t === 'inlineStr' ? xmlText(inl || '') : xmlText(v || '');
    }
    rows.push(Array.from(row, (x) => x ?? ''));
  }
  return rows.filter((r) => r.some((v) => String(v).trim()));
}
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const monthOf = (word) => MONTHS.indexOf(String(word).slice(0, 3).toLowerCase()) + 1;
// A calendar date as YYYY-MM-DD, or null when the parts do not make a real date.
function ymd(y, mo, d) {
  y = +y; mo = +mo; d = +d;
  if (y < 100) y += 2000;
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d ? t.toISOString().slice(0, 10) : null;
}
// Reads the date formats found on US and Indian documents and in spreadsheets.
// 3/4/2027 is read month first (US). It is read day first only when the first number cannot be a month (31/12/2027).
// A month and year with no day (12/2027, December 2027) means the end of that month, as on renewal cards.
// Never goes through the local time zone, so a date cannot move a day.
function normDate(v) {
  if (v === undefined || v === null || v === '') return null;
  const s = String(v).trim().replace(/\s+/g, ' ');
  if (/^\d{5}(\.\d+)?$/.test(s)) return new Date(Date.UTC(1899, 11, 30) + +s * 864e5).toISOString().slice(0, 10);
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:$|[T ])/.exec(s);
  if (m) return ymd(m[1], m[2], m[3]);
  m = /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4}|\d{2})$/.exec(s);
  if (m) return +m[1] > 12 ? ymd(m[3], m[2], m[1]) : ymd(m[3], m[1], m[2]);
  m = /^(\d{1,2})[/.\-](\d{4})$/.exec(s);
  if (m) return +m[1] >= 1 && +m[1] <= 12 ? new Date(Date.UTC(+m[2], +m[1], 0)).toISOString().slice(0, 10) : null;
  m = /^([A-Za-z]{3,9})\.? (\d{1,2})(?:st|nd|rd|th)?,? (\d{4})$/.exec(s); // December 31, 2027
  if (m && monthOf(m[1])) return ymd(m[3], monthOf(m[1]), m[2]);
  m = /^(\d{1,2})(?:st|nd|rd|th)?[ \-]([A-Za-z]{3,9})\.?,?[ \-](\d{4})$/.exec(s); // 31 December 2027, 31-Dec-2027
  if (m && monthOf(m[2])) return ymd(m[3], monthOf(m[2]), m[1]);
  m = /^([A-Za-z]{3,9})\.?,? (\d{4})$/.exec(s); // December 2027
  if (m && monthOf(m[1])) return new Date(Date.UTC(+m[2], monthOf(m[1]), 0)).toISOString().slice(0, 10);
  const d = new Date(s);
  return isNaN(d) ? null : ymd(d.getFullYear(), d.getMonth() + 1, d.getDate());
}
const csvCell = (v) => {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // stops spreadsheet formula injection
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
module.exports = { clock, id, shortId, sha256, token, addDays, daysBetween, count, US_STATES, stateCode, placeKey, sameName, nameMatch, j, hashPassword, checkPassword, setSecret, encrypt, decrypt, parseCsv, parseXlsx, normDate, csvCell };
