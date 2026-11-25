'use strict';
// Verifies the AI adapter against a local stand-in that enforces provider-specific rules.
const test = require('node:test'), assert = require('node:assert'), fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-ai-'));
process.env.NODE_ENV = 'test';
process.env.AEGIS_DATA = dir; process.env.AEGIS_DEMO = '1';
const KEY = 'sk-test-secret-1234';
let calls = [], reply = null, down = false, failModel = null, incompatible = false, declined = false, redirects = false, classification = 'coverage', guidance = null;
const classificationResult = () => ({ intent: classification, ...(guidance ? { guidance } : {}) });
const fake = http.createServer((req, res) => {
  let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => {
    const body = JSON.parse(b);
    const chat = req.url === '/v1/chat/completions';
    calls.push({ url: req.url, key: req.headers['x-api-key'], bearer: req.headers.authorization, body });
    const send = (s, o) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (down) return send(500, {});
    if (failModel && body.model === failModel) return send(400, { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } });
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
    if (body.model === 'deepseek-flash') {
      if (body.tool_choice?.type === 'tool' && body.thinking?.type !== 'disabled') return send(400, { error: 'tool_choice tool not allowed in thinking mode' });
      if (body.messages[0].content.some((c) => c.type === 'document')) return send(400, { error: 'document not supported' });
    }
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

test('Anthropic defaults to Haiku 4.5 for text, images, and scanned PDFs', async () => {
  process.env.AEGIS_LLM_BASE_URL = `http://127.0.0.1:${fake.address().port}/anthropic/v1/messages`;
  const saved = await admin.post('/api/ai', { provider: 'anthropic', api_key: KEY, approved: true });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.model, 'claude-haiku-4-5-20251001');
  assert.equal(saved.data.reads_images, true);
  assert.equal(saved.data.reads_scanned_pdf, true);

  const worker = db.get("SELECT * FROM workers WHERE name LIKE 'Elena%'");
  reply = { doc_type: 'acls_card', holder_name: worker.name, doc_number: 'HAIKU-FIXTURE', confidence: 0.92 };
  const label = 'Reference ID: HAIKU-FIXTURE';
  const fixtures = [
    [up('haiku.txt', 'text/plain', label), { type: 'text', text: label }],
    // Claude gets every PDF itself, so it sees the layout as well as the words.
    [up('haiku-text.pdf', 'application/pdf', `%PDF-1.4\nBT (${label}) Tj ET\n`), { type: 'document', mediaType: 'application/pdf', hasText: true }],
    [up('haiku.png', 'image/png', [137, 80, 78, 71, 55]), { type: 'image', mediaType: 'image/png' }],
    [up('haiku-scan.pdf', 'application/pdf', Buffer.from('%PDF-1.4\n% Image-only fixture\n')), { type: 'document', mediaType: 'application/pdf' }],
  ];
  try {
    for (const [file, expected] of fixtures) {
      const before = calls.length;
      const result = await admin.post('/api/evidence', {
        subject_type: 'worker', subject_id: worker.id, control_key: 'CTRL-HC-ACLS', file,
      });
      assert.equal(result.status, 200, file.name);
      assert.equal(calls.length, before + 1, file.name);
      const { body } = calls.at(-1);
      assert.equal(body.model, 'claude-haiku-4-5-20251001');
      assert.equal(body.tools[0].name, 'record_fields');
      const block = body.messages[0].content.find((b) => b.type === expected.type);
      assert.ok(block, file.name);
      if (expected.mediaType) {
        assert.deepEqual(block.source, { type: 'base64', media_type: expected.mediaType, data: file.data });
        assert.equal(result.data.status, 'needs_review');
        // Fields read only from a picture of the page always need a person to confirm them.
        assert.equal(result.data.reasons.some((reason) => /read by AI/.test(reason)), !expected.hasText, file.name);
      } else {
        assert.equal(block.text, expected.text);
      }
      assert.equal(db.get('SELECT doc_number FROM evidence WHERE id=?', result.data.id).doc_number, reply.doc_number);
    }
  } finally {
    await admin.post('/api/ai/remove');
  }
});

// A one-page PDF drawn from a PDF content stream: with text it is a typed PDF, without it a scan.
function makePdf(stream) {
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let pdf = '%PDF-1.4\n'; const at = [];
  objs.forEach((o, i) => { at.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${at.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}

test('Claude reads evidence first, and DeepSeek answers when Claude fails', async () => {
  const env = { ANTHROPIC_API_KEY: KEY, DEEPSEEK_API_KEY: KEY, AEGIS_LLM_PROVIDER: 'anthropic', AEGIS_LLM_FALLBACK: 'deepseek' };
  process.env.AEGIS_LLM_BASE_URL = `http://127.0.0.1:${fake.address().port}/anthropic/v1/messages`;
  Object.assign(process.env, env);
  const worker = db.get("SELECT * FROM workers WHERE name LIKE 'Elena%'");
  const upload = (file) => admin.post('/api/evidence', { subject_type: 'worker', subject_id: worker.id, control_key: 'CTRL-HC-ACLS', file });
  try {
    const status = (await admin.get('/api/ai')).data;
    assert.equal(status.provider, 'anthropic');
    assert.deepEqual(status.fallback, { provider: 'deepseek', provider_label: 'DeepSeek', model: 'deepseek-flash' });

    reply = { doc_type: 'acls_card', holder_name: worker.name, doc_number: 'FALLBACK-1', confidence: 0.9 };
    calls = [];
    await upload(up('claude-first.txt', 'text/plain', `ACLS Provider\nName: ${worker.name}\nCard No: AC-1001`));
    assert.deepEqual(calls.map((c) => c.body.model), ['claude-haiku-4-5-20251001'], 'Claude answers, DeepSeek is not called');

    failModel = 'claude-haiku-4-5-20251001'; calls = [];
    const text = await upload(up('fallback.txt', 'text/plain', `ACLS Provider\nName: ${worker.name}\nCard No: AC-1002`));
    assert.deepEqual(calls.map((c) => c.body.model), ['claude-haiku-4-5-20251001', 'deepseek-flash']);
    assert.equal(db.get('SELECT doc_number FROM evidence WHERE id=?', text.data.id).doc_number, 'FALLBACK-1');
    const error = (await admin.get('/api/health')).data.ai_error.message;
    assert.match(error, /credit balance is too low/); assert.match(error, /DeepSeek answered instead/);
    assert.ok(db.all('SELECT * FROM audit_log').some((a) => JSON.stringify(a).includes('DeepSeek answered instead')), 'the switch is in the audit log');
    assert.equal((await admin.post('/api/ai/test')).status, 502, 'the connection test checks Claude itself');

    // DeepSeek cannot take a PDF, so a scanned page reaches it as a picture.
    calls = [];
    const scan = await upload(up('scan-fallback.pdf', 'application/pdf', makePdf('0.2 0.2 0.2 rg 72 600 300 80 re f')));
    assert.equal(calls.length, 2);
    assert.equal(calls[0].body.messages[0].content[0].type, 'document');
    const pictures = calls[1].body.messages[0].content.filter((b) => b.type === 'image');
    assert.equal(pictures.length, 1); assert.equal(pictures[0].source.media_type, 'image/jpeg');
    assert.ok(scan.data.reasons.some((r) => /read by AI/.test(r)), 'a scan read by AI still needs a person');

    down = true; calls = [];
    const none = await upload(up('both-down.jpg', 'image/jpeg', [255, 216, 255, 77]));
    assert.equal(calls.length, 2); assert.equal(none.data.status, 'needs_review');
    assert.ok(none.data.reasons.some((r) => /AI could not read/.test(r)));
    assert.match((await admin.get('/api/health')).data.ai_error.message, /Claude \(Anthropic\).*DeepSeek/);
  } finally {
    failModel = null; down = false;
    for (const k of Object.keys(env)) delete process.env[k];
  }
});

test('a typed PDF is read word for word, and a wrong reading by AI is sent to a person', async () => {
  process.env.DEEPSEEK_API_KEY = KEY;
  const worker = db.get("SELECT * FROM workers WHERE name LIKE 'Elena%'");
  try {
    const pdf = makePdf(`BT /F1 12 Tf 72 720 Td [(Training Center Name: Mercy)-20( Hospital)] TJ 0 -20 Td [(Name: ${worker.name})] TJ 0 -20 Td (ACLS Provider) Tj 0 -20 Td (Card No: AC-2002) Tj 0 -20 Td (Expiration Date: 12/31/2099) Tj ET`);
    reply = { doc_type: 'acls_card', holder_name: worker.name, doc_number: 'AC-9999', expires_on: '2099-12-31', confidence: 0.9 };
    calls = [];
    const r = await admin.post('/api/evidence', { subject_type: 'worker', subject_id: worker.id, control_key: 'CTRL-HC-ACLS', file: up('typed.pdf', 'application/pdf', pdf) });
    assert.equal(calls.length, 1);
    const sent = calls[0].body.messages[0].content[0].text;
    assert.match(sent, /Training Center Name: Mercy Hospital/); assert.match(sent, /Expiration Date: 12\/31\/2099/);
    const ev = db.get('SELECT * FROM evidence WHERE id=?', r.data.id);
    assert.equal(ev.holder_name, worker.name); assert.equal(ev.expires_on, '2099-12-31');
    assert.equal(r.data.status, 'needs_review');
    assert.ok(r.data.reasons.some((x) => /AI read the document number differently/.test(x)), r.data.reasons.join(' | '));
  } finally { delete process.env.DEEPSEEK_API_KEY; }
});

test('a value the AI gives that is not in the document is never trusted', async () => {
  process.env.DEEPSEEK_API_KEY = KEY;
  const worker = db.get("SELECT * FROM workers WHERE name LIKE 'Elena%'");
  try {
    reply = { doc_type: 'acls_card', holder_name: worker.name, doc_number: 'ACLS-55555', expires_on: '2030-01-31', confidence: 0.92 };
    const r = await admin.post('/api/evidence', { subject_type: 'worker', subject_id: worker.id, control_key: 'CTRL-HC-ACLS', file: up('no-number.txt', 'text/plain', `ACLS Provider card\nCardholder: ${worker.name}\nValid through January 2030`) });
    const ev = db.get('SELECT * FROM evidence WHERE id=?', r.data.id), conf = JSON.parse(ev.fields_json);
    assert.equal(ev.doc_number, 'ACLS-55555'); assert.ok(conf.doc_number <= 0.5, 'shown, but marked unsure');
    assert.equal(ev.expires_on, '2030-01-31'); assert.ok(conf.expires_on > 0.5, 'a date that is on the page is trusted');
    assert.equal(r.data.status, 'needs_review');
    assert.ok(r.data.reasons.some((x) => /document number that does not appear in the document text/.test(x)), r.data.reasons.join(' | '));
  } finally { delete process.env.DEEPSEEK_API_KEY; }
});

test('a zip or an email upload becomes one piece of evidence per document, each with its own preview', async () => {
  const fixture = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', n));
  const zlib = require('zlib');
  const zipOf = (files) => { // [{ name, data }] -> .zip (stored, no compression)
    const parts = [], dir = []; let at = 0;
    for (const { name, data } of files) {
      const nb = Buffer.from(name), crc = zlib.crc32(data), lh = Buffer.alloc(30), ch = Buffer.alloc(46);
      lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nb.length, 26);
      ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nb.length, 28); ch.writeUInt32LE(at, 42);
      parts.push(lh, nb, data); dir.push(ch, nb); at += 30 + nb.length + data.length;
    }
    const cd = Buffer.concat(dir), end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(at, 16);
    return Buffer.concat([...parts, cd, end]);
  };
  const worker = db.get("SELECT * FROM workers WHERE name LIKE 'Elena%'");
  const zip = zipOf([{ name: 'license.pdf', data: fixture('license-table-browser.pdf') }, { name: 'license.odt', data: fixture('license-table.odt') }, { name: '.DS_Store', data: Buffer.from('x') }]);
  const r = await admin.post('/api/evidence', { subject_type: 'worker', subject_id: worker.id, file: up('documents.zip', 'application/zip', zip) });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.data.files.map((f) => f.filename), ['documents.zip › license.pdf', 'documents.zip › license.odt']);
  for (const f of r.data.files) {
    const ev = db.get('SELECT * FROM evidence WHERE id=?', f.id);
    assert.equal(ev.doc_number, 'RN-748291', f.filename); assert.equal(ev.expires_on, '2027-12-31', f.filename);
  }
  const listed = (await admin.get('/api/evidence')).data;
  const row = (id) => (listed.rows || listed).find((e) => e.id === id);
  assert.equal(row(r.data.files[0].id).preview, 'image'); assert.equal(row(r.data.files[1].id).preview, 'text');
  const picture = await admin.get(`/api/evidence/${r.data.files[0].id}/preview`);
  assert.equal(picture.status, 200); assert.equal(picture.data, null, 'the first page comes back as a picture');
  const text = await admin.get(`/api/evidence/${r.data.files[1].id}/preview`);
  assert.match(text.data.text, /Sarah Jenkins/);
  const hidden = db.get("SELECT id FROM evidence WHERE doc_type='unknown' AND stored_path<>'' LIMIT 1"); // only admins see unclassified files
  assert.equal((await hr.get(`/api/evidence/${hidden.id}/preview`)).status, 403, 'the same permission as opening the file');

  const msg = await admin.post('/api/evidence', { subject_type: 'worker', subject_id: worker.id, file: up('license-email.msg', 'application/vnd.ms-outlook', fixture('license-email.msg')) });
  assert.deepEqual(msg.data.files.map((f) => f.filename), ['license-email.msg › Sarah_Jenkins_RN_License.pdf']);
  const broken = await admin.post('/api/evidence', { subject_type: 'worker', subject_id: worker.id, file: up('broken.zip', 'application/zip', Buffer.from('PK\u0003\u0004 not a zip')) });
  assert.equal(broken.status, 422); assert.match(broken.data.error, /could not be opened/);

  // Files Aegis cannot open are refused with the reason, and nothing is stored for a reviewer.
  const stored = () => db.get('SELECT COUNT(*) n FROM evidence').n, before = stored();
  const program = await admin.post('/api/evidence', { subject_type: 'worker', subject_id: worker.id, file: up('setup.exe', 'application/x-msdownload', Buffer.concat([Buffer.from('MZ'), Buffer.alloc(500, 7)])) });
  assert.equal(program.status, 422); assert.match(program.data.error, /^This file type cannot be read\. Upload a PDF/);
  const fake = await admin.post('/api/evidence', { subject_type: 'worker', subject_id: worker.id, file: up('license.pdf', 'application/pdf', Buffer.from('just some words, renamed to .pdf')) });
  assert.equal(fake.status, 422); assert.match(fake.data.error, /is named \.pdf but is not a PDF/);
  const big = await admin.post('/api/evidence', { subject_type: 'worker', subject_id: worker.id, file: up('huge.pdf', 'application/pdf', Buffer.alloc(10 * 1024 * 1024 + 1, 32)) });
  assert.equal(big.status, 413); assert.match(big.data.error, /larger than 10 MB, the most Aegis accepts/);
  assert.equal(stored(), before, 'none of them was stored');
  // In a zip, the unreadable file is listed as not uploaded and the good one is kept.
  const mixed = await admin.post('/api/evidence', { subject_type: 'worker', subject_id: worker.id, file: up('mixed.zip', 'application/zip', zipOf([{ name: 'tool.exe', data: Buffer.from('MZ binary') }, { name: 'card.txt', data: Buffer.from('BLS Provider card\nName: Zip Tester\nExpires: 2028-01-31\n') }])) });
  assert.equal(mixed.status, 200);
  assert.deepEqual(mixed.data.files.map((f) => f.filename), ['mixed.zip › card.txt']);
  assert.deepEqual(mixed.data.failed.map((f) => [f.filename, f.status]), [['tool.exe', 422]]);
});

// ---- The cases in the Aegis Evidence Test Kit ----
// A typed cover page followed by a scanned page, as a PDF: page 2 is only a picture.
async function coverAndScanPdf() {
  const docread = require('../server/lib/docread');
  const [jpeg] = await docread.pageImages(fs.readFileSync(path.join(__dirname, 'fixtures', 'license-table-browser.pdf')), 1);
  const size = (b) => { for (let i = 2; i < b.length;) { const m = b[i + 1], len = b.readUInt16BE(i + 2); if (m >= 0xc0 && m <= 0xc3) return [b.readUInt16BE(i + 7), b.readUInt16BE(i + 5)]; i += 2 + len; } return [0, 0]; };
  const [w, h] = size(jpeg), cover = 'BT /F1 18 Tf 72 700 Td (Fax cover sheet for the credentialing team) Tj 0 -24 Td (Two pages including this one) Tj ET', draw = 'q 612 0 0 792 0 0 cm /Im1 Do Q';
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 7 0 R >> >> >>', `<< /Length ${cover.length} >>\nstream\n${cover}\nendstream`,
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 6 0 R /Resources << /XObject << /Im1 8 0 R >> >> >>', `<< /Length ${draw.length} >>\nstream\n${draw}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n${jpeg.toString('latin1')}\nendstream`];
  let pdf = '%PDF-1.4\n'; const at = [];
  objs.forEach((o, i) => { at.push(Buffer.byteLength(pdf, 'latin1')); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${at.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}

test('test kit: a scanned page inside a typed PDF is read from its picture and confirmed by a person', async () => {
  process.env.DEEPSEEK_API_KEY = KEY;
  const worker = db.get("SELECT * FROM workers WHERE name LIKE 'Elena%'");
  try {
    reply = { doc_type: 'professional_license', holder_name: worker.name, doc_number: 'RN-748291', expires_on: '2027-12-31', confidence: 0.9 };
    calls = [];
    const r = await admin.post('/api/evidence', { subject_type: 'worker', subject_id: worker.id, file: up('cover-and-scan.pdf', 'application/pdf', await coverAndScanPdf()) });
    const sent = calls[0].body.messages[0].content;
    assert.match(sent[0].text, /Fax cover sheet/, 'the typed page goes as text');
    assert.equal(sent.filter((b) => b.type === 'image').length, 1, 'only the scanned page goes as a picture');
    assert.equal(r.data.status, 'needs_review');
    assert.ok(r.data.reasons.some((x) => /came from the scanned page \(page 2\) and were read by AI/.test(x)), r.data.reasons.join(' | '));
    assert.ok(!r.data.reasons.some((x) => /does not appear in the document text/.test(x)), 'a scanned page is not called made up');
  } finally { delete process.env.DEEPSEEK_API_KEY; }
});

test('test kit: a date that reads two ways goes to a person, even when the AI agrees with one reading', async () => {
  process.env.DEEPSEEK_API_KEY = KEY;
  const worker = db.get("SELECT * FROM workers WHERE name LIKE 'Elena%'");
  try {
    reply = { doc_type: 'acls_card', holder_name: worker.name, doc_number: 'QA-ACLS-7', expires_on: '2028-03-04', confidence: 0.92 };
    const r = await admin.post('/api/evidence', { subject_type: 'worker', subject_id: worker.id, control_key: 'CTRL-HC-ACLS', file: up('ambiguous.txt', 'text/plain', `ACLS Provider Card\nName: ${worker.name}\nCard Number: QA-ACLS-7\nExpiration Date: 03/04/2028`) });
    assert.equal(r.data.status, 'needs_review');
    assert.ok(r.data.reasons.some((x) => /expiry date is printed as 03\/04\/2028, which can be read as two different dates/.test(x)), r.data.reasons.join(' | '));
    assert.ok(!r.data.reasons.some((x) => /Please check the expiry date; the reading is uncertain/.test(x)), 'said once, not twice');
    assert.ok(JSON.parse(db.get('SELECT fields_json FROM evidence WHERE id=?', r.data.id).fields_json).expires_on <= 0.85);
  } finally { delete process.env.DEEPSEEK_API_KEY; }
});

test('test kit: a document the AI confidently reads as someone else’s cannot be accepted by typing over the name', async () => {
  process.env.DEEPSEEK_API_KEY = KEY;
  const worker = db.get("SELECT * FROM workers WHERE name LIKE 'Elena%'");
  try {
    reply = { doc_type: 'acls_card', holder_name: 'Jordan Example', doc_number: 'QA-ACLS-8', expires_on: '2029-01-31', confidence: 0.95 };
    const r = await admin.post('/api/evidence', { subject_type: 'worker', subject_id: worker.id, control_key: 'CTRL-HC-ACLS', file: up('someone-else.png', 'image/png', [137, 80, 78, 71, 99]) });
    assert.ok(r.data.reasons.some((x) => /Name on document \(Jordan Example\) does not match/.test(x)));
    const typedOver = await admin.post(`/api/evidence/${r.data.id}/review`, { decision: 'accept', fields: { holder_name: worker.name } });
    assert.equal(typedOver.status, 422); assert.match(typedOver.data.error, /holder must match the worker/);
    assert.equal((await admin.post(`/api/evidence/${r.data.id}/review`, { decision: 'reject', reason: 'This card belongs to someone else.' })).status, 200);
  } finally { delete process.env.DEEPSEEK_API_KEY; }
});

test('names written differently: surname first is the same person; a first name only is checked, then can be accepted', async () => {
  const worker = db.get("SELECT * FROM workers WHERE name LIKE 'Elena%'");
  const [first, ...rest] = worker.name.replace(/,.*$/, '').split(' '), last = rest.at(-1);
  const card = (name, n) => up(`acls-${n}.txt`, 'text/plain', `ACLS Provider Card\nName: ${name}\nCard Number: QA-ACLS-${n}\nExpiration Date: 2030-01-31`);
  const upload = (name, n) => admin.post('/api/evidence', { subject_type: 'worker', subject_id: worker.id, control_key: 'CTRL-HC-ACLS', file: card(name, n) });

  const surnameFirst = await upload(`${last}, ${first}`, 101);
  assert.ok(!surnameFirst.data.reasons.some((x) => /name/i.test(x)), surnameFirst.data.reasons.join(' | '));

  const firstOnly = await upload(first, 102);
  assert.equal(firstOnly.data.status, 'needs_review');
  assert.ok(firstOnly.data.reasons.some((x) => x.startsWith('Check the name: the document says “' + first + '”')), firstOnly.data.reasons.join(' | '));
  assert.equal((await admin.post(`/api/evidence/${firstOnly.data.id}/review`, { decision: 'accept' })).status, 200, 'the reviewer can accept a possible match');

  const someoneElse = await upload(`Jordan ${last}`, 103);
  assert.ok(someoneElse.data.reasons.some((x) => x.startsWith(`Name on document (Jordan ${last}) does not match`)));
  assert.equal((await admin.post(`/api/evidence/${someoneElse.data.id}/review`, { decision: 'accept' })).status, 422, 'a different person is still blocked');
});

// ---- Duplicates and requirements that do not apply ----
const blsCard = (w, no, extra = '') => `Basic Life Support\nName: ${w.name}\nCard No: ${no}\nExpiration Date: 2029-03-01${extra}`;
const uploadBls = (w, file) => admin.post('/api/evidence', { subject_type: 'worker', subject_id: w.id, control_key: 'CTRL-HC-BLS', file });
const evidenceRow = async (eid) => (await admin.get('/api/evidence')).data.find((e) => e.id === eid);
const lastAudit = (type) => db.get('SELECT * FROM audit_log WHERE type=? ORDER BY seq DESC LIMIT 1', type);
// Photos are read by the stand-in Claude, as in production.
const withClaude = (fn) => async () => {
  Object.assign(process.env, { ANTHROPIC_API_KEY: KEY, AEGIS_LLM_PROVIDER: 'anthropic' });
  process.env.AEGIS_LLM_BASE_URL = `http://127.0.0.1:${fake.address().port}/anthropic/v1/messages`;
  try { await fn(); } finally { delete process.env.ANTHROPIC_API_KEY; delete process.env.AEGIS_LLM_PROVIDER; }
};

test('the same card in another file is kept as a duplicate of the accepted one and needs no review', withClaude(async () => {
  const w = db.get("SELECT * FROM workers WHERE name LIKE 'Sarah Jenkins%'");
  const fields = { doc_type: 'bls_card', holder_name: w.name, doc_number: 'QA-BLS-555', expires_on: '2029-03-01', confidence: 0.98 };
  reply = fields;
  const text = await uploadBls(w, up('bls-555.txt', 'text/plain', blsCard(w, 'QA-BLS-555')));
  assert.equal(text.data.status, 'accepted', text.data.reasons.join(' | '));
  const waitingBefore = (await admin.get('/api/nav')).data.evidence;

  reply = { ...fields, doc_number: 'QA BLS 555' }; // the photo prints the number with spaces
  const photo = await uploadBls(w, up('bls-555.png', 'image/png', [137, 80, 78, 71, 55]));
  assert.equal(photo.data.status, 'covered', photo.data.reasons.join(' | '));
  assert.equal(photo.data.duplicate, false);
  assert.deepEqual(photo.data.covered_by, { id: text.data.id, filename: 'bls-555.txt' });
  assert.equal((await admin.get('/api/nav')).data.evidence, waitingBefore, 'a duplicate adds nothing to the review queue');
  const row = await evidenceRow(photo.data.id);
  assert.equal(row.can_review, false); assert.deepEqual(row.covered_by, { id: text.data.id, filename: 'bls-555.txt' });
  assert.deepEqual((await evidenceRow(text.data.id)).duplicates, [{ id: photo.data.id, filename: 'bls-555.png' }]);
  assert.match(lastAudit('EVIDENCE_DUPLICATE').action, /^bls-555\.png is the same BLS provider card as bls-555\.txt, which is already accepted/);
  assert.equal((await admin.post(`/api/evidence/${photo.data.id}/review`, { decision: 'accept' })).status, 409, 'a duplicate is not a review task');

  reply = { ...fields, expires_on: '2031-03-01' }; // a renewed card is a new document, not a copy
  const renewal = await uploadBls(w, up('bls-renewed.png', 'image/png', [137, 80, 78, 71, 56]));
  assert.equal(renewal.data.status, 'needs_review');
  assert.equal(renewal.data.covered_by, null);
  assert.equal((await evidenceRow(renewal.data.id)).same_as, null);

  reply = { ...fields, doc_number: 'QA-BLS-000' }; // the AI and the page disagree on the number: not the same card
  const misread = await uploadBls(w, up('bls-555-misread.txt', 'text/plain', blsCard(w, 'QA-BLS-555', '\nTraining Center: Mercy')));
  assert.equal(misread.data.status, 'needs_review');
  assert.ok(misread.data.reasons.some((x) => /document number differently/.test(x)), misread.data.reasons.join(' | '));
  assert.equal((await evidenceRow(misread.data.id)).same_as, null);

  reply = { ...fields, state: 'NV' }; // the AI adds a state the page does not show: a person must look
  const typedCopy = await uploadBls(w, up('bls-555-copy.txt', 'text/plain', blsCard(w, 'QA-BLS-555', '\nTraining Center: St. Jude')));
  assert.equal(typedCopy.data.status, 'needs_review');
  assert.ok(typedCopy.data.reasons.some((x) => /does not appear in the document text/.test(x)), typedCopy.data.reasons.join(' | '));
  assert.deepEqual((await evidenceRow(typedCopy.data.id)).same_as, { id: text.data.id, filename: 'bls-555.txt' }, 'the reviewer is told it matches the accepted card');

}));

test('a copy waiting for review becomes a duplicate once the same card is accepted, and is checked again if that card is', withClaude(async () => {
  const w = db.get("SELECT * FROM workers WHERE name LIKE 'David Kim%'");
  const fields = { doc_type: 'bls_card', holder_name: w.name, doc_number: 'QA-BLS-777', expires_on: '2029-03-01', confidence: 0.97 };
  reply = fields;
  const photo = await uploadBls(w, up('bls-777.jpg', 'image/jpeg', [255, 216, 255, 77]));
  assert.equal(photo.data.status, 'needs_review');
  reply = { ...fields, holder_name: w.name.split(' ')[0] }; // only the first name: a person must check it
  const partName = await uploadBls(w, up('bls-777-first-name.jpg', 'image/jpeg', [255, 216, 255, 78]));
  assert.equal(partName.data.status, 'needs_review');

  reply = fields;
  const text = await uploadBls(w, up('bls-777.txt', 'text/plain', blsCard(w, 'QA-BLS-777')));
  assert.equal(text.data.status, 'accepted', text.data.reasons.join(' | '));
  const covered = db.get('SELECT * FROM evidence WHERE id=?', photo.data.id);
  assert.equal(covered.status, 'covered'); assert.equal(covered.covered_by, text.data.id);
  assert.match(lastAudit('EVIDENCE_DUPLICATE').action, /^bls-777\.jpg is the same BLS provider card as bls-777\.txt, which is now accepted/);
  assert.equal(db.get('SELECT status FROM evidence WHERE id=?', partName.data.id).status, 'needs_review', 'a partial name always reaches a person');

  // An exact copy of the accepted file is not stored again, and the attempt is recorded on the original.
  const count = () => db.get('SELECT COUNT(*) n FROM evidence WHERE subject_id=?', w.id).n, before = count();
  const again = await uploadBls(w, up('renamed-card.txt', 'text/plain', blsCard(w, 'QA-BLS-777')));
  assert.equal(again.data.duplicate, true); assert.equal(again.data.id, text.data.id);
  assert.equal(again.data.filename, 'bls-777.txt', 'the result names the copy already on record');
  assert.equal(count(), before);
  const copies = (await evidenceRow(text.data.id)).copies;
  assert.equal(copies.length, 1); assert.equal(copies[0].filename, 'renamed-card.txt'); assert.equal(copies[0].by, 'Sathinath');
  assert.match(lastAudit('EVIDENCE_COPY').action, /^renamed-card\.txt is the same file as bls-777\.txt, already on record\. Nothing new was saved\./);
  const photoAgain = await uploadBls(w, up('bls-777 (1).jpg', 'image/jpeg', [255, 216, 255, 77]));
  assert.equal(photoAgain.data.duplicate, true); assert.equal(photoAgain.data.status, 'covered'); assert.equal(count(), before);

  // If the accepted card turns out to belong to someone else, its duplicates go back to a person.
  db.run('UPDATE evidence SET holder_name=? WHERE id=?', 'Jordan Example', text.data.id);
  require('../server/evidence').recheckAcceptedHolders();
  const reopened = db.get('SELECT * FROM evidence WHERE id=?', photo.data.id);
  assert.equal(reopened.status, 'needs_review'); assert.equal(reopened.covered_by, null);
  assert.ok(JSON.parse(reopened.review_reasons_json).some((x) => /accepted copy of this document \(bls-777\.txt\) needs checking again/.test(x)));

}));

test('documents for a requirement that does not apply to the person say so', withClaude(async () => {
  const alex = db.get("SELECT * FROM workers WHERE name='Alex Patel'"), nurse = db.get("SELECT * FROM workers WHERE name LIKE 'Sarah Jenkins%'");
  reply = { doc_type: 'bls_card', holder_name: alex.name, doc_number: 'QA-BLS-888', expires_on: '2029-03-01', confidence: 0.98 };
  const r = await uploadBls(alex, up('alex-bls.txt', 'text/plain', blsCard(alex, 'QA-BLS-888')));
  assert.equal(r.data.status, 'accepted');
  const note = "BLS provider card doesn't apply to Alex Patel (applies to clinical workers only). Documents for it are kept on file but don't count toward any check.";
  assert.equal(r.data.requirement_note, note);
  assert.equal((await evidenceRow(r.data.id)).requirement_note, note);
  assert.equal((await evidenceRow(db.get("SELECT id FROM evidence WHERE subject_id=? AND filename='bls-555.txt'", nurse.id).id)).requirement_note, null, 'a nurse needs a BLS card');

}));

test('two readings are the same document only when every accepted detail matches', () => {
  const { sameDocument } = require('../server/evidence');
  const accepted = { doc_type: 'bls_card', doc_number: 'BLS-293847', holder_name: 'Alex Patel', expires_on: '2028-04-02', issued_on: '2026-04-02' };
  assert.equal(sameDocument(accepted, { ...accepted, doc_number: 'bls 293847', holder_name: 'Patel, Alex' }), true);
  assert.equal(sameDocument(accepted, { ...accepted, issued_on: null }), false, 'a date the new reading lacks is a difference');
  const withEmployer = { ...accepted, state: 'NY', entity_name: 'Example Healthcare Staffing LLC' };
  assert.equal(sameDocument(withEmployer, { ...accepted, state: null, entity_name: null }), true, 'a photo may leave out the employer and state');
  assert.equal(sameDocument(withEmployer, { ...withEmployer, state: 'CA' }), false, 'but they must not disagree');
  assert.equal(sameDocument(accepted, { ...accepted, expires_on: '2028-04-03' }), false);
  assert.equal(sameDocument(accepted, { ...accepted, holder_name: 'Alex' }), false);
  assert.equal(sameDocument(accepted, { ...accepted, doc_type: 'acls_card' }), false);
  assert.equal(sameDocument({ ...accepted, doc_number: null }, accepted), false, 'without a number nothing is called a copy');
});

// ---- Moving a document to the person named on it ----
test('a document uploaded for the wrong person can be moved to the worker named on it', async () => {
  const alex = db.get("SELECT * FROM workers WHERE name='Alex Patel'");
  assert.equal((await admin.post('/api/workers', { name: 'Alex Example', role: 'Staff Nurse', category: 'clinical', license_type: 'RN' })).status, 200);
  const other = db.get("SELECT * FROM workers WHERE name='Alex Example'"), nurse = db.get("SELECT id FROM workers WHERE name LIKE 'Sarah Jenkins%'");
  const card = blsCard(alex, 'QA-BLS-901');
  const wrong = await uploadBls(other, up('alex-patel-bls.txt', 'text/plain', card));
  assert.equal(wrong.data.status, 'needs_review');
  assert.ok(wrong.data.reasons.some((x) => x.startsWith('Name on document (Alex Patel) does not match Alex Example')), wrong.data.reasons.join(' | '));
  assert.deepEqual(wrong.data.move_to, { id: alex.id, name: 'Alex Patel' });
  assert.deepEqual((await evidenceRow(wrong.data.id)).move_to, { id: alex.id, name: 'Alex Patel' });

  // Only to the person named on it, and only by someone who may review it.
  assert.equal((await admin.post(`/api/evidence/${wrong.data.id}/move`, { subject_id: nurse.id })).status, 422);
  assert.equal((await admin.post(`/api/evidence/${wrong.data.id}/move`, { subject_id: other.id })).status, 422);
  assert.equal((await hr.post(`/api/evidence/${wrong.data.id}/move`, { subject_id: alex.id })).status, 403);

  const moved = await admin.post(`/api/evidence/${wrong.data.id}/move`, { subject_id: alex.id });
  assert.equal(moved.status, 200, moved.text);
  assert.equal(moved.data.id, wrong.data.id); assert.equal(moved.data.subject_name, 'Alex Patel'); assert.equal(moved.data.move_to, null);
  assert.equal(moved.data.status, 'accepted', moved.data.reasons.join(' | '));
  const row = db.get('SELECT * FROM evidence WHERE id=?', wrong.data.id);
  assert.equal(row.subject_id, alex.id); assert.equal(row.case_id, null); assert.equal(row.filename, 'alex-patel-bls.txt');
  assert.ok(!JSON.parse(row.review_reasons_json).some((x) => /Name on document/.test(x)), 'the wrong-person reason is gone');
  assert.match(lastAudit('EVIDENCE_MOVED').action, /^alex-patel-bls\.txt was moved from Alex Example to Alex Patel, the person named on it, and checked again\. It was accepted\./);
  assert.ok(!(await admin.get('/api/evidence')).data.some((e) => e.subject_id === other.id && e.filename === 'alex-patel-bls.txt'), 'no longer in Alex Example’s file');
  assert.equal((await admin.post(`/api/evidence/${wrong.data.id}/move`, { subject_id: alex.id })).status, 409, 'an accepted document stays where it is');

  // Alex Patel already has this exact file: the misplaced copy is removed rather than stored twice.
  const again = await uploadBls(other, up('alex-patel-bls (2).txt', 'text/plain', card));
  assert.equal(again.data.duplicate, false); assert.deepEqual(again.data.move_to, { id: alex.id, name: 'Alex Patel' });
  const merged = await admin.post(`/api/evidence/${again.data.id}/move`, { subject_id: alex.id });
  assert.equal(merged.status, 200, merged.text);
  assert.equal(merged.data.duplicate, true); assert.equal(merged.data.id, wrong.data.id);
  assert.equal(db.get('SELECT COUNT(*) n FROM evidence WHERE id=?', again.data.id).n, 0);
  assert.ok(JSON.parse(db.get('SELECT copies_json c FROM evidence WHERE id=?', wrong.data.id).c).some((c) => c.filename === 'alex-patel-bls (2).txt'));
  assert.match(lastAudit('EVIDENCE_MOVED').action, /Alex Patel already had the same file, so the moved copy was removed\.$/);
});

test('a move is offered only when the name on the document is exactly one other worker', () => {
  const { moveTarget } = require('../server/evidence');
  const ev = { subject_type: 'worker', subject_id: 'w1', status: 'needs_review', holder_name: 'Patel, Alex' };
  const workers = [{ id: 'w1', name: 'Alex Example' }, { id: 'w2', name: 'Alex Patel' }, { id: 'w3', name: 'Alexander Patel' }];
  assert.deepEqual(moveTarget(null, ev, { workers }), { id: 'w2', name: 'Alex Patel' });
  assert.equal(moveTarget(null, ev, { workers: [...workers, { id: 'w4', name: 'Alex Patel, RN' }] }), null, 'two workers share the name');
  assert.equal(moveTarget(null, { ...ev, holder_name: 'Alex' }, { workers }), null, 'a first name alone fits Alex Example too, so it stays with a person');
  assert.equal(moveTarget(null, { ...ev, holder_name: 'Jordan Smith' }, { workers }), null, 'nobody by that name');
  assert.equal(moveTarget(null, { ...ev, status: 'accepted' }, { workers }), null, 'only documents waiting for review');
  assert.equal(moveTarget(null, { ...ev, subject_type: 'entity' }, { workers }), null);
});
