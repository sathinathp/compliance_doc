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
  flu_vaccine: 'Flu vaccination', facility_orientation: 'Facility orientation', handbook_ack: 'Handbook acknowledgment',
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
  if (!r.ok) throw new Error(data.error || 'Request failed.');
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
  ? h`<div class="table-scroll-container"><table><thead><tr>${heads.map((x) => h`<th>${x}</th>`)}</tr></thead><tbody>${rows}</tbody></table></div>`
  : emptyState(none);
const card = (title, sub, body, tools) => h`<div class="panel"><div class="ph2"><div><h2>${title}</h2><p>${sub}</p></div>${tools ? h`<div>${tools}</div>` : ''}</div>${body}</div>`;

const I = { overview: '<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>', setup: '<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>', cases: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>', approvals: '<path d="M20 6 9 17l-5-5"/>', checks: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>', workers: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/>', evidence: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M12 18v-6m-3 3 3-3 3 3"/>', packs: '<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/>', controls: '<path d="M4 21h16M4 14h16M4 7h16"/><circle cx="8" cy="7" r="2"/><circle cx="16" cy="14" r="2"/>', integrations: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="m9 12 2 2 4-4"/>', dashboards: '<rect x="3" y="3" width="7" height="9"/><rect x="14" y="3" width="7" height="5"/><rect x="14" y="12" width="7" height="9"/><rect x="3" y="16" width="7" height="5"/>', audit: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>', reports: '<path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-3 3"/>', metrics: '<path d="M12 20V10M18 20V4M6 20v-4"/>', settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>' };
const NAV = [
  ['Workspace', [['overview', 'Overview'], ['cases', 'Cases'], ['evidence', 'Evidence'], ['approvals', 'Approvals']]],
  ['Records', [['workers', 'Workers'], ['checks', 'Checks'], ['packs', 'Compliance packs'], ['controls', 'Control rules']]],
  ['Reporting', [['dashboards', 'Dashboards'], ['reports', 'Reports & notices'], ['metrics', 'Pilot metrics'], ['audit', 'Audit history']]],
  ['Organization', [['setup', 'Company setup'], ['integrations', 'Connections'], ['settings', 'Settings']]]
];
const HEAD = { overview: ['Workspace', 'Overview', 'Current status across activated packs, accepted evidence and open remediation.'], setup: ['Organization', 'Company setup', 'Connect records, confirm context, activate packs and run the first assessment.'], cases: ['Workspace', 'Cases', 'Each gap moves from identified to closed. Only accepted evidence closes a case.'], approvals: ['Workspace', 'Approvals', 'Consequential actions wait here for an authorized person.'], evidence: ['Workspace', 'Evidence', 'AI proposes matches and fields. Uncertain documents go to a person.'], checks: ['Records', 'Checks', 'Every result has a reason, evidence references and a control version.'], workers: ['Records', 'Workers', 'Per-pack status for each worker. One pack never hides another.'], packs: ['Records', 'Compliance packs', 'Versioned packs reviewed and activated by an authorized person.'], controls: ['Records', 'Control rules', 'Draft, preview and approve changes before they take effect.'], integrations: ['Organization', 'Connections', 'Connectors, messages, background jobs and visible failures.'], dashboards: ['Reporting', 'Dashboards', 'Live views of readiness, expirations and gaps, from the same records as Checks and the coworker.'], reports: ['Reporting', 'Reports & notices', 'Evidence-backed exports and tax notice intake.'], metrics: ['Reporting', 'Pilot metrics', 'Measured from records. Blank means not measured yet.'], audit: ['Reporting', 'Audit history', 'Append-only, hash-chained history of evaluations, requests and closures.'], settings: ['Organization', 'Settings', 'Users, roles, reporting channel and schedules.'] };

// Ticked cases on the Cases page (ids). Cleared when the tab or page changes.
const caseSel = new Set();
let lastCaseCheck = null;
let caseClosed = false, me = null, route = 'overview', routeArg = null, checkFilter = {}, evidenceSel = null, lastDraft = null, importPreview = null;
let navigation = 0;
const adminRoutes = new Set(['setup', 'settings', 'audit', 'integrations']);
const canEdit = () => me.user.role !== 'viewer';
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
const PAGE_TOOLS = { dashboards: ['newView'], cases: ['uploadEvidence'], workers: ['importRoster', 'addWorker'], evidence: ['uploadEvidence'] };
const SEARCH_PAGES = new Set(['cases', 'evidence', 'approvals', 'workers', 'checks', 'controls', 'audit', 'settings']);
const TOOL_ALLOWED = { addWorker: () => canAddWorker(), importRoster: () => canEdit(), uploadEvidence: () => canEdit(), newView: () => canEdit() };
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
    const visible = items.filter(([key]) => me.user.is_admin || !adminRoutes.has(key));
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
    $('#view').innerHTML = render(h`<div class="panel empty"><span class="hook">${raw(hookSvg)}</span><div><b>Error loading view</b><span>${e.message}</span></div></div>`);
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

// ---------- Dashboards ----------
const DASH_ICON = {
  readiness: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="m16 11 2 2 4-4"/>',
  expirations: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  open_gaps: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  missing_evidence: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="m9.5 12.5 5 5"/><path d="m14.5 12.5-5 5"/>',
  coverage: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/>',
};
const dashIcon = (metric) => raw(`<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${DASH_ICON[metric] || DASH_ICON.coverage}</svg>`);
const GROUP_LABEL = { facility: 'facility', team: 'team', pack: 'pack', status: 'result', control: 'requirement', window: 'time left', readiness: 'readiness decision' };
const WINDOW_TONE = { Expired: 'fail', 'Next 30 days': 'warn', '31 to 60 days': 'info', '61 to 90 days': 'na', Later: 'na' };
const READY_TONE = { approved: 'pass', pending: 'warn', blocked: 'fail' };
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
// The headline number, its label and the coloured parts of the bar, from the same numbers the API sends.
function dashFigures(d, data) {
  const m = d.definition.metric, groups = data.groups, count = (name) => groups.find((g) => g.name === name)?.count || 0;
  if (m === 'readiness') {
    const ok = count('approved');
    return { value: `${ok} of ${data.total}`, label: 'workers approved for assignment', parts: ['blocked', 'pending', 'approved'].map((k) => ({ label: words(k), n: count(k), tone: READY_TONE[k] })) };
  }
  if (m === 'expirations') {
    const expired = count('Expired');
    return { value: data.total, label: data.total === 1 ? 'credential to renew' : 'credentials to renew', note: expired ? `${expired} already expired` : 'None expired', parts: Object.keys(WINDOW_TONE).map((k) => ({ label: k, n: count(k), tone: WINDOW_TONE[k] })) };
  }
  const split = [{ label: 'Pass', n: data.split.pass, tone: 'pass' }, { label: 'Fail', n: data.split.fail, tone: 'fail' }, { label: 'Unknown', n: data.split.unknown, tone: 'unknown' }];
  if (m === 'coverage') {
    const pct = data.total ? Math.round(data.split.pass / data.total * 100) : 0;
    return { value: `${pct}%`, label: `of ${plural(data.total, 'check')} pass`, parts: split };
  }
  const by = GROUP_LABEL[d.definition.group_by] || 'group';
  return { value: data.total, label: m === 'missing_evidence' ? (data.total === 1 ? 'missing document' : 'missing documents') : data.total === 1 ? 'open gap' : 'open gaps', note: groups.length ? `Across ${plural(groups.length, by, by === 'facility' ? 'facilities' : `${by}s`)}` : '', parts: split.filter((x) => x.tone !== 'pass') };
}
const segBar = (parts, cls = '') => {
  const total = parts.reduce((a, x) => a + x.n, 0);
  return h`<div class="seg-bar ${cls}" role="img" aria-label="${parts.filter((x) => x.n).map((x) => `${x.label} ${x.n}`).join(', ') || 'Nothing to show'}">${total ? parts.filter((x) => x.n).map((x) => h`<span class="seg seg-${x.tone}" style="flex-grow:${x.n}"></span>`) : h`<span class="seg seg-empty"></span>`}</div>`;
};
const segLegend = (parts) => h`<ul class="seg-legend">${parts.filter((x) => x.n).map((x) => h`<li><i class="dot dot-${x.tone}"></i>${x.label} <b>${x.n}</b></li>`)}</ul>`;
const dashOrigin = (d) => (d.built_in ? h`<span class="dash-tag">Built in</span>` : h`<span class="dash-tag is-saved">Saved by ${d.created_by}</span>`);
function dashCard(d) {
  const f = dashFigures(d, d.summary);
  return h`<a class="dash-card" href="#dashboards/${d.id}">
    <div class="dash-card-top"><span class="dash-icon dash-icon-${d.definition.metric}">${dashIcon(d.definition.metric)}</span>${dashOrigin(d)}</div>
    <h3>${d.name}</h3>
    <div class="dash-figure"><b>${f.value}</b><span>${f.label}</span></div>
    ${segBar(f.parts)}
    <p class="dash-note">${f.note || d.description || `Grouped by ${GROUP_LABEL[d.definition.group_by]}`}</p>
  </a>`;
}
const daysLeft = (n) => (n < 0 ? h`<span class="pill pill-fail">Expired ${plural(-n, 'day')} ago</span>` : n === 0 ? h`<span class="pill pill-fail">Expires today</span>` : n <= 30 ? h`<span class="pill pill-warn">${plural(n, 'day')} left</span>` : h`<span class="pill pill-na">${plural(n, 'day')} left</span>`);
const personCell = (i) => (i.subject_type === 'worker' ? h`<button class="row-title" data-act="workerDetail" data-id="${i.subject_id}">${i.subject}</button><div class="case-sub">${i.facility}</div>` : h`<strong>${i.subject}</strong><div class="case-sub">Company level</div>`);
function dashRows(metric, items) {
  if (metric === 'readiness') return table(['Worker', 'Open checks', 'Overall', 'Readiness'], items.map((i) => h`<tr><td>${personCell(i)}</td><td>${i.open ? h`<span class="open-count">${i.open}</span>` : h`<span class="muted">None</span>`}</td><td>${statusPill(i.status)}</td><td><span class="pill pill-${READY_TONE[i.readiness] === 'warn' ? 'warn' : READY_TONE[i.readiness]}">${words(i.readiness)}</span></td></tr>`), 'Nobody here.');
  if (metric === 'expirations') return table(['Worker', 'Credential', 'Expires', 'Time left'], items.map((i) => h`<tr><td>${personCell(i)}</td><td>${i.control}<div class="case-sub">${words(i.pack)}</div></td><td class="nowrap">${date(i.expires_on)}</td><td>${daysLeft(i.days_left)}</td></tr>`), 'Nothing expires in this window.');
  return table(['Worker', 'Requirement', 'Result', 'Why'], items.map((i) => h`<tr><td>${personCell(i)}</td><td>${i.control}<div class="case-sub">${words(i.pack)}</div></td><td>${statusPill(i.status)}</td><td class="small">${i.reason}</td></tr>`), 'Nothing here.');
}
function dashboardDetail(d) {
  const data = d.data, m = d.definition.metric, f = dashFigures(d, data), max = Math.max(1, ...data.groups.map((g) => g.count));
  const by = d.definition.group_by, groupName = (n) => (by === 'status' || by === 'readiness' ? words(n) : n);
  const canDelete = !d.built_in && canEdit() && (me.user.is_admin || d.created_by === me.user.name);
  const filters = [d.definition.pack ? `${words(d.definition.pack)} pack` : 'All packs', `grouped by ${GROUP_LABEL[by]}`, d.definition.within_days ? `next ${d.definition.within_days} days` : ''].filter(Boolean).join(' · ');
  return h`<div class="stack">
    <a class="back-link" href="#dashboards"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>All dashboards</a>
    <div class="panel dash-hero">
      <div class="dash-hero-main">
        <span class="dash-icon dash-icon-${m}">${dashIcon(m)}</span>
        <div><div class="dash-hero-title"><h2>${d.name}</h2>${dashOrigin(d)}</div><p>${d.description || filters}</p><p class="dash-meta">${d.description ? `${filters} · ` : ''}As of ${dt(data.as_of)}</p></div>
      </div>
      <div class="dash-hero-tools"><button class="btn-card-outline" data-act="copyLink">Copy link</button>${canDelete ? h`<button class="btn-card-outline danger" data-act="deleteView" data-id="${d.id}" data-name="${d.name}">Delete view</button>` : ''}</div>
      <div class="dash-hero-figures">
        <div class="dash-figure is-large"><b>${f.value}</b><span>${f.label}</span>${f.note ? h`<small>${f.note}</small>` : ''}</div>
        <div class="dash-hero-bar">${segBar(f.parts, 'is-large')}${segLegend(f.parts)}</div>
      </div>
    </div>
    ${data.groups.length ? data.groups.map((g, i) => h`<details class="panel dash-group" ${i < 4 ? raw('open') : ''}>
      <summary><span class="dash-group-name">${groupName(g.name)}</span><span class="dash-group-bar"><span style="width:${g.count / max * 100}%" class="${by === 'window' ? `tone-${WINDOW_TONE[g.name]}` : by === 'readiness' ? `tone-${READY_TONE[g.name]}` : ''}"></span></span><b class="dash-group-count">${g.count}</b><svg class="chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></summary>
      ${dashRows(m, g.items)}
    </details>`) : h`<div class="panel">${emptyState([m === 'expirations' ? 'Nothing expires in this window' : 'Nothing to show', 'This dashboard updates by itself as checks change.'])}</div>`}
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
    const s = await api('/api/setup'), st = s.steps;
    const step = (n, done, title, sub, body) => h`<div class="step${done ? ' done' : ''}"><div class="step-num">${done ? '✓' : n}</div><div class="step-body"><h3>${title}</h3><p class="muted small mb">${sub}</p>${body}</div></div>`;
    return h`<div class="stack">
    ${step(1, st.connect, 'Connect records or start manually', `${s.summary.workers} workers, ${s.summary.facilities} locations and ${s.summary.entities} employing entities on record.`, h`<div class="row"><a class="top-action-btn" href="#integrations">Connect a system</a><button class="top-action-btn" data-act="importRoster">Upload Excel or CSV</button><button class="top-action-btn" data-act="addWorker">Add a worker</button></div>`)}
    ${step(2, st.context, 'Confirm company context', 'Confirm entities, locations and each facility’s requirements. Unconfirmed facilities produce Unknown results.', h`${s.gaps.length ? h`<div class="alert-box"><strong>Gaps found</strong><ul>${s.gaps.map((g) => h`<li>${g}</li>`)}</ul></div>` : ''}${table(['Facility', 'State', 'Requirements', 'Status', ''], s.facilities.map((f) => h`<tr><td><strong>${f.name}</strong></td><td>${f.state}</td><td>${f.requirements.map(words).join(', ') || 'None'}</td><td>${f.requirements_confirmed ? h`<span class="pill pill-pass">Confirmed</span>` : h`<span class="pill pill-unknown">Not confirmed</span>`}</td><td style="text-align:right"><button class="btn-link-action" data-act="facility" data-id="${f.id}" data-name="${f.name}" data-state="${f.state}" data-req="${f.requirements.join(',')}">Edit</button></td></tr>`), 'Add records first.')}<div class="mt"><button class="btn-submit-green" data-act="confirmContext" ${st.connect ? '' : raw('disabled')}>Confirm company profile</button></div>`)}
    ${step(3, st.packs, 'Review and activate packs', 'New packs start in validation mode. Nothing is sent until owners validate findings.', h`${table(['Pack', 'Recommended', 'Status', ''], s.recommended.map((p) => h`<tr><td>${p.icon} <strong>${p.name}</strong></td><td>${p.recommended ? 'Yes' : 'Not yet'}</td><td>${statePill(p.status)}</td><td style="text-align:right"><button class="btn-link-action" data-act="reviewPack" data-id="${p.key}">Review</button></td></tr>`), '')}`)}
    ${step(4, st.channel, 'Connect the reporting channel', s.slack_ready ? 'Slack is configured on this server.' : 'Slack needs a bot token on the server. Until then, messages stay in the in-app outbox.', h`<form class="row" data-form="channel"><select name="type" class="mini-select"><option value="outbox" ${s.channel.type !== 'slack' ? raw('selected') : ''}>In-app outbox</option><option value="slack" ${s.channel.type === 'slack' ? raw('selected') : ''} ${s.slack_ready ? '' : raw('disabled')}>Slack</option></select><input name="channel" class="mini-select" value="${s.channel.channel || '#compliance-alerts'}" aria-label="Channel"><button class="btn-card-outline">Save</button></form>`)}
    ${step(5, st.assessed, 'Run the initial assessment', st.assessed ? s.coverage.scope_statement : 'Shows checked records, missing evidence and unknown results.', h`${st.assessed ? h`<div class="grid-3 mb" style="max-width:420px"><div class="tile"><b>${s.coverage.pass}</b><span>Pass</span></div><div class="tile"><b>${s.coverage.fail}</b><span>Fail</span></div><div class="tile"><b>${s.coverage.unknown}</b><span>Unknown</span></div></div>` : ''}<button class="btn-submit-green" data-act="assess" ${st.packs ? '' : raw('disabled')}>${st.assessed ? 'Run again' : 'Run assessment'}</button>`)}
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
      <section><div class="dash-section-head"><h2>Built-in dashboards</h2><p>Ready for every team. They read the same records as Checks and the coworker.</p></div><div class="dash-grid">${built.map(dashCard)}</div></section>
      <section><div class="dash-section-head"><h2>Saved views</h2><p>Made by your team with New view, or by asking the coworker, for example "Make a view of missing documents by team".</p></div>${saved.length ? h`<div class="dash-grid">${saved.map(dashCard)}</div>` : emptyState(['No saved views yet', canEdit() ? 'Use New view at the top, or ask the coworker to make one.' : 'Saved views made by your team appear here.'])}</section>
    </div>`;
  },
  async reports() {
    const o = await api('/api/overview'); scope(o.coverage);
    const canFin = me.user.is_admin || me.user.role === 'finance', notices = canFin ? await api('/api/notices') : [];
    return h`<div class="stack"><div class="grid-3">${o.packs.map((p) => h`<div class="plain-card"><strong class="pack-title">${packIcon(p.key)}${p.name}</strong><p class="muted small mt">${p.pass} pass, ${p.fail} fail and ${p.unknown} unknown of ${p.total} applicable checks.</p><a class="btn-card-outline mt" href="/api/reports/${p.key}" download>Download CSV</a></div>`)}<div class="plain-card"><strong>All activated packs</strong><p class="muted small mt">Includes the scope statement, reasons and evidence references.</p><a class="btn-card-outline mt" href="/api/reports/all" download>Download CSV</a></div>
    ${me.user.is_admin ? h`<div class="plain-card"><strong>Digest</strong><p class="muted small mt">Posted daily to the reporting channel. Uses the same records as this page.</p><button class="btn-card-outline mt" data-act="sendDigest">Send digest now</button></div>` : ''}</div>
    ${canFin ? h`${card('Tax Notice Intake', 'Aegis drafts a response. Finance reviews it, and nothing is filed by Aegis.', table(['Agency', 'Type', 'Respond by', 'Status', ''], notices.map((n) => h`<tr><td><strong>${n.agency}</strong></td><td>${n.notice_type}</td><td class="date-urgent">${date(n.response_due)}</td><td>${statePill(n.status)}</td><td style="text-align:right"><button class="btn-link-action" data-act="viewNotice" data-text="${n.draft_response}">View draft</button></td></tr>`), ['No tax notices yet', 'Log a notice and Aegis drafts a response for Finance to review.']))}<form class="plain-card" data-form="notice"><strong>Log a notice</strong><div class="form-grid mt"><div class="form-group"><label class="form-label">Agency</label><input name="agency" class="form-select" required></div><div class="form-group"><label class="form-label">Notice type</label><input name="notice_type" class="form-select" required></div><div class="form-group"><label class="form-label">Respond by</label><input name="response_due" type="date" class="form-select"></div><div class="form-group"><label class="form-label">Summary</label><input name="summary" class="form-select" required></div></div><button class="btn-submit-green">Draft response</button></form>` : ''}</div>`;
  },
  async metrics() {
    scope(null);
    const m = await api('/api/metrics');
    const v = (x, u = '') => x === null || x === undefined ? 'Not measured' : `${x}${u}`;
    const rows = [['Labor saved', v(m.hours_saved, ' hrs'), `${m.automated_messages} automated messages × ${v(m.minutes_per_chase, ' min')} baseline`], ['Verified closure time (median)', v(m.median_closure_hours, ' h'), `${m.verified_closures} verified closures`], ['Closed with accepted evidence', `${m.closures_with_evidence} of ${m.verified_closures}`, 'Field-based checks reference the worker record'], ['False findings', `${m.false_findings} of ${m.findings_reviewed} reviewed`, 'Marked by the responsible owner'], ['Unknown results', m.unknown_results, 'Current checks that cannot be proven yet'], ['Duplicate actions blocked', m.duplicates_blocked, `${m.duplicate_messages_sent} duplicate messages actually sent`], ['Onboarding effort', v(m.onboarding_minutes, ' min'), 'Tenant created to first assessment'], ['Manual support', `${m.manual_support_minutes} min`, 'Logged by the delivery team'], ['AI usage (operating cost input)', `${m.llm_calls} calls, ${m.llm_tokens} tokens`, 'Add messaging and hosting costs separately']];
    return h`<div class="stack">${card('Pilot Scorecard', 'Internal success proves function. External paying customers must still prove demand.', table(['Measure', 'Result', 'Basis'], rows.map((r) => h`<tr><td><strong>${r[0]}</strong></td><td>${r[1]}</td><td class="muted">${r[2]}</td></tr>`), ''))}
    <div class="grid-2"><form class="plain-card" data-form="baseline"><strong>Set baseline</strong><p class="muted small">Measure how long a person takes to chase one document.</p><div class="form-group mt"><label class="form-label">Minutes per manual chase</label><input name="value" type="number" min="0" step="0.5" class="form-select" value="${m.minutes_per_chase ?? ''}" required></div><button class="btn-submit-green">Save</button></form>
    <form class="plain-card" data-form="manualSupport"><strong>Log manual support</strong><p class="muted small">Time your team spent helping this tenant.</p><div class="form-group mt"><label class="form-label">Minutes</label><input name="minutes" type="number" min="1" class="form-select" required></div><div class="form-group"><label class="form-label">What was done</label><input name="note" class="form-select"></div><button class="btn-submit-green">Log time</button></form></div></div>`;
  },
  async audit() {
    scope(null);
    if (!me.user.is_admin) return h`<div class="plain-card empty">The audit trail is available to administrators.</div>`;
    const rows = await api('/api/audit'), v = await api('/api/audit/verify');
    return card('Audit Log', `${v.entries} entries. Chain ${v.ok ? 'verified' : `broken at entry ${v.broken_at_seq}`}.`, table(['Time (UTC)', 'Event', 'Subject', 'Action', 'Actor', 'Hash'], rows.map((a) => h`<tr><td class="mono">${dt(a.ts)}</td><td><span class="priority-pill pill-low">${a.type}</span></td><td><strong>${a.subject}</strong></td><td>${a.action}</td><td class="text-muted">${a.actor}</td><td class="mono" title="${a.hash}">${a.hash.slice(0, 10)}…</td></tr>`), ['No entries yet', 'Every check, request and decision is recorded here.']), h`<span class="pill ${v.ok ? 'pill-pass' : 'pill-fail'}">${v.ok ? 'Chain verified' : 'Chain broken'}</span><a class="btn-card-outline" href="/api/audit/export" download>Export JSON</a>`);
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
    toast(via === 'slack' ? 'Digest posted to Slack.' : 'Digest saved to the Aegis outbox.', 'success');
  },
  viewNotice(el) { openModal('Draft response', 'For finance review. Aegis does not file or send this.', h`<div style="white-space:pre-wrap;font-size:12px">${el.dataset.text}</div>`); },
  newView() {
    openModal('New view', 'Pick what to count and how to group it. It updates by itself as checks change.', h`<form data-form="dashboard">
      <div class="form-group"><label class="form-label" for="nvName">Name</label><input id="nvName" name="name" class="form-select" required maxlength="120" placeholder="For example: Healthcare gaps by facility"></div>
      <div class="form-grid">
        <div class="form-group"><label class="form-label" for="nvMetric">Show</label><select id="nvMetric" name="metric" class="form-select" data-view-metric><option value="open_gaps">Open gaps (fail or unknown)</option><option value="missing_evidence">Missing documents</option><option value="expirations">Expiring credentials (next 90 days)</option><option value="coverage">All applicable checks</option></select></div>
        <div class="form-group"><label class="form-label" for="nvPack">Pack</label><select id="nvPack" name="pack" class="form-select"><option value="">All packs</option>${['healthcare', 'onboarding', 'immigration', 'payroll'].map((k) => h`<option value="${k}">${words(k)}</option>`)}</select></div>
        <div class="form-group"><label class="form-label" for="nvGroup">Group by</label><select id="nvGroup" name="group_by" class="form-select"><option value="facility">Facility</option><option value="team">Team</option><option value="pack">Pack</option><option value="status">Result</option><option value="control">Requirement</option><option value="window" hidden disabled>Time left</option></select></div>
      </div>
      <p class="muted small">People with your role and administrators can open it.</p>
      <button class="btn-submit-green">Save view</button></form>`);
  },
  deleteView(el) {
    openModal(`Delete "${el.dataset.name}"?`, 'Only this saved view is removed. No checks, cases or records change.', '', h`<button class="btn-cancel" data-act="closeModal">Cancel</button><button class="btn-danger" data-act="confirmDeleteView" data-id="${el.dataset.id}">Delete view</button>`);
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
  async notice(d) { await api('/api/notices', d); toast('Draft created and sent to Approvals.', 'success'); refresh(); },
  async baseline(d) { await api('/api/metrics/baseline', { key: 'minutes_per_chase', value: d.value }); toast('Baseline saved.', 'success'); refresh(); },
  async manualSupport(d) { await api('/api/metrics/manual-support', d); toast('Logged.', 'success'); refresh(); },
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
window.addEventListener('hashchange', readHash);
fetch('/api/me').then((r) => { if (r.ok) boot(); else showLogin(); });
