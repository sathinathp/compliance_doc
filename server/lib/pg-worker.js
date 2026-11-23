'use strict';
// Runs PostgreSQL queries in a worker thread so db.js can stay synchronous.
// The main thread writes a request into the shared buffer and waits; this
// worker runs it and writes the answer back. Every path must answer, or the
// main thread waits until its timeout.
const { parentPort, workerData } = require('node:worker_threads');
const { Client } = require('pg');

const { sab, connectionString, statementTimeoutMs } = workerData;
const int32 = new Int32Array(sab, 0, 4); // [state, length, status, reserved]
const uint8 = new Uint8Array(sab, 16);

let client = null, inTx = false, txBroken = false;
// The one-server lock belongs to a connection. After a reconnect it is taken again.
let lockSql = null;

async function connect() {
  const c = new Client({ connectionString, statement_timeout: statementTimeoutMs, connectionTimeoutMillis: 10000 });
  // Without this handler a dropped connection (for example a database restart) crashes the worker.
  c.on('error', (err) => {
    console.error('[db] PostgreSQL connection lost:', err.message);
    if (client === c) { client = null; if (inTx) txBroken = true; }
  });
  await c.connect();
  client = c;
  if (lockSql && !(await c.query(lockSql)).rows[0]?.ok) console.error('[db] Another Aegis server took the database lock while this one was reconnecting. Stop one of them.');
}

function answer(status, obj) {
  let encoded = Buffer.from(JSON.stringify(obj), 'utf8');
  if (encoded.length > uint8.length) {
    status = 1;
    encoded = Buffer.from(JSON.stringify({ error: `Query result is too large (${encoded.length} bytes). Add a LIMIT or page through the rows.` }), 'utf8');
  }
  int32[1] = encoded.length;
  int32[2] = status;
  uint8.set(encoded);
  Atomics.store(int32, 0, 2); // state 2 = response ready
  Atomics.notify(int32, 0, 1);
}

async function init() {
  try {
    await connect();
    int32[2] = 0; // ready
  } catch (err) {
    console.error('[db] PostgreSQL worker connection error:', err.message);
    int32[2] = 1; // error
  }
  Atomics.store(int32, 0, 1);
  Atomics.notify(int32, 0, 1);
}

parentPort.on('message', async (cmd) => {
  if (cmd === 'close') {
    if (client) await client.end().catch(() => {});
    process.exit(0);
  }
  try {
    const { type, sql, params } = JSON.parse(Buffer.from(uint8.buffer, 16, int32[1]).toString('utf8'));
    const word = /^\s*(BEGIN|COMMIT|ROLLBACK)\b/i.exec(sql)?.[1]?.toUpperCase();
    // If the connection dropped inside a transaction, the database already rolled that work back.
    // Refuse everything until db.tx sends ROLLBACK, so later statements are not saved as half a change.
    if (txBroken) {
      if (word === 'ROLLBACK') { txBroken = false; inTx = false; return answer(0, { data: { ok: true } }); }
      throw new Error('The database connection was lost during a transaction, so the change was not saved.');
    }
    // Reconnect if the connection dropped since the last query.
    if (!client) await connect();
    if (word === 'BEGIN') inTx = true;
    else if (word === 'COMMIT' || word === 'ROLLBACK') inTx = false;
    if (type === 'exec') {
      await client.query(sql);
      return answer(0, { data: { ok: true } });
    }
    const res = await client.query(sql, params);
    if (/^SELECT pg_try_advisory_lock\(/.test(sql) && res.rows[0]?.ok) lockSql = sql;
    // pg returns bigint counts and sums as strings; the app expects numbers for these aliases.
    const rows = res.rows.map((row) => {
      const out = { ...row };
      for (const [k, v] of Object.entries(out)) {
        if ((k === 'n' || k === 's' || k === 'm') && typeof v === 'string' && /^-?\d+$/.test(v)) out[k] = Number(v);
      }
      return out;
    });
    answer(0, { data: { rows, rowCount: res.rowCount } });
  } catch (err) {
    answer(1, { error: err.message });
  }
});

init();
