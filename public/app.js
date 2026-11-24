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
  const sheet = $('#sheet'), menu = $('#menu');
  if (sheet.open === open) return;
  if (open) {
    closeAllDirMenus();
    sheet.showModal();
    const current = sheet.querySelector('[aria-current="page"]');
    (current?.getClientRects().length ? current : sheet.querySelector('.rail-link.is-section') || $('#closeNavigation')).focus();
  } else {
    sheet.close();
  }
  menu.setAttribute('aria-expanded', String(open));
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

// Side menu icons: Lucide (lucide.dev), drawn at 16 px with a 1.6 stroke. Each one says what the page is for.
const I = {
  overview: '<path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/><path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  cases: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  approvals: '<path d="M5 22h14"/><path d="M19.27 13.73A2.5 2.5 0 0 0 17.5 13h-11A2.5 2.5 0 0 0 4 15.5V17a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-1.5c0-.66-.26-1.3-.73-1.77Z"/><path d="M14 13V8.5C14 7 15 7 15 5a3 3 0 0 0-3-3c-1.66 0-3 1-3 3s1 2 1 3.5V13"/>',
  evidence: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="m9 15 2 2 4-4"/>',
  notices: '<path d="M3 22h18"/><path d="M6 18v-7"/><path d="M10 18v-7"/><path d="M14 18v-7"/><path d="M18 18v-7"/><path d="M12 2 20 7H4z"/>',
  workers: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  checks: '<path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/>',
  packs: '<path d="m7.5 4.27 9 5.15"/><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
  controls: '<path d="m16 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z"/><path d="m2 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z"/><path d="M7 21h10"/><path d="M12 3v18"/><path d="M3 7h2c2 0 5-1 7-2 2 1 5 2 7 2h2"/>',
  dashboards: '<rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/>',
  reports: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M8 18v-2"/><path d="M12 18v-6"/><path d="M16 18v-4"/>',
  audit: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
  metrics: '<path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>',
  setup: '<path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z"/><path d="M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2"/><path d="M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2"/><path d="M10 6h4"/><path d="M10 10h4"/><path d="M10 14h4"/><path d="M10 18h4"/>',
  integrations: '<path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"/>',
  settings: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
};
// Daily work first and without a heading, then records, then reporting. Organisation pages are
// used mostly during setup, so they sit at the bottom of the menu, out of the way.
const NAV = [
  ['', [['overview', 'Overview'], ['cases', 'Cases'], ['approvals', 'Approvals'], ['evidence', 'Evidence'], ['notices', 'Tax notices']]],
  ['Records', [['workers', 'Workers'], ['checks', 'Checks'], ['packs', 'Compliance packs'], ['controls', 'Control rules']]],
  ['Reporting', [['dashboards', 'Dashboards'], ['reports', 'Reports'], ['audit', 'Audit history'], ['metrics', 'Pilot metrics']]],
];
const NAV_ORG = [['setup', 'Company setup'], ['integrations', 'Connections'], ['settings', 'Settings']];
// Dashboards opens to its standard views (the ids match the built-in dashboards on the server).
const DASH_VIEWS = [['builtin-readiness', 'Readiness'], ['builtin-expiring', 'Expiring soon'], ['builtin-gaps', 'Open gaps'], ['builtin-missing', 'Missing documents'], ['builtin-coverage', 'Coverage']];
const HEAD = { overview: ['Workspace', 'Overview', 'Current status across activated packs, accepted evidence and open remediation.'], setup: ['Organization', 'Company setup', 'Get your organisation ready: bring in your people, confirm requirements, and run the first check.'], cases: ['Workspace', 'Cases', 'Each gap moves from identified to closed. Only accepted evidence closes a case.'], approvals: ['Workspace', 'Approvals', 'Consequential actions wait here for an authorized person.'], evidence: ['Workspace', 'Evidence', 'AI proposes matches and fields. Uncertain documents go to a person.'], checks: ['Records', 'Checks', 'Every result has a reason, evidence references and a control version.'], workers: ['Records', 'Workers', 'Per-pack status for each worker. One pack never hides another.'], packs: ['Records', 'Compliance packs', 'Versioned packs reviewed and activated by an authorized person.'], controls: ['Records', 'Control rules', 'Draft, preview and approve changes before they take effect.'], integrations: ['Organization', 'Connections', 'Manage workforce sync, reporting channels, and message delivery.'], dashboards: ['Reporting', 'Dashboards', 'Readiness, expirations and gaps, counted from current checks.'], reports: ['Reporting', 'Reports', 'Reports to share with clients, auditors and managers.'], notices: ['Workspace', 'Tax notices', 'Letters from tax agencies and the replies Finance approves.'], metrics: ['Reporting', 'Pilot metrics', 'How the pilot is going, measured from Aegis records.'], audit: ['Reporting', 'Audit history', 'Every check, request and decision, in order. Entries cannot be edited or deleted.'], settings: ['Organization', 'Settings', 'Users, roles, reporting channel and schedules.'] };

// Ticked cases on the Cases page (ids). Cleared when the tab or page changes.
const caseSel = new Set();
let lastCaseCheck = null;
let caseClosed = false, me = null, route = 'overview', routeArg = null, checkFilter = {}, evidenceSel = null, lastDraft = null, importPreview = null;
// Evidence uploaded in this browser session, marked New in the inbox until the page is reloaded.
const recentUploads = new Set();
let navigation = 0;
// The company's locations, from the last Setup or Workers page, for the location suggestions.
let knownLocations = [];
const rememberLocations = (list) => {
  const seen = new Map(knownLocations.map((f) => [f.name, f]));
  for (const f of list) if (f?.name) seen.set(f.name, { name: f.name, state: f.state || '' });
  knownLocations = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
};
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
  resetChat();
  renderTop();
  renderNav();
  renderVerificationNotice();
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
  const tenantAvatar = $('#tenantAvatar'); if (tenantAvatar) tenantAvatar.textContent = badgeInitials(me.tenant?.name || 'Aegis');
  const tenantName = $('#tenantName'); if (tenantName) tenantName.textContent = me.tenant?.name || 'Aegis';
  const tenantStatus = $('#tenantStatus');
  tenantStatus.hidden = !me.demo && !me.sandbox;
  tenantStatus.textContent = me.sandbox ? 'Sandbox' : 'Demo data';
  tenantStatus.title = me.sandbox ? 'A practice workspace. Messages stay in Aegis.' : 'This workspace holds sample people and records.';
  $('#meMenuAvatar').textContent = badgeInitials(me.user.name || '?');
  $('#meMenuName').textContent = me.user.name || 'User';
  $('#meMenuEmail').textContent = me.user.email || '';
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

// ---------- Side menu ----------
// Counts come from /api/nav and are counted exactly as the page they open. Only things waiting on
// this person get a tinted badge; plain totals are grey numbers; Company setup gets a dot when
// something needs fixing.
let navCounts = {}, navCountsLoading = false;
let dashboardViewsOpen = false;
const NAV_COUNT_WORDS = { cases: 'open', approvals: 'waiting for you', evidence: 'to review', notices: 'waiting' };
const navIcon = (key) => raw(`<svg class="rail-icon" aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${I[key]}</svg>`);
const caretSvg = '<svg class="rail-caret" aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';
function navMeta(key) {
  const n = navCounts[key];
  if (key === 'setup') return n ? h`<span class="rail-dot" aria-hidden="true"></span><span class="visually-hidden">, ${plural(n, 'thing')} to fix</span>` : '';
  if (!n || !NAV_COUNT_WORDS[key]) return '';
  return h`<span class="rail-count${key === 'approvals' ? ' is-yours' : ''}" aria-hidden="true">${n}</span><span class="visually-hidden">, ${n} ${NAV_COUNT_WORDS[key]}</span>`;
}
const canOpen = (key) => (me.user.is_admin || !adminRoutes.has(key)) && (key !== 'notices' || canFinance());
const navLink = (key, label) => h`<a class="rail-link" href="#${key}" data-key="${key}" data-label="${label}">${navIcon(key)}<span class="rail-label">${label}</span><span class="rail-meta">${navMeta(key)}</span></a>`;
function setDashboardViewsOpen(open) {
  dashboardViewsOpen = open;
  for (const tree of document.querySelectorAll('.rail-tree')) {
    const toggle = tree.querySelector('.rail-disclosure');
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', open ? 'Collapse dashboard views' : 'Expand dashboard views');
    tree.querySelector('.rail-sub').hidden = !open;
  }
}
function renderNav() {
  setRailCollapsed(document.documentElement.classList.contains('rail-collapsed'), false);
  const groups = (navId) => NAV.map(([group, items]) => {
    const visible = items.filter(([key]) => canOpen(key));
    if (!visible.length) return '';
    const viewId = navId + '-dashboard-views';
    const links = visible.map(([key, label]) => (key === 'dashboards'
      ? h`<div class="rail-tree"><div class="rail-tree-head">${navLink(key, label)}<button type="button" class="rail-disclosure" aria-controls="${viewId}">${raw(caretSvg)}</button></div><div class="rail-sub" id="${viewId}" role="group" aria-label="Dashboard views" hidden>${DASH_VIEWS.map(([id, name]) => h`<a class="rail-sublink" href="#dashboards/${id}">${name}</a>`)}</div></div>`
      : navLink(key, label)));
    const titleId = group ? navId + '-' + group.toLowerCase() : '';
    return group
      ? h`<section class="rail-group" aria-labelledby="${titleId}"><h2 class="rail-group-title" id="${titleId}">${group}</h2>${links}</section>`
      : h`<section class="rail-group" aria-label="Daily work">${links}</section>`;
  });
  const org = NAV_ORG.filter(([key]) => canOpen(key)).map(([key, label]) => navLink(key, label));
  $('#tabs').innerHTML = render(groups('tabs'));
  $('#tabsOrg').innerHTML = render(org);
  // The phone menu is one list: daily work, records, reporting, then the organisation pages.
  $('#sheetIn').innerHTML = render(h`${groups('sheetIn')}${org.length ? h`<section class="rail-group rail-group-org" aria-label="Organisation">${org}</section>` : ''}`);
  setDashboardViewsOpen(dashboardViewsOpen);
  syncNav();
}
// Marks the current page without changing the dashboard disclosure.
function syncNav() {
  for (const nav of document.querySelectorAll('.rail-nav, .rail-org')) {
    for (const a of nav.querySelectorAll('[aria-current]')) a.removeAttribute('aria-current');
    for (const a of nav.querySelectorAll('.is-section')) a.classList.remove('is-section');
    const main = nav.querySelector(`.rail-link[href="#${route}"]`);
    const sub = route === 'dashboards' && routeArg ? nav.querySelector(`.rail-sublink[href="#dashboards/${CSS.escape(routeArg)}"]`) : null;
    const current = sub || main;
    if (!current) continue;
    current.setAttribute('aria-current', 'page');
    if (sub) main?.classList.add('is-section');
    if (nav.clientHeight) (current.getClientRects().length ? current : main)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
}
// Refreshes the counts in place, so keyboard focus in the menu is never lost.
async function loadNavCounts() {
  if (navCountsLoading || !me?.user) return;
  navCountsLoading = true;
  try {
    navCounts = await api('/api/nav');
    for (const a of document.querySelectorAll('.rail-link[data-key]')) {
      const slot = a.querySelector('.rail-meta');
      if (slot) slot.innerHTML = render(navMeta(a.dataset.key));
    }
  } catch { /* the counts are a convenience; the page itself still loads */ } finally { navCountsLoading = false; }
}
// Collapsed sidebar: a 60 px icon rail. The choice is remembered on this device only.
const RAIL_KEY = 'aegis.sidebar.collapsed';
function setRailCollapsed(collapsed, remember = true) {
  // The width animates only when someone toggles it, never on page load.
  if (remember) document.documentElement.classList.add('rail-ready');
  document.documentElement.classList.toggle('rail-collapsed', collapsed);
  const toggle = $('.rail-toggle');
  if (toggle) { toggle.setAttribute('aria-expanded', String(!collapsed)); toggle.setAttribute('aria-label', collapsed ? 'Expand sidebar' : 'Collapse sidebar'); }
  hideRailTip();
  if (remember) { try { localStorage.setItem(RAIL_KEY, collapsed ? '1' : '0'); } catch { /* private mode: not remembered */ } }
}
try { if (localStorage.getItem(RAIL_KEY) === '1') document.documentElement.classList.add('rail-collapsed'); } catch { /* not remembered */ }
// In the collapsed rail each icon names itself (and its count) beside the pointer or keyboard focus.
function showRailTip(el) {
  const tip = $('#railTip');
  if (!tip || !document.documentElement.classList.contains('rail-collapsed')) return;
  const n = el.dataset.key && navCounts[el.dataset.key];
  tip.innerHTML = render(h`${el.dataset.label}${n && el.dataset.key !== 'setup' ? h`<b>${n}</b>` : ''}${n && el.dataset.key === 'setup' ? h`<b>${plural(n, 'thing')} to fix</b>` : ''}`);
  const r = el.getBoundingClientRect();
  tip.hidden = false;
  tip.style.top = `${Math.round(r.top + r.height / 2)}px`;
  tip.style.left = `${Math.round(r.right + 10)}px`;
}
function hideRailTip() { const tip = $('#railTip'); if (tip) tip.hidden = true; }
document.addEventListener('pointerover', (ev) => { const el = ev.target.closest?.('.workspace-rail [data-label]'); if (el) showRailTip(el); else hideRailTip(); });
document.addEventListener('focusin', (ev) => { const el = ev.target.closest?.('.workspace-rail [data-label]'); if (el && el.matches(':focus-visible')) showRailTip(el); else hideRailTip(); });
document.addEventListener('scroll', hideRailTip, true);

function readHash() {
  if (!me) {
    if (location.hash === '#signup' && signupEnabled && $('#loginScreen .main-desk') && !$('#signup-form')) renderSignup();
    else if (location.hash !== '#signup' && $('#signup-form')) showLogin();
    return;
  }
  const [page, argument] = location.hash.slice(1).split('/');
  if (page === 'verify-email' && argument) {
    history.replaceState(null, '', '#setup');
    go('setup');
    showVerifyEmail(argument);
    return;
  }
  go(Object.hasOwn(VIEWS, page) ? page : 'overview', argument || null);
}

function renderVerificationNotice() {
  const banner = $('#workspaceVerification');
  const verification = me.workspace_email;
  banner.hidden = !verification?.pending;
  banner.innerHTML = !verification?.pending ? '' : render(h`
    <div><strong>Confirm your work email</strong>
      <p>${verification.can_verify ? h`A verification email for <b>${me.user.email}</b> is in your sandbox inbox.` : 'Ask the first workspace administrator to confirm their work email.'}
        You can add workers, import a roster, and run checks in validation mode. Connections and follow-ups require verification.</p>
    </div>
    ${verification.can_verify ? h`<div class="verification-actions"><button class="btn" data-act="openVerificationInbox">Open sandbox inbox</button><button class="btn-link-action" data-act="resendVerification">Resend email</button></div>` : ''}
  `);
}

function showVerifyEmail(token) {
  openModal('Confirm your work email', 'Verify the email for this workspace.', h`
    <p>You’re signed in as <b>${me.user.email}</b>.</p>
    <p id="verify-error" class="signup-error" role="alert"></p>
  `, h`<button class="btn primary" id="confirm-verification">Confirm email</button>`);
  const button = $('#confirm-verification');
  button.onclick = async () => {
    button.disabled = true;
    try {
      await api('/api/verify-email', { token });
      closeModal();
      await boot();
      toast('Work email confirmed.', 'success');
    } catch (err) {
      const error = $('#verify-error');
      if (error) error.textContent = err.message;
    } finally { button.disabled = false; }
  };
}

// Due-date views of the Cases page (#cases/overdue, #cases/week). The Overview counts link here,
// so each count matches the list it opens. Any other #cases/<id> opens that case.
const isOverdue = (c) => (daysFromToday(c.due_date) ?? 1) < 0;
const isDueThisWeek = (c) => { const n = daysFromToday(c.due_date); return n !== null && n >= 0 && n <= 7; };
const CASE_DUE = { overdue: ['Overdue', isOverdue], week: ['Due this week', isDueThisWeek] };
async function go(r, arg = null, keep) {
  const version = ++navigation;
  if (!keep && r !== route) { $('#globalSearch').value = ''; caseSel.clear(); closeChat(false); }
  if (!keep && r === 'dashboards' && (r !== route || arg !== routeArg)) setDashboardViewsOpen(true);
  route = r; routeArg = arg;
  closeAllDirMenus();
  setNavigationOpen(false);
  syncNav();
  if (r !== 'overview') {
    const alertEl = $('#alert');
    if (alertEl) { alertEl.hidden = true; alertEl.innerHTML = ''; }
  }
  const [, t, d] = HEAD[r] || ['', words(r), ''];
  $('#crumb').hidden = true;
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
    if (r === 'integrations') filterOutbox();
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
  // Every page load and every refresh after an action brings the menu counts up to date.
  loadNavCounts();
  if (r === 'cases' && arg && !CASE_DUE[arg] && !keep) {
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
  const needsEmail = me.workspace_email?.pending;
  rememberLocations(s.facilities);
  // Gaps on records and context are problems to fix; the packs note is guidance, so it reads as information.
  // A gap about people names them; workers without a location get a button that sets it.
  const SHOWN = 5;
  const gapPeople = (g) => {
    if (!g.workers?.length) return '';
    const fix = g.kind === 'no_location' && canEdit();
    if (g.workers.length === 1 && !fix) return '';
    const shown = g.workers.slice(0, SHOWN), more = g.workers.length - shown.length;
    return h`<ul class="gap-people">${shown.map((w) => h`<li><button class="btn-link-action" data-act="workerDetail" data-id="${w.id}">${w.name}</button>${fix ? h`<button class="btn-card-outline" data-act="moveWorker" data-id="${w.id}" data-title="Set work location for ${w.name}">Set location</button>` : ''}</li>`)}${more ? h`<li><a class="btn-link-action" href="#workers">${plural(more, 'more worker')} on the Workers page</a></li>` : ''}</ul>`;
  };
  const gapNote = (k, info) => (gapsFor(k).length ? h`<div class="setup-note${info ? ' is-info' : ''}"><b>${info ? 'Good to know' : gapsFor(k).length === 1 ? 'One thing to fix' : `${gapsFor(k).length} things to fix`}</b><ul>${gapsFor(k).map((g) => h`<li>${g.text}${gapPeople(g)}</li>`)}</ul></div>` : '');
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
      summary: st.connect ? `${plural(s.summary.workers, 'worker')}, ${plural(s.summary.facilities, 'location')} and ${plural(s.summary.entities, 'employing entity', 'employing entities')}${cons.length ? `, from ${cons.map((c) => c.name).join(' and ')}` : ''}.` : needsEmail ? 'Import a spreadsheet or add people one by one.' : 'Connect your HR system, import a spreadsheet, or add people one by one.',
      body: h`<dl class="report-figures setup-figures"><div><dt>Workers</dt><dd>${s.summary.workers}</dd></div><div><dt>Locations</dt><dd>${s.summary.facilities}</dd></div><div><dt>Employing entities</dt><dd>${s.summary.entities}</dd></div></dl>
        <h4 class="setup-sub">Where your records come from</h4>
        ${cons.length ? h`<ul class="source-list">${cons.map((c) => { const [cls, label] = conState(c); return h`<li><span class="source-name">${c.name}<small>${words(c.type)} connection</small></span><span class="pill ${cls}">${label}</span><span class="source-meta">${c.last_sync_at ? `Last synced ${dt(c.last_sync_at)} UTC` : 'Not synced yet'}${c.records ? `, ${plural(c.records, 'record')}` : ''}</span></li>`; })}</ul>` : h`<p class="setup-text">No system is connected. ${needsEmail ? 'Confirm your work email before connecting your HR system.' : s.summary.workers ? 'Records were added by spreadsheet or by hand.' : 'Connect your HR system to keep records up to date automatically.'}</p>`}
        ${fromLine ? h`<p class="setup-text muted">Workers: ${fromLine}.</p>` : ''}
        ${gapNote('records')}
        <div class="setup-actions">${needsEmail ? '' : h`<a class="${!cons.length && !st.connect ? 'btn-submit-green' : 'btn-card-outline'}" href="#integrations">${cons.length ? 'Manage connections' : 'Connect a system'}</a>`}<button class="${needsEmail ? 'btn-submit-green' : 'btn-card-outline'}" data-act="importRoster">Import a spreadsheet</button><button class="btn-link-action" data-act="addWorker">Add a worker</button></div>`,
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
          <label class="choice${s.slack_ready ? '' : ' is-disabled'}"><input type="radio" name="type" value="slack" ${s.channel.type === 'slack' ? raw('checked') : ''} ${s.slack_ready ? '' : raw('disabled')}><span><b>Slack</b><small>${needsEmail ? 'Confirm your work email before connecting Slack.' : s.slack_ready ? 'Digests and alerts are posted to the channel below.' : h`Connect Slack first in <a href="#integrations">Connections</a>.`}</small></span></label>
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
  MESSAGE_SENT: 'Message', DIGEST_SENT: 'Digest posted', DIGEST_OUTBOX: 'Digest saved', DIGEST_FAILED: 'Digest failed', CHAT_COMMAND: 'Coworker request', COWORKER_POLICY_UPDATED: 'Coworker policy updated',
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
  const c = $('#crumb');
  c.innerHTML = render(h`<a href="${href}">Back to ${crumb}</a>`);
  c.hidden = false;
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
// ---------- Users ----------
// The roles, named as the server names them, in the order people usually choose them.
const ROLES = [['admin', 'Administrator'], ['hr', 'HR'], ['healthcare_compliance', 'Healthcare compliance'], ['immigration_owner', 'Immigration owner'], ['finance', 'Payroll / finance'], ['viewer', 'Read only']];
const roleName = (k) => ROLES.find(([key]) => key === k)?.[1] || words(k);
const PW_HINT = 'At least 12 characters. A short sentence is easy to remember and hard to guess.';

// ---------- Overview ----------
// Priority cases on the Overview: everyone's (false) or only the signed-in person's (true).
let ovMine = false;
// Approval types in plain words, for the "Approvals waiting for you" line. Each pluralises with an s.
const APPROVAL_KIND = { action: 'outgoing message', assignment_review: 'assignment review', readiness_decision: 'readiness decision', notice_response: 'notice reply', control_activation: 'rule change' };
// The sentence under the Overview title: what fails, what cannot be proven yet and why, who can start.
const WHY_PHRASE = { document: 'mostly because documents haven’t arrived', review: 'mostly because documents are waiting for review', details: 'mostly because worker or location details are missing' };
function ovSummary({ coverage: c, fail_people: people, unknown_reasons: why, readiness: rd }) {
  if (!c.total) return h`No checks have run yet. Activate a compliance pack in Company setup to start.`;
  const top = Object.entries(why).filter(([k]) => k !== 'other').sort((a, b) => b[1] - a[1])[0];
  const reason = top && top[1] > c.unknown / 2 ? `, ${WHY_PHRASE[top[0]]}` : '';
  const ready = rd.total ? h` <b>${rd.approved} of ${rd.total}</b> ${rd.total === 1 ? 'worker is' : 'workers are'} cleared to start.` : '';
  if (!c.fail && !c.unknown) return h`<b class="ovx-t-pass">All ${plural(c.total, 'applicable check')} pass.</b>${ready}`;
  const fail = c.fail ? h`<b class="ovx-t-fail">${plural(c.fail, 'check')} ${c.fail === 1 ? 'fails' : 'fail'}</b> for ${plural(people, 'person', 'people')}` : '';
  const unknown = c.unknown ? h`<b class="ovx-t-warn">${c.unknown} can’t be proven yet</b>${reason}` : '';
  return h`${fail}${c.fail && c.unknown ? ', and ' : ''}${unknown}.${ready}`;
}
const VIEWS = {
  // Overview: one answer at the top, then what needs you, readiness, coverage with its reasons,
  // priority cases, renewals, packs and (for administrators) recent activity. Every number links to
  // the list it was counted from, and no number is shown twice.
  async overview() {
    const [report, health, openCases] = await Promise.all([
      api('/api/overview'),
      me.user.is_admin ? api('/api/health') : null,
      api('/api/cases'),
    ]);
    const { coverage: cov, kpi, packs, readiness: rd, unknown_reasons: why, trend, expiring_detail: exp, attention, feed } = report;
    const failedConnector = health?.connectors?.find((connector) => connector.last_error);
    const alert = $('#alert');
    if (alert) {
      alert.hidden = !failedConnector;
      alert.innerHTML = failedConnector ? render(h`<p><b>${failedConnector.name}</b> needs attention. ${failedConnector.last_error}</p><a class="btn" href="#integrations">Review connection</a>`) : '';
    }
    const subtitle = $('#scope');
    if (subtitle) subtitle.innerHTML = render(ovSummary(report));
    const go = raw('<svg class="ovx-go" aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>');
    const head = (title, sub, tools) => h`<header class="ovx-head"><div><h2>${title}</h2><p>${sub}</p></div>${tools || ''}</header>`;
    const more = (href, label) => h`<a class="ovx-link" href="${href}">${label} <span aria-hidden="true">→</span></a>`;

    // Needs your attention: only rows with something in them, most urgent first.
    const overdue = openCases.filter(isOverdue).sort((a, b) => (a.due_date < b.due_date ? -1 : 1));
    const thisWeek = openCases.filter(isDueThisWeek).sort((a, b) => (a.due_date < b.due_date ? -1 : 1));
    const kinds = Object.entries(attention.approvals_by_kind).map(([k, n]) => plural(n, APPROVAL_KIND[k] || words(k).toLowerCase()));
    const dayWord = (d) => { const n = daysFromToday(d); return n === 0 ? 'today' : n === 1 ? 'tomorrow' : date(d); };
    const rows = [
      { n: overdue.length, tone: 'fail', what: overdue.length === 1 ? 'Case overdue' : 'Cases overdue', href: '#cases/overdue',
        why: overdue[0] && `Oldest: ${overdue[0].control_name}, ${plural(-daysFromToday(overdue[0].due_date), 'day')} late` },
      { n: kpi.pending_approvals, tone: 'warn', what: kpi.pending_approvals === 1 ? 'Approval waiting for you' : 'Approvals waiting for you', href: '#approvals', why: kinds.join(', ') },
      { n: kpi.expiring, tone: 'warn', what: kpi.expiring === 1 ? 'Credential to renew' : 'Credentials to renew', href: '#dashboards/builtin-expiring',
        why: [exp.expired && `${exp.expired} already expired`, exp.d30 && `${exp.expired ? `${exp.d30} more` : exp.d30} within 30 days`].filter(Boolean).join(', ') || 'Within the next 90 days' },
      { n: attention.review, tone: 'info', what: attention.review === 1 ? 'Document to review' : 'Documents to review', href: '#evidence',
        why: attention.review_oldest && `Waiting since ${date(attention.review_oldest)}` },
      { n: thisWeek.length, tone: 'na', what: thisWeek.length === 1 ? 'Case due this week' : 'Cases due this week', href: '#cases/week',
        why: thisWeek[0] && `Next one due ${dayWord(thisWeek[0].due_date)}` },
    ].filter((r) => r.n);
    const attentionPanel = h`<section class="ovx-panel ovx-7" aria-labelledby="ovxAttention">
      ${head(h`<span id="ovxAttention">Needs your attention</span>`, rows.length ? 'Waiting on you, most urgent first' : 'Nothing is waiting on you')}
      ${rows.length ? h`<ul class="ovx-att">${rows.map((r, i) => h`<li><a href="${r.href}" class="${i === 0 && r.tone === 'fail' ? 'is-urgent' : ''}"><i class="ovx-dot is-${r.tone}" aria-hidden="true"></i><b class="ovx-n">${r.n}</b><span class="ovx-what"><b>${r.what}</b>${r.why ? h`<span>${r.why}</span>` : ''}</span>${go}</a></li>`)}</ul>`
        : h`<p class="ovx-clear"><i class="ovx-dot is-pass" aria-hidden="true"></i>No overdue cases, approvals, renewals or documents waiting.</p>`}
    </section>`;

    // Readiness: the Readiness dashboard's numbers, and who is closest to being cleared.
    const seg = (n, cls) => (n ? h`<i class="${cls}" style="flex:${n}"></i>` : '');
    const readinessPanel = h`<section class="ovx-panel ovx-5" aria-labelledby="ovxReady">
      ${head(h`<span id="ovxReady">Assignment readiness</span>`, 'Who can start work', more('#dashboards/builtin-readiness', 'Open readiness'))}
      ${rd.total ? h`<div class="ovx-ready">
        <p class="ovx-headline">${rd.approved} cleared <span>of ${plural(rd.total, 'active worker')}</span></p>
        <div class="ovx-stack" role="img" aria-label="${`${rd.approved} cleared, ${rd.pending} waiting, ${rd.blocked} blocked`}">${seg(rd.approved, 'is-pass')}${seg(rd.pending, 'is-warn')}${seg(rd.blocked, 'is-fail')}</div>
        <ul class="ovx-legend-rows">
          <li><i class="ovx-dot is-pass" aria-hidden="true"></i>Cleared to start<b>${rd.approved}</b></li>
          <li><i class="ovx-dot is-warn" aria-hidden="true"></i>Waiting<b>${rd.pending}</b></li>
          <li><i class="ovx-dot is-fail" aria-hidden="true"></i>Blocked by an owner<b>${rd.blocked}</b></li>
        </ul>
        ${rd.closest.length ? h`<div class="ovx-closest"><h3>Closest to clearing</h3>${rd.closest.map((w) => h`<p><span><button type="button" class="ovx-name" data-act="workerDetail" data-id="${w.subject_id}">${w.subject}</button> ${w.open ? `needs ${w.control || 'a document'}${w.open > 1 ? ` and ${w.open - 1} more` : ''}` : 'is ready for a decision'}</span>${w.open && w.control_key && canEdit() ? h`<button type="button" class="ovx-act" data-act="uploadEvidence" data-subject="worker:${w.subject_id}" data-control="${w.control_key}" data-name="${w.subject}">Upload</button>` : !w.open ? h`<button type="button" class="ovx-act" data-act="workerDetail" data-id="${w.subject_id}">Review</button>` : ''}</p>`)}</div>` : ''}
      </div>` : h`<p class="ovx-clear">No active workers yet. Add people in Company setup.</p>`}
    </section>`;

    // Coverage: the share that passes, how it has moved, and why the unknown checks are unknown.
    const pct = cov.total ? Math.round((cov.pass / cov.total) * 100) : 0;
    const known = trend.points.filter((p) => p.pct !== null);
    const spark = () => {
      const lo = Math.min(...known.map((p) => p.pct)), hi = Math.max(...known.map((p) => p.pct)), span = hi - lo || 1;
      const pts = trend.points.map((p, i) => (p.pct === null ? null : [2 + (i * 92) / (trend.points.length - 1), 22 - ((p.pct - lo) / span) * 16])).filter(Boolean);
      const last = pts.at(-1);
      return raw(`<svg class="ovx-spark is-${trend.change > 0 ? 'up' : trend.change < 0 ? 'down' : 'flat'}" aria-hidden="true" width="96" height="26" viewBox="0 0 96 26" fill="none"><polyline points="${pts.map((p) => p.map((v) => v.toFixed(1)).join(',')).join(' ')}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="2.6" fill="currentColor"/></svg>`);
    };
    const trendNote = known.length > 1 && trend.change !== null
      ? h`<div class="ovx-trend">${spark()}<div><b class="${trend.change > 0 ? 'is-up' : trend.change < 0 ? 'is-down' : ''}">${trend.change > 0 ? '+' : ''}${trend.change === 0 ? 'No change' : `${trend.change} points`}</b><span>${trend.since === trend.points[0].date ? 'in the last 30 days' : `since ${date(trend.since)}`}</span></div></div>`
      : h`<p class="ovx-trend-wait">The trend appears once checks have run on more than one day.</p>`;
    const WHY = [
      ['document', 'Waiting for a document', '#dashboards/builtin-missing', 'Missing documents'],
      ['review', 'Need a person to review', '#evidence', 'Review evidence'],
      ['details', 'Missing worker or location details', me.user.is_admin ? '#setup' : '#workers', me.user.is_admin ? 'Company setup' : 'Workers'],
      ['other', 'Other reasons', '#checks', 'View checks'],
    ].filter(([k]) => why[k]);
    const coveragePanel = h`<section class="ovx-panel ovx-12" aria-labelledby="ovxCov">
      ${head(h`<span id="ovxCov">Verification coverage</span>`, `Every applicable check across ${plural(packs.length, 'active pack')}`, more('#checks', 'View checks'))}
      ${cov.total ? h`<div class="ovx-cov">
        <div class="ovx-score"><p class="ovx-pct">${pct}%<small>of ${plural(cov.total, 'check')} pass</small></p>${trendNote}</div>
        <div>
          <div class="ovx-bar" role="img" aria-label="${`${cov.pass} pass, ${cov.fail} fail, ${cov.unknown} unknown`}">${seg(cov.pass, 'is-pass')}${seg(cov.fail, 'is-fail')}${seg(cov.unknown, 'is-warn')}</div>
          <div class="ovx-legend"><span><i class="ovx-dot is-pass" aria-hidden="true"></i>Pass <b>${cov.pass}</b></span><span><i class="ovx-dot is-fail" aria-hidden="true"></i>Fail <b>${cov.fail}</b></span><span><i class="ovx-dot is-warn" aria-hidden="true"></i>Unknown <b>${cov.unknown}</b></span></div>
          ${WHY.length ? h`<h3 class="ovx-why-title">Why ${plural(cov.unknown, 'check is', 'checks are')} unknown</h3><div class="ovx-why">${WHY.map(([k, label, href, link]) => h`<a href="${href}"><b>${why[k]}</b><span>${label}</span><small>${link} →</small></a>`)}</div>`
            : h`<p class="ovx-clear"><i class="ovx-dot is-pass" aria-hidden="true"></i>Every check has a clear result.</p>`}
        </div>
      </div>` : h`<p class="ovx-clear">No checks yet. Activate a compliance pack and run the first assessment in Company setup.</p>`}
    </section>`;

    // Priority cases, with All / Mine. Mine means cases the signed-in person owns.
    const mineCount = openCases.filter((c) => c.owner_user_id === me.user.id).length;
    const caseRows = (ovMine ? openCases.filter((c) => c.owner_user_id === me.user.id) : openCases).slice(0, 5);
    const toggle = h`<div class="ovx-tools"><div class="ovx-seg" role="group" aria-label="Whose cases"><button type="button" data-act="ovCases" data-v="" aria-pressed="${!ovMine}" class="${ovMine ? '' : 'on'}">All</button><button type="button" data-act="ovCases" data-v="1" aria-pressed="${ovMine}" class="${ovMine ? 'on' : ''}">Mine${mineCount ? ` (${mineCount})` : ''}</button></div>${more('#cases', 'All cases')}</div>`;
    const casesPanel = h`<section class="ovx-panel ovx-7 ovx-flush" aria-labelledby="ovxCases">
      ${head(h`<span id="ovxCases">Priority cases</span>`, 'By priority, then due date', toggle)}
      ${table(['Case', 'Pack', 'Owner', 'Due'], caseRows.map((c) => h`<tr><td><a class="row-title" href="#cases/${encodeURIComponent(c.id)}">${c.control_name}</a><div class="case-sub">${c.subject_name} · ${words(c.state)}</div></td><td>${packTag(c.pack_key)}</td><td>${c.owner_name || c.owner_team || 'Unassigned'}</td><td class="nowrap">${date(c.due_date)}${dueNote(c.due_date)}</td></tr>`), ovMine ? ['No cases assigned to you', 'Cases you own appear here.'] : ['No open cases', 'Every check in scope passes, or its gap is already closed.'])}
    </section>`;

    // Credentials to renew: the Expiring soon dashboard in brief.
    const left = (d) => (d < 0 ? 'Expired' : d === 0 ? 'Today' : plural(d, 'day'));
    const renewPanel = h`<section class="ovx-panel ovx-5" aria-labelledby="ovxRenew">
      ${head(h`<span id="ovxRenew">Credentials to renew</span>`, 'Expired or expiring within 90 days', more('#dashboards/builtin-expiring', 'Expiring soon'))}
      ${kpi.expiring ? h`<div class="ovx-buckets">
          <div class="${exp.expired ? 'is-hot' : ''}"><b>${exp.expired}</b><span><i class="ovx-dot is-fail" aria-hidden="true"></i>Expired</span></div>
          <div><b>${exp.d30}</b><span><i class="ovx-dot is-warn" aria-hidden="true"></i>30 days</span></div>
          <div><b>${exp.d60}</b><span><i class="ovx-dot is-warn" aria-hidden="true"></i>60 days</span></div>
          <div><b>${exp.d90}</b><span><i class="ovx-dot is-na" aria-hidden="true"></i>90 days</span></div>
        </div>
        <ul class="ovx-exp">${exp.next.map((x) => h`<li><span><button type="button" class="ovx-name" data-act="workerDetail" data-id="${x.subject_id}">${x.subject}</button><small>${x.control}${x.facility ? ` · ${x.facility}` : ''}</small></span><span class="ovx-when ${x.days_left < 0 ? 'is-late' : ''}">${left(x.days_left)}<small>${date(x.expires_on)}</small></span></li>`)}</ul>`
        : h`<p class="ovx-clear"><i class="ovx-dot is-pass" aria-hidden="true"></i>No credentials expire in the next 90 days.</p>`}
    </section>`;

    // Active packs: one colour per result everywhere, and what stands between validation and automatic requests.
    const packPct = (p) => (p.total ? Math.round((100 * p.pass) / p.total) : 0);
    const packsPanel = h`<section class="ovx-panel ${feed.length ? 'ovx-7' : 'ovx-12'}" aria-labelledby="ovxPacks">
      ${head(h`<span id="ovxPacks">Active packs</span>`, 'Results by compliance area', more('#packs', 'View packs'))}
      ${packs.length ? h`<ul class="ovx-packs">${packs.map((p) => h`<li>${packIcon(p.key)}<h3>${p.name}<span class="ovx-mode ${p.mode === 'auto' ? 'is-auto' : ''}">${p.mode === 'auto' ? 'Automatic' : 'Validation only'}</span></h3><span class="ovx-pscore"><b>${packPct(p)}%</b>${p.pass} of ${p.total} pass</span>
        <div class="ovx-pbar" role="img" aria-label="${`${p.pass} pass, ${p.fail} fail, ${p.unknown} unknown`}">${seg(p.pass, 'is-pass')}${seg(p.fail, 'is-fail')}${seg(p.unknown, 'is-warn')}</div>
        <div class="ovx-meta">${p.fail ? h`<span><i class="ovx-dot is-fail" aria-hidden="true"></i>${p.fail} fail</span>` : ''}${p.unknown ? h`<span><i class="ovx-dot is-warn" aria-hidden="true"></i>${p.unknown} unknown</span>` : ''}${!p.fail && !p.unknown ? h`<span><i class="ovx-dot is-pass" aria-hidden="true"></i>All pass</span>` : ''}${p.mode !== 'auto' && p.unvalidated ? h`<a href="#cases">${plural(p.unvalidated, 'finding')} to review before automatic requests</a>` : ''}</div></li>`)}</ul>`
        : h`<p class="ovx-clear">No active packs. Activate one in Company setup.</p>`}
    </section>`;

    // Recent activity, for administrators: the latest audit entries in plain words.
    // Today's entries show the time; older ones the day, without the year, so the column stays narrow.
    const SHORT_DAY = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
    const when = (ts) => (String(ts).slice(0, 10) === me.today ? timeUtc(ts) : SHORT_DAY.format(new Date(ts)));
    const activityPanel = feed.length ? h`<section class="ovx-panel ovx-5" aria-labelledby="ovxAct">
      ${head(h`<span id="ovxAct">Recent activity</span>`, 'The latest entries in the audit history', more('#audit', 'Audit history'))}
      <ul class="ovx-act">${feed.slice(0, 6).map((e) => h`<li><time datetime="${e.ts}">${when(e.ts)}</time><i class="ovx-dot is-${AUDIT_TONE[e.type] || 'na'}" aria-hidden="true"></i><span><b>${auditLabel(e.type)}</b>${e.subject ? ` · ${e.subject}` : ''}<small>${e.action}</small></span></li>`)}</ul>
    </section>` : '';

    return h`<div class="ovx">
      ${attentionPanel}${readinessPanel}${coveragePanel}${casesPanel}${renewPanel}${packsPanel}${activityPanel}
      <p class="ovx-foot">${cov.scope_statement} Only accepted evidence counts as a pass.</p>
    </div>`;
  },
  async setup() {
    scope(null);
    const s = await api('/api/setup');
    const steps = setupSteps(s), done = steps.filter((x) => x.done).length, next = steps.find((x) => !x.done && !x.locked);
    const total = steps.length, toFix = steps.filter((x) => x.done && x.attention), fix = toFix[0];
    return h`<div class="stack">
      <section class="panel setup-progress" aria-labelledby="setupProgress">
        <div class="setup-progress-text">
          <h2 id="setupProgress">${done === total ? 'Setup is complete' : `${done} of ${total} steps done`}</h2>
          <p>${done === total ? `Aegis is checking ${plural(s.summary.workers, 'worker')} against ${plural(s.recommended.filter((p) => p.status === 'active').length, 'active pack')}.${toFix.length > 1 ? ` ${toFix.length} steps need attention: ${toFix.map((x) => x.title.toLowerCase()).join('; ')}.` : fix ? ` One step needs attention: ${fix.title.toLowerCase()}.` : ' You can change any step below.'}` : `Next: ${next ? next.title.toLowerCase() : 'finish the steps above'}.`}</p>
        </div>
        <ol class="setup-meter" aria-hidden="true">${steps.map((x) => h`<li class="${x.done ? 'is-done' : x === next ? 'is-current' : ''}"></li>`)}</ol>
        ${next ? h`<button class="btn-submit-green" data-act="openStep" data-step="${next.key}">Continue</button>` : fix ? h`<button class="btn-card-outline" data-act="openStep" data-step="${fix.key}">Review</button>` : ''}
      </section>
      <div class="setup-steps">${steps.map((x, n) => setupStep(x, n + 1, x === next))}</div>
    </div>`;
  },
  async cases(arg) {
    scope(null);
    const [all, packs] = await Promise.all([api(`/api/cases${caseClosed ? '?closed=1' : ''}`), caseClosed ? [] : api('/api/packs')]);
    const due = !caseClosed && CASE_DUE[arg] ? arg : '';
    const rows = due ? all.filter(CASE_DUE[due][1]) : all;
    const autoPacks = new Set(packs.filter((p) => p.mode === 'auto').map((p) => p.key));
    // Why a follow-up would not be sent, known before sending. "Already sent today" is only known by the server.
    const skipOf = (c) => !autoPacks.has(c.pack_key) ? 'validation' : c.gap_kind === 'review' ? 'review' : '';
    const selectable = !caseClosed && rows.some((c) => c.can_act);
    for (const id of [...caseSel]) if (!rows.some((c) => c.id === id && c.can_act)) caseSel.delete(id);
    const pickCell = (c) => !selectable ? '' : c.can_act
      ? h`<td class="select-cell"><label><input type="checkbox" class="case-check" data-id="${c.id}" ${caseSel.has(c.id) ? raw('checked') : ''} aria-label="${`Select ${c.control_name} for ${c.subject_name}`}"></label></td>`
      : h`<td class="select-cell"></td>`;
    const dueChips = caseClosed ? '' : h`<span class="filter-sep" aria-hidden="true"></span>${[['', 'Any due date', all.length], ...Object.entries(CASE_DUE).map(([k, [label, test]]) => [k, label, all.filter(test).length])].map(([k, label, n]) => h`<button class="chip${due === k ? ' on' : ''}" data-act="caseDue" data-v="${k}" aria-pressed="${due === k}">${label}${k ? ` (${n})` : ''}</button>`)}`;
    const tabs = h`<div class="filters"><button class="chip${caseClosed ? '' : ' on'}" data-act="caseTab" data-v="">Open</button><button class="chip${caseClosed ? ' on' : ''}" data-act="caseTab" data-v="1">Closed</button>${dueChips}</div>`;
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
    const late = all.filter(isOverdue).length;
    return card(caseClosed ? 'Closed cases' : due ? `Open cases: ${CASE_DUE[due][0].toLowerCase()}` : 'Open cases', caseClosed ? 'Cases closed by accepted evidence or no longer applicable.' : due ? `${rows.length} of ${all.length} open cases. Open a case to see its gap and history.` : `${all.length} open${late ? ` · ${late} overdue` : ''}. Open a case to see its gap and history.`,
      h`${tabs}${table([...(selectable ? [allBox] : []), 'Case', 'Pack', 'Stage', 'Owner', 'Due', 'Finding', caseClosed ? 'How it closed' : ''], caseRows, caseClosed ? ['No closed cases yet', 'Cases appear here once accepted evidence closes them.'] : due ? [`No cases ${CASE_DUE[due][0].toLowerCase()}`, 'Choose Any due date to see every open case.'] : ['No open cases', 'Every check in scope passes, or its gap is already closed.'])}`, followUps);
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
    rememberLocations(rows.filter((w) => w.facility).map((w) => ({ name: w.facility, state: w.state })));
    return card('All workers', `${rows.length} workers${withGaps ? ` · ${withGaps} with open checks` : ''}. A tick means the pack passes; only problems are highlighted.`, table(['Worker', 'Location', 'Onboarding', 'Healthcare', 'Immigration', 'Payroll', 'Overall', 'Open', 'Readiness'], rows.map((w) => h`<tr class="click" data-act="workerDetail" data-id="${w.id}"><td><button class="row-title" data-act="workerDetail" data-id="${w.id}">${w.name}</button>${w.status !== 'active' ? h` <span class="pill pill-na">${words(w.status)}</span>` : ''}<div class="case-sub">${w.role || 'No role'}</div></td><td class="${w.facility ? '' : 'muted'}">${w.facility || 'No location assigned'}</td><td class="result-cell">${quietStatus(w.packs.onboarding)}</td><td class="result-cell">${quietStatus(w.packs.healthcare)}</td><td class="result-cell">${quietStatus(w.packs.immigration)}</td><td class="result-cell">${quietStatus(w.packs.payroll)}</td><td class="result-cell">${quietStatus(w.overall)}</td><td class="open-cell">${openOf(w) ? h`<b>${openOf(w)}</b>` : h`<span class="muted">0</span>`}</td><td class="${w.readiness === 'blocked' ? 'text-fail' : 'muted'}">${words(w.readiness)}</td></tr>`), ['No workers yet', 'Add a worker, import a roster, or connect your HR system under Connections.']));
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
    return h`<div class="bottom-split-row evidence-layout"><div class="split-card"><div class="split-card-header"><div><h3 class="split-title">Evidence inbox</h3><p class="muted small">${rows.length} document${rows.length === 1 ? '' : 's'}${waiting ? ` · ${waiting} waiting for review` : ''}</p></div></div>${table(['Document', 'Subject', 'Confidence', 'Status'], rows.map((e) => h`<tr class="click${e.id === ev?.id ? ' selected' : ''}" data-act="selectEvidence" data-id="${e.id}"><td><button class="row-title" data-act="selectEvidence" data-id="${e.id}">${words(e.doc_type)}</button>${recentUploads.has(e.id) ? h` <span class="pill pill-blue new-tag">New</span>` : ''}<div class="muted small">${e.filename}</div></td><td class="text-secondary">${e.subject_name}</td><td>${e.source === 'demo_seed' ? '—' : `${Math.round((e.confidence || 0) * 100)}%`}</td><td>${statePill(e.status)}</td></tr>`), ['No evidence yet', 'Documents appear here when workers send them or you upload them.'])}</div>
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
      ...health.connectors.filter((c) => c.last_error).map((c) => ['HR system', c.name, c.last_error]),
      ...health.jobs.dead.map((job) => ['Background job', words(job.type), job.last_error]),
      ...health.failed_actions.map((action) => ['Message delivery', action.recipient, action.error]),
      ...health.events.filter((event) => event.status === 'failed').map((event) => ['HR system update', words(event.type), event.error]),
    ];
    if (connections.slack.receiving?.error) failures.push(['Slack', 'Incoming chat', connections.slack.receiving.error]);
    const ready = !me.sandbox && !me.workspace_email?.pending;
    return h`<div class="stack">
      ${connectionStatus(failures)}
      ${me.sandbox ? h`<p class="setup-note is-info"><b>Sandbox</b>Workforce sync uses sample data, and messages stay in the outbox.</p>` : ''}
      ${me.workspace_email?.pending ? h`<p class="setup-note"><b>Confirm your email first</b>Connections can be added once the workspace email is confirmed.</p>` : ''}
      ${card('Connected tools', 'The systems this workspace uses. Keys are stored encrypted and never shown again.', h`<ul class="tool-list">${[...hrRows(health.connectors, ready), slackRow(connections.slack, ready), emailRow(connections.email)]}</ul>`, ready ? h`<button class="btn-card-outline" data-act="addConnector">Add HR system</button>` : '')}
      ${failures.length ? card('Needs attention', 'Fix these to keep records and messages flowing.', table(['Item', 'Source', 'What happened'], failures.map(([kind, item, error]) => h`<tr><td><span class="row-title is-static">${item || 'Unnamed item'}</span></td><td class="nowrap">${kind}</td><td class="small">${error || 'The service did not say what went wrong.'}</td></tr>`), ''), '') : ''}
      ${messageOutbox(messages)}
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
    const [users, hl, coworker] = await Promise.all([api('/api/users'), api('/api/health'), api('/api/coworker/settings')]);
    return h`<div class="stack">${coworkerPolicyPanel(coworker)}
    ${card('Users & Roles', 'Roles limit which packs a person can act on. Immigration records are restricted. Deactivated people keep their history but cannot sign in.', table(['Person', 'Role', 'Status', num('Open cases'), ''], users.map((u) => h`<tr class="${u.disabled_at ? 'is-muted-row' : ''}"><td><strong>${u.name}</strong>${u.is_you ? h` <span class="pill pill-na">You</span>` : ''}<div class="case-sub">${u.email}</div></td><td>${roleName(u.role)}</td><td>${u.disabled_at ? h`<span class="pill pill-na">Deactivated</span>` : h`<span class="pill pill-pass">Active</span>`}</td><td class="num">${u.open_cases}</td><td class="row-action">${u.is_you ? h`<button class="btn-link-action" data-act="changePassword">Change your password</button>` : manageMenu([
      !u.disabled_at && h`<button role="menuitem" data-act="userRole" data-id="${u.id}" data-name="${u.name}" data-role="${u.role}">Change role</button>`,
      !u.disabled_at && h`<button role="menuitem" data-act="userPassword" data-id="${u.id}" data-name="${u.name}">Reset password</button>`,
      u.disabled_at ? h`<button role="menuitem" data-act="userReactivate" data-id="${u.id}" data-name="${u.name}">Reactivate</button>`
        : h`<button role="menuitem" class="is-danger" data-act="userDeactivate" data-id="${u.id}" data-name="${u.name}" data-cases="${u.open_cases}">Deactivate</button>`,
    ])}</td></tr>`), ''))}
    <form class="plain-card" data-form="user"><strong>Add user</strong><div class="form-grid mt"><div class="form-group"><label class="form-label" for="nuName">Name</label><input id="nuName" name="name" class="form-select" required></div><div class="form-group"><label class="form-label" for="nuEmail">Work email</label><input id="nuEmail" name="email" type="email" class="form-select" required></div><div class="form-group"><label class="form-label" for="nuRole">Role</label><select id="nuRole" name="role" class="form-select">${ROLES.map(([k, l]) => h`<option value="${k}" ${k === 'hr' ? raw('selected') : ''}>${l}</option>`)}</select></div><div class="form-group"><label class="form-label" for="nuPw">Temporary password</label><input id="nuPw" name="password" type="password" minlength="12" maxlength="128" autocomplete="new-password" class="form-select" required><span class="subtext">At least 12 characters. Share it with them in person; they can change it in their account menu.</span></div></div><button class="btn-submit-green">Add user</button></form>
    ${card('Schedules', 'Checks run daily. Reminders run on each control’s cadence.', table(['Job', 'Cadence', 'Next run'], hl.schedules.map((s) => h`<tr><td>${s.kind}</td><td>${s.cadence}</td><td class="mono">${dt(s.next_run_at)}</td></tr>`), ['No schedules', 'Daily checks and digests appear here once set up.']))}</div>`;
  },
};

function coworkerPolicyPanel({ policy, ai_calls_today, limits }) {
  const choices = [
    ['enabled', 'Answer new questions'],
    ['follow_ups', 'Preview and queue evidence follow-ups'],
    ['dashboards', 'Save dashboards from chat'],
    ['slack', 'Answer questions in Slack direct messages'],
  ];
  return card('Coworker policy', 'Choose what Ask coworker can do in this workspace.', h`
    <form data-form="coworkerPolicy" class="coworker-policy-form">
      <fieldset>
        <legend>Capabilities</legend>
        <div class="coworker-policy-options">${choices.map(([key, label]) => h`
          <label><input type="checkbox" name="${key}" ${policy[key] ? raw('checked') : ''}><span>${label}</span></label>
        `)}</div>
      </fieldset>
      <div class="form-grid">
        <div class="form-group">
          <label class="form-label" for="coworker-retention">Chat retention in days</label>
          <input id="coworker-retention" name="retention_days" type="number" class="form-select" min="1" max="${limits.retention_days}" step="1" placeholder="Keep indefinitely" value="${policy.retention_days ?? ''}" aria-describedby="coworker-retention-help">
          <p id="coworker-retention-help" class="muted small">Leave blank to keep chats indefinitely. Saving a retention window removes messages older than that window.</p>
        </div>
        <div class="form-group">
          <label class="form-label" for="coworker-daily-limit">Daily coworker AI request limit</label>
          <input id="coworker-daily-limit" name="daily_ai_calls" type="number" class="form-select" min="0" max="${limits.daily_ai_calls}" step="1" placeholder="No daily limit" value="${policy.daily_ai_calls ?? ''}" aria-describedby="coworker-ai-help">
          <p id="coworker-ai-help" class="muted small">${ai_calls_today} attempted today. Resets at midnight UTC. Enter 0 to turn off AI interpretation. Known questions still use Aegis records.</p>
        </div>
      </div>
      <div class="row"><button type="submit" class="btn-submit-green">Save coworker policy</button>
        ${policy.updated_at ? h`<span class="muted small">Last updated by ${policy.updated_by} on ${dt(policy.updated_at)} UTC</span>` : ''}
      </div>
    </form>
  `);
}

function connectionIcon(key, size) {
  return h`<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${raw(I[key])}</svg>`;
}

// One line that says whether everything is working, with a way to look again.
function connectionStatus(failures) {
  const n = failures.length;
  return h`<div class="panel chain-panel ${n ? 'is-warn' : 'is-ok'}" role="status">
    <span class="chain-icon" aria-hidden="true">${raw(n ? '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>' : '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 5 5 9-10"/></svg>')}</span>
    <div><b>${n ? `${plural(n, 'thing needs', 'things need')} attention` : 'All connections are working'}</b><p>${n ? 'See Needs attention below.' : 'Records sync and messages are delivered or kept in the outbox.'} Checked ${dt(new Date().toISOString())} UTC.</p></div>
    <button class="btn-card-outline" data-act="refreshConnections">Refresh</button>
  </div>`;
}
// A tool: what it is, what it does for this workspace, its state, and what you can do.
const toolRow = ({ name, what, state, meta, actions }) => h`<li class="tool-row">
  <div class="tool-main"><b>${name}</b><span>${what}</span></div>
  <div class="tool-state"><span class="pill ${state[1]}">${state[0]}</span>${meta ? h`<small>${meta}</small>` : ''}</div>
  <div class="tool-actions">${actions || ''}</div>
</li>`;
const manageMenu = (items) => (items.filter(Boolean).length ? h`<details class="row-menu"><summary class="btn-card-outline">Manage</summary><div class="row-menu-list" role="menu">${items}</div></details>` : '');
function hrRows(connectors, ready) {
  if (!connectors.length) return [toolRow({ name: 'HR system', what: 'Keeps workers, locations and assignments up to date from your HR system.', state: ['Not connected', 'pill-na'], meta: 'You can also import a spreadsheet.', actions: h`${ready ? h`<button class="btn-submit-green" data-act="addConnector">Connect</button>` : ''}<button class="btn-link-action" data-act="importRoster">Import a spreadsheet</button>` })];
  return connectors.map((c) => {
    const paused = c.status === 'disabled';
    const state = paused ? ['Paused', 'pill-na'] : c.last_error || c.status === 'error' ? ['Needs attention', 'pill-warn'] : c.status === 'connected' ? ['Connected', 'pill-pass'] : [words(c.status), 'pill-na'];
    return toolRow({
      name: c.name, what: 'HR system. Workers, locations and assignments.', state,
      meta: `${c.last_sync_at ? `Synced ${dt(c.last_sync_at)} UTC` : 'Not synced yet'}${c.records ? `, ${plural(c.records, 'record')}` : ''}`,
      actions: h`${!paused && !me.workspace_email?.pending ? h`<button class="btn-card-outline" data-act="syncConnector" data-id="${c.id}">Sync now</button>` : ''}${ready ? manageMenu([
        h`<button role="menuitem" data-act="testConnector" data-id="${c.id}">Test connection</button>`,
        h`<button role="menuitem" data-act="editConnector" data-id="${c.id}">Edit settings</button>`,
        h`<button role="menuitem" data-act="importRoster">Import a spreadsheet</button>`,
        h`<button role="menuitem" class="${paused ? '' : 'is-danger'}" data-act="toggleConnector" data-id="${c.id}" data-next="${paused ? 'enable' : 'disable'}">${paused ? 'Resume sync' : 'Pause sync'}</button>`,
      ]) : ''}`,
    });
  });
}
function slackRow(slack, ready) {
  const r = slack.receiving;
  const state = !slack.connected ? ['Not connected', 'pill-na'] : r?.error ? ['Needs attention', 'pill-warn'] : ['Connected', 'pill-pass'];
  const chat = r?.mode === 'socket' ? 'chat on' : r?.mode === 'events_url' ? 'chat by events URL' : 'chat off';
  return toolRow({
    name: 'Slack', what: 'Posts digests and alerts, and lets people ask the coworker questions.', state,
    meta: slack.connected ? `${slack.workspace || 'Workspace set on the server'}, ${slack.channel || 'no channel'}, ${chat}` : 'Until connected, messages stay in the outbox.',
    actions: ready ? (slack.connected
      ? manageMenu([
        h`<button role="menuitem" data-act="slackTest">Send a test message</button>`,
        h`<button role="menuitem" data-act="slackConfig" data-channel="${slack.channel || '#compliance-alerts'}" data-replace="${slack.source === 'settings' ? 'yes' : ''}">Update keys or channel</button>`,
        slack.source === 'settings' ? h`<button role="menuitem" class="is-danger" data-act="slackDisconnect">Disconnect</button>` : '',
      ])
      : h`<button class="btn-submit-green" data-act="slackConfig" data-channel="${slack.channel || '#compliance-alerts'}" data-replace="">Connect</button>`) : '',
  });
}
function emailRow(email) {
  return toolRow({
    name: 'Email', what: 'Sends document requests and reminders to workers.', state: email?.configured ? ['Set up', 'pill-pass'] : ['Not set up', 'pill-na'],
    meta: email?.configured ? 'Delivered through the server’s email service.' : 'Requests stay in the outbox. Your Aegis administrator sets email up on the server.',
  });
}
const outboxFilter = { query: '', channel: '' };
const OUTBOX_PAGE = 10;
let outboxLimit = OUTBOX_PAGE;
function messageOutbox(messages) {
  return h`<section class="panel connection-outbox" aria-labelledby="messageOutbox">
    <div class="ph2"><div><h2 id="messageOutbox" tabindex="-1">Message outbox</h2><p>Every message Aegis sends or keeps. Times are UTC.</p></div></div>
    ${messages.length ? h`<div class="outbox-tools">
      <input type="search" class="form-select" id="outboxSearch" placeholder="Subject or recipient" aria-label="Search messages" value="${outboxFilter.query}">
      <select class="form-select" id="outboxChannel" aria-label="Delivery">${[['', 'All deliveries'], ['outbox', 'Kept in outbox'], ['email', 'Email'], ['slack', 'Slack']].map(([key, label]) => h`<option value="${key}" ${outboxFilter.channel === key ? raw('selected') : ''}>${label}</option>`)}</select>
      <p id="outboxCount" role="status"></p>
    </div>
    ${table(['Message', 'To', 'When', 'Delivery', ''], messages.map(outboxRow), '')}
    <div class="load-more" id="outboxMore" hidden><button class="btn-card-outline" data-act="outboxMore">Show more</button></div>
    <div id="outboxNoMatches" hidden>${emptyState(['No matching messages', 'Change the search or choose another delivery.'])}</div>` : emptyState(['No messages yet', 'Alerts and follow-ups will appear here as they are recorded.'])}
  </section>`;
}

function filterOutbox() {
  const rows = [...document.querySelectorAll('.connection-outbox tr[data-channel]')];
  if (!rows.length) return;
  const query = outboxFilter.query.trim().toLowerCase();
  let matched = 0, shown = 0;
  for (const row of rows) {
    const match = (!outboxFilter.channel || row.dataset.channel === outboxFilter.channel)
      && (!query || row.dataset.searchText.toLowerCase().includes(query));
    if (match) matched++;
    row.hidden = !match || matched > outboxLimit;
    if (!row.hidden) shown++;
  }
  $('.connection-outbox .table-scroll-container').hidden = !shown;
  $('#outboxNoMatches').hidden = !!matched;
  $('#outboxMore').hidden = matched <= shown;
  $('#outboxCount').textContent = matched ? `Showing ${shown} of ${matched}${matched < rows.length ? ` matching` : ''} ${matched === 1 ? 'message' : 'messages'}` : '';
}

function outboxRow(message) {
  const content = message.body || '';
  const token = /\/submit\/([\w-]+)/.exec(content)?.[1];
  const body = content.replace(/https?:\/\/\S+/g, '[link]');
  const label = { outbox: 'Outbox only', email: 'Email', slack: 'Slack' }[message.channel] || words(message.channel);
  const [tone, delivery] = message.channel === 'outbox' ? ['na', 'Kept in outbox']
    : message.status === 'sent' ? ['pass', `Sent by ${label.toLowerCase()}`] : ['warn', `${words(message.status)}, ${label.toLowerCase()}`];
  return h`<tr data-channel="${message.channel}" data-search-text="${message.subject} ${message.recipient}"><td><strong>${message.subject}</strong><span class="outbox-preview">${body.length > 130 ? `${body.slice(0, 130).trimEnd()}…` : body}</span></td>
    <td>${message.recipient}</td><td class="outbox-time"><time datetime="${message.created_at}">${dt(message.created_at)}</time></td>
    <td class="nowrap"><span class="delivery tone-${tone}"><i aria-hidden="true"></i>${delivery}</span></td>
    <td>${token ? h`<a class="btn-link-action" href="/submit/${token}" target="_blank" rel="noopener" aria-label="Open the upload link for ${message.subject} in a new tab">Upload link</a>` : ''}</td></tr>`;
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
// One file in the upload window: what happened to it, and why. A zip or an email lists the documents in it.
function uploadRow(name, r) {
  if (r.files) return h`<div class="upload-row-main"><span class="upload-file-name">${name}</span><span class="pill pill-blue">Opened: ${r.files.length} document${r.files.length === 1 ? '' : 's'}</span></div><ul class="upload-children">${r.files.map((x) => h`<li>${uploadRow(x.filename.split(' › ').pop(), x)}</li>`)}</ul>`;
  const [label, cls] = r.state === 'waiting' ? ['Waiting', 'pill-na'] : r.state === 'reading' ? ['Reading…', 'pill-blue'] : r.state === 'failed' ? ['Not uploaded', 'pill-fail']
    : r.duplicate ? ['Already on record', 'pill-na'] : r.status === 'accepted' ? ['Accepted', 'pill-pass'] : r.status === 'rejected' ? ['Rejected', 'pill-fail'] : ['Needs review', 'pill-warn'];
  const why = r.state === 'failed' ? r.error
    : r.duplicate ? `This exact file was uploaded for this person${r.created_at ? ` on ${dt(r.created_at)}` : ' before'}. Nothing new was saved.`
      : r.state ? '' : r.status === 'accepted' ? 'Matched to the requirement. The check runs again.' : (r.reasons || []).join(' ');
  const open = r.id && !r.state ? h`<button type="button" class="btn-link-action" data-act="openUploaded" data-id="${r.id}" aria-label="Open ${name}">Open</button>` : '';
  return h`<div class="upload-row-main"><span class="upload-file-name">${name}</span><span class="pill ${cls}">${label}</span>${open}</div>${why ? h`<p class="upload-why">${why}</p>` : ''}`;
}
const EV_FIELDS = [['holder_name', 'Name on document'], ['doc_number', 'Document number'], ['issued_on', 'Issued', 'date'], ['expires_on', 'Expires', 'date'], ['state', 'State'], ['period', 'Period'], ['entity_name', 'Company']];
function evidencePanel(e, controls = {}) {
  const pending = e.can_review;
  const conf = (k) => e.field_confidence[k] ? h` <span class="conf">${Math.round(e.field_confidence[k] * 100)}%</span>` : '';
  const ctl = controls[e.control_key];
  const requirement = ctl ? `${ctl.name} · ${words(ctl.pack)}` : e.control_key ? words(e.control_key) : 'Not matched yet';
  const reasons = e.review_reasons.length ? h`<div class="why-box"><strong>Why this needs a person</strong><ul>${e.review_reasons.map((r) => h`<li>${r}</li>`)}</ul></div>` : '';
  const facts = h`<dl class="kv ev-facts"><dt>File</dt><dd>${e.filename}${e.has_file ? h` · <a class="btn-link-action" href="/api/evidence/${e.id}/file">Download</a>` : ''}</dd><dt>For</dt><dd>${e.subject_name}</dd><dt>Requirement</dt><dd>${requirement}</dd><dt>Source</dt><dd>${words(e.source)}</dd>${e.reviewed_by ? h`<dt>Reviewed by</dt><dd>${e.reviewed_by}</dd>` : ''}${e.reject_reason ? h`<dt>Rejected because</dt><dd>${e.reject_reason}</dd>` : ''}</dl>`;
  // The uploaded file itself, so the reviewer can compare every field with what the document says.
  const doc = e.preview === 'image' ? h`<h4 class="inspector-sub">The document</h4><a class="ev-preview" href="/api/evidence/${e.id}/preview" target="_blank" rel="noopener" title="Open the first page full size"><img src="/api/evidence/${e.id}/preview" alt="First page of ${e.filename}" loading="lazy"></a><p class="muted small">Scroll to see up to three pages. Download the file to see every page.</p>`
    : e.preview === 'text' ? h`<h4 class="inspector-sub">The document</h4><pre class="ev-preview-text" data-preview-text="${e.id}" tabindex="0" aria-label="Text of ${e.filename}">Loading the text…</pre>`
      : e.has_file ? h`<p class="muted small">Aegis cannot show this file here. Download it to open it.</p>` : '';
  const head = h`<div class="inspector-head"><div><h3 class="split-title">${words(e.doc_type)}</h3><p class="muted small">${e.subject_name}</p></div>${statePill(e.status)}</div>`;
  if (!pending) {
    // Finished documents: plain read-only details, no empty boxes.
    const read = EV_FIELDS.filter(([k]) => e[k]);
    return h`<aside class="split-card inspector" aria-label="Document details">${head}<div class="inspector-body">${reasons}${facts}${doc}
      <h4 class="inspector-sub">What the document says</h4>
      ${read.length ? h`<dl class="kv ev-read">${read.map(([k, l, t]) => h`<dt>${l}</dt><dd>${t === 'date' ? date(e[k]) : e[k]}${conf(k)}</dd>`)}</dl>` : h`<p class="muted small">No details were read from this document.</p>`}
    </div></aside>`;
  }
  const f = ([k, l, type = 'text']) => h`<div class="form-group"><label class="form-label" for="evidence-${k}">${l}${conf(k)}</label><input id="evidence-${k}" name="${k}" type="${type}" class="form-select" value="${e[k] || ''}"></div>`;
  return h`<aside class="split-card inspector" aria-label="Review document">${head}
    <form class="inspector-form" data-form="reviewEvidence" data-id="${e.id}">
      <div class="inspector-body">${reasons}${facts}${doc}
        <h4 class="inspector-sub">What the document says</h4>
        <p class="muted small">Correct anything Aegis read wrongly. The percentage shows how sure Aegis was.</p>
        <div class="form-group"><label class="form-label" for="evidence-type">Document type${conf('doc_type')}</label><select id="evidence-type" name="doc_type" class="form-select" required><option value="">Choose a type</option>${['professional_license', 'bls_card', 'acls_card', 'tb_screening', 'flu_vaccine', 'facility_orientation', 'handbook_ack', 'security_training', 'i9_record', 'work_authorization', 'w4', 'payroll_filing_receipt'].map((x) => h`<option value="${x}" ${x === e.doc_type ? raw('selected') : ''}>${words(x)}</option>`)}</select></div>
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
  async openVerificationInbox() {
    const { link } = await api('/api/verify-email/inbox');
    openModal('Sandbox inbox', me.user.email, link ? h`
      <h4>Confirm your Aegis work email</h4>
      <p>Confirm this address to finish setting up your workspace. This link expires 30 minutes after it was requested.</p>
    ` : h`<p>No current verification email. Request a fresh link to continue.</p>`, link
      ? h`<a class="btn primary" href="${link}">Open verification link</a>`
      : h`<button class="btn" data-act="resendVerification">Resend email</button>`);
  },
  async resendVerification(el) {
    el.disabled = true;
    try {
      await api('/api/verify-email/resend', {});
      toast('A new email is in your sandbox inbox.', 'success');
      if ($('#modal').classList.contains('open')) await ACT.openVerificationInbox();
    } finally { el.disabled = false; }
  },
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
  closeModal, openChat, closeChat: () => closeChat(), newChat, toggleChatHistory, selectChat,
  toggleRail: () => setRailCollapsed(!document.documentElement.classList.contains('rail-collapsed')),
  async logout() { await api('/api/logout', {}); history.replaceState(null, '', location.pathname + location.search); location.reload(); },
  prompt: (el) => sendChat(el.dataset.q),
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
  caseTab(el) { caseClosed = !!el.dataset.v; caseSel.clear(); if (routeArg) location.hash = 'cases'; else refresh(); },
  caseDue(el) { caseSel.clear(); location.hash = el.dataset.v ? `cases/${el.dataset.v}` : 'cases'; },
  ovCases(el) { ovMine = !!el.dataset.v; refresh(); },
  // Users: each action opens a short window that says what will happen before it happens.
  userRole(el) {
    openModal(`Change role for ${el.dataset.name}`, 'The new role applies straight away, also to sessions that are already open.', h`<form data-form="userRole" data-id="${el.dataset.id}"><div class="form-group"><label class="form-label" for="urRole">Role</label><select id="urRole" name="role" class="form-select">${ROLES.map(([k, l]) => h`<option value="${k}" ${k === el.dataset.role ? raw('selected') : ''}>${l}</option>`)}</select></div><button class="btn-submit-green">Save role</button></form>`);
  },
  userPassword(el) {
    openModal(`Reset password for ${el.dataset.name}`, 'They are signed out everywhere and use this password next time. Tell them in person or by phone, never by email.', h`<form data-form="userPassword" data-id="${el.dataset.id}"><div class="form-group"><label class="form-label" for="upPw">New password</label><input id="upPw" name="password" type="password" minlength="12" maxlength="128" autocomplete="new-password" class="form-select" required><span class="subtext">${PW_HINT}</span></div><button class="btn-submit-green">Reset password</button></form>`);
  },
  userDeactivate(el) {
    const n = +el.dataset.cases;
    openModal(`Deactivate ${el.dataset.name}?`, 'They are signed out at once and cannot sign in or use the coworker in Slack. Their history stays, and you can reactivate them later.',
      n ? h`<p class="alert-box">${el.dataset.name} still owns ${plural(n, 'open case')}. Assign ${n === 1 ? 'it' : 'them'} to someone else from Cases so nothing is missed.</p>` : '',
      h`<button class="btn-cancel" data-act="closeModal">Cancel</button><button class="btn-danger" data-act="confirmDeactivate" data-id="${el.dataset.id}" data-name="${el.dataset.name}">Deactivate</button>`);
  },
  async confirmDeactivate(el) { await api(`/api/users/${el.dataset.id}/deactivate`, {}); closeModal(); toast(`${el.dataset.name} is deactivated and signed out.`, 'success'); refresh(); },
  async userReactivate(el) { await api(`/api/users/${el.dataset.id}/reactivate`, {}); toast(`${el.dataset.name} can sign in again.`, 'success'); refresh(); },
  changePassword() {
    closeAllDirMenus();
    openModal('Change your password', 'You stay signed in here. Other devices are signed out.', h`<form data-form="myPassword"><div class="form-group"><label class="form-label" for="mpCur">Current password</label><input id="mpCur" name="current" type="password" autocomplete="current-password" class="form-select" required></div><div class="form-group"><label class="form-label" for="mpNew">New password</label><input id="mpNew" name="password" type="password" minlength="12" maxlength="128" autocomplete="new-password" class="form-select" required><span class="subtext">${PW_HINT}</span></div><div class="form-group"><label class="form-label" for="mpAgain">New password again</label><input id="mpAgain" name="again" type="password" minlength="12" maxlength="128" autocomplete="new-password" class="form-select" required></div><button class="btn-submit-green">Change password</button></form>`);
  },
  checkFilter(el) { checkFilter[el.dataset.k] = el.dataset.v; refresh(); },
  async workerDetail(el, ev) {
    ev?.stopPropagation();
    const w = await api(`/api/workers/${el.dataset.id}`), rv = w.readiness_view;
    // Problems first, then passes. Checks that do not apply are left out.
    const rank = { fail: 0, unknown: 1, pass: 2 };
    const list = w.checks_list.filter((c) => c.status !== 'not_applicable').sort((a, b) => rank[a.status] - rank[b.status]);
    const openN = list.filter((c) => c.status !== 'pass').length;
    openModal(w.name, `${w.role || 'No role'} · ${w.facility || 'No location assigned'}`, h`<div class="pack-boxes">${rv.summary.map((s) => h`<div class="pack-box pack-box-${s.status}"><span>${words(s.pack)}</span>${statusPill(s.status)}<small>${s.open ? `${s.open} open` : s.status === 'restricted' ? 'Restricted' : 'Nothing open'}</small></div>`)}</div>
      <div class="readiness-note ${openN || !list.length ? 'is-open' : 'is-clear'}"><b>${!list.length ? 'No applicable checks yet' : openN ? `${openN} of ${list.length} visible checks still open` : 'All visible checks pass'}</b><span>${rv.statement}${w.readiness_request ? ` Waiting in Approvals since ${date(w.readiness_request.created_at)}, asked by ${w.readiness_request.requested_by}.` : ''}</span></div>
      ${table(['Requirement', 'Result', 'Why', ''], list.map((c) => h`<tr><td>${c.control_name}<div class="case-sub">${words(c.pack_key)}</div></td><td>${statusPill(c.status)}</td><td class="small">${c.reason}</td><td class="row-action">${canEdit() && (c.status !== 'pass' || /expir/.test(c.code || '')) ? h`<button class="btn-link-action" data-act="uploadEvidence" data-subject="worker:${w.id}" data-control="${c.control_key}" data-name="${w.name}">Upload</button>` : ''}</td></tr>`), 'No checks yet.')}`, workerFoot(w, openN, list.length), true);
  },
  // Suggests the locations the company already has, so a typo does not create a new one.
  moveWorker(el, ev) {
    ev?.stopPropagation();
    openModal(el.dataset.title || 'Change assignment', 'Aegis re-runs the checks that apply to the new location.', h`<form data-form="move" data-id="${el.dataset.id}"><div class="form-group"><label class="form-label" for="mvFacility">Location</label><input id="mvFacility" name="facility" class="form-select" list="mvLocations" autocomplete="off" required><datalist id="mvLocations">${knownLocations.map((f) => h`<option value="${f.name}">${f.state || ''}</option>`)}</datalist></div><div class="form-group"><label class="form-label" for="mvState">State</label><input id="mvState" name="facility_state" class="form-select" maxlength="2" placeholder="${knownLocations.length ? 'Filled in for a known location' : ''}"></div><button class="btn-submit-green">Save</button></form>`);
  },
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
  // From the upload window: close it and show that document in the Evidence inbox, scrolled into view.
  async openUploaded(el) {
    closeModal();
    if (el.dataset.id) evidenceSel = el.dataset.id;
    if (route === 'evidence') await refresh(); else { location.hash = 'evidence'; await new Promise((ok) => setTimeout(ok, 500)); }
    document.querySelector('.evidence-layout tr.selected')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  },
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
          <input type="file" name="file" required multiple data-upload-files aria-describedby="upHint" accept=".pdf,.docx,.doc,.rtf,.odt,.pages,.jpg,.jpeg,.png,.webp,.gif,.heic,.heif,.tif,.tiff,.bmp,.txt,.csv,.html,.htm,.eml,.msg,.zip">
          <span class="upload-drop-icon" aria-hidden="true"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4"/><path d="m7 9 5-5 5 5"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/></svg></span>
          <b data-upload-title>Drop files here, or <u>choose files</u></b>
          <span id="upHint" data-upload-count>One file, or several at once. PDF, Word, photos and scans (including iPhone and TIFF), text, emails or a .zip.</span>
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
  jumpConnections(el) {
    const heading = document.getElementById(el.dataset.target);
    heading?.focus();
  },
  async refreshConnections(el) {
    el.disabled = true;
    await refresh();
    const button = $('[data-act="refreshConnections"]');
    if (button) {
      button.focus();
      toast('Connections refreshed.', 'success');
    }
  },
  async syncConnector(el) {
    const id = el.dataset.id;
    el.disabled = true;
    el.textContent = 'Syncing…';
    try {
      const result = await api(`/api/connectors/${id}/sync`, {});
      const outcome = result.records || result.skipped ? `${plural(result.records, 'record')} synced.` : 'No new records to sync.';
      toast(`${outcome}${result.skipped ? ` ${result.skipped} skipped.` : ''}`, result.skipped ? 'warning' : 'success');
    } finally {
      if (route === 'integrations') {
        await refresh();
        $(`[data-act="syncConnector"][data-id="${CSS.escape(id)}"]`)?.focus();
      }
    }
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
  outboxMore() { outboxLimit += OUTBOX_PAGE * 2; filterOutbox(); },
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
  async chat(d, f) {
    if (await sendChat(d.text) && f.elements.text.value === d.text) f.reset();
  },
  async addWorker(d) { await api('/api/workers', d); toast('Worker added. Checks are running.', 'success'); closeModal(); setTimeout(after, 1200); },
  async move(d, f) {
    const known = knownLocations.find((x) => x.name.toLowerCase() === d.facility.trim().toLowerCase());
    const body = known ? { facility: known.name, facility_state: d.facility_state || known.state || '' } : d;
    await api(`/api/workers/${f.dataset.id}/assignment`, body); toast('Location saved. Checks are running.', 'success'); closeModal(); setTimeout(after, 1200);
  },
  async note(d, f) { await api(`/api/cases/${f.dataset.id}/note`, d); toast('Note added.', 'success'); ACT.caseDetail({ dataset: { id: f.dataset.id } }); },
  async importFile(d, f) {
    const p = await api('/api/import/preview', { file: await fileData(f.elements.file.files[0]) });
    openModal(`Review ${p.filename}`, `${p.total} worker(s) ready. Nothing is saved yet.`, h`${p.errors.length ? h`<div class="alert-box">${p.errors.length} row(s) will be skipped: ${p.errors.map((e) => `row ${e.row}: ${e.error}`).join('; ')}</div>` : ''}${p.unmapped.length ? h`<p class="small muted mb">Ignored columns: ${p.unmapped.join(', ')}</p>` : ''}<p class="small mb">Missing: ${p.missing.facility} location, ${p.missing.email} email, ${p.missing.hire_date} hire date. These will show as data gaps.</p>${table(['Name', 'Email', 'Role', 'Facility', 'Hire date'], p.sample.map((r) => h`<tr><td>${r.name}</td><td>${r.email}</td><td>${r.role}</td><td>${r.facility}</td><td>${r.hire_date}</td></tr>`), '')}`, h`<button class="btn-cancel" data-act="closeModal">Cancel</button><button class="btn-submit-green" data-act="commitImport" data-id="${p.id}">Import ${p.total} worker(s)</button>`, true);
  },
  // The upload window stays open and shows what happened to each file: accepted, sent to review
  // (with the reason), already on record, or not uploaded. One file failing does not stop the rest.
  async upload(d, f) {
    const [subject_type, subject_id] = d.subject.split(':'), files = [...f.elements.file.files], many = files.length > 1;
    const list = f.querySelector('[data-upload-list]'), done = [];
    const row = (i) => list.children[i];
    let failed = 0;
    list.hidden = false;
    list.innerHTML = render(files.map((file) => h`<li>${uploadRow(file.name, { state: 'waiting' })}</li>`));
    for (const field of f.querySelectorAll('input, select')) field.disabled = true;
    for (const [i, file] of files.entries()) {
      row(i).innerHTML = render(uploadRow(file.name, { state: 'reading' }));
      try {
        // With several files the document number and expiry are left for Aegis to read from each file.
        const r = await api('/api/evidence', { subject_type, subject_id, control_key: d.control_key || null, bulk: many, file: await fileData(file), claimed: many ? {} : { doc_number: d.doc_number, expires_on: d.expires_on } });
        done.push(...(r.files || [r]));
        row(i).innerHTML = render(uploadRow(file.name, r));
      } catch (err) { failed++; row(i).innerHTML = render(uploadRow(file.name, { state: 'failed', error: err.message })); }
    }
    const count = (test) => done.filter(test).length, fresh = done.filter((r) => !r.duplicate);
    const summary = [[count((r) => !r.duplicate && r.status === 'accepted'), 'accepted'], [count((r) => !r.duplicate && r.status !== 'accepted'), 'sent to review'], [count((r) => r.duplicate), 'already on record'], [failed, 'not uploaded']]
      .filter(([n]) => n).map(([n, w]) => `${n} ${w}`).join(' · ');
    f.querySelector('[data-upload-title]').textContent = summary ? `Done: ${summary}` : 'Done';
    f.querySelector('[data-upload-count]').textContent = 'Open a file to check what Aegis read, or close this window. New files are marked New in the inbox.';
    for (const r of fresh) recentUploads.add(r.id);
    const go = f.querySelector('[data-upload-go]');
    go.type = 'button'; go.dataset.act = 'openUploaded'; go.dataset.id = (fresh[0] || done.at(-1))?.id || ''; go.textContent = 'Go to the Evidence inbox';
    if (route === 'evidence') refresh();
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
  async coworkerPolicy(d) {
    await api('/api/coworker/settings', {
      enabled: !!d.enabled, follow_ups: !!d.follow_ups, dashboards: !!d.dashboards, slack: !!d.slack,
      retention_days: d.retention_days === '' ? null : Number(d.retention_days),
      daily_ai_calls: d.daily_ai_calls === '' ? null : Number(d.daily_ai_calls),
    });
    if ($('#chatDrawer').classList.contains('open')) await refreshChatView().catch(() => {});
    toast('Coworker policy saved.', 'success');
    refresh();
  },
  async user(d) { await api('/api/users', d); toast('User added.', 'success'); refresh(); },
  async userRole(d, f) { await api(`/api/users/${f.dataset.id}/role`, d); closeModal(); toast('Role saved.', 'success'); refresh(); },
  async userPassword(d, f) { await api(`/api/users/${f.dataset.id}/password`, d); closeModal(); toast('Password reset. They have been signed out everywhere.', 'success'); refresh(); },
  async myPassword(d) {
    if (d.password !== d.again) throw new Error('The two new passwords do not match.');
    await api('/api/me/password', { current: d.current, password: d.password });
    closeModal(); toast('Password changed. Other devices have been signed out.', 'success');
  },
  async login(d) { await api('/api/login', d); location.reload(); },
};
const CHAT_LINKS = { checks: 'Open checks', cases: 'Open cases', evidence: 'Open evidence', approvals: 'Open approvals', workers: 'Open workers' };
function chatText(text, fromCoworker) {
  const escaped = esc(text);
  if (!fromCoworker) return escaped.replace(/\n/g, '<br>');
  return escaped
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/#(cases\/CASE-[A-F0-9]{6,8}|dashboards\/dash_[a-f0-9]{12}|checks|cases|workers|evidence|approvals)(?=[\s.,]|$)/g, (_, path) => {
      const label = CHAT_LINKS[path] || (path.startsWith('dashboards/') ? 'Open dashboard' : path.split('/')[1]);
      return '<a href="#' + path + '">' + label + '</a>';
    })
    .replace(/\n/g, '<br>');
}
let chatOpener;
let chatBusy = false;
let chatHistoryVersion = 0;
let chatIndexVersion = 0;
let chatId, chatCapabilities = null, chatConversations = [];
let chatSuggestions = null;

function resetChat() {
  chatId = undefined;
  chatCapabilities = null;
  chatConversations = [];
  chatSuggestions = null;
  chatHistoryVersion++;
  chatIndexVersion++;
  $('#chatMessages').replaceChildren();
  $('#chatHistoryList').replaceChildren();
  $('#chatComposer form').reset();
  showChatHistory(false);
  syncChatControls();
}

function showChatHistory(open) {
  $('#chatHistoryButton').setAttribute('aria-expanded', String(open));
  $('#chatHistory').hidden = !open;
  $('#chatThread').hidden = open;
}

function syncChatControls() {
  const slackChat = chatConversations.some((chat) => chat.id === chatId && chat.source === 'slack');
  const enabled = chatCapabilities?.enabled === true;
  const canWrite = enabled && !slackChat;
  $('#chatNewButton').disabled = !enabled || chatBusy;
  $('#chatHistoryButton').disabled = chatBusy;
  $('#chatComposer').hidden = !canWrite;
  const reason = $('#chatUnavailable');
  reason.hidden = !chatCapabilities || canWrite;
  reason.textContent = slackChat ? 'Open a new chat to ask a question in Aegis.' : 'Ask coworker is turned off for this workspace.';
  const pack = route === 'checks' && checkFilter.pack ? checkFilter.pack + ' ' : '';
  const starters = ['Which ' + pack + 'checks need attention?', 'Which credentials expire next month?', 'What needs my approval?'];
  const questions = canWrite ? chatSuggestions ?? starters : [];
  $('#chatPromptsBar').hidden = questions.length === 0;
  $('#chatPromptsBar').classList.toggle('has-follow-ups', chatSuggestions !== null);
  $('#chatPromptLabel').textContent = chatSuggestions !== null ? 'Ask next' : 'Try asking';
  $('#chatPrompts').innerHTML = render(questions.map((q) => h`<button type="button" class="prompt-pill" data-act="prompt" data-q="${q}" ${chatBusy ? raw('disabled') : ''}>${q}</button>`));
  $('#chatNote').textContent = chatCapabilities?.follow_ups ? 'Follow-ups are queued after you confirm.' : 'Answers come from your Aegis records.';
}

function renderChatIndex() {
  $('#chatHistoryList').innerHTML = chatConversations.length ? render(h`<ul>${chatConversations.map((chat) => h`
    <li><button type="button" data-act="selectChat" data-chat-id="${chat.id}" aria-current="${chat.id === chatId}">
      <span>${chat.title}</span><span>${date(chat.updated_at)}</span>
    </button></li>`)}</ul>`) : '<p class="muted small">No previous chats. Conversations you start appear here.</p>';
}

async function loadChatIndex() {
  const version = ++chatIndexVersion;
  const result = await api('/api/chat/conversations');
  if (version !== chatIndexVersion) return false;
  chatCapabilities = result.capabilities;
  chatConversations = result.chats;
  if (chatId === undefined) chatId = chatConversations.find((chat) => chat.source === 'web')?.id ?? null;
  if (chatId && !chatConversations.some((chat) => chat.id === chatId)) {
    chatId = null;
    chatSuggestions = null;
    chatHistoryVersion++;
    $('#chatMessages').replaceChildren();
  }
  syncChatControls();
  renderChatIndex();
  return true;
}

async function refreshChatView() {
  if (await loadChatIndex() && $('#chatHistory').hidden) await loadChat();
}

function newChat() {
  if (chatBusy || !chatCapabilities?.enabled) return;
  chatId = null;
  $('#chatComposer form').reset();
  showChatHistory(false);
  syncChatControls();
  loadChat();
  $('#chatComposer input').focus({ preventScroll: true });
}

async function toggleChatHistory() {
  if (chatBusy) return;
  const open = $('#chatHistory').hidden;
  showChatHistory(open);
  if (!open) return refreshChatView();
  $('#chatHistoryList').textContent = 'Loading chats…';
  await loadChatIndex();
}

async function selectChat(button) {
  if (chatBusy || !chatConversations.some((chat) => chat.id === button.dataset.chatId)) return;
  chatId = button.dataset.chatId;
  $('#chatComposer form').reset();
  showChatHistory(false);
  syncChatControls();
  $('#chatHistoryButton').focus({ preventScroll: true });
  await loadChat();
}

async function openChat(opener) {
  const d = $('#chatDrawer');
  if (d.classList.contains('open')) return closeChat();
  chatOpener = opener;
  chatCapabilities = null;
  syncChatControls();
  d.classList.add('open');
  setChatExpanded(true);
  const close = d.querySelector('.btn-close-drawer');
  close.focus({ preventScroll: true });
  await refreshChatView();
  if (chatOpener === opener && !matchMedia('(pointer: coarse)').matches && !$('#chatComposer').hidden
    && (document.activeElement === close || document.activeElement === opener)) $('#chatComposer input').focus({ preventScroll: true });
}
function setChatExpanded(expanded) {
  for (const button of document.querySelectorAll('[aria-controls="chatDrawer"]')) {
    button.setAttribute('aria-expanded', String(expanded));
  }
}
function closeChat(restoreFocus = true) {
  const d = $('#chatDrawer'); if (!d.classList.contains('open')) return false;
  d.classList.remove('open');
  setChatExpanded(false);
  chatHistoryVersion++;
  chatIndexVersion++;
  chatSuggestions = null;
  $('#chatMessages').replaceChildren();
  $('#chatHistoryList').replaceChildren();
  showChatHistory(false);
  if (restoreFocus) {
    const button = chatOpener?.getClientRects().length
      ? chatOpener
      : [...document.querySelectorAll('[aria-controls="chatDrawer"]')].find((el) => el.getClientRects().length);
    button?.focus({ preventScroll: true });
  }
  chatOpener = null;
  return true;
}
async function loadChat() {
  const version = ++chatHistoryVersion;
  const selected = chatId, m = $('#chatMessages');
  m.replaceChildren();
  let list = [];
  if (selected) {
    try { list = await api('/api/chat?' + new URLSearchParams({ chat_id: selected })); }
    catch (error) {
      if (version !== chatHistoryVersion) return;
      if (error.status !== 404) throw error;
      chatId = null;
      syncChatControls();
    }
  }
  if (version !== chatHistoryVersion) return;
  chatSuggestions = list.at(-1)?.suggestions ?? null;
  m.innerHTML = list.length ? render(list.map((message) => {
    const fromCoworker = message.sender === 'bot';
    return h`<div class="chat-bubble ${fromCoworker ? 'bot' : 'user'}"><span class="chat-bubble-author">${message.author}</span><div class="chat-bubble-content">${raw(chatText(message.text, fromCoworker))}</div>${message.confirmation ? h`<button type="button" class="prompt-pill chat-confirm" data-act="prompt" data-q="${message.confirmation}">Confirm follow-ups</button>` : ''}</div>`;
  })) : chatCapabilities?.enabled ? '<div class="empty chat-empty">Ask about gaps, expirations or approvals.</div>' : '';
  syncChatControls();
  m.scrollTop = m.scrollHeight;
}
async function sendChat(text) {
  if (!text?.trim() || chatBusy || $('#chatComposer').hidden) return false;
  chatBusy = true;
  syncChatControls();
  const status = $('#chatStatus');
  status.textContent = 'Working on your request…';
  try {
    const result = await api('/api/chat', { text, chat_id: chatId ?? null });
    chatId = result.chat_id;
    if ($('#chatDrawer').classList.contains('open')) await loadChat().catch(() => toast('Your reply was saved. Reopen Ask coworker to see it.', 'warning'));
    if (result.updated) refresh();
    return true;
  } catch (error) {
    toast(error.message, 'warning');
    if ([403, 404, 409].includes(error.status)) await refreshChatView().catch(() => {});
    return false;
  } finally {
    status.textContent = '';
    chatBusy = false;
    syncChatControls();
  }
}
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
let signupEnabled = false;
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
  navigation++;
  me = null;
  closeModal();
  setNavigationOpen(false);
  closeChat(false);
  const as = $('#appShell'); if (as) { as.hidden = true; as.style.display = 'none'; }
  const ls = $('#loginScreen'); if (ls) { ls.hidden = false; ls.style.display = 'block'; }
  document.body.style.background = 'var(--wall)';

  const info = await fetch('/api/public/info').then((r) => r.json()).catch(() => ({}));
  demoEnabled = info.demo === true;
  signupEnabled = info.signup === true;
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
          ${signupEnabled ? `<p class="auth-switch"><a href="#signup">Create a workspace</a></p>` : ''}

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
  if (signupEnabled && location.hash === '#signup') renderSignup();
}

const SIGNUP_FIELDS = [
  { name: 'org_name', label: 'Organisation name', autocomplete: 'organization', min: 2, max: 120, error: 'Enter an organisation name of 2 to 120 characters.' },
  { name: 'admin_name', label: 'Your full name', autocomplete: 'name', min: 2, max: 120, error: 'Enter your full name of 2 to 120 characters.' },
  { name: 'email', label: 'Work email', autocomplete: 'email', type: 'email', max: 254, error: 'Enter a valid work email.' },
  { name: 'password', label: 'Password', autocomplete: 'new-password', type: 'password', min: 12, max: 128, error: 'Use a password of 12 to 128 characters.' },
];

function renderSignup() {
  const desk = $('#loginScreen .main-desk');
  desk.innerHTML = render(h`
    <h1 tabindex="-1">Create a workspace</h1>
    <p class="lead">Set up your organisation in Aegis. You’ll be the first administrator.</p>
    <form id="signup-form" class="form-desk" novalidate>
      ${SIGNUP_FIELDS.map((f) => h`<div>
        <label for="new-${f.name}">${f.label}</label>
        <input id="new-${f.name}" name="${f.name}" type="${f.type || 'text'}" autocomplete="${f.autocomplete}" maxlength="${f.max}"
          aria-describedby="error-${f.name}${f.name === 'password' ? ' signup-password-hint' : ''}" required>
        ${f.name === 'password' ? h`<p id="signup-password-hint" class="signup-hint">Use at least 12 characters.</p>` : ''}
        <p id="error-${f.name}" class="signup-error" aria-live="polite"></p>
      </div>`)}
      <button class="primary primary-badge-btn" type="submit">Create workspace</button>
      <p class="signup-error" id="signup-error" role="alert"></p>
    </form>
    <p class="auth-switch">Already have an account? <a href="#">Sign in</a></p>
  `);
  window.scrollTo(0, 0);
  desk.querySelector('h1').focus({ preventScroll: true });
  $('#signup-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget, values = Object.fromEntries(new FormData(form));
    let firstInvalid = null;
    for (const f of SIGNUP_FIELDS) {
      const input = form.elements[f.name];
      const value = f.name === 'password' ? values[f.name] : values[f.name].trim();
      values[f.name] = value;
      const valid = f.type === 'email' ? /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) : value.length >= f.min && value.length <= f.max;
      $('#error-' + f.name).textContent = valid ? '' : f.error;
      input.setAttribute('aria-invalid', String(!valid));
      if (!valid && !firstInvalid) firstInvalid = input;
    }
    if (firstInvalid) { firstInvalid.focus(); return; }
    const error = $('#signup-error'), submit = form.querySelector('button[type="submit"]');
    error.textContent = '';
    submit.disabled = true;
    try {
      await api('/api/signup', values);
      history.replaceState(null, '', '#setup');
      await boot();
    } catch (err) {
      error.textContent = err.message;
    } finally { submit.disabled = false; }
  });
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

  // The mobile dialog traps focus and restores it to the menu button on close.
  if (ev.target.closest('#menu')) {
    setNavigationOpen(true);
    return;
  }
  if (ev.target.id === 'sheet' || ev.target.closest('#closeNavigation')) {
    setNavigationOpen(false);
    return;
  }
  if (ev.target.closest('.rail-disclosure')) {
    setDashboardViewsOpen(!dashboardViewsOpen);
    return;
  }
  const dashboardLink = ev.target.closest('.rail-tree .rail-link');
  const plainClick = !ev.ctrlKey && !ev.metaKey && !ev.shiftKey && !ev.altKey;
  const iconOnly = dashboardLink?.closest('.workspace-rail') && document.documentElement.classList.contains('rail-collapsed');
  if (dashboardLink && plainClick && !iconOnly && route === 'dashboards' && !routeArg) {
    ev.preventDefault();
    setDashboardViewsOpen(!dashboardViewsOpen);
    return;
  }
  if (plainClick && ev.target.closest('#sheet :is(.rail-link, .rail-sublink)')) {
    setNavigationOpen(false);
    return;
  }
  if (ev.target.closest('.skip-main')) {
    ev.preventDefault();
    $('#workspace-main').focus();
    return;
  }

  const dirLink = ev.target.closest('.dir a');
  if (dirLink) {
    const act = dirLink.dataset.act;
    const href = dirLink.getAttribute('href');
    closeAllDirMenus();
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
  if ($('#sheet').open) return;
  if (e.key === 'Escape') {
    // Escape closes the top-most thing: a window, then the coworker panel, then the case selection.
    if ($('#modal').classList.contains('open')) closeModal();
    else if (closeChat()) { /* closed the coworker panel */ }
    else if (caseSel.size) clearCaseSelection();
    closeDemoRack();
    closeAllDirMenus();
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
$('#sheet').addEventListener('cancel', (e) => {
  e.preventDefault();
  setNavigationOpen(false);
});
matchMedia('(max-width: 760px)').addEventListener('change', (e) => {
  if (!e.matches) setNavigationOpen(false);
});
$('#globalSearch')?.addEventListener('input', (e) => filterRows(e.target.value));
document.addEventListener('input', (e) => {
  if (e.target.id === 'outboxSearch') outboxFilter.query = e.target.value;
  else if (e.target.id === 'outboxChannel') outboxFilter.channel = e.target.value;
  else return;
  outboxLimit = OUTBOX_PAGE;
  filterOutbox();
});
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
  form.querySelector('[data-upload-count]').textContent = n > 1 ? 'Bulk upload: Aegis reads the document number and expiry from each file.' : 'One file, or several at once. PDF, Word, photos and scans (including iPhone and TIFF), text, emails or a .zip.';
  const list = form.querySelector('[data-upload-list]');
  list.hidden = !n;
  list.innerHTML = render(files.map((f) => h`<li><span class="upload-file-name">${f.name}</span><span class="upload-file-size">${fileSize(f.size)}</span></li>`));
  form.querySelector('[data-upload-go]').textContent = n > 1 ? `Upload ${n} files` : 'Upload';
});
// Evidence review: fill in the text of a document when its panel appears, and say so plainly when a
// preview cannot be shown. textContent keeps document text as text, never as page markup.
const previewText = new Map();
function loadPreviewText() {
  for (const el of document.querySelectorAll('[data-preview-text]:not([data-loaded])')) {
    el.dataset.loaded = '1';
    const id = el.dataset.previewText;
    if (!previewText.has(id)) previewText.set(id, api(`/api/evidence/${id}/preview`).then((d) => d.text || '', (err) => { previewText.delete(id); throw err; }));
    previewText.get(id).then((text) => { el.textContent = text || 'No text was found in this document.'; }, (err) => { el.textContent = err.message; el.classList.add('is-error'); });
  }
}
new MutationObserver(loadPreviewText).observe(document.documentElement, { childList: true, subtree: true });
document.addEventListener('error', (e) => {
  const img = e.target; if (!(img instanceof HTMLImageElement) || !img.closest('.ev-preview')) return;
  const note = document.createElement('p'); note.className = 'muted small'; note.textContent = 'Aegis cannot show this file here. Download it to open it.';
  img.closest('.ev-preview').replaceWith(note);
}, true);
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
document.addEventListener('click', (e) => {
  for (const m of document.querySelectorAll('details.row-menu[open]')) if (!m.contains(e.target) || e.target.closest('.row-menu-list button')) m.open = false;
});
window.addEventListener('hashchange', readHash);
fetch('/api/me').then((r) => { if (r.ok) boot(); else showLogin(); });
