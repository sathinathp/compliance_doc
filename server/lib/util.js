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
const daysBetween = (a, b) => Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 864e5);
function sameName(a, b) {
  const parts = (name) => String(name || '').normalize('NFD').toLowerCase().replace(/,.*$/, '').replace(/\p{M}/gu, '').replace(/[^\p{L}\s]/gu, '').trim().split(/\s+/).filter(Boolean);
  const x = parts(a), y = parts(b);
  return x.length > 0 && y.length > 0 && x[0] === y[0] && x.at(-1) === y.at(-1);
}
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
function normDate(v) {
  if (v === undefined || v === null || v === '') return null;
  const s = String(v).trim();
  if (/^\d{5}(\.\d+)?$/.test(s)) return new Date(Date.UTC(1899, 11, 30) + +s * 864e5).toISOString().slice(0, 10);
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  const d = new Date(s);
  return isNaN(d) ? null : d.toISOString().slice(0, 10);
}
const csvCell = (v) => {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // stops spreadsheet formula injection
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
module.exports = { clock, id, shortId, sha256, token, addDays, daysBetween, sameName, j, hashPassword, checkPassword, setSecret, encrypt, decrypt, parseCsv, parseXlsx, normDate, csvCell };
