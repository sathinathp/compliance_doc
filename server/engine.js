'use strict';
// Event-driven core: evaluate -> reconcile case -> plan action -> send once -> follow up -> escalate.
const db = require('./lib/db'), { clock, id, shortId, addDays, j, sha256, token } = require('./lib/util');
const P = require('./platform'), R = require('./registry'), { evaluate } = require('./evaluator'), channels = require('./channels');
const W = require('./lib/workspace');
const CoworkerPolicy = require('./coworker-policy');
const { HttpError, SYSTEM } = P;
const OPEN = "closed_at IS NULL";
const BASE = () => process.env.AEGIS_BASE_URL || `http://localhost:${process.env.PORT || 4100}`;

function currentFacility(t, workerId) {
  return db.get(`SELECT f.* FROM assignments a JOIN facilities f ON f.id=a.facility_id WHERE a.tenant_id=? AND a.worker_id=? AND a.status='active' ORDER BY a.start_date DESC LIMIT 1`, t, workerId);
}
function loadCtx(t, type, s) {
  const evidence = db.all("SELECT * FROM evidence WHERE tenant_id=? AND subject_type=? AND subject_id=? AND status IN ('accepted','needs_review')", t, type, s.id);
  const facility = type === 'worker' ? currentFacility(t, s.id) : null;
  return { today: clock.today(), evidence, facility, facilityReqs: facility ? j(facility.requirements_json, []) : [] };
}
// Saves the new result and returns the previous status (null for a first check),
// so the case logic can tell when a check gets worse, for example from "expiring" to "expired".
function recordEvaluation(t, type, s, c, r, trigger) {
  const cur = db.get('SELECT * FROM evaluations WHERE tenant_id=? AND subject_type=? AND subject_id=? AND control_key=? AND is_current=1', t, type, s.id, c.key);
  const evs = JSON.stringify(r.evidence_ids);
  if (cur && cur.status === r.status && cur.reason === r.reason && cur.control_version === c.version_label && cur.evidence_ids_json === evs) {
    db.update('evaluations', cur.id, { evaluated_at: clock.iso(), action_needed: r.action_needed ? 1 : 0 });
    return cur.status;
  }
  if (cur) db.update('evaluations', cur.id, { is_current: 0 });
  const row = { id: id('eval'), tenant_id: t, subject_type: type, subject_id: s.id, pack_key: c.pack_key, control_key: c.key, control_version: c.version_label, status: r.status, code: r.code, reason: r.reason, evidence_ids_json: evs, action_needed: r.action_needed ? 1 : 0, trigger, is_current: 1, created_at: clock.iso(), evaluated_at: clock.iso() };
  db.insert('evaluations', row);
  P.audit(t, 'CHECK_RESULT', s.name, `${c.name}: ${r.status.toUpperCase()}. ${r.reason}`, { name: 'Control Evaluator' }, { detail: { control_version: c.version_label, evidence_ids: r.evidence_ids, trigger } });
  return cur ? cur.status : null;
}
function audience(t, cs) {
  if (cs.subject_type === 'worker') { const w = db.get('SELECT * FROM workers WHERE id=? AND tenant_id=?', cs.subject_id, t); return { worker: w }; }
  return { worker: null };
}
function owner(t, cs) { return cs.owner_user_id ? db.get('SELECT * FROM users WHERE id=? AND tenant_id=?', cs.owner_user_id, t) : null; }
function newLink(t, cs) {
  const raw = token();
  db.insert('submission_tokens', { token_hash: sha256(raw), tenant_id: t, case_id: cs.id, expires_at: new Date(clock.now().getTime() + 14 * 864e5).toISOString(), created_at: clock.iso() });
  return `${BASE()}/submit/${raw}`;
}
function enqueueAction(t, a, actor = SYSTEM) {
  return db.tx(() => {
    const existing = db.get('SELECT * FROM actions WHERE tenant_id=? AND idempotency_key=?', t, a.idempotency_key);
    if (existing && existing.status !== 'paused') { P.bump(t, 'duplicates_blocked'); return { ...existing, duplicate: true }; }
    const row = { tenant_id: t, case_id: a.case_id, type: a.type, idempotency_key: a.idempotency_key, status: a.requires_approval ? 'pending_approval' : 'queued', automated: actor.type === 'system' ? 1 : 0, recipient: a.recipient, recipient_type: a.recipient_type, subject: a.subject, body: a.body, created_by: actor.name, created_at: clock.iso() };
    if (existing) db.update('actions', existing.id, row);
    row.id = existing?.id || id('act');
    if (!existing) db.insert('actions', row);
    if (a.requires_approval) {
      db.insert('approvals', { id: id('apr'), tenant_id: t, kind: 'action', ref_id: row.id, case_id: a.case_id, pack_key: a.pack_key, title: a.approval_title || `Approve message to ${a.recipient}`, detail: a.body, requested_by: actor.name, created_at: clock.iso() });
      P.audit(t, 'APPROVAL_REQUESTED', a.recipient, `Awaiting approval: ${a.subject}`, actor, { case_id: a.case_id });
    } else {
      const payload = { action_id: row.id, ...(a.confirmed_follow_up && { confirmed_follow_up: a.confirmed_follow_up }) };
      P.enqueue(t, 'send_action', payload, { dedupe: `send:${row.id}` });
    }
    return row;
  });
}
function planNext(t, cs, c) {
  if (cs.closed_at || !c || cs.finding_verdict === 'false_finding') return;
  const rem = c.remediation || {}, mode = c.mode;
  const o = owner(t, cs), { worker } = audience(t, cs);
  if (mode !== 'auto') {
    if (cs.gap_kind === 'review' && cs.state !== 'in_review') setState(t, cs, 'in_review', 'Evidence awaiting review.');
    return;
  }
  if (cs.gap_kind === 'review') { if (cs.state !== 'in_review') setState(t, cs, 'in_review', 'Evidence awaiting review.'); return; }
  if (cs.state !== 'assigned') return;
  const toOwner = cs.gap_kind === 'data' || rem.route === 'owner_task' || cs.subject_type === 'entity' || !worker;
  if (toOwner) {
    if (!o) return;
    const needLink = cs.gap_kind !== 'data';
    enqueueAction(t, { case_id: cs.id, pack_key: cs.pack_key, type: 'owner_task', idempotency_key: `${cs.id}:owner_task:1`, recipient: o.name, recipient_type: 'owner', subject: `${c.restricted ? 'Restricted review task' : 'Task'}: ${c.name}`, body: c.restricted ? `A restricted ${c.pack_name} review is assigned to you. Open Aegis to view it.${needLink ? ` Upload: ${newLink(t, cs)}` : ''}` : `${cs.subject_name}: ${cs.gap}${needLink ? ` Upload evidence: ${newLink(t, cs)}` : ' Please update the record.'}` });
  } else {
    const first = worker.name.split(/[ ,]/)[0];
    enqueueAction(t, { case_id: cs.id, pack_key: cs.pack_key, type: 'request_evidence', idempotency_key: `${cs.id}:request:1`, requires_approval: !!rem.request_requires_approval, recipient: worker.name, recipient_type: 'worker', subject: `Action needed: ${c.name}`, body: `Hi ${first}, we need your ${c.name}. ${cs.gap} Please upload it by ${cs.due_date} using your secure link: ${newLink(t, cs)}` });
  }
}
function setState(t, cs, state, why, actor = SYSTEM) {
  db.update('cases', cs.id, { state }); cs.state = state;
  P.audit(t, 'CASE_STATE', cs.subject_name, `${cs.control_name}: moved to ${state.replace(/_/g, ' ')}. ${why}`, actor, { case_id: cs.id });
}
function closeCase(t, cs, closure, evIds, why) {
  const realEv = (evIds || []).find((x) => !String(x).startsWith('record:')) || (evIds || [])[0] || null;
  db.update('cases', cs.id, { state: 'closed', closed_at: clock.iso(), closure, closure_evidence_id: realEv, next_reminder_at: null });
  cs.state = 'closed'; cs.closed_at = clock.iso();
  db.run("UPDATE approvals SET status='withdrawn',note='Case closed',decided_at=? WHERE tenant_id=? AND case_id=? AND status='pending'", clock.iso(), t, cs.id);
  db.run("UPDATE actions SET status='cancelled' WHERE tenant_id=? AND case_id=? AND status='pending_approval'", t, cs.id);
  P.audit(t, 'CASE_CLOSED', cs.subject_name, `${cs.control_name}: closed (${closure.replace(/_/g, ' ')}). ${why}`, { name: 'Control Evaluator' }, { case_id: cs.id, detail: { evidence: realEv } });
}
const firstName = (name) => String(name || '').split(/[ ,]/)[0];
const noEndStop = (s) => String(s || '').trim().replace(/[.!?]+$/, '');
// The gap as of right now, so a reminder says "expires in 16 days", not the count from the last check.
function currentGap(t, cs, c) {
  const s = db.get(`SELECT * FROM ${cs.subject_type === 'worker' ? 'workers' : 'entities'} WHERE id=? AND tenant_id=?`, cs.subject_id, t);
  if (!s) return cs.gap;
  const r = evaluate(c, { ...s, attrs: j(s.attrs_json, {}) }, loadCtx(t, cs.subject_type, s));
  return r.action_needed ? r.reason : cs.gap;
}
const decisionDetail = (gap) => `${gap} Decide whether the assignment should continue. Aegis records your decision and does not change the assignment itself.`;

// Critical alert to the owner when a high-priority check fails. One alert per kind of failure
// (for example "expired on 2026-12-09"), checked before sending so the duplicate counter stays honest.
function alertCritical(t, cs, c, s, r) {
  const o = owner(t, cs), key = `${cs.id}:alert:${r.code}:${r.due || ''}`;
  if (r.status !== 'fail' || cs.priority !== 'high' || c.mode !== 'auto' || !o) return;
  if (db.get('SELECT 1 AS x FROM actions WHERE tenant_id=? AND idempotency_key=?', t, key)) return;
  enqueueAction(t, { case_id: cs.id, pack_key: cs.pack_key, type: 'notify', idempotency_key: key, recipient: o.name, recipient_type: 'owner', subject: `Critical: ${c.name}`, body: c.restricted ? 'A critical restricted finding is waiting in Aegis.' : `${s.name}: ${r.reason}` });
}

function reconcile(t, type, s, c, r, prevStatus = null) {
  const open = db.get(`SELECT * FROM cases WHERE tenant_id=? AND subject_type=? AND subject_id=? AND control_key=? AND ${OPEN}`, t, type, s.id, c.key);
  if (!r.action_needed) {
    if (open) closeCase(t, open, r.status === 'pass' ? 'verified' : 'no_longer_applicable', r.evidence_ids, r.reason);
    return;
  }
  const priority = r.status === 'fail' || (r.code === 'expiring' && r.days <= 14) ? 'high' : c.priority || 'medium';
  // A real deadline from the rule (expiry date, hire date + N days) always wins. Without one, the case keeps
  // the date it got when it opened, so it can become overdue instead of moving forward on every check.
  const due = r.due || open?.due_date || addDays(clock.today(), 7);
  if (!open) {
    const cs = { id: shortId('CASE'), tenant_id: t, subject_type: type, subject_id: s.id, subject_name: s.name, pack_key: c.pack_key, control_key: c.key, control_name: c.name, state: 'identified', gap: r.reason, gap_kind: r.gap_kind, priority, owner_user_id: c.owner_user_id, owner_team: c.team, restricted: c.restricted ? 1 : 0, due_date: due, opened_at: clock.iso() };
    db.insert('cases', cs);
    P.audit(t, 'CASE_OPENED', s.name, `${c.name}: gap identified. ${r.reason}`, SYSTEM, { case_id: cs.id });
    setState(t, cs, 'assigned', `Assigned to ${c.team}.`);
    planNext(t, cs, c);
    alertCritical(t, cs, c, s, r);
    return;
  }
  const wasReview = open.gap_kind === 'review', wasData = open.gap_kind === 'data', gapChanged = open.gap !== r.reason;
  db.update('cases', open.id, { gap: r.reason, gap_kind: r.gap_kind, priority, due_date: due });
  Object.assign(open, { gap: r.reason, gap_kind: r.gap_kind, priority, due_date: due });
  // A waiting assignment decision must show the current situation, not the one from when it was created.
  if (gapChanged) {
    const waiting = db.all("SELECT id FROM approvals WHERE tenant_id=? AND case_id=? AND kind='assignment_review' AND status='pending'", t, open.id);
    for (const a of waiting) db.update('approvals', a.id, { detail: decisionDetail(r.reason) });
    if (waiting.length && prevStatus !== r.status) P.audit(t, 'APPROVAL_UPDATED', s.name, `${c.name}: waiting decision updated. ${r.reason}`, SYSTEM, { case_id: open.id });
  }
  // An open case that just got worse (for example a credential that expired) alerts the owner again.
  if (prevStatus !== 'fail') alertCritical(t, open, c, s, r);
  if (wasReview && r.gap_kind !== 'review' && open.state === 'in_review') {
    // Reviewed evidence was rejected or withdrawn, so the case returns to chasing. It does not close.
    const sent = db.get(`SELECT 1 x FROM actions WHERE case_id=? AND status='sent' AND type IN ('request_evidence','owner_task')`, open.id);
    setState(t, open, sent ? 'requested' : 'assigned', 'Evidence was not accepted.');
    db.update('cases', open.id, { next_reminder_at: new Date(clock.now().getTime() + (c.remediation?.reminder_every_days ?? 3) * 864e5).toISOString() });
    if (!sent) planNext(t, open, c);
  } else {
    // Missing context was supplied and the gap is now a real evidence gap, so the request can go out.
    if (wasData && r.gap_kind === 'evidence' && ['requested', 'following_up'].includes(open.state)) setState(t, open, 'assigned', 'Context confirmed. Evidence is now needed.');
    planNext(t, open, c);
  }
}
function notifyRejected(t, ev, reason) {
  if (W.pending(t)) return;
  const cs = db.get(`SELECT * FROM cases WHERE tenant_id=? AND subject_type=? AND subject_id=? AND control_key=? AND ${OPEN}`, t, ev.subject_type, ev.subject_id, ev.control_key);
  const c = R.effectiveControls(t).find((x) => x.key === ev.control_key);
  if (!cs || !c || c.mode !== 'auto') return;
  const { worker } = audience(t, cs), o = owner(t, cs), toW = worker && c.remediation?.route === 'worker';
  const body = toW
    ? `Hi ${firstName(worker.name)}, the document you sent for your ${c.name} could not be accepted: ${noEndStop(reason)}. Please upload a replacement using your secure link: ${newLink(t, cs)}`
    : `The document sent for ${cs.subject_name}'s ${c.name} could not be accepted: ${noEndStop(reason)}. Please upload a replacement: ${newLink(t, cs)}`;
  enqueueAction(t, { case_id: cs.id, pack_key: cs.pack_key, type: 'notify', idempotency_key: `${cs.id}:rejected:${ev.id}`, recipient: toW ? worker.name : o?.name, recipient_type: toW ? 'worker' : 'owner', subject: `Please resubmit: ${c.name}`, body: c.restricted ? 'A restricted document needs to be resubmitted. Open Aegis for details.' : body });
}
function evaluateSubject(t, type, s, trigger, only) {
  const controls = R.effectiveControls(t).filter((c) => c.subject === type && (!only || c.key === only));
  const subject = { ...s, attrs: j(s.attrs_json, {}) };
  const ctx = loadCtx(t, type, s);
  return db.tx(() => {
    const newlyOpen = [];
    const out = controls.map((c) => {
      const r = evaluate(c, subject, ctx);
      const prevStatus = recordEvaluation(t, type, s, c, r, trigger);
      reconcile(t, type, s, c, r, prevStatus);
      if (UNRESOLVED.has(r.status) && !UNRESOLVED.has(prevStatus)) newlyOpen.push(c.name);
      return { control: c.key, ...r };
    });
    if (type === 'worker' && newlyOpen.length) reopenReadiness(t, s.id, newlyOpen);
    return out;
  });
}
const UNRESOLVED = new Set(['fail', 'unknown']);
// An approved worker goes back to pending when a check that passed stops passing
// (a credential expires, a new requirement applies). Checks that were already open
// when the owner approved do not reopen it: the owner saw those.
function reopenReadiness(t, wid, names) {
  const w = db.get('SELECT id, name, readiness FROM workers WHERE id=? AND tenant_id=?', wid, t);
  if (w?.readiness !== 'approved') return;
  db.update('workers', wid, { readiness: 'pending' });
  P.audit(t, 'READINESS_REOPENED', `Assignment readiness: ${w.name}`, `Back to pending. No longer passing: ${names.join(', ')}.`);
}
function evaluateTenant(t, trigger) {
  for (const w of db.all('SELECT * FROM workers WHERE tenant_id=?', t)) evaluateSubject(t, 'worker', w, trigger);
  for (const e of db.all('SELECT * FROM entities WHERE tenant_id=?', t)) evaluateSubject(t, 'entity', e, trigger);
  const tn = db.get('SELECT * FROM tenants WHERE id=?', t);
  if (!tn.first_assessment_at && db.get('SELECT 1 x FROM evaluations WHERE tenant_id=? LIMIT 1', t)) db.update('tenants', t, { first_assessment_at: clock.iso() });
}
const evaluateById = (t, type, sid, trigger) => {
  const s = db.get(`SELECT * FROM ${type === 'worker' ? 'workers' : 'entities'} WHERE id=? AND tenant_id=?`, sid, t);
  if (s) evaluateSubject(t, type, s, trigger);
};
function canDeliverConfirmedFollowUp(t, cs, confirmed) {
  if (!cs || cs.closed_at || cs.control_key !== confirmed.controlKey || cs.gap_kind !== 'evidence' || cs.finding_verdict === 'false_finding') return false;
  const policy = CoworkerPolicy.get(t);
  if (!policy.enabled || !policy.follow_ups || policy.follow_up_epoch !== (confirmed.policyEpoch ?? 0)) return false;
  const user = db.get('SELECT id,role,coworker_epoch FROM users WHERE id=? AND tenant_id=?', confirmed.actorId, t);
  if (!user || user.coworker_epoch !== (confirmed.actorEpoch ?? 0) || !P.canPack(user, cs.pack_key)
    || (cs.restricted && !P.canSeeRestricted(user))) return false;
  const control = R.effectiveControls(t).find((c) => c.key === cs.control_key);
  if (!control || control.mode !== 'auto') return false;
  const { person, type } = followUpRecipient(t, cs, control);
  return person?.id === confirmed.recipientId && type === confirmed.recipientType
    && (type === 'worker' ? person.status === 'active' : P.canPack(person, cs.pack_key));
}

async function sendAction(t, { action_id, confirmed_follow_up }) {
  const a = db.get('SELECT * FROM actions WHERE id=? AND tenant_id=?', action_id, t);
  if (!a || a.status !== 'queued') return; // retried or duplicate job: nothing to send again
  const cs = a.case_id ? db.get('SELECT * FROM cases WHERE id=? AND tenant_id=?', a.case_id, t) : null;
  if (!cs || cs.closed_at) { db.update('actions', a.id, { status: 'cancelled' }); return; }
  const stillConfirmed = (target) => !confirmed_follow_up || canDeliverConfirmedFollowUp(t, target, confirmed_follow_up);
  const cancelConfirmed = () => {
    const error = 'The case, recipient, requester’s access or coworker policy changed after confirmation.';
    db.tx(() => {
      const cancelled = db.run("UPDATE actions SET status='cancelled',error=? WHERE id=? AND tenant_id=? AND status='queued'", error, a.id, t);
      if (!cancelled.changes) return;
      P.audit(t, 'CHAT_COMMAND', 'Confirmed follow-up', error, SYSTEM, { case_id: cs.id, detail: { action_id: a.id, requester_id: confirmed_follow_up.actorId } });
    });
  };
  if (!stillConfirmed(cs)) { cancelConfirmed(); return; }
  const maySend = () => {
    const pack = R.tenantPack(t, cs.pack_key);
    const target = db.get('SELECT * FROM cases WHERE id=? AND tenant_id=?', cs.id, t);
    const action = db.get('SELECT status,body,created_at FROM actions WHERE id=? AND tenant_id=?', a.id, t);
    return !W.pending(t) && pack?.status === 'active' && pack.mode === 'auto' && target && !target.closed_at && target.owner_user_id === cs.owner_user_id
      && action?.status === 'queued' && action.body === a.body && action.created_at === a.created_at && stillConfirmed(target);
  };
  if (!maySend()) { R.pausePackActions(t, cs.pack_key); return; }
  const tn = db.get('SELECT * FROM tenants WHERE id=?', t);
  const recipient = a.recipient_type === 'worker' ? audience(t, cs).worker : owner(t, cs);
  const canReceive = recipient && (a.recipient_type === 'worker' ? recipient.status === 'active' : P.canPack(recipient, cs.pack_key));
  try {
    const channel = await channels.deliver(tn, { ...a, recipient_slack: canReceive ? recipient.slack_id : null, recipient_email: canReceive ? recipient.email : null }, maySend);
    if (channel === 'paused') {
      const current = db.get('SELECT * FROM cases WHERE id=? AND tenant_id=?', cs.id, t);
      if (current?.closed_at) db.run("UPDATE actions SET status='cancelled' WHERE id=? AND tenant_id=? AND status='queued'", a.id, t);
      else if (!stillConfirmed(current)) cancelConfirmed();
      return;
    }
    db.tx(() => {
      db.update('actions', a.id, { status: 'sent', sent_at: clock.iso(), error: null });
      const how = channel === 'outbox' ? 'kept in the Aegis outbox: no email or Slack is set up for this person, so it did not leave Aegis' : `sent by ${channel}`;
      P.audit(t, a.type === 'reminder' ? 'AUTO_REMINDER' : 'MESSAGE_SENT', a.recipient, `${a.subject} (${how})`, a.automated ? SYSTEM : { name: a.created_by }, { case_id: a.case_id });
      if (a.automated) P.bump(t, 'automated_messages');
      if (cs && ['request_evidence', 'owner_task', 'reminder', 'follow_up'].includes(a.type)) {
        const c = R.effectiveControls(t).find((x) => x.key === cs.control_key);
        const every = c?.remediation?.reminder_every_days ?? 3;
        const next = cs.gap_kind === 'data' ? null : new Date(clock.now().getTime() + every * 864e5).toISOString();
        const u = { next_reminder_at: next };
        if (a.type === 'reminder') u.reminders_sent = cs.reminders_sent + 1;
        db.update('cases', cs.id, u);
        if (['assigned', 'identified'].includes(cs.state)) setState(t, cs, 'requested', 'Evidence requested.');
        else if (a.type === 'reminder' && cs.state === 'requested') setState(t, cs, 'following_up', 'Reminder sent. A reminder does not resolve the case.');
      }
    });
  } catch (e) { db.update('actions', a.id, { error: e.message }); throw e; }
}
function runReminders(t) {
  if (W.pending(t)) return;
  const now = clock.iso(), controls = R.effectiveControls(t);
  for (const cs of db.all(`SELECT * FROM cases WHERE tenant_id=? AND ${OPEN} AND state IN ('requested','following_up') AND next_reminder_at IS NOT NULL AND next_reminder_at<=?`, t, now)) {
    const c = controls.find((x) => x.key === cs.control_key);
    if (!c || c.mode !== 'auto') continue;
    const max = c.remediation?.max_reminders ?? 2;
    if (cs.reminders_sent < max) {
      const n = cs.reminders_sent + 1, { worker } = audience(t, cs), o = owner(t, cs), toW = worker && c.remediation?.route === 'worker';
      db.update('cases', cs.id, { next_reminder_at: null });
      const gap = currentGap(t, cs, c);
      const body = c.restricted
        ? `Reminder ${n}: a restricted ${c.pack_name} review is waiting in Aegis.`
        : toW
          ? `Hi ${firstName(worker.name)}, this is reminder ${n} about your ${c.name}. ${gap} Please upload it using your secure link: ${newLink(t, cs)}`
          : `Reminder ${n}: ${cs.subject_name} still needs ${c.name}. ${gap}`;
      enqueueAction(t, { case_id: cs.id, pack_key: cs.pack_key, type: 'reminder', idempotency_key: `${cs.id}:reminder:${n}`, recipient: toW ? worker.name : o?.name || cs.owner_team, recipient_type: toW ? 'worker' : 'owner', subject: `Reminder ${n}: ${c.name}`, body });
    } else if (!cs.escalated) {
      db.update('cases', cs.id, { escalated: 1, next_reminder_at: null });
      const o = owner(t, cs), gap = currentGap(t, cs, c);
      enqueueAction(t, { case_id: cs.id, pack_key: cs.pack_key, type: 'escalation', idempotency_key: `${cs.id}:escalate:1`, recipient: o?.name || cs.owner_team, recipient_type: 'owner', subject: `Escalated: ${c.name}`, body: c.restricted ? 'A restricted case is unresolved after all reminders.' : `${cs.subject_name}: ${gap} No accepted evidence after ${max} reminders.` });
      P.audit(t, 'CASE_ESCALATED', cs.subject_name, `${c.name}: escalated after ${max} unanswered reminders.`, SYSTEM, { case_id: cs.id });
      if (c.remediation?.on_escalate === 'assignment_review') {
        db.insert('approvals', { id: id('apr'), tenant_id: t, kind: 'assignment_review', ref_id: cs.id, case_id: cs.id, pack_key: cs.pack_key, title: `Assignment decision: ${cs.subject_name}`, detail: decisionDetail(gap), requested_by: SYSTEM.name, created_at: clock.iso() });
      }
    }
  }
}
function setMode(t, user, pack, mode) {
  P.assertPack(user, pack);
  if (!['shadow', 'auto'].includes(mode)) throw new HttpError(400, 'Invalid mode.');
  if (R.tenantPack(t, pack)?.status !== 'active') throw new HttpError(404, 'Activate this pack before changing its mode.');
  if (mode === 'auto') {
    W.requireVerified(t);
    const un = db.get(`SELECT COUNT(*) n FROM cases WHERE tenant_id=? AND pack_key=? AND ${OPEN} AND finding_verdict IS NULL`, t, pack).n;
    if (un) throw new HttpError(409, `${un} finding(s) still need owner validation before automatic requests can be turned on.`);
  }
  db.tx(() => {
    db.run('UPDATE tenant_packs SET mode=? WHERE tenant_id=? AND pack_key=?', mode, t, pack);
    if (mode === 'shadow') R.pausePackActions(t, pack);
    P.audit(t, 'PACK_MODE', pack, `Automation set to ${mode === 'auto' ? 'automatic requests' : 'validation only'}.`, user);
  });
  if (mode === 'auto') {
    const controls = R.effectiveControls(t);
    for (const cs of db.all(`SELECT * FROM cases WHERE tenant_id=? AND pack_key=? AND ${OPEN} AND state='assigned' AND (finding_verdict IS NULL OR finding_verdict='confirmed')`, t, pack)) planNext(t, cs, controls.find((c) => c.key === cs.control_key));
  }
}
function followUp(t, user, cs, confirmedRecipient = null) {
  P.assertPack(user, cs.pack_key);
  W.requireVerified(t);
  if (cs.closed_at) throw new HttpError(409, 'Case is closed.');
  const c = R.effectiveControls(t).find((x) => x.key === cs.control_key);
  if (!c) throw new HttpError(409, 'Control is no longer active.');
  if (c.mode !== 'auto') return { sent: false, message: 'This pack is in validation mode, so nothing was sent.' };
  if (cs.finding_verdict === 'false_finding') return { sent: false, message: 'This finding was marked false, so nothing was sent.' };
  if (cs.gap_kind === 'review') return { sent: false, message: 'Evidence is already awaiting review.' };
  const { person, type } = followUpRecipient(t, cs, c), toW = type === 'worker';
  const gap = currentGap(t, cs, c);
  const body = c.restricted
    ? 'A restricted review needs your attention in Aegis.'
    : toW
      ? `Hi ${firstName(person.name)}, a follow-up from your compliance team about your ${c.name}. ${gap} Please upload it using your secure link: ${newLink(t, cs)}`
      : `${cs.subject_name}: ${gap}${cs.gap_kind !== 'data' ? ` Upload: ${newLink(t, cs)}` : ''}`;
  const confirmed_follow_up = confirmedRecipient && {
    actorId: user.id, actorEpoch: user.coworker_epoch, policyEpoch: confirmedRecipient.policyEpoch,
    controlKey: c.key, recipientId: confirmedRecipient.recipientId, recipientType: confirmedRecipient.recipientType,
  };
  const a = enqueueAction(t, { case_id: cs.id, pack_key: cs.pack_key, type: 'follow_up', idempotency_key: `${cs.id}:manual:${clock.today()}`, recipient: person?.name, recipient_type: type, subject: `Follow-up: ${c.name}`, body, confirmed_follow_up }, user);
  return a.duplicate ? { sent: false, message: 'A follow-up was already sent today.' } : { sent: true, message: `Follow-up queued for ${person?.name}.` };
}
function followUpRecipient(t, cs, control) {
  const { worker } = audience(t, cs);
  return worker && control.remediation?.route === 'worker' && cs.gap_kind !== 'data'
    ? { person: worker, type: 'worker' }
    : { person: owner(t, cs), type: 'owner' };
}
function recordVerdict(t, user, cs, verdict, note) {
  P.assertPack(user, cs.pack_key);
  if (!['confirmed', 'false_finding'].includes(verdict)) throw new HttpError(400, 'Invalid verdict.');
  db.update('cases', cs.id, { finding_verdict: verdict, verdict_by: user.name, verdict_note: note || null });
  if (verdict === 'false_finding') P.bump(t, 'false_findings');
  P.audit(t, 'FINDING_REVIEWED', cs.subject_name, `${cs.control_name}: owner marked finding as ${verdict.replace('_', ' ')}.${note ? ` ${note}` : ''}`, user, { case_id: cs.id });
}
function requestDecision(t, user, kind, cs, title, detail, pack, ref) {
  db.insert('approvals', { id: id('apr'), tenant_id: t, kind, ref_id: ref, case_id: cs?.id || null, pack_key: pack, title, detail, requested_by: user.name, created_at: clock.iso() });
  P.audit(t, 'APPROVAL_REQUESTED', title, detail, user, { case_id: cs?.id });
}
function decide(t, user, apr, decision, note) {
  if (apr.status !== 'pending') throw new HttpError(409, 'Already decided.');
  if (!['approved', 'rejected'].includes(decision)) throw new HttpError(400, 'Invalid decision.');
  if (apr.pack_key) P.assertPack(user, apr.pack_key); else P.assertAdmin(user);
  if (user.role === 'viewer') throw new HttpError(403, 'Read-only users cannot approve.');
  if (apr.kind === 'action' && decision === 'approved') W.requireVerified(t);
  db.tx(() => {
    db.update('approvals', apr.id, { status: decision, decided_by: user.name, decided_at: clock.iso(), note: note || null });
    P.audit(t, 'APPROVAL_DECIDED', apr.title, `${decision}${note ? `: ${note}` : ''}`, user, { case_id: apr.case_id });
    const ok = decision === 'approved';
    if (apr.kind === 'action') {
      db.update('actions', apr.ref_id, { status: ok ? 'queued' : 'rejected' });
      if (ok) P.enqueue(t, 'send_action', { action_id: apr.ref_id }, { dedupe: `send:${apr.ref_id}` });
    } else if (apr.kind === 'control_activation') {
      const ch = db.get('SELECT * FROM control_changes WHERE id=? AND tenant_id=?', apr.ref_id, t);
      if (ok) db.run("UPDATE control_changes SET status='superseded' WHERE tenant_id=? AND control_key=? AND status='active'", t, ch.control_key);
      db.update('control_changes', ch.id, { status: ok ? 'active' : 'rejected', approved_by: user.name, activated_at: ok ? clock.iso() : null });
      if (ok) P.enqueue(t, 'evaluate_tenant', { trigger: 'control_activated' }, { dedupe: `eval_tenant:${t}` });
    } else if (apr.kind === 'readiness_decision') {
      db.update('workers', apr.ref_id, { readiness: ok ? 'approved' : 'blocked' });
    } else if (apr.kind === 'notice_response') {
      db.update('notices', apr.ref_id, { status: ok ? 'response_approved' : 'needs_rework' });
    }
  });
}
module.exports = { notifyRejected, loadCtx, evaluateSubject, evaluateTenant, evaluateById, sendAction, runReminders, setMode, followUp, followUpRecipient, recordVerdict, requestDecision, decide, enqueueAction, planNext, setState, currentFacility, OPEN };
