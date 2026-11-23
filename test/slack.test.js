'use strict';
// Slack on the Integrations page: keys saved per company, tested first, never shown again,
// and used for alerts, direct requests and chat replies. Slack itself is faked.
const test = require('node:test'), assert = require('node:assert'), fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-'));
process.env.NODE_ENV = 'test';
process.env.AEGIS_DATA = dir; process.env.AEGIS_DEMO = '1';
// Keep any real keys in .env out of these tests.
for (const k of ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'SLACK_SIGNING_SECRET']) process.env[k] = '';

const calls = [];
const slackUsers = { 'health@northstar.demo': 'U_HEALTH', 'asha@northstar.test': 'U_ASHA' };
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (!u.startsWith('https://slack.com/api/')) return realFetch(url, opts);
  const method = u.slice('https://slack.com/api/'.length), body = JSON.parse(opts.body || '{}'), auth = opts.headers?.authorization;
  calls.push({ method, body, auth });
  const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
  if (auth === 'Bearer xoxb-bad') return json({ ok: false, error: 'invalid_auth' });
  switch (method) {
    case 'auth.test': return json({ ok: true, team: 'Northstar Test', team_id: 'T1', user: 'aegis', user_id: 'UBOT' });
    case 'apps.connections.open': return auth === 'Bearer xapp-good-1234' ? json({ ok: true, url: 'wss://example.invalid' }) : json({ ok: false, error: 'invalid_auth' });
    case 'chat.postMessage': return body.channel === '#private' ? json({ ok: false, error: 'not_in_channel' }) : json({ ok: true, ts: '1.1' });
    case 'users.lookupByEmail': return slackUsers[body.email] ? json({ ok: true, user: { id: slackUsers[body.email] } }) : json({ ok: false, error: 'users_not_found' });
    case 'users.info': return json({ ok: true, user: { profile: { email: body.user === 'U_HEALTH' ? 'health@northstar.demo' : 'stranger@elsewhere.com' } } });
  }
  return json({ ok: false, error: 'unknown_method' });
};

const { start, server } = require('../server/index.js');
const db = require('../server/lib/db'), Slack = require('../server/slack'), channels = require('../server/channels'), Chat = require('../server/chat');
let base, admin;
async function login(email) {
  const r = await realFetch(`${base}/api/login`, { method: 'POST', body: JSON.stringify({ email, password: 'demo1234' }) });
  assert.equal(r.status, 200);
  const cookie = r.headers.get('set-cookie').split(';')[0];
  const call = async (m, p, b) => { const x = await realFetch(base + p, { method: m, headers: { cookie, 'x-aegis-client': 'web' }, body: b ? JSON.stringify(b) : undefined }); const t = await x.text(); let d; try { d = JSON.parse(t); } catch { d = t; } return { status: x.status, data: d, text: t }; };
  return { get: (p) => call('GET', p), post: (p, b = {}) => call('POST', p, b) };
}
const ns = () => db.get("SELECT * FROM tenants WHERE slug='northstar'");
const posts = () => calls.filter((c) => c.method === 'chat.postMessage');

test.before(async () => {
  await start(0, { loop: false });
  base = `http://127.0.0.1:${server.address().port}`; process.env.AEGIS_BASE_URL = base;
  admin = await login('admin@northstar.demo');
});
test.after(() => { server.close(); globalThis.fetch = realFetch; try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch {} setTimeout(() => process.exit(0), 50); });

test('the Integrations page starts disconnected, shows Teams as coming soon, and is for administrators only', async () => {
  const r = await admin.get('/api/integrations');
  assert.equal(r.status, 200);
  assert.equal(r.data.slack.connected, false);
  assert.equal(r.data.teams.available, false);
  assert.deepEqual(r.data.teams.needs, ['App ID', 'Client secret', 'Tenant ID']);
  // Email shows as set up for SMTP as well as Resend, the two ways the server can send it.
  const saved = { RESEND_API_KEY: process.env.RESEND_API_KEY, SMTP_HOST: process.env.SMTP_HOST };
  try {
    delete process.env.RESEND_API_KEY; delete process.env.SMTP_HOST;
    assert.equal((await admin.get('/api/integrations')).data.email.configured, false);
    process.env.SMTP_HOST = 'smtp.example.com';
    assert.equal((await admin.get('/api/integrations')).data.email.configured, true);
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
  const hr = await login('hr@northstar.demo');
  assert.equal((await hr.get('/api/integrations')).status, 403);
  assert.equal((await hr.post('/api/integrations/slack', { bot_token: 'xoxb-1' })).status, 403);
});

test('wrong keys are refused with a clear message and nothing is saved', async () => {
  const wrongKind = await admin.post('/api/integrations/slack', { bot_token: 'xapp-oops' });
  assert.equal(wrongKind.status, 422); assert.match(wrongKind.data.error, /should start with xoxb-/);
  const rejected = await admin.post('/api/integrations/slack', { bot_token: 'xoxb-bad' });
  assert.equal(rejected.status, 422); assert.match(rejected.data.error, /Slack rejected this token/);
  const badApp = await admin.post('/api/integrations/slack', { bot_token: 'xoxb-good-5678', app_token: 'xapp-wrong-0000' });
  assert.equal(badApp.status, 422); assert.match(badApp.data.error, /App token/);
  assert.equal((await admin.post('/api/integrations/slack', { bot_token: 'xoxb-good-5678', channel: 'Not A Channel!' })).status, 400);
  assert.equal((await admin.get('/api/integrations')).data.slack.connected, false);
});

test('saving keys connects Slack; keys are never returned or written to the audit log', async () => {
  const r = await admin.post('/api/integrations/slack', { bot_token: 'xoxb-good-5678', app_token: 'xapp-good-1234', channel: 'compliance-alerts' });
  assert.equal(r.status, 200);
  const s = r.data.slack;
  assert.equal(s.connected, true); assert.equal(s.source, 'settings');
  assert.equal(s.workspace, 'Northstar Test'); assert.equal(s.bot, 'aegis');
  assert.equal(s.channel, '#compliance-alerts', 'a # is added');
  assert.equal(s.bot_token_hint, 'xoxb-…5678');
  assert.equal(s.receiving.mode, 'socket');
  assert.ok(!r.text.includes('xoxb-good-5678') && !r.text.includes('xapp-good-1234'), 'full keys never leave the server');
  assert.ok(!db.all('SELECT action FROM audit_log').some((a) => /xoxb-good|xapp-good/.test(a.action)));
  assert.ok(!db.all('SELECT v FROM meta').some((m) => m.v.includes('xoxb-good')), 'stored encrypted');
  assert.ok(db.get("SELECT 1 AS x FROM audit_log WHERE type='SLACK_CONNECTED' AND tenant_id=?", ns().id));
  assert.equal(JSON.parse(ns().channel_json).type, 'slack');
  assert.equal(Slack.configured(db.get("SELECT id FROM tenants WHERE slug='bluebix'").id), false, 'one company’s Slack is not another’s');
});

test('test message posts to the alerts channel, and explains how to fix a missing invite', async () => {
  calls.length = 0;
  const ok = await admin.post('/api/integrations/slack/test');
  assert.equal(ok.data.ok, true); assert.equal(ok.data.posted, true);
  assert.equal(posts()[0].body.channel, '#compliance-alerts');
  assert.equal(posts()[0].auth, 'Bearer xoxb-good-5678');
  db.update('tenants', ns().id, { channel_json: JSON.stringify({ type: 'slack', channel: '#private' }) });
  const bad = await admin.post('/api/integrations/slack/test');
  assert.equal(bad.data.ok, false); assert.match(bad.data.error, /\/invite @aegis/);
  db.update('tenants', ns().id, { channel_json: JSON.stringify({ type: 'slack', channel: '#compliance-alerts' }) });
});

test('requests reach people in Slack by their work email, and fall back when they are not in Slack', async () => {
  calls.length = 0;
  const tn = ns();
  assert.equal(await channels.deliver(tn, { id: 'act_1', recipient: 'Asha Rao', recipient_email: 'asha@northstar.test', subject: 'S', body: 'Please upload your **BLS card**.' }), 'slack');
  const dm = posts()[0];
  assert.equal(dm.body.channel, 'U_ASHA');
  assert.equal(dm.body.text, 'Please upload your *BLS card*.', 'bold is converted to Slack format');
  assert.equal(await channels.deliver(tn, { id: 'act_2', recipient: 'Nobody', recipient_email: 'nobody@northstar.test', subject: 'S', body: 'B' }), 'outbox', 'not in Slack and no email set up: stays in the outbox');
  // A second message to the same person does not look them up again.
  const lookups = calls.filter((c) => c.method === 'users.lookupByEmail').length;
  await channels.deliver(tn, { id: 'act_3', recipient: 'Asha Rao', recipient_email: 'asha@northstar.test', subject: 'S', body: 'B' });
  assert.equal(calls.filter((c) => c.method === 'users.lookupByEmail').length, lookups);
});

test('chat: Aegis answers direct messages and mentions once, ignores channel chatter, and knows who is asking', async () => {
  const t = ns().id, ev = (id, event) => ({ type: 'event_callback', event_id: id, event: { user: 'U_HEALTH', channel: 'D1', ts: '1', ...event } });
  calls.length = 0;
  await Slack.handleEvent(t, ev('E1', { type: 'message', channel_type: 'im', text: 'What needs my approval?' }), Chat.handle);
  assert.equal(posts().length, 1);
  assert.equal(posts()[0].body.channel, 'D1');
  assert.equal(db.get("SELECT slack_id FROM users WHERE email='health@northstar.demo'").slack_id, 'U_HEALTH', 'matched by email and remembered');
  await Slack.handleEvent(t, ev('E1', { type: 'message', channel_type: 'im', text: 'What needs my approval?' }), Chat.handle);
  assert.equal(posts().length, 1, 'a repeated event is answered once');
  await Slack.handleEvent(t, ev('E2', { type: 'message', channel_type: 'channel', text: 'lunch?' }), Chat.handle);
  await Slack.handleEvent(t, ev('E3', { type: 'message', channel_type: 'im', text: 'hi', bot_id: 'B1' }), Chat.handle);
  assert.equal(posts().length, 1, 'channel chatter and bot messages are ignored');
  await Slack.handleEvent(t, ev('E4', { type: 'app_mention', text: '<@UBOT> which credentials expire next month?' }), Chat.handle);
  assert.equal(posts().length, 2);
  await Slack.handleEvent(t, ev('E5', { type: 'message', channel_type: 'im', text: 'hello', user: 'U_STRANGER' }), Chat.handle);
  assert.match(posts()[2].body.text, /do not know who you are/);
});

test('Events URL: per-company signing secret, and the URL check Slack sends', async () => {
  await admin.post('/api/integrations/slack', { signing_secret: 'sign-secret-1' });
  const send = (body, secret) => {
    const ts = String(Math.floor(Date.now() / 1000)), raw = JSON.stringify(body);
    const sig = 'v0=' + crypto.createHmac('sha256', secret).update(`v0:${ts}:${raw}`).digest('hex');
    return realFetch(`${base}/api/webhooks/slack/northstar`, { method: 'POST', headers: { 'x-slack-request-timestamp': ts, 'x-slack-signature': sig }, body: raw });
  };
  const ok = await send({ type: 'url_verification', challenge: 'abc' }, 'sign-secret-1');
  assert.deepEqual(await ok.json(), { challenge: 'abc' });
  assert.equal((await send({ type: 'url_verification', challenge: 'abc' }, 'wrong')).status, 401);
  assert.equal((await realFetch(`${base}/api/webhooks/slack/bluebix`, { method: 'POST', body: '{}' })).status, 404, 'a company without Slack has no Events URL');
});

test('replacing keeps saved keys unless new ones are given; disconnecting deletes them', async () => {
  const r = await admin.post('/api/integrations/slack', { channel: '#alerts-2' });
  assert.equal(r.status, 200);
  assert.equal(r.data.slack.bot_token_hint, 'xoxb-…5678', 'the bot token was kept');
  assert.equal(r.data.slack.channel, '#alerts-2');
  assert.ok(db.get("SELECT 1 AS x FROM audit_log WHERE type='SLACK_UPDATED'"));
  const off = await admin.post('/api/integrations/slack/remove');
  assert.equal(off.data.slack.connected, false);
  assert.equal(JSON.parse(ns().channel_json).type, 'outbox');
  assert.ok(!db.get("SELECT 1 AS x FROM meta WHERE k=?", `slack:${ns().id}`));
  assert.equal(await channels.post(ns(), '#alerts-2', 'Digest', 'B'), 'outbox');
});

test('keys from the server .env show as such and cannot be removed from the page', async () => {
  process.env.SLACK_BOT_TOKEN = 'xoxb-env-9999';
  try {
    const r = await admin.get('/api/integrations');
    assert.equal(r.data.slack.source, 'environment');
    assert.equal((await admin.post('/api/integrations/slack/remove')).status, 409);
  } finally { process.env.SLACK_BOT_TOKEN = ''; }
});
