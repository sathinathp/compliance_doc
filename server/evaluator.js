'use strict';
// Deterministic control evaluator. No AI here: every result is Pass, Fail, Unknown or Not applicable,
// with a reason and evidence references. Missing or stale evidence can never yield Pass.
const { addDays, daysBetween, nameMatch } = require('./lib/util');

const NA = (reason) => ({ status: 'not_applicable', code: 'not_applicable', reason, evidence_ids: [], action_needed: false, gap_kind: null });
const unknown = (code, reason, gap_kind, extra = {}) => ({ status: 'unknown', code, reason, evidence_ids: [], action_needed: true, gap_kind, ...extra });
const fail = (code, reason, gap_kind, extra = {}) => ({ status: 'fail', code, reason, evidence_ids: [], action_needed: true, gap_kind, ...extra });
const pass = (code, reason, evidence_ids, extra = {}) => ({ status: 'pass', code, reason, evidence_ids, action_needed: false, gap_kind: null, ...extra });

function latestDuePeriod(today) {
  const y = +today.slice(0, 4);
  const list = [[`Q3-${y - 1}`, `${y - 1}-10-31`], [`Q4-${y - 1}`, `${y}-01-31`], [`Q1-${y}`, `${y}-04-30`], [`Q2-${y}`, `${y}-07-31`], [`Q3-${y}`, `${y}-10-31`]];
  const hit = list.filter((p) => p[1] <= today).pop();
  return { period: hit[0], due: hit[1] };
}
function applies(c, s, ctx) {
  const a = c.applies_when || {}, attrs = s.attrs || {};
  if (a.category && !a.category.includes(s.category)) return { ok: false, why: `Applies to ${a.category.join('/')} workers only.` };
  if (a.license_type) {
    if (!s.license_type) return { ok: null, why: 'License type is missing from the worker record.' };
    if (!a.license_type.includes(s.license_type)) return { ok: false, why: `Does not apply to license type ${s.license_type}.` };
  }
  if (a.has && !s[a.has] && !attrs[a.has]) return { ok: false, why: `No ${a.has.replace(/_/g, ' ')} on the worker record.` };
  if (a.facility_requires) {
    if (!ctx.facility) return { ok: null, why: 'Not assigned to a work location, so location requirements cannot be checked.' };
    if (!ctx.facility.requirements_confirmed) return { ok: null, why: `Requirements for ${ctx.facility.name} have not been confirmed.` };
    if (!(ctx.facilityReqs || []).includes(a.facility_requires)) return { ok: false, why: `${ctx.facility.name} does not require this.` };
  }
  return { ok: true };
}
function evaluate(c, s, ctx) {
  if (s.status && s.status !== 'active') return NA(`Worker is ${s.status}.`);
  const ap = applies(c, s, ctx);
  if (ap.ok === false) return NA(ap.why);
  if (ap.ok === null) return unknown('missing_context', ap.why, 'data');
  const today = ctx.today, docTypes = c.evidence?.doc_types || [];
  const ev = (ctx.evidence || []).filter((e) => docTypes.includes(e.doc_type));
  // A possible match ("Alex" for Alex Patel) counts once a person accepted it; a different person never does.
  const wrongHolder = (e) => c.subject === 'worker' && e.holder_name && s.name && nameMatch(e.holder_name, s.name) === 'different';
  const accepted = ev.filter((e) => e.status === 'accepted' && !wrongHolder(e));
  const pending = (ctx.evidence || []).filter((e) => e.status === 'needs_review' && (docTypes.includes(e.doc_type) || e.control_key === c.key));
  const review = (msg) => unknown('awaiting_review', msg, 'review', { evidence_ids: pending.map((e) => e.id) });

  switch (c.type) {
    case 'credential_current': {
      const warn = c.remediation?.request_days_before ?? 30, maxAge = c.params?.max_age_days;
      const withExp = accepted.map((e) => ({ e, exp: e.expires_on || (maxAge && e.issued_on ? addDays(e.issued_on, maxAge) : null) }));
      if (!accepted.length) return pending.length ? review('Evidence received and awaiting review.') : unknown('missing_evidence', `No accepted ${c.name} on file.`, 'evidence');
      const dated = withExp.filter((x) => x.exp).sort((a, b) => b.exp.localeCompare(a.exp));
      if (!dated.length) return unknown('evidence_incomplete', 'Accepted evidence has no expiration or issue date, so currency cannot be confirmed.', 'evidence');
      const best = dated[0], days = daysBetween(today, best.exp);
      if (days < 0) return fail('expired', `${c.name} expired ${-days} day(s) ago on ${best.exp}.${pending.length ? ' A replacement is awaiting review.' : ''}`, pending.length ? 'review' : 'evidence', { evidence_ids: [best.e.id, ...pending.map((e) => e.id)], due: best.exp });
      if (c.params?.state_must_match && ctx.facility && best.e.state && best.e.state !== ctx.facility.state)
        return unknown('state_mismatch', `License state ${best.e.state} does not match work state ${ctx.facility.state}. Specialist review needed.`, 'review', { evidence_ids: [best.e.id] });
      if (days <= warn) return pass('expiring', `${c.name} is valid but expires in ${days} day(s) on ${best.exp}.`, [best.e.id], { action_needed: true, gap_kind: pending.length ? 'review' : 'evidence', due: best.exp, days });
      return pass('current', `${c.name} is current until ${best.exp}.`, [best.e.id]);
    }
    case 'document_required': {
      if (accepted.length) return pass('on_file', `${c.name} accepted and on file.`, [accepted[0].id]);
      if (pending.length) return review('Evidence received and awaiting review.');
      const dl = c.params?.deadline_days_from_hire;
      if (dl === undefined) return unknown('missing_evidence', `No accepted ${c.name} on file.`, 'evidence');
      if (!s.hire_date) return unknown('missing_context', 'Hire date is missing, so the deadline cannot be calculated.', 'data');
      const due = addDays(s.hire_date, dl);
      if (today > due) return fail('overdue', `${c.name} was due ${due} and has not been accepted.`, 'evidence', { due });
      return unknown('not_yet_received', `${c.name} not yet received. Due ${due}.`, 'evidence', { due });
    }
    case 'field_required': {
      const attrs = s.attrs || {}, missing = (c.params?.fields || []).filter((f) => !s[f] && !attrs[f]);
      if (missing.length) return unknown('missing_data', `Missing from the worker record: ${missing.join(', ').replace(/_/g, ' ')}.`, 'data');
      return pass('fields_present', 'Required fields are present on the worker record.', [`record:worker:${s.id}`]);
    }
    case 'periodic_filing': {
      const { period, due } = latestDuePeriod(today);
      const match = accepted.filter((e) => e.period === period && e.entity_name === s.name);
      if (match.length) return pass('filed', `Filing evidence accepted for ${period}.`, [match[0].id]);
      if (pending.length) return review(`Evidence for ${period} is awaiting review.`);
      return unknown('missing_filing_evidence', `No accepted filing evidence for ${period} (due ${due}).`, 'evidence', { due });
    }
    default: return unknown('unsupported_control', `Control type ${c.type} is not supported.`, 'data');
  }
}
module.exports = { evaluate, latestDuePeriod };
