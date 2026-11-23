'use strict';
// Verifies the AI adapter against a local stand-in that enforces DeepSeek's documented rules.
const test = require('node:test'), assert = require('node:assert'), fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-ai-'));
process.env.NODE_ENV = 'test';
process.env.AEGIS_DATA = dir; process.env.AEGIS_DEMO = '1';
const KEY = 'sk-test-secret-1234';
let calls = [], reply = null, down = false, incompatible = false, declined = false, redirects = false, classification = 'coverage', guidance = null;
const classificationResult = () => ({ intent: classification, ...(guidance ? { guidance } : {}) });
const fake = http.createServer((req, res) => {
  let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => {
    const body = JSON.parse(b);
    const chat = req.url === '/v1/chat/completions';
    calls.push({ url: req.url, key: req.headers['x-api-key'], bearer: req.headers.authorization, body });
    const send = (s, o) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (down) return send(500, {});
    if (chat) {
      if (req.headers.authorization !== `Bearer ${KEY}`) return send(401, {});
      if (redirects) {
        res.writeHead(307, { location: '/unexpected' });
        return res.end();
      }
      if (incompatible) return send(200, { choices: [{ message: { content: 'Plain text only' } }] });
      const fn = body.tools[0].function;
      const input = fn.name === 'record_ping' ? { ok: !declined } : fn.name === 'classify' ? classificationResult() : reply;
      const tool = { type: 'function', function: { name: fn.name, arguments: JSON.stringify(input) } };
      const field = body.tool_choice === 'auto' ? 'toolCalls' : 'tool_calls';
      return send(200, { choices: [{ message: { [field]: [tool] } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
    }
    if (req.headers['x-api-key'] !== KEY) return send(401, { error: 'bad key' });
    if (body.tool_choice?.type === 'tool' && body.thinking?.type !== 'disabled') return send(400, { error: 'tool_choice tool not allowed in thinking mode' });
    if (body.messages[0].content.some((c) => c.type === 'document')) return send(400, { error: 'document not supported' });
    const name = body.tools[0].name, input = name === 'record_ping' ? { ok: true } : name === 'classify' ? classificationResult() : reply;
    send(200, { content: [{ type: 'tool_use', name, input }], usage: { input_tokens: 10, output_tokens: 5 } });
  });
});
const { start, server } = require('../server/index.js');
const db = require('../server/lib/db'), P = require('../server/platform');
let base, admin, hr;
async function login(email) {
  const r = await fetch(`${base}/api/login`, { method: 'POST', body: JSON.stringify({ email, password: 'demo1234' }) });
  const cookie = r.headers.get('set-cookie').split(';')[0];
  const call = async (m, p, b) => { const x = await fetch(base + p, { method: m, headers: { cookie, 'x-aegis-client': 'web' }, body: b ? JSON.stringify(b) : undefined }); return { status: x.status, text: await x.clone().text(), data: await x.json().catch(() => null) }; };
  return { get: (p) => call('GET', p), post: (p, b = {}) => call('POST', p, b) };
}
const up = (name, mime, bytes) => ({ name, mime, data: Buffer.from(bytes).toString('base64') });
test.before(async () => {
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.AEGIS_LLM_PROVIDER;
  await new Promise((ok) => fake.listen(0, ok));
  process.env.AEGIS_LLM_BASE_URL = `http://127.0.0.1:${fake.address().port}/anthropic/v1/messages`;
  await start(0, { loop: false }); base = `http://127.0.0.1:${server.address().port}`;
  admin = await login('sathinath@bluebix.demo'); hr = await login('hr@bluebix.demo');
});
test.after(() => { server.close(); fake.close(); try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch {} setTimeout(() => process.exit(0), 50); });

test('default DeepSeek address and model are the documented ones', () => {
  const { PROVIDERS } = require('../server/llm.js');
  assert.equal(PROVIDERS.deepseek.url, 'https://api.deepseek.com/anthropic/v1/messages');
  assert.equal(PROVIDERS.deepseek.model, 'deepseek-flash');
});
test('key setup: needs admin and approval, wrong key is not saved, key never comes back', async () => {
  assert.equal((await hr.post('/api/ai', { provider: 'deepseek', api_key: KEY, approved: true })).status, 403);
  assert.equal((await admin.post('/api/ai', { provider: 'deepseek', api_key: KEY })).status, 400);
  const bad = await admin.post('/api/ai', { provider: 'deepseek', api_key: 'wrong', approved: true });
  assert.equal(bad.status, 422); assert.match(bad.data.error, /rejected/);
  assert.equal((await admin.get('/api/ai')).data.configured, false);
  const ok = await admin.post('/api/ai', { provider: 'deepseek', api_key: KEY, approved: true });
  assert.equal(ok.status, 200); assert.equal(ok.data.key_hint, '••••1234'); assert.equal(ok.data.model, 'deepseek-flash');
  assert.ok(!ok.text.includes(KEY));
  for (const r of db.all('SELECT v FROM meta')) assert.ok(!r.v.includes(KEY), 'stored encrypted');
  assert.ok(!db.all('SELECT action FROM audit_log').some((a) => a.action.includes(KEY)));
  const c = calls.at(-1); assert.equal(c.url, '/anthropic/v1/messages'); assert.equal(c.key, KEY); assert.equal(c.body.model, 'deepseek-flash'); assert.deepEqual(c.body.thinking, { type: 'disabled' }); assert.equal(c.body.tool_choice.type, 'tool');
});
test('a photo is read by AI, but a person must still confirm it and the case stays open', async () => {
  const c = db.get("SELECT * FROM cases WHERE subject_name='Chloe Dubois' AND control_key='CTRL-ONB-HANDBOOK' AND closed_at IS NULL");
  reply = { doc_type: 'handbook_ack', holder_name: 'Chloe Dubois', confidence: 0.99 }; calls = [];
  const r = await admin.post('/api/evidence', { subject_type: 'worker', subject_id: c.subject_id, control_key: c.control_key, file: up('ack.png', 'image/png', [137, 80, 78, 71, 1]) });
  assert.equal(r.data.status, 'needs_review'); assert.ok(r.data.reasons.some((x) => /read by AI/.test(x)));
  const block = calls[0].body.messages[0].content.find((x) => x.type === 'image'); assert.equal(block.source.media_type, 'image/png');
  await P.drain();
  const d = (await admin.get(`/api/cases/${c.id}`)).data; assert.equal(d.state, 'in_review'); assert.equal(d.closed_at, null); assert.notEqual(d.evaluation.status, 'pass');
  assert.equal(db.get('SELECT holder_name h FROM evidence WHERE id=?', r.data.id).h, 'Chloe Dubois');
});
test('scanned PDF is not sent to DeepSeek and goes to review with a clear reason', async () => {
  const w = db.get("SELECT * FROM workers WHERE name LIKE 'Elena%'"); calls = [];
  const r = await admin.post('/api/evidence', { subject_type: 'worker', subject_id: w.id, control_key: 'CTRL-HC-ACLS', file: up('scan.pdf', 'application/pdf', [37, 80, 68, 70, 45, 1, 2, 3]) });
  assert.equal(calls.length, 0); assert.equal(r.data.status, 'needs_review'); assert.ok(r.data.reasons.some((x) => /scanned PDF/.test(x)));
});
test('provider outage falls back to review and stays visible', async () => {
  const w = db.get("SELECT * FROM workers WHERE name LIKE 'Maria%'"); down = true;
  const r = await admin.post('/api/evidence', { subject_type: 'worker', subject_id: w.id, control_key: 'CTRL-HC-ACLS', file: up('x.jpg', 'image/jpeg', [255, 216, 255, 9]) });
  down = false;
  assert.equal(r.status, 200); assert.equal(r.data.status, 'needs_review'); assert.ok(r.data.reasons.some((x) => /AI could not read/.test(x)));
  assert.match((await admin.get('/api/health')).data.ai_error.message, /returned an error/);
});
test('chat uses the provider for free-form questions, and answers come from records', async () => {
  calls = [];
  await admin.post('/api/chat', { text: 'What needs my approval?' });
  assert.equal(calls.length, 0, 'known questions stay local');
  const out = await admin.post('/api/chat', { text: 'where do we stand overall on the rules?' });
  assert.equal(calls.at(-1).body.tools[0].name, 'classify'); assert.match(out.data.reply, /applicable checks pass/);
  assert.equal((await admin.get('/api/health')).data.ai_error, null);
  assert.ok((await admin.get('/api/metrics')).data.llm_calls >= 2);
});

test('chat rejects an AI classification outside the read-only schema', async () => {
  classification = 'create_dashboard';
  try {
    const before = db.get('SELECT COUNT(*) AS n FROM dashboards').n;
    const out = await admin.post('/api/chat', { text: 'Could you handle that for me?' });
    assert.equal(out.status, 200);
    assert.match(out.data.reply, /AI provider couldn’t answer/);
    assert.equal(db.get('SELECT COUNT(*) AS n FROM dashboards').n, before);
  } finally {
    classification = 'coverage';
  }
});

test('the AI coworker uses recent user questions for guidance without sending record answers', async () => {
  const start = await admin.post('/api/chat', { text: 'Which credentials expire next month?', chat_id: null });
  classification = 'guidance';
  guidance = 'Checks applies the requirement. Evidence holds the supporting document. Cases tracks the work to resolve a gap.';
  calls = [];
  try {
    const message = 'Could you explain how those pieces fit together?';
    const follow = await admin.post('/api/chat', { text: message, chat_id: start.data.chat_id });
    assert.equal(follow.data.reply, guidance);
    assert.equal(calls.length, 1);
    const input = JSON.parse(calls[0].body.messages[0].content[0].text);
    assert.equal(input.current_message, message);
    assert.deepEqual(input.recent_questions, ['Which credentials expire next month?']);
    assert.deepEqual(input.previous_topic, { intent: 'expiring', window: 'next_month' });
  } finally {
    classification = 'coverage';
    guidance = null;
  }
});

test('coworker limits count concurrent AI attempts while known questions stay local', async () => {
  const route = '/api/coworker/settings';
  const initial = (await admin.get(route)).data;
  const dailyLimit = initial.ai_calls_today + 1;
  assert.equal((await admin.post(route, { ...initial.policy, daily_ai_calls: dailyLimit })).status, 200);
  calls = [];
  try {
    const results = await Promise.all([
      admin.post('/api/chat', { text: 'where do we stand overall on the rules?', chat_id: null }),
      hr.post('/api/chat', { text: 'could you puzzle that out for me?', chat_id: null }),
    ]);
    assert.equal(results.filter((r) => /under this workspace’s daily limit/.test(r.data.reply)).length, 1);
    assert.equal(calls.length, 1);
    assert.equal((await admin.get(route)).data.ai_calls_today, dailyLimit);
    await admin.post('/api/chat', { text: 'What needs my approval?' });
    assert.equal(calls.length, 1);
    assert.equal((await admin.post(route, { ...initial.policy, daily_ai_calls: 0 })).status, 200);
    assert.match((await admin.post('/api/chat', { text: 'where do we stand overall on the rules?' })).data.reply, /daily limit/);
    assert.equal(calls.length, 1);
  } finally {
    assert.equal((await admin.post(route, initial.policy)).status, 200);
  }
});

test('named OpenAI-compatible providers test and save their model and use bearer authentication', async () => {
  process.env.AEGIS_LLM_BASE_URL = `http://127.0.0.1:${fake.address().port}/v1/chat/completions`;
  const { PROVIDERS } = require('../server/llm.js');
  const endpoints = {
    openai: 'https://api.openai.com/v1/chat/completions',
    gemini: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    openrouter: 'https://openrouter.ai/api/v1/chat/completions',
    groq: 'https://api.groq.com/openai/v1/chat/completions',
    mistral: 'https://api.mistral.ai/v1/chat/completions',
  };
  const payload = { provider: 'openai', model: 'provider/fixture-model', api_key: KEY, approved: true };
  for (const [provider, endpoint] of Object.entries(endpoints)) {
    assert.equal(PROVIDERS[provider].url, endpoint);
    const configured = await admin.post('/api/ai', { ...payload, provider });
    assert.equal(configured.status, 200);
    assert.equal(configured.data.provider, provider);
    assert.equal(configured.data.model, payload.model);
    assert.equal(configured.data.endpoint, null);
    assert.equal(configured.data.reads_images, false);
    assert.equal(configured.data.reads_scanned_pdf, false);
    assert.ok(!configured.text.includes(KEY));
    const call = calls.at(-1);
    assert.equal(call.bearer, `Bearer ${KEY}`);
    assert.equal(call.key, undefined);
    assert.equal(call.body.model, payload.model);
    assert.equal(call.body.tools[0].function.name, 'record_ping');
    assert.ok(call.body.max_tokens || call.body.max_completion_tokens);
    assert.equal((await admin.post('/api/ai/test')).status, 200);
  }
  assert.equal((await admin.post('/api/ai', { ...payload, model: '' })).status, 400);
  assert.equal((await hr.post('/api/ai', payload)).status, 403);
  assert.equal((await admin.post('/api/ai', { ...payload, api_key: 'wrong' })).status, 422);
  try {
    incompatible = true;
    assert.match((await admin.post('/api/ai', payload)).data.error, /function response/);
    assert.equal((await admin.post('/api/ai/test')).status, 502);
    assert.equal((await admin.get('/api/ai')).data.provider, 'mistral');
  } finally { incompatible = false; }
  try {
    declined = true;
    assert.equal((await admin.post('/api/ai', payload)).status, 422);
    assert.equal((await admin.post('/api/ai/test')).status, 502);
  } finally { declined = false; }
});

test('custom endpoints require an exact server-approved URL and share the tested chat and evidence adapter', async () => {
  const endpoint = 'https://approved-provider.example.test/v1/chat/completions';
  process.env.AEGIS_LLM_CUSTOM_ENDPOINTS = endpoint;
  const payload = { provider: 'custom', model: 'custom-fixture-model', api_key: KEY, approved: true };
  try {
    const before = calls.length;
    for (const invalid of ['http://approved-provider.example.test/v1/chat/completions', endpoint + '?extra=1', endpoint + '/other', 'https://unapproved-provider.example.test/v1/chat/completions']) {
      assert.equal((await admin.post('/api/ai', { ...payload, endpoint: invalid })).status, 400);
    }
    assert.equal(calls.length, before);
    try {
      redirects = true;
      assert.equal((await admin.post('/api/ai', { ...payload, endpoint })).status, 422);
      assert.equal(calls.length, before + 1);
    } finally { redirects = false; }
    assert.equal((await admin.post('/api/ai', { ...payload, endpoint })).status, 200);
    const worker = db.get("SELECT * FROM workers WHERE name LIKE 'Elena%'");
    const image = { subject_type: 'worker', subject_id: worker.id, control_key: 'CTRL-HC-ACLS', file: up('fixture.png', 'image/png', [137, 80, 78, 71, 1]) };
    const beforeImage = calls.length;
    const skipped = await admin.post('/api/evidence', image);
    assert.equal(skipped.data.status, 'needs_review');
    assert.ok(skipped.data.reasons.some((reason) => /images are disabled/.test(reason)));
    assert.equal(calls.length, beforeImage);

    const saved = await admin.post('/api/ai', { ...payload, endpoint, reads_images: true });
    assert.equal(saved.status, 200);
    assert.equal(saved.data.endpoint, endpoint);
    assert.equal(saved.data.reads_images, true);
    assert.ok(!saved.text.includes(KEY));
    const chat = await admin.post('/api/chat', { text: 'where do we stand overall on the rules?' });
    assert.match(chat.data.reply, /applicable checks pass/);
    assert.equal(calls.at(-1).body.tools[0].function.name, 'classify');
    reply = { doc_type: 'acls_card', holder_name: worker.name, confidence: 0.91 };
    const parsed = await admin.post('/api/evidence', { ...image, file: up('fixture-vision.png', 'image/png', [137, 80, 78, 71, 2]) });
    assert.equal(parsed.data.status, 'needs_review');
    assert.ok(parsed.data.reasons.some((reason) => /read by AI/.test(reason)));
    const sentImage = calls.at(-1).body.messages[1].content.find((block) => block.type === 'image_url');
    assert.match(sentImage.image_url.url, /^data:image\/png;base64,/);

    delete process.env.AEGIS_LLM_CUSTOM_ENDPOINTS;
    const beforeRevokedCall = calls.length;
    assert.equal((await admin.post('/api/ai/test')).status, 502);
    assert.equal(calls.length, beforeRevokedCall);
    assert.equal((await admin.post('/api/ai/remove')).data.configured, false);
  } finally { delete process.env.AEGIS_LLM_CUSTOM_ENDPOINTS; }
});
