'use strict';
const crypto = require('node:crypto');
const db = require('./db'), sandbox = require('./sandbox');
const { clock, hashPassword, id, sha256, token } = require('./util');
const { audit, HttpError } = require('../platform');

const CONFIRM_EMAIL = 'Confirm your work email first.';
// Sign-up is on in the sandbox, or when AEGIS_SIGNUP=1. In production the startup checks also
// require server email, so the confirmation email can really be sent.
// Where the confirmation email goes:
//   sandbox  the pretend inbox inside the sandbox
//   email    a real email, through the server's email service (Resend or SMTP in .env)
//   local    this computer has no email set up (never in production): the link is printed in the
//            terminal running Aegis and kept in a local test inbox
const serverEmail = () => !!process.env.RESEND_API_KEY || !!process.env.SMTP_HOST;
const enabled = () => sandbox.isActive() || (process.env.AEGIS_SIGNUP === '1' && (process.env.NODE_ENV !== 'production' || serverEmail()));
const delivery = () => (sandbox.isActive() ? 'sandbox' : serverEmail() ? 'email' : 'local');
const verification = (t) => db.get('SELECT * FROM workspace_verifications WHERE tenant_id=?', t);
const pending = (t) => !!db.get('SELECT 1 AS x FROM workspace_verifications WHERE tenant_id=? AND verified_at IS NULL', t);
function requireVerified(t) {
  if (pending(t)) throw new HttpError(403, CONFIRM_EMAIL);
}

function createWorkspace({ orgName, adminName, email, password, slug, kind = 'customer' }) {
  return db.tx(() => {
    if (db.get('SELECT id FROM users WHERE lower(email)=?', email)) throw new HttpError(409, 'An account already exists for this email. Sign in instead.');
    const now = clock.iso(), tenantId = id('ten'), userId = id('usr');
    const base = slug || orgName.normalize('NFKD').toLowerCase().replace(/\p{M}/gu, '').replace(/[^a-z0-9]+/g, '-').slice(0, 60).replace(/^-|-$/g, '') || 'workspace';
    for (let n = 1; ; n++) {
      const candidate = n === 1 ? base : `${base}-${n}`;
      const inserted = db.run('INSERT INTO tenants(id,slug,name,kind,webhook_secret,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(slug) DO NOTHING',
        tenantId, candidate, orgName, kind, crypto.randomBytes(24).toString('hex'), now);
      if (inserted.changes) break;
      if (slug) throw new HttpError(409, 'The requested workspace already exists.');
    }
    const user = db.run("INSERT INTO users(id,tenant_id,email,name,role,password_hash,created_at) VALUES(?,?,?,?,'admin',?,?) ON CONFLICT(email) DO NOTHING",
      userId, tenantId, email, adminName, hashPassword(password), now);
    if (!user.changes) throw new HttpError(409, 'An account already exists for this email. Sign in instead.');
    db.insert('schedules', { id: id('sch'), tenant_id: tenantId, kind: 'digest', cadence: 'daily', next_run_at: new Date(clock.now().getTime() + 864e5).toISOString(), enabled: 1 });
    audit(tenantId, 'WORKSPACE_CREATED', orgName, 'Created the workspace and its first administrator.');
    return { tenantId, userId };
  });
}

// Loopback sandbox only. The database stores hashes, and each account sees only its own test email.
const inbox = new Map();
function prepareEmail(tenantId, userId, { initial = false } = {}) {
  const raw = token(), now = Date.now();
  const requestedAt = new Date(now).toISOString(), expiresAt = new Date(now + 30 * 60e3).toISOString();
  if (initial) {
    db.insert('workspace_verifications', { tenant_id: tenantId, user_id: userId, token_hash: sha256(raw), expires_at: expiresAt, requested_at: requestedAt });
  } else {
    const result = db.run('UPDATE workspace_verifications SET token_hash=?, expires_at=?, requested_at=? WHERE tenant_id=? AND user_id=? AND verified_at IS NULL AND requested_at<=?',
      sha256(raw), expiresAt, requestedAt, tenantId, userId, new Date(now - 30e3).toISOString());
    if (!result.changes) throw new HttpError(429, 'Wait 30 seconds before requesting another verification email.');
  }
  return { raw, expiresAt };
}
function deliverTestEmail(userId, message) {
  const now = new Date().toISOString();
  for (const [key, mail] of inbox) if (mail.expiresAt <= now) inbox.delete(key);
  inbox.set(userId, message);
}
// Sends (or keeps) the confirmation email. Returns { sent: true } or { sent: false, error }.
async function sendConfirmation(t, userId, message) {
  const mode = delivery();
  if (mode !== 'email') {
    deliverTestEmail(userId, message);
    if (mode === 'local') console.log(`[sign-up] No email is set up on this computer. Confirmation link: ${base()}/#verify-email/${message.raw}`);
    return { sent: true };
  }
  const user = db.get('SELECT name,email FROM users WHERE id=?', userId), org = db.get('SELECT name FROM tenants WHERE id=?', t);
  const first = String(user.name).split(/\s+/)[0];
  const text = `Hi ${first},\n\nConfirm your email to finish setting up ${org.name} in Aegis:\n\n${base()}/#verify-email/${message.raw}\n\nThe link works for 30 minutes. Until you confirm, you can add workers and run checks, but Aegis won't send anything to your people.\n\nIf you didn't create this workspace, you can ignore this email.`;
  try {
    await require('../channels').sendSystemEmail(user.email, 'Confirm your email for Aegis', text);
    return { sent: true };
  } catch (e) {
    console.error('[sign-up] confirmation email failed:', e.message);
    return { sent: false, error: 'We couldn’t send the confirmation email. Try again in a minute.' };
  }
}
const base = () => (process.env.AEGIS_BASE_URL || `http://localhost:${process.env.PORT || 4100}`).replace(/\/+$/, '');

function testEmail(t, userId) {
  if (delivery() === 'email') return { link: null };
  const message = inbox.get(userId);
  const state = verification(t);
  return message && state?.user_id === userId && state.token_hash === sha256(message.raw) && message.expiresAt > new Date().toISOString()
    ? { link: `/#verify-email/${message.raw}` } : { link: null };
}
function verifyEmail(t, user, raw) {
  if (typeof raw !== 'string' || !/^[\w-]{43}$/.test(raw)) throw new HttpError(410, 'This link has expired or already been used. Request a new verification email.');
  db.tx(() => {
    const now = new Date().toISOString();
    const result = db.run('UPDATE workspace_verifications SET verified_at=?, token_hash=NULL, expires_at=NULL WHERE tenant_id=? AND user_id=? AND token_hash=? AND expires_at>? AND verified_at IS NULL',
      now, t, user.id, sha256(raw), now);
    if (!result.changes) throw new HttpError(410, 'This link has expired or already been used. Request a new verification email.');
    audit(t, 'EMAIL_VERIFIED', user.name, 'Confirmed the first administrator’s work email.', user);
  });
  inbox.delete(user.id);
}

module.exports = { enabled, delivery, sendConfirmation, verification, pending, requireVerified, CONFIRM_EMAIL, createWorkspace, prepareEmail, deliverTestEmail, testEmail, verifyEmail };
