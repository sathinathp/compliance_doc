'use strict';
// Backups: every table of the database plus the stored documents, in one dated folder.
//
//   <backups>/aegis-backup-2026-11-23T02-00-00Z/
//     manifest.json      what is inside, row counts, and a fingerprint of the encryption key
//     tables/<name>.jsonl one row per line
//     documents/         the stored documents, still encrypted
//
// The encryption key (AEGIS_SECRET, or data/.secret) is NOT in the backup, on purpose: whoever
// holds a backup and the key can read every document. Keep the key somewhere separate and safe.
// Without the same key, restored documents and connector keys cannot be read.
//
// Works for SQLite and PostgreSQL, and can restore from one into the other.
const fs = require('fs'), path = require('path'), crypto = require('crypto'), readline = require('readline');
const db = require('./db');

const FORMAT = 1;
const PAGE = 2000;
const SKIP = new Set(['sessions']); // sign-ins are not restored; everyone signs in again
const docsDir = () => path.join(process.env.AEGIS_DATA, 'documents');
const keyFingerprint = (secret) => crypto.createHash('sha256').update(`aegis-key-fingerprint:${secret}`).digest('hex').slice(0, 16);
const stamp = (d = new Date()) => d.toISOString().replace(/\.\d+Z$/, 'Z').replace(/:/g, '-');

function tables() {
  return db.mode() === 'pg'
    ? db.all("SELECT table_name AS name FROM information_schema.tables WHERE table_schema=current_schema() AND table_type='BASE TABLE' ORDER BY table_name").map((r) => r.name)
    : db.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map((r) => r.name);
}
// Parents before children, so foreign keys are satisfied while restoring.
function restoreOrder(names) {
  const parents = new Map(names.map((n) => [n, new Set()]));
  if (db.mode() === 'pg') {
    for (const r of db.all(`SELECT tc.table_name AS child, ccu.table_name AS parent FROM information_schema.table_constraints tc
      JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name=ccu.constraint_name AND tc.table_schema=ccu.table_schema
      WHERE tc.constraint_type='FOREIGN KEY' AND tc.table_schema=current_schema()`)) if (r.child !== r.parent) parents.get(r.child)?.add(r.parent);
  } else {
    for (const n of names) for (const fk of db.all(`PRAGMA foreign_key_list("${n}")`)) if (fk.table !== n) parents.get(n)?.add(fk.table);
  }
  const out = [], seen = new Set();
  const visit = (n, stack = new Set()) => {
    if (seen.has(n) || stack.has(n)) return;
    stack.add(n);
    for (const p of parents.get(n) || []) if (parents.has(p)) visit(p, stack);
    seen.add(n); out.push(n);
  };
  for (const n of names) visit(n);
  return out;
}
function copyTree(from, to) {
  if (!fs.existsSync(from)) return 0;
  let n = 0;
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, e.name), b = path.join(to, e.name);
    if (e.isDirectory()) { fs.mkdirSync(b, { recursive: true }); n += copyTree(a, b); } else { fs.mkdirSync(to, { recursive: true }); fs.copyFileSync(a, b); n++; }
  }
  return n;
}

// Writes a backup and returns its folder. Reads one consistent snapshot of the database.
function backup({ dir, secret, keep = 14, version = '' }) {
  const out = path.join(dir, `aegis-backup-${stamp()}`);
  const tmp = `${out}.partial`;
  fs.mkdirSync(path.join(tmp, 'tables'), { recursive: true });
  const counts = {};
  db.exec(db.mode() === 'pg' ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN');
  try {
    for (const name of tables()) {
      if (SKIP.has(name)) continue;
      const fd = fs.openSync(path.join(tmp, 'tables', `${name}.jsonl`), 'w');
      let n = 0;
      for (let offset = 0; ; offset += PAGE) {
        const rows = db.all(`SELECT * FROM "${name}" ORDER BY ${db.mode() === 'pg' ? 'ctid' : 'rowid'} LIMIT ${PAGE} OFFSET ${offset}`);
        for (const r of rows) fs.writeSync(fd, `${JSON.stringify(r)}\n`);
        n += rows.length;
        if (rows.length < PAGE) break;
      }
      fs.closeSync(fd);
      counts[name] = n;
    }
  } finally { db.exec('COMMIT'); }
  const documents = copyTree(docsDir(), path.join(tmp, 'documents'));
  fs.writeFileSync(path.join(tmp, 'manifest.json'), JSON.stringify({
    format: FORMAT, created_at: new Date().toISOString(), app_version: version, database: db.mode(),
    key_fingerprint: keyFingerprint(secret), documents, documents_root: docsDir(), tables: counts,
  }, null, 2));
  fs.renameSync(tmp, out); // only a finished backup gets its final name
  prune(dir, keep);
  return { folder: out, tables: counts, documents };
}
// Keeps the newest `keep` backups in the folder and removes older ones (and unfinished ones).
function prune(dir, keep) {
  const all = fs.readdirSync(dir).filter((n) => /^aegis-backup-.+Z(\.partial)?$/.test(n)).sort();
  for (const n of all.filter((x) => x.endsWith('.partial'))) fs.rmSync(path.join(dir, n), { recursive: true, force: true });
  const done = all.filter((x) => !x.endsWith('.partial'));
  for (const n of done.slice(0, Math.max(0, done.length - keep))) fs.rmSync(path.join(dir, n), { recursive: true, force: true });
}
function readManifest(folder) {
  const file = path.join(folder, 'manifest.json');
  if (!fs.existsSync(file)) throw new Error(`No backup found at ${folder} (manifest.json is missing).`);
  const m = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (m.format !== FORMAT) throw new Error(`This backup uses format ${m.format}; this version of Aegis reads format ${FORMAT}.`);
  return m;
}
// Restores a backup into this database. The database must be empty unless replace is true.
async function restore({ folder, secret, replace = false, ignoreKey = false }) {
  const m = readManifest(folder);
  if (m.key_fingerprint !== keyFingerprint(secret) && !ignoreKey) {
    throw new Error('This backup was made with a different encryption key. Set AEGIS_SECRET (or data/.secret) to the key used when the backup was made, or documents and saved keys cannot be read.');
  }
  const hasData = tables().includes('tenants') && db.get('SELECT 1 AS x FROM tenants LIMIT 1');
  if (hasData && !replace) throw new Error('This database already has data. Restore into an empty database, or add --replace to delete what is there first.');
  if (hasData) db.resetAll();
  const present = new Set(tables());
  const order = restoreOrder([...present].filter((n) => Object.hasOwn(m.tables, n)));
  const oldRoot = m.documents_root, newRoot = docsDir();
  const restored = {};
  for (const name of order) {
    const file = path.join(folder, 'tables', `${name}.jsonl`);
    if (!fs.existsSync(file)) continue;
    const columns = new Set((db.mode() === 'pg'
      ? db.all('SELECT column_name AS name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=?', name)
      : db.all(`PRAGMA table_info("${name}")`)).map((c) => c.name));
    if (name === 'chat_messages' && db.mode() === 'sqlite') columns.add('rowid');
    let batch = [], n = 0;
    const flush = () => { if (!batch.length) return; const rows = batch; batch = []; db.tx(() => { for (const r of rows) db.insert(name, r); }); };
    for await (const line of readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity })) {
      if (!line.trim()) continue;
      const row = JSON.parse(line);
      // Only columns this database has; documents move to this server's documents folder.
      const r = Object.fromEntries(Object.entries(row).filter(([k]) => columns.has(k)));
      if (name === 'evidence' && r.stored_path && oldRoot && path.resolve(r.stored_path).startsWith(path.resolve(oldRoot))) {
        r.stored_path = path.join(newRoot, path.relative(oldRoot, r.stored_path));
      }
      batch.push(r); n++;
      if (batch.length >= 500) flush();
    }
    flush();
    restored[name] = n;
  }
  // PostgreSQL counters (SERIAL columns) continue after the restored rows.
  if (db.mode() === 'pg') {
    for (const c of db.all("SELECT table_name AS t, column_name AS c FROM information_schema.columns WHERE table_schema=current_schema() AND column_default LIKE 'nextval(%'")) {
      db.get(`SELECT setval(pg_get_serial_sequence('"${c.t}"', '${c.c}'), GREATEST(COALESCE((SELECT MAX("${c.c}") FROM "${c.t}"), 0), 1)) AS v`);
    }
  }
  const documents = copyTree(path.join(folder, 'documents'), newRoot);
  return { tables: restored, documents, manifest: m };
}

module.exports = { backup, restore, prune, readManifest, keyFingerprint, stamp };
