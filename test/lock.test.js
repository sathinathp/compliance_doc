'use strict';
// One server per database: a second server process on the same database must refuse to start.
const test = require('node:test'), assert = require('node:assert'), fs = require('fs'), os = require('os'), path = require('path');
const { spawnSync } = require('child_process');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-'));
process.env.NODE_ENV = 'test';
process.env.AEGIS_DATA = dir;
const db = require('../server/lib/db');
const file = path.join(dir, 'aegis.db');
const repo = path.join(__dirname, '..');

// Tries to take the lock from a separate process and prints the answer.
const tryInOtherProcess = () => spawnSync(process.execPath, ['--no-warnings', '-e', `
  process.env.NODE_ENV = 'test'; process.env.AEGIS_DATA = ${JSON.stringify(dir)};
  const db = require(${JSON.stringify(path.join(repo, 'server/lib/db'))});
  db.open(${JSON.stringify(file)}); console.log(db.lockServer() ? 'locked' : 'refused');`], { encoding: 'utf8' }).stdout.trim().split('\n').pop();

test.after(() => { db.close(); try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch {} });

test('a second server on the same database is refused; a lock left by a crashed server is not', () => {
  db.open(file);
  assert.equal(db.lockServer(), true, 'the first server takes the lock');
  assert.equal(db.lockServer(), true, 'asking again from the same server is fine');
  assert.equal(tryInOtherProcess(), 'refused', 'a second server process is refused');
  // A server that crashed leaves its lock file behind, naming a process that no longer exists.
  fs.writeFileSync(`${file}.lock`, '999999');
  assert.equal(tryInOtherProcess(), 'locked', 'a stale lock from a crashed server does not block a restart');
});
