'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const db = require('../server/lib/db');
const { checkPassword } = require('../server/lib/util');
const { provisionBluebix } = require('../server/lib/provision-bluebix');
const { verifyAudit } = require('../server/platform');

test('pilot provisioning creates an empty workspace once and preserves an existing administrator', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-pilot-'));
  process.env.NODE_ENV = 'test';
  delete process.env.AEGIS_TEST_DATABASE_URL;
  db.open(path.join(dir, 'pilot.db'));
  try {
    const admin = { email: 'pilot-admin@example.test', name: 'Pilot Admin', password: 'example-password-for-tests' };
    assert.throws(() => provisionBluebix({ ...admin, email: 'admin@bluebix.demo' }), /real pilot administrator/);
    assert.throws(() => provisionBluebix({ ...admin, password: 'weak' }), /at least 16/);
    assert.equal(db.get('SELECT id FROM tenants'), undefined);
    assert.equal(provisionBluebix(admin), true);
    const tenant = db.get('SELECT * FROM tenants WHERE slug=?', 'bluebix');
    assert.equal(tenant.kind, 'internal_pilot');
    assert.equal(JSON.parse(tenant.channel_json).type, 'outbox');
    assert.equal(db.get('SELECT id FROM workers'), undefined);
    assert.equal(db.get('SELECT pack_key FROM tenant_packs'), undefined);
    assert.ok(verifyAudit(tenant.id).ok);
    const account = db.get('SELECT * FROM users WHERE tenant_id=?', tenant.id);
    assert.ok(checkPassword(admin.password, account.password_hash));
    assert.equal(provisionBluebix({ ...admin, password: undefined }), false);
    assert.equal(db.get('SELECT password_hash FROM users WHERE id=?', account.id).password_hash, account.password_hash);
    assert.throws(() => provisionBluebix({ ...admin, email: 'other-admin@example.test' }), /already exists/);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
