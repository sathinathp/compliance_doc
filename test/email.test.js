'use strict';
// Email on the Connections page: each company connects its own mailbox (Microsoft 365, Google
// Workspace or SMTP). Microsoft, Google and the SMTP server are all faked, so no real email is sent.
const test = require('node:test'), assert = require('node:assert'), fs = require('fs'), os = require('os'), path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-'));
process.env.NODE_ENV = 'test';
process.env.AEGIS_DATA = dir; process.env.AEGIS_DEMO = '1';
for (const k of ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'SLACK_SIGNING_SECRET', 'RESEND_API_KEY', 'SMTP_HOST']) process.env[k] = '';
Object.assign(process.env, {
  AEGIS_MICROSOFT_CLIENT_ID: 'ms-app-id', AEGIS_MICROSOFT_CLIENT_SECRET: 'ms-app-secret',
  AEGIS_GOOGLE_CLIENT_ID: 'google-app-id', AEGIS_GOOGLE_CLIENT_SECRET: 'google-app-secret',
});

// ---- fake Microsoft and Google
const calls = [];
const fake = { tokenExpires: 3600, refreshFails: false, sendAsDenied: false };
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const ms = u.startsWith('https://login.microsoftonline.com/') || u.startsWith('https://graph.microsoft.com/');
  const google = u.startsWith('https://oauth2.googleapis.com/') || u.startsWith('https://gmail.googleapis.com/');
  if (!ms && !google) return realFetch(url, opts);
  const form = opts.headers?.['content-type'] === 'application/x-www-form-urlencoded' ? Object.fromEntries(new URLSearchParams(opts.body)) : null;
  const body = !form && opts.body ? JSON.parse(opts.body) : null;
  calls.push({ url: u, form, body, auth: opts.headers?.authorization });
  if (u.endsWith('/oauth2/v2.0/token')) {
    if (form.grant_type === 'refresh_token' && fake.refreshFails) return json({ error: 'invalid_grant', error_description: 'AADSTS700082: The refresh token has expired.' }, 400);
    if (form.client_secret !== 'ms-app-secret') return json({ error: 'invalid_client' }, 401);
    const n = calls.filter((c) => c.url.endsWith('/oauth2/v2.0/token')).length;
    return json({ access_token: `ms-access-${n}`, refresh_token: `ms-refresh-${n}`, expires_in: fake.tokenExpires });
  }
  if (u.startsWith('https://graph.microsoft.com/v1.0/me?')) return json({ mail: 'Nora.Lane@northstar.test', userPrincipalName: 'nora.lane@northstar.test', displayName: 'Nora Lane' });
  if (u.endsWith('/sendMail')) return fake.sendAsDenied ? json({ error: { code: 'ErrorSendAsDenied', message: 'The user account which was used to submit this request does not have the right to send mail on behalf of the specified sending account.' } }, 403) : new Response(null, { status: 202 });
  if (u === 'https://oauth2.googleapis.com/token') {
    const idToken = ['x', Buffer.from(JSON.stringify({ email: 'Payroll@northstar-mail.test' })).toString('base64url'), 'y'].join('.');
    return json({ access_token: 'g-access', refresh_token: 'g-refresh', expires_in: 3600, id_token: idToken });
  }
  if (u.endsWith('/gmail/v1/users/me/messages/send')) return json({ id: 'gmail-123' });
  return json({ error: 'unknown' }, 404);
};
// Aegis's own account emails go through Resend; faked too.
const resendSent = [];
const fetchWithResend = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  if (String(url) === 'https://api.resend.com/emails') { resendSent.push(JSON.parse(opts.body)); return json({ id: `re_${resendSent.length}` }); }
  return fetchWithResend(url, opts);
};

const { start, server } = require('../server/index.js');
const db = require('../server/lib/db'), Email = require('../server/email'), channels = require('../server/channels');

// ---- fake SMTP server
const smtpSent = [];
let smtpVerify = async () => true;
Email.hooks.smtpTransport = (cfg) => ({
  verify: () => smtpVerify(cfg),
  sendMail: async (m) => { smtpSent.push({ cfg, ...m }); return { messageId: `<m${smtpSent.length}@test>` }; },
});

let base, admin, staff;
async function login(email) {
  const r = await realFetch(`${base}/api/login`, { method: 'POST', body: JSON.stringify({ email, password: 'demo1234' }) });
  assert.equal(r.status, 200);
  const cookie = r.headers.get('set-cookie').split(';')[0];
  const call = async (m, p, b) => { const x = await realFetch(base + p, { method: m, redirect: 'manual', headers: { cookie, 'x-aegis-client': 'web' }, body: b ? JSON.stringify(b) : undefined }); const t = await x.text(); let d; try { d = JSON.parse(t); } catch { d = t; } return { status: x.status, data: d, text: t, location: x.headers.get('location') }; };
  return { get: (p) => call('GET', p), post: (p, b = {}) => call('POST', p, b) };
}
const ns = () => db.get("SELECT * FROM tenants WHERE slug='northstar'");
const audits = (type) => db.all('SELECT * FROM audit_log WHERE tenant_id=? AND type=? ORDER BY seq', ns().id, type);
const callback = (qs) => realFetch(`${base}/api/oauth/callback?${new URLSearchParams(qs)}`, { redirect: 'manual' });
const stateOf = (url) => new URL(url).searchParams.get('state');
const lastCall = (end) => calls.filter((c) => c.url.endsWith(end)).at(-1);

test.before(async () => {
  await start(0, { loop: false });
  base = `http://127.0.0.1:${server.address().port}`; process.env.AEGIS_BASE_URL = base;
  admin = await login('admin@northstar.demo');
  staff = await login('health@northstar.demo');
});
test.after(() => { server.close(); globalThis.fetch = realFetch; try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch {} setTimeout(() => process.exit(0), 50); });

test('email starts disconnected, lists the available providers, and is for administrators only', async () => {
  const r = await admin.get('/api/integrations');
  assert.equal(r.status, 200);
  assert.equal(r.data.email.connected, false);
  assert.equal(r.data.email.configured, false);
  assert.deepEqual(r.data.email.available, { microsoft: true, google: true, smtp: true });
  assert.equal(r.data.email.default_sender, `${ns().name} Compliance`);
  assert.equal(r.data.email.redirect_uri, `${base}/api/oauth/callback`);
  assert.equal((await staff.get('/api/integrations')).status, 403);
  assert.equal((await staff.post('/api/integrations/email/smtp', { host: 'smtp.x.com' })).status, 403);
  assert.equal((await staff.post('/api/integrations/email/sign-in', { provider: 'microsoft' })).status, 403);
});

test('SMTP is tested before saving, the password is never shown, and worker requests go through it', async () => {
  smtpVerify = async () => { const e = new Error('Invalid login: 535 5.7.8 Authentication failed'); e.code = 'EAUTH'; throw e; };
  const bad = await admin.post('/api/integrations/email/smtp', { address: 'compliance@northstar.test', host: 'smtp.northstar.test', port: 587, username: 'compliance@northstar.test', password: 'wrong' });
  assert.equal(bad.status, 422);
  assert.match(bad.data.error, /rejected the username or password/);
  assert.equal((await admin.get('/api/integrations')).data.email.connected, false, 'a failed test saves nothing');

  assert.match((await admin.post('/api/integrations/email/smtp', { address: 'not-an-email', host: 'smtp.northstar.test', username: '' })).data.error, /sent from/);
  assert.match((await admin.post('/api/integrations/email/smtp', { address: 'a@b.co', host: 'not a host' })).data.error, /server name/);

  smtpVerify = async () => true;
  const ok = await admin.post('/api/integrations/email/smtp', { address: 'Compliance@Northstar.test', sender_name: 'Northstar Compliance', reply_to: 'hr@northstar.test', host: 'SMTP.northstar.test', port: 587, security: 'starttls', username: 'compliance@northstar.test', password: 'app-password-1' });
  assert.equal(ok.status, 200);
  const e = ok.data.email;
  assert.equal(e.connected, true);
  assert.equal(e.provider, 'smtp');
  assert.equal(e.address, 'compliance@northstar.test');
  assert.equal(e.host, 'smtp.northstar.test');
  assert.equal(e.has_password, true);
  assert.ok(!ok.text.includes('app-password-1'), 'the password never goes back to the browser');
  const raw = db.get('SELECT v FROM meta WHERE k=?', `email:${ns().id}`).v;
  assert.ok(!raw.includes('app-password-1') && !Buffer.from(raw, 'base64').toString().includes('app-password-1'), 'the password is stored encrypted');
  assert.equal(audits('EMAIL_CONNECTED').length, 1);

  // Saving again with a blank password keeps the saved one.
  const again = await admin.post('/api/integrations/email/smtp', { address: 'compliance@northstar.test', sender_name: 'Northstar Compliance', host: 'smtp.northstar.test', port: 587, username: 'compliance@northstar.test', password: '' });
  assert.equal(again.status, 200);
  assert.equal(smtpSent.length, 0);

  const t = await admin.post('/api/integrations/email/test', { to: 'nora.personal@example.com' });
  assert.equal(t.status, 200);
  assert.equal(smtpSent.length, 1);
  assert.equal(smtpSent[0].cfg.password, 'app-password-1');
  assert.equal(smtpSent[0].from, '"Northstar Compliance" <compliance@northstar.test>');
  assert.equal(smtpSent[0].to, 'nora.personal@example.com');
  assert.match(smtpSent[0].subject, /^Test email from Northstar Compliance$/);
  assert.equal(audits('EMAIL_TEST').length, 1);

  // A worker request uses the company's mailbox, with a safe HTML version and clickable links.
  const ref = await channels.deliver(ns(), { id: 'act_test_1', recipient: 'Asha Rao', recipient_email: 'asha@northstar.test', subject: 'Action needed: BLS card', body: 'Hi Asha, we need your BLS card <b>today</b>. Upload: https://aegis.test/submit/abc' });
  assert.equal(ref, 'email');
  const sent = smtpSent.at(-1);
  assert.equal(sent.to, 'asha@northstar.test');
  assert.match(sent.html, /&lt;b&gt;today&lt;\/b&gt;/, 'text from records is escaped, not run as HTML');
  assert.match(sent.html, /<a href="https:\/\/aegis.test\/submit\/abc">/);
  const msg = db.get("SELECT * FROM messages WHERE action_id='act_test_1'");
  assert.equal(msg.channel, 'email');
  assert.equal(msg.status, 'sent');
  assert.match(msg.provider_ref, /^smtp:/);
  const st = (await admin.get('/api/integrations')).data.email;
  assert.ok(st.last_sent_at);
  assert.equal(st.last_error, null);
});

test('sender name and reply address change without connecting again', async () => {
  const r = await admin.post('/api/integrations/email/details', { sender_name: 'Northstar HR Team', reply_to: '' });
  assert.equal(r.status, 200);
  assert.equal(r.data.email.sender_name, 'Northstar HR Team');
  assert.equal(r.data.email.reply_to, null);
  assert.equal(r.data.email.host, 'smtp.northstar.test');
  assert.equal((await admin.post('/api/integrations/email/details', { sender_name: 'x', reply_to: 'nope' })).status, 422);
});

test('Microsoft sign-in: a one-time link with PKCE, then the mailbox and a refresh key are saved', async () => {
  const start = await admin.post('/api/integrations/email/sign-in', { provider: 'microsoft', sender_name: 'Northstar Compliance', shared_mailbox: 'Compliance@Northstar.test', reply_to: 'hr@northstar.test' });
  assert.equal(start.status, 200);
  const url = new URL(start.data.url);
  assert.equal(url.origin + url.pathname, 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
  assert.equal(url.searchParams.get('client_id'), 'ms-app-id');
  assert.equal(url.searchParams.get('redirect_uri'), `${base}/api/oauth/callback`);
  assert.match(url.searchParams.get('scope'), /Mail\.Send Mail\.Send\.Shared/);
  assert.match(url.searchParams.get('scope'), /offline_access/);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(url.searchParams.get('code_challenge'));

  fake.tokenExpires = 30; // expires almost at once, so the first send renews it
  const back = await callback({ code: 'ms-code', state: stateOf(start.data.url) });
  assert.equal(back.status, 302);
  assert.equal(back.headers.get('location'), '/#integrations/email-connected');
  const exchange = lastCall('/oauth2/v2.0/token');
  assert.equal(exchange.form.grant_type, 'authorization_code');
  assert.equal(exchange.form.code, 'ms-code');
  assert.ok(exchange.form.code_verifier, 'the PKCE verifier is sent with the code');

  const e = (await admin.get('/api/integrations')).data.email;
  assert.equal(e.provider, 'microsoft');
  assert.equal(e.account, 'nora.lane@northstar.test');
  assert.equal(e.address, 'compliance@northstar.test', 'mail goes out from the shared mailbox');
  assert.equal(e.shared_mailbox, 'compliance@northstar.test');
  assert.equal(e.reply_to, 'hr@northstar.test');
  assert.ok(!JSON.stringify(e).includes('ms-refresh') && !JSON.stringify(e).includes('ms-access'), 'keys never reach the browser');
  assert.equal(audits('EMAIL_UPDATED').filter((a) => /Microsoft 365/.test(a.action)).length, 1);

  // The same sign-in link cannot be used twice.
  const reused = await callback({ code: 'ms-code', state: stateOf(start.data.url) });
  assert.equal(reused.headers.get('location'), '/#sso-error/expired');
});

test('Microsoft sending: renews the key, sends from the shared mailbox, and explains a Send As refusal', async () => {
  const ref = await Email.send(ns().id, { to: 'asha@northstar.test', subject: 'Action needed: BLS card', text: 'Hi Asha, please upload your card.' });
  assert.match(ref, /^graph:/);
  const renew = lastCall('/oauth2/v2.0/token');
  assert.equal(renew.form.grant_type, 'refresh_token');
  assert.equal(renew.form.refresh_token, 'ms-refresh-1');
  const sendCall = lastCall('/sendMail');
  assert.equal(sendCall.url, 'https://graph.microsoft.com/v1.0/users/compliance%40northstar.test/sendMail');
  assert.equal(sendCall.auth, 'Bearer ms-access-2');
  assert.deepEqual(sendCall.body.message.toRecipients, [{ emailAddress: { address: 'asha@northstar.test' } }]);
  assert.deepEqual(sendCall.body.message.from, { emailAddress: { address: 'compliance@northstar.test', name: 'Northstar Compliance' } });
  assert.deepEqual(sendCall.body.message.replyTo, [{ emailAddress: { address: 'hr@northstar.test' } }]);
  assert.equal(sendCall.body.message.body.contentType, 'HTML');
  assert.equal(sendCall.body.saveToSentItems, true);

  fake.sendAsDenied = true;
  const r = await admin.post('/api/integrations/email/test', { to: 'nora@northstar.test' });
  fake.sendAsDenied = false;
  assert.equal(r.status, 422);
  assert.match(r.data.error, /not allowed to send as compliance@northstar.test.*Send As/);
  assert.match((await admin.get('/api/integrations')).data.email.last_error, /Send As/);
  assert.equal((await admin.post('/api/integrations/email/test', { to: 'nora@northstar.test' })).status, 200);
  assert.equal((await admin.get('/api/integrations')).data.email.last_error, null, 'a later success clears the warning');
});

test('a Microsoft connection that was removed asks the company to connect again', async () => {
  const id = ns().id;
  const cfg = JSON.parse(require('../server/lib/util').decrypt(Buffer.from(db.get('SELECT v FROM meta WHERE k=?', `email:${id}`).v, 'base64')).toString());
  cfg.expires_at = 0;
  db.run('UPDATE meta SET v=? WHERE k=?', require('../server/lib/util').encrypt(Buffer.from(JSON.stringify(cfg))).toString('base64'), `email:${id}`);
  fake.refreshFails = true;
  await assert.rejects(Email.send(id, { to: 'asha@northstar.test', subject: 'x', text: 'y' }), /expired or was removed\. Connect your email again/);
  fake.refreshFails = false;
});

test('a cancelled sign-in keeps the reason for the Connections page', async () => {
  const start = await admin.post('/api/integrations/email/sign-in', { provider: 'microsoft' });
  const back = await callback({ error: 'access_denied', error_description: 'The user cancelled.', state: stateOf(start.data.url) });
  assert.equal(back.headers.get('location'), '/#integrations/email-failed');
  assert.match((await admin.get('/api/integrations')).data.email.last_error, /cancelled/);
  assert.equal(audits('EMAIL_CONNECT_FAILED').length, 1);

  const consent = await admin.post('/api/integrations/email/sign-in', { provider: 'microsoft' });
  await callback({ error: 'access_denied', error_description: 'AADSTS65001: The user or administrator has not consented.', state: stateOf(consent.data.url) });
  assert.match((await admin.get('/api/integrations')).data.email.last_error, /administrator to approve Aegis/);
});

test('Google sign-in reads the account from the ID token and sends through the Gmail API', async () => {
  const start = await admin.post('/api/integrations/email/sign-in', { provider: 'google', sender_name: 'Northstar Payroll' });
  const url = new URL(start.data.url);
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.match(url.searchParams.get('scope'), /gmail\.send/);
  const back = await callback({ code: 'g-code', state: stateOf(start.data.url) });
  assert.equal(back.headers.get('location'), '/#integrations/email-connected');
  const e = (await admin.get('/api/integrations')).data.email;
  assert.equal(e.provider, 'google');
  assert.equal(e.address, 'payroll@northstar-mail.test');
  assert.equal(e.shared_mailbox, null);
  assert.equal(e.last_error, null, 'connecting again clears an old sign-in error');

  const ref = await Email.send(ns().id, { to: 'asha@northstar.test', subject: 'Reminder 1: BLS card', text: 'Hi Asha,\n\nplease upload it.' });
  assert.equal(ref, 'gmail:gmail-123');
  const sent = lastCall('/messages/send');
  assert.equal(sent.auth, 'Bearer g-access');
  const mime = Buffer.from(sent.body.raw, 'base64url').toString();
  assert.match(mime, /^From: Northstar Payroll <payroll@northstar-mail\.test>/m);
  assert.match(mime, /^To: asha@northstar\.test/m);
  assert.match(mime, /^Subject: Reminder 1: BLS card/m);
  assert.match(mime, /multipart\/alternative/);
});

test('a provider that is not registered on the server cannot be chosen', async () => {
  const saved = process.env.AEGIS_GOOGLE_CLIENT_ID;
  delete process.env.AEGIS_GOOGLE_CLIENT_ID;
  try {
    const r = await admin.post('/api/integrations/email/sign-in', { provider: 'google' });
    assert.equal(r.status, 422);
    assert.match(r.data.error, /not available on this server yet/);
    assert.equal((await admin.get('/api/integrations')).data.email.available.google, false);
  } finally { process.env.AEGIS_GOOGLE_CLIENT_ID = saved; }
  assert.equal((await admin.post('/api/integrations/email/sign-in', { provider: 'yahoo' })).status, 422);
});

test('disconnecting returns worker requests to the outbox', async () => {
  const r = await admin.post('/api/integrations/email/remove', {});
  assert.equal(r.status, 200);
  assert.equal(r.data.email.connected, false);
  assert.equal(audits('EMAIL_REMOVED').length, 1);
  assert.equal((await admin.post('/api/integrations/email/remove', {})).status, 409);
  const ref = await channels.deliver(ns(), { id: 'act_test_2', recipient: 'Asha Rao', recipient_email: 'asha@northstar.test', subject: 'Reminder', body: 'Hi Asha.' });
  assert.equal(ref, 'outbox');
});

test('a new organization signs up on the real app and confirms its email through a real email', async () => {
  process.env.AEGIS_SIGNUP = '1'; process.env.RESEND_API_KEY = 're_test_key'; process.env.EMAIL_FROM = 'Aegis <accounts@aegis.test>';
  try {
    const info = await (await realFetch(`${base}/api/public/info`)).json();
    assert.equal(info.signup, true);
    const r = await realFetch(`${base}/api/signup`, { method: 'POST', headers: { 'x-aegis-client': 'web' }, body: JSON.stringify({ org_name: 'Riverbend Staffing', admin_name: 'Jordan Lee', email: 'Jordan@Riverbend.test', password: 'a long test-only signup password' }) });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true, email_sent: true });
    const mail = resendSent.at(-1);
    assert.deepEqual(mail.to, ['jordan@riverbend.test']);
    assert.equal(mail.subject, 'Confirm your email for Aegis');
    assert.match(mail.text, /^Hi Jordan,/);
    assert.match(mail.text, /Riverbend Staffing/);
    const link = mail.text.match(/(https?:\/\/\S+#verify-email\/([\w-]{43}))/);
    assert.ok(link, 'the email carries the confirmation link');
    assert.match(mail.html, /<a href="http/);

    const cookie = r.headers.get('set-cookie').split(';')[0];
    const call = async (m, p, b) => { const x = await realFetch(base + p, { method: m, headers: { cookie, 'x-aegis-client': 'web' }, body: b ? JSON.stringify(b) : undefined }); return { status: x.status, data: await x.json() }; };
    const me = (await call('GET', '/api/me')).data;
    assert.deepEqual(me.workspace_email, { pending: true, can_verify: true, delivery: 'email' });
    assert.deepEqual((await call('GET', '/api/verify-email/inbox')).data, { link: null }, 'no test inbox when real email is sent');
    assert.equal((await call('POST', '/api/integrations/email/smtp', { host: 'smtp.x.test' })).status, 403, 'email cannot be connected before confirming');
    assert.equal((await call('POST', '/api/verify-email', { token: link[2] })).status, 200);
    assert.equal((await call('GET', '/api/me')).data.workspace_email.pending, false);
  } finally {
    delete process.env.AEGIS_SIGNUP; delete process.env.RESEND_API_KEY; delete process.env.EMAIL_FROM;
  }
});
