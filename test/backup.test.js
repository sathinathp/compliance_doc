'use strict';
// Backup and restore, run as the real commands in separate processes: every row and document
// comes back, documents still decrypt, the audit chain still verifies, and a restore refuses the
// wrong key, a running server and an existing database (unless asked to replace it).
const test = require('node:test'), assert = require('node:assert'), fs = require('fs'), os = require('os'), path = require('path');
const { spawnSync } = require('child_process');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-'));
const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-'));
process.env.NODE_ENV = 'test';
process.env.AEGIS_DATA = dir; process.env.AEGIS_DEMO = '1';
delete process.env.AEGIS_SECRET;
const { start, server } = require('../server/index.js');
const repo = path.join(__dirname, '..');
let base;

// Runs server/backup.js against a data folder and returns its exit code and output.
const run = (data, ...args) => {
  const env = { ...process.env, NODE_ENV: 'test', AEGIS_DATA: data };
  delete env.AEGIS_SECRET;
  const r = spawnSync(process.execPath, ['--no-warnings', path.join(repo, 'server/backup.js'), ...args], { env, encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
};
// Reads a data folder in a separate process: row counts, the stored document, the audit chain.
const inspect = (data, tables) => JSON.parse(spawnSync(process.execPath, ['--no-warnings', '-e', `
  process.env.NODE_ENV = 'test'; process.env.AEGIS_DATA = ${JSON.stringify(data)};
  const fs = require('fs'), path = require('path');
  const db = require(${JSON.stringify(path.join(repo, 'server/lib/db'))}), U = require(${JSON.stringify(path.join(repo, 'server/lib/util'))});
  U.setSecret(fs.readFileSync(path.join(process.env.AEGIS_DATA, '.secret'), 'utf8'));
  db.open(path.join(process.env.AEGIS_DATA, 'aegis.db'));
  const P = require(${JSON.stringify(path.join(repo, 'server/platform'))}), storage = require(${JSON.stringify(path.join(repo, 'server/lib/storage'))});
  const counts = {}; for (const t of ${JSON.stringify(tables)}) counts[t] = Number(db.get('SELECT COUNT(*) AS n FROM "' + t + '"').n);
  const ev = db.get("SELECT stored_path FROM evidence WHERE filename='backup-check.txt'");
  storage.get(ev.stored_path).then((buf) => {
    console.log(JSON.stringify({ counts, path: ev.stored_path, text: buf.toString(), audit: db.all('SELECT id FROM tenants').map((t) => P.verifyAudit(t.id).ok) }));
  });`], { encoding: 'utf8' }).stdout.trim().split('\n').pop());

test.before(async () => { await start(0, { loop: false }); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => { server.close(); for (const d of [dir, dir2]) try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 3 }); } catch {} setTimeout(() => process.exit(0), 50); });

test('a backup restores completely into a new database, with readable documents', async () => {
  // A stored document, so the backup has a file to carry.
  const login = await fetch(`${base}/api/login`, { method: 'POST', body: JSON.stringify({ email: 'sathinath@bluebix.demo', password: 'demo1234' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const call = (p, b) => fetch(base + p, { method: b ? 'POST' : 'GET', headers: { cookie, 'x-aegis-client': 'web' }, body: b && JSON.stringify(b) }).then((r) => r.json());
  const worker = (await call('/api/workers'))[0];
  await call('/api/evidence', { subject_type: 'worker', subject_id: worker.id, file: { name: 'backup-check.txt', mime: 'text/plain', data: Buffer.from('backup check document').toString('base64') } });

  const made = run(dir, 'backup', '--dir', path.join(dir, 'backups'));
  assert.equal(made.code, 0, made.out);
  const [name] = fs.readdirSync(path.join(dir, 'backups'));
  const folder = path.join(dir, 'backups', name), manifest = JSON.parse(fs.readFileSync(path.join(folder, 'manifest.json'), 'utf8'));
  assert.ok(manifest.tables.evidence > 0 && manifest.documents > 0 && !('sessions' in manifest.tables));
  assert.ok(!fs.readdirSync(folder).includes('.secret'), 'the key is never put in the backup');

  // While this server runs on the database, a restore into it is refused.
  const busy = run(dir, 'restore', folder);
  assert.notEqual(busy.code, 0); assert.match(busy.out, /Stop it before restoring/);

  // The wrong key is refused; the right one restores everything.
  fs.writeFileSync(path.join(dir2, '.secret'), 'a'.repeat(64));
  const wrong = run(dir2, 'restore', folder);
  assert.notEqual(wrong.code, 0); assert.match(wrong.out, /different encryption key/);
  fs.copyFileSync(path.join(dir, '.secret'), path.join(dir2, '.secret'));
  fs.rmSync(path.join(dir2, 'aegis.db'), { force: true });
  const ok = run(dir2, 'restore', folder);
  assert.equal(ok.code, 0, ok.out);
  const after = inspect(dir2, Object.keys(manifest.tables));
  assert.deepEqual(after.counts, manifest.tables, 'every table has the same number of rows');
  assert.equal(after.text, 'backup check document', 'the document decrypts after the restore');
  assert.ok(after.path.startsWith(dir2), 'documents point at the new data folder');
  assert.ok(after.audit.every(Boolean), 'the audit chain still verifies');

  // A database with data is only overwritten when asked.
  const again = run(dir2, 'restore', folder);
  assert.notEqual(again.code, 0); assert.match(again.out, /already has data/);
  assert.equal(run(dir2, 'restore', folder, '--replace').code, 0);
  assert.deepEqual(inspect(dir2, Object.keys(manifest.tables)).counts, manifest.tables);
});

test('only the newest backups are kept', () => {
  const { prune } = require('../server/lib/backup');
  const keepDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-keep-'));
  for (const d of ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04']) fs.mkdirSync(path.join(keepDir, `aegis-backup-${d}T02-00-00Z`));
  fs.mkdirSync(path.join(keepDir, 'aegis-backup-2026-11-05T02-00-00Z.partial'));
  prune(keepDir, 2);
  assert.deepEqual(fs.readdirSync(keepDir).sort(), ['aegis-backup-2026-11-03T02-00-00Z', 'aegis-backup-2026-11-04T02-00-00Z']);
  fs.rmSync(keepDir, { recursive: true, force: true });
});
