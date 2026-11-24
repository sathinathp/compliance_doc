'use strict';

const { existsSync } = require('node:fs');
const { join } = require('node:path');
const db = require('../server/lib/db');
const llm = require('../server/llm');

const providers = ['deepseek', 'anthropic'];
const usage = 'Usage: node scripts/check-llm.js [deepseek|anthropic]';

async function checkAnthropic(key, model) {
  const response = await fetch(llm.PROVIDERS.anthropic.url, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(30000),
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 1000,
      system: 'Connection test. Call the record_ping tool with ok set to true.',
      messages: [{ role: 'user', content: 'Use record_ping to confirm the connection.' }],
      tools: [{
        name: 'record_ping',
        description: 'Record the structured result.',
        input_schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
      }],
      tool_choice: { type: 'auto' },
    }),
  });

  if (response.status === 401) throw new Error('Anthropic rejected the API key (HTTP 401).');
  if (response.status === 403) throw new Error('Anthropic denied access (HTTP 403). Check the key permissions.');
  if (!response.ok) throw new Error(`Anthropic returned HTTP ${response.status}.`);

  const content = (await response.json().catch(() => null))?.content;
  if (!Array.isArray(content) || !content.some(
    (block) => block?.type === 'tool_use' && block.name === 'record_ping' && block.input?.ok === true,
  )) {
    throw new Error('Anthropic accepted the request but did not return the expected tool response.');
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    console.log(usage);
    return;
  }
  if (args.length > 1 || (args.length === 1 && !providers.includes(args[0]))) {
    console.error(usage);
    process.exitCode = 2;
    return;
  }

  const envFile = join(__dirname, '..', '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);

  const selected = args.length ? args : providers;
  if (selected.includes('deepseek')) {
    // Keep Aegis's DeepSeek counters in memory and call DeepSeek's own endpoint.
    process.env.NODE_ENV = 'test';
    delete process.env.AEGIS_TEST_DATABASE_URL;
    delete process.env.AEGIS_LLM_BASE_URL;
    db.open(':memory:');
  }

  try {
    for (const provider of selected) {
      const { label, env, model: defaultModel } = llm.PROVIDERS[provider];
      const key = process.env[env];
      if (!key) {
        console.error(`${label}: ${env} is missing. Add it to .env or set it in your environment.`);
        process.exitCode = 1;
        continue;
      }

      const model = process.env.AEGIS_LLM_MODEL || defaultModel;
      try {
        if (provider === 'anthropic') {
          await checkAnthropic(key, model);
        } else {
          await llm.test('llm-connection-check', { provider, key, model });
        }
        console.log(`${label} (${model}): connection test passed.`);
      } catch (error) {
        const message = error.name === 'TimeoutError' ? 'The request timed out.' : error.message;
        console.error(`${label} (${model}): ${message}`);
        process.exitCode = 1;
      }
    }
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error(`Could not run the connection check: ${error.message}`);
  process.exitCode = 1;
});
