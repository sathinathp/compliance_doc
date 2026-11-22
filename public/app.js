/* Aegis web workspace. All data comes from the API; nothing is calculated or stored in the browser. */
'use strict';
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
class Safe { constructor(s) { this.s = s; } }
const render = (v) => v instanceof Safe ? v.s : Array.isArray(v) ? v.map(render).join('') : v === null || v === undefined || v === false ? '' : esc(v);
const h = (st, ...v) => new Safe(st.reduce((a, s, i) => a + s + (i < v.length ? render(v[i]) : ''), ''));
const raw = (s) => new Safe(s);
// Friendly names for the codes the backend sends. Anything not listed is shown in sentence case.
const LABELS = {
  // document types
  professional_license: 'Professional license', bls_card: 'BLS card', acls_card: 'ACLS card', tb_screening: 'TB screening',
  acls: 'ACLS card', flu_vaccine: 'Flu vaccination', facility_orientation: 'Facility orientation', handbook_ack: 'Handbook acknowledgment',
  security_training: 'Security training', i9_record: 'I-9 record', work_authorization: 'Work authorization', w4: 'W-4',
  payroll_filing_receipt: 'Payroll filing receipt', unknown: 'Unknown',
  // case stages and outcomes
  identified: 'New', following_up: 'Following up', in_review: 'In review', reevaluating: 'Re-evaluating',
  confirmed: 'Confirmed by owner', false_finding: 'Marked false by owner', verified: 'Verified with evidence', no_longer_applicable: 'No longer applicable',
  // evidence, messages and approvals
  needs_review: 'Needs review', pending_approval: 'Waiting for approval', demo_seed: 'Demo data', bulk_upload: 'Bulk upload',
  action: 'Message to send', assignment_review: 'Assignment decision', readiness_decision: 'Readiness decision',
  control_activation: 'Rule change', notice_response: 'Notice response',
  // people and packs
  hr: 'HR', admin: 'Administrator', immigration_owner: 'Immigration owner', healthcare_compliance: 'Healthcare compliance',
  healthcare: 'Healthcare', onboarding: 'Onboarding', immigration: 'Immigration', payroll: 'Payroll & Tax',
  facility_policy: 'Facility policy', hrms: 'HRMS',
};
const words = (s) => { const k = String(s ?? ''); if (Object.hasOwn(LABELS, k)) return LABELS[k]; const t = k.replace(/_/g, ' '); return t.charAt(0).toUpperCase() + t.slice(1); };
// Dates read like "Oct 31, 2026"; times like "Oct 31, 2026, 2:05 PM". Shown in UTC, as the page labels say.
const DAY = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const DAYTIME = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC' });
const parse = (s) => { const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(String(s)) ? `${s}T00:00:00Z` : s); return Number.isNaN(d.getTime()) ? null : d; };
// Non-breaking spaces keep a date on one line in narrow table columns.
const date = (s) => { const d = s ? parse(s) : null; return d ? DAY.format(d).replace(/ /g, ' ') : (s ? String(s) : '—'); };
const dt = (s) => { const d = s ? parse(s) : null; return d ? DAYTIME.format(d) : (s ? String(s) : '—'); };

async function api(path, body) {
  const r = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'x-aegis-client': 'web' }, body: JSON.stringify(body) });
  if (r.status === 401 && path !== '/api/login') { showLogin(); throw new Error('Please sign in.'); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(data.error || 'Request failed.'); e.status = r.status; throw e; }
  return data;
}
function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${type}`; el.textContent = msg;
  $('#toasts').append(el); setTimeout(() => el.remove(), 4200);
}
const fileData = (f) => new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok({ name: f.name, mime: f.type || 'application/octet-stream', data: r.result.split(',')[1] }); r.onerror = no; r.readAsDataURL(f); });
let modalOpener;
function openModal(title, sub, body, foot, wide) {
  const c = $('#modalCard');
  const overlay = $('#modal');
  if (!overlay.classList.contains('open')) modalOpener = document.activeElement;
  c.className = `modal-card${wide ? ' wide' : ''}`;
  c.innerHTML = render(h`<div class="modal-header"><div class="modal-title-wrap"><h3 class="modal-title" id="modalTitle">${title}</h3><p class="modal-subtitle" id="modalDescription">${sub}</p></div><button class="modal-close-btn" data-act="closeModal" aria-label="Close">&times;</button></div><div class="modal-body">${body}</div>${foot ? h`<div class="modal-footer">${foot}</div>` : ''}`);
  overlay.classList.add('open');
  $('#appShell').inert = true;
  c.querySelector('.modal-close-btn').focus();
}
function closeModal() {
  const overlay = $('#modal');
  if (!overlay.classList.contains('open')) return;
  overlay.classList.remove('open');
  $('#appShell').inert = false;
  (modalOpener?.isConnected ? modalOpener : $('#workspace-main')).focus();
  modalOpener = null;
}

function setNavigationOpen(open) {
  $('#sheet').classList.toggle('open', open);
  $('#menu').setAttribute('aria-expanded', String(open));
}

const PILL = { pass: ['pill-pass', 'Pass'], fail: ['pill-fail', 'Fail'], unknown: ['pill-unknown', 'Unknown'], not_applicable: ['pill-na', 'N/A'], restricted: ['pill-na', 'Restricted'], not_assessed: ['pill-na', 'Not assessed'] };
const statusPill = (s) => { const [c, l] = PILL[s] || ['pill-na', words(s)]; return h`<span class="pill ${c}">${l}</span>`; };
const STATE_PILL = { needs_review: 'pill-warn', accepted: 'pill-pass', rejected: 'pill-fail', superseded: 'pill-na', sent: 'pill-pass', queued: 'pill-blue', pending_approval: 'pill-warn' };
const statePill = (s) => h`<span class="pill ${STATE_PILL[s] || 'pill-blue'}">${words(s)}</span>`;
const prio = (p) => h`<span class="priority-pill ${p === 'high' ? 'pill-high' : p === 'medium' ? 'pill-med' : 'pill-low'}">${words(p)}</span>`;
// How urgent a due date is, in words: "22 days overdue", "Due today", "Due in 3 days".
const daysFromToday = (d) => d ? Math.round((Date.parse(`${String(d).slice(0, 10)}T00:00:00Z`) - Date.parse(`${me.today}T00:00:00Z`)) / 864e5) : null;
const dueNote = (d, open = true) => {
  const n = daysFromToday(d);
  if (!open || n === null || n > 7) return '';
  if (n < 0) return h`<small class="due-note due-late">${-n} day${n === -1 ? '' : 's'} overdue</small>`;
  if (n === 0) return h`<small class="due-note due-late">Due today</small>`;
  return h`<small class="due-note due-soon">Due in ${n} day${n === 1 ? '' : 's'}</small>`;
};
// Pack name as a soft label.
const packTag = (k) => h`<span class="pack-tag pack-${k}">${words(k)}</span>`;
// For grids full of results: a pass is a quiet tick, "not applicable" a dash, and only problems are loud.
const tickSvg = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
const quietStatus = (s) => s === 'pass' ? h`<span class="ok-tick" title="Pass">${raw(tickSvg)}<span class="visually-hidden">Pass</span></span>`
  : s === 'not_applicable' ? h`<span class="na-dash" title="Not applicable"><span aria-hidden="true">—</span><span class="visually-hidden">Not applicable</span></span>`
  : statusPill(s);
// Case progress as a line of steps, like a delivery tracker.
const STEPS = [['identified', 'Found'], ['assigned', 'Assigned'], ['requested', 'Requested'], ['following_up', 'Following up'], ['in_review', 'In review'], ['reevaluating', 'Re-checking'], ['closed', 'Closed']];
const stepper = (state) => {
  const at = Math.max(0, STEPS.findIndex(([k]) => k === state));
  return h`<ol class="stepper" aria-label="Case progress">${STEPS.map(([, label], i) => h`<li class="${i < at ? 'done' : i === at ? 'now' : ''}" ${i === at ? raw('aria-current="step"') : ''}><span class="dot" aria-hidden="true"></span><span class="label">${label}</span></li>`)}</ol>`;
};
// Line icons for the packs, in the same style as the side menu.
const PACK_ICONS = {
  healthcare: '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/><path d="M3.22 12H9.5l.5-1 2 4.5 2-7 1.5 3.5h5.27"/>',
  immigration: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
  onboarding: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M19 8v6M22 11h-6"/>',
  payroll: '<path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z"/><path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8"/><path d="M12 17.5v-11"/>',
};
const packIcon = (k) => h`<span class="pack-icon pack-icon-${k}" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${raw(PACK_ICONS[k] || '<circle cx="12" cy="12" r="9"/>')}</svg></span>`;
const hookSvg = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 3v11a4 4 0 1 1-4-4"/></svg>';
// An empty list says what will appear there and what to do next. "none" is a title, or [title, hint].
const emptySvg = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>';
const emptyState = (none) => { const [title, hint] = Array.isArray(none) ? none : [none, '']; return h`<div class="empty-state"><span class="empty-icon" aria-hidden="true">${raw(emptySvg)}</span><div><b>${title}</b>${hint ? h`<span>${hint}</span>` : ''}</div></div>`; };
// With no rows the table is replaced by the empty state, so empty column headings never show.
const table = (heads, rows, none) => rows.length
  ? h`<div class="table-scroll-container"><table><thead><tr>${heads.map((x) => (x?.num ? h`<th class="num">${x.t}</th>` : h`<th>${x}</th>`))}</tr></thead><tbody>${rows}</tbody></table></div>`
  : emptyState(none);
// A right-aligned column heading, for columns of numbers.
const num = (t) => ({ t, num: true });
const card = (title, sub, body, tools) => h`<div class="panel"><div class="ph2"><div><h2>${title}</h2><p>${sub}</p></div>${tools ? h`<div>${tools}</div>` : ''}</div>${body}</div>`;

const I = { notices: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>', overview: '<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>', setup: '<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>', cases: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>', approvals: '<path d="M20 6 9 17l-5-5"/>', checks: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>', workers: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/>', evidence: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M12 18v-6m-3 3 3-3 3 3"/>', packs: '<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/>', controls: '<path d="M4 21h16M4 14h16M4 7h16"/><circle cx="8" cy="7" r="2"/><circle cx="16" cy="14" r="2"/>', integrations: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="m9 12 2 2 4-4"/>', dashboards: '<rect x="3" y="3" width="7" height="9"/><rect x="14" y="3" width="7" height="5"/><rect x="14" y="12" width="7" height="9"/><rect x="3" y="16" width="7" height="5"/>', audit: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>', reports: '<path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-3 3"/>', metrics: '<path d="M12 20V10M18 20V4M6 20v-4"/>', settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>' };
const NAV = [
  ['Workspace', [['overview', 'Overview'], ['cases', 'Cases'], ['evidence', 'Evidence'], ['approvals', 'Approvals'], ['notices', 'Tax notices']]],
  ['Records', [['workers', 'Workers'], ['checks', 'Checks'], ['packs', 'Compliance packs'], ['controls', 'Control rules']]],
  ['Reporting', [['dashboards', 'Dashboards'], ['reports', 'Reports'], ['metrics', 'Pilot metrics'], ['audit', 'Audit history']]],
  ['Organization', [['setup', 'Company setup'], ['integrations', 'Connections'], ['settings', 'Settings']]]
];
const HEAD = { overview: ['Workspace', 'Overview', 'Current status across activated packs, accepted evidence and open remediation.'], setup: ['Organization', 'Company setup', 'Get your organisation ready: bring in your people, confirm requirements, and run the first check.'], cases: ['Workspace', 'Cases', 'Each gap moves from identified to closed. Only accepted evidence closes a case.'], approvals: ['Workspace', 'Approvals', 'Consequential actions wait here for an authorized person.'], evidence: ['Workspace', 'Evidence', 'AI proposes matches and fields. Uncertain documents go to a person.'], checks: ['Records', 'Checks', 'Every result has a reason, evidence references and a control version.'], workers: ['Records', 'Workers', 'Per-pack status for each worker. One pack never hides another.'], packs: ['Records', 'Compliance packs', 'Versioned packs reviewed and activated by an authorized person.'], controls: ['Records', 'Control rules', 'Draft, preview and approve changes before they take effect.'], integrations: ['Organization', 'Connections', 'Connectors, messages, background jobs and visible failures.'], dashboards: ['Reporting', 'Dashboards', 'Readiness, expirations and gaps, counted from current checks.'], reports: ['Reporting', 'Reports', 'Reports to share with clients, auditors and managers.'], notices: ['Workspace', 'Tax notices', 'Letters from tax agencies and the replies Finance approves.'], metrics: ['Reporting', 'Pilot metrics', 'How the pilot is going, measured from Aegis records.'], audit: ['Reporting', 'Audit history', 'Every check, request and decision, in order. Entries cannot be edited or deleted.'], settings: ['Organization', 'Settings', 'Users, roles, reporting channel and schedules.'] };

// Ticked cases on the Cases page (ids). Cleared when the tab or page changes.
const caseSel = new Set();
let lastCaseCheck = null;
let caseClosed = false, me = null, route = 'overview', routeArg = null, checkFilter = {}, evidenceSel = null, lastDraft = null, importPreview = null;
let navigation = 0;
const adminRoutes = new Set(['setup', 'settings', 'audit', 'integrations']);
const canEdit = () => me.user.role !== 'viewer';
// Tax notices belong to the payroll pack: Finance and administrators.
const canFinance = () => me.user.is_admin || me.user.role === 'finance';
const canAddWorker = () => me.user.is_admin || me.user.role === 'hr';
const refresh = () => go(route, routeArg, true);

async function boot() {
  try { me = await api('/api/me'); } catch { return; }
  demoEnabled = me.demo;
  document.body.style.background = '';
  const ls = $('#loginScreen'); if (ls) { ls.hidden = true; ls.style.display = 'none'; ls.innerHTML = ''; }
  const as = $('#appShell'); if (as) { as.hidden = false; as.style.display = 'block'; }
  const questions = ['What is missing for new workers?', 'Which credentials expire next month?', 'What needs my approval?', 'Show unresolved cases by team'];
  if (canEdit()) questions.push('Request the missing documents.', 'Create a healthcare dashboard showing missing evidence by facility.');
  $('#chatPrompts').innerHTML = render(questions.map((q) => h`<button class="prompt-pill" data-act="prompt" data-q="${q}">${q}</button>`));
  renderTop();
  renderDemoRack();
  readHash();
}

// Header buttons per page. The search box shows on pages that are mostly tables.
const PAGE_TOOLS = { notices: ['logNotice'], dashboards: ['newView'], cases: ['uploadEvidence'], workers: ['importRoster', 'addWorker'], evidence: ['uploadEvidence'] };
const SEARCH_PAGES = new Set(['cases', 'evidence', 'approvals', 'workers', 'checks', 'controls', 'settings']);
const TOOL_ALLOWED = { addWorker: () => canAddWorker(), importRoster: () => canEdit(), uploadEvidence: () => canEdit(), newView: () => canEdit(), logNotice: () => canFinance() };
function syncTools() {
  if (!me?.user) return;
  const mine = PAGE_TOOLS[route] || [];
  for (const [act, allowed] of Object.entries(TOOL_ALLOWED)) {
    const b = $(`#topTools [data-act="${act}"]`);
    if (b) b.hidden = !mine.includes(act) || !allowed();
  }
  const search = $('#globalSearch'); if (search) search.hidden = !SEARCH_PAGES.has(route);
}

function renderTop() {
  if (!me || !me.user) return;
  const tenantAvatar = $('#tenantAvatar'); if (tenantAvatar) tenantAvatar.textContent = (me.tenant?.name || 'BH').slice(0, 2).toUpperCase();
  const tenantName = $('#tenantName'); if (tenantName) tenantName.textContent = me.tenant?.name || 'Aegis';
  const tenantStatus = $('#tenantStatus');
  tenantStatus.hidden = !me.demo;
  tenantStatus.textContent = me.sandbox ? 'Sandbox' : 'Demo data';
  $('#meMenuDemoRole').hidden = !me.demo;
  $('#meMenuDemoControls').hidden = !me.demo || !me.user.is_admin;
  syncTools();

  const userEmail = (me.user.email || '').toLowerCase();
  const pMatch = PERSONAS.find((p) => p.email && userEmail && p.email.toLowerCase() === userEmail) ||
                 PERSONAS.find((p) => p.roleName && me.user.role_label && p.roleName.toLowerCase() === me.user.role_label.toLowerCase()) ||
                 (me.user.is_admin ? PERSONAS[0] : null);
  const roleColor = pMatch?.color || (
    me.user.is_admin ? '#0E8A5F' :
    me.user.role === 'hr' ? '#D9622B' :
    me.user.role === 'immigration_owner' ? '#5B45C9' :
    me.user.role === 'healthcare_compliance' ? '#C2283F' :
    me.user.role === 'finance' ? '#B98A00' :
    me.user.role === 'viewer' ? '#2F6496' : '#0E8A5F'
  );
  document.documentElement.style.setProperty('--role', roleColor);

  const uAv = $('#userAvatar'); if (uAv) uAv.textContent = badgeInitials(me.user.name || '?');
  const uNm = $('#userName'); if (uNm) uNm.textContent = (me.user.name || 'User').split(' ')[0] || me.user.name;
  const uRl = $('#userRole'); if (uRl) uRl.textContent = me.user.role_label || words(me.user.role);
  $('#meBtn').setAttribute('aria-label', `${me.user.name || 'User'} account`);

  const meMenuSettings = $('#meMenuSettings');
  if (meMenuSettings) meMenuSettings.hidden = !me.user.is_admin;
}

function renderNav() {
  const links = NAV.map(([group, items]) => {
    const visible = items.filter(([key]) => (me.user.is_admin || !adminRoutes.has(key)) && (key !== 'notices' || canFinance()));
    if (!visible.length) return '';
    return h`<section class="rail-group"><h2>${group}</h2>${visible.map(([key, label]) => h`<a class="rail-link" href="#${key}" aria-current="${route === key ? 'page' : 'false'}"><svg aria-hidden="true" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round">${raw(I[key])}</svg><span>${label}</span></a>`)}</section>`;
  });
  const markup = render(links);
  $('#tabs').innerHTML = markup;
  $('#sheetIn').innerHTML = markup;
}

function readHash() {
  if (!me) return;
  const [page, argument] = location.hash.slice(1).split('/');
  go(Object.hasOwn(VIEWS, page) ? page : 'overview', argument || null);
}

async function go(r, arg = null, keep) {
  const version = ++navigation;
  if (!keep && r !== route) { $('#globalSearch').value = ''; caseSel.clear(); closeChat(); }
  route = r; routeArg = arg;
  closeAllDirMenus();
  setNavigationOpen(false);
  if (r !== 'overview') {
    const alertEl = $('#alert');
    if (alertEl) { alertEl.hidden = true; alertEl.innerHTML = ''; }
  }
  const [c, t, d] = HEAD[r] || ['Workspace', words(r), ''];
  const crumb = $('#crumb'); if (crumb) crumb.textContent = c;
  const heading = $('#heading'); if (heading) heading.textContent = t;
  const scopeEl = $('#scope'); if (scopeEl) scopeEl.textContent = d;
  syncTools();
  try {
    const out = adminRoutes.has(r) && !me.user.is_admin
      ? card('Administrators only', 'Ask an administrator for access to this area.', '')
      : await VIEWS[r](arg);
    if (version !== navigation) return;
    $('#view').innerHTML = render(out);
    labelTableCells($('#view'));
    fitInspector();
    if (!keep) window.scrollTo(0, 0);
    const q = $('#globalSearch')?.value; if (q) filterRows(q);
    syncCaseSelection();
  } catch (e) {
    if (version !== navigation) return;
    // Say what went wrong and what to do. A 404 here means the page is newer than the running server.
    const hint = e.status === 404 ? 'The Aegis server is running an older version than this page. Restart the server, then try again.'
      : e.status >= 500 ? `The server ran into a problem: ${e.message}`
        : e.message === 'Failed to fetch' ? 'Aegis could not reach the server. Check that it is running, then try again.' : e.message;
    $('#view').innerHTML = render(h`<div class="panel load-error" role="alert"><div><b>This page did not load</b><p>${hint}</p></div><button class="btn-card-outline" data-act="retryView">Try again</button></div>`);
  }
  renderNav();
  if (r === 'cases' && arg && !keep) {
    try { await ACT.caseDetail({ dataset: { id: arg } }); } catch (e) { toast(e.message, 'warning'); }
  }
}

const scope = (c) => {
  const el = $('#scope');
  if (!el) return;
  if (!c) {
    const cur = HEAD[route];
    el.textContent = cur ? cur[2] : '';
    return;
  }
  el.innerHTML = render(h`${c.all_pass ? h`<span class="pill pill-pass">All checks in scope pass</span> ` : h`<span class="pill pill-warn">Verified scope only</span> `}${c.scope_statement} Evidence as of ${dt(c.as_of)} UTC.`);
};
// Phones show each table row as a card. Every cell gets its column name, and the first named cell is the card title.
function labelTableCells(root) {
  for (const t of root.querySelectorAll('.table-scroll-container table')) {
    const heads = [...t.querySelectorAll('thead th')].map((th) => th.textContent.trim());
    for (const tr of t.querySelectorAll('tbody tr')) {
      let titled = false;
      [...tr.children].forEach((td, i) => {
        if (heads[i]) td.dataset.label = heads[i];
        if (heads[i] && !titled) { td.classList.add('cell-title'); titled = true; }
      });
    }
  }
}
function filterRows(q) { q = q.toLowerCase(); document.querySelectorAll('#view tbody tr').forEach((r) => { r.hidden = !r.textContent.toLowerCase().includes(q); }); syncCaseSelection(); }

// ---- Ticking cases (Cases page)
const SKIP_WHY = { validation: 'Validation mode, not sent', review: 'Waiting for review, not sent' };
const caseChecks = () => [...document.querySelectorAll('#view .case-check')];
const shownChecks = () => caseChecks().filter((c) => !c.closest('tr').hidden);
const caseRow = (id) => $(`#view tr[data-id="${CSS.escape(id)}"]`);
function syncCaseSelection() {
  const bar = $('#selectionBar'); if (!bar) return;
  const onCases = route === 'cases' && !caseClosed;
  for (const box of caseChecks()) { box.checked = caseSel.has(box.dataset.id); box.closest('tr').classList.toggle('is-picked', box.checked); }
  const all = $('#view .case-check-all');
  if (all) {
    const shown = shownChecks(), on = shown.filter((c) => c.checked).length;
    all.checked = shown.length > 0 && on === shown.length;
    all.indeterminate = on > 0 && on < shown.length;
    all.disabled = !shown.length;
  }
  const n = onCases ? caseSel.size : 0;
  const skipped = [...caseSel].filter((id) => caseRow(id)?.dataset.skip).length;
  const hiddenBySearch = [...caseSel].filter((id) => caseRow(id)?.hidden).length;
  const num = $('#selectionNum');
  if (num.textContent !== String(n)) { num.textContent = n; num.classList.remove('tick'); void num.offsetWidth; num.classList.add('tick'); }
  $('#selectionWord').textContent = n === 1 ? 'case selected' : 'cases selected';
  $('#selectionHint').textContent = [skipped ? `${skipped} won't send` : '', hiddenBySearch ? `${hiddenBySearch} hidden by search` : ''].filter(Boolean).join(' · ');
  if (n) { if (bar.hidden) { bar.hidden = false; void bar.offsetWidth; } bar.classList.add('show'); } // the reflow lets the slide-in start from the hidden position
  else { bar.classList.remove('show'); bar.hidden = true; }
  document.body.classList.toggle('has-selection', n > 0);
  const chaseAllBtn = $('#chaseAllBtn'); if (chaseAllBtn) chaseAllBtn.hidden = n > 0;
}
function announceSelection() { const l = $('#selectionLive'); if (l) l.textContent = caseSel.size ? `${caseSel.size} ${caseSel.size === 1 ? 'case' : 'cases'} selected` : 'Selection cleared'; }
function clearCaseSelection() { if (!caseSel.size) return; caseSel.clear(); lastCaseCheck = null; syncCaseSelection(); announceSelection(); }
// A click on a tick box. Shift-click ticks or unticks every shown case between this one and the last one clicked.
function onCaseCheck(box, shift) {
  if (box.classList.contains('case-check-all')) {
    const turnOn = box.checked;
    for (const c of shownChecks()) turnOn ? caseSel.add(c.dataset.id) : caseSel.delete(c.dataset.id);
    lastCaseCheck = null;
  } else {
    const list = shownChecks(), here = list.indexOf(box), before = list.indexOf(lastCaseCheck);
    const range = shift && before !== -1 && here !== -1 ? list.slice(Math.min(here, before), Math.max(here, before) + 1) : [box];
    for (const c of range) box.checked ? caseSel.add(c.dataset.id) : caseSel.delete(c.dataset.id);
    lastCaseCheck = box;
  }
  syncCaseSelection(); announceSelection();
}
// The confirm step says exactly what will happen before anything is sent.
function confirmFollowUps(ids, scopeText) {
  const rows = ids.map(caseRow).filter(Boolean);
  const willSend = rows.filter((r) => !r.dataset.skip), skipped = rows.filter((r) => r.dataset.skip);
  const item = (r) => h`<li><span><b>${r.dataset.name}</b><small>${r.dataset.subject}</small></span>${r.dataset.skip ? h`<span class="pill pill-na">${SKIP_WHY[r.dataset.skip]}</span>` : h`<span class="pill pill-pass">Will send</span>`}</li>`;
  const listed = [...willSend, ...skipped], extra = listed.length - 6;
  openModal(`Follow up on ${ids.length} ${ids.length === 1 ? 'case' : 'cases'}?`, scopeText,
    h`<div class="confirm-summary"><div><b>${willSend.length}</b><span>will be sent</span></div><div><b>${skipped.length}</b><span>skipped</span></div></div>
      <ul class="confirm-list">${listed.slice(0, 6).map(item)}</ul>${extra > 0 ? h`<p class="muted small">And ${extra} more.</p>` : ''}
      <p class="muted small confirm-note">A follow-up never closes a case; only accepted evidence does. Anyone already followed up today is skipped automatically.${me.sandbox ? ' Sandbox messages stay in the local outbox.' : ''}</p>`,
    h`<button class="btn-cancel" data-act="closeModal">Cancel</button><button class="btn-submit-green" data-act="confirmChaseAll" data-ids="${JSON.stringify(ids)}" ${willSend.length ? '' : raw('disabled')}>${willSend.length ? `Send ${willSend.length} follow-up${willSend.length === 1 ? '' : 's'}` : 'Nothing to send'}</button>`);
}

// ---------- Company setup ----------
// The five steps, each with whether it is done, locked (and why), a one-line summary and its content.
function setupSteps(s) {
  const st = s.steps, gapsFor = (k) => s.gap_items.filter((g) => g.step === k);
  // Gaps on records and context are problems to fix; the packs note is guidance, so it reads as information.
  const gapNote = (k, info) => (gapsFor(k).length ? h`<div class="setup-note${info ? ' is-info' : ''}"><b>${info ? 'Good to know' : gapsFor(k).length === 1 ? 'One thing to fix' : `${gapsFor(k).length} things to fix`}</b><ul>${gapsFor(k).map((g) => h`<li>${g.text}</li>`)}</ul></div>` : '');
  const active = s.recommended.filter((p) => p.status === 'active');
  const cons = s.source.connectors, bySrc = s.source.workers_by_source;
  const srcWords = { hrms: 'from the HRMS', spreadsheet: 'from spreadsheets', manual: 'added by hand', webhook: 'from the HRMS' };
  // Workers record the connection they came from by its id; say its name instead.
  const srcName = (k) => srcWords[k] || (cons.find((c) => c.id === k) ? `from ${cons.find((c) => c.id === k).name}` : 'from a connected system');
  const fromLine = Object.keys(bySrc).length > 1 ? Object.entries(bySrc).map(([k, v]) => `${v} ${srcName(k)}`).join(', ') : '';
  const conState = (c) => (c.last_error ? ['pill-fail', 'Needs attention'] : c.status === 'disabled' ? ['pill-na', 'Paused'] : ['pill-pass', 'Connected']);
  const cov = s.coverage;
  return [
    {
      key: 'connect', title: 'Add your people and locations', done: st.connect, attention: gapsFor('records').length,
      summary: st.connect ? `${plural(s.summary.workers, 'worker')}, ${plural(s.summary.facilities, 'location')} and ${plural(s.summary.entities, 'employing entity', 'employing entities')}${cons.length ? `, from ${cons.map((c) => c.name).join(' and ')}` : ''}.` : 'Connect your HR system, import a spreadsheet, or add people one by one.',
      body: h`<dl class="report-figures setup-figures"><div><dt>Workers</dt><dd>${s.summary.workers}</dd></div><div><dt>Locations</dt><dd>${s.summary.facilities}</dd></div><div><dt>Employing entities</dt><dd>${s.summary.entities}</dd></div></dl>
        <h4 class="setup-sub">Where your records come from</h4>
        ${cons.length ? h`<ul class="source-list">${cons.map((c) => { const [cls, label] = conState(c); return h`<li><span class="source-name">${c.name}<small>${words(c.type)} connection</small></span><span class="pill ${cls}">${label}</span><span class="source-meta">${c.last_sync_at ? `Last synced ${dt(c.last_sync_at)} UTC` : 'Not synced yet'}${c.records ? `, ${plural(c.records, 'record')}` : ''}</span></li>`; })}</ul>` : h`<p class="setup-text">No system is connected. ${s.summary.workers ? 'Records were added by spreadsheet or by hand.' : 'Connect your HR system to keep records up to date by themselves.'}</p>`}
        ${fromLine ? h`<p class="setup-text muted">Workers: ${fromLine}.</p>` : ''}
        ${gapNote('records')}
        <div class="setup-actions"><a class="${!cons.length && !st.connect ? 'btn-submit-green' : 'btn-card-outline'}" href="#integrations">${cons.length ? 'Manage connections' : 'Connect a system'}</a><button class="btn-card-outline" data-act="importRoster">Import a spreadsheet</button><button class="btn-link-action" data-act="addWorker">Add a worker</button></div>`,
    },
    {
      key: 'context', title: 'Confirm locations and requirements', done: st.context, attention: gapsFor('context').length, locked: !st.connect, why: 'Add people and locations first.',
      summary: st.context ? `${plural(s.facilities.filter((f) => f.requirements_confirmed).length, 'location')} of ${s.facilities.length} confirmed. Employing entities: ${s.entities.map((e) => e.name).join(', ') || 'none'}.` : 'Each location’s requirements decide which checks apply there. Unconfirmed locations give Unknown results.',
      body: h`${gapNote('context')}
        ${table(['Location', 'State', 'Requirements', 'Status', ''], s.facilities.map((f) => h`<tr><td><span class="row-title is-static">${f.name}</span></td><td>${f.state || '—'}</td><td>${f.requirements.map(words).join(', ') || h`<span class="muted">None</span>`}</td><td>${f.requirements_confirmed ? h`<span class="pill pill-pass">Confirmed</span>` : h`<span class="pill pill-warn">Not confirmed</span>`}</td><td class="row-action"><button class="btn-link-action" data-act="facility" data-id="${f.id}" data-name="${f.name}" data-state="${f.state}" data-req="${f.requirements.join(',')}">Edit</button></td></tr>`), ['No locations yet', 'Locations come from your workers’ assignments.'])}
        ${s.entities.length ? h`<p class="setup-text muted">Employing entities: ${s.entities.map((e) => e.name).join(', ')}.</p>` : ''}
        <div class="setup-actions">${st.context ? h`<span class="done-note">Company profile confirmed.</span><button class="btn-link-action" data-act="confirmContext">Confirm again</button>` : h`<button class="btn-submit-green" data-act="confirmContext">Confirm company profile</button>`}</div>`,
    },
    {
      key: 'packs', title: 'Activate compliance packs', done: st.packs,
      summary: active.length ? `${active.length} of ${s.recommended.length} packs active: ${active.filter((p) => p.mode === 'auto').length} automatic, ${active.filter((p) => p.mode !== 'auto').length} in validation.` : 'Packs hold the requirements Aegis checks. New packs start in validation, so nothing is sent until owners agree with the findings.',
      body: h`${table(['Pack', 'Status', 'Mode', ''], s.recommended.map((p) => h`<tr><td><span class="pack-title">${packIcon(p.key)}<span><span class="row-title is-static">${p.name}</span>${p.description ? h`<span class="case-sub">${p.description}</span>` : ''}</span></span></td><td>${p.status === 'active' ? h`<span class="pill pill-pass">Active</span>` : h`<span class="pill pill-na">Not active</span>${p.recommended ? h` <span class="pill pill-blue">Recommended</span>` : ''}`}</td><td class="muted nowrap">${p.status === 'active' ? (p.mode === 'auto' ? 'Automatic' : 'Validation only') : '—'}</td><td class="row-action"><button class="${p.status === 'active' ? 'btn-link-action' : 'btn-card-outline'}" data-act="reviewPack" data-id="${p.key}">${p.status === 'active' ? 'Review' : 'Review and activate'}</button></td></tr>`), '')}
        ${gapNote('packs', true)}`,
    },
    {
      key: 'channel', title: 'Choose where updates go', done: st.channel,
      summary: st.channel ? `${s.channel.type === 'slack' ? 'Slack' : 'In-app outbox'}, ${s.channel.channel || '#compliance-alerts'}.` : 'Digests and alerts go to Slack, or stay in the in-app outbox.',
      body: h`<form data-form="channel" class="channel-form">
        <fieldset class="choice-group"><legend class="sr-only">Where updates go</legend>
          <label class="choice"><input type="radio" name="type" value="outbox" ${s.channel.type !== 'slack' ? raw('checked') : ''}><span><b>In-app outbox</b><small>Messages are kept in Aegis under Connections. Nothing leaves Aegis.</small></span></label>
          <label class="choice${s.slack_ready ? '' : ' is-disabled'}"><input type="radio" name="type" value="slack" ${s.channel.type === 'slack' ? raw('checked') : ''} ${s.slack_ready ? '' : raw('disabled')}><span><b>Slack</b><small>${s.slack_ready ? 'Digests and alerts are posted to the channel below.' : h`Connect Slack first in <a href="#integrations">Connections</a>.`}</small></span></label>
        </fieldset>
        <div class="form-group channel-name"><label class="form-label" for="chName">Channel</label><input id="chName" name="channel" class="form-select" value="${s.channel.channel || '#compliance-alerts'}" autocomplete="off"></div>
        <div class="setup-actions"><button class="btn-submit-green">Save</button></div>
      </form>`,
    },
    {
      key: 'assessed', title: 'Run the first assessment', done: st.assessed, locked: !st.packs, why: 'Activate at least one pack first.',
      summary: st.assessed ? `${cov.pass} pass, ${cov.fail} fail and ${cov.unknown} unknown across ${plural(cov.total, 'applicable check')}.` : 'Checks every worker against the active packs and shows what is missing.',
      body: h`${st.assessed ? h`<dl class="report-figures setup-figures"><div><dt>Pass</dt><dd class="${cov.pass ? 'tone-text-pass' : ''}">${cov.pass}</dd></div><div><dt>Fail</dt><dd class="${cov.fail ? 'tone-text-fail' : ''}">${cov.fail}</dd></div><div><dt>Unknown</dt><dd class="${cov.unknown ? 'tone-text-warn' : ''}">${cov.unknown}</dd></div></dl><p class="setup-text muted">${cov.scope_statement}</p>` : ''}
        <div class="setup-actions"><button class="${st.assessed ? 'btn-card-outline' : 'btn-submit-green'}" data-act="assess">${st.assessed ? 'Run again' : 'Run assessment'}</button>${st.assessed ? h`<a class="btn-link-action" href="#overview">See the results on Overview</a>` : ''}</div>`,
    },
  ];
}
// A step: always shows its title and summary; opens to show its content. Locked steps say why.
const STEP_ICON = { done: '<path d="m5 12 5 5 9-10"/>', attention: '<path d="M12 7v6"/><path d="M12 17h.01"/>', locked: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>' };
function setupStep(x, n, current) {
  // A finished step with something left to fix asks for attention instead of saying Done.
  const state = x.done ? (x.attention ? 'attention' : 'done') : x.locked ? 'locked' : current ? 'current' : 'todo';
  const label = { done: 'Done', attention: x.attention === 1 ? '1 to fix' : `${x.attention} to fix`, locked: 'Not yet', current: 'Next', todo: 'To do' }[state];
  return h`<details class="setup-step is-${state}" id="step-${x.key}" ${state === 'current' ? raw('open') : ''}>
    <summary>
      <span class="step-mark" aria-hidden="true">${STEP_ICON[state] ? raw(`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">${STEP_ICON[state]}</svg>`) : n}</span>
      <span class="step-text"><b>${x.title}</b><span>${x.locked ? x.why : x.summary}</span></span>
      <span class="step-state">${label}</span>
      <svg class="chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
    </summary>
    <div class="step-content">${x.locked ? h`<p class="setup-text muted">${x.why}</p>` : x.body}</div>
  </details>`;
}

// ---------- Pilot metrics and audit history ----------
// Hours as people say them: minutes under an hour, days after two.
const hoursText = (h) => (h < 1 ? `${Math.max(1, Math.round(h * 60))} min` : h < 48 ? `${Math.round(h * 10) / 10} h` : `${Math.round(h / 24 * 10) / 10} days`);
let auditFilter = { kind: '', q: '', from: '', to: '' }, audit = { rows: [], more: false, total: 0 };
const auditUrl = (before) => `/api/audit/search?${new URLSearchParams(Object.entries({ ...auditFilter, before: before || '' }).filter(([, v]) => v)).toString()}`;
const AUDIT_LABEL = {
  CHECK_RESULT: 'Check result', CASE_OPENED: 'Case opened', CASE_STATE: 'Case moved', CASE_NOTE: 'Note added', CASE_ESCALATED: 'Case escalated', CASE_CLOSED: 'Case closed',
  FINDING_REVIEWED: 'Finding reviewed', EVIDENCE_MATCHED: 'Evidence matched', EVIDENCE_ACCEPTED: 'Evidence accepted', EVIDENCE_REJECTED: 'Evidence rejected', EVIDENCE_REVIEW: 'Sent to review', EVIDENCE_VIEWED: 'Evidence opened',
  APPROVAL_REQUESTED: 'Approval requested', APPROVAL_DECIDED: 'Decision made', APPROVAL_UPDATED: 'Approval updated', READINESS_REOPENED: 'Readiness reopened',
  MESSAGE_SENT: 'Message', DIGEST_SENT: 'Digest posted', DIGEST_OUTBOX: 'Digest saved', DIGEST_FAILED: 'Digest failed', CHAT_COMMAND: 'Coworker request',
  WORKER_ADDED: 'Worker added', ROSTER_IMPORT: 'Roster imported', ASSIGNMENT_CHANGED: 'Assignment changed', HRMS_EVENT: 'HRMS update', HRMS_SYNC: 'HRMS sync',
  PACK_ACTIVATED: 'Pack activated', PACK_MODE: 'Pack mode changed', CONTROL_DRAFTED: 'Rule drafted', DASHBOARD_CREATED: 'View saved', DASHBOARD_DELETED: 'View deleted', USER_ADDED: 'User added',
};
// The kind of each event, as on the server, so the dot matches the filter it belongs to.
const AUDIT_KIND = {};
for (const [k, list] of Object.entries({
  checks: ['CHECK_RESULT'], cases: ['CASE_OPENED', 'CASE_STATE', 'CASE_NOTE', 'CASE_ESCALATED', 'CASE_CLOSED', 'FINDING_REVIEWED'],
  evidence: ['EVIDENCE_MATCHED', 'EVIDENCE_ACCEPTED', 'EVIDENCE_REJECTED', 'EVIDENCE_REVIEW', 'EVIDENCE_VIEWED', 'EVIDENCE_RECEIVED'],
  approvals: ['APPROVAL_REQUESTED', 'APPROVAL_DECIDED', 'APPROVAL_UPDATED', 'READINESS_REOPENED'],
  messages: ['ACTION_SENT', 'MESSAGE_SENT', 'DIGEST_SENT', 'DIGEST_OUTBOX', 'DIGEST_FAILED', 'CHAT_COMMAND', 'SLACK_TEST'],
  records: ['WORKER_ADDED', 'ROSTER_IMPORT', 'ASSIGNMENT_CHANGED', 'HRMS_EVENT', 'HRMS_SYNC'],
})) for (const t of list) AUDIT_KIND[t] = k;
const auditKindOf = (t) => AUDIT_KIND[t] || 'settings';
const auditLabel = (t) => AUDIT_LABEL[t] || words(String(t).toLowerCase());
const AUDIT_TONE = { EVIDENCE_REJECTED: 'fail', CASE_ESCALATED: 'fail', DIGEST_FAILED: 'fail', CONNECTOR_ERROR: 'fail', AI_ERROR: 'fail', READINESS_REOPENED: 'warn', EVIDENCE_REVIEW: 'warn', EVIDENCE_ACCEPTED: 'pass', EVIDENCE_MATCHED: 'pass', CASE_CLOSED: 'pass' };
const timeUtc = (iso) => new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }).format(new Date(iso));
const dayLabel = (d) => (d === me.today ? 'Today' : d === addDaysLocal(me.today, -1) ? 'Yesterday' : date(d));
const addDaysLocal = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
// Capitalise a sentence that starts with a plain word ("approved"), never a file name or code.
const firstCap = (t) => (t && /^[a-z]+(\s|$)/.test(t) ? t[0].toUpperCase() + t.slice(1) : t);
function auditList() {
  if (!audit.rows.length) return emptyState(auditFilter.kind || auditFilter.q || auditFilter.from || auditFilter.to ? ['Nothing matches', 'Try another kind of event, name or date.'] : ['No entries yet', 'Every check, request and decision is recorded here.']);
  const days = [];
  for (const r of audit.rows) { const d = r.ts.slice(0, 10); if (days.at(-1)?.d !== d) days.push({ d, rows: [] }); days.at(-1).rows.push(r); }
  return h`<p class="audit-count">${audit.total.toLocaleString('en-US')} ${audit.total === 1 ? 'entry' : 'entries'}${audit.more ? `, showing the newest ${audit.rows.length}` : ''}. Times are UTC.</p>
    <div class="table-scroll-container"><table class="grouped-table audit-table"><thead><tr><th>Time</th><th>Event</th><th>Subject</th><th>What happened</th><th>By</th></tr></thead>
    ${days.map((g) => h`<tbody><tr class="group-row"><th colspan="5" scope="colgroup">${dayLabel(g.d)}<span>${g.rows.length}</span></th></tr>${g.rows.map((r) => h`<tr class="click" data-act="auditDetail" data-seq="${r.seq}" aria-expanded="false"><td class="nowrap num-left">${timeUtc(r.ts)}</td><td class="nowrap"><span class="audit-event${AUDIT_TONE[r.type] ? ` tone-${AUDIT_TONE[r.type]}` : ''}"><i class="kind-dot kind-${auditKindOf(r.type)}" aria-hidden="true"></i>${auditLabel(r.type)}</span></td><td>${r.subject}</td><td class="small">${firstCap(r.action)}</td><td class="muted nowrap">${r.actor}</td></tr>`)}</tbody>`)}
    </table></div>
    ${audit.more ? h`<div class="load-more"><button class="btn-card-outline" data-act="auditMore">Load older entries</button></div>` : ''}`;
}
async function reloadAudit() {
  const res = await api(auditUrl());
  audit = { rows: res.rows, more: res.has_more, total: res.total };
  const el = $('#auditList'); if (el) { el.innerHTML = render(auditList()); labelTableCells(el); }
}


// Detail pages carry their own title; the crumb links back to the list they came from.
function pageHead(crumb, href, title, sub) {
  const c = $('#crumb'); if (c) c.innerHTML = render(h`<a href="${href}">${crumb}</a>`);
  const t = $('#heading'); if (t) t.textContent = title;
  const d = $('#scope'); if (d) d.textContent = sub || '';
}
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const pct = (x) => (x.total ? Math.round(x.pass / x.total * 100) : 0);
// The same pass / fail / unknown bar the Overview uses.
const passBar = (x) => h`<div class="ov-pack-bar" role="img" aria-label="${`${x.pass} pass, ${x.fail} fail, ${x.unknown} unknown`}">${['pass', 'fail', 'unknown'].map((k) => (x[k] && x.total ? h`<i class="ov-band-${k}" style="width:${100 * x[k] / x.total}%"></i>` : ''))}</div>`;

// Dashboards
const GROUP_LABEL = { facility: 'facility', team: 'team', pack: 'pack', status: 'result', control: 'requirement', window: 'time left', readiness: 'decision' };
const SHOWS = { readiness: 'Workers', expirations: 'Credentials', open_gaps: 'Open gaps', missing_evidence: 'Missing documents', coverage: 'Applicable checks' };
// What the view counts and how it is split, in a few words.
const dashShows = (d) => `${SHOWS[d.definition.metric] || 'Checks'} by ${GROUP_LABEL[d.definition.group_by] || 'group'}${d.definition.pack ? `, ${words(d.definition.pack)} only` : ''}${d.definition.within_days ? `, next ${d.definition.within_days} days` : ''}`;
// The figure in the list and the sentence on top of the dashboard. Both come from the API's numbers.
function dashNow(d, data) {
  const g = (name) => data.groups.find((x) => x.name === name)?.count || 0;
  switch (d.definition.metric) {
    case 'readiness': return { figure: h`<b>${g('approved')}</b> of ${data.total} approved`, sentence: `${g('approved')} of ${plural(data.total, 'worker')} approved for assignment. ${g('pending')} pending, ${g('blocked')} blocked.` };
    case 'expirations': {
      const expired = g('Expired'), soon = g('Next 30 days');
      return { figure: h`<b>${data.total}</b>${expired ? h` <span class="text-fail">${expired} expired</span>` : ''}`, sentence: data.total ? `${plural(data.total, 'credential')} to renew: ${expired} expired, ${soon} within 30 days, ${data.total - expired - soon} later.` : 'No credentials expire in this window.' };
    }
    case 'coverage': return { figure: h`<b>${data.split.pass}</b> of ${data.total} pass`, sentence: `${data.split.pass} of ${plural(data.total, 'applicable check')} pass. ${data.split.fail} fail, ${data.split.unknown} cannot be proven yet.` };
    default: {
      const by = GROUP_LABEL[d.definition.group_by], many = by === 'facility' ? 'facilities' : `${by}s`;
      return { figure: h`<b>${data.total}</b>`, sentence: data.total ? `${plural(data.total, d.definition.metric === 'missing_evidence' ? 'missing document' : 'open gap')} across ${plural(data.groups.length, by, many)}.` : 'Nothing open.' };
    }
  }
}
// A coloured bar only where colour means status. Parts with nothing in them are left out.
const statusBar = (parts) => {
  const total = parts.reduce((a, x) => a + x.n, 0);
  return h`<div class="ov-pack-bar card-bar" role="img" aria-label="${parts.filter((x) => x.n).map((x) => `${x.n} ${x.label.toLowerCase()}`).join(', ') || 'Nothing to show'}">${total ? parts.filter((x) => x.n).map((x) => h`<i class="tone-${x.tone}" style="width:${100 * x.n / total}%"></i>`) : ''}</div>`;
};
// The parts of a dashboard's bar, and the line under it that names those parts in the same colours.
const READY_TONE = { blocked: 'fail', pending: 'warn', approved: 'pass' };
const WINDOW_TONE = { Expired: 'fail', 'Next 30 days': 'warn', '31 to 60 days': 'na', '61 to 90 days': 'na' };
const toneText = (n, text, tone) => (n ? h`<span class="tone-text-${tone}">${n} ${text}</span>` : '');
// "a, b and c" from the non-empty parts.
const joinParts = (xs) => { const p = xs.filter((x) => x && x.s !== ''); return p.length < 2 ? p : [...p.slice(0, -1).flatMap((x, n) => (n ? [', ', x] : [x])), ' and ', p.at(-1)]; };
function dashParts(d, data) {
  const g = (name) => data.groups.find((x) => x.name === name)?.count || 0;
  switch (d.definition.metric) {
    case 'readiness': return { parts: [{ label: 'Approved', n: g('approved'), tone: 'pass' }, { label: 'Pending', n: g('pending'), tone: 'warn' }, { label: 'Blocked', n: g('blocked'), tone: 'fail' }], note: joinParts([toneText(g('pending'), 'pending', 'warn'), toneText(g('blocked'), 'blocked', 'fail')]) };
    case 'expirations': {
      const expired = g('Expired'), soon = g('Next 30 days');
      return { parts: [{ label: 'Expired', n: expired, tone: 'fail' }, { label: 'Within 30 days', n: soon, tone: 'warn' }, { label: 'Later', n: data.total - expired - soon, tone: 'na' }], note: data.total ? (expired || soon ? joinParts([toneText(expired, 'expired', 'fail'), toneText(soon, 'within 30 days', 'warn')]) : 'None within 30 days') : 'Nothing expiring' };
    }
    case 'coverage': return { parts: [{ label: 'Pass', n: data.split.pass, tone: 'pass' }, { label: 'Fail', n: data.split.fail, tone: 'fail' }, { label: 'Unknown', n: data.split.unknown, tone: 'warn' }], note: data.split.fail || data.split.unknown ? joinParts([toneText(data.split.fail, 'fail', 'fail'), toneText(data.split.unknown, 'unknown', 'warn')]) : 'All pass' };
    default: return { parts: [{ label: 'Fail', n: data.split.fail, tone: 'fail' }, { label: 'Unknown', n: data.split.unknown, tone: 'warn' }], note: data.total ? joinParts([toneText(data.split.fail, 'fail', 'fail'), toneText(data.split.unknown, 'unknown', 'warn')]) : 'Nothing open' };
  }
}
const DASH_LABEL = { readiness: 'approved', expirations: 'to renew', coverage: 'checks pass', open_gaps: 'open', missing_evidence: 'missing' };
function dashCard(d) {
  const x = d.summary, m = d.definition.metric, { parts, note } = dashParts(d, x);
  const value = m === 'readiness' ? h`${parts[0].n}<small>of ${x.total}</small>` : m === 'coverage' ? h`${x.split.pass}<small>of ${x.total}</small>` : x.total;
  return h`<a class="view-card" href="#dashboards/${d.id}">
    <span class="view-card-name">${d.name}</span>
    <span class="view-card-figure"><b>${value}</b><span>${DASH_LABEL[m] || ''}</span></span>
    ${statusBar(parts)}
    <span class="view-card-note">${note}${d.built_in ? '' : h`<span class="view-card-owner">Saved by ${d.created_by}</span>`}</span>
  </a>`;
}
function reportCard(p) {
  return h`<div class="view-card report-card">
    <a class="view-card-name" href="#reports/${p.key}">${packIcon(p.key)}<span>${p.name}</span></a>
    <span class="view-card-figure"><b>${pct(p)}%</b><span>${p.pass} of ${p.total} pass</span></span>
    ${passBar(p)}
    <span class="view-card-note">${p.fail || p.unknown ? h`${p.fail ? h`<span class="text-fail">${p.fail} fail</span>` : ''}${p.fail && p.unknown ? ', ' : ''}${p.unknown ? h`<span class="text-warn">${p.unknown} unknown</span>` : ''}` : 'All pass'}</span>
    <span class="view-card-actions"><a class="btn-card-outline" href="#reports/${p.key}">Open report</a><a class="btn-link-action" href="/api/reports/${p.key}" download aria-label="${`Download ${p.name} as CSV`}">Download CSV</a></span>
  </div>`;
}
const timeLeft = (n) => (n < 0 ? h`<span class="text-fail">${plural(-n, 'day')} ago</span>` : n === 0 ? h`<span class="text-fail">Today</span>` : n <= 30 ? h`<span class="text-warn">${plural(n, 'day')}</span>` : plural(n, 'day'));
// The place line under a name is left out when the table is already grouped by place.
const personCell = (i, place = true) => (i.subject_type === 'worker' ? h`<button class="row-title" data-act="workerDetail" data-id="${i.subject_id}">${i.subject}</button>${place ? h`<div class="case-sub">${i.facility}</div>` : ''}` : h`<span class="row-title is-static">${i.subject}</span>${place ? h`<div class="case-sub">Company level</div>` : ''}`);
// What should happen next for a worker, from their decision and open checks.
const nextStep = (i) => (i.readiness === 'approved' ? (i.open ? 'Approved with open checks' : 'Cleared to start')
  : i.readiness === 'blocked' ? (i.open ? 'Resolve the open checks, then ask again' : 'Ask for a new decision')
    : i.open ? 'Collect the missing documents' : 'Ready for a decision');
const groupId = (n) => `grp-${n}`;
const groupTone = (by, name) => (by === 'readiness' ? READY_TONE[name] : by === 'window' ? WINDOW_TONE[name] : '');
// One chart per dashboard, answering its question at a glance. Each part jumps to its group below.
function dashChart(d, data) {
  const m = d.definition.metric, by = d.definition.group_by, name = (n) => (by === 'status' || by === 'readiness' ? words(n) : n);
  if (!data.groups.length) return '';
  if (m === 'readiness' || m === 'expirations') {
    const keys = m === 'readiness' ? ['blocked', 'pending', 'approved'] : Object.keys(WINDOW_TONE);
    return h`<div class="stat-blocks">${keys.map((k) => { const n = data.groups.findIndex((x) => x.name === k), c = n < 0 ? 0 : data.groups[n].count; return h`<button class="stat-block tone-${groupTone(by, k)}${c ? '' : ' is-zero'}" ${c ? raw(`data-act="jumpGroup" data-g="${groupId(n)}"`) : raw('disabled')}><span><i></i>${name(k)}</span><b>${c}</b></button>`; })}</div>`;
  }
  const max = Math.max(...data.groups.map((g) => g.count));
  return h`<div class="bar-chart" role="list">${data.groups.map((g, n) => { const t = g.split.pass + g.split.fail + g.split.unknown || g.count; const go = m !== 'coverage' || g.split.fail + g.split.unknown; return h`<button class="bar-chart-row" role="listitem" ${go ? raw(`data-act="jumpGroup" data-g="${groupId(n)}"`) : raw('disabled')}><span class="bar-chart-label">${name(g.name)}</span><span class="bar-chart-track"><span class="bar-chart-fill" style="width:${100 * g.count / max}%">${['pass', 'fail', 'unknown'].map((k) => (g.split[k] ? h`<i class="tone-${k === 'unknown' ? 'warn' : k}" style="width:${100 * g.split[k] / t}%"></i>` : ''))}</span></span><span class="bar-chart-value">${m === 'coverage' ? h`<b>${g.split.pass}</b> of ${g.count} pass` : h`<b>${g.count}</b>`}</span></button>`; })}</div>`;
}
// One table for the whole dashboard; each group is a heading row, so columns line up across groups.
function dashTable(d, data) {
  const m = d.definition.metric, by = d.definition.group_by, place = by !== 'facility';
  const cols = m === 'readiness' ? ['Worker', 'Open checks', 'Next step'] : m === 'expirations' ? ['Worker', 'Credential', 'Expires', 'Left'] : ['Worker', 'Requirement', 'Result', 'Why'];
  const row = (i) => (m === 'readiness'
    ? h`<tr><td>${personCell(i)}</td><td>${i.open ? h`<span class="open-count">${i.open}</span>` : h`<span class="muted">None</span>`}</td><td class="small">${nextStep(i)}</td></tr>`
    : m === 'expirations'
      ? h`<tr><td>${personCell(i)}</td><td>${i.control}<div class="case-sub">${words(i.pack)}</div></td><td class="nowrap">${date(i.expires_on)}</td><td class="nowrap num">${timeLeft(i.days_left)}</td></tr>`
      : h`<tr><td>${personCell(i, place)}</td><td>${i.control}<div class="case-sub">${words(i.pack)}</div></td><td>${statusPill(i.status)}</td><td class="small">${i.reason}</td></tr>`);
  const name = (n) => (by === 'status' || by === 'readiness' ? words(n) : n);
  if (m === 'coverage' && data.groups.length) {
    const open = data.groups.map((g, n) => { const items = g.items.filter((i) => i.status !== 'pass'); return { ...g, items, count: items.length, at: n }; }).filter((g) => g.items.length);
    return open.length ? h`<h3 class="coverage-sub">Not passing</h3>${dashTable({ ...d, definition: { ...d.definition, metric: 'open_gaps' } }, { ...data, groups: open })}` : emptyState(['Everything passes', 'Every applicable check passes with accepted evidence.']);
  }
  if (!data.groups.length) return emptyState([m === 'expirations' ? 'Nothing expires in this window' : 'Nothing to show', 'This view updates as checks change.']);
  return h`<div class="table-scroll-container"><table class="grouped-table"><thead><tr>${cols.map((c, n) => h`<th class="${m === 'expirations' && n === 3 ? 'num' : ''}">${c}</th>`)}</tr></thead>${data.groups.map((g, n) => { const tone = groupTone(by, g.name); return h`<tbody><tr class="group-row" id="${groupId(g.at ?? n)}" tabindex="-1"><th colspan="${cols.length}" scope="colgroup">${tone ? h`<i class="group-dot tone-${tone}" aria-hidden="true"></i>` : ''}${name(g.name)}<span>${g.count}</span></th></tr>${g.items.map(row)}</tbody>`; })}</table></div>`;
}
function dashboardDetail(d) {
  const data = d.data, now = dashNow(d, data);
  const canDelete = !d.built_in && canEdit() && (me.user.is_admin || d.created_by === me.user.name);
  pageHead('Dashboards', '#dashboards', d.name, d.built_in ? d.description : `${dashShows(d)}. Saved by ${d.created_by}.`);
  // Reading a dashboard, not making one: the header keeps Copy link and drops New view.
  const nv = $('#topTools [data-act="newView"]'); if (nv) nv.hidden = true;
  return h`<div class="panel">
    <div class="ph2"><div><h2>${now.sentence}</h2><p>Updated ${dt(data.as_of)} UTC</p></div><div class="row">${canDelete ? h`<button class="btn-link-action danger" data-act="deleteView" data-id="${d.id}" data-name="${d.name}">Delete view</button>` : ''}<button class="btn-card-outline" data-act="copyLink">Copy link</button></div></div>
    ${dashChart(d, data)}
    ${dashTable(d, data)}
  </div>`;
}

// Reports
const NOTICE_LABEL = { draft_awaiting_approval: 'Waiting for Finance', response_approved: 'Reply approved', needs_rework: 'Needs rework' };
const NOTICE_PILL = { draft_awaiting_approval: 'pill-warn', response_approved: 'pill-pass', needs_rework: 'pill-fail' };
function digestPanel(d) {
  if (d.error) return card('Daily digest', d.error, '', h`<button class="btn-card-outline" data-act="retryView">Try again</button>`);
  const last = d.last;
  const line = !last ? 'Not sent yet.' : last.type === 'DIGEST_FAILED' ? `The last attempt failed on ${dt(last.ts)}. Check Connections.` : last.type === 'DIGEST_SENT' ? `Last posted to ${d.channel} on ${dt(last.ts)}.` : `Last saved to the outbox on ${dt(last.ts)}. Connect Slack to post it to ${d.channel}.`;
  return card('Daily digest', line, h`<pre class="digest-text">${d.preview}</pre>`, h`<button class="btn-card-outline" data-act="sendDigest">Send now</button>`);
}
function reportDetail(r) {
  const t = r.tally;
  pageHead('Reports', '#reports', r.title, 'Read it here, print it, or save it as PDF to share.');
  return h`<div>
    <article class="panel report-doc">
      <header class="report-head"><div><h2>${r.tenant} compliance report</h2><p>${r.pack === 'all' ? `All activated packs: ${r.packs.join(', ')}` : `${r.title} pack`}. Generated ${dt(r.as_of)} UTC.</p></div><div class="row no-print"><a class="btn-card-outline" href="/api/reports/${r.pack}" download>Download CSV</a><button class="btn-submit-green" data-act="printReport">Print or save as PDF</button></div></header>
      <p class="report-scope">${r.all_pass ? `All ${t.total} applicable checks in scope pass with accepted evidence. ` : ''}${r.scope_statement}</p>
      <dl class="report-figures"><div><dt>Applicable checks</dt><dd>${t.total}</dd></div><div><dt>Pass</dt><dd>${t.pass}</dd></div><div><dt>Fail</dt><dd class="${t.fail ? 'text-fail' : ''}">${t.fail}</dd></div><div><dt>Unknown</dt><dd class="${t.unknown ? 'text-warn' : ''}">${t.unknown}</dd></div></dl>
      ${passBar(t)}
      <h3 class="report-h">Needs attention</h3>
      ${table(['Person', 'Requirement', 'Result', 'Why'], r.attention.map((i) => h`<tr><td><span class="row-title is-static">${i.subject}</span><div class="case-sub">${i.facility}</div></td><td>${i.control}<div class="case-sub">${words(i.pack)}</div></td><td>${statusPill(i.status)}</td><td class="small">${i.reason}</td></tr>`), ['Nothing needs attention', 'Every applicable check in this report passes with accepted evidence.'])}
      <h3 class="report-h">By location</h3>
      ${table(['Location', num('Checks'), num('Pass'), num('Fail'), num('Unknown')], r.facilities.map((f) => h`<tr><td>${f.name}</td><td class="num">${f.total}</td><td class="num">${f.pass}</td><td class="num">${f.fail ? h`<span class="text-fail">${f.fail}</span>` : '0'}</td><td class="num">${f.unknown ? h`<span class="text-warn">${f.unknown}</span>` : '0'}</td></tr>`), 'No locations.')}
      <p class="report-foot">Each result records its reason, the rule version and the accepted evidence it relied on. The CSV lists them for every check.</p>
    </article>
  </div>`;
}

// Worker window buttons. When every check passes, asking for the readiness decision is the main step.
// While checks are open, getting the missing documents is, and the decision is still there but quieter.
function workerFoot(w, openN, total) {
  if (!canEdit() || w.status !== 'active') return '';
  const move = h`<button class="btn-cancel" data-act="moveWorker" data-id="${w.id}">Change assignment</button>`;
  const upload = (cls) => h`<button class="${cls}" data-act="uploadEvidence" data-subject="worker:${w.id}" data-name="${w.name}">Upload evidence</button>`;
  // Already asked: one open request at a time (the backend refuses a second one).
  if (w.readiness_request) return h`${move}<button class="btn-cancel" data-act="openApprovals">Waiting in Approvals</button>${upload(openN ? 'btn-submit-green' : 'btn-cancel')}`;
  // Already approved: nothing to ask. If a passing check fails later, the backend sets it back to pending.
  if (w.readiness === 'approved') return h`${move}${upload(openN ? 'btn-submit-green' : 'btn-cancel')}`;
  const label = w.readiness === 'blocked' ? 'Ask for a new decision' : 'Request readiness decision';
  if (total && !openN) return h`${move}${upload('btn-cancel')}<button class="btn-submit-green" data-act="readiness" data-id="${w.id}">${label}</button>`;
  return h`${move}<button class="btn-cancel" data-act="readiness" data-id="${w.id}" data-open="${openN || 1}">Request decision anyway</button>${upload('btn-submit-green')}`;
}
function openCaseCell(c) { return h`<button class="btn-link-action" data-act="caseDetail" data-id="${c.id}">Open</button>`; }
const VIEWS = {
  async overview() {
    const [report, health, openCases] = await Promise.all([
      api('/api/overview'),
      me.user.is_admin ? api('/api/health') : null,
      api('/api/cases')
    ]);
    const { coverage, kpi, urgent, packs } = report;
    const percent = (count) => coverage.total ? 100 * count / coverage.total : 0;
    const counts = [
      { label: 'Pass', value: coverage.pass, kind: 'pass' },
      { label: 'Fail', value: coverage.fail, kind: 'fail' },
      { label: 'Unknown', value: coverage.unknown, kind: 'unknown' }
    ];
    const failedConnector = health?.connectors?.find((connector) => connector.last_error);
    const alert = $('#alert');
    if (alert) {
      alert.hidden = !failedConnector;
      alert.innerHTML = failedConnector ? render(h`<p><b>${failedConnector.name}</b> needs attention. ${failedConnector.last_error}</p><a class="btn" href="#integrations">Review connection</a>`) : '';
    }
    const subtitle = $('#scope');
    if (subtitle) subtitle.textContent = `Last checked ${dt(coverage.as_of)} UTC · ${packs.length} active pack${packs.length === 1 ? '' : 's'}`;
    // "Today": what needs attention now, each part a link to the list behind it.
    const overdue = openCases.filter((c) => (daysFromToday(c.due_date) ?? 1) < 0).length;
    const dueSoon = openCases.filter((c) => { const n = daysFromToday(c.due_date); return n !== null && n >= 0 && n <= 7; }).length;
    const today = [
      { n: overdue, one: 'case overdue', many: 'cases overdue', tone: 'late', href: '#cases' },
      { n: dueSoon, one: 'case due this week', many: 'cases due this week', tone: 'soon', href: '#cases' },
      { n: kpi.expiring, one: 'credential expiring soon', many: 'credentials expiring soon', tone: 'soon', href: '#dashboards/builtin-expiring' },
      { n: kpi.pending_approvals, one: 'approval waiting for you', many: 'approvals waiting for you', tone: 'soon', href: '#approvals' }
    ];
    const allClear = today.every((t) => !t.n);
    const workload = [
      { label: 'Open cases', count: kpi.open_cases, destination: 'cases' },
      { label: 'Pending approvals', count: kpi.pending_approvals, destination: 'approvals' },
      { label: 'Active workers', count: kpi.workers, destination: 'workers' }
    ];
    const fmtDate = (iso) => iso ? new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(new Date(iso)) : 'No deadline';
    return h`<div class="ov-workspace">
      <nav class="today-strip${allClear ? ' all-clear' : ''}" aria-label="Needs attention today">
        <span class="today-label">Today</span>
        ${allClear ? h`<span class="today-item"><i class="tone-ok"></i>Nothing needs attention right now</span>`
          : today.map((t) => h`<a class="today-item${t.n ? '' : ' is-zero'}" href="${t.href}"><i class="tone-${t.n ? t.tone : 'zero'}"></i><b>${t.n}</b> ${t.n === 1 ? t.one : t.many}</a>`)}
      </nav>
      <section class="ov-snapshot" aria-label="Assessment summary">
        <div class="ov-coverage">
          <div class="ov-heading"><h2>Verification coverage</h2><a href="#checks">View checks <span aria-hidden="true">↗</span></a></div>
          <p class="ov-metric"><strong>${coverage.pass}</strong><span>of ${coverage.total} applicable checks pass</span></p>
          <div class="ov-bar" aria-hidden="true">${counts.filter((s) => s.value).map((s) => h`<i class="ov-band-${s.kind}" style="width:${percent(s.value)}%"></i>`)}</div>
          <div class="ov-legend">${counts.map((s) => h`<span><i class="ov-band-${s.kind}"></i>${s.label} <b>${s.value}</b></span>`)}</div>
        </div>
        <div class="ov-workload">
          <h2>Workspace activity</h2>
          <div class="ov-counter-list">${workload.map((item) => h`<a href="#${item.destination}"><strong>${item.count}</strong><span>${item.label}</span></a>`)}</div>
          <p>${kpi.expiring} credential${kpi.expiring === 1 ? '' : 's'} approaching expiration</p>
        </div>
      </section>
      <div class="ov-detail-grid">
        <section class="ov-panel ov-queue" aria-labelledby="ov-queue-title">
          <header class="ov-panel-head"><div><h2 id="ov-queue-title">Priority cases</h2><p>Ordered by priority and due date</p></div><a href="#cases">All cases <span aria-hidden="true">→</span></a></header>
          ${urgent.length ? h`<div class="ov-table-scroll" tabindex="0" role="region" aria-label="Priority cases table"><table class="ov-table"><thead><tr><th scope="col">Case</th><th scope="col">Owner</th><th scope="col">Due</th></tr></thead><tbody>
            ${urgent.map((c) => h`<tr><td><a class="ov-case-title" href="#cases/${encodeURIComponent(c.id)}">${c.control_name}</a><small>${c.subject_name} <span aria-hidden="true">·</span> ${words(c.state)}</small></td>
            <td>${c.owner_name || c.owner_team || 'Unassigned'}</td>
            <td><time datetime="${c.due_date || ''}">${fmtDate(c.due_date)}</time>${dueNote(c.due_date) || (c.priority === 'high' ? h`<small class="ov-urgent">High priority</small>` : '')}</td></tr>`)}
          </tbody></table></div>` : h`<div class="ov-empty"><h3>No open cases in your queue</h3><p>${coverage.total ? 'See Checks for individual assessment results.' : 'Cases appear after the first assessment finds a gap.'}</p><a href="#checks">View checks →</a></div>`}
        </section>
        <section class="ov-panel ov-packs" aria-labelledby="ov-packs-title">
          <header class="ov-panel-head"><div><h2 id="ov-packs-title">Active packs</h2><p>Assessment scope by workflow</p></div><a href="#packs">View packs <span aria-hidden="true">→</span></a></header>
          ${packs.length ? h`<ul class="ov-pack-list">${packs.map((p) => h`<li><div class="ov-pack-heading"><h3>${p.name}</h3><span class="ov-pack-score"><b>${p.total ? Math.round(100 * p.pass / p.total) : 0}%</b> ${p.pass} of ${p.total} pass</span></div><div class="ov-pack-bar" role="img" aria-label="${`${p.pass} pass, ${p.fail} fail, ${p.unknown} unknown`}">${['pass','fail','unknown'].map((s) => p[s] && p.total ? h`<i class="ov-band-${s}" style="width:${100*p[s]/p.total}%"></i>` : '')}</div><p class="ov-pack-meta">${p.fail ? h`<span class="ov-count ov-count-fail"><i></i>${p.fail} fail</span>` : ''}${p.unknown ? h`<span class="ov-count ov-count-unknown"><i></i>${p.unknown} unknown</span>` : ''}${!p.fail && !p.unknown ? h`<span class="ov-count ov-count-pass"><i></i>All pass</span>` : ''}<span class="ov-mode">${p.mode === 'auto' ? 'Automatic' : 'Validation only'}</span></p></li>`)}</ul>` : h`<div class="ov-empty"><h3>No active packs</h3><p>An administrator can review and activate packs in Company setup.</p></div>`}
        </section>
      </div>
      <div class="ov-scope-note">${coverage.scope_statement}</div>
    </div>`;
  },
  async setup() {
    scope(null);
    const s = await api('/api/setup');
    const steps = setupSteps(s), done = steps.filter((x) => x.done).length, next = steps.find((x) => !x.done && !x.locked);
    const total = steps.length, fix = steps.find((x) => x.done && x.attention);
    return h`<div class="stack">
      <section class="panel setup-progress" aria-labelledby="setupProgress">
        <div class="setup-progress-text">
          <h2 id="setupProgress">${done === total ? 'Setup is complete' : `${done} of ${total} steps done`}</h2>
          <p>${done === total ? `Aegis is checking ${plural(s.summary.workers, 'worker')} against ${plural(s.recommended.filter((p) => p.status === 'active').length, 'active pack')}.${fix ? ` One step needs attention: ${fix.title.toLowerCase()}.` : ' You can change any step below.'}` : `Next: ${next ? next.title.toLowerCase() : 'finish the steps above'}.`}</p>
        </div>
        <ol class="setup-meter" aria-hidden="true">${steps.map((x) => h`<li class="${x.done ? 'is-done' : x === next ? 'is-current' : ''}"></li>`)}</ol>
        ${next ? h`<button class="btn-submit-green" data-act="openStep" data-step="${next.key}">Continue</button>` : fix ? h`<button class="btn-card-outline" data-act="openStep" data-step="${fix.key}">Review</button>` : ''}
      </section>
      <div class="setup-steps">${steps.map((x, n) => setupStep(x, n + 1, x === next))}</div>
    </div>`;
  },
  async cases() {
    scope(null);
    const [rows, packs] = await Promise.all([api(`/api/cases${caseClosed ? '?closed=1' : ''}`), caseClosed ? [] : api('/api/packs')]);
    const autoPacks = new Set(packs.filter((p) => p.mode === 'auto').map((p) => p.key));
    // Why a follow-up would not be sent, known before sending. "Already sent today" is only known by the server.
    const skipOf = (c) => !autoPacks.has(c.pack_key) ? 'validation' : c.gap_kind === 'review' ? 'review' : '';
    const selectable = !caseClosed && rows.some((c) => c.can_act);
    for (const id of [...caseSel]) if (!rows.some((c) => c.id === id && c.can_act)) caseSel.delete(id);
    const pickCell = (c) => !selectable ? '' : c.can_act
      ? h`<td class="select-cell"><label><input type="checkbox" class="case-check" data-id="${c.id}" ${caseSel.has(c.id) ? raw('checked') : ''} aria-label="${`Select ${c.control_name} for ${c.subject_name}`}"></label></td>`
      : h`<td class="select-cell"></td>`;
    const tabs = h`<div class="filters"><button class="chip${caseClosed ? '' : ' on'}" data-act="caseTab" data-v="">Open</button><button class="chip${caseClosed ? ' on' : ''}" data-act="caseTab" data-v="1">Closed</button></div>`;
    const caseRows = rows.map((c) => h`<tr class="click${caseSel.has(c.id) ? ' is-picked' : ''}" data-act="caseDetail" data-id="${c.id}" data-can-follow-up="${!caseClosed && c.can_act}" data-skip="${skipOf(c)}" data-name="${c.control_name}" data-subject="${c.subject_name}">
      ${pickCell(c)}
      <td class="case-main" title="${c.gap}"><button class="row-title" data-act="caseDetail" data-id="${c.id}">${c.control_name}</button><div class="case-sub">${c.subject_name}<span aria-hidden="true"> · </span><span class="mono">${c.id}</span></div></td>
      <td>${packTag(c.pack_key)}</td>
      <td><div class="stage-cell">${statePill(c.state)}${c.escalated ? h`<span class="pill pill-fail">Escalated</span>` : ''}</div></td>
      <td class="owner-cell">${c.owner_name || c.owner_team || 'Unassigned'}</td>
      <td class="due-cell"><span>${date(c.due_date)}${dueNote(c.due_date, !caseClosed)}</span></td>
      <td class="${c.finding_verdict ? '' : 'muted'}">${c.finding_verdict ? words(c.finding_verdict) : 'Not reviewed yet'}</td>
      <td class="row-action">${caseClosed ? words(c.closure) : c.can_act ? h`<button class="top-action-btn btn-row" data-act="followUp" data-id="${c.id}">Follow up</button>` : ''}</td>
    </tr>`);
    const followUps = selectable ? h`<button class="btn-intake-evidence" id="chaseAllBtn" data-act="chaseAll">Follow up on all</button>` : '';
    const allBox = h`<label class="select-all"><input type="checkbox" class="case-check-all" aria-label="Select all cases shown"></label>`;
    return card(caseClosed ? 'Closed cases' : 'Open cases', caseClosed ? 'Cases closed by accepted evidence or no longer applicable.' : `${rows.length} open${rows.filter((c) => (daysFromToday(c.due_date) ?? 1) < 0).length ? ` · ${rows.filter((c) => (daysFromToday(c.due_date) ?? 1) < 0).length} overdue` : ''}. Open a case to see its gap and history.`,
      h`${tabs}${table([...(selectable ? [allBox] : []), 'Case', 'Pack', 'Stage', 'Owner', 'Due', 'Finding', caseClosed ? 'How it closed' : ''], caseRows, caseClosed ? ['No closed cases yet', 'Cases appear here once accepted evidence closes them.'] : ['No open cases', 'Every check in scope passes, or its gap is already closed.'])}`, followUps);
  },
  async approvals() {
    scope(null);
    const [rows, approved, rejected] = await Promise.all([api('/api/approvals'), api('/api/approvals?status=approved'), api('/api/approvals?status=rejected')]);
    const done = [...approved, ...rejected].sort((a, b) => (a.decided_at < b.decided_at ? 1 : -1));
    return h`<div class="stack">${card('Waiting for you', 'Only items your role can decide appear here.', table(['Type', 'Item', 'Detail', 'Requested by', ''], rows.map((a) => h`<tr><td><span class="pill pill-blue">${words(a.kind)}</span></td><td><strong>${a.title}</strong></td><td class="text-secondary">${a.detail}</td><td class="text-muted">${a.requested_by}</td><td style="text-align:right;white-space:nowrap"><button class="btn-link-action" data-act="decide" data-id="${a.id}" data-d="approved">Approve</button> <button class="btn-link-action danger" data-act="decide" data-id="${a.id}" data-d="rejected">Reject</button></td></tr>`), ['Nothing waiting for you', 'When Aegis needs a person to decide something, it appears here.']))}
    ${card('Recent decisions', 'Approved and rejected items. Every decision also stays in the audit history.', table(['Item', 'Decision', 'Decided by', 'When', 'Note'], done.slice(0, 15).map((a) => h`<tr><td><strong>${a.title}</strong><div class="case-sub">${words(a.kind)}</div></td><td><span class="pill ${a.status === 'approved' ? 'pill-pass' : 'pill-fail'}">${a.status === 'approved' ? 'Approved' : 'Rejected'}</span></td><td>${a.decided_by}</td><td class="nowrap">${dt(a.decided_at)}</td><td class="text-muted">${a.note || '—'}</td></tr>`), ['No decisions yet', 'Approved and rejected items appear here.']))}</div>`;
  },
  async checks() {
    const qs = new URLSearchParams(Object.entries(checkFilter).filter(([, v]) => v)).toString();
    const d = await api(`/api/checks?${qs}`); scope(d.coverage);
    const chip = (k, v, l) => h`<button class="chip${(checkFilter[k] || '') === v ? ' on' : ''}" data-act="checkFilter" data-k="${k}" data-v="${v}">${l}</button>`;
    return card('All Evaluations', `${d.rows.length} shown. Unknown means the record cannot prove the requirement yet.`, h`<div class="filters">${chip('status', '', 'All')}${chip('status', 'pass', 'Pass')}${chip('status', 'fail', 'Fail')}${chip('status', 'unknown', 'Unknown')}${chip('status', 'not_applicable', 'N/A')}<span style="width:12px"></span>${chip('pack', '', 'All packs')}${['healthcare', 'onboarding', 'immigration', 'payroll'].map((p) => chip('pack', p, words(p)))}</div>${table(['Subject', 'Control', 'Requirement', 'Result', 'Reason', 'Evidence', 'Version'], d.rows.map((c) => h`<tr><td><strong>${c.subject_name}</strong><div class="muted small">${c.facility}</div></td><td>${c.control_name}</td><td class="muted">${words(c.requirement_type)}</td><td>${statusPill(c.status)}</td><td>${c.reason}</td><td class="mono">${c.evidence_ids.length ? c.evidence_ids.length : '—'}</td><td class="mono">${c.control_version}</td></tr>`), ['No checks match', 'Try another result or pack filter.'])}`);
  },
  async workers() {
    scope(null);
    // Workers with the most open checks come first, so problems are at the top.
    const openOf = (w) => (w.checks?.fail || 0) + (w.checks?.unknown || 0);
    const rows = (await api('/api/workers')).sort((a, b) => openOf(b) - openOf(a) || a.name.localeCompare(b.name));
    const withGaps = rows.filter((w) => openOf(w)).length;
    return card('All workers', `${rows.length} workers${withGaps ? ` · ${withGaps} with open checks` : ''}. A tick means the pack passes; only problems are highlighted.`, table(['Worker', 'Location', 'Onboarding', 'Healthcare', 'Immigration', 'Payroll', 'Overall', 'Open', 'Readiness'], rows.map((w) => h`<tr class="click" data-act="workerDetail" data-id="${w.id}"><td><button class="row-title" data-act="workerDetail" data-id="${w.id}">${w.name}</button>${w.status !== 'active' ? h` <span class="pill pill-na">${words(w.status)}</span>` : ''}<div class="case-sub">${w.role || 'No role'}</div></td><td class="${w.facility ? '' : 'muted'}">${w.facility || 'No confirmed location'}</td><td class="result-cell">${quietStatus(w.packs.onboarding)}</td><td class="result-cell">${quietStatus(w.packs.healthcare)}</td><td class="result-cell">${quietStatus(w.packs.immigration)}</td><td class="result-cell">${quietStatus(w.packs.payroll)}</td><td class="result-cell">${quietStatus(w.overall)}</td><td class="open-cell">${openOf(w) ? h`<b>${openOf(w)}</b>` : h`<span class="muted">0</span>`}</td><td class="${w.readiness === 'blocked' ? 'text-fail' : 'muted'}">${words(w.readiness)}</td></tr>`), ['No workers yet', 'Add a worker, import a roster, or connect your HR system under Connections.']));
  },
  async evidence() {
    scope(null);
    const [list, ctl] = await Promise.all([api('/api/evidence'), api('/api/controls')]);
    // Waiting for a person first, then rejected, then everything else (newest first within each group).
    const order = { needs_review: 0, rejected: 1 };
    const rows = list.sort((a, b) => (order[a.status] ?? 2) - (order[b.status] ?? 2));
    const controls = Object.fromEntries(ctl.controls.map((c) => [c.key, c]));
    const ev = rows.find((e) => e.id === evidenceSel) || rows.find((e) => e.status === 'needs_review') || null;
    const waiting = rows.filter((e) => e.status === 'needs_review').length;
    return h`<div class="bottom-split-row evidence-layout"><div class="split-card"><div class="split-card-header"><div><h3 class="split-title">Evidence inbox</h3><p class="muted small">${rows.length} document${rows.length === 1 ? '' : 's'}${waiting ? ` · ${waiting} waiting for review` : ''}</p></div></div>${table(['Document', 'Subject', 'Confidence', 'Status'], rows.map((e) => h`<tr class="click${e.id === ev?.id ? ' selected' : ''}" data-act="selectEvidence" data-id="${e.id}"><td><button class="row-title" data-act="selectEvidence" data-id="${e.id}">${words(e.doc_type)}</button><div class="muted small">${e.filename}</div></td><td class="text-secondary">${e.subject_name}</td><td>${e.source === 'demo_seed' ? '—' : `${Math.round((e.confidence || 0) * 100)}%`}</td><td>${statePill(e.status)}</td></tr>`), ['No evidence yet', 'Documents appear here when workers send them or you upload them.'])}</div>
    ${ev ? evidencePanel(ev, controls) : h`<aside class="split-card inspector" aria-label="Document details"><div class="inspector-head"><h3 class="split-title">Document details</h3></div><div class="inspector-body">${emptyState(['Pick a document', 'Its details and what Aegis read from it show here.'])}</div></aside>`}</div>`;
  },
  async packs() {
    scope(null);
    const rows = await api('/api/packs');
    return h`<div class="grid-2">${rows.map((p) => h`<div class="plain-card"><div class="between"><strong class="pack-title">${packIcon(p.key)}${p.name}</strong>${p.status === 'active' ? modePill(p.mode) : h`<span class="pill pill-na">Not active</span>`}</div><p class="muted small mt">${p.description}</p><p class="small mt"><span class="version-tag">v${p.version}${p.pilot ? ' pilot' : ''}</span> · ${p.controls.length} controls · Owner: ${p.owner || 'not assigned'}</p>
    ${p.status === 'active' ? h`<p class="small mt">${p.pass} pass · ${p.fail} fail · ${p.unknown} unknown · ${p.unvalidated ? `${p.unvalidated} finding${p.unvalidated === 1 ? '' : 's'} to review` : 'No findings to review'}</p>` : ''}<div class="row mt"><button class="btn-card-outline" data-act="reviewPack" data-id="${p.key}">${p.status === 'active' ? 'View controls' : 'Review & activate'}</button>${p.status === 'active' ? (p.mode === 'shadow' ? h`<button class="btn-submit-green" data-act="packMode" data-id="${p.key}" data-m="auto">Enable automatic requests</button>` : h`<button class="btn-card-outline" data-act="packMode" data-id="${p.key}" data-m="shadow">Return to validation mode</button>`) : ''}</div></div>`)}</div>`;
  },
  async controls() {
    scope(null);
    const d = await api('/api/controls');
    return h`<div class="stack">${card('Natural Language Rule Drafter', 'Aegis drafts the change and previews it. Nothing takes effect until it is approved.', h`<form class="row" data-form="draftRule"><input name="text" class="form-select" style="flex:1;min-width:220px" required placeholder="Request renewals 30 days before expiration and escalate after two unanswered reminders." aria-label="Rule"><button class="btn-submit-green">Draft & preview</button></form>${lastDraft ? lastDraft.map(draftCard) : ''}`)}
    ${card('Active Controls', 'Reviewed pack requirements stay separate from customer overrides.', table(['Control', 'Pack', 'Requirement', 'Schedule', 'Version', 'Source'], d.controls.map((c) => h`<tr><td><strong>${c.name}</strong><div class="mono muted">${c.key}</div></td><td><span class="priority-pill pill-low">${c.pack}</span></td><td class="muted">${words(c.requirement_type)}</td><td class="small">${c.remediation?.request_days_before !== undefined ? `${c.remediation.request_days_before}d before expiry; ` : ''}${c.remediation?.max_reminders !== undefined ? `escalate after ${c.remediation.max_reminders}` : 'owner task'}</td><td class="mono">${c.version}</td><td>${c.custom ? h`<span class="pill pill-blue">Custom</span>` : c.overridden ? h`<span class="pill pill-warn">Override</span>` : h`<span class="pill pill-na">Pack</span>`}</td></tr>`), ['No active controls', 'Activate a compliance pack to see its rules here.']))}
    ${card('Change History', 'Drafts, approvals and superseded versions.', table(['Change', 'Control', 'Request', 'Status', 'By'], d.changes.map((c) => h`<tr><td>${c.kind}</td><td class="mono">${c.control_key}</td><td class="small">${c.source_text}</td><td>${statePill(c.status)}</td><td class="muted">${c.created_by}${c.approved_by ? ` → ${c.approved_by}` : ''}</td></tr>`), ['No rule changes yet', 'Drafted and approved changes to rules are listed here.']))}</div>`;
  },
  async integrations() {
    const [health, messages, connections] = await Promise.all([api('/api/health'), api('/api/messages'), api('/api/integrations')]);
    const failures = [
      ...health.connectors.filter((c) => c.last_error).map((c) => ['HRMS', c.name, c.last_error]),
      ...health.jobs.dead.map((job) => ['Job', words(job.type), job.last_error]),
      ...health.failed_actions.map((action) => ['Message', action.recipient, action.error]),
    ];
    if (health.ai_error) failures.push(['AI', 'AI engine', health.ai_error.message]);
    return h`<div class="stack">
      ${me.sandbox ? h`<p class="alert-box">The sandbox uses the sample HRMS and records messages in the local outbox.</p>` : ''}
      <div class="grid-2">${hrmsCard(health.connectors)}${slackCard(connections.slack)}</div>
      ${card('Failures', 'Review failed jobs, deliveries and connections.', table(['Type', 'Item', 'Error'], failures.map(([kind, item, error]) => h`<tr><td>${kind}</td><td>${item}</td><td>${error}</td></tr>`), ['Everything is running', 'Failed syncs, messages or background jobs would show up here.']))}
      ${card('Message Outbox', 'Delivery status and secure worker links.', table(['When', 'To', 'Subject', 'Delivery', ''], messages.map(outboxRow), ['No messages yet', 'Every message Aegis sends is kept here, including ones held in the outbox.']))}
    </div>`;
  },
  async dashboards(arg) {
    scope(null);
    if (arg) return dashboardDetail(await api(`/api/dashboards/${arg}`));
    const list = await api('/api/dashboards');
    const built = list.filter((d) => d.built_in), saved = list.filter((d) => !d.built_in);
    return h`<div class="stack">
      <section aria-labelledby="stdViews"><h2 class="section-title" id="stdViews">Standard views</h2><div class="card-grid">${built.map(dashCard)}</div></section>
      <section aria-labelledby="savedViews"><h2 class="section-title" id="savedViews">Saved views</h2>${saved.length ? h`<div class="card-grid">${saved.map(dashCard)}</div>` : emptyState(['No saved views', canEdit() ? 'Use New view to count gaps, missing documents or expiring credentials your way.' : 'Views your team saves appear here.'])}</section>
    </div>`;
  },
  async reports(arg) {
    if (arg) { scope(null); return reportDetail(await api(`/api/reports/${arg}/data`)); }
    const o = await api('/api/overview'); scope(o.coverage);
    const digest = me.user.is_admin ? await api('/api/digest').catch((e) => ({ error: e.status === 404 ? 'The server needs a restart to show the digest.' : e.message })) : null;
    const all = o.packs.reduce((a, p) => ({ pass: a.pass + p.pass, fail: a.fail + p.fail, unknown: a.unknown + p.unknown, total: a.total + p.total }), { pass: 0, fail: 0, unknown: 0, total: 0 });
    return h`<div class="stack">
      <section class="report-all" aria-labelledby="allReport">
        <div class="report-all-main"><h2 id="allReport">All activated packs</h2><p>${plural(o.packs.length, 'pack')}, ${plural(all.total, 'applicable check')}</p></div>
        <div class="report-all-figure"><b>${pct(all)}%</b><span>${all.pass} of ${all.total} pass</span>${passBar(all)}</div>
        <div class="view-card-actions"><a class="btn-card-outline" href="#reports/all">Open report</a><a class="btn-link-action" href="/api/reports/all" download>Download CSV</a></div>
      </section>
      <section aria-labelledby="packReports"><h2 class="section-title" id="packReports">By pack</h2><div class="card-grid card-grid-4">${o.packs.map(reportCard)}</div></section>
      ${digest ? digestPanel(digest) : ''}
    </div>`;
  },
  async notices() {
    scope(null);
    if (!canFinance()) return card('Finance only', 'Ask an administrator for access.', '');
    const list = await api('/api/notices');
    const waiting = list.filter((n) => n.status === 'draft_awaiting_approval').length;
    return card('Notices', waiting ? `${plural(waiting, 'reply', 'replies')} waiting for Finance` : list.length ? 'Nothing waiting' : 'Log a notice when a letter arrives from a tax agency.', table(['Notice', 'Received', 'Respond by', 'Status', ''], list.map((n) => h`<tr class="click" data-act="viewNotice" data-id="${n.id}"><td><button class="row-title" data-act="viewNotice" data-id="${n.id}">${n.agency}: ${n.notice_type}</button><div class="case-sub">${n.summary}</div></td><td class="nowrap">${date(n.received_on)}</td><td class="nowrap">${date(n.response_due)}${n.status !== 'response_approved' ? dueNote(n.response_due, true) : ''}</td><td><span class="pill ${NOTICE_PILL[n.status] || 'pill-blue'}">${NOTICE_LABEL[n.status] || words(n.status)}</span></td><td class="row-action"><button class="btn-link-action" data-act="viewNotice" data-id="${n.id}">Open</button></td></tr>`), ['No notices yet', 'Aegis drafts a reply for each one and sends it to Approvals.']));
  },
  async metrics() {
    scope(null);
    const m = await api('/api/metrics');
    const tools = h`<div class="panel-tools">${canEdit() ? h`<button class="btn-link-action" data-act="logSupport">Log support time</button>` : ''}${me.user.is_admin ? h`<button class="btn-card-outline" data-act="editBaseline">Edit baseline</button>` : ''}</div>`;
    // status: good (green), watch (amber), problem (red), brand for the headline benefit, or none.
    const STATUS = { good: 'Good', watch: 'Watch', problem: 'Needs attention' };
    const fig = (label, value, note, status, statusText) => h`<div class="metric is-${value === null ? 'empty' : status || 'plain'}"><dt>${label}</dt><dd>${value === null ? 'Not measured' : value}</dd>${value !== null && status && status !== 'brand' ? h`<span class="metric-status"><i></i>${statusText || STATUS[status]}</span>` : ''}<p>${note}</p></div>`;
    const rate = m.findings_reviewed ? Math.round(m.false_findings / m.findings_reviewed * 100) : null;
    const dl = h`<dl class="report-figures metric-figures">
        ${fig('Hours saved', m.hours_saved === null ? null : hoursText(m.hours_saved), m.minutes_per_chase === null ? 'Set how long one manual chase takes to measure this.' : `${plural(m.automated_messages, 'automated message')} at ${m.minutes_per_chase} min each`, 'brand')}
        ${fig('Time to verified closure', m.median_closure_hours === null ? null : hoursText(m.median_closure_hours), m.verified_closures ? `Median of ${plural(m.verified_closures, 'case')} closed with accepted evidence` : 'Measured once a case closes with accepted evidence.')}
        ${fig('False findings', rate === null ? null : `${rate}%`, m.findings_reviewed ? `${m.false_findings} of ${plural(m.findings_reviewed, 'finding')} owners reviewed` : 'Measured once owners review findings.', rate === 0 ? 'good' : rate <= 10 ? 'watch' : 'problem', rate === 0 ? 'None found false' : rate <= 10 ? 'Watch' : 'Above 10%')}
        ${fig('Unknown results', m.unknown_results, 'Current checks Aegis cannot prove yet', m.unknown_results ? 'watch' : 'good', m.unknown_results ? 'Needs evidence' : 'All provable')}
      </dl>`;
    return h`<div class="stack">
      ${card('Pilot scorecard', 'The measures from the pilot plan, taken from Aegis records.', dl, tools)}
      ${card('Other measures', 'Effort, safety and cost.', table(['Measure', 'Result', 'How it is measured'], [
        ['Closed with accepted evidence', m.verified_closures ? `${m.closures_with_evidence} of ${m.verified_closures}` : 'No verified closures yet', 'Field-based checks rely on the worker record instead of a document'],
        ['Duplicate actions blocked', h`<span class="state-dot is-${m.duplicate_messages_sent ? 'problem' : 'good'}"></span>${m.duplicates_blocked}`, m.duplicate_messages_sent ? h`<span class="text-fail">${plural(m.duplicate_messages_sent, 'duplicate message')} was still sent</span>` : 'No duplicate message has been sent'],
        ['Onboarding effort', m.onboarding_minutes === null ? 'Not measured' : m.onboarding_minutes < 1 ? 'Under 1 min' : hoursText(m.onboarding_minutes / 60), 'From creating the workspace to its first assessment'],
        ['Manual support', `${m.manual_support_minutes} min`, 'Time your team logged helping this workspace'],
        ['AI usage', `${plural(m.llm_calls, 'call')}, ${m.llm_tokens.toLocaleString('en-US')} tokens`, 'Add messaging and hosting costs to get the operating cost'],
      ].map(([a, b, c]) => h`<tr><td><span class="row-title is-static">${a}</span></td><td class="nowrap">${b}</td><td class="small muted">${c}</td></tr>`), ''))}
    </div>`;
  },
  async audit() {
    scope(null);
    if (!me.user.is_admin) return card('Administrators only', 'Ask an administrator for access to the audit history.', '');
    const [res, v] = await Promise.all([api(auditUrl()), api('/api/audit/verify')]);
    audit = { rows: res.rows, more: res.has_more, total: res.total };
    const kinds = [['', 'All'], ['checks', 'Checks'], ['cases', 'Cases'], ['evidence', 'Evidence'], ['approvals', 'Approvals'], ['messages', 'Messages'], ['records', 'Workers'], ['settings', 'Setup']];
    return h`<div class="stack">
      <div class="panel chain-panel ${v.ok ? 'is-ok' : 'is-broken'}" role="${v.ok ? 'status' : 'alert'}">
        <span class="chain-icon" aria-hidden="true">${raw(v.ok ? '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/></svg>' : '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>')}</span>
        <div><b>${v.ok ? 'The record is intact' : `The record was changed at entry ${v.broken_at_seq}`}</b><p>${v.ok ? `All ${v.entries.toLocaleString('en-US')} entries are linked in order and unchanged since they were written.` : 'Entries from that point may have been altered outside Aegis. Export the log and contact support.'}</p></div>
        <a class="btn-card-outline" href="/api/audit/export" download>Export JSON</a>
      </div>
      <div class="panel">
        <div class="audit-filters">
          <div class="chip-row" role="group" aria-label="Kind of event">${kinds.map(([k, l]) => h`<button class="chip${auditFilter.kind === k ? ' on' : ''}" data-act="auditKind" data-k="${k}" aria-pressed="${auditFilter.kind === k}">${k ? h`<i class="kind-dot kind-${k}" aria-hidden="true"></i>` : ''}${l}</button>`)}</div>
          <div class="audit-fields">
            <input class="form-select" type="search" placeholder="Person, subject or detail" aria-label="Search the audit history" value="${auditFilter.q}" data-audit-field="q">
            <label class="audit-date"><span>From</span><input class="form-select" type="date" value="${auditFilter.from}" data-audit-field="from"></label>
            <label class="audit-date"><span>To</span><input class="form-select" type="date" value="${auditFilter.to}" data-audit-field="to"></label>
          </div>
        </div>
        <div id="auditList">${auditList()}</div>
      </div>
    </div>`;
  },
  async settings() {
    scope(null);
    if (!me.user.is_admin) return h`<div class="plain-card empty">Settings are available to administrators.</div>`;
    const users = await api('/api/users'), hl = await api('/api/health'), ai = await api('/api/ai');
    return h`<div class="stack">${card('AI Engine', 'Reads photos and scanned documents, and helps chat understand free-form questions. It cannot accept evidence or set a result.', h`${ai.last_error ? h`<div class="alert-box"><strong>Last AI problem:</strong> ${ai.last_error.message}</div>` : ''}${ai.configured ? h`<dl class="kv mb"><dt>Status</dt><dd><span class="pill pill-pass">Connected</span></dd><dt>Provider</dt><dd>${ai.provider_label} (${ai.model})</dd><dt>Key</dt><dd class="mono">${ai.key_hint}</dd><dt>Set from</dt><dd>${ai.source}${ai.approved_by ? ` · approved by ${ai.approved_by}` : ''}</dd><dt>Scanned PDFs</dt><dd>${ai.reads_scanned_pdf ? 'Supported' : 'Not supported by this provider. They go to human review.'}</dd></dl><div class="row mb"><button class="btn-card-outline" data-act="aiTest">Test connection</button>${ai.source === 'settings' ? h`<button class="btn-danger" data-act="aiRemove">Remove key</button>` : ''}</div>` : ''}<form data-form="aiKey"><div class="form-grid"><div class="form-group"><label class="form-label">Provider</label><select name="provider" class="form-select">${ai.providers.slice().sort((a) => (a.key === 'deepseek' ? -1 : 1)).map((p) => h`<option value="${p.key}" ${(ai.provider || 'deepseek') === p.key ? raw('selected') : ''}>${p.label}</option>`)}</select></div><div class="form-group"><label class="form-label">API key</label><input name="api_key" type="password" class="form-select" autocomplete="off" required placeholder="${ai.configured ? 'Paste a new key to replace it' : 'Paste your key'}"></div></div><label class="row small mb"><input type="checkbox" name="approved" required> Our compliance owner approved sending worker documents to this provider.</label><button class="btn-submit-green">Test & save</button></form>`)}
    ${card('Users & Roles', 'Roles limit which packs a person can act on. Immigration records are restricted.', table(['Name', 'Email', 'Role', 'Slack ID'], users.map((u) => h`<tr><td><strong>${u.name}</strong></td><td>${u.email}</td><td>${words(u.role)}</td><td class="mono">${u.slack_id}</td></tr>`), ''))}
    <form class="plain-card" data-form="user"><strong>Add user</strong><div class="form-grid mt"><div class="form-group"><label class="form-label">Name</label><input name="name" class="form-select" required></div><div class="form-group"><label class="form-label">Email</label><input name="email" type="email" class="form-select" required></div><div class="form-group"><label class="form-label">Role</label><select name="role" class="form-select"><option>hr</option><option>healthcare_compliance</option><option>immigration_owner</option><option>finance</option><option>viewer</option><option>admin</option></select></div><div class="form-group"><label class="form-label">Temporary password</label><input name="password" type="password" minlength="8" class="form-select" required></div></div><button class="btn-submit-green">Add user</button></form>
    ${card('Schedules', 'Checks run daily. Reminders run on each control’s cadence.', table(['Job', 'Cadence', 'Next run'], hl.schedules.map((s) => h`<tr><td>${s.kind}</td><td>${s.cadence}</td><td class="mono">${dt(s.next_run_at)}</td></tr>`), ['No schedules', 'Daily checks and digests appear here once set up.']))}</div>`;
  },
};

function hrmsCard(connectors) {
  return card('Workforce records', 'Connect an HRMS or import your roster from Excel or CSV.', h`<div class="plain-card stack">
    ${connectors.map((c) => h`<div class="tile">
      <div class="between"><strong>${c.name}</strong>${statePill(c.status)}</div>
      <p class="muted small mt">Last sync ${dt(c.last_sync_at)} · ${c.records} records processed</p>
      <div class="row mt">
        ${c.status !== 'disabled' ? h`<button class="btn-card-outline" data-act="syncConnector" data-id="${c.id}">Sync now</button>` : ''}
        ${!me.sandbox ? h`<button class="btn-card-outline" data-act="testConnector" data-id="${c.id}">Test connection</button>
          <button class="btn-card-outline" data-act="editConnector" data-id="${c.id}">Edit settings</button>
          <button class="btn-card-outline" data-act="toggleConnector" data-id="${c.id}" data-next="${c.status === 'disabled' ? 'enable' : 'disable'}">${c.status === 'disabled' ? 'Enable' : 'Disable'}</button>` : ''}
      </div>
    </div>`)}
    <div class="row"><button class="btn-card-outline" data-act="importRoster">Upload roster</button>
      ${!me.sandbox ? h`<button class="btn-submit-green" data-act="addConnector">Add HRMS connection</button>` : ''}
    </div>
  </div>`);
}

function slackCard(slack) {
  const receiving = slack.receiving;
  const chat = receiving?.mode === 'socket' ? `Socket Mode · ${receiving.state}`
    : receiving?.mode === 'events_url' ? 'Events URL' : 'Off';
  return card('Slack', 'Send alerts and digests and ask the coworker questions in Slack.', h`<div class="plain-card stack">
    ${slack.connected ? h`<dl class="kv"><dt>Workspace</dt><dd>${slack.workspace || 'Configured on server'}</dd>
      <dt>Alerts channel</dt><dd>${slack.channel || 'Not selected'}</dd><dt>Incoming chat</dt><dd>${chat}</dd></dl>
      ${receiving?.error ? h`<p class="alert-box">${receiving.error}</p>` : ''}` : h`<p>Slack is disconnected. Reporting messages stay in the outbox.</p>`}
    ${!me.sandbox ? h`<div class="row">
      <button class="btn-submit-green" data-act="slackConfig" data-channel="${slack.channel || '#compliance-alerts'}" data-replace="${slack.source === 'settings' ? 'yes' : ''}">${slack.connected ? 'Update Slack connection' : 'Connect Slack'}</button>
      ${slack.connected ? h`<button class="btn-card-outline" data-act="slackTest">Send test message</button>` : ''}
      ${slack.source === 'settings' ? h`<button class="btn-card-outline" data-act="slackDisconnect">Disconnect</button>` : ''}
    </div>` : ''}
  </div>`);
}

function outboxRow(message) {
  const token = /\/submit\/([\w-]+)/.exec(message.body)?.[1];
  const body = message.body.replace(/https?:\/\/\S+/g, '[link]').slice(0, 130);
  return h`<tr><td class="mono">${dt(message.created_at)}</td><td><strong>${message.recipient}</strong></td>
    <td>${message.subject}<div class="muted small">${body}</div></td>
    <td>${message.channel === 'outbox' ? 'Outbox only' : `${words(message.status)} · ${message.channel}`}</td>
    <td>${token ? h`<a class="btn-link-action" href="/submit/${token}" target="_blank" rel="noopener">Open link</a>` : ''}</td></tr>`;
}

function connectorDialog(connector) {
  const { base_url = '', path = '/workers', has_api_key, has_password, username, ...advanced } = connector?.settings || {};
  openModal(connector ? 'Edit HRMS connection' : 'Add HRMS connection', 'Test the mapping before synchronizing workforce records.',
    h`<form class="stack" data-form="connector" data-id="${connector?.id}">
      <label>Connection name<input class="form-select" name="name" value="${connector?.name || 'Bluebix HRMS'}" required></label>
      <label>API base URL<input class="form-select" name="base_url" value="${base_url}" placeholder="https://hrms.example.com/api" required></label>
      <label>Worker list path<input class="form-select" name="path" value="${path}" required></label>
      <label>API key<input class="form-select" name="api_key" type="password" autocomplete="new-password" placeholder="${has_api_key ? 'Leave blank to keep the saved key' : 'Bearer token or header key'}"></label>
      <details><summary>Authentication and mapping settings</summary>
        <label class="mt">Basic authentication username<input class="form-select" name="username" value="${username}"></label>
        <label class="mt">Basic authentication password<input class="form-select" name="password" type="password" autocomplete="new-password" placeholder="${has_password ? 'Leave blank to keep the saved password' : 'Optional'}"></label>
        <label class="mt">Additional settings JSON<textarea class="form-select mono" name="options" rows="6" placeholder='{"auth_type":"header","auth_header":"X-API-Key","field_map":{"name":"displayName"}}'>${Object.keys(advanced).length ? JSON.stringify(advanced, null, 2) : ''}</textarea></label>
        <p class="muted small">Use the fields above for credentials. Set authentication type, pagination and field mapping here.</p>
      </details>
      <div data-connector-result role="status"></div>
      <div class="row"><button class="btn-card-outline" type="submit" value="test">Test mapping</button><button class="btn-submit-green" type="submit" value="save">Test and save</button></div>
    </form>`);
}

function mappingPreview(result) {
  if (!result.ok) throw new Error(result.error || 'The HRMS did not return worker records.');
  return h`<div class="tile">
    <p>${result.records_on_first_page} records read from the first page.</p>
    ${result.fields_never_found?.length ? h`<p>Fields not found: ${result.fields_never_found.join(', ')}.</p>` : ''}
    ${table(['Name', 'Role', 'Work location', 'Mapping issue'], (result.sample || []).map((w) => h`<tr><td>${w.name}</td><td>${w.role}</td><td>${w.facility}</td><td>${w.problem}</td></tr>`), 'No sample rows.')}
  </div>`;
}
const modePill = (m) => m === 'auto' ? h`<span class="pill pill-pass">Automatic requests</span>` : h`<span class="pill pill-warn">Validation only</span>`;
function draftCard(d) {
  const p = d.preview;
  return h`<div class="tile mt"><div class="between"><strong>${p.control}</strong><button class="btn-submit-green" data-act="submitDraft" data-id="${d.id}">Submit for approval</button></div><p class="small mt"><strong>${p.would_act}</strong> of ${p.applicable} applicable records would be acted on. ${p.schedule}.</p><p class="small muted">Message: ${p.sample_message}</p><div class="small mt">${p.rows.filter((r) => r.would_act).slice(0, 6).map((r) => h`<div>${statusPill(r.status)} ${r.name}: ${r.reason}</div>`)}</div></div>`;
}
// The right-hand panel on Evidence. It fits the screen and scrolls on its own; for a document
// waiting for review, Accept and Reject stay pinned at the bottom.
const EV_FIELDS = [['holder_name', 'Name on document'], ['doc_number', 'Document number'], ['issued_on', 'Issued', 'date'], ['expires_on', 'Expires', 'date'], ['state', 'State'], ['period', 'Period'], ['entity_name', 'Company']];
function evidencePanel(e, controls = {}) {
  const pending = e.can_review;
  const conf = (k) => e.field_confidence[k] ? h` <span class="conf">${Math.round(e.field_confidence[k] * 100)}%</span>` : '';
  const ctl = controls[e.control_key];
  const requirement = ctl ? `${ctl.name} · ${words(ctl.pack)}` : e.control_key ? words(e.control_key) : 'Not matched yet';
  const reasons = e.review_reasons.length ? h`<div class="why-box"><strong>Why this needs a person</strong><ul>${e.review_reasons.map((r) => h`<li>${r}</li>`)}</ul></div>` : '';
  const facts = h`<dl class="kv ev-facts"><dt>File</dt><dd>${e.filename}${e.has_file ? h` · <a class="btn-link-action" href="/api/evidence/${e.id}/file">Download</a>` : ''}</dd><dt>For</dt><dd>${e.subject_name}</dd><dt>Requirement</dt><dd>${requirement}</dd><dt>Source</dt><dd>${words(e.source)}</dd>${e.reviewed_by ? h`<dt>Reviewed by</dt><dd>${e.reviewed_by}</dd>` : ''}${e.reject_reason ? h`<dt>Rejected because</dt><dd>${e.reject_reason}</dd>` : ''}</dl>`;
  const head = h`<div class="inspector-head"><div><h3 class="split-title">${words(e.doc_type)}</h3><p class="muted small">${e.subject_name}</p></div>${statePill(e.status)}</div>`;
  if (!pending) {
    // Finished documents: plain read-only details, no empty boxes.
    const read = EV_FIELDS.filter(([k]) => e[k]);
    return h`<aside class="split-card inspector" aria-label="Document details">${head}<div class="inspector-body">${reasons}${facts}
      <h4 class="inspector-sub">What the document says</h4>
      ${read.length ? h`<dl class="kv ev-read">${read.map(([k, l, t]) => h`<dt>${l}</dt><dd>${t === 'date' ? date(e[k]) : e[k]}${conf(k)}</dd>`)}</dl>` : h`<p class="muted small">No details were read from this document.</p>`}
    </div></aside>`;
  }
  const f = ([k, l, type = 'text']) => h`<div class="form-group"><label class="form-label" for="evidence-${k}">${l}${conf(k)}</label><input id="evidence-${k}" name="${k}" type="${type}" class="form-select" value="${e[k] || ''}"></div>`;
  return h`<aside class="split-card inspector" aria-label="Review document">${head}
    <form class="inspector-form" data-form="reviewEvidence" data-id="${e.id}">
      <div class="inspector-body">${reasons}${facts}
        <h4 class="inspector-sub">What the document says</h4>
        <p class="muted small">Correct anything Aegis read wrongly. The percentage shows how sure Aegis was.</p>
        ${e.doc_type === 'unknown' ? h`<div class="form-group"><label class="form-label" for="evidence-type">Document type</label><select id="evidence-type" name="doc_type" class="form-select" required><option value="">Choose a type</option>${['professional_license', 'bls_card', 'acls_card', 'tb_screening', 'flu_vaccine', 'facility_orientation', 'handbook_ack', 'security_training', 'i9_record', 'work_authorization', 'w4', 'payroll_filing_receipt'].map((x) => h`<option value="${x}">${words(x)}</option>`)}</select></div>` : ''}
        <div class="form-grid">${EV_FIELDS.map(f)}</div>
        <div class="form-group"><label class="form-label" for="evidence-rejection-reason">Reason, if you reject it</label><input id="evidence-rejection-reason" name="reason" class="form-select" placeholder="Required to reject. The sender sees this."></div>
      </div>
      <div class="inspector-foot"><p class="muted small">Accepting records the document. Aegis reruns the check. The case closes if it passes.</p><div class="row"><button class="btn-danger" name="decision" value="reject" formnovalidate>Reject</button><button class="btn-submit-green" name="decision" value="accept">Accept evidence</button></div></div>
    </form></aside>`;
}
const LIFE = [['Identify', ['identified']], ['Assign', ['assigned']], ['Request', ['requested']], ['Follow up', ['following_up']], ['Review', ['in_review']], ['Re-evaluate', ['reevaluating']], ['Close', ['closed']]];
const lifecycle = (s) => { const i = LIFE.findIndex(([, a]) => a.includes(s)); return h`<div class="lifecycle">${LIFE.map(([l], n) => h`<div class="${n < i ? 'done' : n === i ? 'now' : ''}">${l}</div>`)}</div>`; };
function closeAllDirMenus(except) {
  document.querySelectorAll('.dir.open').forEach((d) => {
    if (d !== except) {
      d.classList.remove('open');
      const btn = d.previousElementSibling;
      if (btn && btn.setAttribute) btn.setAttribute('aria-expanded', 'false');
    }
  });
}

function renderDemoRack() {
  const rackEl = $('#rack');
  if (!rackEl) return;
  rackEl.innerHTML = PERSONAS.map((p, i) => `
    <div class="peg" style="--c:${p.color};--i:${i}">
      <span class="s"></span>
      <button class="mini" type="button" data-persona-idx="${i}">
        <span class="mb">${p.name}<small>${p.email}</small></span>
        <span class="md" style="display:block">${p.desc}</span>
        <span class="zones" style="display:block"><span class="zgrid" style="display:grid">${renderZonesHtml(p.z)}</span></span>
        <span class="go">Sign in as ${p.short}</span>
      </button>
    </div>
  `).join('');
}

async function selectPersonaInWorkspace(p) {
  if (!demoEnabled) return;
  closeDemoRack();
  toast(`Switching to ${p.name} (${p.roleName})…`, 'info');
  try {
    await api('/api/login', { email: p.email, password: demoPassword });
    location.reload();
  } catch (err) {
    toast(err.message || 'Failed to switch demo account', 'warning');
  }
}

const ACT = {
  toggleMenu: () => $('#sheet')?.classList.toggle('open'),
  openDemoRack: () => { renderDemoRack(); openDemoRack(); },
  closeDemoRack: () => { closeDemoRack(); },
  navDirect: (el) => {
    closeAllDirMenus();
    const id = el.dataset.id;
    if (id) {
      location.hash = '#' + id;
      go(id);
    }
  },
  toggleDir: (el, ev) => {
    ev?.stopPropagation();
    const btn = el.closest('.tab') || el;
    const wrap = btn.closest('.tabwrap');
    const dir = wrap?.querySelector('.dir');
    if (dir) {
      const wasOpen = dir.classList.contains('open');
      closeAllDirMenus();
      if (!wasOpen) {
        dir.classList.add('open');
        btn.setAttribute('aria-expanded', 'true');
      }
    }
  },
  dirLink: (el) => {
    closeAllDirMenus();
    $('#sheet')?.classList.remove('open');
    const href = el.getAttribute('href') || el.closest('a')?.getAttribute('href');
    if (href && href.startsWith('#') && href.length > 1) {
      const [r, a] = href.slice(1).split('/');
      location.hash = href;
      go(VIEWS[r] ? r : 'overview', a || null);
    }
  },
  closeModal, openChat: () => { $('#chatDrawer').classList.add('open'); loadChat(); setTimeout(() => $('#chatDrawer [name="text"]')?.focus(), 120); }, closeChat: () => closeChat(),
  async logout() { await api('/api/logout', {}); location.hash = ''; location.reload(); },
  prompt: (el) => { $('#chatDrawer').classList.add('open'); sendChat(el.dataset.q); },
  async caseDetail(el) {
    const version = navigation;
    const c = await api(`/api/cases/${el.dataset.id}`), e = c.evaluation, open = !c.closed_at;
    if (version !== navigation) return;
    // History: audit entries and notes in one timeline, oldest first. Note entries in the audit log are shown once, as notes.
    const history = [...c.timeline.filter((t) => t.type !== 'CASE_NOTE').map((t) => ({ at: t.ts, text: t.action })), ...c.notes.map((n) => ({ at: n.created_at, who: n.author, text: n.note }))].sort((a, b) => (a.at < b.at ? -1 : 1));
    openModal(`${c.control_name}: ${c.subject_name}`, `${words(c.pack_key)} · Owner ${c.owner_name || c.owner_team || 'not assigned'}`, h`${stepper(c.state)}
    <div class="case-result"><div>${e ? statusPill(e.status) : ''}</div><p>${e?.reason || c.gap || 'No current result.'}</p></div>
    <dl class="kv mb"><dt>Due</dt><dd>${date(c.due_date)} ${dueNote(c.due_date, open)}</dd><dt>Reminders sent</dt><dd>${c.reminders_sent}${c.escalated ? ' · Escalated' : ''}</dd>${c.closure ? h`<dt>How it closed</dt><dd>${words(c.closure)}</dd>` : ''}<dt>Finding</dt><dd>${c.finding_verdict ? `${words(c.finding_verdict)} (${c.verdict_by})` : 'Not reviewed yet'}</dd></dl>
    ${c.evidence.length ? h`<h4 class="detail-heading">Evidence</h4>${c.evidence.map((x) => h`<div class="timeline-item"><span>${statePill(x.status)}</span><span>${x.filename}${x.review_reasons.length ? ` · ${x.review_reasons.join(' ')}` : ''}</span></div>`)}` : ''}
    ${open ? h`<div class="who-uploads"><b>Who sends the document?</b><span>${c.subject_type === 'worker' ? 'Send a follow-up and the worker uploads it from a secure link, no login needed.' : 'Send a follow-up to the owner.'} If you already have the file, upload it yourself.</span></div>` : ''}
    <h4 class="detail-heading">History</h4><div class="history">${history.map((x) => h`<div class="timeline-item${x.who ? ' is-note' : ''}"><time>${dt(x.at)}</time><span>${x.who ? h`<strong>${x.who}:</strong> ` : ''}${x.text}</span></div>`)}</div>
    <details class="tech-details"><summary>Technical details</summary><dl class="kv"><dt>Case ID</dt><dd class="mono">${c.id}</dd><dt>Rule version</dt><dd class="mono">${e?.control_version || '—'}</dd><dt>Evidence used</dt><dd class="mono">${e?.evidence_ids.join(', ') || 'None'}</dd></dl></details>
    ${open && canEdit() ? h`<form class="row mt" data-form="note" data-id="${c.id}"><input name="note" class="form-select" style="flex:1" placeholder="Add a note" required aria-label="Note"><button class="btn-card-outline">Add note</button></form>` : ''}`,
      open && c.can_act ? h`${!c.finding_verdict ? h`<button class="btn-cancel" data-act="verdict" data-id="${c.id}" data-v="false_finding">False finding</button><button class="btn-cancel" data-act="verdict" data-id="${c.id}" data-v="confirmed">Confirm finding</button>` : ''}<button class="btn-cancel" data-act="humanDecision" data-id="${c.id}">Request decision</button><button class="btn-cancel" data-act="uploadEvidence" data-subject="${c.subject_type}:${c.subject_id}" data-control="${c.control_key}" data-name="${c.subject_name}">Upload evidence</button><button class="btn-submit-green" data-act="followUp" data-id="${c.id}">Send follow-up</button>` : '', true);
  },
  async followUp(el, ev) { ev?.stopPropagation(); const r = await api(`/api/cases/${el.dataset.id}/follow-up`, {}); toast(r.message, r.sent ? 'success' : 'warning'); after(); },
  async verdict(el) { await api(`/api/cases/${el.dataset.id}/verdict`, { verdict: el.dataset.v }); toast('Finding recorded.', 'success'); closeModal(); refresh(); },
  async humanDecision(el) { await api(`/api/cases/${el.dataset.id}/decision`, { title: 'Assignment decision', detail: 'Requested from the case.' }); toast('Sent to Approvals.', 'success'); closeModal(); refresh(); },
  chaseAll() {
    const ids = [...document.querySelectorAll('#view tr[data-can-follow-up="true"]:not([hidden])')].map((row) => row.dataset.id);
    if (!ids.length) { toast('No open cases match this view.', 'warning'); return; }
    confirmFollowUps(ids, 'Every open case shown in this view.');
  },
  followUpSelected() {
    if (!caseSel.size) return;
    confirmFollowUps([...caseSel], 'Only the cases you ticked.');
  },
  clearCaseSelection() { clearCaseSelection(); },
  async confirmChaseAll(el) {
    el.disabled = true;
    try {
      const result = await api('/api/cases/chase-all', { case_ids: JSON.parse(el.dataset.ids) });
      closeModal();
      const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
      toast(`${plural(result.sent, 'follow-up')} queued${result.skipped ? ` · ${result.skipped} skipped` : ''}.`, result.sent ? 'success' : 'warning');
      clearCaseSelection();
      after();
    } finally { el.disabled = false; }
  },
  async decide(el) { await api(`/api/approvals/${el.dataset.id}/decide`, { decision: el.dataset.d }); toast(`Marked ${el.dataset.d}.`, 'success'); after(); },
  caseTab(el) { caseClosed = !!el.dataset.v; caseSel.clear(); refresh(); },
  checkFilter(el) { checkFilter[el.dataset.k] = el.dataset.v; refresh(); },
  async workerDetail(el, ev) {
    ev?.stopPropagation();
    const w = await api(`/api/workers/${el.dataset.id}`), rv = w.readiness_view;
    // Problems first, then passes. Checks that do not apply are left out.
    const rank = { fail: 0, unknown: 1, pass: 2 };
    const list = w.checks_list.filter((c) => c.status !== 'not_applicable').sort((a, b) => rank[a.status] - rank[b.status]);
    const openN = list.filter((c) => c.status !== 'pass').length;
    openModal(w.name, `${w.role || 'No role'} · ${w.facility || 'No confirmed location'}`, h`<div class="pack-boxes">${rv.summary.map((s) => h`<div class="pack-box pack-box-${s.status}"><span>${words(s.pack)}</span>${statusPill(s.status)}<small>${s.open ? `${s.open} open` : s.status === 'restricted' ? 'Restricted' : 'Nothing open'}</small></div>`)}</div>
      <div class="readiness-note ${openN || !list.length ? 'is-open' : 'is-clear'}"><b>${!list.length ? 'No applicable checks yet' : openN ? `${openN} of ${list.length} visible checks still open` : 'All visible checks pass'}</b><span>${rv.statement}${w.readiness_request ? ` Waiting in Approvals since ${date(w.readiness_request.created_at)}, asked by ${w.readiness_request.requested_by}.` : ''}</span></div>
      ${table(['Requirement', 'Result', 'Why', ''], list.map((c) => h`<tr><td>${c.control_name}<div class="case-sub">${words(c.pack_key)}</div></td><td>${statusPill(c.status)}</td><td class="small">${c.reason}</td><td class="row-action">${canEdit() && (c.status !== 'pass' || /expir/.test(c.code || '')) ? h`<button class="btn-link-action" data-act="uploadEvidence" data-subject="worker:${w.id}" data-control="${c.control_key}" data-name="${w.name}">Upload</button>` : ''}</td></tr>`), 'No checks yet.')}`, workerFoot(w, openN, list.length), true);
  },
  moveWorker(el) { openModal('Change assignment', 'Aegis re-runs the checks that apply to the new location.', h`<form data-form="move" data-id="${el.dataset.id}"><div class="form-group"><label class="form-label">Facility</label><input name="facility" class="form-select" required></div><div class="form-group"><label class="form-label">State</label><input name="facility_state" class="form-select" maxlength="2"></div><button class="btn-submit-green">Save</button></form>`); },
  openApprovals() { closeModal(); location.hash = 'approvals'; },
  // With checks still open, ask once more and show what the approver will see.
  async readiness(el) {
    if (+el.dataset.open > 0 && !el.dataset.confirmed) {
      const w = await api(`/api/workers/${el.dataset.id}`);
      const open = w.checks_list.filter((c) => c.status !== 'pass' && c.status !== 'not_applicable');
      const n = open.length, checks = `${n} open check${n === 1 ? '' : 's'}`;
      openModal(n ? `${w.name} still has ${checks}` : `No checks have run for ${w.name} yet`, 'You can still ask, for example when a renewal is already booked. The approver sees this.', n ? h`<ul class="open-list">${open.map((c) => h`<li>${statusPill(c.status)}<div><b>${c.control_name}</b><span>${c.reason}</span></div></li>`)}</ul>` : h`<p class="small">Aegis has nothing to show the approver for this person.</p>`,
        h`<button class="btn-cancel" data-act="workerDetail" data-id="${w.id}">Back</button><button class="btn-submit-green" data-act="readiness" data-id="${w.id}" data-confirmed="1">Send to Approvals</button>`);
      return;
    }
    await api(`/api/workers/${el.dataset.id}/readiness-review`, {}); toast('Sent to Approvals.', 'success'); closeModal(); refresh();
  },
  selectEvidence(el, ev) { ev?.stopPropagation(); evidenceSel = el.dataset.id; refresh(); },
  addWorker() { openModal('Add Worker', 'Added workers are checked against activated packs.', h`<form data-form="addWorker"><div class="form-grid"><div class="form-group"><label class="form-label">Full name</label><input name="name" class="form-select" required></div><div class="form-group"><label class="form-label">Email</label><input name="email" type="email" class="form-select"></div><div class="form-group"><label class="form-label">Role</label><input name="role" class="form-select" required></div><div class="form-group"><label class="form-label">Category</label><select name="category" class="form-select"><option value="clinical">Clinical</option><option value="corporate">Corporate</option></select></div><div class="form-group"><label class="form-label">License type</label><select name="license_type" class="form-select"><option value="">None</option><option>RN</option><option>NP</option><option>MD</option><option>PT</option></select></div><div class="form-group"><label class="form-label">Hire date</label><input name="hire_date" type="date" class="form-select" value="${me.today}"></div><div class="form-group"><label class="form-label">Facility</label><input name="facility" class="form-select"></div><div class="form-group"><label class="form-label">State</label><input name="facility_state" maxlength="2" class="form-select"></div><div class="form-group"><label class="form-label">Employing entity</label><input name="entity" class="form-select"></div></div><button class="btn-submit-green">Save worker</button></form>`, null, true); },
  importRoster() { importPreview = null; openModal('Import Worker Roster', 'Excel or CSV. You review the mapping before anything is saved.', h`<form data-form="importFile"><div class="drop-zone-box"><input type="file" name="file" accept=".csv,.xlsx" required aria-label="Roster file"><span class="subtext mt">Columns like Name, Email, Role, Facility, State, License Type, Hire Date</span></div><button class="btn-submit-green mt">Preview import</button></form>`); },
  async commitImport(el) { const r = await api(`/api/import/${el.dataset.id}/commit`, {}); toast(`${r.created} added, ${r.updated} updated.`, 'success'); closeModal(); after(); },
  // Opened from the page header (nothing chosen yet), or from a case or a worker,
  // in which case the person and the requirement are already filled in.
  async uploadEvidence(el, ev) {
    ev?.stopPropagation();
    const pre = el?.dataset || {};
    const [ws, ctl, setup] = await Promise.all([api('/api/workers'), api('/api/controls'), api('/api/setup')]);
    const sel = (on) => (on ? raw('selected') : '');
    openModal(pre.name ? `Upload evidence for ${pre.name}` : 'Upload evidence', 'Upload one file, or several at once. Aegis reads each one and suggests what it is; unclear ones go to a person.', h`<form data-form="upload" class="upload-form">
      <div class="form-grid">
        <div class="form-group"><label class="form-label" for="upSubject">Who is this for</label><select id="upSubject" name="subject" class="form-select" required>${ws.map((w) => h`<option value="worker:${w.id}" ${sel(pre.subject === `worker:${w.id}`)}>${w.name}</option>`)}${setup.entities.map((e) => h`<option value="entity:${e.id}" ${sel(pre.subject === `entity:${e.id}`)}>${e.name} (company)</option>`)}</select></div>
        <div class="form-group"><label class="form-label" for="upControl">Requirement</label><select id="upControl" name="control_key" class="form-select"><option value="">Let Aegis match each file</option>${ctl.controls.filter((c) => c.remediation && c.type !== 'field_required').map((c) => h`<option value="${c.key}" ${sel(pre.control === c.key)}>${words(c.pack)}: ${c.name}</option>`)}</select></div>
      </div>
      <div class="form-group"><span class="form-label">Files</span>
        <label class="upload-drop" data-upload-drop>
          <input type="file" name="file" required multiple data-upload-files aria-describedby="upHint">
          <span class="upload-drop-icon" aria-hidden="true"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4"/><path d="m7 9 5-5 5 5"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/></svg></span>
          <b data-upload-title>Drop files here, or <u>choose files</u></b>
          <span id="upHint" data-upload-count>One file, or select several at once to upload in bulk. PDF or photo.</span>
        </label>
        <ul class="upload-list" data-upload-list hidden></ul>
      </div>
      <div class="form-grid" data-single-only><div class="form-group"><label class="form-label">Document number (optional)</label><input name="doc_number" class="form-select"></div><div class="form-group"><label class="form-label">Expires (optional)</label><input name="expires_on" type="date" class="form-select"></div></div>
      <button class="btn-submit-green" data-upload-go>Upload</button></form>`);
  },
  // Older links may still ask for "bulk upload"; it is the same window now.
  bulkUpload() { return ACT.uploadEvidence(); },
  async reviewPack(el) {
    const [packs, owners] = await Promise.all([api('/api/packs'), api('/api/owners')]), p = packs.find((x) => x.key === el.dataset.id);
    openModal(p.name, `Version ${p.latest_version}`, h`<div class="alert-box">${p.review_note}</div>${table(['Control', 'Type', 'Source'], p.controls.map((c) => h`<tr><td><strong>${c.name}</strong></td><td class="muted">${words(c.requirement_type)}</td><td class="small">${c.source}</td></tr>`), '')}<p class="small mt"><strong>Validation tests:</strong> ${p.validation.filter((v) => v.ok).length} of ${p.validation.length} pass.</p>${me.user.is_admin ? h`<form data-form="activate" data-id="${p.key}" class="mt"><div class="form-group"><label class="form-label">Responsible owner</label><select name="owner_user_id" class="form-select" required>${owners.filter((o) => o.role === 'admin' || o.role === p.owner_role).map((o) => h`<option value="${o.id}" ${(p.owner_user_id ? o.id === p.owner_user_id : o.role === p.owner_role) ? raw('selected') : ''}>${o.name} (${words(o.role)})</option>`)}</select></div><label class="row small"><input type="checkbox" name="reviewed" required> I reviewed applicability, sources and deadlines for this company.</label><button class="btn-submit-green mt">${p.status === 'active' ? 'Update in validation mode' : 'Activate in validation mode'}</button></form>` : ''}`, null, true);
  },
  async packMode(el) { await api(`/api/packs/${el.dataset.id}/mode`, { mode: el.dataset.m }); toast('Pack mode updated.', 'success'); after(); },
  async submitDraft(el) { await api(`/api/controls/${el.dataset.id}/submit`, {}); lastDraft = (lastDraft || []).filter((d) => d.id !== el.dataset.id); toast('Sent to Approvals. It is not active yet.', 'success'); refresh(); },
  facility(el) { openModal(`Requirements: ${el.dataset.name}`, 'These come from the client contract or facility policy.', h`<form data-form="facility" data-id="${el.dataset.id}"><div class="form-group"><label class="form-label">State</label><input name="state" class="form-select" maxlength="2" value="${el.dataset.state}"></div>${[['acls', 'ACLS card'], ['flu_vaccine', 'Flu vaccination'], ['facility_orientation', 'Facility orientation']].map(([k, l]) => h`<label class="row small mb"><input type="checkbox" name="req" value="${k}" ${el.dataset.req.split(',').includes(k) ? raw('checked') : ''}> ${l}</label>`)}<button class="btn-submit-green">Confirm requirements</button></form>`); },
  async confirmContext() { await api('/api/setup/context', {}); toast('Company profile confirmed.', 'success'); refresh(); },
  async assess() { const c = await api('/api/setup/assess', {}); toast(`${c.pass} pass, ${c.fail} fail, ${c.unknown} unknown.`, 'success'); after(); },
  async syncConnector(el) {
    const result = await api(`/api/connectors/${el.dataset.id}/sync`, {});
    toast(`${result.records} records synced. ${result.skipped} skipped.`, result.skipped ? 'warning' : 'success');
    refresh();
  },
  addConnector() { connectorDialog(null); },
  async editConnector(el) {
    const connector = (await api('/api/connectors')).find((c) => c.id === el.dataset.id);
    if (!connector) throw new Error('This HRMS connection is no longer available.');
    connectorDialog(connector);
  },
  async testConnector(el) {
    const result = await api(`/api/connectors/${el.dataset.id}/test`, {});
    openModal('HRMS mapping', 'Sample of the records the connector can read.', mappingPreview(result), null, true);
  },
  async toggleConnector(el) {
    const next = el.dataset.next;
    await api(`/api/connectors/${el.dataset.id}/${next}`, {});
    toast(next === 'enable' ? 'Connection enabled.' : 'Connection disabled.', 'success');
    refresh();
  },
  slackConfig(el) {
    const replace = el.dataset.replace === 'yes';
    openModal(replace ? 'Update Slack connection' : 'Connect Slack', 'Aegis verifies tokens with Slack before saving.',
      h`<form class="stack" data-form="slackConnection">
        <label>Alerts channel<input class="form-select" name="channel" value="${el.dataset.channel}" required></label>
        <label>Bot token<input class="form-select" type="password" name="bot_token" autocomplete="new-password" placeholder="${replace ? 'Leave blank to keep the saved token' : 'xoxb-…'}" ${!replace ? raw('required') : ''}></label>
        <label>App token for Socket Mode<input class="form-select" type="password" name="app_token" autocomplete="new-password" placeholder="xapp-…"></label>
        <label>Signing secret for Events API<input class="form-select" type="password" name="signing_secret" autocomplete="new-password"></label>
        <button class="btn-submit-green">Test and save</button>
      </form>`);
  },
  async slackTest(el) {
    el.disabled = true;
    try {
      const result = await api('/api/integrations/slack/test', {});
      if (!result.ok) throw new Error(result.error || 'Slack test failed.');
      toast(result.posted ? `Test message posted to ${result.channel}.` : 'Slack responded. Select an alerts channel to test delivery.', 'success');
    } finally { el.disabled = false; }
  },
  slackDisconnect() {
    openModal('Disconnect Slack?', 'New reporting messages will go to the Aegis outbox.', '',
      h`<button class="btn-cancel" data-act="closeModal">Cancel</button><button class="btn-danger" data-act="confirmSlackDisconnect">Disconnect</button>`);
  },
  async confirmSlackDisconnect() {
    await api('/api/integrations/slack/remove', {});
    toast('Slack disconnected.', 'success');
    closeModal();
    refresh();
  },
  async aiTest() { const r = await api('/api/ai/test', {}); toast(`${r.provider} is responding.`, 'success'); refresh(); },
  async aiRemove() { await api('/api/ai/remove', {}); toast('AI key removed.', 'success'); refresh(); },
  async sendDigest() {
    const { via } = await api('/api/digest/send', {});
    toast(via === 'slack' ? 'Digest posted.' : 'Digest saved to the outbox.', 'success');
    refresh();
  },
  async viewNotice(el, ev) {
    ev?.stopPropagation();
    const n = (await api('/api/notices')).find((x) => x.id === el.dataset.id);
    if (!n) return;
    const waiting = n.status === 'draft_awaiting_approval';
    openModal(`${n.agency}: ${n.notice_type}`, `Received ${date(n.received_on)}. Respond by ${date(n.response_due)}.`, h`<dl class="kv mb"><dt>Status</dt><dd><span class="pill ${NOTICE_PILL[n.status] || 'pill-blue'}">${NOTICE_LABEL[n.status] || words(n.status)}</span></dd><dt>Summary</dt><dd>${n.summary}</dd><dt>Logged by</dt><dd>${n.created_by}</dd></dl><h4 class="detail-heading">Drafted reply</h4><pre class="notice-draft">${n.draft_response}</pre>`,
      h`<button class="btn-cancel" data-act="closeModal">Close</button>${waiting ? h`<button class="btn-submit-green" data-act="openApprovals">Review in Approvals</button>` : ''}`, true);
  },
  logNotice() {
    openModal('Log a tax notice', 'Aegis drafts a reply and sends it to Approvals. Nothing is filed or sent.', h`<form data-form="notice">
      <div class="form-grid"><div class="form-group"><label class="form-label" for="ntAgency">Agency</label><input id="ntAgency" name="agency" class="form-select" required autocomplete="off"></div><div class="form-group"><label class="form-label" for="ntType">Notice type</label><input id="ntType" name="notice_type" class="form-select" required autocomplete="off"></div>
      <div class="form-group"><label class="form-label" for="ntRecv">Received</label><input id="ntRecv" name="received_on" type="date" class="form-select" value="${me.today}" required></div><div class="form-group"><label class="form-label" for="ntDue">Respond by</label><input id="ntDue" name="response_due" type="date" class="form-select" required></div></div>
      <div class="form-group"><label class="form-label" for="ntSum">Summary</label><textarea id="ntSum" name="summary" class="form-select" rows="3" required></textarea><p class="muted small mt">What the agency is asking for, in a sentence or two.</p></div>
      <button class="btn-submit-green">Log notice</button></form>`);
  },
  retryView() { refresh(); },
  openStep(el) {
    const d = document.getElementById(`step-${el.dataset.step}`); if (!d) return;
    d.open = true;
    d.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    d.querySelector('summary')?.focus({ preventScroll: true });
  },
  jumpGroup(el) {
    const row = document.getElementById(el.dataset.g); if (!row) return;
    row.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
    row.focus({ preventScroll: true });
  },
  async auditKind(el) {
    auditFilter.kind = el.dataset.k;
    for (const b of document.querySelectorAll('[data-act="auditKind"]')) { const on = b === el; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); }
    await reloadAudit();
  },
  async auditMore(el) {
    el.disabled = true;
    const res = await api(auditUrl(audit.rows.at(-1).seq));
    audit = { rows: [...audit.rows, ...res.rows], more: res.has_more, total: res.total };
    const list = $('#auditList'); list.innerHTML = render(auditList()); labelTableCells(list);
  },
  // Opens a row to show its place in the chain: sequence number and hashes.
  auditDetail(el) {
    const open = el.nextElementSibling?.classList.contains('audit-more-row');
    if (open) { el.nextElementSibling.remove(); el.setAttribute('aria-expanded', 'false'); return; }
    const r = audit.rows.find((x) => String(x.seq) === el.dataset.seq); if (!r) return;
    const extra = Object.entries(JSON.parse(r.detail_json || '{}'));
    el.insertAdjacentHTML('afterend', render(h`<tr class="audit-more-row"><td colspan="5"><dl class="kv audit-kv"><dt>Entry</dt><dd>${r.seq} · ${dt(r.ts)} UTC</dd><dt>Fingerprint</dt><dd class="mono">${r.hash}</dd><dt>Links to</dt><dd class="mono">${r.prev_hash}</dd>${r.case_id ? h`<dt>Case</dt><dd><button class="btn-link-action" data-act="caseDetail" data-id="${r.case_id}">Open case</button></dd>` : ''}${extra.map(([k, v]) => h`<dt>${words(k)}</dt><dd>${Array.isArray(v) ? v.join(', ') || 'None' : typeof v === 'object' ? JSON.stringify(v) : String(v)}</dd>`)}</dl></td></tr>`));
    el.setAttribute('aria-expanded', 'true');
  },
  editBaseline() {
    openModal('Edit baseline', 'Used to estimate hours saved.', h`<form data-form="baseline"><div class="form-group"><label class="form-label" for="blMin">Minutes for one manual chase</label><input id="blMin" name="value" type="number" min="0" step="0.5" class="form-select" required><p class="muted small mt">How long a person spends chasing one document by email or phone, from first message to receiving it.</p></div><button class="btn-submit-green">Save baseline</button></form>`);
    api('/api/metrics').then((m) => { const i = $('#blMin'); if (i && m.minutes_per_chase !== null) i.value = m.minutes_per_chase; }).catch(() => {});
  },
  logSupport() {
    openModal('Log support time', 'Time your team spent helping this workspace. It counts toward manual support.', h`<form data-form="manualSupport"><div class="form-grid"><div class="form-group"><label class="form-label" for="msMin">Minutes</label><input id="msMin" name="minutes" type="number" min="1" class="form-select" required></div><div class="form-group"><label class="form-label" for="msNote">What was done</label><input id="msNote" name="note" class="form-select" autocomplete="off"></div></div><button class="btn-submit-green">Log time</button></form>`);
  },
  printReport() { window.print(); },
  newView() {
    openModal('New view', 'Choose what to count and how to group it.', h`<form data-form="dashboard">
      <div class="form-group"><label class="form-label" for="nvName">Name</label><input id="nvName" name="name" class="form-select" required maxlength="120" autocomplete="off"></div>
      <div class="form-grid">
        <div class="form-group"><label class="form-label" for="nvMetric">Show</label><select id="nvMetric" name="metric" class="form-select" data-view-metric><option value="open_gaps">Open gaps (fail or unknown)</option><option value="missing_evidence">Missing documents</option><option value="expirations">Expiring credentials (next 90 days)</option><option value="coverage">All applicable checks</option></select></div>
        <div class="form-group"><label class="form-label" for="nvPack">Pack</label><select id="nvPack" name="pack" class="form-select"><option value="">All packs</option>${['healthcare', 'onboarding', 'immigration', 'payroll'].map((k) => h`<option value="${k}">${words(k)}</option>`)}</select></div>
        <div class="form-group"><label class="form-label" for="nvGroup">Group by</label><select id="nvGroup" name="group_by" class="form-select"><option value="facility">Facility</option><option value="team">Team</option><option value="pack">Pack</option><option value="status">Result</option><option value="control">Requirement</option><option value="window" hidden disabled>Time left</option></select></div>
      </div>
      <p class="muted small mb">Visible to people with your role and to administrators.</p>
      <button class="btn-submit-green">Save view</button></form>`);
  },
  deleteView(el) {
    openModal(`Delete ${el.dataset.name}?`, 'The view is removed for everyone who can see it. Checks and cases do not change.', '', h`<button class="btn-cancel" data-act="closeModal">Cancel</button><button class="btn-danger" data-act="confirmDeleteView" data-id="${el.dataset.id}">Delete view</button>`);
  },
  async confirmDeleteView(el) { await api(`/api/dashboards/${el.dataset.id}/delete`, {}); closeModal(); toast('Saved view deleted.', 'success'); location.hash = 'dashboards'; },
  copyLink() { navigator.clipboard?.writeText(location.href); toast('Link copied. Access still depends on role.', 'success'); },
  demoPanel() {
    if (!me.demo || !me.user.is_admin) return;
    openModal('Demo controls', 'Run the workflow with sample HRMS events.', h`<div class="stack">
      <div><strong>Sample HRMS events</strong><div class="row mt">
        <button class="top-action-btn" data-act="demoEvent" data-k="new_hire">New clinical hire</button>
        <button class="top-action-btn" data-act="demoEvent" data-k="assignment_change">Assignment change</button>
        <button class="top-action-btn" data-act="demoEvent" data-k="termination">Termination</button>
      </div></div>
      <div class="row"><button class="top-action-btn" data-act="demoAdvance" data-d="4">Advance 4 days</button><span class="muted small">Demo date ${me.today}</span></div>
      ${me.sandbox ? h`<div><button class="btn-danger" data-act="confirmDemoReset">Reset sandbox data</button></div>` : ''}
    </div>`);
  },
  async demoEvent(el) { const r = await api('/api/demo/hrms-event', { kind: el.dataset.k }); toast(`${r.type}: ${r.worker}`, 'success'); closeModal(); after(); },
  async demoAdvance(el) { const r = await api('/api/demo/advance', { days: +el.dataset.d }); me.today = r.today; renderTop(); toast(`Demo date is now ${r.today}.`, 'success'); closeModal(); after(); },
  confirmDemoReset() {
    openModal('Reset sandbox data?', 'The sandbox will restore the original sample workers and cases.', '',
      h`<button class="btn-cancel" data-act="closeModal">Cancel</button><button class="btn-danger" data-act="demoReset">Reset sandbox</button>`);
  },
  async demoReset() { await api('/api/demo/reset', {}); location.hash = ''; location.reload(); },
};
const after = () => refresh();
const FORM = {
  chat: (d, f) => { f.reset(); sendChat(d.text); },
  async addWorker(d) { await api('/api/workers', d); toast('Worker added. Checks are running.', 'success'); closeModal(); setTimeout(after, 1200); },
  async move(d, f) { await api(`/api/workers/${f.dataset.id}/assignment`, d); toast('Assignment updated. Checks are running.', 'success'); closeModal(); setTimeout(after, 1200); },
  async note(d, f) { await api(`/api/cases/${f.dataset.id}/note`, d); toast('Note added.', 'success'); ACT.caseDetail({ dataset: { id: f.dataset.id } }); },
  async importFile(d, f) {
    const p = await api('/api/import/preview', { file: await fileData(f.elements.file.files[0]) });
    openModal(`Review ${p.filename}`, `${p.total} worker(s) ready. Nothing is saved yet.`, h`${p.errors.length ? h`<div class="alert-box">${p.errors.length} row(s) will be skipped: ${p.errors.map((e) => `row ${e.row}: ${e.error}`).join('; ')}</div>` : ''}${p.unmapped.length ? h`<p class="small muted mb">Ignored columns: ${p.unmapped.join(', ')}</p>` : ''}<p class="small mb">Missing: ${p.missing.facility} location, ${p.missing.email} email, ${p.missing.hire_date} hire date. These will show as data gaps.</p>${table(['Name', 'Email', 'Role', 'Facility', 'Hire date'], p.sample.map((r) => h`<tr><td>${r.name}</td><td>${r.email}</td><td>${r.role}</td><td>${r.facility}</td><td>${r.hire_date}</td></tr>`), '')}`, h`<button class="btn-cancel" data-act="closeModal">Cancel</button><button class="btn-submit-green" data-act="commitImport" data-id="${p.id}">Import ${p.total} worker(s)</button>`, true);
  },
  async upload(d, f) {
    const [subject_type, subject_id] = d.subject.split(':'), files = [...f.elements.file.files], many = files.length > 1;
    let last, matched = 0, review = 0, dup = 0;
    for (const file of files) {
      // With several files the document number and expiry are left for Aegis to read from each file.
      last = await api('/api/evidence', { subject_type, subject_id, control_key: d.control_key || null, bulk: many, file: await fileData(file), claimed: many ? {} : { doc_number: d.doc_number, expires_on: d.expires_on } });
      if (last.duplicate) dup++; else if (last.status === 'accepted') matched++; else review++;
    }
    if (!many) toast(last.duplicate ? 'That file is already on record.' : last.status === 'accepted' ? 'Evidence matched. Re-running the check.' : `Sent to review: ${last.reasons[0]}`, last.status === 'accepted' ? 'success' : 'warning');
    else toast([matched ? `${matched} matched` : '', review ? `${review} sent to review` : '', dup ? `${dup} already on record` : ''].filter(Boolean).join(' · ') + '.', review || dup ? 'warning' : 'success');
    closeModal(); evidenceSel = last.id; if (route !== 'evidence') location.hash = 'evidence'; setTimeout(after, 1200);
  },
  async reviewEvidence(d, f, sub) {
    const { reason, ...fields } = d;
    await api(`/api/evidence/${f.dataset.id}/review`, { decision: sub?.value, reason, fields });
    toast(sub?.value === 'accept' ? 'Accepted. Re-running the check.' : 'Rejected. The submitter will be asked again.', 'success'); setTimeout(after, 1200);
  },
  async draftRule(d) { lastDraft = await api('/api/controls/draft', d); refresh(); },
  async activate(d, f) { await api(`/api/packs/${f.dataset.id}/activate`, { owner_user_id: d.owner_user_id, reviewed: !!d.reviewed }); toast('Pack activated in validation mode.', 'success'); closeModal(); setTimeout(after, 1200); },
  async facility(d, f) { await api(`/api/setup/facility/${f.dataset.id}`, { state: d.state, requirements: [...f.querySelectorAll('[name=req]:checked')].map((x) => x.value) }); toast('Requirements confirmed.', 'success'); closeModal(); setTimeout(after, 1200); },
  async channel(d) { await api('/api/setup/channel', d); toast('Channel saved.', 'success'); refresh(); },
  async connector(d, form, submitter) {
    const { options, ...fields } = d;
    let advanced;
    try { advanced = JSON.parse(options || '{}'); } catch { throw new Error('Enter a valid JSON object for additional settings.'); }
    if (!advanced || typeof advanced !== 'object' || Array.isArray(advanced)) throw new Error('Additional settings must be a JSON object.');
    const settings = { ...advanced, ...fields };
    const endpoint = form.dataset.id ? `/api/connectors/${form.dataset.id}` : '/api/connectors';
    const result = await api(`${endpoint}/test`, settings);
    form.querySelector('[data-connector-result]').innerHTML = render(mappingPreview(result));
    if (submitter?.value !== 'save') return;
    await api(endpoint, settings);
    toast('HRMS connection saved.', 'success');
    closeModal();
    refresh();
  },
  async slackConnection(d) {
    await api('/api/integrations/slack', d);
    toast('Slack connected.', 'success');
    closeModal();
    refresh();
  },
  async dashboard(d) { const r = await api('/api/dashboards', { ...d, pack: d.pack || null, within_days: d.metric === 'expirations' ? 90 : undefined }); closeModal(); toast('View saved.', 'success'); location.hash = `dashboards/${r.id}`; },
  async notice(d) { await api('/api/notices', d); closeModal(); toast('Notice logged. The drafted reply is in Approvals.', 'success'); refresh(); },
  async baseline(d) { await api('/api/metrics/baseline', { key: 'minutes_per_chase', value: d.value }); closeModal(); toast('Baseline saved.', 'success'); refresh(); },
  async manualSupport(d) { await api('/api/metrics/manual-support', d); closeModal(); toast('Support time logged.', 'success'); refresh(); },
  async aiKey(d) { const r = await api('/api/ai', { provider: d.provider, api_key: d.api_key, approved: !!d.approved }); toast(`${r.provider_label} connected.`, 'success'); refresh(); },
  async user(d) { await api('/api/users', d); toast('User added.', 'success'); refresh(); },
  async login(d) { await api('/api/login', d); location.reload(); },
};
const md = (t) => esc(t).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/#dashboards\/(dash_[a-f0-9]+)/g, '<a href="#dashboards/$1">Open dashboard</a>').replace(/\n/g, '<br>');
// Closing the panel returns focus to the button that opened it.
function closeChat() {
  const d = $('#chatDrawer'); if (!d?.classList.contains('open')) return false;
  d.classList.remove('open');
  $('.rail-assistant')?.focus({ preventScroll: true });
  return true;
}
async function loadChat() {
  const list = await api('/api/chat'), m = $('#chatMessages');
  m.innerHTML = list.length ? list.map((x) => `<div class="chat-bubble ${x.sender === 'bot' ? 'bot' : 'user'}"><span class="chat-bubble-author">${esc(x.author)}</span><div class="chat-bubble-content">${md(x.text)}</div></div>`).join('') : '<div class="empty chat-empty">Ask about gaps, expirations or approvals.</div>';
  m.scrollTop = m.scrollHeight;
}
async function sendChat(text) { if (!text) return; try { await api('/api/chat', { text }); } catch (e) { toast(e.message, 'warning'); } await loadChat(); refresh(); }
/* ==========================================================================
   AEGIS HANGING BADGE AUTH & RBAC PERSONAS
   ========================================================================== */

const ZONES = ["Immigration", "Clinical", "Tax", "HR", "Audit log", "Settings"];
// 2 = full access, 1 = view only, 0 = blocked  (same order as ZONES)
const PERSONAS = [
  {
    name: "Sathinath Padhi",
    roleName: "Full Admin",
    short: "Admin",
    email: "sathinath@bluebix.demo",
    color: "#0E8A5F",
    desc: "Sees everything. Manages settings and AI keys, and approves rule changes.",
    z: [2, 2, 2, 2, 2, 2]
  },
  {
    name: "Hannah Reed",
    roleName: "HR Operations",
    short: "HR",
    email: "hr@bluebix.demo",
    color: "#D9622B",
    desc: "Runs handbooks and onboarding. Legally blocked from passport and immigration files.",
    z: [0, 0, 0, 2, 0, 0]
  },
  {
    name: "Ivan Morales",
    roleName: "Immigration Specialist",
    short: "Immigration",
    email: "immigration@bluebix.demo",
    color: "#5B45C9",
    desc: "Reviews passports, Form I-9, STEM OPT and visa documents.",
    z: [2, 0, 0, 1, 0, 0]
  },
  {
    name: "Grace Okafor",
    roleName: "Clinical Compliance",
    short: "Clinical",
    email: "health@bluebix.demo",
    color: "#C2283F",
    desc: "Reviews clinical credentials only: RN licenses, BLS/CPR cards and TB tests.",
    z: [0, 2, 0, 0, 0, 0]
  },
  {
    name: "Farah Ali",
    roleName: "Payroll / Finance",
    short: "Finance",
    email: "finance@bluebix.demo",
    color: "#B98A00",
    desc: "Handles Form W-4 withholding certificates and payroll tax notices.",
    z: [0, 0, 2, 0, 0, 0]
  },
  {
    name: "Vikram Shah",
    roleName: "Auditor / Read-Only",
    short: "Auditor",
    email: "viewer@bluebix.demo",
    color: "#2F6496",
    desc: "Reads records and the audit log for inspections. Can't change anything.",
    z: [1, 1, 1, 1, 1, 0]
  }
];

const BLANK_BADGE = { name: "Your name here", role: "Not signed in", email: "", color: "#0E8A5F", z: [0, 0, 0, 0, 0, 0] };
let currentPersona = null;
let demoEnabled = false;
let demoPassword = 'demo1234';

function badgeInitials(s) {
  const w = String(s || '').replace(/[^a-zA-Z ]/g, ' ').trim().split(/\s+/);
  return ((w[0] || '?')[0] + (w[1] ? w[1][0] : '')).toUpperCase();
}

function renderBarcode(seed) {
  let h = 2166136261;
  for (const c of String(seed || '')) {
    h ^= c.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  let x = 0, out = '';
  while (x < 250) {
    h ^= h << 13;
    h ^= h >>> 17;
    h ^= h << 5;
    const w = 1 + (Math.abs(h) % 4);
    if ((h >>> 3) & 1) out += `<rect x="${x}" y="0" width="${w}" height="30"/>`;
    x += w + 1;
  }
  const el = $('#bCode');
  if (el) {
    el.setAttribute('viewBox', '0 0 250 30');
    el.innerHTML = `<g fill="#16202B">${out}</g>`;
  }
}

const zoneClass = (v) => (v === 2 ? 'full' : v === 1 ? 'view' : 'none');
const renderZonesHtml = (z) => ZONES.map((n, i) => `<span class="z ${zoneClass(z[i])}"><i></i>${n}</span>`).join('');

function updateHangingBadge({ name, role, email, color, z }) {
  document.documentElement.style.setProperty('--role', color || '#0E8A5F');
  const bName = $('#bName'); if (bName) bName.textContent = name || 'Your name here';
  const bRole = $('#bRole'); if (bRole) bRole.textContent = role || 'Not signed in';
  const bMail = $('#bMail'); if (bMail) bMail.textContent = email || '';
  const bInit = $('#bInit'); if (bInit) bInit.textContent = badgeInitials(name === 'Your name here' ? '?' : name);
  const bZones = $('#bZones'); if (bZones) bZones.innerHTML = renderZonesHtml(z || [0, 0, 0, 0, 0, 0]);
  renderBarcode(email || 'aegis');
}

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
async function typeIntoInput(el, text, ms) {
  if (!el) return;
  el.value = '';
  for (let i = 1; i <= text.length; i++) {
    el.value = text.slice(0, i);
    if (ms > 0) await sleepMs(ms);
  }
}

let tiltInitialized = false;
function setupTiltListener() {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced || tiltInitialized) return;
  tiltInitialized = true;
  let cur = 0, target = 0;
  window.addEventListener('pointermove', (e) => {
    target = ((e.clientX / window.innerWidth) - 0.5) * -5;
  });
  function loop() {
    const tilt = $('#tilt');
    if (tilt) {
      cur += (target - cur) * 0.06;
      tilt.style.transform = `rotate(${cur.toFixed(2)}deg)`;
    }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
}

let rackLastFocus = null;
function openDemoRack() {
  if (!demoEnabled) return;
  const overlay = $('#overlay');
  if (!overlay) return;
  rackLastFocus = document.activeElement;
  overlay.classList.add('open');
  overlay.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
  setTimeout(() => {
    const first = overlay.querySelector('.mini');
    if (first) first.focus();
  }, 60);
}

function closeDemoRack() {
  const overlay = $('#overlay');
  if (!overlay) return;
  overlay.classList.remove('open');
  overlay.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
  if (rackLastFocus) rackLastFocus.focus();
}

let selectingDemo = false;
async function selectDemoBadge(p) {
  if (!demoEnabled || selectingDemo) return;
  selectingDemo = true;
  try {
    closeDemoRack();
    const hanger = $('#hanger');
    const stamp = $('#stamp');
    const emailInput = $('#email');
    const passInput = $('#password');
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (stamp) stamp.classList.remove('hit');
    if (hanger && !reduced) {
      hanger.classList.remove('again');
      hanger.classList.add('lift');
      await sleepMs(430);
    }

    updateHangingBadge({ name: p.name, role: p.roleName, email: p.email, color: p.color, z: p.z });

    if (hanger) {
      hanger.classList.remove('lift');
      void hanger.offsetWidth;
      hanger.classList.add('again');
    }

    currentPersona = p;
    await sleepMs(reduced ? 0 : 450);
    await typeIntoInput(emailInput, p.email, reduced ? 0 : 20);
    currentPersona = p;
    await typeIntoInput(passInput, demoPassword, reduced ? 0 : 35);
    submitBadgeLogin();
  } finally {
    selectingDemo = false;
  }
}

async function submitBadgeLogin() {
  const emailInput = $('#email');
  const passInput = $('#password');
  const submitBtn = $('#submit');
  const statusEl = $('#status');
  if (statusEl) { statusEl.className = 'status status-desk'; statusEl.textContent = ''; }

  const em = emailInput ? emailInput.value.trim() : '';
  const pw = passInput ? passInput.value : '';

  if (!em) {
    if (statusEl) { statusEl.className = 'status status-desk err'; statusEl.textContent = 'Enter your work email to sign in.'; }
    if (emailInput) emailInput.focus();
    return;
  }
  if (!pw) {
    if (statusEl) { statusEl.className = 'status status-desk err'; statusEl.textContent = 'Enter your password to sign in.'; }
    if (passInput) passInput.focus();
    return;
  }

  if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Checking your badge…'; }

  try {
    await api('/api/login', { email: em, password: pw });
    if (submitBtn) { submitBtn.textContent = 'Signed in'; submitBtn.classList.add('done'); }
    const bRole = $('#bRole'); if (bRole) bRole.textContent = currentPersona ? `${currentPersona.roleName}, cleared` : 'Cleared';
    const stamp = $('#stamp'); if (stamp) stamp.classList.add('hit');
    if (statusEl) {
      statusEl.className = 'status status-desk ok';
      statusEl.textContent = currentPersona
        ? `Signed in as ${currentPersona.name}. Opening the workspace…`
        : 'Signed in. Opening the workspace…';
    }
    setTimeout(() => { location.reload(); }, 1000);
  } catch (err) {
    if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Sign in'; }
    if (statusEl) {
      statusEl.className = 'status status-desk err';
      statusEl.textContent = err.message || "That email and password don't match. Check them and try again.";
    }
  }
}

async function showLogin() {
  me = null;
  closeModal();
  const as = $('#appShell'); if (as) { as.hidden = true; as.style.display = 'none'; }
  const ls = $('#loginScreen'); if (ls) { ls.hidden = false; ls.style.display = 'block'; }
  document.body.style.background = 'var(--wall)';

  const info = await fetch('/api/public/info').then((r) => r.json()).catch(() => ({}));
  demoEnabled = info.demo === true;
  demoPassword = info.demo_password || '';

  $('#loginScreen').innerHTML = `
    <div class="page badge-page">
      <!-- Left: the hanging badge on lanyard -->
      <aside class="stand" aria-label="Badge preview">
        <div class="hanger" id="hanger">
          <div class="tilt" id="tilt">
            <div class="strap"><span>aegis&nbsp;&nbsp;aegis&nbsp;&nbsp;aegis&nbsp;&nbsp;aegis&nbsp;&nbsp;aegis&nbsp;&nbsp;aegis</span></div>
            <div class="clip"></div>
            <div class="holder">
              <div class="badge">
                <div class="band">
                  <span class="org">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6l7-3z"/></svg>
                    Aegis
                  </span>
                  <small>Compliance workspace</small>
                </div>
                <div class="photo" id="bInit">?</div>
                <div class="who">
                  <div class="name" id="bName">Your name here</div>
                  <div class="role" id="bRole">Not signed in</div>
                  <div class="mail" id="bMail"></div>
                </div>
                <div class="zones">
                  <p>Records this badge opens</p>
                  <div class="zgrid" id="bZones"></div>
                </div>
                <svg class="barcode" id="bCode" preserveAspectRatio="none" aria-hidden="true"></svg>
                <div class="stamp" id="stamp">Cleared</div>
              </div>
            </div>
          </div>
        </div>
      </aside>

      <!-- Right: the sign-in desk -->
      <main class="desk">
        <div class="top top-desk">
          <div class="logo desk-logo">
            <b><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6l7-3z"/><path d="M9 12l2 2 4-4"/></svg></b>
            Aegis
          </div>
        </div>

        <section class="main main-desk">
          <h1>Sign in to Aegis</h1>
          <p class="lead">Use your work account to access your compliance workspace.</p>

          <form id="form" class="form-desk" novalidate>
            <div>
              <label for="email">Work email</label>
              <input id="email" type="email" placeholder="name@company.com" autocomplete="username" />
            </div>
            <div>
              <label for="password">Password</label>
              <div class="pw">
                <input id="password" type="password" autocomplete="current-password" />
                <button type="button" id="toggle" aria-pressed="false">Show</button>
              </div>
            </div>
            <button class="primary primary-badge-btn" id="submit" type="submit">Sign in</button>
          </form>

          ${demoEnabled ? `<div class="or or-divider">Sample workspaces</div>
          <button class="demo demo-trigger" type="button" data-act="quickLogin" data-e="sathinath@bluebix.demo">Open Bluebix sandbox</button>
          <button class="demo demo-trigger mt" id="openRack" type="button" aria-haspopup="dialog">
            <span class="swatch" id="swatch">${PERSONAS.map(p => `<i style="background:${p.color}"></i>`).join('')}</span>
            Use a demo badge
            <span class="count">6 roles</span>
          </button>
          <button class="demo demo-trigger mt" type="button" data-act="quickLogin" data-e="admin@northstar.demo">Try empty company setup</button>` : ''}

          <p class="status status-desk" id="status" role="status" aria-live="polite"></p>
        </section>

        <p class="fine">Contact your workspace administrator for sign-in help.</p>
      </main>
    </div>
  `;

  renderDemoRack();
  updateHangingBadge(BLANK_BADGE);
  setupTiltListener();

  const emailInput = $('#email');
  const passInput = $('#password');
  const formEl = $('#form');
  const toggleBtn = $('#toggle');
  const openRackBtn = $('#openRack');
  const closeRackBtn = $('#closeRack');
  const overlayEl = $('#overlay');

  if (emailInput) {
    emailInput.addEventListener('input', () => {
      const val = emailInput.value.trim();
      const found = demoEnabled && PERSONAS.find((p) => p.email.toLowerCase() === val.toLowerCase());
      if (found) {
        currentPersona = found;
        updateHangingBadge({ name: found.name, role: found.roleName, email: found.email, color: found.color, z: found.z });
      } else {
        currentPersona = null;
        const local = val.split('@')[0].replace(/[._-]+/g, ' ').trim();
        const name = local ? local.replace(/\b\w/g, (c) => c.toUpperCase()) : BLANK_BADGE.name;
        updateHangingBadge({ ...BLANK_BADGE, name, role: val ? 'Signing in' : BLANK_BADGE.role, email: val });
      }
      const stamp = $('#stamp');
      if (stamp) stamp.classList.remove('hit');
    });
  }

  if (toggleBtn && passInput) {
    toggleBtn.onclick = () => {
      const isPw = passInput.type === 'password';
      passInput.type = isPw ? 'text' : 'password';
      toggleBtn.textContent = isPw ? 'Hide' : 'Show';
      toggleBtn.setAttribute('aria-pressed', String(isPw));
    };
  }

  if (formEl) {
    formEl.addEventListener('submit', (e) => {
      e.preventDefault();
      currentPersona = currentPersona && emailInput && emailInput.value === currentPersona.email ? currentPersona : null;
      submitBadgeLogin();
    });
  }

  if (openRackBtn) openRackBtn.onclick = openDemoRack;
  if (closeRackBtn) closeRackBtn.onclick = closeDemoRack;
  if (overlayEl) {
    overlayEl.addEventListener('click', (e) => {
      if (e.target === overlayEl) closeDemoRack();
    });
  }

}

ACT.quickLogin = async (el) => {
  if (!demoEnabled) return;
  const e = el.dataset.e;
  const p = demoPassword;
  el.disabled = true;
  try {
    await api('/api/login', { email: e, password: p });
    location.reload();
  } catch (err) {
    toast(err.message || 'Login failed', 'warning');
  } finally { el.disabled = false; }
};

document.addEventListener('click', async (ev) => {
  // Check worn badge menu toggle
  const meBtn = ev.target.closest('#meBtn');
  if (meBtn) {
    ev.stopPropagation();
    const meMenu = $('#meMenu');
    if (meMenu) {
      const wasOpen = meMenu.classList.contains('open');
      closeAllDirMenus();
      if (!wasOpen) {
        meMenu.classList.add('open');
        meBtn.setAttribute('aria-expanded', 'true');
      }
    }
    return;
  }

  // Check demo rack mini clicks
  const miniBtn = ev.target.closest('#rack .mini');
  if (miniBtn) {
    ev.preventDefault();
    ev.stopPropagation();
    const idx = parseInt(miniBtn.dataset.personaIdx, 10);
    if (!isNaN(idx) && PERSONAS[idx]) {
      if ($('#loginScreen') && !$('#loginScreen').hidden) {
        selectDemoBadge(PERSONAS[idx]);
      } else {
        selectPersonaInWorkspace(PERSONAS[idx]);
      }
    }
    return;
  }

  // Check close rack button or backdrop click
  if (ev.target.closest('#closeRack') || ev.target.id === 'overlay') {
    closeDemoRack();
    return;
  }

  // Check mobile menu button or sheet backdrop
  if (ev.target.closest('#menu')) {
    setNavigationOpen(!$('#sheet').classList.contains('open'));
    return;
  }
  if (ev.target.id === 'sheet') {
    setNavigationOpen(false);
    return;
  }
  if (ev.target.closest('.skip-main')) {
    ev.preventDefault();
    $('#workspace-main').focus();
    return;
  }

  // Check any link inside a .dir dropdown or mobile sheet
  const dirLink = ev.target.closest('.dir a, .sheet a');
  if (dirLink) {
    const act = dirLink.dataset.act;
    const href = dirLink.getAttribute('href');
    closeAllDirMenus();
    setNavigationOpen(false);
    if (act && ACT[act] && act !== 'dirLink') {
      ev.preventDefault();
      try { await ACT[act](dirLink, ev); } catch (e) { toast(e.message, 'warning'); }
      return;
    }
    if (href && href.startsWith('#') && href.length > 1) {
      ev.preventDefault();
      if (location.hash !== href) location.hash = href;
      return;
    }
  }

  // Close open dropdowns if clicking outside
  if (!ev.target.closest('.dir') && !ev.target.closest('.tab') && !ev.target.closest('#meBtn')) {
    closeAllDirMenus();
  }

  // Tick boxes on Cases: handled here so the click does not also open the case.
  const box = ev.target.closest('.case-check, .case-check-all');
  if (box) { ev.stopPropagation(); onCaseCheck(box, ev.shiftKey); return; }
  if (ev.target.closest('.select-cell, .select-all')) return; // the label passes the click on to its tick box

  // A download link inside a clickable row downloads; it does not open the row.
  if (ev.target.closest('a[download]')) return;
  const el = ev.target.closest('[data-act]');
  if (el && ACT[el.dataset.act]) {
    ev.preventDefault();
    if (el.tagName === 'BUTTON' && el.closest('tr[data-act]')) ev.stopPropagation();
    try { await ACT[el.dataset.act](el, ev); } catch (e) { toast(e.message, 'warning'); }
  } else if (ev.target.id === 'modal') {
    closeModal();
  }
});
document.addEventListener('submit', async (ev) => {
  const f = ev.target.closest('form[data-form]'); if (!f) return;
  ev.preventDefault();
  const data = Object.fromEntries([...new FormData(f).entries()].filter(([, v]) => !(v instanceof File)));
  const sub = ev.submitter, btn = sub || f.querySelector('button');
  if (btn) btn.disabled = true;
  try { await FORM[f.dataset.form](data, f, sub); } catch (e) { toast(e.message, 'warning'); } finally { if (btn) btn.disabled = false; }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    // Escape closes the top-most thing: a window, then the coworker panel, then the case selection.
    if ($('#modal').classList.contains('open')) closeModal();
    else if (closeChat()) { /* closed the coworker panel */ }
    else if (caseSel.size) clearCaseSelection();
    closeDemoRack();
    closeAllDirMenus();
    setNavigationOpen(false);
  }
  if (e.key === 'Tab' && $('#modal').classList.contains('open')) {
    const focusable = [...$('#modalCard').querySelectorAll('a[href], button, input, select, textarea, [tabindex]')]
      .filter((el) => el.tabIndex >= 0 && !el.disabled && el.getClientRects().length);
    const first = focusable[0], last = focusable.at(-1);
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    return;
  }
  const overlay = $('#overlay');
  if (overlay && overlay.classList.contains('open') && e.key === 'Tab') {
    const f = overlay.querySelectorAll('button'), first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
});
$('#globalSearch')?.addEventListener('input', (e) => filterRows(e.target.value));
// Evidence: the right panel is sized to the space left on screen, so its bottom (Accept / Reject)
// is visible at every scroll position, not only once it starts to stick.
let fitQueued = false;
function fitInspector() {
  fitQueued = false;
  const el = $('#view .inspector'); if (!el) return;
  if (matchMedia('(max-width: 900px)').matches) { el.style.maxHeight = ''; return; }
  const top = Math.max(el.getBoundingClientRect().top, 24);
  el.style.maxHeight = `${Math.max(320, innerHeight - top - 24)}px`;
}
const queueFit = () => { if (!fitQueued) { fitQueued = true; requestAnimationFrame(fitInspector); } };
addEventListener('scroll', queueFit, { passive: true });
addEventListener('resize', queueFit, { passive: true });
// Upload window: list the chosen files. The document number and expiry boxes only make sense for one file.
const fileSize = (b) => (b < 1024 * 1024 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`);
document.addEventListener('change', (e) => {
  const input = e.target.closest?.('[data-upload-files]'); if (!input) return;
  const form = input.form, files = [...input.files], n = files.length;
  form.querySelector('[data-single-only]').hidden = n > 1;
  form.querySelector('[data-upload-drop]').classList.toggle('has-files', n > 0);
  form.querySelector('[data-upload-title]').innerHTML = n ? `${n} file${n > 1 ? 's' : ''} chosen · <u>change</u>` : 'Drop files here, or <u>choose files</u>';
  form.querySelector('[data-upload-count]').textContent = n > 1 ? 'Bulk upload: Aegis reads the document number and expiry from each file.' : 'One file, or select several at once to upload in bulk. PDF or photo.';
  const list = form.querySelector('[data-upload-list]');
  list.hidden = !n;
  list.innerHTML = render(files.map((f) => h`<li><span class="upload-file-name">${f.name}</span><span class="upload-file-size">${fileSize(f.size)}</span></li>`));
  form.querySelector('[data-upload-go]').textContent = n > 1 ? `Upload ${n} files` : 'Upload';
});
// Highlight the drop area while files are dragged over it. The file input covers it, so the drop itself is native.
for (const type of ['dragenter', 'dragover', 'dragleave', 'drop']) {
  document.addEventListener(type, (e) => {
    const zone = e.target.closest?.('[data-upload-drop]'); if (!zone) return;
    zone.classList.toggle('is-over', type === 'dragenter' || type === 'dragover');
  });
}
document.addEventListener('change', (e) => {
  const metric = e.target.closest?.('[data-view-metric]'); if (!metric) return;
  const group = metric.form.elements.group_by, win = group.querySelector('[value="window"]'), on = metric.value === 'expirations';
  win.hidden = win.disabled = !on;
  if (on) group.value = 'window'; else if (group.value === 'window') group.value = 'facility';
});
let auditTimer;
document.addEventListener('input', (e) => {
  const f = e.target.closest?.('[data-audit-field]'); if (!f) return;
  auditFilter[f.dataset.auditField] = f.value;
  clearTimeout(auditTimer);
  auditTimer = setTimeout(() => reloadAudit().catch((err) => toast(err.message, 'warning')), f.type === 'search' ? 300 : 0);
});
window.addEventListener('hashchange', readHash);
fetch('/api/me').then((r) => { if (r.ok) boot(); else showLogin(); });
