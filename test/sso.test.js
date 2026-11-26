'use strict';
// "Continue with Microsoft" and "Continue with Google" on the sign-in and sign-up screens.
// Microsoft and Google are faked, so no real account is involved.
const test = require('node:test'), assert = require('node:assert'), fs = require('fs'), os = require('os'), path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-'));
process.env.NODE_ENV = 'test';
process.env.AEGIS_DATA = dir; process.env.AEGIS_DEMO = '1';
for (const k of ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'SLACK_SIGNING_SECRET', 'RESEND_API_KEY', 'SMTP_HOST', 'AEGIS_SIGNUP']) process.env[k] = '';
Object.assign(process.env, {
  AEGIS_MICROSOFT_CLIENT_ID: 'ms-app-id', AEGIS_MICROSOFT_CLIENT_SECRET: 'ms-app-secret',
  AEGIS_GOOGLE_CLIENT_ID: 'google-app-id', AEGIS_GOOGLE_CLIENT_SECRET: 'google-app-secret',
});

// Who Microsoft or Google says signed in, set by each test.
const fake = { me: null, google: null };
const calls = [];
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
const idToken = (claims) => ['x', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'y'].join('.');
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.startsWith('https://login.microsoftonline.com/')) { calls.push({ url: u, form: Object.fromEntries(new URLSearchParams(opts.body)) }); return json({ access_token: 'ms-access', id_token: 'x.e30.y', expires_in: 3600 }); }
  if (u.startsWith('https://graph.microsoft.com/v1.0/me')) return json(fake.me);
  if (u === 'https://oauth2.googleapis.com/token') { calls.push({ url: u, form: Object.fromEntries(new URLSearchParams(opts.body)) }); return json({ access_token: 'g-access', id_token: idToken(fake.google), expires_in: 3600 }); }
  return realFetch(url, opts);
};

const { start, server } = require('../server/index.js');
const db = require('../server/lib/db');
let base;
test.before(async () => {
  await start(0, { loop: false });
  base = `http://127.0.0.1:${server.address().port}`; process.env.AEGIS_BASE_URL = base;
});
test.after(() => { server.close(); globalThis.fetch = realFetch; try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch {} setTimeout(() => process.exit(0), 50); });

const get = (p, cookie) => realFetch(base + p, { redirect: 'manual', headers: cookie ? { cookie } : {} });
// Starts a sign-in the way the button does, then comes back from the provider with the given answer.
async function signIn(provider, answer = { code: 'auth-code' }) {
  const startRes = await get(`/api/auth/${provider}`);
  assert.equal(startRes.status, 302);
  const state = new URL(startRes.headers.get('location')).searchParams.get('state');
  const back = await get(`/api/oauth/callback?${new URLSearchParams({ ...answer, state })}`);
  assert.equal(back.status, 302);
  return { location: back.headers.get('location'), cookie: back.headers.get('set-cookie')?.split(';')[0] || null, state };
}
const me = async (cookie) => (await (await get('/api/me', cookie)).json());

test('the sign-in page lists the providers, and the buttons start a one-time sign-in with PKCE', async () => {
  const info = await (await get('/api/public/info')).json();
  assert.deepEqual(info.sso, { microsoft: true, google: true });

  const ms = new URL((await get('/api/auth/microsoft')).headers.get('location'));
  assert.equal(ms.origin + ms.pathname, 'https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize', 'work and school accounts only');
  assert.equal(ms.searchParams.get('scope'), 'openid profile email User.Read', 'sign-in asks only who you are, not for mail');
  assert.equal(ms.searchParams.get('redirect_uri'), `${base}/api/oauth/callback`);
  assert.equal(ms.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(ms.searchParams.get('prompt'), 'select_account');

  const g = new URL((await get('/api/auth/google')).headers.get('location'));
  assert.equal(g.origin + g.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(g.searchParams.get('scope'), 'openid email profile');

  assert.equal((await get('/api/auth/yahoo')).headers.get('location'), '/#sso-error/failed');
  const saved = process.env.AEGIS_GOOGLE_CLIENT_ID;
  delete process.env.AEGIS_GOOGLE_CLIENT_ID;
  try {
    assert.equal((await get('/api/auth/google')).headers.get('location'), '/#sso-error/unavailable');
    assert.deepEqual((await (await get('/api/public/info')).json()).sso, { microsoft: true, google: false });
  } finally { process.env.AEGIS_GOOGLE_CLIENT_ID = saved; }
});

test('Microsoft signs in an existing person by the work account Microsoft confirms', async () => {
  fake.me = { displayName: 'Nora Lane', userPrincipalName: 'Admin@Northstar.demo', mail: null };
  const r = await signIn('microsoft');
  assert.equal(r.location, '/#overview');
  assert.ok(r.cookie);
  assert.equal((await me(r.cookie)).user.email, 'admin@northstar.demo');
  assert.equal(calls.at(-1).form.code_verifier.length > 20, true);
  assert.match(calls.at(-1).url, /\/organizations\/oauth2\/v2\.0\/token$/);

  // A second address on the same proven domain also matches.
  fake.me = { displayName: 'Nora Lane', userPrincipalName: 'nora.lane@northstar.demo', mail: 'admin@northstar.demo' };
  assert.equal((await me((await signIn('microsoft')).cookie)).user.email, 'admin@northstar.demo');
});

test('Microsoft cannot be used to claim an address on a domain the company has not proved', async () => {
  fake.me = { displayName: 'Mallory', userPrincipalName: 'mallory@attacker.test', mail: 'admin@northstar.demo' };
  const r = await signIn('microsoft');
  assert.equal(r.location, '/#sso-error/no-account');
  assert.equal(r.cookie, null);

  fake.me = { displayName: 'Guest', userPrincipalName: 'admin_northstar.demo#EXT#@other.onmicrosoft.com', mail: 'admin@northstar.demo' };
  assert.equal((await signIn('microsoft')).location, '/#sso-error/failed', 'guest accounts are refused');
});

test('Google signs in only with an email Google has verified', async () => {
  fake.google = { email: 'health@northstar.demo', email_verified: true, name: 'Lena Cole' };
  const ok = await signIn('google');
  assert.equal(ok.location, '/#overview');
  assert.equal((await me(ok.cookie)).user.email, 'health@northstar.demo');

  fake.google = { email: 'admin@northstar.demo', email_verified: false, name: 'Nora' };
  const bad = await signIn('google');
  assert.equal(bad.location, '/#sso-error/failed');
  assert.equal(bad.cookie, null);
});

test('cancelled, unapproved, expired and deactivated sign-ins each explain themselves', async () => {
  assert.equal((await signIn('microsoft', { error: 'access_denied', error_description: 'The user cancelled.' })).location, '/#sso-error/cancelled');
  assert.equal((await signIn('microsoft', { error: 'access_denied', error_description: 'AADSTS65001: consent required' })).location, '/#sso-error/consent');

  fake.me = { displayName: 'Nora Lane', userPrincipalName: 'admin@northstar.demo' };
  const used = await signIn('microsoft');
  const again = await get(`/api/oauth/callback?${new URLSearchParams({ code: 'auth-code', state: used.state })}`);
  assert.equal(again.headers.get('location'), '/#sso-error/expired', 'a sign-in link works once');

  db.run("UPDATE users SET disabled_at=? WHERE email='finance@northstar.demo'", new Date().toISOString());
  fake.google = { email: 'finance@northstar.demo', email_verified: true, name: 'Tara Bell' };
  const off = await signIn('google');
  assert.equal(off.location, '/#sso-error/disabled');
  assert.equal(off.cookie, null);
});

test('without sign-up, a new person is told to ask their administrator', async () => {
  fake.google = { email: 'new.person@elsewhere.test', email_verified: true, name: 'New Person' };
  assert.equal((await signIn('google')).location, '/#sso-error/no-account');
});

test('with sign-up on, a new person creates a workspace with their confirmed details and no email check', async () => {
  process.env.AEGIS_SIGNUP = '1';
  try {
    fake.me = { displayName: 'Jordan Lee', userPrincipalName: 'jordan@riverbend.test', mail: 'jordan@riverbend.test' };
    const r = await signIn('microsoft');
    const handle = r.location.match(/^\/#signup\/sso\/([\w-]+)$/)?.[1];
    assert.ok(handle, 'goes to the sign-up form');
    assert.equal(r.cookie, null, 'not signed in until the workspace exists');

    const details = await (await get(`/api/signup/sso/${handle}`)).json();
    assert.deepEqual(details, { email: 'jordan@riverbend.test', name: 'Jordan Lee', provider: 'microsoft', provider_name: 'Microsoft' });

    const post = (body) => realFetch(`${base}/api/signup`, { method: 'POST', headers: { 'x-aegis-client': 'web' }, body: JSON.stringify(body) });
    // The email cannot be swapped for another one.
    const made = await post({ sso: handle, org_name: 'Riverbend Staffing', admin_name: 'Jordan Lee', email: 'someone.else@other.test' });
    assert.equal(made.status, 200);
    assert.deepEqual(await made.json(), { ok: true, email_sent: false, email_confirmed_by: 'microsoft' });
    const cookie = made.headers.get('set-cookie').split(';')[0];
    const who = await me(cookie);
    assert.equal(who.user.email, 'jordan@riverbend.test');
    assert.equal(who.user.role, 'admin');
    assert.equal(who.tenant.name, 'Riverbend Staffing');
    assert.equal(who.workspace_email, null, 'Microsoft already confirmed the email');
    assert.ok(db.get("SELECT 1 AS x FROM audit_log WHERE type='EMAIL_VERIFIED' AND action LIKE 'Signed up with Microsoft%'"));

    assert.equal((await post({ sso: handle, org_name: 'Again', admin_name: 'Jordan Lee' })).status, 410, 'a sign-up handle works once');
    assert.equal((await get(`/api/signup/sso/${handle}`)).status, 410);

    // Next time, the same Microsoft account simply signs in.
    assert.equal((await signIn('microsoft')).location, '/#overview');
  } finally { process.env.AEGIS_SIGNUP = ''; }
});

test('signing in with Google confirms an email that was still waiting for its link', async () => {
  process.env.AEGIS_SIGNUP = '1';
  try {
    const r = await realFetch(`${base}/api/signup`, { method: 'POST', headers: { 'x-aegis-client': 'web' }, body: JSON.stringify({ org_name: 'Pending Care', admin_name: 'Pat Doe', email: 'pat@pendingcare.test', password: 'a long test-only password' }) });
    const cookie = r.headers.get('set-cookie').split(';')[0];
    assert.equal((await me(cookie)).workspace_email.pending, true);
    fake.google = { email: 'pat@pendingcare.test', email_verified: true, name: 'Pat Doe' };
    const g = await signIn('google');
    assert.equal(g.location, '/#overview');
    assert.equal((await me(g.cookie)).workspace_email.pending, false);
  } finally { process.env.AEGIS_SIGNUP = ''; }
});
