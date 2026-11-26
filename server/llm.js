'use strict';
// Optional AI adapter. Used for interpretation and field extraction only: output is schema-limited
// and can never set a check status, accept evidence or send anything.
const db = require('./lib/db'), { encrypt, decrypt, clock } = require('./lib/util'), P = require('./platform');
const PROVIDERS = {
  // DeepSeek returns 400 for a forced tool in thinking mode, so thinking is turned off.
  deepseek: { label: 'DeepSeek', url: 'https://api.deepseek.com/anthropic/v1/messages', model: 'deepseek-flash', env: 'DEEPSEEK_API_KEY', extra: { thinking: { type: 'disabled' } } },
  anthropic: { label: 'Claude (Anthropic)', url: 'https://api.anthropic.com/v1/messages', model: 'claude-haiku-4-5-20251001', pdf: true, env: 'ANTHROPIC_API_KEY' },
  openai: { label: 'OpenAI', url: 'https://api.openai.com/v1/chat/completions', chat: true, tokenLimit: 'max_completion_tokens' },
  gemini: { label: 'Google Gemini', url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', chat: true, toolChoice: 'auto' },
  openrouter: { label: 'OpenRouter', url: 'https://openrouter.ai/api/v1/chat/completions', chat: true },
  groq: { label: 'Groq', url: 'https://api.groq.com/openai/v1/chat/completions', chat: true, tokenLimit: 'max_completion_tokens' },
  mistral: { label: 'Mistral AI', url: 'https://api.mistral.ai/v1/chat/completions', chat: true },
  custom: { label: 'Custom OpenAI-compatible', chat: true },
};
const metaKey = (t) => `llm:${t}`, errKey = (t) => `llmerr:${t}`;
function stored(t) {
  const r = db.get('SELECT v FROM meta WHERE k=?', metaKey(t));
  if (!r) return null;
  try { return JSON.parse(decrypt(Buffer.from(r.v, 'base64')).toString()); } catch { return null; }
}
function fromEnv() {
  const wanted = process.env.AEGIS_LLM_PROVIDER;
  const hasKey = (name) => Object.hasOwn(PROVIDERS, name) && PROVIDERS[name].env && process.env[PROVIDERS[name].env];
  const name = hasKey(wanted) ? wanted : Object.keys(PROVIDERS).find(hasKey);
  return name ? { provider: name, key: process.env[PROVIDERS[name].env], source: 'environment' } : null;
}
const config = (t) => { const s = stored(t); return s ? { ...s, source: 'settings' } : fromEnv(); };
// A second provider, set on the server with AEGIS_LLM_FALLBACK (for example deepseek), answers when the
// main one fails: an outage, a rejected key, no credit, a timeout or an unusable reply.
function fallbackOf(primary) {
  const name = process.env.AEGIS_LLM_FALLBACK;
  if (!primary || !name || name === primary.provider || !Object.hasOwn(PROVIDERS, name)) return null;
  const key = PROVIDERS[name].env && process.env[PROVIDERS[name].env];
  return key ? { provider: name, key, source: 'environment', fallback: true } : null;
}
const chain = (t) => { const c = config(t); return c ? [c, fallbackOf(c)].filter(Boolean) : []; };
const enabled = (t) => !!config(t);
const readsImages = (cfg) => cfg && (!PROVIDERS[cfg.provider].chat || cfg.reads_images === true);
const capsOf = (cfg) => ({ pdf: !!PROVIDERS[cfg.provider].pdf, images: !!readsImages(cfg) });
// True when any provider in the chain can take the file, so the main one failing still leaves a reader.
const supportsPdf = (t) => chain(t).some((c) => capsOf(c).pdf);
const supportsImages = (t) => chain(t).some((c) => capsOf(c).images);
const modelOf = (cfg) => cfg.model || (cfg.fallback ? process.env.AEGIS_LLM_FALLBACK_MODEL : process.env.AEGIS_LLM_MODEL) || PROVIDERS[cfg.provider].model;
// Newer Claude models always think and reject a forced tool, so they get tool_choice auto, a plain
// instruction to use the tool, and room for their thinking.
const thinksAlways = (model) => /^claude-(opus-5-5|sonnet-5-5|fable-5-[12]|mythos-5-[12])/.test(model);

function normalizeEndpoint(value) {
  if (typeof value !== 'string' || value.length > 500) return null;
  try {
    const u = new URL(value.trim());
    return u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash ? u.href : null;
  } catch { return null; }
}
function customEndpoint(value) {
  const endpoint = normalizeEndpoint(value);
  if (!endpoint) throw new P.HttpError(400, 'Enter an HTTPS Chat Completions endpoint without credentials, query parameters, or a fragment.');
  const approved = (process.env.AEGIS_LLM_CUSTOM_ENDPOINTS || '').split(',').map(normalizeEndpoint);
  if (!approved.includes(endpoint)) throw new P.HttpError(400, 'This endpoint has not been approved on the Aegis server.');
  return endpoint;
}
function providerConfig(body, user) {
  const { provider, model, endpoint, reads_images } = body || {};
  if (typeof provider !== 'string' || !Object.hasOwn(PROVIDERS, provider)) throw new P.HttpError(400, 'Choose an AI provider.');
  const key = typeof body.api_key === 'string' ? body.api_key.trim() : '';
  if (!key || key.length > 4096 || /\s/.test(key)) throw new P.HttpError(400, 'Enter a valid API key without whitespace.');
  if (body.approved !== true) throw new P.HttpError(400, 'Confirm that sending documents to this provider is approved.');
  const cfg = { provider, key, approved_by: user.name, approved_at: clock.iso() };
  if (PROVIDERS[provider].chat) {
    const selected = typeof model === 'string' ? model.trim() : '';
    if (!/^[\w][\w.:/@+-]{0,159}$/.test(selected)) throw new P.HttpError(400, 'Enter a valid model ID from your provider.');
    cfg.model = selected;
    cfg.reads_images = reads_images === true;
  }
  if (provider === 'custom') cfg.endpoint = customEndpoint(endpoint);
  return cfg;
}
function requestUrl(cfg, provider) {
  const destination = cfg.provider === 'custom' ? customEndpoint(cfg.endpoint) : provider.url;
  if (process.env.NODE_ENV === 'test' || !provider.chat) return process.env.AEGIS_LLM_BASE_URL || destination;
  return destination;
}

function chatRequest(cfg, provider, system, content, name, schema) {
  const blocks = content.map((block) => block.type === 'image'
    ? { type: 'image_url', image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` } }
    : { type: 'text', text: block.text });
  return {
    model: modelOf(cfg),
    [provider.tokenLimit || 'max_tokens']: 2048,
    messages: [{ role: 'system', content: system }, { role: 'user', content: blocks.length === 1 && blocks[0].type === 'text' ? blocks[0].text : blocks }],
    tools: [{ type: 'function', function: { name, description: 'Record the structured result.', parameters: schema } }],
    tool_choice: provider.toolChoice || { type: 'function', function: { name } },
  };
}
function toolResult(out, isChat, name, schema) {
  const message = out?.choices?.[0]?.message;
  const calls = message?.tool_calls ?? message?.toolCalls;
  let input;
  if (isChat) {
    const args = Array.isArray(calls) && calls.find((call) => call?.function?.name === name)?.function?.arguments;
    try { input = JSON.parse(args); } catch { return null; }
  } else {
    input = Array.isArray(out?.content) && out.content.find((block) => block?.type === 'tool_use' && block.name === name)?.input;
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const fields = Object.entries(schema.properties).filter(([key, rule]) => Object.hasOwn(input, key)
    && typeof input[key] === rule.type && (rule.type !== 'number' || Number.isFinite(input[key]))
    && (!rule.enum || rule.enum.includes(input[key])));
  const result = Object.fromEntries(fields.map(([key]) => [key, input[key]]));
  return fields.length && (schema.required || []).every((key) => Object.hasOwn(result, key)) ? result : null;
}

async function request(t, cfg, system, userContent, name, schema, timeoutMs = 60000) {
  const p = PROVIDERS[cfg.provider];
  const destination = requestUrl(cfg, p);
  const auth = p.chat ? { authorization: `Bearer ${cfg.key}` } : { 'x-api-key': cfg.key, 'anthropic-version': '2023-06-01' };
  const model = modelOf(cfg), thinks = !p.chat && thinksAlways(model);
  const body = p.chat ? chatRequest(cfg, p, system, userContent, name, schema)
    : { model, max_tokens: thinks ? 16000 : 1000, system: thinks ? `${system}\nAlways answer by calling the ${name} tool.` : system, messages: [{ role: 'user', content: userContent }], tools: [{ name, description: 'Record the structured result.', input_schema: schema }], tool_choice: thinks ? { type: 'auto' } : { type: 'tool', name }, ...p.extra };
  const res = await fetch(destination, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).catch((e) => { if (e.name === 'TimeoutError') throw e; throw new Error(`Could not reach ${p.label}. Check this server's internet access.`); });
  if (res.status === 401 || res.status === 403) throw new Error(`${p.label} rejected this API key.`);
  if (res.status === 402) throw new Error(`${p.label} reports insufficient balance on this account.`);
  if (!res.ok) {
    // The provider's own reason (for example "credit balance is too low") helps whoever fixes it.
    const why = await res.json().then((x) => x?.error?.message || (typeof x?.error === 'string' ? x.error : ''), () => '');
    throw new Error(`${p.label} returned an error (${res.status})${why ? `: ${String(why).replace(/\s+/g, ' ').slice(0, 160)}` : ''}.`);
  }
  const out = await res.json().catch(() => null);
  const result = toolResult(out, p.chat, name, schema);
  if (!result) throw new Error(`${p.label} did not return the expected function response. Choose a model that supports function calling.`);
  const usage = out.usage || {};
  const tokens = (n) => Number.isSafeInteger(n) && n >= 0 ? n : 0;
  P.bump(t, 'llm_calls');
  P.bump(t, 'llm_input_tokens', tokens(p.chat ? usage.prompt_tokens : usage.input_tokens));
  P.bump(t, 'llm_output_tokens', tokens(p.chat ? usage.completion_tokens : usage.output_tokens));
  return result;
}
const failureText = (cfg, e) => (e.name === 'TimeoutError' ? `${PROVIDERS[cfg.provider].label} timed out.` : e.message);
function recordError(t, message) {
  db.run('INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v', errKey(t), JSON.stringify({ message, at: clock.iso() }));
}
// Never throws. Tries the main provider, then the fallback. If both fail the work goes to human
// review, and the failure stays visible on the health page and in the audit log.
// userContent may be a function of what a provider can read ({ pdf, images }): it returns the blocks
// to send, or null when that provider cannot read the file, so it is skipped.
async function callTool(t, system, userContent, name, schema, { timeoutMs } = {}) {
  const failed = [];
  for (const cfg of chain(t)) {
    const content = typeof userContent === 'function' ? userContent(capsOf(cfg)) : userContent;
    if (!content) continue;
    try {
      const out = await request(t, cfg, system, content, name, schema, timeoutMs);
      if (!failed.length) db.run('DELETE FROM meta WHERE k=?', errKey(t));
      else {
        const message = `${failed.join(' ')} ${PROVIDERS[cfg.provider].label} answered instead.`;
        if (lastError(t)?.message !== message) P.audit(t, 'AI_FALLBACK', 'AI engine', `Main AI provider failed: ${message}`);
        recordError(t, message);
      }
      return out;
    } catch (e) { failed.push(failureText(cfg, e)); }
  }
  if (failed.length) {
    const message = failed.join(' ');
    recordError(t, message);
    P.audit(t, 'AI_ERROR', 'AI engine', `AI call failed: ${message} Work continues through human review.`);
  }
  return null;
}
const PING = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] };
const ping = async (call) => {
  const result = await call('Connection test. Call the record_ping tool with ok set to true.', [{ type: 'text', text: 'Use record_ping to confirm the connection.' }], 'record_ping', PING);
  return result?.ok === true;
};
async function test(t, cfg) {
  if (!await ping((...args) => request(t, cfg, ...args))) throw new Error('The provider did not confirm the connection.');
}
// Tests the main provider only, so a working fallback cannot hide a broken main key.
async function testSaved(t) {
  const cfg = config(t);
  if (!cfg) return false;
  try {
    const ok = await ping((...args) => request(t, cfg, ...args));
    if (ok) db.run('DELETE FROM meta WHERE k=?', errKey(t));
    else recordError(t, 'The provider did not confirm the connection.');
    return ok;
  } catch (e) { recordError(t, failureText(cfg, e)); return false; }
}
function save(t, cfg) { db.run('INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v', metaKey(t), encrypt(Buffer.from(JSON.stringify(cfg))).toString('base64')); db.run('DELETE FROM meta WHERE k=?', errKey(t)); }
function remove(t) { db.run('DELETE FROM meta WHERE k=?', metaKey(t)); db.run('DELETE FROM meta WHERE k=?', errKey(t)); }
function lastError(t) { const r = db.get('SELECT v FROM meta WHERE k=?', errKey(t)); return r ? JSON.parse(r.v) : null; }
function status(t) {
  const c = config(t), p = c && PROVIDERS[c.provider], f = fallbackOf(c);
  return {
    fallback: f ? { provider: f.provider, provider_label: PROVIDERS[f.provider].label, model: modelOf(f) } : null,
    configured: !!c, provider: c?.provider || null, provider_label: p?.label || null, model: c ? modelOf(c) : null,
    endpoint: c?.endpoint || null, source: c?.source || null, key_hint: c ? `••••${c.key.length > 4 ? c.key.slice(-4) : ''}` : null,
    reads_images: !!readsImages(c), reads_scanned_pdf: !!p?.pdf, approved_by: c?.approved_by || null, approved_at: c?.approved_at || null,
    last_error: lastError(t), providers: Object.entries(PROVIDERS).map(([key, v]) => ({ key, label: v.label, requires_model: !!v.chat })),
  };
}
module.exports = { PROVIDERS, providerConfig, enabled, supportsPdf, supportsImages, callTool, test, testSaved, save, remove, status, lastError };
