'use strict';
// The model interprets a conversation. Aegis reads records and runs authorized actions.
const db = require('./lib/db'), { clock, id, j, count, addDays } = require('./lib/util');
const W = require('./lib/workspace');
const P = require('./platform'), V = require('./views'), E = require('./engine'), R = require('./registry'), llm = require('./llm');
const Policy = require('./coworker-policy');
const Conversation = require('./coworker-conversation');
const MAX_RESULTS = 10;
const MAX_FOLLOW_UPS = 10;
const CONFIRM_FOLLOW_UP = /^confirm follow-ups ([a-f0-9]{12})\.?$/;
const CREATE_DASHBOARD = /^(?:please )?(?:create|build|make)[ \t]+(?:(?:a|an|the)[ \t]+)?(?:(?:healthcare|onboarding|immigration|payroll|tax)[ \t]+)?(?:dashboard|view)(?:[ \t]+(?:showing|for|with|by|of|named|called)[ \t]+[^?\r\n]+)?\.?$/;
const WORKSPACE_ACTION = 'Open Ask coworker in the Aegis workspace top bar to review and run actions.';

function command(q) {
  if (CREATE_DASHBOARD.test(q)) return 'create_dashboard';
  if (/^(please )?request (the )?missing documents\.?$/.test(q)) return 'request_missing';
  return null;
}

function eligibleFollowUps(t, user, selected) {
  const controls = new Map(R.effectiveControls(t).filter((c) => c.mode === 'auto' && P.canPack(user, c.pack_key)).map((c) => [c.key, c]));
  const alreadyQueued = new Set(db.all("SELECT case_id FROM actions WHERE tenant_id=? AND type='follow_up' AND status<>'paused' AND idempotency_key LIKE ?", t, '%:manual:' + clock.today()).map((a) => a.case_id));
  const items = [];
  for (const c of V.listCases(t, user)) {
    const control = controls.get(c.control_key);
    if (!control || c.gap_kind !== 'evidence' || c.finding_verdict === 'false_finding' || alreadyQueued.has(c.id)) continue;
    if (selected && !selected.has(c.id)) continue;
    const { person, type } = E.followUpRecipient(t, c, control);
    if (!person || (type === 'worker' ? person.status !== 'active' : !P.canPack(person, c.pack_key))) continue;
    const expected = selected?.get(c.id);
    if (expected && (expected.controlKey !== c.control_key || expected.recipientId !== person.id || expected.recipientType !== type)) continue;
    items.push({ caseId: c.id, controlKey: c.control_key, recipientId: person.id, recipientType: type, recipientName: person.name, case: c });
    if (items.length === MAX_FOLLOW_UPS) break;
  }
  return items;
}

const followUpKey = (t, user) => 'chat_follow_ups:' + t + ':' + user.id;
const actionAudit = (t, user, action, detail) => P.audit(t, 'CHAT_COMMAND', user.name, action, user, { detail: { actor_id: user.id, role: user.role, source: 'web', ...detail } });
function activeProposal(t, user, chatId, policy) {
  if (!policy.enabled || !policy.follow_ups || user.role === 'viewer' || W.pending(t)) return null;
  const value = db.get('SELECT v FROM meta WHERE k=?', followUpKey(t, user))?.v;
  const proposal = j(value);
  if (!Array.isArray(proposal?.items) || proposal.chatId !== chatId || proposal.actorEpoch !== user.coworker_epoch
    || proposal.policyEpoch !== policy.follow_up_epoch || proposal.expiresAt <= Date.now()) return null;
  return { proposal, value };
}

function previewFollowUps(t, user, chatId, policy) {
  if (user.role === 'viewer') return 'Your read-only role cannot queue follow-ups.';
  if (!policy.follow_ups) return 'Evidence follow-ups from the coworker are turned off for this workspace.';
  if (W.pending(t)) return W.CONFIRM_EMAIL;
  const items = eligibleFollowUps(t, user);
  if (!items.length) return 'There are no evidence follow-ups ready to queue in your authorized automatic packs.';
  const code = id('preview').slice('preview_'.length);
  const selected = items.map(({ caseId, controlKey, recipientId, recipientType }) => ({ caseId, controlKey, recipientId, recipientType }));
  const proposal = JSON.stringify({ code, chatId, actorEpoch: user.coworker_epoch, policyEpoch: policy.follow_up_epoch, expiresAt: Date.now() + 5 * 60 * 1000, items: selected });
  db.tx(() => {
    db.run('INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v', followUpKey(t, user), proposal);
    actionAudit(t, user, 'Previewed evidence follow-ups.', { case_ids: selected.map((item) => item.caseId) });
  });
  const lines = items.map((item) => '• ' + item.case.subject_name + ' · ' + item.case.control_name + ' · to ' + item.recipientName + ' (' + item.recipientType + ') · #cases/' + item.caseId);
  return ['**' + count(items.length, 'evidence follow-up') + ' ready**', ...lines, 'To queue these follow-ups, reply within five minutes with: Confirm follow-ups ' + code].join('\n');
}

function confirmFollowUps(t, user, code, chatId, policy) {
  if (user.role === 'viewer') return 'Your read-only role cannot queue follow-ups.';
  if (!policy.follow_ups) return 'Evidence follow-ups from the coworker are turned off for this workspace.';
  if (W.pending(t)) return W.CONFIRM_EMAIL;
  return db.tx(() => {
    const active = activeProposal(t, user, chatId, policy);
    if (!active || active.proposal.code !== code
      || !db.run('DELETE FROM meta WHERE k=? AND v=?', followUpKey(t, user), active.value).changes) {
      return 'This confirmation is unavailable. Request a fresh preview with “Request the missing documents”.';
    }
    const selected = new Map(active.proposal.items.map((item) => [item.caseId, item]));
    const queued = [];
    for (const item of eligibleFollowUps(t, user, selected)) {
      if (E.followUp(t, user, item.case, { ...item, policyEpoch: policy.follow_up_epoch }).sent) queued.push(item.caseId);
    }
    actionAudit(t, user, 'Confirmed evidence follow-ups. ' + queued.length + ' queued.', { case_ids: [...selected.keys()], queued_case_ids: queued });
    return { reply: 'Queued **' + queued.length + '** ' + (queued.length === 1 ? 'follow-up' : 'follow-ups') + '. ' + (selected.size - queued.length) + ' skipped because the case or recipient changed, or a follow-up was already queued.', updated: queued.length > 0 };
  });
}

function expiryWindow({ window, days = 60 }) {
  const today = clock.today();
  if (window === 'next_month') {
    const day = new Date(today + 'T00:00:00Z'), year = day.getUTCFullYear(), month = day.getUTCMonth();
    const start = new Date(Date.UTC(year, month + 1, 1)), end = new Date(Date.UTC(year, month + 2, 0));
    return [start.toISOString().slice(0, 10), end.toISOString().slice(0, 10), 'next month'];
  }
  if (days < 1 || days > 365) return null;
  return [today, addDays(today, days), 'the next ' + days + ' days'];
}

function resultLines(rows, format) {
  const lines = rows.slice(0, MAX_RESULTS).map(format);
  if (rows.length > MAX_RESULTS) lines.push('Showing the first ' + MAX_RESULTS + ' of ' + rows.length + '.');
  return lines.join('\n');
}

const nameWords = (text) => (text || '').normalize('NFKD').toLowerCase().replace(/\p{M}/gu, '').match(/[\p{L}\p{N}]+/gu)?.join(' ') || '';
const evidenceReasons = new Set(['missing_evidence', 'not_yet_received', 'missing_filing_evidence', 'overdue', 'evidence_incomplete', 'expired']);
function workerStatus(t, user, plan, text) {
  const name = nameWords(plan.worker_name);
  if (!name) return 'Enter the worker’s name, for example “Worker status for Alex Morgan”.';
  const workers = db.all('SELECT id,name FROM workers WHERE tenant_id=?', t);
  const exact = workers.filter((w) => nameWords(w.name) === name);
  const matches = exact.length ? exact : workers.filter((w) => !name.includes(' ') && nameWords(w.name).split(' ')[0] === name);
  if (matches.length > 1) return 'More than one worker matches. Open Workers to pick the right record. #workers';
  if (!matches.length) return 'I couldn’t find that worker in this workspace. #workers';
  const d = V.workerDetail(t, user, matches[0].id);
  const evidenceOnly = /\b(?:evidence|documents?)\b.*\bmissing\b|\bmissing\b.*\b(?:evidence|documents?)\b/i.test(text);
  const blockers = d.checks_list.filter((check) => ['fail', 'unknown'].includes(check.status)
    && (!plan.pack || check.pack_key === plan.pack) && (!plan.status || check.status === plan.status)
    && (!evidenceOnly || evidenceReasons.has(check.code)));
  const summary = blockers.length ? resultLines(blockers, (b) => '• **' + b.control_name + '**: ' + b.reason)
    : evidenceOnly ? 'I found no visible checks here that call for missing or replacement evidence.'
      : plan.pack || plan.status ? 'I found no visible checks that match those filters.' : d.readiness_view.statement;
  return '**' + d.name + '**\n' + summary + '\n#workers';
}

const packName = (pack) => pack ? pack.charAt(0).toUpperCase() + pack.slice(1) : '';
const plural = (count, word) => word + (count === 1 ? '' : 's');
function nextSteps(t, user, topic, plan) {
  if (topic?.intent === 'expiring') return 'Start with the earliest expiration in the list. Open Evidence to check the document, then use its case if a renewal is needed.\n#evidence\n#cases';
  if (topic?.intent === 'approvals') return 'Open Approvals and review the evidence and reason before deciding on each item assigned to your role.\n#approvals';
  if (topic?.intent === 'worker_status') return 'Open the worker record and review the checks listed above. Use the related case for missing evidence, or open Evidence to review a document already submitted.\n#workers\n#evidence';
  const pack = plan.pack || topic?.pack, status = plan.status || topic?.status;
  let open = V.listCases(t, user, { pack });
  if (status) {
    const matching = new Set(V.checks(t, user, { pack, status }).map((c) => c.subject_id + ':' + c.control_key));
    open = open.filter((c) => matching.has(c.subject_id + ':' + c.control_key));
  }
  if (!open.length) return 'I found no open cases in that scope. Open Checks to review the current results and their reasons.\n#checks';
  const lines = open.slice(0, 3).map((c) => '• ' + c.subject_name + ' — ' + c.control_name + ' · #cases/' + c.id);
  return 'Start with these cases, ordered by priority and due date. Open each case to see whether it needs evidence, review, or a record update.\n' + lines.join('\n');
}

function respond(t, user, text, { source, chatId, policy, plan, previous, confirmation }) {
  const q = text.toLowerCase();
  if (confirmation) return source === 'web' ? confirmFollowUps(t, user, confirmation[1], chatId, policy) : WORKSPACE_ACTION;
  const { intent, pack, status } = plan || {};
  if ((pack === 'immigration' || (intent === 'next_steps' && previous?.pack === 'immigration')) && !P.canSeeRestricted(user)) {
    return 'Immigration checks are restricted for your role. I can help with the checks you can see.\n#checks';
  }
  const scope = pack ? ' in ' + packName(pack) : '';
  switch (intent) {
    case 'greeting': {
      const first = user.name?.trim().split(/\s+/)[0];
      return (first ? 'Hi, ' + first + '.' : 'Hi.') + ' What are you working on today? I can help you understand a check, find a worker’s blockers, or see which credentials are coming due.';
    }
    case 'introduction': {
      const preview = source === 'web' && policy.follow_ups && user.role !== 'viewer' && !W.pending(t);
      return 'I’m the Aegis coworker. I can explain the checks you can see, show what’s blocking a worker, and find expiring credentials or decisions waiting for you.'
        + (preview ? ' I can also show who would receive an evidence follow-up so you can review the list before confirming.' : '')
        + '\nWhat would you like to look at first?';
    }
    case 'acknowledgment': return 'You’re welcome.' + (previous ? ' We can keep working through this or look at another check.' : ' I’m here if you want to look into a check or a worker.');
    case 'explain_unknown': return 'Unknown means Aegis doesn’t have enough verified information to prove a requirement. Open the check’s reason to see whether evidence is missing, waiting for review, or needs more context.\n#checks';
    case 'explain_failed': return 'A failed check means the available information shows the requirement hasn’t been met. Open the check’s reason, then look for a related case to see what needs to change.\n#checks\n#cases';
    case 'explain_evidence': return 'A check is the result of applying a requirement. Evidence is the document or record that supports it. If you want to know why a requirement is still open, start with its check and read the reason.\n#checks\n#evidence';
    case 'worker_status': return workerStatus(t, user, { ...plan, worker_name: plan.worker_name || previous?.worker_name }, text);
    case 'next_steps': return nextSteps(t, user, previous, plan);
    case 'guidance':
    case 'help':
      if (plan.guidance) return plan.guidance;
      break;
    case 'missing_new_workers': {
      const today = clock.today(), since = addDays(today, -30);
      const recent = db.all("SELECT id,name FROM workers WHERE tenant_id=? AND status='active' AND hire_date BETWEEN ? AND ? ORDER BY hire_date DESC,name", t, since, today);
      if (!recent.length) return 'No workers were hired in the last 30 days.';
      const byWorker = new Map(recent.slice(0, MAX_RESULTS).map((w) => [w.id, []]));
      for (const c of V.listCases(t, user, { pack })) if (c.subject_type === 'worker') byWorker.get(c.subject_id)?.push(c.control_name);
      const lines = resultLines(recent, (w) => '• **' + w.name + '**: ' + (byWorker.get(w.id).join(', ') || 'nothing open'));
      return 'Here are the open cases' + scope + ' for ' + recent.length + ' ' + plural(recent.length, 'worker') + ' hired in the last 30 days:\n' + lines + '\n#workers';
    }
    case 'expiring': {
      const window = expiryWindow(plan);
      if (!window) return 'Choose an expiration window between 1 and 365 days, or ask about next month.';
      const [from, through, label] = window;
      const when = label === 'next month' ? label : 'in ' + label;
      let ev = V.listEvidence(t, user, { acceptedFrom: from, acceptedThrough: through });
      if (pack) {
        const controls = R.effectiveControls(t).filter((c) => c.pack_key === pack);
        const keys = new Set(controls.map((c) => c.key)), types = new Set(controls.flatMap((c) => c.evidence?.doc_types || []));
        ev = ev.filter((e) => e.control_key ? keys.has(e.control_key) : types.has(e.doc_type));
      }
      if (!ev.length) return 'No accepted credentials expire ' + when + scope + '.';
      const lines = resultLines(ev, (e) => '• **' + e.subject_name + '**: ' + e.doc_type.replace(/_/g, ' ') + ', ' + e.expires_on);
      return '**' + ev.length + ' ' + plural(ev.length, 'credential') + '** ' + (ev.length === 1 ? 'expires ' : 'expire ') + when + scope + ':\n' + lines + '\n#evidence';
    }
    case 'request_missing': return source === 'web' ? previewFollowUps(t, user, chatId, policy) : WORKSPACE_ACTION;
    case 'approvals': {
      const approvals = V.listApprovals(t, user).filter((a) => !pack || a.pack_key === pack);
      return approvals.length ? '**' + approvals.length + '** ' + plural(approvals.length, 'item') + ' ' + (approvals.length === 1 ? 'needs' : 'need') + ' your approval' + scope + ':\n' + resultLines(approvals, (a) => '• ' + a.title) + '\n#approvals' : 'Nothing needs your approval' + scope + '.';
    }
    case 'unresolved_by_team': {
      const open = V.listCases(t, user, { pack });
      if (!open.length) return 'There are no unresolved cases you can see.';
      const teams = new Map();
      for (const c of open) teams.set(c.owner_team, (teams.get(c.owner_team) || 0) + 1);
      return '**' + open.length + '** unresolved ' + plural(open.length, 'case') + scope + ':\n' + resultLines([...teams], ([team, count]) => '• **' + team + '**: ' + count) + '\n#cases';
    }
    case 'coverage': {
      const rows = V.checks(t, user, { pack }).filter((c) => c.status !== 'not_applicable');
      const c = V.tally(rows), packs = new Set(rows.map((row) => row.pack_key)).size;
      return (pack ? '**' + packName(pack) + '**\n' : '') + c.pass + ' of ' + c.total + ' applicable checks pass, ' + c.fail + ' fail and ' + c.unknown + ' are unknown.\n'
        + 'This covers checks visible to your role across ' + count(packs, 'evaluated pack') + '.\n#checks';
    }
    case 'check_gaps': {
      const rows = V.checks(t, user, { pack, status }).filter((c) => ['fail', 'unknown'].includes(c.status));
      const result = status === 'fail' ? 'failed' : status === 'unknown' ? 'unknown' : 'failed or unknown';
      if (!rows.length) return 'I found no visible ' + result + ' checks' + scope + '.\n#checks';
      const lines = resultLines(rows, (c) => '• **' + c.subject_name + ' · ' + c.control_name + '**: ' + c.reason);
      return 'I found **' + rows.length + '** ' + result + ' ' + plural(rows.length, 'check') + scope + '. Here’s what needs attention:\n' + lines + '\n#checks';
    }
    case 'create_dashboard': {
      if (source !== 'web') return WORKSPACE_ACTION;
      if (user.role === 'viewer') return 'Your read-only role cannot create dashboards.';
      if (!policy.dashboards) return 'Saving dashboards from the coworker is turned off for this workspace.';
      const pack = /health/.test(q) ? 'healthcare' : /onboard/.test(q) ? 'onboarding' : /immig/.test(q) ? 'immigration' : /payroll|tax/.test(q) ? 'payroll' : null;
      if (pack === 'immigration' && !P.canSeeRestricted(user)) return 'Your role cannot view restricted immigration checks.';
      const metric = /missing/.test(q) ? 'missing_evidence' : /expir/.test(q) ? 'expirations' : 'open_gaps';
      const group_by = /by team/.test(q) ? 'team' : /by pack/.test(q) ? 'pack' : /by control|by credential/.test(q) ? 'control' : 'facility';
      const did = id('dash');
      const name = text.replace(/^(please )?(create|build|make)\s+(?:(?:a|an|the)\s+)?/i, '').replace(/\.$/, '').replace(/^./, (x) => x.toUpperCase()).slice(0, 120);
      db.tx(() => {
        db.insert('dashboards', { id: did, tenant_id: t, name, definition_json: JSON.stringify({ pack, metric, group_by }), roles_json: JSON.stringify([user.role]), created_by: user.name, created_at: clock.iso() });
        P.audit(t, 'DASHBOARD_CREATED', name, 'Saved from chat.', user, { detail: { actor_id: user.id, source: 'web', dashboard_id: did, pack, metric, group_by } });
      });
      return { reply: 'Saved **' + name + '**. Shared with the ' + P.ROLE_LABEL[user.role] + ' role.\n#dashboards/' + did, updated: true };
    }
    case 'ai_limited':
      return 'AI interpretation is unavailable under this workspace’s daily limit. Try a quick prompt or ask “What needs my approval?”.';
    case 'ai_unavailable':
      return 'The AI provider couldn’t answer that question. I can still look up a worker, show which checks need attention, or check what expires next month.';
  }
  if (previous?.intent === 'worker_status') return 'Are you asking about the same worker or someone else? If it’s a different person, tell me their name.';
  if (previous?.intent === 'expiring') return 'Are you asking about a different expiration window or a particular compliance pack?';
  return 'What would you like me to look into? Give me a worker’s name, a compliance pack, or a question about your checks.';
}

const CHAT_SCOPE = `
  FROM coworker_chats c JOIN users u
    ON u.id=c.user_id AND u.tenant_id=c.tenant_id AND u.coworker_epoch=c.coworker_epoch
  WHERE c.tenant_id=? AND c.user_id=? AND c.updated_at>=?
`;

function ownChat(t, user, before, chatId, source) {
  const conditions = [], params = [t, user.id, before];
  if (chatId !== undefined) { conditions.push('c.id=?'); params.push(chatId); }
  if (source) { conditions.push('c.source=?'); params.push(source); }
  const where = conditions.length ? ' AND ' + conditions.join(' AND ') : '';
  return db.get('SELECT c.id,c.source ' + CHAT_SCOPE + where + ' ORDER BY c.updated_at DESC,c.id DESC LIMIT 1', ...params);
}

function conversations(t, user) {
  const policy = Policy.get(t), before = Policy.cutoff(policy.retention_days);
  const rows = db.all(`
    SELECT c.id,c.source,c.updated_at,
      (SELECT m.text FROM chat_messages m WHERE m.coworker_chat_id=c.id AND m.sender='user' AND m.created_at>=?
        ORDER BY m.created_at,m.rowid LIMIT 1) AS first_message
    ${CHAT_SCOPE}
    ORDER BY c.updated_at DESC,c.id DESC LIMIT 200
  `, before, t, user.id, before);
  const chats = rows.map(({ first_message, ...chat }) => ({
    ...chat, title: chat.source === 'slack' ? 'Slack direct messages' : first_message?.replace(/\s+/g, ' ').slice(0, 72) || 'Conversation',
  }));
  return { chats, capabilities: Policy.capabilities(t, user, policy) };
}

function history(t, user, chatId) {
  const policy = Policy.get(t), before = Policy.cutoff(policy.retention_days);
  const chat = ownChat(t, user, before, chatId, chatId === undefined ? 'web' : null);
  if (chatId !== undefined && !chat) throw new P.HttpError(404, 'Conversation not found.');
  if (!chat) return [];
  const messages = db.all(`
    SELECT id,sender,author,text,created_at,context_json FROM (
      SELECT m.id,m.sender,m.author,m.text,m.created_at,m.context_json,m.rowid AS chat_order
      FROM chat_messages m JOIN users u
        ON u.id=m.user_id AND u.tenant_id=m.tenant_id AND u.coworker_epoch=m.coworker_epoch
      WHERE m.coworker_chat_id=? AND m.tenant_id=? AND m.user_id=? AND m.created_at>=?
      ORDER BY m.created_at DESC,m.rowid DESC LIMIT 200
    ) recent ORDER BY created_at,chat_order
  `, chat.id, t, user.id, before);
  const last = messages.at(-1);
  if (last?.sender === 'bot' && chat.source === 'web' && policy.enabled) {
    const lastQuestion = messages.at(-2)?.text?.trim().toLowerCase();
    last.suggestions = Conversation.suggestions(j(last.context_json), Policy.capabilities(t, user, policy).follow_ups)
      .filter((suggestion) => suggestion.toLowerCase() !== lastQuestion);
  }
  const active = chat.source === 'web' && last?.sender === 'bot' && activeProposal(t, user, chat.id, policy);
  if (active) {
    const command = 'Confirm follow-ups ' + active.proposal.code;
    if (last.text.endsWith(command)) last.confirmation = command;
  }
  return messages.map(({ context_json, ...message }) => message);
}

function priorQuestions(chatId, t, user, before) {
  if (!chatId) return [];
  const rows = db.all(`
    SELECT m.text FROM chat_messages m JOIN users u
      ON u.id=m.user_id AND u.tenant_id=m.tenant_id AND u.coworker_epoch=m.coworker_epoch
    WHERE m.coworker_chat_id=? AND m.tenant_id=? AND m.user_id=? AND m.created_at>=? AND m.sender='user'
    ORDER BY m.created_at DESC,m.rowid DESC LIMIT 6
  `, chatId, t, user.id, before);
  return rows.map((row) => row.text.trim()).filter((question) => {
    const q = question.toLowerCase();
    return !CONFIRM_FOLLOW_UP.test(q) && !command(q);
  }).slice(0, 3).reverse().map((question) => question.slice(0, 280));
}

function previousTopic(chatId, t, user, before) {
  if (!chatId) return null;
  const row = db.get(`
    SELECT m.context_json FROM chat_messages m JOIN users u
      ON u.id=m.user_id AND u.tenant_id=m.tenant_id AND u.coworker_epoch=m.coworker_epoch
    WHERE m.coworker_chat_id=? AND m.tenant_id=? AND m.user_id=? AND m.created_at>=?
      AND m.sender='bot' AND m.context_json IS NOT NULL
    ORDER BY m.created_at DESC,m.rowid DESC LIMIT 1
  `, chatId, t, user.id, before);
  return j(row?.context_json);
}

function requireEnabled(t, source, lock) {
  const policy = Policy.get(t, lock);
  if (!policy.enabled) throw new P.HttpError(403, 'Ask coworker is turned off for this workspace.');
  if (source === 'slack' && !policy.slack) throw new P.HttpError(403, 'Coworker chat in Slack is turned off for this workspace.');
  return policy;
}

async function handle(t, user, text, { source = 'web', requestedChatId } = {}) {
  text = text.trim();
  const policy = requireEnabled(t, source), before = Policy.cutoff(policy.retention_days);
  const selected = requestedChatId === null ? null : ownChat(t, user, before, requestedChatId, source);
  if (typeof requestedChatId === 'string' && !selected) {
    throw new P.HttpError(404, 'Conversation not found.');
  }
  const q = text.toLowerCase(), confirmation = CONFIRM_FOLLOW_UP.exec(q), action = !confirmation && command(q);
  const previous = previousTopic(selected?.id, t, user, before);
  let plan = action ? { intent: action } : !confirmation ? Conversation.readPlan(text, previous) : null;
  if (!confirmation && !plan && llm.enabled(t)) {
    if (!Policy.reserveAiCall(t, source)) plan = { intent: 'ai_limited' };
    else {
      const recent = priorQuestions(selected?.id, t, user, before);
      const input = JSON.stringify({ current_message: text, recent_questions: recent, previous_topic: previous });
      const result = await llm.callTool(t, Conversation.AI_INSTRUCTIONS, [{ type: 'text', text: input }], 'classify', Conversation.AI_SCHEMA, { timeoutMs: 8000 });
      plan = result ? Conversation.aiPlan(result) : { intent: 'ai_unavailable' };
    }
  }
  return db.tx(() => {
    const livePolicy = requireEnabled(t, source, true);
    const lock = db.mode() === 'pg' ? ' FOR UPDATE' : '';
    const actor = db.get('SELECT coworker_epoch,role FROM users WHERE id=? AND tenant_id=?' + lock, user.id, t);
    if (!actor || actor.coworker_epoch !== user.coworker_epoch || actor.role !== user.role) {
      throw new P.HttpError(409, 'Your access changed. Reopen Ask coworker and try again.');
    }
    const now = new Date().toISOString();
    const existing = selected && ownChat(t, user, Policy.cutoff(livePolicy.retention_days), selected.id, source);
    if (selected && !existing) throw new P.HttpError(404, 'Conversation not found.');
    const chatId = existing?.id || id('conv');
    if (existing) db.update('coworker_chats', chatId, { updated_at: now });
    else db.insert('coworker_chats', { id: chatId, tenant_id: t, user_id: user.id, coworker_epoch: actor.coworker_epoch, source, created_at: now, updated_at: now });
    const result = respond(t, user, text, { source, chatId, policy: livePolicy, plan, previous, confirmation });
    const response = typeof result === 'string' ? { reply: result } : result;
    const context = Conversation.topicFrom(plan, previous);
    const topic = context?.pack === 'immigration' && !P.canSeeRestricted(user) ? null : context;
    const add = (sender, author, message, context = null) => db.insert('chat_messages', {
      id: id('chat'), tenant_id: t, user_id: user.id, coworker_chat_id: chatId, coworker_epoch: actor.coworker_epoch,
      sender, author, text: message, created_at: now, context_json: context ? JSON.stringify(context) : null,
    });
    add('user', user.name, text);
    add('bot', 'Aegis Coworker', response.reply, topic);
    return { ...response, chat_id: chatId };
  });
}
module.exports = { handle, history, conversations };
