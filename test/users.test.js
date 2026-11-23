'use strict';
// User management: adding people, changing roles, resetting and changing passwords, and
// deactivating people who have left. Nobody can lock their own company out.
const test = require('node:test'), assert = require('node:assert'), fs = require('fs'), os = require('os'), path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-'));
process.env.NODE_ENV = 'test';
process.env.AEGIS_DATA = dir; process.env.AEGIS_DEMO = '1';
const { start, server } = require('../server/index.js');
const db = require('../server/lib/db');
let base;
const send = async (cookie, m, p, b) => {
  const r = await fetch(base + p, { method: m, headers: { ...(cookie ? { cookie } : {}), 'x-aegis-client': 'web' }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, data: await r.json().catch(() => ({})) };
};
async function login(email, password = 'demo1234') {
  const r = await fetch(`${base}/api/login`, { method: 'POST', body: JSON.stringify({ email, password }) });
  return r.status === 200 ? client(r.headers.get('set-cookie').split(';')[0]) : { status: r.status, data: await r.json() };
}
const client = (cookie) => ({ cookie, get: (p) => send(cookie, 'GET', p), post: (p, b = {}) => send(cookie, 'POST', p, b) });
const NEW_PW = 'correct horse battery';

test.before(async () => { await start(0, { loop: false }); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => { server.close(); try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch {} setTimeout(() => process.exit(0), 50); });

test('adding a user needs a valid email and a 12-character password', async () => {
  const admin = await login('sathinath@bluebix.demo');
  assert.equal((await admin.post('/api/users', { name: 'Short', email: 'short@bluebix.demo', role: 'hr', password: 'eightchr' })).status, 400);
  assert.equal((await admin.post('/api/users', { name: 'Bad', email: 'not-an-email', role: 'hr', password: NEW_PW })).status, 400);
  assert.equal((await admin.post('/api/users', { name: 'Ana', email: 'Ana@Bluebix.demo', role: 'hr', password: NEW_PW })).status, 200);
  assert.equal((await admin.post('/api/users', { name: 'Ana again', email: 'ana@bluebix.demo', role: 'hr', password: NEW_PW })).status, 409, 'emails are matched without case');
  assert.equal((await login('ana@bluebix.demo', NEW_PW)).cookie !== undefined, true);
  const hr = await login('hr@bluebix.demo');
  assert.equal((await hr.post('/api/users', { name: 'X', email: 'x@bluebix.demo', role: 'admin', password: NEW_PW })).status, 403, 'only administrators add users');
});

test('roles change at once; nobody changes their own role', async () => {
  const admin = await login('sathinath@bluebix.demo');
  const users = (await admin.get('/api/users')).data;
  const ana = users.find((u) => u.email === 'ana@bluebix.demo'), me = users.find((u) => u.is_you);
  const anaSession = await login('ana@bluebix.demo', NEW_PW);
  assert.equal((await anaSession.get('/api/notices')).status, 403, 'HR cannot open tax notices');
  assert.equal((await admin.post(`/api/users/${ana.id}/role`, { role: 'finance' })).status, 200);
  assert.equal((await anaSession.get('/api/notices')).status, 200, 'the new role applies to the open session straight away');
  assert.equal((await admin.post(`/api/users/${me.id}/role`, { role: 'hr' })).status, 409);
  assert.equal((await admin.post(`/api/users/${ana.id}/role`, { role: 'superuser' })).status, 400);
});

test('deactivating signs the person out everywhere and blocks sign-in until reactivated', async () => {
  const admin = await login('sathinath@bluebix.demo');
  const users = (await admin.get('/api/users')).data;
  const hannah = users.find((u) => u.email === 'hr@bluebix.demo'), me = users.find((u) => u.is_you);
  const hrSession = await login('hr@bluebix.demo');
  assert.equal((await hrSession.get('/api/me')).status, 200);
  const off = await admin.post(`/api/users/${hannah.id}/deactivate`);
  assert.equal(off.status, 200);
  assert.equal(off.data.open_cases, hannah.open_cases, 'reports the open cases still naming this owner');
  assert.equal((await hrSession.get('/api/me')).status, 401, 'the open session ends at once');
  const again = await login('hr@bluebix.demo');
  assert.equal(again.status, 403);
  assert.match(again.data.error, /deactivated/);
  assert.equal((await login('hr@bluebix.demo', 'wrong password')).status, 401, 'a wrong password says nothing about the account');
  assert.ok(!(await admin.get('/api/owners')).data.some((u) => u.id === hannah.id), 'not offered as an owner');
  assert.ok((await admin.get('/api/users')).data.find((u) => u.id === hannah.id).disabled_at);
  assert.equal((await admin.post(`/api/users/${me.id}/deactivate`)).status, 409, 'nobody deactivates themselves');
  assert.equal((await admin.post(`/api/users/${hannah.id}/reactivate`)).status, 200);
  assert.equal((await login('hr@bluebix.demo')).cookie !== undefined, true, 'reactivated people can sign in again');
  const audit = db.all("SELECT type FROM audit_log WHERE type IN ('USER_DEACTIVATED','USER_REACTIVATED','USER_ROLE_CHANGED')").map((r) => r.type);
  assert.deepEqual([...new Set(audit)].sort(), ['USER_DEACTIVATED', 'USER_REACTIVATED', 'USER_ROLE_CHANGED']);
});

test('an administrator resets a password: the person is signed out and uses the new one', async () => {
  const admin = await login('sathinath@bluebix.demo');
  const grace = (await admin.get('/api/users')).data.find((u) => u.email === 'health@bluebix.demo');
  const graceSession = await login('health@bluebix.demo');
  assert.equal((await admin.post(`/api/users/${grace.id}/password`, { password: 'short' })).status, 400);
  assert.equal((await admin.post(`/api/users/${grace.id}/password`, { password: NEW_PW })).status, 200);
  assert.equal((await graceSession.get('/api/me')).status, 401);
  assert.equal((await login('health@bluebix.demo')).status, 401, 'the old password stops working');
  assert.ok((await login('health@bluebix.demo', NEW_PW)).cookie);
  assert.ok(!db.all("SELECT detail_json, action FROM audit_log WHERE type='USER_PASSWORD_RESET'").some((r) => (r.detail_json + r.action).includes(NEW_PW)), 'the password is never written to the audit log');
});

test('anyone changes their own password; other devices are signed out, this one stays', async () => {
  const laptop = await login('viewer@bluebix.demo'), phone = await login('viewer@bluebix.demo');
  assert.equal((await laptop.post('/api/me/password', { current: 'not it', password: NEW_PW })).status, 400);
  assert.equal((await laptop.post('/api/me/password', { current: 'demo1234', password: 'tooshort' })).status, 400);
  assert.equal((await laptop.post('/api/me/password', { current: 'demo1234', password: NEW_PW })).status, 200, 'read-only users can change their own password');
  assert.equal((await laptop.get('/api/me')).status, 200, 'this session stays signed in');
  assert.equal((await phone.get('/api/me')).status, 401, 'other sessions end');
  assert.ok((await login('viewer@bluebix.demo', NEW_PW)).cookie);
});
