'use strict';
// Email, one connection per company. An administrator connects it on the Connections page:
//
//   microsoft  "Sign in with Microsoft" (Outlook / Microsoft 365). Sends through Microsoft Graph.
//   google     "Sign in with Google" (Gmail / Google Workspace). Sends through the Gmail API.
//   smtp       Any other provider: server, port, username and password.
//
// Microsoft and Google never give Aegis a password. The company signs in on Microsoft's or Google's own
// page and approves one permission: send mail. Aegis keeps the resulting key (a refresh token),
// encrypted, and the company can cancel it at any time from its Microsoft or Google account.
//
// Microsoft and Google sign-in need Aegis to be registered once with each of them, by the team that
// runs Aegis (not by each customer). Those app keys come from the server's .env:
//   AEGIS_MICROSOFT_CLIENT_ID, AEGIS_MICROSOFT_CLIENT_SECRET, AEGIS_GOOGLE_CLIENT_ID, AEGIS_GOOGLE_CLIENT_SECRET
// Without them the option shows as "not available yet".
//
// Keys and passwords are tested before saving, stored encrypted, and never returned to the browser.
const crypto = require('crypto');
const db = require('./lib/db'), { encrypt, decrypt, clock, sha256, token } = require('./lib/util');

let nodemailer = null;
try { nodemailer = require('nodemailer'); } catch {}

// Tests replace these so no real email or provider is involved.
const hooks = { smtpTransport: null };

const PROVIDERS = {
  microsoft: {
    label: 'Microsoft 365 (Outlook)',
    authorize: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    token: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scope: (shared) => `offline_access openid email User.Read Mail.Send${shared ? ' Mail.Send.Shared' : ''}`,
    env: ['AEGIS_MICROSOFT_CLIENT_ID', 'AEGIS_MICROSOFT_CLIENT_SECRET'],
  },
  google: {
    label: 'Google Workspace (Gmail)',
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    scope: () => 'openid email https://www.googleapis.com/auth/gmail.send',
    env: ['AEGIS_GOOGLE_CLIENT_ID', 'AEGIS_GOOGLE_CLIENT_SECRET'],
  },
  smtp: { label: 'Other email (SMTP)' },
};
const appKeys = (p) => ({ id: process.env[PROVIDERS[p].env[0]] || '', secret: process.env[PROVIDERS[p].env[1]] || '' });
const available = () => ({
  microsoft: !!(appKeys('microsoft').id && appKeys('microsoft').secret),
  google: !!(appKeys('google').id && appKeys('google').secret),
  smtp: !!nodemailer,
});
const baseUrl = () => (process.env.AEGIS_BASE_URL || `http://localhost:${process.env.ACTUAL_PORT || process.env.PORT || 4100}`).replace(/\/+$/, '');
const redirectUri = () => `${baseUrl()}/api/oauth/callback`;

// ---- stored connection (encrypted) and its delivery status (plain, no secrets)
const metaKey = (t) => `email:${t}`, statusKey = (t) => `email-status:${t}`;
function stored(t) {
  const r = t && db.get('SELECT v FROM meta WHERE k=?', metaKey(t));
  if (!r) return null;
  try { return JSON.parse(decrypt(Buffer.from(r.v, 'base64')).toString()); } catch { return null; }
}
function write(t, cfg) {
  db.run('INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v', metaKey(t), encrypt(Buffer.from(JSON.stringify(cfg))).toString('base64'));
}
function readStatus(t) {
  const r = db.get('SELECT v FROM meta WHERE k=?', statusKey(t));
  try { return r ? JSON.parse(r.v) : {}; } catch { return {}; }
}
function writeStatus(t, patch) {
  const next = { ...readStatus(t), ...patch };
  db.run('INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v', statusKey(t), JSON.stringify(next));
}
const connected = (t) => !!stored(t);

// ---- input checks
const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;
const cleanEmail = (v) => String(v || '').trim().toLowerCase();
function optionalEmail(v, what) {
  const e = cleanEmail(v);
  if (e && !EMAIL_RE.test(e)) throw new Error(`Enter a valid email address for ${what}.`);
  return e || null;
}
function senderName(v, fallback) {
  const s = String(v ?? '').replace(/[\r\n<>"]/g, ' ').replace(/\s+/g, ' ').trim();
  if (s.length > 80) throw new Error('Keep the sender name under 80 characters.');
  return s || fallback;
}
const defaultSender = (t) => `${db.get('SELECT name FROM tenants WHERE id=?', t)?.name || 'Your company'} Compliance`;

// ---- HTTP helpers for Microsoft and Google
async function call(url, opts, who) {
  let res;
  try { res = await fetch(url, { ...opts, signal: AbortSignal.timeout(20000) }); }
  catch (e) { throw new Error(`${who} could not be reached (${e.name === 'TimeoutError' ? 'timed out' : e.message}).`); }
  const text = await res.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text.slice(0, 200) }; }
  return { status: res.status, ok: res.ok, body };
}
const form = (o) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(o).toString() });

// What a sign-in or token error means, in words an administrator can act on.
function tokenError(provider, body) {
  const who = provider === 'microsoft' ? 'Microsoft' : 'Google';
  const desc = String(body.error_description || '').split(/\r?\n/)[0];
  if (/AADSTS65001|AADSTS90094|consent/i.test(desc)) return `${who} needs your administrator to approve Aegis for your organization first.`;
  if (body.error === 'invalid_grant') return `The connection to ${who} has expired or was removed. Connect your email again.`;
  if (body.error === 'invalid_client' || body.error === 'unauthorized_client') return `${who} did not accept the Aegis app keys on this server. The Aegis team needs to check them.`;
  return `${who} sign-in failed: ${desc || body.error || 'no reason given'}.`;
}

// ---- sign-in with Microsoft or Google
// A started sign-in waits here for up to 10 minutes. One server only, as for background jobs.
const pendingSignIns = new Map();
// The shared callback address serves email connections and "Continue with Microsoft/Google" sign-in.
const ownsState = (state) => !!state && pendingSignIns.has(sha256(state));
const SIGN_IN_TTL = 10 * 60e3;
function startSignIn(t, user, input) {
  const provider = input.provider;
  if (provider !== 'microsoft' && provider !== 'google') throw new Error('Choose Microsoft 365 or Google Workspace.');
  if (!available()[provider]) throw new Error(`${provider === 'microsoft' ? 'Microsoft' : 'Google'} sign-in is not available on this server yet. The Aegis team needs to register Aegis with ${provider === 'microsoft' ? 'Microsoft' : 'Google'} first.`);
  const shared = provider === 'microsoft' ? optionalEmail(input.shared_mailbox, 'the shared mailbox') : null;
  const options = { sender_name: senderName(input.sender_name, defaultSender(t)), reply_to: optionalEmail(input.reply_to, 'replies'), shared_mailbox: shared };
  const now = Date.now();
  for (const [k, v] of pendingSignIns) if (v.expires < now) pendingSignIns.delete(k);
  const state = token(), verifier = crypto.randomBytes(32).toString('base64url');
  pendingSignIns.set(sha256(state), { tenant: t, user_id: user.id, user_name: user.name, provider, options, verifier, expires: now + SIGN_IN_TTL });
  const p = PROVIDERS[provider], q = new URLSearchParams({
    client_id: appKeys(provider).id, response_type: 'code', redirect_uri: redirectUri(), scope: p.scope(shared), state,
    code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
  });
  if (provider === 'microsoft') { q.set('response_mode', 'query'); q.set('prompt', 'select_account'); }
  else { q.set('access_type', 'offline'); q.set('prompt', 'consent'); }
  return { url: `${p.authorize}?${q}` };
}

// Google returns the account's email inside the ID token. It comes straight from Google over HTTPS,
// so reading its middle part is enough here.
function idTokenEmail(idToken) {
  try { return cleanEmail(JSON.parse(Buffer.from(String(idToken).split('.')[1], 'base64url').toString()).email); } catch { return ''; }
}

// Microsoft or Google sends the browser back here. Returns the company it belongs to, or throws.
async function finishSignIn(q) {
  const state = q.get('state') || '', found = state && pendingSignIns.get(sha256(state));
  if (!found || found.expires < Date.now()) throw Object.assign(new Error('This sign-in link has expired. Start again from Connections.'), { tenant: null });
  pendingSignIns.delete(sha256(state));
  const fail = (message) => Object.assign(new Error(message), { tenant: found.tenant, user_name: found.user_name });
  if (q.get('error')) {
    const desc = q.get('error_description') || '';
    throw fail(q.get('error') === 'access_denied' && !/AADSTS65001/.test(desc) ? 'Sign-in was cancelled, so email was not connected.' : tokenError(found.provider, { error: q.get('error'), error_description: desc }));
  }
  const code = q.get('code');
  if (!code) throw fail('The sign-in did not return a code. Try again.');
  const p = PROVIDERS[found.provider], keys = appKeys(found.provider);
  const tok = await call(p.token, form({
    client_id: keys.id, client_secret: keys.secret, grant_type: 'authorization_code', code, redirect_uri: redirectUri(), code_verifier: found.verifier,
    ...(found.provider === 'microsoft' ? { scope: p.scope(found.options.shared_mailbox) } : {}),
  }), found.provider === 'microsoft' ? 'Microsoft' : 'Google');
  if (!tok.ok || !tok.body.access_token) throw fail(tokenError(found.provider, tok.body));
  if (!tok.body.refresh_token) throw fail(`${found.provider === 'microsoft' ? 'Microsoft' : 'Google'} did not allow Aegis to stay connected. Try again and accept every permission shown.`);
  let account = '';
  if (found.provider === 'microsoft') {
    const me = await call('https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName,displayName', { headers: { authorization: `Bearer ${tok.body.access_token}` } }, 'Microsoft');
    if (!me.ok) throw fail(`Microsoft did not share the signed-in mailbox (${me.body.error?.message || me.status}).`);
    account = cleanEmail(me.body.mail || me.body.userPrincipalName);
    if (!me.body.mail) throw fail('This Microsoft account has no mailbox. Sign in with a work account that uses Outlook.');
  } else {
    account = idTokenEmail(tok.body.id_token);
    if (!account) throw fail('Google did not share the email address of the signed-in account.');
  }
  const old = stored(found.tenant);
  const cfg = {
    provider: found.provider, account, address: found.options.shared_mailbox || account,
    sender_name: found.options.sender_name, reply_to: found.options.reply_to, shared_mailbox: found.options.shared_mailbox,
    refresh_token: tok.body.refresh_token, access_token: tok.body.access_token,
    expires_at: Date.now() + (Number(tok.body.expires_in) || 3600) * 1000,
    saved_by: found.user_name, saved_at: clock.iso(),
  };
  write(found.tenant, cfg);
  writeStatus(found.tenant, { last_error: null, last_error_at: null });
  return { tenant: found.tenant, user_name: found.user_name, replaced: !!old, ...view(cfg) };
}

// A fresh access key for sending. Keys last about an hour; the refresh token renews them.
async function accessToken(t, cfg) {
  if (cfg.access_token && cfg.expires_at > Date.now() + 60e3) return cfg.access_token;
  const p = PROVIDERS[cfg.provider], keys = appKeys(cfg.provider);
  if (!keys.id) throw new Error(`${cfg.provider === 'microsoft' ? 'Microsoft' : 'Google'} sign-in is no longer set up on this server. The Aegis team needs to restore the app keys.`);
  const tok = await call(p.token, form({
    client_id: keys.id, client_secret: keys.secret, grant_type: 'refresh_token', refresh_token: cfg.refresh_token,
    ...(cfg.provider === 'microsoft' ? { scope: p.scope(cfg.shared_mailbox) } : {}),
  }), cfg.provider === 'microsoft' ? 'Microsoft' : 'Google');
  if (!tok.ok || !tok.body.access_token) throw new Error(tokenError(cfg.provider, tok.body));
  // Microsoft may hand out a new refresh token each time; keep the newest one.
  const next = { ...cfg, access_token: tok.body.access_token, expires_at: Date.now() + (Number(tok.body.expires_in) || 3600) * 1000, refresh_token: tok.body.refresh_token || cfg.refresh_token };
  write(t, next);
  return next.access_token;
}

// ---- other providers by SMTP
function smtpTransport(cfg) {
  if (hooks.smtpTransport) return hooks.smtpTransport(cfg);
  if (!nodemailer) throw new Error('Email by SMTP is not available on this server.');
  return nodemailer.createTransport({
    host: cfg.host, port: cfg.port, secure: cfg.security === 'ssl', requireTLS: cfg.security === 'starttls',
    auth: cfg.username ? { user: cfg.username, pass: cfg.password } : undefined,
    connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000,
  });
}
function smtpError(e) {
  const m = String(e?.message || e);
  if (e?.code === 'EAUTH' || /535|authentication/i.test(m)) return 'The email server rejected the username or password. Some providers need an app password instead of your normal one.';
  if (e?.code === 'ETIMEDOUT' || e?.code === 'ECONNECTION' || /timeout|ECONNREFUSED|ENOTFOUND/i.test(m)) return 'Aegis could not reach that email server. Check the server name and port.';
  if (/certificate|SSL|TLS|wrong version/i.test(m)) return 'The secure connection failed. Check the security setting matches the port (SSL for 465, STARTTLS for 587).';
  return `The email server said: ${m}`;
}
async function saveSmtp(t, user, input) {
  if (!available().smtp) throw new Error('Email by SMTP is not available on this server.');
  const old = stored(t);
  const oldSmtp = old?.provider === 'smtp' ? old : {};
  const host = String(input.host || '').trim().toLowerCase();
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) throw new Error('Enter the email server name, for example smtp.example.com.');
  const port = Number(input.port || 587);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Enter a port number, usually 587 or 465.');
  const security = ['starttls', 'ssl', 'none'].includes(input.security) ? input.security : port === 465 ? 'ssl' : 'starttls';
  const username = String(input.username ?? '').trim();
  const password = typeof input.password === 'string' && input.password ? input.password : (username && username === oldSmtp.username ? oldSmtp.password : '');
  if (username && !password) throw new Error('Enter the password for this email account.');
  const address = cleanEmail(input.address || username);
  if (!EMAIL_RE.test(address)) throw new Error('Enter the email address messages are sent from.');
  const cfg = {
    provider: 'smtp', host, port, security, username, password, account: username || address, address,
    sender_name: senderName(input.sender_name, defaultSender(t)), reply_to: optionalEmail(input.reply_to, 'replies'),
    saved_by: user.name, saved_at: clock.iso(),
  };
  try { await smtpTransport(cfg).verify(); } catch (e) { throw new Error(smtpError(e)); }
  write(t, cfg);
  writeStatus(t, { last_error: null, last_error_at: null });
  return { replaced: !!old, ...view(cfg) };
}

// Sender name and reply address can change without signing in again.
function updateDetails(t, user, input) {
  const cfg = stored(t);
  if (!cfg) throw new Error('Connect email first.');
  const next = { ...cfg, sender_name: senderName(input.sender_name, defaultSender(t)), reply_to: optionalEmail(input.reply_to, 'replies'), saved_by: user.name, saved_at: clock.iso() };
  write(t, next);
  return view(next);
}
function remove(t) {
  db.run('DELETE FROM meta WHERE k=?', metaKey(t));
  db.run('DELETE FROM meta WHERE k=?', statusKey(t));
}

// ---- building and sending one message
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Plain-text body to simple, safe HTML: paragraphs, and links that can be clicked.
function simpleHtml(text) {
  const para = String(text).trim().split(/\n{2,}/).map((p) => esc(p).replace(/\n/g, '<br>')
    .replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?)])/g, '<a href="$1">$1</a>'));
  return `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:15px;line-height:1.6;color:#1f2933;max-width:600px">${para.map((p) => `<p style="margin:0 0 14px">${p}</p>`).join('')}</div>`;
}
const fromHeader = (cfg) => `"${cfg.sender_name.replace(/"/g, '')}" <${cfg.address}>`;

async function graphSend(t, cfg, msg) {
  const accessKey = await accessToken(t, cfg);
  const path = cfg.shared_mailbox ? `users/${encodeURIComponent(cfg.shared_mailbox)}` : 'me';
  const message = {
    subject: msg.subject,
    body: { contentType: 'HTML', content: msg.html },
    toRecipients: [{ emailAddress: { address: msg.to } }],
    from: { emailAddress: { address: cfg.address, name: cfg.sender_name } },
  };
  if (cfg.reply_to) message.replyTo = [{ emailAddress: { address: cfg.reply_to } }];
  const r = await call(`https://graph.microsoft.com/v1.0/${path}/sendMail`, {
    method: 'POST', headers: { authorization: `Bearer ${accessKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ message, saveToSentItems: true }),
  }, 'Microsoft');
  if (r.status === 202 || r.ok) return `graph:${clock.iso()}`;
  const code = r.body.error?.code || '';
  if (code === 'ErrorSendAsDenied' || (r.status === 403 && cfg.shared_mailbox)) throw new Error(`${cfg.account} is not allowed to send as ${cfg.shared_mailbox}. Ask your Microsoft 365 administrator to give it "Send As" permission on that mailbox.`);
  if (r.status === 401) throw new Error('Microsoft rejected the saved connection. Connect your email again.');
  if (code === 'MailboxNotEnabledForRESTAPI' || code === 'ResourceNotFound') throw new Error('Microsoft could not find an Outlook mailbox for this account.');
  throw new Error(`Microsoft did not send the email: ${r.body.error?.message || `HTTP ${r.status}`}.`);
}
async function rawMessage(cfg, msg) {
  if (!nodemailer) throw new Error('Building emails needs the nodemailer package on this server.');
  const built = await nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'windows' })
    .sendMail({ from: fromHeader(cfg), to: msg.to, replyTo: cfg.reply_to || undefined, subject: msg.subject, text: msg.text, html: msg.html });
  return built.message;
}
async function gmailSend(t, cfg, msg) {
  const accessKey = await accessToken(t, cfg);
  const raw = (await rawMessage(cfg, msg)).toString('base64url');
  const r = await call('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST', headers: { authorization: `Bearer ${accessKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ raw }),
  }, 'Google');
  if (r.ok) return `gmail:${r.body.id || clock.iso()}`;
  if (r.status === 401) throw new Error('Google rejected the saved connection. Connect your email again.');
  throw new Error(`Gmail did not send the email: ${r.body.error?.message || `HTTP ${r.status}`}.`);
}
async function smtpSend(cfg, msg) {
  try {
    const info = await smtpTransport(cfg).sendMail({ from: fromHeader(cfg), to: msg.to, replyTo: cfg.reply_to || undefined, subject: msg.subject, text: msg.text, html: msg.html });
    return `smtp:${info.messageId || clock.iso()}`;
  } catch (e) { throw new Error(smtpError(e)); }
}

// Sends through the company's own connection. Returns null when the company has none, so the
// caller can fall back. Failures are recorded for the Connections page and then thrown.
async function send(t, { to, subject, text, html }) {
  const cfg = stored(t);
  if (!cfg) return null;
  const msg = { to: cleanEmail(to), subject: String(subject || '').replace(/[\r\n]+/g, ' '), text: String(text || ''), html: html || simpleHtml(text || '') };
  if (!EMAIL_RE.test(msg.to)) throw new Error(`"${to}" is not a valid email address.`);
  try {
    const ref = cfg.provider === 'microsoft' ? await graphSend(t, cfg, msg) : cfg.provider === 'google' ? await gmailSend(t, cfg, msg) : await smtpSend(cfg, msg);
    writeStatus(t, { last_sent_at: clock.iso(), last_error: null, last_error_at: null });
    return ref;
  } catch (e) {
    writeStatus(t, { last_error: e.message, last_error_at: clock.iso() });
    throw e;
  }
}

async function sendTest(t, to) {
  const cfg = stored(t);
  if (!cfg) throw new Error('Connect email first.');
  const company = db.get('SELECT name FROM tenants WHERE id=?', t)?.name || 'your company';
  const text = `This is a test email from Aegis for ${company}.\n\nDocument requests and reminders to workers will come from ${cfg.sender_name} <${cfg.address}>.${cfg.reply_to ? ` When workers reply, their answers go to ${cfg.reply_to}.` : ' When workers reply, their answers come back to this mailbox.'}\n\nIf this arrived in your junk or spam folder, mark it as not junk so future requests reach the inbox.`;
  const ref = await send(t, { to, subject: `Test email from ${cfg.sender_name}`, text });
  return { ok: true, to: cleanEmail(to), from: cfg.address, ref };
}

// What the Connections page shows. Never includes a password or key.
function view(cfg) {
  return {
    provider: cfg.provider, provider_label: PROVIDERS[cfg.provider]?.label || cfg.provider,
    address: cfg.address, account: cfg.account, sender_name: cfg.sender_name, reply_to: cfg.reply_to || null,
    shared_mailbox: cfg.shared_mailbox || null,
    ...(cfg.provider === 'smtp' ? { host: cfg.host, port: cfg.port, security: cfg.security, username: cfg.username || null, has_password: !!cfg.password } : {}),
    saved_by: cfg.saved_by || null, saved_at: cfg.saved_at || null,
  };
}
function status(t) {
  const cfg = stored(t), st = readStatus(t);
  return {
    connected: !!cfg, ...(cfg ? view(cfg) : {}),
    last_sent_at: cfg ? st.last_sent_at || null : null,
    last_error: st.last_error || null, last_error_at: st.last_error_at || null,
    available: available(), redirect_uri: redirectUri(), default_sender: defaultSender(t),
  };
}
// A sign-in that failed after leaving Aegis is shown on the Connections page.
const recordSignInError = (t, message) => writeStatus(t, { last_error: message, last_error_at: clock.iso() });

module.exports = {
  status, connected, startSignIn, finishSignIn, ownsState, saveSmtp, updateDetails, remove, send, sendTest, recordSignInError, simpleHtml, available, hooks, PROVIDERS,
  // shared with server/sso.js
  appKeys, redirectUri, call, form, tokenError, cleanEmail,
};
