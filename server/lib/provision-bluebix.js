'use strict';
const db = require('./db');
const { clock, hashPassword, id } = require('./util');
const { audit } = require('../platform');

function provisionBluebix({ email, name, password }) {
  email = String(email || '').trim().toLowerCase();
  name = String(name || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.endsWith('.demo') || !name || name.length > 120) {
    throw new Error('Set a real pilot administrator name and work email.');
  }
  return db.tx(() => {
    const tenant = db.get('SELECT id, kind FROM tenants WHERE slug=?', 'bluebix');
    const account = db.get('SELECT id, tenant_id, role FROM users WHERE lower(email)=?', email);
    if (tenant) {
      if (tenant.kind === 'internal_pilot' && account?.tenant_id === tenant.id && account.role === 'admin'
        && !db.get("SELECT id FROM users WHERE tenant_id=? AND lower(email) LIKE '%.demo'", tenant.id)) {
        return false;
      }
      throw new Error('The Bluebix workspace already exists. Use its existing administrator or a separate pilot database.');
    }
    if (account) throw new Error('The requested work email is already in use.');
    if (typeof password !== 'string' || password.length < 16) throw new Error('Set a generated pilot administrator password with at least 16 characters.');

    const now = clock.iso(), tenantId = id('ten');
    db.insert('tenants', { id: tenantId, slug: 'bluebix', name: 'Bluebix Healthcare', kind: 'internal_pilot', created_at: now });
    db.insert('users', { id: id('usr'), tenant_id: tenantId, email, name, role: 'admin', password_hash: hashPassword(password), created_at: now });
    db.insert('schedules', { id: id('sch'), tenant_id: tenantId, kind: 'digest', cadence: 'daily', next_run_at: new Date(clock.now().getTime() + 864e5).toISOString(), enabled: 1 });
    audit(tenantId, 'WORKSPACE_CREATED', 'Bluebix Healthcare', 'Created the Bluebix pilot workspace and its initial administrator.');
    return true;
  });
}

module.exports = { provisionBluebix };
