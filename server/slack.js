'use strict';
// Slack, one connection per company. An administrator enters the keys on the Integrations page.
// Keys are tested before saving, stored encrypted, and never returned to the browser.
//
//   bot_token       xoxb-...  needed for everything
//   app_token       xapp-...  Socket Mode: Aegis opens the connection to Slack, so chat works
//                             with no public address (for example on a laptop). Recommended now.
//   signing_secret            Events URL mode: Slack calls <AEGIS_BASE_URL>/api/webhooks/slack/<company>.
//                             Needs a public https address. Optional.
//
// For local development the same values can come from .env (SLACK_BOT_TOKEN, SLACK_APP_TOKEN,
// SLACK_SIGNING_SECRET). Keys saved on the Integrations page always win.
//
// Direct messages can read records. Channel mentions only point people to a private conversation.
const crypto = require('crypto');
const db = require('./lib/db'), { encrypt, decrypt, clock } = require('./lib/util');

const metaKey = (t) => `slack:${t}`;
function stored(t) {
  const r = t && db.get('SELECT v FROM meta WHERE k=?', metaKey(t));
  if (!r) return null;
  try { return JSON.parse(decrypt(Buffer.from(r.v, 'base64')).toString()); } catch { return null; }
}
function fromEnv() {
  const e = process.env;
  return e.SLACK_BOT_TOKEN ? { bot_token: e.SLACK_BOT_TOKEN, app_token: e.SLACK_APP_TOKEN || null, signing_secret: e.SLACK_SIGNING_SECRET || null, source: 'environment' } : null;
}
const config = (t) => {
  const s = stored(t);
  if (s) return { ...s, source: 'settings' };
  return t && db.get("SELECT 1 AS x FROM tenants WHERE id=? AND kind='customer'", t) ? null : fromEnv();
};
const configured = (t) => !!config(t)?.bot_token;
const hint = (k) => (k ? `${k.slice(0, 5)}…${k.slice(-4)}` : null);

async function api(method, body, auth) {
  let res;
  try {
    res = await fetch(`https://slack.com/api/${method}`, { method: 'POST', headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify(body || {}), signal: AbortSignal.timeout(15000) });
  } catch (e) { throw new Error(`Slack could not be reached (${e.name === 'TimeoutError' ? 'timed out' : e.message}).`); }
  if (res.status === 429) throw new Error('Slack is rate limiting requests. Try again in a minute.');
  const out = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  if (!out.ok) throw new Error(friendly(out));
  return out;
}
const ERRORS = {
  invalid_auth: 'Slack rejected this token. Copy it again from the Slack app page.',
  not_authed: 'No token was sent to Slack.',
  account_inactive: 'This Slack app or workspace is no longer active.',
  token_revoked: 'This token was revoked in Slack. Create a new one.',
  not_allowed_token_type: 'This is the wrong kind of token. The bot token starts with xoxb- and the app token with xapp-.',
  channel_not_found: 'Slack cannot find that channel.',
  not_in_channel: 'The Aegis app is not in that channel yet.',
};
const friendly = (out) => (ERRORS[out.error] || `Slack error: ${out.error}`) + (out.needed ? ` The app needs the ${out.needed} permission; reinstall it after adding it.` : '');

// Aegis writes **bold**; Slack writes *bold*.
const toSlack = (text) => String(text).replace(/\*\*(.+?)\*\*/g, '*$1*');
async function postMessage(t, channel, text) {
  const cfg = config(t);
  if (!cfg?.bot_token) throw new Error('Slack is not connected.');
  return (await api('chat.postMessage', { channel, text: toSlack(text), unfurl_links: false }, cfg.bot_token)).ts;
}

// People are found by their work email, so nobody has to copy Slack IDs by hand.
// A found ID is remembered for an hour; "not in Slack" for ten minutes.
const lookups = new Map();
async function findUserByEmail(t, email) {
  const cfg = config(t);
  if (!email || !cfg?.bot_token) return null;
  const key = `${t}:${email.toLowerCase()}`, hit = lookups.get(key);
  if (hit && hit.until > Date.now()) return hit.id;
  let found = null;
  try { found = (await api('users.lookupByEmail', { email }, cfg.bot_token)).user?.id || null; }
  catch (e) { if (!/users_not_found/.test(e.message)) throw e; }
  lookups.set(key, { id: found, until: Date.now() + (found ? 36e5 : 6e5) });
  return found;
}

// ---- managing the connection (Integrations page)
// New keys replace old ones; a field left empty keeps the saved value.
async function save(t, user, input) {
  const old = stored(t) || {};
  const pick = (k) => (typeof input[k] === 'string' && input[k].trim() ? input[k].trim() : old[k] || null);
  const cfg = { bot_token: pick('bot_token'), app_token: pick('app_token'), signing_secret: pick('signing_secret') };
  if (!cfg.bot_token) throw new Error('The bot token is required.');
  if (!cfg.bot_token.startsWith('xoxb-')) throw new Error('The bot token should start with xoxb-. Find it under OAuth & Permissions in your Slack app.');
  if (cfg.app_token && !cfg.app_token.startsWith('xapp-')) throw new Error('The app token should start with xapp-. Find it under Basic Information > App-Level Tokens.');
  const who = await api('auth.test', {}, cfg.bot_token);
  // Opening a Socket Mode URL proves the app token is valid. The URL itself is not used here.
  if (cfg.app_token) await api('apps.connections.open', {}, cfg.app_token).catch((e) => { throw new Error(`App token: ${e.message.replace('this token', 'the app token')} It needs the connections:write scope.`); });
  Object.assign(cfg, { team: who.team, team_id: who.team_id, bot_user: who.user, bot_user_id: who.user_id, saved_by: user.name, saved_at: clock.iso() });
  db.run('INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v', metaKey(t), encrypt(Buffer.from(JSON.stringify(cfg))).toString('base64'));
  for (const k of lookups.keys()) if (k.startsWith(`${t}:`)) lookups.delete(k);
  return { replaced: !!old.bot_token, ...cfg };
}
function remove(t) {
  db.run('DELETE FROM meta WHERE k=?', metaKey(t));
  stopSocket(t);
}
// What the Integrations page shows. Never includes a key.
function status(t, channel) {
  const cfg = config(t);
  if (!cfg?.bot_token) return { connected: false, source: null };
  const s = sockets.get(socketKey(t, cfg));
  return {
    connected: true,
    source: cfg.source,
    workspace: cfg.team || null,
    bot: cfg.bot_user || null,
    channel: channel || null,
    bot_token_hint: hint(cfg.bot_token),
    app_token_hint: hint(cfg.app_token),
    has_signing_secret: !!cfg.signing_secret,
    saved_by: cfg.saved_by || null,
    saved_at: cfg.saved_at || null,
    receiving: cfg.app_token ? { mode: 'socket', state: s?.state || 'off', error: s?.error || null } : cfg.signing_secret ? { mode: 'events_url' } : { mode: 'none' },
  };
}
// Checks the token and posts a test message to the alerts channel.
async function test(t, channel) {
  const cfg = config(t);
  if (!cfg?.bot_token) throw new Error('Slack is not connected.');
  const who = await api('auth.test', {}, cfg.bot_token);
  const out = { ok: true, workspace: who.team, bot: who.user, channel };
  if (!channel) return out;
  try { await postMessage(t, channel, 'Aegis test message: Slack is connected. Compliance alerts and digests will appear here.'); out.posted = true; }
  catch (e) { out.ok = false; out.posted = false; out.error = /not in that channel|cannot find/.test(e.message) ? `${e.message} In Slack, open ${channel} and type /invite @${who.user}.` : e.message; }
  return out;
}

// ---- incoming messages (shared by Socket Mode and the Events URL)
const seenEvents = new Map();
function firstTime(eventId) {
  if (!eventId) return true;
  const now = Date.now();
  for (const [k, at] of seenEvents) if (now - at > 36e5) seenEvents.delete(k);
  if (seenEvents.has(eventId)) return false;
  seenEvents.set(eventId, now);
  return true;
}
// The question to answer, or null when Aegis should stay quiet.
function questionFrom(e) {
  if (!e || e.bot_id || e.subtype || !e.text || !e.user) return null;
  if (e.type === 'app_mention') return e.text.replace(/<@[A-Z0-9]+>/g, '').trim() || null;
  if (e.type === 'message' && e.channel_type === 'im') return e.text.trim();
  return null;
}
// tenantId is known for a company's own connection. For the shared .env connection it is null,
// and the company comes from the person who wrote.
async function handleEvent(tenantId, envelope, chatHandle) {
  if (envelope?.type !== 'event_callback' || !firstTime(envelope.event_id)) return;
  const e = envelope.event, text = questionFrom(e);
  if (!text) return;
  const cfg = tenantId ? config(tenantId) : fromEnv();
  if (!cfg?.bot_token) return;
  if (cfg.team_id && envelope.team_id && cfg.team_id !== envelope.team_id) return;
  const reply = (msg) => {
    const safeText = msg.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
    return api('chat.postMessage', { channel: e.channel, text: toSlack(safeText), unfurl_links: false, unfurl_media: false }, cfg.bot_token).catch((err) => console.error('[slack] reply failed:', err.message));
  };
  if (e.type === 'app_mention' && e.channel_type !== 'im') return reply('Send me a direct message to ask about Aegis records, or open Ask coworker in Aegis to run actions.');
  const scope = tenantId ? ' AND tenant_id=?' : " AND tenant_id IN (SELECT id FROM tenants WHERE kind IS NULL OR kind<>'customer')";
  const args = tenantId ? [tenantId] : [];
  const singleMatch = (predicate, value) => {
    const users = db.all(`SELECT * FROM users WHERE ${predicate} AND disabled_at IS NULL${scope} LIMIT 2`, value, ...args);
    return users.length === 1 ? users[0] : null;
  };
  // A Slack account is matched to an Aegis user by Slack ID, or else by the same work email.
  let u = singleMatch('slack_id=?', e.user);
  if (!u) {
    try {
      const email = (await api('users.info', { user: e.user }, cfg.bot_token)).user?.profile?.email;
      u = email && singleMatch('lower(email)=lower(?)', email);
      if (u) db.update('users', u.id, { slack_id: e.user });
    } catch (err) { console.error('[slack] users.info failed:', err.message); }
  }
  if (!u) return reply('I do not know who you are in Aegis yet. Ask an administrator to add your work email to your Aegis user.');
  try {
    const { reply: answer } = await chatHandle(u.tenant_id, { ...u, type: 'user' }, text.slice(0, 1000), { source: 'slack' });
    await reply(answer);
  }
  catch (err) {
    if (err.status >= 400 && err.status < 500) return reply(err.message);
    console.error('[slack] chat failed:', err);
    await reply('Something went wrong while answering. The error was logged.');
  }
}
function verify(secret, ts, raw, sig) {
  if (!secret || !ts || !sig || Math.abs(Date.now() / 1000 - +ts) > 300) return false;
  const h = 'v0=' + crypto.createHmac('sha256', secret).update(`v0:${ts}:${raw}`).digest('hex');
  return h.length === sig.length && crypto.timingSafeEqual(Buffer.from(h), Buffer.from(sig));
}

// ---- Socket Mode: one connection per company with an app token
const sockets = new Map();
const socketKey = (t, cfg) => (cfg?.source === 'environment' ? 'env' : t);
let chat = null;
function startSocket(t) {
  const cfg = config(t);
  if (!chat || !cfg?.app_token || typeof WebSocket === 'undefined') return;
  const key = socketKey(t, cfg);
  stopSocket(key);
  const s = { state: 'connecting', error: null, ws: null, stopped: false, retryMs: 1000 };
  sockets.set(key, s);
  const tenantId = key === 'env' ? null : t;
  const connect = async () => {
    if (s.stopped) return;
    let url;
    try { url = (await api('apps.connections.open', {}, cfg.app_token)).url; }
    catch (e) { s.state = 'error'; s.error = e.message; return again(); }
    const ws = new WebSocket(url);
    s.ws = ws;
    ws.onopen = () => { s.state = 'connected'; s.error = null; s.retryMs = 1000; console.log(`[slack] Socket Mode connected for ${cfg.team || key}.`); };
    ws.onmessage = (m) => {
      let msg; try { msg = JSON.parse(m.data); } catch { return; }
      // Slack needs an acknowledgement within 3 seconds, so acknowledge first and answer after.
      if (msg.envelope_id) ws.send(JSON.stringify({ envelope_id: msg.envelope_id }));
      if (msg.type === 'events_api') handleEvent(tenantId, msg.payload, chat);
      if (msg.type === 'disconnect') ws.close();
    };
    ws.onerror = () => { s.error = 'The connection to Slack failed.'; };
    ws.onclose = () => { s.ws = null; if (!s.stopped) { s.state = 'reconnecting'; again(); } };
  };
  const again = () => { if (s.stopped) return; setTimeout(connect, s.retryMs).unref(); s.retryMs = Math.min(s.retryMs * 2, 60000); };
  connect();
}
function stopSocket(key) {
  const s = sockets.get(key);
  if (!s) return;
  s.stopped = true;
  if (s.ws) try { s.ws.close(); } catch {}
  sockets.delete(key);
}
// Starts Socket Mode for every company that has an app token.
function startAll(chatHandle) {
  chat = chatHandle;
  if (fromEnv()?.app_token) startSocket(null);
  for (const r of db.all("SELECT k FROM meta WHERE k LIKE 'slack:%'")) startSocket(r.k.slice(6));
}
function stopAll() { for (const k of [...sockets.keys()]) stopSocket(k); }

module.exports = { config, configured, postMessage, findUserByEmail, save, remove, status, test, handleEvent, questionFrom, verify, startSocket, startAll, stopAll, toSlack };
