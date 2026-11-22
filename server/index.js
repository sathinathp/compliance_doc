'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const sandbox = require('./lib/sandbox');
const sandboxRequested = require.main === module && process.argv.includes('--sandbox');
const provisionRequested = require.main === module && process.argv.includes('--provision-bluebix');
if (sandboxRequested && provisionRequested) {
  console.error('Start the sandbox and provision the pilot using separate commands.');
  process.exit(1);
}
if (sandboxRequested) sandbox.configure();
else {
  try { if (process.loadEnvFile && fs.existsSync(path.join(__dirname, '..', '.env'))) process.loadEnvFile(path.join(__dirname, '..', '.env')); } catch {}
}
const DATA = process.env.AEGIS_DATA = process.env.AEGIS_DATA || path.join(__dirname, '..', 'data');
const { isProd, productionProblems } = require('./lib/config');
// Demo mode is on by default for local development and off by default in production.
process.env.AEGIS_DEMO = process.env.AEGIS_DEMO ?? (isProd() ? '0' : '1');
if (provisionRequested && (!isProd() || process.env.AEGIS_DEMO !== '0')) {
  console.error('Provision the Bluebix pilot with NODE_ENV=production and AEGIS_DEMO=0.');
  process.exit(1);
}
if (isProd()) {
  const problems = productionProblems();
  if (problems.length) {
    console.error('Aegis will not start in production until these settings are fixed:\n' + problems.map((x) => `  - ${x}`).join('\n'));
    process.exit(1);
  }
}
fs.mkdirSync(DATA, { recursive: true });
const U = require('./lib/util'), db = require('./lib/db');
const secretFile = path.join(DATA, '.secret');
if (!process.env.AEGIS_SECRET && !fs.existsSync(secretFile)) fs.writeFileSync(secretFile, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
U.setSecret(process.env.AEGIS_SECRET || fs.readFileSync(secretFile, 'utf8'));
try { db.open(path.join(DATA, 'aegis.db')); } catch (e) { console.error(e.message); process.exit(1); }
const P = require('./platform'), R = require('./registry'), E = require('./engine'), C = require('./connectors'), V = require('./views'), channels = require('./channels'), mock = require('./mock-hrms'), { routes } = require('./routes'), { seed } = require('./seed');
const { j, clock } = U;

P.on('process_event', (t, p) => C.processHrmsEvent(t, p));
P.on('evaluate_subject', (t, p) => E.evaluateById(t, p.type, p.id, p.trigger));
P.on('evaluate_tenant', (t, p) => E.evaluateTenant(t, p.trigger));
P.on('send_action', (t, p) => E.sendAction(t, p));
P.on('run_reminders', (t) => E.runReminders(t));
P.on('digest', async (t) => {
  const tenant = db.get('SELECT * FROM tenants WHERE id=?', t);
  const destination = j(tenant.channel_json, {}).channel || '#compliance-alerts';
  const via = await channels.post(tenant, destination, 'Compliance digest', V.digestText(t));
  if (via === 'slack') P.audit(t, 'DIGEST_SENT', 'Digest', 'Scheduled digest posted to Slack.');
  else P.audit(t, 'DIGEST_OUTBOX', 'Digest', 'Scheduled digest saved to the Aegis outbox.');
});
P.on('sync_connector', (t, p) => C.syncConnector(t, p.id));

function tick() {
  const today = clock.today();
  db.run('DELETE FROM sessions WHERE expires_at<?', new Date().toISOString());
  for (const tn of db.all('SELECT id FROM tenants')) {
    // Daily jobs: `once` stops them from running again every minute after they finish.
    P.enqueue(tn.id, 'evaluate_tenant', { trigger: 'scheduled_check' }, { dedupe: `daily:${tn.id}:${today}`, once: true });
    // Reminders run every minute on purpose: each case has its own next_reminder_at time.
    P.enqueue(tn.id, 'run_reminders', {}, { dedupe: `rem:${tn.id}` });
    for (const c of db.all("SELECT id FROM connectors WHERE tenant_id=? AND type='hrms' AND status!='disabled'", tn.id)) P.enqueue(tn.id, 'sync_connector', { id: c.id }, { dedupe: `sync:${c.id}:${today}`, once: true });
    for (const s of db.all('SELECT * FROM schedules WHERE tenant_id=? AND enabled=1 AND next_run_at<=?', tn.id, clock.iso())) {
      P.enqueue(tn.id, s.kind, {}, { dedupe: `${s.id}:${s.next_run_at}` });
      db.update('schedules', s.id, { next_run_at: new Date(clock.now().getTime() + (s.cadence === 'weekly' ? 7 : 1) * 864e5).toISOString() });
    }
  }
}
// The main workspace and the worker upload page are served from public/.
const PUB = path.join(__dirname, '..', 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.webp': 'image/webp', '.woff': 'font/woff', '.woff2': 'font/woff2' };
const HEADERS = { 'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'", 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY', 'permissions-policy': 'camera=(), microphone=(), geolocation=()' };
if (/^https:/.test(process.env.AEGIS_BASE_URL || '')) HEADERS['strict-transport-security'] = 'max-age=31536000; includeSubDomains';
function serve(res, file, root = PUB) {
  let fp = path.resolve(root, file);
  if (!fp.startsWith(root + path.sep)) { res.writeHead(404).end('Not found'); return; }
  if (!fs.existsSync(fp) || fs.statSync(fp).isDirectory()) { res.writeHead(404).end('Not found'); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(fp)] || 'application/octet-stream', 'cache-control': 'no-cache' });
  fs.createReadStream(fp).pipe(res);
}
// Hides secret path parts (worker upload tokens) in logs.
const logPath = (p) => p.replace(/^(\/(?:api\/)?submit\/)[^/]+/, '$1<token>');
function logRequest(req, status, started) {
  if (process.env.NODE_ENV === 'test' && !process.env.AEGIS_LOG_REQUESTS) return;
  console.log(`${new Date().toISOString()} ${req.method} ${logPath(new URL(req.url, 'http://x').pathname)} ${status} ${Date.now() - started}ms`);
}
const readBody = (req) => new Promise((ok, no) => { const c = []; let n = 0; req.on('data', (d) => { n += d.length; if (n > 16 * 1024 * 1024) { no(new P.HttpError(413, 'Request too large.')); req.destroy(); } else c.push(d); }); req.on('end', () => ok(Buffer.concat(c))); req.on('error', no); });
function send(res, status, obj) { if (res.headersSent) return; res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); }

let shuttingDown = false;
const server = http.createServer(async (req, res) => {
  for (const [k, v] of Object.entries(HEADERS)) res.setHeader(k, v);
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/api/')) { const started = Date.now(); res.on('finish', () => logRequest(req, res.statusCode, started)); }
  try {
    if (sandbox.rejectsHost(req)) return send(res, 403, { error: 'The sandbox is available on localhost.' });
    if (sandbox.blocksIntegration(req.method, url.pathname)) {
      return send(res, 403, { error: 'The sandbox uses the sample HRMS and the local message outbox.' });
    }
    // For load balancers and uptime checks. No sign-in needed, and it reveals nothing about tenants.
    if (url.pathname === '/healthz') {
      let dbOk = false;
      try { dbOk = db.get('SELECT 1 AS ok')?.ok == 1; } catch {}
      const ok = dbOk && !shuttingDown;
      return send(res, ok ? 200 : 503, { ok, database: dbOk ? db.mode() : 'unavailable', shutting_down: shuttingDown });
    }
    if (url.pathname.startsWith('/mock-hrms/') && process.env.AEGIS_DEMO === '1') return mock.route(req, res, url);
    if (url.pathname.startsWith('/submit/')) return serve(res, 'submit.html', PUB);
    if (/^\/worker-assets\/(?:tokens\.css|styles\.css|surfaces\.css|inter\.woff2|submit\.js)$/.test(url.pathname)) {
      return serve(res, url.pathname.slice('/worker-assets/'.length), PUB);
    }
    if (!url.pathname.startsWith('/api/')) return serve(res, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
    const route = routes.find((r) => r.m === req.method && r.re.test(url.pathname));
    if (!route) return send(res, 404, { error: 'Not found' });
    const m = route.re.exec(url.pathname), p = {};
    route.keys.forEach((k, i) => { p[k] = decodeURIComponent(m[i + 1]); });
    const raw = req.method === 'GET' ? Buffer.alloc(0) : await readBody(req);
    let body = {};
    if (raw.length) { try { body = JSON.parse(raw); } catch { throw new P.HttpError(400, 'Invalid JSON.'); } }
    const cookiePrefix = `${sandbox.sessionCookie()}=`;
    const sid = (req.headers.cookie || '').split(';').map((c) => c.trim()).find((c) => c.startsWith(cookiePrefix))?.slice(cookiePrefix.length);
    const ctx = { req, res, p, q: url.searchParams, body, raw, sid };
    if (!route.o.public) {
      const s = sid && db.get('SELECT * FROM sessions WHERE token_hash=? AND expires_at>?', U.sha256(sid), new Date().toISOString());
      const u = s && db.get('SELECT * FROM users WHERE id=?', s.user_id);
      if (!u) throw new P.HttpError(401, 'Please sign in.');
      if (req.method !== 'GET' && req.headers['x-aegis-client'] !== 'web') throw new P.HttpError(403, 'Missing client header.');
      ctx.user = { ...u, type: 'user' }; ctx.t = u.tenant_id;
    }
    const out = await route.fn(ctx);
    if (out !== res) send(res, 200, out);
  } catch (e) {
    if (!e.status) console.error(e);
    send(res, e.status || 500, { error: e.status ? e.message : 'Something went wrong on the server.' });
  }
});
async function start(port = +(process.env.PORT || 4100), { loop = true } = {}) {
  R.loadPacks(); P.recoverStale();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ port, host: sandbox.isActive() ? '127.0.0.1' : undefined }, () => {
      server.off('error', reject);
      resolve();
    });
  });
  process.env.ACTUAL_PORT = String(server.address().port);
  if (process.env.AEGIS_DEMO === '1') { mock.reset(); if (!db.get('SELECT 1 x FROM tenants')) await seed(); }
  // Slack Socket Mode connections, for companies that saved an app token.
  if (loop) require('./slack').startAll(require('./chat').handle);
  if (loop) { timers.push(setInterval(() => P.loop().catch(console.error), 1000), setInterval(() => { try { tick(); } catch (e) { console.error(e); } }, 60000)); tick(); }
  return server;
}
const timers = [];
// Stop taking new work, let the current job and requests finish, then close the database.
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[aegis] ${signal} received. Shutting down.`);
  timers.forEach(clearInterval);
  require('./slack').stopAll();
  setTimeout(() => { console.error('[aegis] Shutdown took too long. Exiting.'); process.exit(1); }, 20000).unref();
  await new Promise((ok) => server.close(ok));
  await P.idle();
  db.close();
  process.exit(0);
}
if (provisionRequested) {
  try {
    const { provisionBluebix } = require('./lib/provision-bluebix');
    const created = provisionBluebix({ email: process.env.AEGIS_PILOT_ADMIN_EMAIL, name: process.env.AEGIS_PILOT_ADMIN_NAME, password: process.env.AEGIS_PILOT_ADMIN_PASSWORD });
    console.log(created ? 'Bluebix pilot workspace created.' : 'Bluebix pilot workspace already provisioned.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally { db.close(); }
} else if (require.main === module) {
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (e) => console.error('[aegis] Unhandled promise rejection:', e));
  start()
    .then((s) => console.log(`Aegis running at http://localhost:${s.address().port}${isProd() ? ' (production)' : ''}${process.env.AEGIS_DEMO === '1' ? ' (demo mode)' : ''}`))
    .catch((e) => { console.error('[aegis] Could not start:', e.message); process.exit(1); });
}
module.exports = { start, server, tick };
