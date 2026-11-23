'use strict';
// Production readiness: HRMS connector settings, webhooks, storage, health and startup checks.
const test = require('node:test'), assert = require('node:assert'), fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto'), http = require('http');
const { spawnSync } = require('child_process');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-'));
process.env.NODE_ENV = 'test';
process.env.AEGIS_DATA = dir; process.env.AEGIS_DEMO = '1';
const { start, server } = require('../server/index.js');
const db = require('../server/lib/db'), P = require('../server/platform');

// A stand-in for a real HRMS that looks nothing like the mock: API key header, page numbers,
// the list nested under data.people, and different field names.
const KEY = 'real-hrms-key';
const PEOPLE = [
  { emp_no: 'E1', person: { display_name: 'Asha Rao', email: 'asha@northstar.test' }, title: 'Staff Nurse', license_type: 'RN', site: { name: 'Northstar General', state: 'TX' }, state: 'active', hire_date: '2026-01-10' },
  { emp_no: 'E2', person: { display_name: 'Ben Ortiz', email: 'ben@northstar.test' }, title: 'Payroll Clerk', site: { name: 'Northstar HQ', state: 'TX' }, state: 'active', hire_date: '2025-06-01' },
  { emp_no: 'E3', person: { display_name: 'Cara Lim', email: 'cara@northstar.test' }, title: 'Physical Therapist', license_type: 'PT', site: { name: 'Northstar General', state: 'TX' }, state: 'Inactive', hire_date: '2024-03-15' },
  { emp_no: 'E4', person: { email: 'nobody@northstar.test' }, title: 'Unknown', state: 'active' },
  { emp_no: 'E5', person: { display_name: 'Dev Shah', email: 'dev@northstar.test' }, title: 'Analyst', site: { name: 'Northstar HQ', state: 'TX' }, state: 'active', hire_date: '2026-02-01' },
];
let hrmsCalls = [];
const hrms = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  hrmsCalls.push(u.pathname + u.search);
  if (req.headers['x-api-key'] !== KEY) { res.writeHead(401).end('{}'); return; }
  if (u.pathname !== '/api/people') { res.writeHead(404).end('{}'); return; }
  const page = +u.searchParams.get('page'), size = +u.searchParams.get('per_page');
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ data: { people: PEOPLE.slice((page - 1) * size, page * size) } }));
});

let base, hrmsBase, admin;
async function login(email) {
  const r = await fetch(`${base}/api/login`, { method: 'POST', body: JSON.stringify({ email, password: 'demo1234' }) });
  assert.equal(r.status, 200);
  const cookie = r.headers.get('set-cookie').split(';')[0];
  const call = async (m, p, b) => { const x = await fetch(base + p, { method: m, headers: { cookie, 'x-aegis-client': 'web' }, body: b ? JSON.stringify(b) : undefined }); const t = await x.text(); let d; try { d = JSON.parse(t); } catch { d = t; } return { status: x.status, data: d, text: t }; };
  return { get: (p) => call('GET', p), post: (p, b = {}) => call('POST', p, b) };
}
const settings = () => ({
  name: 'Northstar HRMS', base_url: `${hrmsBase}/api`, path: '/people', auth_type: 'header', auth_header: 'X-API-Key', api_key: KEY,
  pagination: 'page', page_size: 2, list_field: 'data.people', incremental: 'none', terminated_values: ['inactive'],
  field_map: { external_id: 'emp_no', name: 'person.display_name', email: 'person.email', role: 'title', facility: 'site.name', facility_state: 'site.state', status: 'state' },
});
const ns = () => db.get("SELECT * FROM tenants WHERE slug='northstar'");

test.before(async () => {
  await new Promise((ok) => hrms.listen(0, '127.0.0.1', ok));
  hrmsBase = `http://127.0.0.1:${hrms.address().port}`;
  await start(0, { loop: false });
  base = `http://127.0.0.1:${server.address().port}`; process.env.AEGIS_BASE_URL = base;
  admin = await login('admin@northstar.demo');
});
test.after(() => { server.close(); hrms.close(); try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch {} setTimeout(() => process.exit(0), 50); });

test('HRMS test connection shows the mapping before anything is saved', async () => {
  const r = await admin.post('/api/connectors/test', settings());
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, true);
  assert.equal(r.data.records_on_first_page, 2);
  assert.ok(r.data.source_fields.includes('person.display_name'));
  assert.deepEqual(r.data.sample[0], { external_id: 'E1', name: 'Asha Rao', email: 'asha@northstar.test', role: 'Staff Nurse', category: 'clinical', facility: 'Northstar General', status: 'active', hire_date: '2026-01-10', problem: null });
  assert.equal(db.get('SELECT COUNT(*) AS n FROM connectors WHERE tenant_id=?', ns().id).n, 0, 'a test saves nothing');

  const bad = await admin.post('/api/connectors/test', { ...settings(), api_key: 'wrong' });
  assert.equal(bad.data.ok, false);
  assert.match(bad.data.error, /refused the credentials \(401\)/);
  const noPath = await admin.post('/api/connectors/test', { ...settings(), path: '/nope' });
  assert.match(noPath.data.error, /404/);
});

test('HRMS settings are validated and unsafe addresses are refused', async () => {
  assert.equal((await admin.post('/api/connectors/test', { ...settings(), base_url: 'http://169.254.169.254/latest' })).status, 400);
  assert.equal((await admin.post('/api/connectors/test', { ...settings(), base_url: 'ftp://x' })).status, 400);
  const fm = await admin.post('/api/connectors/test', { ...settings(), field_map: { shoe_size: 'x' } });
  assert.equal(fm.status, 400); assert.match(fm.data.error, /unknown field "shoe_size"/);
  assert.equal((await admin.post('/api/connectors/test', { ...settings(), api_key: '' })).status, 400);
  assert.equal((await admin.post('/api/connectors/test', { ...settings(), auth_header: 'bad header' })).status, 400);
  const hr = await login('hr@northstar.demo');
  assert.equal((await hr.post('/api/connectors/test', settings())).status, 403, 'only administrators manage connectors');
});

let conId;
test('HRMS sync reads every page, maps fields, skips unsafe records, and keeps the key secret', async () => {
  const c = await admin.post('/api/connectors', settings());
  assert.equal(c.status, 200); conId = c.data.id;
  const list = await admin.get('/api/connectors');
  assert.ok(!list.text.includes(KEY), 'the API key is never returned');
  assert.equal(list.data[0].settings.has_api_key, true);
  assert.match(list.data[0].webhook_url, /\/api\/webhooks\/hrms\/northstar$/);

  hrmsCalls = [];
  const s = await admin.post(`/api/connectors/${conId}/sync`);
  assert.equal(s.status, 200);
  assert.equal(s.data.pages, 3, '5 records at 2 per page');
  assert.equal(s.data.records, 4);
  assert.equal(s.data.skipped, 1);
  assert.equal(s.data.skipped_examples[0].problem, 'no name');
  assert.deepEqual(hrmsCalls, ['/api/people?page=1&per_page=2', '/api/people?page=2&per_page=2', '/api/people?page=3&per_page=2']);
  const t = ns().id;
  const cara = db.get("SELECT * FROM workers WHERE tenant_id=? AND external_id='E3'", t);
  assert.equal(cara.status, 'terminated', 'terminated_values maps Inactive to terminated');
  assert.equal(cara.category, 'clinical');
  assert.ok(db.get("SELECT 1 AS x FROM facilities WHERE tenant_id=? AND name='Northstar General' AND state='TX'", t));
  assert.ok(!db.get("SELECT 1 AS x FROM workers WHERE tenant_id=? AND email='nobody@northstar.test'", t), 'a record without a name is not guessed');
  assert.match(db.get('SELECT last_error FROM connectors WHERE id=?', conId).last_error, /1 record\(s\) skipped/);

  // A second sync changes nothing and creates no duplicates.
  const again = await admin.post(`/api/connectors/${conId}/sync`);
  assert.equal(again.data.created, 0);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM workers WHERE tenant_id=?', t).n, 4);
  await P.drain();
});

test('changing connector settings keeps the old key unless a new one is given, and a turned-off connector does not sync', async () => {
  const u = await admin.post(`/api/connectors/${conId}`, { page_size: 3 });
  assert.equal(u.status, 200);
  assert.equal(u.data.settings.page_size, 3);
  assert.equal((await admin.post(`/api/connectors/${conId}/test`)).data.ok, true, 'the saved key still works');
  assert.ok(db.get("SELECT 1 AS x FROM audit_log WHERE type='CONNECTOR_UPDATED' AND action LIKE '%page_size%'"));
  await admin.post(`/api/connectors/${conId}`, { api_key: 'rotated' });
  assert.ok(db.get("SELECT 1 AS x FROM audit_log WHERE type='CONNECTOR_UPDATED' AND action LIKE '%api_key (hidden)%'"));
  assert.ok(!db.all('SELECT action FROM audit_log').some((a) => a.action.includes('rotated')), 'keys never reach the audit log');
  await admin.post(`/api/connectors/${conId}`, { api_key: KEY });
  await admin.post(`/api/connectors/${conId}/disable`);
  assert.equal((await admin.post(`/api/connectors/${conId}/sync`)).status, 409);
  await admin.post(`/api/connectors/${conId}/enable`);
  assert.equal((await admin.post(`/api/connectors/${conId}/sync`)).status, 200);
  await P.drain();
});

test('webhooks: rotated secret, events without an id, and thin events that start a sync', async () => {
  const rot = await admin.post('/api/connectors/webhook-secret');
  assert.equal(rot.status, 200); assert.equal(rot.data.secret.length, 64);
  const send = (obj, secret = rot.data.secret) => { const body = JSON.stringify(obj); return fetch(`${base}/api/webhooks/hrms/northstar`, { method: 'POST', headers: { 'x-aegis-signature': 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex') }, body }).then(async (r) => ({ status: r.status, data: await r.json() })); };

  // Events without an id are told apart by their content, so they are not dropped as duplicates.
  const a = await send({ type: 'worker.updated', worker: { emp_no: 'E1', person: { display_name: 'Asha Rao', email: 'asha@northstar.test' }, title: 'Charge Nurse', state: 'active' } });
  const b = await send({ type: 'worker.updated', worker: { emp_no: 'E2', person: { display_name: 'Ben Ortiz', email: 'ben@northstar.test' }, title: 'Payroll Lead', state: 'active' } });
  assert.deepEqual([a.data, b.data], [{ accepted: true }, { accepted: true }]);
  // The configured field_map is used for webhooks too.
  await P.drain();
  assert.equal(db.get("SELECT role FROM workers WHERE tenant_id=? AND external_id='E1'", ns().id).role, 'Charge Nurse');

  // A thin event (only an id) starts a sync rather than creating a half-empty worker.
  hrmsCalls = [];
  const thin = await send({ id: 'evt_thin_1', type: 'worker.updated', worker_id: 'E5' });
  assert.deepEqual(thin.data, { accepted: true });
  await P.drain();
  assert.ok(hrmsCalls.length > 0, 'a sync ran');
  assert.match(db.get("SELECT error FROM events WHERE external_id='evt_thin_1'").error, /a sync was started instead/);

  // The old secret stops working after rotation.
  const seedSecret = 'not-the-secret';
  assert.equal((await send({ id: 'x', type: 'worker.updated' }, seedSecret)).status, 401);
});

test('documents: local storage round trip, encrypted at rest', async () => {
  const storage = require('../server/lib/storage');
  const p = await storage.put('ten_x', 'ev_x', Buffer.from('hello license'));
  assert.ok(!fs.readFileSync(p).includes('hello license'), 'the file on disk is encrypted');
  assert.equal((await storage.get(p)).toString(), 'hello license');
});

test('health check needs no sign-in and reveals nothing about tenants', async () => {
  const r = await fetch(`${base}/healthz`);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.deepEqual(Object.keys(body).sort(), ['database', 'ok', 'shutting_down']);
  assert.equal(body.ok, true);
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
});

test('scheduled and manual digests record where delivery actually occurred', async (ctx) => {
  const tenant = ns();
  const slack = require('../server/slack');
  ctx.after(() => db.update('tenants', tenant.id, { channel_json: tenant.channel_json }));
  ctx.mock.method(slack, 'configured', () => true);
  const post = ctx.mock.method(slack, 'postMessage', async () => 'mock-slack-receipt');
  const latestEvent = () => db.get("SELECT type FROM audit_log WHERE tenant_id=? AND subject='Digest' ORDER BY seq DESC LIMIT 1", tenant.id).type;
  for (const via of ['outbox', 'slack']) {
    db.update('tenants', tenant.id, { channel_json: JSON.stringify({ type: via, channel: '#pilot' }) });
    const expected = via === 'slack' ? 'DIGEST_SENT' : 'DIGEST_OUTBOX';
    const manual = await admin.post('/api/digest/send');
    assert.equal(manual.status, 200);
    assert.equal(manual.data.via, via);
    assert.equal(latestEvent(), expected);
    const previousSeq = db.get('SELECT MAX(seq) AS seq FROM audit_log').seq;
    P.enqueue(tenant.id, 'digest');
    await P.drain();
    assert.equal(db.get("SELECT type FROM audit_log WHERE tenant_id=? AND subject='Digest' AND seq>?", tenant.id, previousSeq)?.type, expected);
    assert.equal(post.mock.callCount(), via === 'slack' ? 2 : 0);
  }
  post.mock.mockImplementation(async () => { throw new Error('Simulated Slack rejection'); });
  assert.equal((await admin.post('/api/digest/send')).status, 502);
  assert.equal(latestEvent(), 'DIGEST_FAILED');
});

test('production refuses to start with unsafe settings', () => {
  const { productionProblems } = require('../server/lib/config');
  const good = { AEGIS_DEMO: '0', AEGIS_SECRET: 'x'.repeat(64), AEGIS_BASE_URL: 'https://aegis.example.com' };
  assert.deepEqual(productionProblems(good), []);
  assert.equal(productionProblems({ ...good, AEGIS_DEMO: '1' }).length, 1);
  assert.equal(productionProblems({ ...good, AEGIS_SECRET: 'change-me' }).length, 1);
  assert.equal(productionProblems({ ...good, AEGIS_BASE_URL: 'http://aegis.example.com' }).length, 1);

  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], { env: { ...process.env, NODE_ENV: 'production', AEGIS_DEMO: '1', AEGIS_SECRET: 'short', AEGIS_BASE_URL: 'http://x', AEGIS_DATA: path.join(dir, 'prod') }, encoding: 'utf8', timeout: 20000 });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /will not start in production/);
  assert.match(r.stderr, /AEGIS_DEMO=1/);
  assert.match(r.stderr, /AEGIS_SECRET is too short/);
  assert.match(r.stderr, /https:\/\//);
});
