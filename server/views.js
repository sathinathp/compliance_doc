'use strict';
// Read models. Dashboards, reports and chat all use these same queries, so they cannot disagree.
const db = require('./lib/db'), { clock, j, daysBetween, addDays, csvCell } = require('./lib/util');
const P = require('./platform'), R = require('./registry'), E = require('./engine');
const { canSeeRestricted } = P;
const llm = require('./llm'), Ev = require('./evidence'), docread = require('./lib/docread');
const isoDay = 864e5;

function controlMap(t) {
  const m = {};
  for (const c of R.effectiveControls(t)) m[c.key] = c;
  return m;
}
function allChecks(t) {
  const cm = controlMap(t);
  const fac = {};
  for (const r of db.all(`SELECT a.worker_id, f.name FROM assignments a JOIN facilities f ON f.id=a.facility_id WHERE a.tenant_id=? AND a.status='active'`, t)) fac[r.worker_id] = r.name;
  const names = {};
  for (const r of db.all('SELECT id,name,status FROM workers WHERE tenant_id=?', t)) names[r.id] = r.name;
  for (const r of db.all('SELECT id,name FROM entities WHERE tenant_id=?', t)) names[r.id] = r.name;
  return db.all('SELECT * FROM evaluations WHERE tenant_id=? AND is_current=1', t).filter((e) => cm[e.control_key]).map((e) => ({
    id: e.id, subject_type: e.subject_type, subject_id: e.subject_id, subject_name: names[e.subject_id] || e.subject_id, facility: e.subject_type === 'worker' ? fac[e.subject_id] || 'No location assigned' : 'Company level', pack_key: e.pack_key, pack_name: cm[e.control_key].pack_name, team: cm[e.control_key].team, restricted: cm[e.control_key].restricted, control_key: e.control_key, control_name: cm[e.control_key].name, requirement_type: cm[e.control_key].requirement_type, control_version: e.control_version, status: e.status, code: e.code, reason: e.reason, evidence_ids: j(e.evidence_ids_json, []), action_needed: !!e.action_needed, evaluated_at: e.evaluated_at,
  }));
}
function checks(t, user, f = {}) {
  let rows = allChecks(t).filter((c) => !c.restricted || canSeeRestricted(user));
  if (f.status) rows = rows.filter((c) => c.status === f.status);
  if (f.pack) rows = rows.filter((c) => c.pack_key === f.pack);
  if (f.subject) rows = rows.filter((c) => c.subject_id === f.subject);
  return rows;
}
function tally(rows) {
  const o = { total: 0, pass: 0, fail: 0, unknown: 0, not_applicable: 0 };
  for (const r of rows) { o[r.status]++; if (r.status !== 'not_applicable') o.total++; }
  return o;
}
function packRows(t) {
  const all = allChecks(t), tps = db.all('SELECT * FROM tenant_packs WHERE tenant_id=?', t), users = {};
  for (const u of db.all('SELECT id,name FROM users WHERE tenant_id=?', t)) users[u.id] = u.name;
  return R.allPacks().map((p) => {
    const tp = tps.find((x) => x.pack_key === p.key), rows = all.filter((c) => c.pack_key === p.key), a = tally(rows);
    return { key: p.key, name: p.name, icon: p.icon, description: p.description, version: tp?.version || p.version, latest_version: p.version, pilot: !!p.pilot, team: p.team, owner_role: p.owner_role, status: tp?.status || 'inactive', mode: tp?.mode || null, owner: users[tp?.owner_user_id] || null, owner_user_id: tp?.owner_user_id || null, reviewed_by: tp?.reviewed_by || null, activated_at: tp?.activated_at || null, ...a, open_cases: db.get(`SELECT COUNT(*) n FROM cases WHERE tenant_id=? AND pack_key=? AND ${E.OPEN}`, t, p.key).n, unvalidated: db.get(`SELECT COUNT(*) n FROM cases WHERE tenant_id=? AND pack_key=? AND ${E.OPEN} AND finding_verdict IS NULL`, t, p.key).n, controls: p.controls.map((c) => ({ key: c.key, name: c.name, requirement_type: c.requirement_type, source: c.source, type: c.type, schedule: c.remediation })), review_note: p.review_note, validation: p.validation };
  });
}
function coverage(t) {
  const rows = allChecks(t), a = tally(rows), packs = packRows(t).filter((p) => p.status === 'active');
  return { ...a, packs: packs.map((p) => p.name), as_of: clock.iso(), scope_statement: packs.length ? `${a.total} applicable checks in ${packs.length} activated pack(s). Obligations outside these packs have not been assessed.` : 'No packs are activated, so nothing has been assessed.', all_pass: a.total > 0 && a.pass === a.total };
}
function listCases(t, user, f = {}) {
  let rows = db.all(`SELECT c.*, u.name owner_name FROM cases c LEFT JOIN users u ON u.id=c.owner_user_id WHERE c.tenant_id=? ${f.closed ? 'AND c.closed_at IS NOT NULL' : 'AND c.closed_at IS NULL'} ORDER BY CASE c.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, c.due_date`, t);
  rows = rows.filter((c) => !c.restricted || canSeeRestricted(user));
  if (f.pack) rows = rows.filter((c) => c.pack_key === f.pack);
  return rows;
}
function caseDetail(t, user, cid) {
  const c = db.get('SELECT c.*, u.name owner_name FROM cases c LEFT JOIN users u ON u.id=c.owner_user_id WHERE c.id=? AND c.tenant_id=?', cid, t);
  if (!c) throw new P.HttpError(404, 'Case not found.');
  if (c.restricted && !canSeeRestricted(user)) throw new P.HttpError(403, 'This case is restricted.');
  const ev = db.get('SELECT * FROM evaluations WHERE tenant_id=? AND subject_type=? AND subject_id=? AND control_key=? AND is_current=1', t, c.subject_type, c.subject_id, c.control_key);
  // can_act tells the screen whether to offer follow-up, verdict and decision buttons. The routes check again.
  const related = db.all('SELECT id,filename,status,doc_type,expires_on,confidence,review_reasons_json,created_at,restricted FROM evidence WHERE tenant_id=? AND subject_type=? AND subject_id=? AND (control_key=? OR case_id=?) ORDER BY created_at DESC', t, c.subject_type, c.subject_id, c.control_key, cid);
  const hidden = new Set(related.filter((x) => !Ev.canView(user, x)).map((x) => x.id));
  const evidence = related.filter((x) => !hidden.has(x.id)).map((x) => ({ ...x, review_reasons: j(x.review_reasons_json, []) }));
  const evidenceIds = ev ? j(ev.evidence_ids_json, []).filter((id) => !hidden.has(id)) : [];
  return { ...c, can_act: user.role !== 'viewer' && P.canPack(user, c.pack_key), closure_evidence_id: hidden.has(c.closure_evidence_id) ? null : c.closure_evidence_id, evaluation: ev ? { ...ev, evidence_ids_json: JSON.stringify(evidenceIds), evidence_ids: evidenceIds } : null, timeline: db.all('SELECT ts,type,action,actor FROM audit_log WHERE tenant_id=? AND case_id=? ORDER BY seq', t, cid), actions: db.all('SELECT id,type,status,recipient,subject,sent_at,created_at,error FROM actions WHERE case_id=? AND tenant_id=? ORDER BY created_at', cid, t), notes: db.all('SELECT * FROM case_notes WHERE case_id=? AND tenant_id=? ORDER BY created_at', cid, t), evidence };
}
const ROLL = (rows) => !rows.length ? 'not_applicable' : rows.some((r) => r.status === 'fail') ? 'fail' : rows.some((r) => r.status === 'unknown') ? 'unknown' : rows.every((r) => r.status === 'not_applicable') ? 'not_applicable' : 'pass';
function listWorkers(t, user) {
  const all = checks(t, user), facs = {};
  for (const r of db.all(`SELECT a.worker_id, f.name, f.state FROM assignments a JOIN facilities f ON f.id=a.facility_id WHERE a.tenant_id=? AND a.status='active'`, t)) facs[r.worker_id] = r;
  return db.all('SELECT * FROM workers WHERE tenant_id=? ORDER BY name', t).map((w) => {
    const mine = all.filter((c) => c.subject_type === 'worker' && c.subject_id === w.id), packs = {};
    for (const k of ['onboarding', 'healthcare', 'immigration', 'payroll']) packs[k] = (k === 'immigration' && !canSeeRestricted(user)) ? 'restricted' : ROLL(mine.filter((c) => c.pack_key === k));
    const applicable = mine.filter((c) => c.status !== 'not_applicable');
    return { id: w.id, name: w.name, email: w.email, role: w.role, category: w.category, dept: w.dept, status: w.status, hire_date: w.hire_date, source: w.source, readiness: w.readiness, facility: facs[w.id]?.name || null, state: facs[w.id]?.state || null, packs, checks: tally(mine), overall: !applicable.length ? 'not_assessed' : ROLL(applicable) };
  });
}
function workerDetail(t, user, wid) {
  const w = listWorkers(t, user).find((x) => x.id === wid);
  if (!w) throw new P.HttpError(404, 'Worker not found.');
  const ch = checks(t, user, { subject: wid }), blockers = ch.filter((c) => c.status === 'fail' || c.status === 'unknown');
  const summary = ['onboarding', 'healthcare', 'immigration', 'payroll'].map((k) => ({ pack: k, status: w.packs[k], open: ch.filter((c) => c.pack_key === k && ['fail', 'unknown'].includes(c.status)).length }));
  return { ...w, checks_list: ch, cases: listCases(t, user).filter((c) => c.subject_id === wid), readiness_view: { summary, blockers: blockers.map((b) => ({ control: b.control_name, pack: b.pack_key, status: b.status, reason: b.reason })), statement: readinessStatement(w, blockers) }, readiness_request: db.get("SELECT id, requested_by, created_at FROM approvals WHERE tenant_id=? AND kind='readiness_decision' AND ref_id=? AND status='pending' ORDER BY created_at DESC LIMIT 1", t, wid) || null };
}
// Plain words for the worker window and for the approver. Open checks are named.
function readinessStatement(w, blockers) {
  if (!w.checks.total) return 'No checks have been run yet.';
  if (!blockers.length && w.packs.immigration === 'restricted') return 'Visible checks pass. An authorized owner can review the full record.';
  if (!blockers.length) return w.readiness === 'approved' ? 'All checks in activated packs pass. Approved for assignment by an owner.' : w.readiness === 'blocked' ? 'All checks in activated packs pass. An owner blocked the assignment; ask again for a new decision.' : 'All checks in activated packs pass. An authorized owner makes the readiness decision.';
  const n = blockers.length, open = `${n} check${n === 1 ? '' : 's'} unresolved (${blockers.map((b) => b.control_name).join(', ')})`;
  return w.readiness === 'approved' ? `Approved by an owner with ${open}.` : w.readiness === 'blocked' ? `Blocked by an owner. ${open[0].toUpperCase()}${open.slice(1)}.` : `Readiness pending: ${open}.`;
}
function listEvidence(t, user, { acceptedFrom, acceptedThrough } = {}) {
  const names = {};
  const controls = controlMap(t);
  for (const r of db.all('SELECT id,name FROM workers WHERE tenant_id=? UNION SELECT id,name FROM entities WHERE tenant_id=?', t, t)) names[r.id] = r.name;
  const rows = acceptedFrom && acceptedThrough
    ? db.all("SELECT * FROM evidence WHERE tenant_id=? AND status='accepted' AND expires_on BETWEEN ? AND ? ORDER BY expires_on,created_at DESC", t, acceptedFrom, acceptedThrough)
    : db.all('SELECT * FROM evidence WHERE tenant_id=? ORDER BY created_at DESC', t);
  return rows.filter((e) => Ev.canView(user, e)).map((e) => ({ id: e.id, subject_name: names[e.subject_id], subject_type: e.subject_type, subject_id: e.subject_id, doc_type: e.doc_type, status: e.status, source: e.source, filename: e.filename, doc_number: e.doc_number, holder_name: e.holder_name, state: e.state, entity_name: e.entity_name, period: e.period, issued_on: e.issued_on, expires_on: e.expires_on, confidence: e.confidence, field_confidence: j(e.fields_json, {}), review_reasons: j(e.review_reasons_json, []), flags: j(e.flags_json, []), control_key: e.control_key, reviewed_by: e.reviewed_by, reject_reason: e.reject_reason, created_at: e.created_at, has_file: !!e.stored_path, preview: e.stored_path ? docread.previewKind(e.mime, e.filename) : null, can_review: e.status === 'needs_review' && Ev.canReview(user, e, controls[e.control_key]) }));
}
function listApprovals(t, user, status = 'pending') {
  return db.all('SELECT * FROM approvals WHERE tenant_id=? AND status=? ORDER BY created_at DESC', t, status).filter((a) => (a.pack_key ? P.canPack(user, a.pack_key) : P.isAdmin(user)));
}
function overview(t, user) {
  const cov = coverage(t), open = listCases(t, user), m = metrics(t);
  const workers = listWorkers(t, user);
  const feed = P.isAdmin(user) ? db.all("SELECT seq,ts,type,subject,action,actor FROM audit_log WHERE tenant_id=? AND type NOT IN ('CHECK_RESULT','CASE_STATE','EVIDENCE_VIEWED') ORDER BY seq DESC LIMIT 8", t) : [];
  // "Expiring" is counted exactly as the Expiring soon dashboard it links to: same window, same role limits.
  const exp = dashboardData(t, user, BUILT_IN.find((d) => d.id === 'builtin-expiring').definition), expiring = exp.total;
  const ready = dashboardData(t, user, BUILT_IN.find((d) => d.id === 'builtin-readiness').definition);
  return { coverage: cov, packs: packRows(t).filter((p) => p.status === 'active'), urgent: open.slice(0, 6), feed,
    readiness: readinessSummary(t, user, ready), unknown_reasons: unknownReasons(t), trend: coverageTrend(t),
    fail_people: new Set(allChecks(t).filter((c) => c.status === 'fail').map((c) => `${c.subject_type}:${c.subject_id}`)).size,
    expiring_detail: expiringSummary(exp), attention: attentionDetail(t, user, open),
    kpi: { open_cases: open.length, expiring, missing_onboarding: open.filter((c) => c.pack_key === 'onboarding').length, specialist: open.filter((c) => ['immigration', 'payroll'].includes(c.pack_key)).length, workers: workers.filter((w) => w.status === 'active').length, clinical: workers.filter((w) => w.category === 'clinical' && w.status === 'active').length, corporate: workers.filter((w) => w.category !== 'clinical' && w.status === 'active').length, with_gaps: workers.filter((w) => ['fail', 'unknown'].includes(w.overall)).length, pending_approvals: listApprovals(t, user).length, ...m } };
}
// ---- Overview details. Each part is counted the same way as the page or dashboard it links to.
// Readiness: the Readiness dashboard's groups, plus the waiting people closest to being cleared
// (fewest open checks), so the Overview can say who to help next.
function readinessSummary(t, user, data) {
  const count = (k) => data.groups.find((g) => g.name === k)?.count || 0;
  const waiting = data.groups.find((g) => g.name === 'pending')?.items || [];
  const open = checks(t, user).filter((c) => c.subject_type === 'worker' && ['fail', 'unknown'].includes(c.status));
  const closest = waiting.slice().sort((a, b) => a.open - b.open || a.subject.localeCompare(b.subject)).slice(0, 3).map((w) => {
    const first = open.find((c) => c.subject_id === w.subject_id);
    return { subject_id: w.subject_id, subject: w.subject, open: w.open, control_key: first?.control_key || null, control: first?.control_name || null };
  });
  return { approved: count('approved'), pending: count('pending'), blocked: count('blocked'), total: data.total, closest };
}
// Why checks are unknown, in the groups people act on. Counted over the same checks as the coverage
// figures, so the groups add up to the Unknown total.
const UNKNOWN_GROUP = { missing_evidence: 'document', not_yet_received: 'document', missing_filing_evidence: 'document', evidence_incomplete: 'document', awaiting_review: 'review', missing_context: 'details', missing_data: 'details', state_mismatch: 'details' };
function unknownReasons(t) {
  const out = { document: 0, review: 0, details: 0, other: 0 };
  for (const c of allChecks(t)) if (c.status === 'unknown') out[UNKNOWN_GROUP[c.code] || 'other']++;
  return out;
}
// Share of applicable checks that passed on each of the last 30 days (7 points), rebuilt from the
// check history. Days before the first check have no value. Only checks still in scope count.
function coverageTrend(t, days = 30, points = 7) {
  const inScope = new Set(allChecks(t).map((c) => `${c.subject_type}:${c.subject_id}:${c.control_key}`));
  const rows = db.all('SELECT subject_type, subject_id, control_key, status, created_at FROM evaluations WHERE tenant_id=? ORDER BY created_at', t);
  const today = clock.today(), latest = new Map();
  const out = [];
  let i = 0;
  for (let p = 0; p < points; p++) {
    const day = addDays(today, -Math.round(days - (p * days) / (points - 1)));
    const end = `${day}T23:59:59.999Z`;
    for (; i < rows.length && rows[i].created_at <= end; i++) {
      const r = rows[i], key = `${r.subject_type}:${r.subject_id}:${r.control_key}`;
      if (inScope.has(key)) latest.set(key, r.status);
    }
    let pass = 0, total = 0;
    for (const s of latest.values()) if (s !== 'not_applicable') { total++; if (s === 'pass') pass++; }
    out.push({ date: day, pct: total ? Math.round((pass / total) * 1000) / 10 : null });
  }
  const known = out.filter((x) => x.pct !== null);
  return { points: out, since: known[0]?.date || null, change: known.length > 1 ? Math.round((known.at(-1).pct - known[0].pct) * 10) / 10 : null };
}
function expiringSummary(data) {
  const n = (name) => data.groups.find((g) => g.name === name)?.count || 0;
  const all = data.groups.flatMap((g) => g.items).sort((a, b) => a.days_left - b.days_left);
  return { expired: n('Expired'), d30: n('Next 30 days'), d60: n('31 to 60 days'), d90: n('61 to 90 days'),
    next: all.slice(0, 3).map((x) => ({ subject_id: x.subject_id, subject: x.subject, control: x.control, facility: x.facility, expires_on: x.expires_on, days_left: x.days_left })) };
}
// The one line of context under each "Needs your attention" row.
function attentionDetail(t, user, open) {
  const approvals = listApprovals(t, user), kinds = {};
  for (const a of approvals) kinds[a.kind] = (kinds[a.kind] || 0) + 1;
  const review = listEvidence(t, user).filter((e) => e.status === 'needs_review' && e.can_review);
  return { approvals_by_kind: kinds, review: review.length, review_oldest: review.map((e) => e.created_at).sort()[0] || null };
}
function metrics(t) {
  const base = (k) => db.get('SELECT value FROM baselines WHERE tenant_id=? AND key=?', t, k)?.value ?? null;
  const closed = db.all('SELECT * FROM cases WHERE tenant_id=? AND closed_at IS NOT NULL', t), verified = closed.filter((c) => c.closure === 'verified');
  const hrs = verified.map((c) => (new Date(c.closed_at) - new Date(c.opened_at)) / 36e5).sort((a, b) => a - b);
  const auto = P.counter(t, 'automated_messages'), mins = base('minutes_per_chase');
  const dupSent = db.get(`SELECT COUNT(*) n FROM (SELECT action_id FROM messages WHERE tenant_id=? AND action_id IS NOT NULL GROUP BY action_id HAVING COUNT(*)>1) AS dup`, t).n;
  const reviewed = db.all('SELECT finding_verdict v FROM cases WHERE tenant_id=? AND finding_verdict IS NOT NULL', t);
  const cov = tally(allChecks(t)), tn = db.get('SELECT * FROM tenants WHERE id=?', t);
  const manual = db.get('SELECT COALESCE(SUM(minutes),0) m FROM manual_support WHERE tenant_id=?', t).m;
  return { automated_messages: auto, minutes_per_chase: mins, baseline_hours_per_month: base('hours_per_month'), hours_saved: mins === null ? null : Math.round(auto * mins / 6) / 10, cases_closed: closed.length, verified_closures: verified.length, closures_with_evidence: verified.filter((c) => c.closure_evidence_id).length, median_closure_hours: hrs.length ? Math.round(hrs[Math.floor(hrs.length / 2)] * 10) / 10 : null, findings_reviewed: reviewed.length, false_findings: reviewed.filter((r) => r.v === 'false_finding').length, unknown_results: cov.unknown, duplicates_blocked: P.counter(t, 'duplicates_blocked'), duplicate_messages_sent: dupSent, onboarding_minutes: tn.first_assessment_at ? Math.round((new Date(tn.first_assessment_at) - new Date(tn.created_at)) / 6e4) : null, manual_support_minutes: manual, llm_calls: P.counter(t, 'llm_calls'), llm_tokens: P.counter(t, 'llm_input_tokens') + P.counter(t, 'llm_output_tokens') };
}
// Dashboards. Built-in ones are the same for every customer and cannot be deleted;
// saved ones come from the form or from chat. Both read the same records as Checks and chat.
const BUILT_IN = [
  { id: 'builtin-readiness', name: 'Readiness', description: 'Who is cleared to start, and who is waiting or blocked.', definition: { metric: 'readiness', group_by: 'readiness' } },
  { id: 'builtin-expiring', name: 'Expiring soon', description: 'Credentials that expired or expire in the next 90 days, soonest first.', definition: { metric: 'expirations', group_by: 'window', within_days: 90 } },
  { id: 'builtin-gaps', name: 'Open gaps', description: 'Checks that fail or cannot be proven yet, by facility.', definition: { metric: 'open_gaps', group_by: 'facility' } },
  { id: 'builtin-missing', name: 'Missing documents', description: 'Requirements with no accepted document, by owning team.', definition: { metric: 'missing_evidence', group_by: 'team' } },
  { id: 'builtin-coverage', name: 'Coverage', description: 'Every applicable check, by pack.', definition: { metric: 'coverage', group_by: 'pack' } },
].map((d) => ({ ...d, built_in: true, created_by: 'Aegis', created_at: null, definition_json: JSON.stringify(d.definition), roles_json: '[]' }));
const GROUP_KEY = { facility: 'facility', team: 'team', pack: 'pack_name', status: 'status', control: 'control_name' };
const WINDOWS = ['Expired', 'Next 30 days', '31 to 60 days', '61 to 90 days', 'Later'];
const READINESS_ORDER = ['blocked', 'pending', 'approved'];
// The expiry date a credential check is based on. The evaluator writes it into the reason.
const expiryOf = (c) => (['expired', 'expiring', 'current'].includes(c.code) ? /(?:until|on) (\d{4}-\d{2}-\d{2})/.exec(c.reason)?.[1] || null : null);
const windowOf = (days) => (days < 0 ? WINDOWS[0] : days <= 30 ? WINDOWS[1] : days <= 60 ? WINDOWS[2] : days <= 90 ? WINDOWS[3] : WINDOWS[4]);
function dashboardData(t, user, def) {
  const today = clock.today(), groups = {};
  const put = (name, item) => (groups[name] ||= []).push(item);
  if (def.metric === 'readiness') {
    for (const w of listWorkers(t, user).filter((x) => x.status === 'active')) {
      put(w.readiness || 'pending', { subject_id: w.id, subject_type: 'worker', subject: w.name, facility: w.facility || 'No location assigned', status: w.overall, readiness: w.readiness || 'pending', open: w.checks.fail + w.checks.unknown });
    }
  } else {
    let rows = checks(t, user, { pack: def.pack }).filter((c) => c.status !== 'not_applicable');
    if (def.metric === 'missing_evidence') rows = rows.filter((c) => ['missing_evidence', 'not_yet_received', 'missing_filing_evidence', 'overdue'].includes(c.code));
    else if (def.metric === 'open_gaps') rows = rows.filter((c) => ['fail', 'unknown'].includes(c.status));
    else if (def.metric === 'expirations') {
      const within = Number(def.within_days) || 0;
      rows = rows.map((c) => ({ ...c, expires_on: expiryOf(c) })).filter((c) => c.expires_on && (within ? daysBetween(today, c.expires_on) <= within : ['expiring', 'expired'].includes(c.code)));
    }
    for (const c of rows) {
      const days = c.expires_on ? daysBetween(today, c.expires_on) : null;
      const name = def.group_by === 'window' ? windowOf(days ?? 0) : c[GROUP_KEY[def.group_by] || 'facility'];
      put(name, { subject_id: c.subject_id, subject_type: c.subject_type, subject: c.subject_name, facility: c.facility, control_key: c.control_key, control: c.control_name, pack: c.pack_key, status: c.status, code: c.code, reason: c.reason, expires_on: c.expires_on || null, days_left: days });
    }
  }
  const order = def.group_by === 'window' ? WINDOWS : def.group_by === 'readiness' ? READINESS_ORDER : null;
  const out = Object.entries(groups).map(([name, items]) => {
    if (def.metric === 'expirations') items.sort((a, b) => a.days_left - b.days_left);
    const split = { pass: 0, fail: 0, unknown: 0 };
    for (const i of items) if (Object.hasOwn(split, i.status)) split[i.status]++;
    return { name, count: items.length, split, items };
  });
  out.sort((a, b) => (order ? order.indexOf(a.name) - order.indexOf(b.name) : b.count - a.count));
  const all = out.flatMap((g) => g.items), split = { pass: 0, fail: 0, unknown: 0 };
  for (const i of all) if (Object.hasOwn(split, i.status)) split[i.status]++;
  return { total: all.length, split, groups: out, as_of: clock.iso() };
}
function dashboardsFor(t, user) { return [...BUILT_IN, ...db.all('SELECT * FROM dashboards WHERE tenant_id=? ORDER BY created_at DESC', t).filter((d) => P.isAdmin(user) || j(d.roles_json, []).includes(user.role))]; }
function reportCsv(t, user, pack) {
  const rows = checks(t, user, pack === 'all' ? {} : { pack }), cov = coverage(t);
  const lines = [['Subject', 'Facility', 'Pack', 'Control', 'Requirement type', 'Status', 'Reason', 'Evidence references', 'Control version', 'Evaluated at']];
  for (const r of rows) lines.push([r.subject_name, r.facility, r.pack_name, r.control_name, r.requirement_type, r.status, r.reason, r.evidence_ids.join(' '), r.control_version, r.evaluated_at]);
  lines.push([]); lines.push([`Scope: ${cov.scope_statement} Evidence current as of ${cov.as_of}.`]);
  return lines.map((l) => l.map(csvCell).join(',')).join('\n');
}
// The printable report: the same rows as the CSV, summarised for a person to read.
// Problems are listed by name; passing checks are counted, with their references in the CSV.
function reportData(t, user, pack) {
  const packs = packRows(t).filter((p) => p.status === 'active');
  const one = pack === 'all' ? null : packs.find((p) => p.key === pack);
  if (pack !== 'all' && !one) throw new P.HttpError(404, 'This pack is not activated.');
  const rows = checks(t, user, pack === 'all' ? {} : { pack }).filter((c) => c.status !== 'not_applicable');
  const tl = tally(rows), cov = coverage(t), byFacility = {};
  for (const r of rows) (byFacility[r.facility] ||= []).push(r);
  const rank = { fail: 0, unknown: 1 };
  return {
    tenant: db.get('SELECT name FROM tenants WHERE id=?', t).name,
    pack: pack === 'all' ? 'all' : one.key,
    title: pack === 'all' ? 'All activated packs' : one.name,
    packs: pack === 'all' ? packs.map((p) => p.name) : [one.name],
    tally: tl,
    all_pass: tl.total > 0 && tl.pass === tl.total,
    scope_statement: pack === 'all' ? cov.scope_statement : `${tl.total} applicable check${tl.total === 1 ? '' : 's'} in the ${one.name} pack. Obligations outside this pack have not been assessed.`,
    as_of: clock.iso(),
    facilities: Object.entries(byFacility).map(([name, list]) => ({ name, ...tally(list) })).sort((a, b) => (b.fail + b.unknown) - (a.fail + a.unknown) || a.name.localeCompare(b.name)),
    attention: rows.filter((r) => r.status === 'fail' || r.status === 'unknown').sort((a, b) => rank[a.status] - rank[b.status] || a.subject_name.localeCompare(b.subject_name))
      .map((r) => ({ subject_id: r.subject_id, subject_type: r.subject_type, subject: r.subject_name, facility: r.facility, control: r.control_name, pack: r.pack_key, status: r.status, reason: r.reason })),
  };
}
// What the next digest says, and where and when the last one went.
function digestInfo(t) {
  const tn = db.get('SELECT channel_json FROM tenants WHERE id=?', t);
  const last = db.get("SELECT ts, type, action, actor FROM audit_log WHERE tenant_id=? AND type IN ('DIGEST_SENT','DIGEST_OUTBOX','DIGEST_FAILED') ORDER BY seq DESC LIMIT 1", t) || null;
  return { channel: j(tn.channel_json, {}).channel || '#compliance-alerts', preview: digestText(t), last };
}
function setupState(t) {
  const tn = db.get('SELECT * FROM tenants WHERE id=?', t), s = j(tn.setup_json, {}), ws = db.all("SELECT * FROM workers WHERE tenant_id=? AND status='active'", t);
  const noLoc = ws.filter((w) => !E.currentFacility(t, w.id)), facs = db.all('SELECT * FROM facilities WHERE tenant_id=? ORDER BY name', t), ents = db.all('SELECT * FROM entities WHERE tenant_id=? ORDER BY name', t);
  const clinical = ws.filter((w) => w.category === 'clinical').length;
  // Each gap names the setup step that fixes it and, where it is about people, who they are, so the
  // page can say who and offer the fix. "gaps" keeps the plain sentences for older callers.
  const gapItems = [], n = (k, one, many) => `${k} ${k === 1 ? one : many}`;
  const people = (list) => list.map((w) => ({ id: w.id, name: w.name }));
  const who = (list, one, many) => (list.length === 1 ? `${list[0].name} ${one}` : `${list.length} workers ${many}`);
  // A worker without a location is fixed on the worker's record, not in the locations table.
  if (noLoc.length) gapItems.push({ step: 'records', kind: 'no_location', text: `${who(noLoc, 'is', 'are')} not assigned to a work location, so location requirements cannot be checked.`, workers: people(noLoc) });
  const noEmail = ws.filter((w) => !w.email);
  if (noEmail.length) gapItems.push({ step: 'records', kind: 'no_email', text: `${who(noEmail, 'has', 'have')} no email address, so document requests cannot reach them.`, workers: people(noEmail) });
  const unf = facs.filter((f) => !f.requirements_confirmed);
  if (unf.length) gapItems.push({ step: 'context', kind: 'unconfirmed_location', text: `Requirements are not confirmed for ${unf.length <= 3 ? unf.map((f) => f.name).join(', ') : n(unf.length, 'location', 'locations')}. Use Edit on ${unf.length === 1 ? 'that row' : 'those rows'} to confirm them.` });
  if (!ents.length) gapItems.push({ step: 'context', kind: 'no_entity', text: 'No employing entity on record. Add it to your workers in the HR system or spreadsheet.' });
  if (ws.length) gapItems.push({ step: 'packs', text: 'Payroll filing evidence is not in HR records and must be uploaded.' });
  const gaps = gapItems.map((g) => g.text);
  // Where the records come from: connected systems, and workers by source.
  const bySource = {};
  for (const w of ws) bySource[w.source || 'manual'] = (bySource[w.source || 'manual'] || 0) + 1;
  const source = { connectors: db.all('SELECT id, name, type, status, last_sync_at, last_error, records FROM connectors WHERE tenant_id=? ORDER BY name', t), workers_by_source: bySource };
  const packs = packRows(t);
  return { tenant: tn.name, kind: tn.kind, summary: { workers: ws.length, clinical, facilities: facs.length, entities: ents.length }, gaps, gap_items: gapItems, source, facilities: facs.map((f) => ({ ...f, requirements: j(f.requirements_json, []) })), entities: ents, steps: { connect: ws.length > 0, context: !!s.context_confirmed, packs: packs.some((p) => p.status === 'active'), channel: !!s.channel_confirmed, assessed: !!tn.first_assessment_at }, recommended: packs.map((p) => ({ key: p.key, name: p.name, icon: p.icon, description: p.description, mode: p.mode, recommended: p.key === 'healthcare' ? clinical > 0 : ws.length > 0, status: p.status, owner_role: p.owner_role, owner_user_id: p.owner_user_id, controls: p.controls, review_note: p.review_note, version: p.latest_version, validation: p.validation })), channel: j(tn.channel_json, {}), slack_ready: require('./slack').configured(t), coverage: coverage(t), users: db.all('SELECT id,name,role FROM users WHERE tenant_id=?', t) };
}
function digestText(t) {
  const c = coverage(t), open = db.all(`SELECT * FROM cases WHERE tenant_id=? AND ${E.OPEN}`, t), pend = db.get("SELECT COUNT(*) n FROM approvals WHERE tenant_id=? AND status='pending'", t).n;
  return `Aegis digest for ${clock.today()}\n${c.pass} pass, ${c.fail} fail, ${c.unknown} unknown across ${c.total} applicable checks.\n${open.length} open case(s), ${open.filter((x) => x.escalated).length} escalated. ${pend} awaiting approval.\n${c.scope_statement}`;
}
function health(t) {
  return { ai_error: llm.lastError(t), jobs: { queued: db.get("SELECT COUNT(*) n FROM jobs WHERE tenant_id=? AND status='queued'", t).n, dead: db.all("SELECT id,type,last_error,attempts,finished_at FROM jobs WHERE tenant_id=? AND status='dead' ORDER BY finished_at DESC LIMIT 20", t) }, failed_actions: db.all("SELECT id,type,recipient,error FROM actions WHERE tenant_id=? AND error IS NOT NULL AND status='queued' LIMIT 20", t), connectors: db.all('SELECT id,type,name,status,last_sync_at,last_error,records,capabilities_json FROM connectors WHERE tenant_id=?', t).map((c) => ({ ...c, capabilities: j(c.capabilities_json, []) })), events: db.all('SELECT type,status,received_at,error FROM events WHERE tenant_id=? ORDER BY received_at DESC LIMIT 10', t), schedules: db.all('SELECT * FROM schedules WHERE tenant_id=?', t), audit: P.verifyAudit(t) };
}
module.exports = { reportData, digestInfo, checks, coverage, tally, packRows, listCases, caseDetail, listWorkers, workerDetail, listEvidence, listApprovals, overview, metrics, dashboardData, dashboardsFor, reportCsv, setupState, digestText, health, allChecks, isoDay, addDays, daysBetween };
