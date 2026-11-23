'use strict';
const crypto = require('crypto');
const sandbox = require('./lib/sandbox');
const W = require('./lib/workspace');
const CoworkerPolicy = require('./coworker-policy');
const db = require('./lib/db'), { clock, id, sha256, token, j, hashPassword, checkPassword } = require('./lib/util');
const P = require('./platform'), R = require('./registry'), E = require('./engine'), Ev = require('./evidence'), C = require('./connectors'), V = require('./views'), Chat = require('./chat'), llm = require('./llm'), mock = require('./mock-hrms'), channels = require('./channels'), Slack = require('./slack');
const { HttpError } = P;
const routes = [];
const add = (m, p, fn, o = {}) => { const keys = []; const re = new RegExp('^' + p.replace(/:([a-z_]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$'); routes.push({ m, re, keys, fn, o }); };
const demo = () => process.env.AEGIS_DEMO === '1';
const file = (b) => { if (!b.file?.data) throw new HttpError(400, 'A file is required.'); return { filename: String(b.file.name || 'upload').slice(0, 200), mime: String(b.file.mime || 'application/octet-stream'), data: Buffer.from(b.file.data, 'base64') }; };
const edit = (u) => { if (u.role === 'viewer') throw new HttpError(403, 'Read-only role.'); };
const getCase = (t, cid) => { const c = db.get('SELECT * FROM cases WHERE id=? AND tenant_id=?', cid, t); if (!c) throw new HttpError(404, 'Case not found.'); return c; };
const seen = (u, c) => { if (c.restricted && !P.canSeeRestricted(u)) throw new HttpError(403, 'This case is restricted.'); };

// ---- public
add('GET', '/api/public/info', () => ({ signup: W.enabled(), demo: demo(), accounts: demo() ? [['sathinath@bluebix.demo', 'Bluebix admin (populated pilot)'], ['admin@northstar.demo', 'Northstar admin (blank external test)'], ['health@bluebix.demo', 'Healthcare compliance'], ['hr@bluebix.demo', 'HR (cannot see immigration)'], ['immigration@bluebix.demo', 'Immigration owner'], ['finance@bluebix.demo', 'Finance'], ['viewer@bluebix.demo', 'Read only']] : [], demo_password: demo() ? 'demo1234' : null }), { public: true });
const attempts = new Map();
add('POST', '/api/login', ({ body, res }) => {
  const key = String(body.email || '').toLowerCase(), a = attempts.get(key) || { n: 0, at: Date.now() };
  if (Date.now() - a.at > 9e5) { a.n = 0; a.at = Date.now(); }
  if (++a.n > 10) throw new HttpError(429, 'Too many attempts. Try again in 15 minutes.');
  attempts.set(key, a);
  const u = db.get('SELECT * FROM users WHERE lower(email)=lower(?)', String(body.email || ''));
  if (!u || !checkPassword(String(body.password || ''), u.password_hash)) throw new HttpError(401, 'Incorrect email or password.');
  res.setHeader('set-cookie', sessionCookie(createSession(u.id), 43200));
  attempts.delete(key);
  return { ok: true };
}, { public: true });
function createSession(userId) {
  const raw = token();
  db.insert('sessions', { token_hash: sha256(raw), user_id: userId, expires_at: new Date(Date.now() + 12 * 36e5).toISOString() });
  return raw;
}
const signupAttempts = new Map();
function requireSignup() {
  if (!W.enabled()) throw new HttpError(404, 'Workspace sign-up is unavailable.');
}
add('POST', '/api/signup', ({ req, res, body }) => {
  requireSignup();
  if (req.headers['x-aegis-client'] !== 'web') throw new HttpError(403, 'Missing client header.');
  const now = Date.now();
  for (const [key, value] of signupAttempts) if (value.until <= now) signupAttempts.delete(key);
  const address = req.socket.remoteAddress;
  const attempt = signupAttempts.get(address) || { count: 0, until: now + 15 * 60e3 };
  if (++attempt.count > 20) throw new HttpError(429, 'Too many sign-up attempts. Try again in 15 minutes.');
  signupAttempts.set(address, attempt);
  const field = (key) => typeof body?.[key] === 'string' ? body[key] : '';
  const orgName = field('org_name').trim(), adminName = field('admin_name').trim();
  const email = field('email').trim().toLowerCase(), password = field('password');
  if (orgName.length < 2 || orgName.length > 120) throw new HttpError(400, 'Enter an organisation name of 2 to 120 characters.');
  if (adminName.length < 2 || adminName.length > 120) throw new HttpError(400, 'Enter a full name of 2 to 120 characters.');
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Enter a valid work email.');
  if (password.length < 12 || password.length > 128) throw new HttpError(400, 'Use a password of 12 to 128 characters.');
  const signup = db.tx(() => {
    const { tenantId, userId } = W.createWorkspace({ orgName, adminName, email, password });
    return { userId, session: createSession(userId), email: W.prepareEmail(tenantId, userId, { initial: true }) };
  });
  W.deliverTestEmail(signup.userId, signup.email);
  res.setHeader('set-cookie', sessionCookie(signup.session, 43200));
  return { ok: true };
}, { public: true });
add('GET', '/api/verify-email/inbox', ({ t, user, res }) => {
  requireSignup();
  res.setHeader('Cache-Control', 'no-store');
  return W.testEmail(t, user.id);
});
add('POST', '/api/verify-email/resend', ({ t, user }) => {
  requireSignup();
  const state = W.verification(t);
  if (!state || state.user_id !== user.id || state.verified_at) throw new HttpError(409, 'There is no email waiting for verification for this account.');
  W.deliverTestEmail(user.id, W.prepareEmail(t, user.id));
  return { ok: true };
});
add('POST', '/api/verify-email', ({ t, user, body }) => {
  requireSignup();
  W.verifyEmail(t, user, body?.token);
  return { ok: true };
});
function sessionCookie(value, maxAge) {
  const secure = /^https:/.test(process.env.AEGIS_BASE_URL || '') ? '; Secure' : '';
  return `${sandbox.sessionCookie()}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure}`;
}
add('POST', '/api/logout', ({ sid, res }) => { db.run('DELETE FROM sessions WHERE token_hash=?', sha256(sid || '')); res.setHeader('set-cookie', sessionCookie('', 0)); return { ok: true }; });
add('GET', '/api/me', ({ t, user }) => {
  const tn = db.get('SELECT name,slug,kind FROM tenants WHERE id=?', t);
  const verification = W.verification(t);
  return {
    user: { id: user.id, name: user.name, email: user.email, role: user.role, role_label: P.ROLE_LABEL[user.role], can_restricted: P.canSeeRestricted(user), is_admin: P.isAdmin(user) },
    tenant: tn, demo: demo() && !verification, sandbox: sandbox.isActive(), today: clock.today(),
    workspace_email: verification ? { pending: !verification.verified_at, can_verify: verification.user_id === user.id && W.enabled() } : null,
  };
});
const tokenCase = (raw) => {
  const s = db.get('SELECT * FROM submission_tokens WHERE token_hash=?', sha256(raw));
  if (!s || s.expires_at < clock.iso()) throw new HttpError(410, 'This link has expired or is not valid.');
  const c = db.get('SELECT * FROM cases WHERE id=? AND tenant_id=?', s.case_id, s.tenant_id);
  if (!c || c.closed_at) throw new HttpError(410, 'This request is already complete.');
  return c;
};
add('GET', '/api/submit/:token', ({ p }) => { const c = tokenCase(p.token); return { first_name: c.subject_type === 'worker' ? c.subject_name.split(/[ ,]/)[0] : c.subject_name, document: c.control_name, due: c.due_date, state: c.state }; }, { public: true });
const limits = new Map();
add('POST', '/api/submit/:token', async ({ p, body }) => {
  const k = sha256(p.token), n = (limits.get(k) || 0) + 1; limits.set(k, n);
  if (n > 20) throw new HttpError(429, 'Too many uploads. Please contact your coordinator.');
  const c = tokenCase(p.token), f = file(body);
  const ev = await Ev.intake(c.tenant_id, { subject_type: c.subject_type, subject_id: c.subject_id, control_key: c.control_key, ...f, source: 'secure_link', case_id: c.id }, { name: c.subject_name });
  return { received: true, status: ev.status === 'accepted' ? 'Your document was accepted and the check is being rerun.' : 'Thanks. Your document was received and is waiting for review.' };
}, { public: true });

// ---- webhooks: authenticated by signature, not by session
add('POST', '/api/webhooks/hrms/:slug', ({ p, raw, req }) => {
  const tn = db.get('SELECT * FROM tenants WHERE slug=?', p.slug);
  if (!tn || !tn.webhook_secret) throw new HttpError(404, 'Unknown tenant.');
  const con = db.get("SELECT * FROM connectors WHERE tenant_id=? AND type='hrms' AND status!='disabled'", tn.id);
  const header = String((con && C.configOf(con).webhook_signature_header) || 'x-aegis-signature').toLowerCase();
  const want = 'sha256=' + crypto.createHmac('sha256', tn.webhook_secret).update(raw).digest('hex'), got = String(req.headers[header] || '');
  if (want.length !== got.length || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(got))) throw new HttpError(401, 'Invalid signature.');
  if (!con) throw new HttpError(409, 'No active HRMS connector.');
  let b;
  try { b = JSON.parse(raw); } catch { throw new HttpError(400, 'Invalid JSON.'); }
  // The event id stops duplicates. Without one, the body's hash is used, so different events never collide.
  const extId = b.id != null && b.id !== '' ? String(b.id) : `sha256:${sha256(raw)}`;
  const evId = id('evt');
  const r = db.run("INSERT OR IGNORE INTO events(id,tenant_id,source,external_id,type,payload_json,status,received_at) VALUES(?,?,?,?,?,?,'received',?)", evId, tn.id, con.id, extId, String(b.type || 'unknown'), raw.toString(), clock.iso());
  if (!r.changes) return { accepted: true, duplicate: true };
  P.enqueue(tn.id, 'process_event', { event_id: evId });
  return { accepted: true };
}, { public: true });
// Slack Events URL. /api/webhooks/slack/<company> uses that company's signing secret from the
// Integrations page; /api/webhooks/slack uses SLACK_SIGNING_SECRET from .env.
// Slack must get an answer within 3 seconds and retries otherwise, so the reply is sent afterwards.
const slackEvents = ({ raw, req, body }, tenantId, secret) => {
  if (!Slack.verify(secret, req.headers['x-slack-request-timestamp'], raw.toString(), req.headers['x-slack-signature'])) throw new HttpError(401, 'Invalid signature.');
  if (body.type === 'url_verification') return { challenge: body.challenge };
  Slack.handleEvent(tenantId, body, Chat.handle).catch((e) => console.error('[slack]', e));
  return { ok: true };
};
add('POST', '/api/webhooks/slack', (ctx) => slackEvents(ctx, null, process.env.SLACK_SIGNING_SECRET), { public: true });
add('POST', '/api/webhooks/slack/:slug', (ctx) => {
  const tn = db.get('SELECT id FROM tenants WHERE slug=?', ctx.p.slug);
  const cfg = tn && Slack.config(tn.id);
  if (!cfg || cfg.source !== 'settings') throw new HttpError(404, 'Unknown company.');
  return slackEvents(ctx, tn.id, cfg.signing_secret);
}, { public: true });

// ---- read models
add('GET', '/api/overview', ({ t, user }) => V.overview(t, user));
// Sidebar counts, each counted exactly as the page it opens shows it. Setup and notices are null for
// people who cannot open those pages.
add('GET', '/api/nav', ({ t, user }) => ({
  cases: V.listCases(t, user).length,
  approvals: V.listApprovals(t, user, 'pending').length,
  evidence: V.listEvidence(t, user).filter((e) => e.status === 'needs_review' && e.can_review).length,
  notices: P.canPack(user, 'payroll') ? db.get("SELECT COUNT(*) AS n FROM notices WHERE tenant_id=? AND status='draft_awaiting_approval'", t).n : null,
  setup: P.isAdmin(user) ? V.setupState(t).gap_items.filter((g) => g.step !== 'packs').length : null,
  // When Aegis last ran the checks, for the "Checked" note in the top bar.
  checked_at: db.get('SELECT MAX(evaluated_at) AS last FROM evaluations WHERE tenant_id=? AND is_current=1', t)?.last || null,
}));
add('GET', '/api/checks', ({ t, user, q }) => ({ rows: V.checks(t, user, { status: q.get('status'), pack: q.get('pack'), subject: q.get('subject') }), coverage: V.coverage(t) }));
add('GET', '/api/cases', ({ t, user, q }) => V.listCases(t, user, { closed: q.get('closed') === '1', pack: q.get('pack') })
  .map((c) => ({ ...c, can_act: user.role !== 'viewer' && P.canPack(user, c.pack_key) })));
add('GET', '/api/cases/:id', ({ t, user, p }) => V.caseDetail(t, user, p.id));
add('POST', '/api/cases/chase-all', ({ t, user, body }) => {
  edit(user);
  W.requireVerified(t);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Choose cases to follow up on.');
  const { case_ids } = body;
  if (case_ids !== undefined && (!Array.isArray(case_ids) || case_ids.some((id) => typeof id !== 'string' || !id))) {
    throw new HttpError(400, 'Choose valid cases before sending follow-ups.');
  }
  const selected = case_ids === undefined ? null : new Set(case_ids);
  const eligible = V.listCases(t, user).filter((c) => P.canPack(user, c.pack_key) && (!selected || selected.has(c.id)));
  let sent = 0;
  for (const c of eligible) {
    if (E.followUp(t, user, c).sent) sent++;
  }
  return { sent, skipped: (selected?.size ?? eligible.length) - sent };
});
add('POST', '/api/cases/:id/follow-up', ({ t, user, p }) => { edit(user); const c = getCase(t, p.id); seen(user, c); return E.followUp(t, user, c); });
add('POST', '/api/cases/:id/note', ({ t, user, p, body }) => { edit(user); const c = getCase(t, p.id); seen(user, c); if (!body.note) throw new HttpError(400, 'Note is required.'); db.insert('case_notes', { id: id('note'), tenant_id: t, case_id: c.id, note: String(body.note).slice(0, 2000), author: user.name, created_at: clock.iso() }); P.audit(t, 'CASE_NOTE', c.subject_name, `Note added. A note does not change the check result: ${String(body.note).slice(0, 200)}`, user, { case_id: c.id }); return { ok: true }; });
add('POST', '/api/cases/:id/verdict', ({ t, user, p, body }) => { edit(user); const c = getCase(t, p.id); seen(user, c); E.recordVerdict(t, user, c, body.verdict, body.note); return { ok: true }; });
add('POST', '/api/cases/:id/decision', ({ t, user, p, body }) => { edit(user); const c = getCase(t, p.id); seen(user, c); P.assertPack(user, c.pack_key); E.requestDecision(t, user, 'assignment_review', c, `${body.title || 'Decision'}: ${c.subject_name}`, `${c.gap} ${body.detail || ''}`.trim(), c.pack_key, c.id); return { ok: true }; });
add('GET', '/api/workers', ({ t, user }) => V.listWorkers(t, user));
add('GET', '/api/workers/:id', ({ t, user, p }) => V.workerDetail(t, user, p.id));
add('POST', '/api/workers', ({ t, user, body }) => {
  edit(user); if (!P.isAdmin(user) && user.role !== 'hr') throw new HttpError(403, 'HR or administrator role required.');
  const name = String(body.name || '').trim();
  if (!name) throw new HttpError(400, 'Name is required.');
  const r = C.upsertWorker(t, { name, email: String(body.email || '').trim(), role: body.role, license_type: body.license_type || null, category: body.category, dept: body.dept, facility: body.facility, facility_state: body.facility_state, entity: body.entity, hire_date: body.hire_date || clock.today(), work_auth_expires: body.work_auth_expires, attrs: {} }, 'manual', user);
  return r;
});
add('POST', '/api/workers/:id/assignment', ({ t, user, p, body }) => {
  edit(user); const w = db.get('SELECT * FROM workers WHERE id=? AND tenant_id=?', p.id, t); if (!w) throw new HttpError(404, 'Worker not found.');
  const facility = String(body.facility || '').trim();
  if (!facility) throw new HttpError(400, 'Facility is required.');
  C.changeAssignment(t, w, facility, body.facility_state, user);
  return { ok: true };
});
add('POST', '/api/workers/:id/readiness-review', ({ t, user, p }) => {
  edit(user); const d = V.workerDetail(t, user, p.id);
  // One open request per worker, so two answers can never contradict each other.
  if (d.readiness_request) throw new HttpError(409, `${d.name} is already waiting for a readiness decision in Approvals.`);
  E.requestDecision(t, user, 'readiness_decision', null, `Assignment readiness: ${d.name}`, d.readiness_view.statement, 'onboarding', d.id); return { ok: true }; });
add('GET', '/api/evidence', ({ t, user }) => V.listEvidence(t, user));
add('POST', '/api/evidence', async ({ t, user, body }) => { edit(user); const ev = await Ev.intake(t, { subject_type: body.subject_type || 'worker', subject_id: body.subject_id, control_key: body.control_key || null, ...file(body), claimed: body.claimed || {}, source: body.bulk ? 'bulk_upload' : 'upload' }, user); return { id: ev.id, status: ev.status, duplicate: !!ev.duplicate, reasons: j(ev.review_reasons_json, []) }; });
const getEv = (t, u, eid) => { const e = db.get('SELECT * FROM evidence WHERE id=? AND tenant_id=?', eid, t); if (!e) throw new HttpError(404, 'Evidence not found.'); if (!Ev.canView(u, e)) throw new HttpError(403, 'This evidence is restricted.'); return e; };
add('POST', '/api/evidence/:id/review', ({ t, user, p, body }) => { edit(user); Ev.review(t, user, getEv(t, user, p.id), body); return { ok: true }; });
add('GET', '/api/evidence/:id/file', async ({ t, user, p, res }) => {
  const e = getEv(t, user, p.id); if (!e.stored_path) throw new HttpError(404, 'Demo evidence has no file.');
  let data;
  try { data = await Ev.readFile(e); } catch (err) { console.error('[storage]', err.message); throw new HttpError(503, 'The document could not be read from storage.'); }
  P.audit(t, 'EVIDENCE_VIEWED', e.filename, 'Document opened.', user);
  res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="${e.filename.replace(/[^\w.\-]/g, '_')}"` }); res.end(data); return res;
});

// ---- governance
add('GET', '/api/packs', ({ t }) => V.packRows(t));
add('POST', '/api/packs/:key/activate', ({ t, user, p, body }) => { R.activatePack(t, user, p.key, body); return { ok: true }; });
add('POST', '/api/packs/:key/mode', ({ t, user, p, body }) => { E.setMode(t, user, p.key, body.mode); return { ok: true }; });
add('GET', '/api/controls', ({ t, user }) => ({
  controls: R.effectiveControls(t).filter((c) => !c.restricted || P.canSeeRestricted(user)).map((c) => ({ key: c.key, name: c.name, pack: c.pack_key, requirement_type: c.requirement_type, type: c.type, version: c.version_label, overridden: !!c.overridden, custom: !!c.custom, remediation: c.remediation, params: c.params })),
  changes: db.all('SELECT * FROM control_changes WHERE tenant_id=? ORDER BY created_at DESC', t)
    .filter((c) => P.canPack(user, c.pack_key) && (!R.packDef(c.pack_key)?.restricted || P.canSeeRestricted(user)))
    .map((c) => ({ ...c, preview: j(c.preview_json) })),
}));
add('POST', '/api/controls/draft', ({ t, user, body }) => { edit(user); return R.draftControl(t, user, body, E.loadCtx); });
add('POST', '/api/controls/:id/submit', ({ t, user, p }) => { edit(user); R.submitDraft(t, user, p.id); return { ok: true }; });
add('GET', '/api/approvals', ({ t, user, q }) => V.listApprovals(t, user, q.get('status') || 'pending'));
add('POST', '/api/approvals/:id/decide', ({ t, user, p, body }) => { const a = db.get('SELECT * FROM approvals WHERE id=? AND tenant_id=?', p.id, t); if (!a) throw new HttpError(404, 'Approval not found.'); E.decide(t, user, a, body.decision, body.note); return { ok: true }; });

// ---- setup
add('GET', '/api/setup', ({ t }) => V.setupState(t));
const setS = (t, patch) => { const tn = db.get('SELECT setup_json s FROM tenants WHERE id=?', t); db.update('tenants', t, { setup_json: JSON.stringify({ ...j(tn.s, {}), ...patch }) }); };
add('POST', '/api/setup/facility/:id', ({ t, user, p, body }) => { P.assertAdmin(user); const f = db.get('SELECT * FROM facilities WHERE id=? AND tenant_id=?', p.id, t); if (!f) throw new HttpError(404, 'Facility not found.'); db.update('facilities', f.id, { requirements_json: JSON.stringify(body.requirements || []), requirements_confirmed: 1, requirement_source: body.source || 'Confirmed by administrator', state: body.state || f.state }); P.audit(t, 'CONTEXT_CONFIRMED', f.name, `Facility requirements confirmed: ${(body.requirements || []).join(', ') || 'none'}.`, user); P.enqueue(t, 'evaluate_tenant', { trigger: 'context_confirmed' }, { dedupe: `eval_tenant:${t}` }); return { ok: true }; });
add('POST', '/api/setup/context', ({ t, user }) => { P.assertAdmin(user); db.run('UPDATE entities SET confirmed=1 WHERE tenant_id=?', t); setS(t, { context_confirmed: true }); P.audit(t, 'CONTEXT_CONFIRMED', 'Company profile', 'Administrator confirmed employing entities and work locations.', user); return { ok: true }; });
add('POST', '/api/setup/channel', ({ t, user, body }) => { P.assertAdmin(user); if (body.type === 'slack') { W.requireVerified(t); if (!Slack.configured(t)) throw new HttpError(409, 'Connect Slack on the Integrations page first.'); } db.update('tenants', t, { channel_json: JSON.stringify({ type: body.type === 'slack' ? 'slack' : 'outbox', channel: body.channel || '#compliance-alerts' }) }); setS(t, { channel_confirmed: true }); P.audit(t, 'CHANNEL_SET', 'Reporting channel', `Reporting channel set to ${body.type || 'outbox'}.`, user); return { ok: true }; });
add('POST', '/api/setup/assess', async ({ t, user }) => { P.assertAdmin(user); E.evaluateTenant(t, 'initial_assessment'); await P.drain(); return V.coverage(t); });

// ---- connectors
// HRMS settings are described at the top of the HRMS section in connectors.js. Keys are write-only:
// they are stored encrypted and never returned.
const getCon = (t, cid) => { const c = db.get('SELECT * FROM connectors WHERE id=? AND tenant_id=?', cid, t); if (!c) throw new HttpError(404, 'Connector not found.'); return c; };
const webhookUrl = (t) => `${(process.env.AEGIS_BASE_URL || '').replace(/\/+$/, '')}/api/webhooks/hrms/${db.get('SELECT slug FROM tenants WHERE id=?', t).slug}`;
const conRow = (t, c) => ({ id: c.id, type: c.type, name: c.name, status: c.status, last_sync_at: c.last_sync_at, last_error: c.last_error, records: c.records, has_cursor: !!c.cursor, capabilities: j(c.capabilities_json, []), settings: C.publicConfig(C.configOf(c)), webhook_url: webhookUrl(t) });
const settingsOf = (body) => { const { name, ...s } = body; return s; };
add('GET', '/api/connectors', ({ t, user }) => { P.assertAdmin(user); return db.all('SELECT * FROM connectors WHERE tenant_id=? ORDER BY name', t).map((c) => conRow(t, c)); });
add('POST', '/api/connectors', ({ t, user, body }) => {
  P.assertAdmin(user);
  const cfg = C.validateConfig(settingsOf(body));
  const c = C.createConnector(t, { type: 'hrms', name: String(body.name || 'HRMS').slice(0, 120), config: cfg, capabilities: ['workers', 'scheduled_import', 'incremental_sync', 'webhooks'] });
  P.audit(t, 'CONNECTOR_ADDED', c.name, `HRMS connector added for ${cfg.base_url}.`, user);
  return { id: c.id };
});
// Tests settings before saving them. Nothing is stored.
add('POST', '/api/connectors/test', async ({ user, body }) => { P.assertAdmin(user); return C.testConnection(C.validateConfig(settingsOf(body))); });
add('POST', '/api/connectors/webhook-secret', ({ t, user }) => {
  P.assertAdmin(user);
  const secret = crypto.randomBytes(32).toString('hex');
  db.update('tenants', t, { webhook_secret: secret });
  P.audit(t, 'WEBHOOK_SECRET_ROTATED', 'HRMS webhooks', 'A new webhook signing secret was created. The old one stopped working.', user);
  return { secret, webhook_url: webhookUrl(t), signature: 'HMAC-SHA256 of the raw body, sent as "sha256=<hex>" in the X-Aegis-Signature header' };
});
add('POST', '/api/connectors/:id', ({ t, user, p, body }) => {
  P.assertAdmin(user);
  const c = getCon(t, p.id), cfg = C.validateConfig(settingsOf(body), C.configOf(c));
  C.saveConfig(c, cfg);
  db.update('connectors', c.id, { name: body.name ? String(body.name).slice(0, 120) : c.name, last_error: null, ...(c.status === 'error' ? { status: 'connected' } : {}) });
  P.audit(t, 'CONNECTOR_UPDATED', c.name, `Settings changed: ${Object.keys(settingsOf(body)).map((k) => (/key|password/.test(k) ? `${k} (hidden)` : k)).join(', ') || 'name'}.`, user);
  return conRow(t, getCon(t, c.id));
});
add('POST', '/api/connectors/:id/test', async ({ t, user, p, body }) => {
  P.assertAdmin(user);
  const saved = C.configOf(getCon(t, p.id));
  return C.testConnection(C.validateConfig(settingsOf(body), saved));
});
add('POST', '/api/connectors/:id/enable', ({ t, user, p }) => { P.assertAdmin(user); const c = getCon(t, p.id); db.update('connectors', c.id, { status: 'connected', last_error: null }); P.audit(t, 'CONNECTOR_ENABLED', c.name, 'Connector turned on.', user); return { ok: true }; });
add('POST', '/api/connectors/:id/disable', ({ t, user, p }) => { P.assertAdmin(user); const c = getCon(t, p.id); db.update('connectors', c.id, { status: 'disabled' }); P.audit(t, 'CONNECTOR_DISABLED', c.name, 'Connector turned off. Scheduled syncs and webhooks stop.', user); return { ok: true }; });
// Forgets the saved position, so the next sync reads every worker again. Safe: records are matched, not duplicated.
add('POST', '/api/connectors/:id/full-resync', async ({ t, user, p }) => { P.assertAdmin(user); const c = getCon(t, p.id); db.update('connectors', c.id, { cursor: null, last_sync_at: null }); P.audit(t, 'CONNECTOR_RESET', c.name, 'Full resync requested.', user); const r = await C.syncConnector(t, c.id, user); P.drain(); return r; });
add('POST', '/api/connectors/:id/sync', async ({ t, user, p }) => { edit(user); const r = await C.syncConnector(t, p.id, user); P.drain(); return r; });
add('POST', '/api/import/preview', ({ t, user, body }) => { edit(user); return C.previewImport(t, user, file(body)); });
add('POST', '/api/import/:id/commit', ({ t, user, p }) => { edit(user); const r = C.commitImport(t, user, p.id); return r; });
add('GET', '/api/health', ({ t, user }) => { P.assertAdmin(user); return V.health(t); });
add('GET', '/api/messages', ({ t, user }) => { P.assertAdmin(user); return db.all('SELECT * FROM messages WHERE tenant_id=? ORDER BY created_at DESC LIMIT 100', t); });

// ---- reporting
add('GET', '/api/audit', ({ t, user }) => { P.assertAdmin(user); return db.all('SELECT * FROM audit_log WHERE tenant_id=? ORDER BY seq DESC LIMIT 300', t); });
// Audit search: by kind of event, by text (person, subject or what happened) and by UTC date,
// newest first, a page at a time. "before" is the last sequence number already shown.
const AUDIT_KINDS = {
  checks: ['CHECK_RESULT'],
  cases: ['CASE_OPENED', 'CASE_STATE', 'CASE_NOTE', 'CASE_ESCALATED', 'CASE_CLOSED', 'FINDING_REVIEWED'],
  evidence: ['EVIDENCE_MATCHED', 'EVIDENCE_ACCEPTED', 'EVIDENCE_REJECTED', 'EVIDENCE_REVIEW', 'EVIDENCE_VIEWED', 'EVIDENCE_RECEIVED'],
  approvals: ['APPROVAL_REQUESTED', 'APPROVAL_DECIDED', 'APPROVAL_UPDATED', 'READINESS_REOPENED'],
  messages: ['ACTION_SENT', 'MESSAGE_SENT', 'DIGEST_SENT', 'DIGEST_OUTBOX', 'DIGEST_FAILED', 'CHAT_COMMAND', 'SLACK_TEST'],
  records: ['WORKER_ADDED', 'ROSTER_IMPORT', 'ASSIGNMENT_CHANGED', 'HRMS_EVENT', 'HRMS_SYNC'],
};
add('GET', '/api/audit/search', ({ t, user, q }) => {
  P.assertAdmin(user);
  const where = ['tenant_id=?'], args = [t], kind = q.get('kind') || '';
  if (kind === 'settings') { const known = Object.values(AUDIT_KINDS).flat(); where.push(`type NOT IN (${known.map(() => '?').join(',')})`); args.push(...known); }
  else if (AUDIT_KINDS[kind]) { where.push(`type IN (${AUDIT_KINDS[kind].map(() => '?').join(',')})`); args.push(...AUDIT_KINDS[kind]); }
  const text = String(q.get('q') || '').trim().slice(0, 100);
  // lower() on both sides: LIKE ignores case in SQLite but not in PostgreSQL.
  if (text) { where.push("(lower(subject) LIKE ? ESCAPE '!' OR lower(action) LIKE ? ESCAPE '!' OR lower(actor) LIKE ? ESCAPE '!')"); const like = `%${text.toLowerCase().replace(/[!%_]/g, (c) => `!${c}`)}%`; args.push(like, like, like); }
  const day = (k) => (/^\d{4}-\d{2}-\d{2}$/.test(q.get(k) || '') ? q.get(k) : null);
  if (day('from')) { where.push('ts >= ?'); args.push(`${day('from')}T00:00:00`); }
  if (day('to')) { where.push('ts < ?'); args.push(`${V.addDays(day('to'), 1)}T00:00:00`); }
  const before = Number(q.get('before')) || 0;
  if (before) { where.push('seq < ?'); args.push(before); }
  const limit = Math.min(Math.max(Number(q.get('limit')) || 100, 1), 200);
  const rows = db.all(`SELECT * FROM audit_log WHERE ${where.join(' AND ')} ORDER BY seq DESC LIMIT ?`, ...args, limit + 1);
  const total = db.get(`SELECT COUNT(*) AS n FROM audit_log WHERE ${where.filter((w) => !w.startsWith('seq <')).join(' AND ')}`, ...args.slice(0, before ? -1 : undefined)).n;
  return { rows: rows.slice(0, limit), has_more: rows.length > limit, total };
});
add('GET', '/api/audit/verify', ({ t, user }) => { P.assertAdmin(user); return P.verifyAudit(t); });
add('GET', '/api/audit/export', ({ t, user, res }) => { P.assertAdmin(user); res.writeHead(200, { 'content-type': 'application/json', 'content-disposition': 'attachment; filename="aegis-audit.json"' }); res.end(JSON.stringify({ verification: P.verifyAudit(t), entries: db.all('SELECT * FROM audit_log WHERE tenant_id=? ORDER BY seq', t) }, null, 1)); return res; });
add('GET', '/api/reports/:pack/data', ({ t, user, p }) => V.reportData(t, user, p.pack));
add('GET', '/api/digest', ({ t, user }) => { P.assertAdmin(user); return V.digestInfo(t); });
add('GET', '/api/reports/:pack', ({ t, user, p, res }) => { res.writeHead(200, { 'content-type': 'text/csv', 'content-disposition': `attachment; filename="aegis-${p.pack.replace(/\W/g, '')}.csv"` }); res.end(V.reportCsv(t, user, p.pack)); return res; });
// Only known values are saved, so a view can never ask for something the data cannot answer.
const dashDef = (b) => {
  const metric = ['open_gaps', 'missing_evidence', 'expirations', 'coverage'].includes(b.metric) ? b.metric : 'open_gaps';
  const group_by = ['facility', 'team', 'pack', 'status', 'control', 'window'].includes(b.group_by) && (b.group_by !== 'window' || metric === 'expirations') ? b.group_by : 'facility';
  const pack = ['healthcare', 'onboarding', 'immigration', 'payroll'].includes(b.pack) ? b.pack : null;
  return { pack, metric, group_by, ...(metric === 'expirations' && b.within_days ? { within_days: Math.min(Math.max(Number(b.within_days) || 90, 1), 365) } : {}) };
};
// Each dashboard comes with its headline numbers so the list can show them without opening it.
add('GET', '/api/dashboards', ({ t, user }) => V.dashboardsFor(t, user).map((d) => {
  const definition = j(d.definition_json), data = V.dashboardData(t, user, definition);
  return { ...d, definition, roles: j(d.roles_json), summary: { total: data.total, split: data.split, groups: data.groups.map((g) => ({ name: g.name, count: g.count })) } };
}));
add('POST', '/api/dashboards', ({ t, user, body }) => { edit(user); const did = id('dash'); db.insert('dashboards', { id: did, tenant_id: t, name: String(body.name || 'Dashboard').slice(0, 120), definition_json: JSON.stringify(dashDef(body)), roles_json: JSON.stringify(body.roles?.length ? body.roles : [user.role]), created_by: user.name, created_at: clock.iso() }); P.audit(t, 'DASHBOARD_CREATED', String(body.name || 'Dashboard').slice(0, 120), 'Saved from the Dashboards page.', user); return { id: did }; });
add('POST', '/api/dashboards/:id/delete', ({ t, user, p }) => {
  edit(user);
  const d = db.get('SELECT * FROM dashboards WHERE id=? AND tenant_id=?', p.id, t);
  if (!d) throw new HttpError(404, 'Saved view not found. Built-in dashboards cannot be deleted.');
  if (!P.isAdmin(user) && d.created_by !== user.name) throw new HttpError(403, 'Only the person who saved this view or an administrator can delete it.');
  db.run('DELETE FROM dashboards WHERE id=? AND tenant_id=?', p.id, t);
  P.audit(t, 'DASHBOARD_DELETED', d.name, 'Saved view deleted.', user);
  return { ok: true };
});
add('GET', '/api/dashboards/:id', ({ t, user, p }) => { const d = V.dashboardsFor(t, user).find((x) => x.id === p.id); if (!d) throw new HttpError(403, 'You do not have access to this dashboard.'); const def = j(d.definition_json); return { ...d, definition: def, data: V.dashboardData(t, user, def) }; });
add('GET', '/api/metrics', ({ t }) => V.metrics(t));
add('POST', '/api/metrics/baseline', ({ t, user, body }) => { P.assertAdmin(user); db.run('INSERT INTO baselines(tenant_id,key,value,note,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(tenant_id,key) DO UPDATE SET value=excluded.value,note=excluded.note,updated_at=excluded.updated_at', t, String(body.key), +body.value, body.note || null, clock.iso()); return { ok: true }; });
add('POST', '/api/metrics/manual-support', ({ t, user, body }) => { edit(user); db.insert('manual_support', { id: id('ms'), tenant_id: t, minutes: +body.minutes, note: body.note || null, created_by: user.name, created_at: clock.iso() }); return { ok: true }; });
add('GET', '/api/notices', ({ t, user }) => { P.assertPack(user, 'payroll'); return db.all('SELECT * FROM notices WHERE tenant_id=? ORDER BY created_at DESC', t); });
add('POST', '/api/notices', ({ t, user, body }) => {
  P.assertPack(user, 'payroll');
  const n = { id: id('ntc'), tenant_id: t, entity_id: body.entity_id || null, agency: body.agency, notice_type: body.notice_type, received_on: body.received_on || clock.today(), response_due: body.response_due, summary: body.summary, status: 'draft_awaiting_approval', created_by: user.name, created_at: clock.iso() };
  n.draft_response = `DRAFT for finance review. Not filed or sent.\n\nRe: ${n.notice_type} from ${n.agency}, received ${n.received_on}.\n\nWe acknowledge the notice and are reviewing the matter described: ${n.summary}\n\n[Finance to confirm facts, amounts and supporting documents before any response is sent.]`;
  db.insert('notices', n);
  E.requestDecision(t, user, 'notice_response', null, `Notice response: ${n.agency} ${n.notice_type}`, `Respond by ${n.response_due || 'date not given'}. ${n.summary}`, 'payroll', n.id);
  return n;
});
add('GET', '/api/chat', ({ t, user, q, res }) => {
  res.setHeader('cache-control', 'no-store');
  return Chat.history(t, user, q.get('chat_id') ?? undefined);
});
add('GET', '/api/chat/conversations', ({ t, user, res }) => {
  res.setHeader('cache-control', 'no-store');
  return Chat.conversations(t, user);
});
add('POST', '/api/chat', ({ t, user, body, res }) => {
  res.setHeader('cache-control', 'no-store');
  if (typeof body?.text !== 'string' || !body.text.trim()) throw new HttpError(400, 'Message is required.');
  const text = body.text.trim();
  if (text.length > 1000) throw new HttpError(400, 'Keep the message to 1,000 characters or fewer.');
  const chatId = body.chat_id;
  if (chatId !== undefined && chatId !== null && (typeof chatId !== 'string' || !/^conv_[a-f0-9]{12}$/.test(chatId))) {
    throw new HttpError(400, 'Choose a conversation or start a new one.');
  }
  return Chat.handle(t, user, text, { requestedChatId: chatId });
});
add('GET', '/api/coworker/settings', ({ t, user }) => {
  P.assertAdmin(user);
  return CoworkerPolicy.settings(t);
});
add('POST', '/api/coworker/settings', ({ t, user, body }) => {
  P.assertAdmin(user);
  return CoworkerPolicy.save(t, user, body);
});
add('GET', '/api/users', ({ t, user }) => { P.assertAdmin(user); return db.all('SELECT id,name,email,role,slack_id FROM users WHERE tenant_id=? ORDER BY name', t); });
add('POST', '/api/users', ({ t, user, body }) => { P.assertAdmin(user); if (!P.ROLE_PACKS[body.role]) throw new HttpError(400, 'Invalid role.'); if (!body.email || String(body.password || '').length < 8) throw new HttpError(400, 'Email and an 8+ character password are required.'); const uid = id('usr'); try { db.insert('users', { id: uid, tenant_id: t, email: body.email, name: body.name || body.email, role: body.role, password_hash: hashPassword(body.password), slack_id: body.slack_id || null, created_at: clock.iso() }); } catch { throw new HttpError(409, 'That email is already in use.'); } P.audit(t, 'USER_ADDED', body.email, `Added with role ${body.role}.`, user); return { id: uid }; });
add('GET', '/api/owners', ({ t }) => db.all('SELECT id,name,role FROM users WHERE tenant_id=? ORDER BY name', t));
add('POST', '/api/digest/send', async ({ t, user }) => {
  P.assertAdmin(user);
  W.requireVerified(t);
  const tn = db.get('SELECT * FROM tenants WHERE id=?', t), body = V.digestText(t);
  let via;
  try { via = await channels.post(tn, j(tn.channel_json, {}).channel || '#compliance-alerts', 'Compliance digest', body); }
  catch (e) {
    P.audit(t, 'DIGEST_FAILED', 'Digest', 'Digest delivery failed.', user);
    throw new HttpError(502, e.message);
  }
  if (via === 'slack') P.audit(t, 'DIGEST_SENT', 'Digest', 'Digest posted to Slack.', user);
  else P.audit(t, 'DIGEST_OUTBOX', 'Digest', 'Digest saved to the Aegis outbox.', user);
  return { body, via };
});

// ---- AI engine: keys are write-only and stored encrypted
add('GET', '/api/ai', ({ t, user }) => { P.assertAdmin(user); return llm.status(t); });
add('POST', '/api/ai', async ({ t, user, body }) => {
  P.assertAdmin(user);
  const cfg = llm.providerConfig(body, user);
  try { await llm.test(t, cfg); } catch (e) { throw new HttpError(422, e.name === 'TimeoutError' ? 'The AI provider timed out.' : e.message); }
  llm.save(t, cfg);
  P.audit(t, 'AI_CONFIGURED', 'AI engine', `AI provider set to ${llm.PROVIDERS[cfg.provider].label}. Document sharing approved by ${user.name}.`, user);
  return llm.status(t);
});
add('POST', '/api/ai/test', async ({ t, user }) => {
  P.assertAdmin(user);
  const s = llm.status(t);
  if (!s.configured) throw new HttpError(400, 'No AI key is set.');
  if (!await llm.testSaved(t)) throw new HttpError(502, llm.lastError(t)?.message || 'The provider did not confirm the connection.');
  return { ok: true, provider: s.provider_label };
});
add('POST', '/api/ai/remove', ({ t, user }) => { P.assertAdmin(user); llm.remove(t); P.audit(t, 'AI_CONFIGURED', 'AI engine', 'AI key removed.', user); return llm.status(t); });

// ---- Integrations page: chat connections. Keys are write-only, tested before saving and stored encrypted.
const alertsChannel = (t) => j(db.get('SELECT channel_json FROM tenants WHERE id=?', t).channel_json, {});
const TEAMS = { available: false, needs: ['App ID', 'Client secret', 'Tenant ID'], note: 'Teams is being built. Your Microsoft 365 administrator registers the Aegis bot in the Teams Developer Portal and gives you these three values.' };
const integrations = (t) => { const ch = alertsChannel(t); return { slack: Slack.status(t, ch.type === 'slack' ? ch.channel : null), email: { configured: channels.emailConfigured() }, teams: TEAMS, events_url: `${(process.env.AEGIS_BASE_URL || '').replace(/\/+$/, '')}/api/webhooks/slack/${db.get('SELECT slug FROM tenants WHERE id=?', t).slug}` }; };
add('GET', '/api/integrations', ({ t, user }) => { P.assertAdmin(user); return integrations(t); });
add('POST', '/api/integrations/slack', async ({ t, user, body }) => {
  P.assertAdmin(user);
  const channel = String(body.channel || '#compliance-alerts').trim();
  if (!/^#?[a-z0-9][a-z0-9._-]{0,79}$/.test(channel) && !/^[CG][A-Z0-9]{6,}$/.test(channel)) throw new HttpError(400, 'Enter a Slack channel name like #compliance-alerts.');
  let r;
  try { r = await Slack.save(t, user, body); } catch (e) { throw new HttpError(422, e.message); }
  db.update('tenants', t, { channel_json: JSON.stringify({ type: 'slack', channel: channel.startsWith('#') || /^[CG][A-Z0-9]{6,}$/.test(channel) ? channel : `#${channel}` }) });
  setS(t, { channel_confirmed: true });
  Slack.startSocket(t);
  P.audit(t, r.replaced ? 'SLACK_UPDATED' : 'SLACK_CONNECTED', 'Slack', `Slack workspace ${r.team} ${r.replaced ? 'keys updated' : 'connected'}. Alerts go to ${alertsChannel(t).channel}.${r.app_token ? ' Chat uses Socket Mode.' : ''}`, user);
  return integrations(t);
});
add('POST', '/api/integrations/slack/test', async ({ t, user }) => {
  P.assertAdmin(user);
  const ch = alertsChannel(t);
  let r;
  try { r = await Slack.test(t, ch.type === 'slack' ? ch.channel : null); } catch (e) { throw new HttpError(422, e.message); }
  P.audit(t, 'SLACK_TEST', 'Slack', r.ok ? `Test message posted to ${r.channel}.` : `Test failed: ${r.error}`, user);
  return r;
});
add('POST', '/api/integrations/slack/remove', ({ t, user }) => {
  P.assertAdmin(user);
  if (Slack.config(t)?.source !== 'settings') throw new HttpError(409, 'These Slack keys are set on the server (.env), so they can only be removed there.');
  Slack.remove(t);
  db.update('tenants', t, { channel_json: JSON.stringify({ type: 'outbox', channel: alertsChannel(t).channel || '#compliance-alerts' }) });
  P.audit(t, 'SLACK_REMOVED', 'Slack', 'Slack disconnected. Messages stay in the Aegis outbox until a chat tool is connected.', user);
  return integrations(t);
});

// ---- demo controls
add('POST', '/api/demo/hrms-event', async ({ t, user, body }) => { P.assertAdmin(user); if (!demo()) throw new HttpError(404, 'Not found.'); const tn = db.get('SELECT * FROM tenants WHERE id=?', t); if (tn.slug !== 'bluebix') throw new HttpError(400, 'The mock HRMS is connected to Bluebix only.'); const r = await mock.emit(tn.slug, tn.webhook_secret, body.kind); await P.drain(); return { type: r.type, worker: r.worker, status: r.status }; });
add('POST', '/api/demo/advance', async ({ t, user, body }) => { P.assertAdmin(user); if (!demo() || W.verification(t)) throw new HttpError(404, 'Not found.'); clock.advanceDays(Math.min(+body.days || 1, 60)); E.runReminders(t); E.evaluateTenant(t, 'scheduled_check'); await P.drain(); E.runReminders(t); await P.drain(); return { today: clock.today() }; });
add('POST', '/api/demo/reset', async ({ t, user }) => { P.assertAdmin(user); if (!sandbox.isActive() || W.verification(t)) throw new HttpError(404, 'Not found.'); clock.reset(); db.resetAll(); R.loadPacks(); await require('./seed').seed(); return { ok: true }; });
module.exports = { routes };
