'use strict';
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { Worker } = require('node:worker_threads');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS tenants(id TEXT PRIMARY KEY, slug TEXT UNIQUE, name TEXT, kind TEXT, setup_json TEXT DEFAULT '{}', channel_json TEXT DEFAULT '{"type":"outbox"}', webhook_secret TEXT, created_at TEXT, first_assessment_at TEXT);
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), email TEXT UNIQUE, name TEXT, role TEXT, password_hash TEXT, slack_id TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id), expires_at TEXT);
CREATE TABLE IF NOT EXISTS workspace_verifications(tenant_id TEXT PRIMARY KEY REFERENCES tenants(id), user_id TEXT UNIQUE NOT NULL REFERENCES users(id), token_hash TEXT UNIQUE, expires_at TEXT, requested_at TEXT NOT NULL, verified_at TEXT);
CREATE TABLE IF NOT EXISTS entities(id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT, state TEXT, confirmed INT DEFAULT 0, UNIQUE(tenant_id,name));
CREATE TABLE IF NOT EXISTS facilities(id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT, state TEXT, requirements_json TEXT DEFAULT '[]', requirements_confirmed INT DEFAULT 0, requirement_source TEXT, UNIQUE(tenant_id,name));
CREATE TABLE IF NOT EXISTS workers(id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, external_id TEXT, source TEXT, name TEXT, email TEXT, slack_id TEXT, role TEXT, category TEXT, dept TEXT, license_type TEXT, entity_id TEXT, status TEXT DEFAULT 'active', hire_date TEXT, work_auth_expires TEXT, attrs_json TEXT DEFAULT '{}', readiness TEXT DEFAULT 'pending', created_at TEXT, updated_at TEXT, UNIQUE(tenant_id,source,external_id));
CREATE INDEX IF NOT EXISTS ix_workers_t ON workers(tenant_id);
CREATE TABLE IF NOT EXISTS assignments(id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, worker_id TEXT NOT NULL, facility_id TEXT NOT NULL, role TEXT, start_date TEXT, end_date TEXT, status TEXT DEFAULT 'active');
CREATE TABLE IF NOT EXISTS packs(key TEXT, version TEXT, definition_json TEXT, validation_json TEXT, PRIMARY KEY(key,version));
CREATE TABLE IF NOT EXISTS tenant_packs(tenant_id TEXT, pack_key TEXT, version TEXT, status TEXT, mode TEXT DEFAULT 'shadow', owner_user_id TEXT, reviewed_by TEXT, activated_at TEXT, PRIMARY KEY(tenant_id,pack_key));
CREATE TABLE IF NOT EXISTS control_changes(id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, kind TEXT, control_key TEXT, pack_key TEXT, source_text TEXT, definition_json TEXT, preview_json TEXT, status TEXT, version INT DEFAULT 1, created_by TEXT, approved_by TEXT, created_at TEXT, activated_at TEXT);
CREATE TABLE IF NOT EXISTS evidence(id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, subject_type TEXT, subject_id TEXT, doc_type TEXT, status TEXT, source TEXT, filename TEXT, mime TEXT, size INT, sha256 TEXT, stored_path TEXT, doc_number TEXT, holder_name TEXT, state TEXT, entity_name TEXT, period TEXT, issued_on TEXT, expires_on TEXT, fields_json TEXT, confidence REAL, review_reasons_json TEXT DEFAULT '[]', flags_json TEXT DEFAULT '[]', case_id TEXT, control_key TEXT, restricted INT DEFAULT 0, reviewed_by TEXT, reviewed_at TEXT, reject_reason TEXT, created_at TEXT);
CREATE INDEX IF NOT EXISTS ix_ev ON evidence(tenant_id,subject_type,subject_id);
CREATE TABLE IF NOT EXISTS evaluations(id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, subject_type TEXT, subject_id TEXT, pack_key TEXT, control_key TEXT, control_version TEXT, status TEXT, code TEXT, reason TEXT, evidence_ids_json TEXT, action_needed INT, trigger TEXT, is_current INT DEFAULT 1, created_at TEXT, evaluated_at TEXT);
CREATE INDEX IF NOT EXISTS ix_eval ON evaluations(tenant_id,is_current,status);
CREATE TABLE IF NOT EXISTS cases(id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, subject_type TEXT, subject_id TEXT, subject_name TEXT, pack_key TEXT, control_key TEXT, control_name TEXT, state TEXT, gap TEXT, gap_kind TEXT, priority TEXT, owner_user_id TEXT, owner_team TEXT, restricted INT DEFAULT 0, due_date TEXT, reminders_sent INT DEFAULT 0, next_reminder_at TEXT, escalated INT DEFAULT 0, opened_at TEXT, closed_at TEXT, closure TEXT, closure_evidence_id TEXT, finding_verdict TEXT, verdict_by TEXT, verdict_note TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS uq_open_case ON cases(tenant_id,subject_type,subject_id,control_key) WHERE closed_at IS NULL;
CREATE TABLE IF NOT EXISTS case_notes(id TEXT PRIMARY KEY, tenant_id TEXT, case_id TEXT, note TEXT, author TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS actions(id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, case_id TEXT, type TEXT, idempotency_key TEXT, status TEXT, automated INT DEFAULT 0, recipient TEXT, recipient_type TEXT, subject TEXT, body TEXT, created_by TEXT, created_at TEXT, sent_at TEXT, error TEXT, UNIQUE(tenant_id,idempotency_key));
CREATE TABLE IF NOT EXISTS approvals(id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, kind TEXT, ref_id TEXT, case_id TEXT, pack_key TEXT, title TEXT, detail TEXT, status TEXT DEFAULT 'pending', requested_by TEXT, decided_by TEXT, decided_at TEXT, note TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, action_id TEXT, channel TEXT, recipient TEXT, subject TEXT, body TEXT, status TEXT, provider_ref TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS submission_tokens(token_hash TEXT PRIMARY KEY, tenant_id TEXT, case_id TEXT, expires_at TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, source TEXT, external_id TEXT, type TEXT, payload_json TEXT, status TEXT, received_at TEXT, processed_at TEXT, error TEXT, UNIQUE(tenant_id,source,external_id));
CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, tenant_id TEXT, type TEXT, payload_json TEXT, run_at TEXT, status TEXT, attempts INT DEFAULT 0, max_attempts INT DEFAULT 5, last_error TEXT, dedupe_key TEXT, locked_at TEXT, created_at TEXT, finished_at TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS uq_job ON jobs(dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('queued','running');
CREATE INDEX IF NOT EXISTS ix_job_dedupe ON jobs(dedupe_key);
CREATE INDEX IF NOT EXISTS ix_jobs ON jobs(status,run_at);
CREATE TABLE IF NOT EXISTS schedules(id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, kind TEXT, cadence TEXT, next_run_at TEXT, enabled INT DEFAULT 1, config_json TEXT DEFAULT '{}');
CREATE TABLE IF NOT EXISTS connectors(id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, type TEXT, name TEXT, config_enc TEXT, cursor TEXT, status TEXT, capabilities_json TEXT DEFAULT '[]', last_sync_at TEXT, last_error TEXT, records INT DEFAULT 0);
CREATE TABLE IF NOT EXISTS imports(id TEXT PRIMARY KEY, tenant_id TEXT, filename TEXT, rows_json TEXT, status TEXT, created_by TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS dashboards(id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT, definition_json TEXT, roles_json TEXT, created_by TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS notices(id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, entity_id TEXT, agency TEXT, notice_type TEXT, received_on TEXT, response_due TEXT, summary TEXT, draft_response TEXT, status TEXT, created_by TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS chat_messages(id TEXT PRIMARY KEY, tenant_id TEXT, user_id TEXT, sender TEXT, author TEXT, text TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS baselines(tenant_id TEXT, key TEXT, value REAL, note TEXT, updated_at TEXT, PRIMARY KEY(tenant_id,key));
CREATE TABLE IF NOT EXISTS manual_support(id TEXT PRIMARY KEY, tenant_id TEXT, minutes REAL, note TEXT, created_by TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS counters(tenant_id TEXT, key TEXT, value REAL DEFAULT 0, PRIMARY KEY(tenant_id,key));
CREATE TABLE IF NOT EXISTS audit_log(seq INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL, ts TEXT, type TEXT, subject TEXT, case_id TEXT, action TEXT, actor TEXT, detail_json TEXT, prev_hash TEXT, hash TEXT);
CREATE INDEX IF NOT EXISTS ix_audit ON audit_log(tenant_id,seq);
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT,'audit_log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT,'audit_log is append-only'); END;
`;

// Postgres version of SCHEMA: same tables, with Postgres types and triggers.
// chat_messages gets an explicit rowid so "ORDER BY created_at, rowid" works on both databases.
const PG_SCHEMA = SCHEMA
  .replace(/^CREATE TRIGGER.*$/gm, '')
  .replace('seq INTEGER PRIMARY KEY AUTOINCREMENT', 'seq INTEGER PRIMARY KEY')
  .replace(/ REAL\b/g, ' DOUBLE PRECISION')
  .replace('chat_messages(id TEXT PRIMARY KEY,', 'chat_messages(rowid SERIAL, id TEXT PRIMARY KEY,') + `
CREATE OR REPLACE FUNCTION aegis_audit_append_only() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit_log is append-only'; END $$;
DROP TRIGGER IF EXISTS audit_no_change ON audit_log;
CREATE TRIGGER audit_no_change BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION aegis_audit_append_only();
`;

let mode = 'sqlite'; // 'pg' or 'sqlite'
let sqliteDb = null;
let pgWorker = null;
let pgInt32 = null;
let pgUint8 = null;
let depth = 0;

function toPgSql(sql) {
  let s = sql;
  // Replace sqlite_master queries with information_schema
  if (/sqlite_master/i.test(s)) {
    s = s.replace(/FROM\s+sqlite_master\s+WHERE\s+type=['"]table['"]\s+AND\s+name\s+NOT\s+LIKE\s+['"]sqlite_%['"]/gi,
      "FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'");
    s = s.replace(/\bname\b/gi, 'table_name AS name');
  }
  // Replace INSERT OR IGNORE INTO
  if (/INSERT\s+OR\s+IGNORE\s+INTO/i.test(s)) {
    s = s.replace(/INSERT\s+OR\s+IGNORE\s+INTO/i, 'INSERT INTO');
    if (!/ON\s+CONFLICT/i.test(s)) {
      s += ' ON CONFLICT DO NOTHING';
    }
  } else if (/INSERT\s+OR\s+REPLACE\s+INTO\s+packs/i.test(s)) {
    s = s.replace(/INSERT\s+OR\s+REPLACE\s+INTO\s+packs\(([^)]+)\)\s+VALUES\(([^)]+)\)/i,
      'INSERT INTO packs($1) VALUES($2) ON CONFLICT(key,version) DO UPDATE SET definition_json=excluded.definition_json, validation_json=excluded.validation_json');
  }
  // Replace ? with $1, $2, ...
  let i = 0;
  return s.replace(/\?/g, () => `$${++i}`);
}

// Postgres cancels a statement after this long; the main thread waits a little longer before
// giving up on the worker, so a stuck worker can never freeze the server.
const STATEMENT_TIMEOUT_MS = +(process.env.AEGIS_DB_STATEMENT_TIMEOUT_MS || 30000);
const WAIT_TIMEOUT_MS = STATEMENT_TIMEOUT_MS + 15000;
const BUFFER_BYTES = 64 * 1024 * 1024;
let pgUrlInUse = null;

// Starts the query worker and waits for it to connect. Returns true when connected.
function startPgWorker(url) {
  const sab = new SharedArrayBuffer(BUFFER_BYTES);
  pgInt32 = new Int32Array(sab, 0, 4);
  pgUint8 = new Uint8Array(sab, 16);
  pgWorker = new Worker(path.join(__dirname, 'pg-worker.js'), { workerData: { sab, connectionString: url, statementTimeoutMs: STATEMENT_TIMEOUT_MS } });
  // Time limit, so a crashed worker (for example, the pg package is not installed) cannot freeze startup.
  if (Atomics.wait(pgInt32, 0, 0, 15000) === 'timed-out') { pgWorker.terminate(); throw new Error('no answer from the database worker. Run "npm install" and check that PostgreSQL is running.'); }
  if (pgInt32[2] !== 0) { pgWorker.terminate(); return false; }
  Atomics.store(pgInt32, 0, 0);
  pgUrlInUse = url;
  return true;
}

function pgExecSync(type, sql, params = []) {
  const payload = JSON.stringify({ type, sql, params });
  const encoded = Buffer.from(payload, 'utf8');
  if (encoded.length > pgUint8.length) {
    throw new Error(`Query payload exceeds buffer size: ${encoded.length} > ${pgUint8.length}`);
  }
  pgInt32[1] = encoded.length;
  pgUint8.set(encoded);
  Atomics.store(pgInt32, 0, 1);
  pgWorker.postMessage('run');

  if (Atomics.wait(pgInt32, 0, 1, WAIT_TIMEOUT_MS) === 'timed-out') {
    // The worker is stuck. Replace it so the next query works, and fail this one loudly.
    console.error(`[db] PostgreSQL did not answer within ${WAIT_TIMEOUT_MS / 1000}s. Restarting the database worker.`);
    pgWorker.terminate();
    let ok = false;
    try { ok = startPgWorker(pgUrlInUse); } catch (e) { console.error('[db]', e.message); }
    if (!ok) console.error('[db] Could not reconnect to PostgreSQL. Every query will fail until it is back.');
    throw new Error('The database did not answer in time.');
  }
  const len = pgInt32[1];
  const status = pgInt32[2];
  const resBuf = Buffer.from(pgUint8.buffer, 16, len);
  const res = JSON.parse(resBuf.toString('utf8'));
  Atomics.store(pgInt32, 0, 0);

  if (status === 1) throw new Error(res.error);
  return res.data;
}

// Separate PG* settings win over DATABASE_URL. They are encoded here, so a
// password with @, #, : or / works without hand-encoding.
function pgConnectionString() {
  const { PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE } = process.env;
  if (PGUSER && PGDATABASE) {
    const auth = encodeURIComponent(PGUSER) + (PGPASSWORD ? ':' + encodeURIComponent(PGPASSWORD) : '');
    return `postgresql://${auth}@${PGHOST || 'localhost'}:${PGPORT || 5432}/${encodeURIComponent(PGDATABASE)}`;
  }
  return process.env.DATABASE_URL || null;
}

function open(file) {
  const isTest = process.env.NODE_ENV === 'test' || /aegis-(ai-)?[a-zA-Z0-9]+/.test(process.env.AEGIS_DATA || '');
  const isProd = process.env.NODE_ENV === 'production';
  // Tests use SQLite unless AEGIS_TEST_DATABASE_URL points them at a Postgres database.
  const pgUrl = isTest ? (process.env.AEGIS_TEST_DATABASE_URL || null) : pgConnectionString();
  // Production must run on PostgreSQL. Falling back to a local SQLite file there would
  // silently split the data, so stop and say what is wrong instead.
  if (isProd && !pgUrl) throw new Error('[db] NODE_ENV=production needs PostgreSQL. Set PGHOST, PGUSER, PGPASSWORD and PGDATABASE (or DATABASE_URL).');
  if (pgUrl) {
    try {
      if (startPgWorker(pgUrl)) {
        mode = 'pg';
        console.log(`[db] Connected to PostgreSQL at ${pgUrl.replace(/:[^:]*@/, ':****@')}`);
        // Every schema statement is safe to re-run, so it runs on each start. That way new tables
        // and indexes also reach an existing database. Changing an existing column still needs a migration.
        const fresh = !get("SELECT to_regclass('tenants') AS t").t;
        exec(PG_SCHEMA);
        if (fresh) console.log('[db] Created the Aegis tables in PostgreSQL.');
        return;
      }
      if (isProd) throw new Error('could not connect. Check the PG* settings and that PostgreSQL is running.');
      console.warn('[db] PostgreSQL connection failed, falling back to SQLite (development only).');
    } catch (err) {
      if (pgWorker) pgWorker.terminate();
      if (isProd) throw new Error(`[db] PostgreSQL ${err.message}`);
      console.warn('[db] PostgreSQL connection failed, falling back to SQLite (development only):', err.message);
    }
  } else if (!isTest) {
    console.warn('[db] No PostgreSQL settings found, so using a local SQLite file. This is for development only.');
  }

  // Fallback to SQLite (used in tests or when Postgres is unavailable)
  mode = 'sqlite';
  sqliteDb = new DatabaseSync(file);
  sqliteDb.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  sqliteDb.exec(SCHEMA); // safe to re-run; adds new tables and indexes to an existing file
  console.log('[db] Using SQLite at', file);
}

function all(s, ...a) {
  if (mode === 'pg') {
    const pgSql = toPgSql(s);
    const res = pgExecSync('query', pgSql, a);
    return res.rows;
  }
  return sqliteDb.prepare(s).all(...a).map((r) => ({ ...r }));
}

function get(s, ...a) {
  if (mode === 'pg') {
    const pgSql = toPgSql(s);
    const res = pgExecSync('query', pgSql, a);
    return res.rows.length > 0 ? res.rows[0] : undefined;
  }
  const r = sqliteDb.prepare(s).get(...a);
  return r ? { ...r } : undefined;
}

function run(s, ...a) {
  if (mode === 'pg') {
    const pgSql = toPgSql(s);
    const res = pgExecSync('query', pgSql, a);
    return { changes: res.rowCount };
  }
  return sqliteDb.prepare(s).run(...a);
}

function exec(s) {
  if (mode === 'pg') {
    if (/PRAGMA/i.test(s)) return; // Ignore SQLite PRAGMAs in Postgres
    return pgExecSync('exec', toPgSql(s));
  }
  return sqliteDb.exec(s);
}

function tx(fn) {
  if (depth > 0) return fn();
  if (mode === 'pg') {
    exec('BEGIN');
    depth++;
    try {
      const r = fn();
      exec('COMMIT');
      return r;
    } catch (e) {
      exec('ROLLBACK');
      throw e;
    } finally {
      depth--;
    }
  }

  sqliteDb.exec('BEGIN IMMEDIATE');
  depth++;
  try {
    const r = fn();
    sqliteDb.exec('COMMIT');
    return r;
  } catch (e) {
    sqliteDb.exec('ROLLBACK');
    throw e;
  } finally {
    depth--;
  }
}

function insert(table, row) {
  const k = Object.keys(row);
  if (mode === 'pg') {
    const cols = k.map((x) => `"${x}"`).join(',');
    const vals = k.map((_, idx) => `$${idx + 1}`).join(',');
    return run(`INSERT INTO "${table}"(${cols}) VALUES(${vals})`, ...k.map((x) => row[x] === undefined ? null : row[x]));
  }
  return run(`INSERT INTO ${table}(${k.join(',')}) VALUES(${k.map(() => '?').join(',')})`, ...k.map((x) => row[x] === undefined ? null : row[x]));
}

function update(table, idv, row, idc = 'id') {
  const k = Object.keys(row);
  if (mode === 'pg') {
    const sets = k.map((x, idx) => `"${x}"=$${idx + 1}`).join(',');
    return run(`UPDATE "${table}" SET ${sets} WHERE "${idc}"=$${k.length + 1}`, ...k.map((x) => row[x] === undefined ? null : row[x]), idv);
  }
  return run(`UPDATE ${table} SET ${k.map((x) => x + '=?').join(',')} WHERE ${idc}=?`, ...k.map((x) => row[x] === undefined ? null : row[x]), idv);
}

function resetAll() {
  if (mode === 'pg') {
    const tables = all("SELECT table_name AS name FROM information_schema.tables WHERE table_schema=current_schema() AND table_type='BASE TABLE'");
    for (const t of tables) {
      exec(`DROP TABLE IF EXISTS "${t.name}" CASCADE`);
    }
    exec(PG_SCHEMA);
    return;
  }
  sqliteDb.exec('PRAGMA foreign_keys=OFF');
  for (const t of all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")) {
    sqliteDb.exec(`DROP TABLE ${t.name}`);
  }
  sqliteDb.exec('PRAGMA foreign_keys=ON');
  sqliteDb.exec(SCHEMA);
}

function close() {
  if (mode === 'pg' && pgWorker) {
    try { pgWorker.postMessage('close'); } catch {}
  }
  if (mode === 'sqlite' && sqliteDb) {
    try { sqliteDb.close(); } catch {}
  }
}

module.exports = { open, all, get, run, exec, tx, insert, update, resetAll, close, mode: () => mode };
