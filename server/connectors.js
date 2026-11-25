'use strict';
// Reusable connector layer: every source maps into one internal worker record.
const db = require('./lib/db'), { clock, id, j, count, placeKey, stateCode, encrypt, decrypt, parseCsv, parseXlsx, normDate } = require('./lib/util');
const P = require('./platform');
const { HttpError, SYSTEM } = P;
const inferCategory = (r) => /\b(nurse|rn|np|lpn|physician|therapist|md|pt|clinician|pediatrician)\b/i.test(`${r.role} ${r.license_type || ''}`) ? 'clinical' : 'corporate';

// A company or location is found by its name however it is capitalized or spaced, so
// "st. jude medical center" from a form or a sync never becomes a second St. Jude Medical Center.
const findPlace = (table, t, name) => db.all(`SELECT * FROM ${table} WHERE tenant_id=?`, t).find((x) => placeKey(x.name) === placeKey(name));
const cleanName = (name) => String(name || '').trim().replace(/\s+/g, ' ');
function ensureEntity(t, name) {
  if (!cleanName(name)) return null;
  let e = findPlace('entities', t, name);
  if (!e) { e = { id: id('ent'), tenant_id: t, name: cleanName(name) }; db.insert('entities', e); }
  return e.id;
}
function ensureFacility(t, name, state) {
  let f = findPlace('facilities', t, name);
  if (!f) { f = { id: id('fac'), tenant_id: t, name: cleanName(name), state: stateCode(state) || state || null }; db.insert('facilities', f); }
  return f.id;
}
function assignWorker(t, worker, facility, state, start, actor) {
  const fid = ensureFacility(t, facility, state);
  const cur = db.get("SELECT * FROM assignments WHERE tenant_id=? AND worker_id=? AND status='active'", t, worker.id);
  if (cur?.facility_id === fid) return false;
  if (cur) db.update('assignments', cur.id, { status: 'ended', end_date: clock.today() });
  db.insert('assignments', { id: id('asn'), tenant_id: t, worker_id: worker.id, facility_id: fid, role: worker.role, start_date: normDate(start) || clock.today(), status: 'active' });
  if (cur) P.audit(t, 'ASSIGNMENT_CHANGED', worker.name, `Assignment moved to ${db.get('SELECT name FROM facilities WHERE id=?', fid).name}.`, actor);
  return true;
}
// A location or company typed by a person: an existing one by its saved name, or a new one that
// is spelled out on purpose. A new location needs its US state, because state rules depend on it.
function placesFrom(t, { facility, facility_state, entity }) {
  const out = { facility: null, facility_state: null, entity: null };
  if (cleanName(facility)) {
    const known = findPlace('facilities', t, facility);
    if (known) Object.assign(out, { facility: known.name, facility_state: known.state });
    else {
      const state = stateCode(facility_state);
      if (!state) throw new HttpError(400, `Choose the US state ${cleanName(facility)} is in. Aegis uses it to know which state rules apply.`);
      Object.assign(out, { facility: cleanName(facility), facility_state: state });
    }
  }
  if (cleanName(entity)) out.entity = findPlace('entities', t, entity)?.name || cleanName(entity);
  return out;
}
function changeAssignment(t, worker, facility, state, actor) {
  return db.tx(() => {
    if (worker.status !== 'active') throw new HttpError(409, 'Only an active worker can be reassigned.');
    if (assignWorker(t, worker, facility, state, null, actor)) {
      P.enqueue(t, 'evaluate_subject', { type: 'worker', id: worker.id, trigger: 'assignment_changed' }, { dedupe: `eval:worker:${worker.id}` });
    }
  });
}
function upsertWorker(t, rec, source, actor = SYSTEM) {
  return db.tx(() => {
    let w = rec.external_id ? db.get('SELECT * FROM workers WHERE tenant_id=? AND source=? AND external_id=?', t, source, rec.external_id) : null;
    if (!w && rec.email) {
      const matches = db.all('SELECT * FROM workers WHERE tenant_id=? AND lower(email)=lower(?) LIMIT 2', t, rec.email);
      if (matches.length > 1 || (source === 'manual' && matches.length)) throw new HttpError(409, 'A worker with this email already exists. Open the existing worker record.');
      w = matches[0];
    }
    const entity_id = ensureEntity(t, rec.entity), now = clock.iso();
    const fields = { name: rec.name, email: rec.email || null, slack_id: rec.slack_id || null, role: rec.role || null, category: rec.category || inferCategory(rec), dept: rec.dept || null, license_type: rec.license_type || null, entity_id, status: rec.status || 'active', hire_date: normDate(rec.hire_date), work_auth_expires: normDate(rec.work_auth_expires), attrs_json: JSON.stringify(rec.attrs || {}), updated_at: now };
    if (w && source === 'spreadsheet') {
      for (const key of Object.keys(fields)) {
        const input = { entity_id: 'entity', attrs_json: 'attrs' }[key] || key;
        if (key !== 'updated_at' && (rec[input] == null || rec[input] === '' || fields[key] == null)) delete fields[key];
      }
    }
    // A sync without an email never erases one added in Aegis; an email from the HR system replaces it.
    if (w?.email && !fields.email) delete fields.email;
    let changed = true, created = false;
    if (w) {
      changed = Object.keys(fields).some((k) => k !== 'updated_at' && (w[k] ?? null) !== (fields[k] ?? null));
      if (changed) db.update('workers', w.id, fields);
    } else {
      w = { id: id('wkr'), tenant_id: t, external_id: rec.external_id || null, source, created_at: now, ...fields };
      db.insert('workers', w); created = true;
      P.audit(t, 'WORKER_ADDED', rec.name, `Added from ${source}.`, actor);
    }
    const moved = rec.facility && !(source === 'spreadsheet' && w.status !== 'active')
      ? assignWorker(t, { ...w, ...fields }, rec.facility, rec.facility_state, rec.assignment_start, actor) : false;
    if (created || changed || moved) P.enqueue(t, 'evaluate_subject', { type: 'worker', id: w.id, trigger: created ? 'worker_added' : moved ? 'assignment_changed' : 'worker_updated' }, { dedupe: `eval:worker:${w.id}` });
    return { id: w.id, created, changed: changed || moved };
  });
}
function createConnector(t, { type, name, config, capabilities }) {
  const c = { id: id('con'), tenant_id: t, type, name, config_enc: encrypt(Buffer.from(JSON.stringify(config))).toString('base64'), status: 'connected', capabilities_json: JSON.stringify(capabilities || []) };
  db.insert('connectors', c);
  return c;
}
const configOf = (c) => JSON.parse(decrypt(Buffer.from(c.config_enc, 'base64')).toString());
const saveConfig = (c, cfg) => db.update('connectors', c.id, { config_enc: encrypt(Buffer.from(JSON.stringify(cfg))).toString('base64') });
const baseUrl = (cfg) => cfg.base_url === 'self' ? `http://127.0.0.1:${process.env.ACTUAL_PORT}/mock-hrms` : cfg.base_url;

// ---- HRMS connector settings
// Everything about the real HRMS API lives in the connector's settings, so connecting it is
// configuration, not code. Settings are stored encrypted. Only base_url and the credentials
// are required; every other setting has a default that matches the mock HRMS.
//   base_url        https://hrms.example.com/api/v1
//   path            /workers (the list endpoint)
//   auth_type       bearer (default) | header (API key in a custom header) | basic | none
//   api_key         the key or token. For basic, also username and password instead.
//   auth_header     header name for auth_type=header, for example X-API-Key
//   pagination      cursor (default: follow next_cursor) | page (page=1,2,...) | none (one request)
//   page_param, page_size_param, page_size, first_page    for pagination=page
//   since_param     query parameter for incremental sync (default since)
//   cursor_field    where the response puts the next cursor (default next_cursor, dotted path allowed)
//   incremental     cursor (default: send the saved cursor) | last_sync (send the last sync time) | none (full sync)
//   list_field      where the list of workers is in the response (default: auto-detect)
//   field_map       { "name": "person.displayName", ... } dotted paths that override the defaults below
//   terminated_values  status values that mean the person has left (default terminated, separated, resigned, former, ended)
//   timeout_ms      per request (default 20000)
//   webhook_signature_header  header the HRMS signs webhooks in (default x-aegis-signature)
const AUTH_TYPES = ['bearer', 'header', 'basic', 'none'], PAGINATION = ['cursor', 'page', 'none'], INCREMENTAL = ['cursor', 'last_sync', 'none'];
const DEFAULT_TERMINATED = ['terminated', 'separated', 'resigned', 'former', 'ended'];
// Where each internal field is looked for in an HRMS record, in order. field_map wins over these.
const DEFAULT_PATHS = {
  external_id: ['id', 'external_id', 'employee_id', 'worker_id', 'emp_id'],
  name: ['full_name', 'name'],
  first_name: ['first_name', 'firstName'],
  last_name: ['last_name', 'lastName'],
  email: ['work_email', 'email'],
  slack_id: ['slack_id'],
  role: ['job_title', 'role', 'title', 'designation'],
  category: ['worker_type', 'category'],
  dept: ['department', 'dept'],
  license_type: ['license_type'],
  entity: ['employing_entity', 'entity', 'company'],
  status: ['employment_status', 'status'],
  hire_date: ['hire_date', 'start_date', 'joining_date'],
  work_auth_expires: ['work_auth_expires', 'visa_expires'],
  facility: ['assignment.facility', 'facility', 'location', 'work_location'],
  facility_state: ['assignment.state', 'facility_state', 'state'],
  assignment_start: ['assignment.start_date', 'assignment_start', 'hire_date'],
  attrs: ['attributes', 'attrs'],
};
const MAPPABLE = Object.keys(DEFAULT_PATHS);
const pick = (o, p) => String(p).split('.').reduce((x, k) => (x == null ? undefined : x[k]), o);
const scalar = (v) => (typeof v === 'string' || typeof v === 'number') && String(v).trim() ? String(v).trim() : null;

function validateConfig(input, existing = {}) {
  const cfg = { ...existing };
  for (const [k, v] of Object.entries(input || {})) if (v !== undefined && v !== '') cfg[k] = v;
  if (!cfg.base_url) throw new HttpError(400, 'Base URL is required.');
  if (cfg.base_url !== 'self') {
    let u;
    try { u = new URL(cfg.base_url); } catch { throw new HttpError(400, 'Base URL is not a valid URL.'); }
    if (!/^https?:$/.test(u.protocol)) throw new HttpError(400, 'Base URL must start with https://.');
    if (u.protocol !== 'https:' && process.env.NODE_ENV === 'production') throw new HttpError(400, 'In production the HRMS must use https://.');
    // Cloud metadata addresses would let a connector read server credentials.
    if (/^(169\.254\.|\[?fe80:)|^metadata(\.google\.internal)?$/i.test(u.hostname)) throw new HttpError(400, 'That address is not allowed for a connector.');
    cfg.base_url = u.toString().replace(/\/+$/, '');
  }
  cfg.auth_type = cfg.auth_type || 'bearer';
  if (!AUTH_TYPES.includes(cfg.auth_type)) throw new HttpError(400, `auth_type must be one of ${AUTH_TYPES.join(', ')}.`);
  if (cfg.auth_type === 'basic' ? !(cfg.username || cfg.api_key) : cfg.auth_type !== 'none' && !cfg.api_key) throw new HttpError(400, cfg.auth_type === 'basic' ? 'Username and password are required.' : 'API key is required.');
  if (cfg.auth_type === 'header' && !/^[\w-]+$/.test(cfg.auth_header || '')) throw new HttpError(400, 'auth_header must be a header name, for example X-API-Key.');
  cfg.pagination = cfg.pagination || 'cursor';
  if (!PAGINATION.includes(cfg.pagination)) throw new HttpError(400, `pagination must be one of ${PAGINATION.join(', ')}.`);
  cfg.incremental = cfg.incremental || 'cursor';
  if (!INCREMENTAL.includes(cfg.incremental)) throw new HttpError(400, `incremental must be one of ${INCREMENTAL.join(', ')}.`);
  if (cfg.path && !String(cfg.path).startsWith('/')) cfg.path = '/' + cfg.path;
  if (cfg.page_size != null) { cfg.page_size = +cfg.page_size; if (!Number.isInteger(cfg.page_size) || cfg.page_size < 1 || cfg.page_size > 1000) throw new HttpError(400, 'page_size must be a whole number from 1 to 1000.'); }
  if (cfg.timeout_ms != null) { cfg.timeout_ms = +cfg.timeout_ms; if (!(cfg.timeout_ms >= 1000 && cfg.timeout_ms <= 120000)) throw new HttpError(400, 'timeout_ms must be from 1000 to 120000.'); }
  if (cfg.field_map != null) {
    if (typeof cfg.field_map !== 'object' || Array.isArray(cfg.field_map)) throw new HttpError(400, 'field_map must be an object like { "name": "person.displayName" }.');
    for (const [k, v] of Object.entries(cfg.field_map)) {
      if (!MAPPABLE.includes(k)) throw new HttpError(400, `field_map has an unknown field "${k}". Known fields: ${MAPPABLE.join(', ')}.`);
      if (typeof v !== 'string' || !v) throw new HttpError(400, `field_map.${k} must be a path like "person.email".`);
    }
  }
  if (cfg.terminated_values != null && !Array.isArray(cfg.terminated_values)) throw new HttpError(400, 'terminated_values must be a list.');
  return cfg;
}
// Settings without secrets, for showing in the UI.
const publicConfig = (cfg) => { const { api_key, password, ...rest } = cfg; return { ...rest, has_api_key: !!api_key, has_password: !!password }; };

function authHeaders(cfg) {
  const t = cfg.auth_type || 'bearer';
  if (t === 'none') return {};
  if (t === 'header') return { [String(cfg.auth_header).toLowerCase()]: cfg.api_key };
  if (t === 'basic') {
    const raw = cfg.username ? `${cfg.username}:${cfg.password || ''}` : cfg.api_key;
    return { authorization: `Basic ${raw.includes(':') ? Buffer.from(raw).toString('base64') : raw}` };
  }
  return { authorization: `Bearer ${cfg.api_key}` };
}
function pageUrl(cfg, { since, page }) {
  const u = new URL(baseUrl(cfg) + (cfg.path || '/workers'));
  if (since) u.searchParams.set(cfg.since_param || 'since', since);
  if (page != null) {
    u.searchParams.set(cfg.page_param || 'page', String(page));
    if (cfg.page_size) u.searchParams.set(cfg.page_size_param || 'per_page', String(cfg.page_size));
  }
  return u.toString();
}
async function fetchJson(cfg, url) {
  let res;
  try {
    res = await fetch(url, { headers: { accept: 'application/json', ...authHeaders(cfg) }, redirect: 'error', signal: AbortSignal.timeout(cfg.timeout_ms || 20000) });
  } catch (e) {
    throw new Error(e.name === 'TimeoutError' ? `no answer within ${(cfg.timeout_ms || 20000) / 1000}s` : `could not reach the HRMS (${e.cause?.code || e.message})`);
  }
  if (res.status === 401 || res.status === 403) throw new Error(`the HRMS refused the credentials (${res.status}). Check the API key and auth settings.`);
  if (res.status === 404) throw new Error('the HRMS returned 404. Check the base URL and path.');
  if (res.status === 429) throw new Error('the HRMS is rate limiting requests (429). The sync will retry.');
  if (!res.ok) throw new Error(`HRMS returned ${res.status}`);
  try { return await res.json(); } catch { throw new Error('the HRMS response was not JSON.'); }
}
function listOf(body, cfg) {
  const list = cfg.list_field ? pick(body, cfg.list_field) : Array.isArray(body) ? body : (body?.workers || body?.data || body?.employees || body?.results || body?.items || []);
  if (!Array.isArray(list)) throw new Error(cfg.list_field ? `the response has no list at "${cfg.list_field}".` : 'could not find the list of workers in the response. Set list_field.');
  return list;
}
// Reads every page. onPage gets each page's records. Returns the cursor to save.
async function readWorkers(cfg, since, onPage, { maxPages = 500 } = {}) {
  const mode = cfg.pagination || 'cursor';
  let page = mode === 'page' ? (cfg.first_page ?? 1) : null, pages = 0, cursor = since || null, last = since || null;
  while (pages < maxPages) {
    const body = await fetchJson(cfg, pageUrl(cfg, { since: mode === 'cursor' ? cursor : since, page }));
    const list = listOf(body, cfg); pages++;
    onPage(list);
    const next = scalar(pick(body, cfg.cursor_field || 'next_cursor'));
    if (next) last = next;
    if (mode === 'none' || !list.length || body?.has_more === false) break;
    if (mode === 'page') { if (cfg.page_size && list.length < cfg.page_size) break; page++; continue; }
    if (!next || next === cursor) break;
    cursor = next;
  }
  return { cursor: last, pages, truncated: pages >= maxPages };
}

// Maps one HRMS record into the internal worker record.
function mapHrms(r, cfg = {}) {
  const fm = cfg.field_map || {};
  const val = (k) => { for (const p of fm[k] ? [fm[k]] : DEFAULT_PATHS[k]) { const v = pick(r, p); if (v != null && v !== '') return v; } return null; };
  const s = (k) => scalar(val(k));
  const role = s('role'), license_type = s('license_type'), cat = s('category'), attrs = val('attrs');
  const terminated = (cfg.terminated_values || DEFAULT_TERMINATED).map((x) => String(x).toLowerCase());
  return {
    external_id: s('external_id') || '',
    name: s('name') || [s('first_name'), s('last_name')].filter(Boolean).join(' '),
    email: s('email') || '',
    slack_id: s('slack_id'),
    role,
    category: cat ? (/clin/i.test(cat) ? 'clinical' : /corp/i.test(cat) ? 'corporate' : cat) : inferCategory({ role, license_type }),
    dept: s('dept'),
    license_type,
    entity: s('entity'),
    status: terminated.includes((s('status') || '').toLowerCase()) ? 'terminated' : 'active',
    hire_date: normDate(s('hire_date')),
    work_auth_expires: normDate(s('work_auth_expires')),
    facility: s('facility'),
    facility_state: s('facility_state'),
    assignment_start: normDate(s('assignment_start')),
    attrs: attrs && typeof attrs === 'object' && !Array.isArray(attrs) ? attrs : {},
  };
}
// A record that cannot be matched safely is skipped and reported, never guessed.
const recordProblem = (rec) => !rec.name ? 'no name' : !rec.external_id && !rec.email ? 'no id or email, so it cannot be matched to a worker' : null;

async function syncConnector(t, connId, actor = SYSTEM) {
  const c = db.get('SELECT * FROM connectors WHERE id=? AND tenant_id=?', connId, t);
  if (!c) throw new HttpError(404, 'Connector not found.');
  if (c.status === 'disabled') throw new HttpError(409, 'This connector is turned off.');
  const cfg = configOf(c), startedAt = new Date().toISOString();
  const since = cfg.incremental === 'none' ? null : cfg.incremental === 'last_sync' ? c.last_sync_at : c.cursor;
  let n = 0, created = 0;
  const skipped = [];
  try {
    const r = await readWorkers(cfg, since, (list) => {
      for (const raw of list) {
        const rec = mapHrms(raw, cfg), problem = recordProblem(rec);
        if (problem) { skipped.push({ external_id: rec.external_id || null, problem }); continue; }
        if (upsertWorker(t, rec, c.id, actor).created) created++;
        n++;
      }
    });
    const cursor = cfg.incremental === 'last_sync' ? startedAt : r.cursor || c.cursor;
    db.update('connectors', c.id, { cursor, status: 'connected', last_sync_at: startedAt, last_error: skipped.length ? `${count(skipped.length, 'record')} skipped in the last sync: ${skipped[0].problem}.` : null, records: c.records + n });
    P.audit(t, 'HRMS_SYNC', c.name, `Synchronized ${count(n, 'changed record')}${skipped.length ? `, skipped ${skipped.length} that could not be matched safely` : ''}.`, actor, { detail: { pages: r.pages, created, skipped: skipped.length } });
    return { records: n, created, skipped: skipped.length, skipped_examples: skipped.slice(0, 10), pages: r.pages, truncated: r.truncated };
  } catch (e) {
    db.update('connectors', c.id, { status: 'error', last_error: e.message });
    P.audit(t, 'CONNECTOR_ERROR', c.name, `Sync failed: ${e.message}`, actor);
    throw new HttpError(502, `HRMS sync failed: ${e.message}`);
  }
}

// Dry run: reads the first page and shows how records would map. Saves nothing.
async function testConnection(cfg) {
  let body;
  try { body = await fetchJson(cfg, pageUrl(cfg, { page: cfg.pagination === 'page' ? (cfg.first_page ?? 1) : null })); }
  catch (e) { return { ok: false, error: e.message }; }
  let list;
  try { list = listOf(body, cfg); } catch (e) { return { ok: false, error: e.message, response_keys: body && typeof body === 'object' ? Object.keys(body) : [] }; }
  const fields = new Set();
  const walk = (o, pre = '', depth = 0) => { for (const [k, v] of Object.entries(o || {})) { const key = pre + k; if (v && typeof v === 'object' && !Array.isArray(v) && depth < 2) walk(v, key + '.', depth + 1); else fields.add(key); } };
  list.slice(0, 20).forEach((r) => walk(r));
  const mapped = list.slice(0, 5).map((r) => mapHrms(r, cfg));
  const empty = ['external_id', 'name', 'email', 'role', 'facility', 'hire_date', 'status'].filter((k) => mapped.length && mapped.every((m) => !m[k]));
  return {
    ok: true,
    records_on_first_page: list.length,
    next_cursor: scalar(pick(body, cfg.cursor_field || 'next_cursor')),
    source_fields: [...fields].sort(),
    sample: mapped.map((m) => ({ external_id: m.external_id, name: m.name, email: m.email, role: m.role, category: m.category, facility: m.facility, status: m.status, hire_date: m.hire_date, problem: recordProblem(m) })),
    fields_never_found: empty,
  };
}

// Webhook payloads differ between systems: the worker may sit under worker, data, employee or payload.
// A "thin" event that only names a worker triggers a sync instead, so Aegis reads the full record.
function processHrmsEvent(t, { event_id }) {
  const ev = db.get('SELECT * FROM events WHERE id=? AND tenant_id=?', event_id, t);
  if (!ev || ev.status === 'processed') return;
  const p = j(ev.payload_json, {}), c = db.get('SELECT * FROM connectors WHERE tenant_id=? AND id=?', t, ev.source);
  if (!c) { db.update('events', ev.id, { status: 'failed', error: 'The connector for this event no longer exists.' }); return; }
  const cfg = configOf(c);
  const raw = [p.worker, p.data, p.employee, p.payload].find((x) => x && typeof x === 'object');
  const rec = raw && mapHrms(raw, cfg), problem = rec ? recordProblem(rec) : 'no worker in the event';
  if (problem) {
    P.enqueue(t, 'sync_connector', { id: c.id }, { dedupe: `sync:${c.id}:event:${ev.id}` });
    db.update('events', ev.id, { status: 'processed', processed_at: clock.iso(), error: `Event had ${problem}; a sync was started instead.` });
    P.audit(t, 'HRMS_EVENT', rec?.name || 'HRMS', `Received ${p.type || 'an event'} without a complete worker record, so a sync was started.`);
    return;
  }
  upsertWorker(t, rec, c.id);
  db.update('events', ev.id, { status: 'processed', processed_at: clock.iso() });
  P.audit(t, 'HRMS_EVENT', rec.name, `Processed ${p.type || 'event'}.`);
}
const HEADERS = { external_id: /^(?:(?:employee|worker|external)\s*)?(?:id|number|no\.?)$/i, name: /^(?:(?:full|worker|employee)\s*)?name$|^(worker|employee)$/i, email: /e-?mail/i, role: /role|title|position/i, dept: /dep(t|artment)/i, facility_state: /^(?:(?:facility|work|location) )?state$/i, facility: /facility|location|site/i, entity: /entity|employer/i, license_type: /licen[sc]e ?type/i, hire_date: /hire|start/i, category: /category|worker type/i };
function previewImport(t, user, { filename, data }) {
  let rows;
  try { rows = /\.xlsx$/i.test(filename) ? parseXlsx(data) : parseCsv(data.toString('utf8')); }
  catch (e) { throw new HttpError(400, `Could not read file: ${e.message}`); }
  if (rows.length < 2) throw new HttpError(400, 'The file needs a header row and at least one worker.');
  const mapping = rows[0].map((h) => Object.keys(HEADERS).find((k) => HEADERS[k].test(String(h).trim().replace(/[_-]+/g, ' '))) || null);
  if (!mapping.includes('name')) throw new HttpError(400, 'No name column found.');
  const out = [], errors = [], unmapped = rows[0].filter((_, i) => !mapping[i]);
  rows.slice(1).forEach((r, i) => {
    const rec = {};
    mapping.forEach((k, c) => { if (k && r[c] !== undefined && String(r[c]).trim()) rec[k] = String(r[c]).trim(); });
    if (!rec.name) { errors.push({ row: i + 2, error: 'Missing name' }); return; }
    if (rec.category) {
      const category = rec.category.toLowerCase().replace(/[\s-]+/g, '');
      if (!['clinical', 'nonclinical', 'corporate'].includes(category)) { errors.push({ row: i + 2, error: 'Category must be clinical, non-clinical or corporate' }); return; }
      rec.category = category === 'clinical' ? 'clinical' : 'corporate';
    }
    out.push(rec);
  });
  const imp = { id: id('imp'), tenant_id: t, filename, rows_json: JSON.stringify(out), status: 'preview', created_by: user.name, created_at: clock.iso() };
  db.insert('imports', imp);
  return { id: imp.id, filename, total: out.length, errors, unmapped, sample: out.slice(0, 10), missing: { facility: out.filter((r) => !r.facility).length, email: out.filter((r) => !r.email).length, hire_date: out.filter((r) => !r.hire_date).length } };
}
function commitImport(t, user, impId) {
  return db.tx(() => {
    const imp = db.get("SELECT * FROM imports WHERE id=? AND tenant_id=? AND status='preview'", impId, t);
    if (!imp) throw new HttpError(404, 'Import not found or already committed.');
    let created = 0, updated = 0;
    for (const r of j(imp.rows_json)) {
      const x = upsertWorker(t, r, 'spreadsheet', user);
      if (x.created) created++;
      else if (x.changed) updated++;
    }
    db.update('imports', imp.id, { status: 'committed' });
    P.audit(t, 'ROSTER_IMPORT', imp.filename, `Imported roster: ${created} added, ${updated} updated.`, user);
    return { created, updated };
  });
}
module.exports = { upsertWorker, changeAssignment, placesFrom, createConnector, syncConnector, testConnection, processHrmsEvent, previewImport, commitImport, ensureEntity, ensureFacility, configOf, saveConfig, validateConfig, publicConfig, mapHrms };
