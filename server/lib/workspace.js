'use strict';
const crypto = require('node:crypto');
const db = require('./db'), sandbox = require('./sandbox');
const { clock, hashPassword, id, sha256, token } = require('./util');
const { audit, HttpError } = require('../platform');

const CONFIRM_EMAIL = 'Confirm your work email first.';
const enabled = () => sandbox.isActive() || (process.env.NODE_ENV === 'test' && process.env.AEGIS_SIGNUP === '1');
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
function testEmail(t, userId) {
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

module.exports = { enabled, verification, pending, requireVerified, CONFIRM_EMAIL, createWorkspace, prepareEmail, deliverTestEmail, testEmail, verifyEmail };
