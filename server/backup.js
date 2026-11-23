'use strict';
// Backups from the command line. Uses the same settings as the server (.env, AEGIS_DATA, the key).
//
//   npm run backup                          writes a backup to data/backups (or AEGIS_BACKUP_DIR)
//   npm run backup -- --dir D:\aegis-backups --keep 30
//   npm run restore -- <backup folder>      restores into an empty database (stop the server first)
//   npm run restore -- <backup folder> --replace     deletes what is in the database first
//
// The server also makes one backup a day by itself (set AEGIS_BACKUPS=off to stop that).
const fs = require('fs'), path = require('path');
const args = process.argv.slice(2), cmd = args[0];
const has = (flag) => args.includes(flag);
const opt = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
if (!['backup', 'restore'].includes(cmd)) {
  console.error('Use: node server/backup.js backup [--dir <folder>] [--keep <n>]\n     node server/backup.js restore <backup folder> [--replace]');
  process.exit(2);
}
if (process.env.NODE_ENV !== 'test') {
  try { const env = path.join(__dirname, '..', '.env'); if (process.loadEnvFile && fs.existsSync(env)) process.loadEnvFile(env); } catch { /* settings may come from the environment */ }
}
const DATA = process.env.AEGIS_DATA = process.env.AEGIS_DATA || path.join(__dirname, '..', 'data');
const secretFile = path.join(DATA, '.secret');
const secret = process.env.AEGIS_SECRET || (fs.existsSync(secretFile) ? fs.readFileSync(secretFile, 'utf8') : null);
if (!secret) { console.error('No encryption key found. Set AEGIS_SECRET or restore data/.secret first.'); process.exit(1); }
fs.mkdirSync(DATA, { recursive: true });
const db = require('./lib/db'), B = require('./lib/backup');
const version = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version;

(async () => {
  db.open(path.join(DATA, 'aegis.db'));
  if (cmd === 'backup') {
    const dir = path.resolve(opt('--dir') || process.env.AEGIS_BACKUP_DIR || path.join(DATA, 'backups'));
    fs.mkdirSync(dir, { recursive: true });
    const keep = Math.max(1, Number(opt('--keep') || process.env.AEGIS_BACKUP_KEEP || 14));
    const r = B.backup({ dir, secret, keep, version });
    const rows = Object.values(r.tables).reduce((a, b) => a + b, 0);
    console.log(`[backup] Saved ${rows} rows from ${Object.keys(r.tables).length} tables and ${r.documents} documents to ${r.folder}`);
    if (!has('--auto')) console.log('[backup] The encryption key is not in the backup. Keep AEGIS_SECRET (or data/.secret) somewhere separate and safe; without it the documents cannot be read. Copy the backup folder off this computer too.');
  } else {
    const folder = args.find((a, i) => i > 0 && !a.startsWith('--'));
    if (!folder) throw new Error('Give the backup folder to restore, for example: npm run restore -- data/backups/aegis-backup-2026-11-23T02-00-00Z');
    // A restore replaces what the server is working with, so the server must not be running.
    if (!db.lockServer()) throw new Error('An Aegis server is running on this database. Stop it before restoring.');
    const r = await B.restore({ folder: path.resolve(folder), secret, replace: has('--replace'), ignoreKey: has('--ignore-key') });
    const rows = Object.values(r.tables).reduce((a, b) => a + b, 0);
    console.log(`[restore] Restored ${rows} rows from ${Object.keys(r.tables).length} tables and ${r.documents} documents, from the backup made ${r.manifest.created_at}. Everyone signs in again.`);
  }
  db.close();
  process.exit(0);
})().catch((e) => { console.error(`[${cmd}] ${e.message}`); try { db.close(); } catch { /* already closed */ } process.exit(1); });
