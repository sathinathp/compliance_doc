'use strict';
// Audit chain, durable jobs, permissions. Shared by every service.
const db = require('./lib/db'), { clock, id, sha256, j } = require('./lib/util');

const SYSTEM = { type: 'system', name: 'Aegis Orchestrator', role: 'system' };
const canon = (e) => JSON.stringify([e.seq, e.tenant_id, e.ts, e.type, e.subject, e.case_id, e.action, e.actor, e.detail_json]);
function audit(tenantId, type, subject, action, actor = SYSTEM, extra = {}) {
  return db.tx(() => {
    const prev = db.get('SELECT hash FROM audit_log WHERE tenant_id=? ORDER BY seq DESC LIMIT 1', tenantId)?.hash || 'GENESIS';
    const seq = (db.get('SELECT COALESCE(MAX(seq),0) s FROM audit_log').s) + 1;
    const e = { seq, tenant_id: tenantId, ts: clock.iso(), type, subject, case_id: extra.case_id || null, action, actor: actor.name, detail_json: JSON.stringify(extra.detail || {}) };
    db.insert('audit_log', { ...e, prev_hash: prev, hash: sha256(prev + canon(e)) });
  });
}
function verifyAudit(tenantId) {
  let prev = 'GENESIS', n = 0;
  for (const e of db.all('SELECT * FROM audit_log WHERE tenant_id=? ORDER BY seq', tenantId)) {
    if (e.prev_hash !== prev || sha256(prev + canon(e)) !== e.hash) return { ok: false, entries: n, broken_at_seq: e.seq };
    prev = e.hash; n++;
  }
  return { ok: true, entries: n, head: prev };
}
const bump = (t, key, by = 1) => db.run('INSERT INTO counters(tenant_id,key,value) VALUES(?,?,?) ON CONFLICT(tenant_id,key) DO UPDATE SET value=counters.value+excluded.value', t, key, by);
const counter = (t, key) => db.get('SELECT value FROM counters WHERE tenant_id=? AND key=?', t, key)?.value || 0;

// ---- durable jobs: every handler must be safe to run twice.
const handlers = {};
const on = (type, fn) => { handlers[type] = fn; };
// dedupe: a second job with the same key is skipped while the first is still queued or running.
// once: the key may run only one time ever, even after the first job finished. Used for keys that
// contain a date (for example the daily sync), so "once a day" really means once a day.
// Returns true when a new job was added.
function enqueue(tenantId, type, payload = {}, { dedupe = null, once = false, runAt = null, max = 5 } = {}) {
  if (once && dedupe && db.get('SELECT 1 AS x FROM jobs WHERE dedupe_key=?', dedupe)) return false;
  const r = db.run(`INSERT OR IGNORE INTO jobs(id,tenant_id,type,payload_json,run_at,status,max_attempts,dedupe_key,created_at) VALUES(?,?,?,?,?,'queued',?,?,?)`,
    id('job'), tenantId, type, JSON.stringify(payload), runAt || clock.iso(), max, dedupe, clock.iso());
  return !!r?.changes;
}
let busy = null;
async function runOne(force) {
  const job = db.get(`SELECT * FROM jobs WHERE status='queued' ${force ? '' : 'AND run_at<=?'} ORDER BY run_at, created_at LIMIT 1`, ...(force ? [] : [clock.iso()]));
  if (!job) return false;
  db.update('jobs', job.id, { status: 'running', locked_at: clock.iso(), attempts: job.attempts + 1 });
  try {
    if (!handlers[job.type]) throw new Error(`No handler for ${job.type}`);
    await handlers[job.type](job.tenant_id, j(job.payload_json, {}), job);
    db.update('jobs', job.id, { status: 'done', finished_at: clock.iso(), last_error: null });
  } catch (e) {
    const dead = job.attempts + 1 >= job.max_attempts;
    db.update('jobs', job.id, { status: dead ? 'dead' : 'queued', last_error: e.message, run_at: new Date(clock.now().getTime() + 2 ** job.attempts * 1000).toISOString(), finished_at: dead ? clock.iso() : null });
    audit(job.tenant_id, dead ? 'JOB_FAILED' : 'JOB_RETRY', job.type, `${job.type} ${dead ? 'failed permanently' : 'will retry'}: ${e.message}`);
  }
  return true;
}
async function loop(force = false) {
  if (busy) await busy;
  busy = (async () => { let n = 0; while (n++ < 5000 && await runOne(force)); })();
  try { await busy; } finally { busy = null; }
}
const drain = () => loop(true);
// Resolves when the job loop is not running a job (used on shutdown).
const idle = () => busy || Promise.resolve();
const recoverStale = () => db.run(`UPDATE jobs SET status='queued' WHERE status='running'`);

// ---- permissions
const ROLE_PACKS = { admin: ['*'], hr: ['onboarding'], healthcare_compliance: ['healthcare'], immigration_owner: ['immigration'], finance: ['payroll'], viewer: [] };
const ROLE_LABEL = { admin: 'Administrator', hr: 'HR', healthcare_compliance: 'Healthcare compliance', immigration_owner: 'Immigration owner', finance: 'Payroll / finance', viewer: 'Read only' };
const canPack = (u, pack) => u.type === 'system' || ROLE_PACKS[u.role]?.includes('*') || ROLE_PACKS[u.role]?.includes(pack);
const canSeeRestricted = (u) => u.type === 'system' || ['admin', 'immigration_owner'].includes(u.role);
const isAdmin = (u) => u.role === 'admin';
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const assertPack = (u, pack) => { if (!canPack(u, pack)) throw new HttpError(403, `Your role cannot act on the ${pack} pack.`); };
const assertAdmin = (u) => { if (!isAdmin(u)) throw new HttpError(403, 'Administrator role required.'); };
module.exports = { SYSTEM, audit, verifyAudit, bump, counter, on, enqueue, loop, drain, idle, recoverStale, ROLE_PACKS, ROLE_LABEL, canPack, canSeeRestricted, isAdmin, assertPack, assertAdmin, HttpError };
