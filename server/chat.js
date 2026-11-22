'use strict';
// Coworker orchestrator. Interprets a request, reads the same records as the dashboard,
// and routes anything that changes state through the action service.
const db = require('./lib/db'), { clock, id, j, addDays } = require('./lib/util');
const P = require('./platform'), V = require('./views'), E = require('./engine'), R = require('./registry'), llm = require('./llm');
const READ_INTENTS = ['missing_new_workers', 'expiring', 'approvals', 'unresolved_by_team', 'coverage', 'help'];
const CONFIRM_FOLLOW_UP = /^confirm follow-ups ([a-f0-9]{12})\.?$/;
function detect(q) {
  if (/^(please )?(create|build|make)\s+[^?]*\b(dashboard|view)\b[^?]*$/.test(q)) return 'create_dashboard';
  if (/^(please )?request (the )?missing documents\.?$/.test(q)) return 'request_missing';
  if (/need.*approv|pending approv|my approval|approvals/.test(q)) return 'approvals';
  if (/expir/.test(q)) return 'expiring';
  if (/new (workers?|hires?|employees?)/.test(q)) return 'missing_new_workers';
  if (/unresolved|open cases?|by team/.test(q)) return 'unresolved_by_team';
  if (/100|complian(t|ce)|coverage|how are we|status overall/.test(q)) return 'coverage';
  return null;
}
function eligibleFollowUps(t, user) {
  const controls = new Set(R.effectiveControls(t).filter((c) => c.mode === 'auto' && P.canPack(user, c.pack_key)).map((c) => c.key));
  return V.listCases(t, user).filter((c) => controls.has(c.control_key) && c.gap_kind !== 'review' && c.finding_verdict !== 'false_finding');
}
const followUpKey = (t, user) => `chat_follow_ups:${t}:${user.id}`;
function previewFollowUps(t, user) {
  if (user.role === 'viewer') return 'Your read-only role cannot queue follow-ups.';
  const cases = eligibleFollowUps(t, user);
  if (!cases.length) return 'No open cases in your authorized automatic packs are ready for a follow-up.';
  const code = id('preview').slice('preview_'.length);
  const proposal = JSON.stringify({ code, expiresAt: Date.now() + 5 * 60 * 1000, caseIds: cases.map((c) => c.id) });
  db.run('INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v', followUpKey(t, user), proposal);
  return `${cases.length} case(s) are eligible for a follow-up. Review them in Cases. To queue follow-ups for this set, reply within five minutes with: Confirm follow-ups ${code}`;
}
function confirmFollowUps(t, user, code) {
  if (user.role === 'viewer') return 'Your read-only role cannot queue follow-ups.';
  return db.tx(() => {
    const key = followUpKey(t, user), value = db.get('SELECT v FROM meta WHERE k=?', key)?.v;
    const proposal = j(value);
    if (!proposal || proposal.code !== code || proposal.expiresAt <= Date.now()
      || !db.run('DELETE FROM meta WHERE k=? AND v=?', key, value).changes) {
      return 'This confirmation is unavailable. Request a fresh preview with “Request the missing documents”.';
    }
    const selected = new Set(proposal.caseIds);
    let sent = 0;
    for (const c of eligibleFollowUps(t, user)) {
      if (selected.has(c.id) && E.followUp(t, user, c).sent) sent++;
    }
    P.audit(t, 'CHAT_COMMAND', user.name, `Confirmed open-case follow-ups. ${sent} queued.`, user);
    return `Queued **${sent}** follow-up(s). ${selected.size - sent} skipped because they were already queued or no longer eligible.`;
  });
}
function expiryWindow(q) {
  const today = clock.today();
  if (/next month/.test(q)) { const d = new Date(today + 'T00:00:00Z'); const s = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)), e = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 2, 0)); return [s.toISOString().slice(0, 10), e.toISOString().slice(0, 10), 'next month']; }
  const m = /(\d+)\s*days?/.exec(q);
  if (m) return [today, addDays(today, +m[1]), `the next ${m[1]} days`];
  return [today, addDays(today, 60), 'the next 60 days'];
}
async function respond(t, user, text) {
  const q = text.trim().toLowerCase();
  const confirmation = CONFIRM_FOLLOW_UP.exec(q);
  if (confirmation) return confirmFollowUps(t, user, confirmation[1]);
  let intent = detect(q), workerName = null;
  const workers = V.listWorkers(t, user);
  const named = workers.find((w) => q.includes(w.name.toLowerCase().split(/[ ,]/)[0]));
  if (!intent && named) { intent = 'worker_status'; workerName = named; }
  if (!intent && llm.enabled(t)) {
    const r = await llm.callTool(t, 'Classify this read-only compliance question. Reply only through the tool.', [{ type: 'text', text }], 'classify', { type: 'object', properties: { intent: { type: 'string', enum: READ_INTENTS } }, required: ['intent'] });
    if (READ_INTENTS.includes(r?.intent)) intent = r.intent;
  }
  const open = V.listCases(t, user);
  switch (intent) {
    case 'missing_new_workers': {
      const since = addDays(clock.today(), -30), recent = workers.filter((w) => w.hire_date >= since && w.status === 'active');
      if (!recent.length) return 'No workers were hired in the last 30 days.';
      const lines = recent.map((w) => { const c = open.filter((x) => x.subject_id === w.id); return `• **${w.name}**: ${c.length ? c.map((x) => x.control_name).join(', ') : 'nothing open'}`; });
      return `For ${recent.length} worker(s) hired in the last 30 days:\n${lines.join('\n')}`;
    }
    case 'expiring': {
      const [a, b, label] = expiryWindow(q), ev = V.listEvidence(t, user).filter((e) => e.status === 'accepted' && e.expires_on && e.expires_on >= a && e.expires_on <= b).sort((x, y) => x.expires_on.localeCompare(y.expires_on));
      return ev.length ? `**${ev.length} credential(s)** expire in ${label}:\n${ev.map((e) => `• **${e.subject_name}**: ${e.doc_type.replace(/_/g, ' ')}, ${e.expires_on}`).join('\n')}` : `No accepted credentials expire in ${label}.`;
    }
    case 'request_missing': return previewFollowUps(t, user);
    case 'approvals': {
      const a = V.listApprovals(t, user);
      return a.length ? `**${a.length}** item(s) need your approval:\n${a.slice(0, 10).map((x) => `• ${x.title}`).join('\n')}` : 'Nothing needs your approval.';
    }
    case 'unresolved_by_team': {
      if (!open.length) return 'There are no unresolved cases you can see.';
      const g = {}; for (const c of open) (g[c.owner_team] ||= []).push(c);
      return `**${open.length}** unresolved case(s):\n${Object.entries(g).map(([k, v]) => `• **${k}**: ${v.length}`).join('\n')}`;
    }
    case 'coverage': {
      const c = V.coverage(t);
      return `${c.pass} of ${c.total} applicable checks pass, ${c.fail} fail and ${c.unknown} are unknown.\n${c.scope_statement} I can report verified completion of these checks, but I cannot say the whole company is compliant.`;
    }
    case 'create_dashboard': {
      if (user.role === 'viewer') return 'Your read-only role cannot create dashboards.';
      const pack = /health/.test(q) ? 'healthcare' : /onboard/.test(q) ? 'onboarding' : /immig/.test(q) ? 'immigration' : /payroll|tax/.test(q) ? 'payroll' : null;
      const metric = /missing/.test(q) ? 'missing_evidence' : /expir/.test(q) ? 'expirations' : 'open_gaps';
      const group_by = /by team/.test(q) ? 'team' : /by pack/.test(q) ? 'pack' : /by control|by credential/.test(q) ? 'control' : 'facility';
      const did = id('dash'), name = text.replace(/^(please )?(create|build|make) (a|an|the)?\s*/i, '').replace(/\.$/, '').replace(/^./, (x) => x.toUpperCase());
      db.insert('dashboards', { id: did, tenant_id: t, name, definition_json: JSON.stringify({ pack, metric, group_by }), roles_json: JSON.stringify([user.role]), created_by: user.name, created_at: clock.iso() });
      P.audit(t, 'DASHBOARD_CREATED', name, 'Saved from chat.', user);
      return `Saved **${name}**. People with the ${P.ROLE_LABEL[user.role]} role can open it at #dashboards/${did}.`;
    }
    case 'worker_status': {
      const d = V.workerDetail(t, user, workerName.id);
      return `**${d.name}**\n${d.readiness_view.summary.map((s) => `• ${s.pack}: ${s.status.replace('_', ' ')}`).join('\n')}\n${d.readiness_view.statement}`;
    }
    default:
      return `I can answer questions from the compliance record. Try “What is missing for new workers?”, “Which credentials expire next month?”, or “Show unresolved cases by team”.${user.role === 'viewer' ? '' : ' Say “Request the missing documents” to preview follow-ups before confirming.'}`;
  }
}
async function handle(t, user, text) {
  const add = (sender, author, msg) => db.insert('chat_messages', { id: id('chat'), tenant_id: t, user_id: user.id, sender, author, text: msg, created_at: clock.iso() });
  add('user', user.name, text);
  const reply = await respond(t, user, text);
  add('bot', 'Aegis Coworker', reply);
  return reply;
}
module.exports = { handle, respond };
