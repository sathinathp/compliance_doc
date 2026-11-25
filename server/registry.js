'use strict';
// Pack registry: versioned packs, tenant activation, customer overrides and custom controls.
const fs = require('fs'), path = require('path');
const db = require('./lib/db'), { clock, id, j, count } = require('./lib/util'), P = require('./platform'), { evaluate } = require('./evaluator');
const { HttpError } = P;

function loadPacks() {
  const dir = path.join(__dirname, 'packs');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    const p = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    const results = (p.tests || []).map((t) => {
      const c = p.controls.find((x) => x.key === t.control);
      const got = evaluate(c, t.subject, { today: clock.today(), evidence: t.evidence }).status;
      return { name: t.name, control: t.control, expect: t.expect, got, ok: got === t.expect };
    });
    db.run('INSERT INTO packs(key,version,definition_json,validation_json) VALUES(?,?,?,?) ON CONFLICT(key,version) DO UPDATE SET definition_json=excluded.definition_json, validation_json=excluded.validation_json', p.key, p.version, JSON.stringify(p), JSON.stringify(results));
  }
}
const packDef = (key, ver) => {
  const r = ver ? db.get('SELECT * FROM packs WHERE key=? AND version=?', key, ver) : db.get('SELECT * FROM packs WHERE key=? ORDER BY version DESC', key);
  return r ? { ...j(r.definition_json), validation: j(r.validation_json, []) } : null;
};
const allPacks = () => db.all('SELECT key FROM packs GROUP BY key').map((r) => packDef(r.key));
const tenantPack = (t, k) => db.get('SELECT * FROM tenant_packs WHERE tenant_id=? AND pack_key=?', t, k);

function merge(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch || {})) out[k] = v && typeof v === 'object' && !Array.isArray(v) ? merge(base[k] || {}, v) : v;
  return out;
}
// Reviewed pack requirements stay untouched; active customer overrides are layered at read time.
function effectiveControls(t) {
  const out = [];
  for (const tp of db.all("SELECT * FROM tenant_packs WHERE tenant_id=? AND status='active'", t)) {
    const p = packDef(tp.pack_key, tp.version);
    for (const c of p.controls) {
      const o = db.get("SELECT * FROM control_changes WHERE tenant_id=? AND kind='override' AND control_key=? AND status='active' ORDER BY version DESC", t, c.key);
      const def = o ? merge(c, j(o.definition_json)) : c;
      out.push({ ...def, pack_key: p.key, pack_name: p.name, team: p.team, restricted: !!p.restricted, version_label: `${p.key}@${tp.version}/${c.key}${o ? `+override.${o.version}` : ''}`, overridden: !!o, mode: tp.mode, owner_user_id: tp.owner_user_id });
    }
  }
  for (const r of db.all("SELECT * FROM control_changes WHERE tenant_id=? AND kind='custom' AND status='active'", t)) {
    const d = j(r.definition_json);
    const tp = tenantPack(t, d.pack_key);
    if (!tp || tp.status !== 'active') continue;
    const p = packDef(d.pack_key, tp.version);
    out.push({ ...d, key: r.control_key, pack_name: p.name, team: p.team, restricted: !!p.restricted, version_label: `custom/${r.control_key}@${r.version}`, custom: true, mode: tp.mode, owner_user_id: tp.owner_user_id });
  }
  return out;
}

const WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
const num = (s) => WORDS[String(s).toLowerCase()] ?? parseInt(s, 10);
const TARGETS = [[/\bbls\b/i, 'CTRL-HC-BLS'], [/\bacls\b/i, 'CTRL-HC-ACLS'], [/\btb\b/i, 'CTRL-HC-TB'], [/\bflu\b/i, 'CTRL-HC-FLU'], [/licen[sc]e/i, 'CTRL-HC-LICENSE'], [/work auth|\bead\b|reverif/i, 'CTRL-IMM-REVERIFY']];

function parseRule(text, controls, defaults = controls) {
  const custom = /require[sd]?\s+(?:a |an |the )?(.+?)\s+within\s+(\d+)\s+days?\s+of\s+hire(?:\s+for\s+(clinical|corporate|all)\b)?/i.exec(text);
  if (custom) {
    const name = custom[1].trim().replace(/^./, (c) => c.toUpperCase());
    return { kind: 'custom', definition: { name, pack_key: custom[3]?.toLowerCase() === 'clinical' ? 'healthcare' : 'onboarding', requirement_type: 'internal', source: 'Customer internal control', subject: 'worker', type: 'document_required', priority: 'medium', applies_when: custom[3] && custom[3].toLowerCase() !== 'all' ? { category: [custom[3].toLowerCase()] } : {}, params: { deadline_days_from_hire: +custom[2] }, evidence: { doc_types: [`custom_${name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`], auto_accept: false, required_fields: ['holder_name'] }, remediation: { reminder_every_days: 3, max_reminders: 2, route: 'worker' } } };
  }
  const rem = {};
  let m;
  if ((m = /(\d+)\s*days?\s+before\s+(?:the\s+)?expir/i.exec(text))) rem.request_days_before = +m[1];
  if ((m = /after\s+(\w+)\s+(?:unanswered\s+)?reminders?/i.exec(text)) && !isNaN(num(m[1]))) rem.max_reminders = num(m[1]);
  if ((m = /every\s+(\d+)\s*days?/i.exec(text))) rem.reminder_every_days = +m[1];
  if (!Object.keys(rem).length) return null;
  const hits = TARGETS.filter(([re]) => re.test(text)).map((x) => x[1]);
  const usable = defaults.filter((c) => c.type === 'credential_current').map((c) => c.key);
  const targets = (hits.length ? hits : usable).filter((k) => controls.some((c) => c.key === k));
  return targets.length ? { kind: 'override', targets, patch: { remediation: rem } } : null;
}

function subjectsFor(t) {
  return { workers: db.all("SELECT * FROM workers WHERE tenant_id=? AND status='active'", t), entities: db.all('SELECT * FROM entities WHERE tenant_id=?', t) };
}
function previewControl(t, ctrl, loadCtx) {
  const { workers, entities } = subjectsFor(t), rows = [];
  for (const s of ctrl.subject === 'entity' ? entities : workers) {
    const r = evaluate(ctrl, { ...s, attrs: j(s.attrs_json, {}) }, loadCtx(t, ctrl.subject, s));
    if (r.status === 'not_applicable') continue;
    rows.push({ name: s.name, status: r.status, reason: r.reason, would_act: r.action_needed });
  }
  const rem = ctrl.remediation || {};
  return { control: ctrl.name, applicable: rows.length, would_act: rows.filter((r) => r.would_act).length, rows: rows.slice(0, 40), schedule: `Request ${rem.request_days_before !== undefined ? `${rem.request_days_before} days before expiration` : 'when the gap is found'}; remind every ${rem.reminder_every_days ?? 3} days; escalate after ${rem.max_reminders ?? 2} unanswered reminders`, sample_message: `Hi {first name}, we need your ${ctrl.name}. Please upload it through your secure link.` };
}
function draftControl(t, user, input, loadCtx) {
  const controls = effectiveControls(t);
  const parsed = parseRule(String(input.text || ''), controls, controls.filter((c) => P.canPack(user, c.pack_key)));
  if (!parsed) throw new HttpError(422, 'I could not turn that into a supported control. Try: "Request renewals 30 days before expiration and escalate after two unanswered reminders" or "Require a parking form within 10 days of hire for clinical staff".');
  const targets = parsed.kind === 'custom' ? [] : parsed.targets.map((key) => controls.find((c) => c.key === key));
  if (parsed.kind === 'custom') P.assertPack(user, parsed.definition.pack_key);
  else for (const c of targets) P.assertPack(user, c.pack_key);
  const made = [];
  const add = (kind, key, pack, def, preview) => {
    const cid = id('chg');
    db.insert('control_changes', { id: cid, tenant_id: t, kind, control_key: key, pack_key: pack, source_text: input.text || 'Form', definition_json: JSON.stringify(def), preview_json: JSON.stringify(preview), status: 'draft', version: (db.get('SELECT MAX(version) v FROM control_changes WHERE tenant_id=? AND control_key=?', t, key)?.v || 0) + 1, created_by: user.name, created_at: clock.iso() });
    made.push({ id: cid, kind, control_key: key, pack_key: pack, preview, definition: def });
  };
  if (parsed.kind === 'custom') {
    const key = `CTRL-CUSTOM-${parsed.definition.name.toUpperCase().replace(/[^A-Z0-9]+/g, '-').slice(0, 24)}`;
    add('custom', key, parsed.definition.pack_key, parsed.definition, previewControl(t, { ...parsed.definition, key }, loadCtx));
  } else for (const c of targets) {
    add('override', c.key, c.pack_key, parsed.patch, previewControl(t, merge(c, parsed.patch), loadCtx));
  }
  P.audit(t, 'CONTROL_DRAFTED', 'Control registry', `Drafted ${count(made.length, 'control change')}: ${input.text || 'form'}`, user);
  return made;
}
function submitDraft(t, user, cid) {
  const d = db.get("SELECT * FROM control_changes WHERE id=? AND tenant_id=? AND status='draft'", cid, t);
  if (!d) throw new HttpError(404, 'Draft not found.');
  P.assertPack(user, d.pack_key);
  db.update('control_changes', cid, { status: 'pending' });
  const pv = j(d.preview_json, {});
  db.insert('approvals', { id: id('apr'), tenant_id: t, kind: 'control_activation', ref_id: cid, pack_key: d.pack_key, title: `Activate ${d.kind === 'custom' ? 'custom control' : 'override'}: ${pv.control}`, detail: `${pv.would_act} of ${pv.applicable} applicable records would be acted on. ${pv.schedule}.`, requested_by: user.name, created_at: clock.iso() });
  P.audit(t, 'APPROVAL_REQUESTED', d.control_key, 'Control change submitted for approval.', user);
}
function pausePackActions(t, pack) {
  const cases = 'SELECT id FROM cases WHERE tenant_id=? AND pack_key=?';
  db.run(`UPDATE cases SET next_reminder_at=COALESCE(next_reminder_at,?) WHERE tenant_id=? AND closed_at IS NULL AND id IN
    (SELECT case_id FROM actions WHERE tenant_id=? AND type='reminder' AND status='queued' AND case_id IN (${cases}))`, clock.iso(), t, t, t, pack);
  db.run(`UPDATE approvals SET status='withdrawn', note='Pack returned to validation mode', decided_at=? WHERE tenant_id=? AND pack_key=? AND kind='action' AND status='pending'`, clock.iso(), t, pack);
  db.run(`UPDATE actions SET status='paused', error=NULL WHERE tenant_id=? AND status IN ('queued','pending_approval') AND case_id IN (${cases})`, t, t, pack);
}
function activatePack(t, user, key, { owner_user_id, reviewed }) {
  P.assertAdmin(user);
  const p = packDef(key);
  if (!p) throw new HttpError(404, 'Unknown pack.');
  if (!reviewed) throw new HttpError(400, 'Confirm that applicability, sources and deadlines were reviewed.');
  const owner = db.get('SELECT * FROM users WHERE id=? AND tenant_id=? AND disabled_at IS NULL', owner_user_id, t);
  if (!owner) throw new HttpError(400, 'Choose a responsible owner.');
  if (!P.canPack(owner, key)) throw new HttpError(400, 'Choose an owner with permission to act on this pack.');
  if (p.validation.some((v) => !v.ok)) throw new HttpError(409, 'This pack version failed its validation tests.');
  db.tx(() => {
    db.run(`INSERT INTO tenant_packs(tenant_id,pack_key,version,status,mode,owner_user_id,reviewed_by,activated_at) VALUES(?,?,?,'active','shadow',?,?,?)
      ON CONFLICT(tenant_id,pack_key) DO UPDATE SET status='active',mode='shadow',version=excluded.version,owner_user_id=excluded.owner_user_id,reviewed_by=excluded.reviewed_by,activated_at=excluded.activated_at`, t, key, p.version, owner_user_id, user.name, clock.iso());
    pausePackActions(t, key);
    db.run('UPDATE cases SET owner_user_id=?, finding_verdict=NULL, verdict_by=NULL, verdict_note=NULL WHERE tenant_id=? AND pack_key=? AND closed_at IS NULL', owner_user_id, t, key);
    P.audit(t, 'PACK_ACTIVATED', p.name, `Activated ${p.name} v${p.version} in validation mode. Owner: ${owner.name}.`, user);
    P.enqueue(t, 'evaluate_tenant', { trigger: 'pack_activated' }, { dedupe: `eval_tenant:${t}` });
  });
}
module.exports = { loadPacks, packDef, allPacks, tenantPack, effectiveControls, parseRule, draftControl, submitDraft, activatePack, pausePackActions, merge, previewControl };
