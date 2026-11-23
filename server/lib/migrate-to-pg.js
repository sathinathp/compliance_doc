'use strict';
const { DatabaseSync } = require('node:sqlite');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const envFile = path.join(__dirname, '..', '..', '.env');
if (process.loadEnvFile && fs.existsSync(envFile)) process.loadEnvFile(envFile);

const sqlitePath = path.join(__dirname, '..', '..', 'data', 'aegis.db');
if (!fs.existsSync(sqlitePath)) {
  console.log('No SQLite DB found at', sqlitePath);
  process.exit(0);
}

const db = new DatabaseSync(sqlitePath);
const tables = [
  'meta', 'tenants', 'users', 'entities', 'facilities', 'workers', 'assignments',
  'packs', 'tenant_packs', 'control_changes', 'cases', 'case_notes', 'evidence',
  'evaluations', 'actions', 'approvals', 'messages', 'submission_tokens', 'events',
  'jobs', 'schedules', 'connectors', 'imports', 'dashboards', 'notices',
  'coworker_policies', 'coworker_chats', 'chat_messages', 'baselines', 'manual_support', 'counters', 'audit_log'
];

let sqlDump = 'BEGIN;\n';

for (const table of tables) {
  try {
    const rows = db.prepare(`SELECT * FROM ${table}`).all();
    if (rows.length === 0) continue;
    
    // For audit_log, disable trigger temporarily during seed import
    if (table === 'audit_log') {
      sqlDump += `ALTER TABLE audit_log DISABLE TRIGGER USER;\n`;
    }
    
    for (const row of rows) {
      const keys = Object.keys(row);
      const cols = keys.map(k => `"${k}"`).join(', ');
      const vals = keys.map(k => {
        const val = row[k];
        if (val === null || val === undefined) return 'NULL';
        if (typeof val === 'number') return val;
        // Escape single quotes for SQL
        return `'${String(val).replace(/'/g, "''")}'`;
      }).join(', ');
      
      sqlDump += `INSERT INTO "${table}" (${cols}) VALUES (${vals}) ON CONFLICT DO NOTHING;\n`;
    }
    
    if (table === 'audit_log') {
      sqlDump += `ALTER TABLE audit_log ENABLE TRIGGER USER;\n`;
      sqlDump += `SELECT setval(pg_get_serial_sequence('audit_log', 'seq'), COALESCE(MAX(seq), 1)) FROM audit_log;\n`;
    }
  } catch (err) {
    console.warn(`Skipping table ${table}:`, err.message);
  }
}

sqlDump += 'COMMIT;\n';

const dumpFile = path.join(__dirname, '..', '..', 'data', 'pg_seed.sql');
fs.writeFileSync(dumpFile, sqlDump, 'utf8');
console.log('Generated SQL dump at', dumpFile, 'with length:', sqlDump.length);

// Execute with psql. psql reads PGHOST, PGPORT, PGUSER, PGPASSWORD and PGDATABASE from the
// environment (loaded from .env above), so no connection details live in this file.
// Set PSQL_PATH if psql is not on PATH, for example C:\Program Files\PostgreSQL\18\bin\psql.exe.
const psqlBin = process.env.PSQL_PATH || 'psql';
const target = process.env.PGUSER && process.env.PGDATABASE ? [] : process.env.DATABASE_URL ? [process.env.DATABASE_URL] : null;
if (!target) {
  console.error('Set PGHOST, PGUSER, PGPASSWORD and PGDATABASE (or DATABASE_URL) in .env first.');
  process.exit(1);
}
const res = spawnSync(psqlBin, [...target, '-v', 'ON_ERROR_STOP=1', '-f', dumpFile], { env: process.env, encoding: 'utf8' });
if (res.error) { console.error(`Could not run ${psqlBin}: ${res.error.message}. Set PSQL_PATH to the full path of psql.`); process.exit(1); }

console.log('psql stdout:', res.stdout ? res.stdout.slice(0, 300) : '');
if (res.stderr) console.error('psql stderr:', res.stderr.slice(0, 300));
if (res.status === 0) console.log('Successfully seeded PostgreSQL database!');
else console.error('psql exited with status', res.status);

