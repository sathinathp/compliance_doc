'use strict';
const path = require('node:path');

const port = 4188;
const origin = `http://127.0.0.1:${port}`;
let active = false;

function configure() {
  active = true;
  for (const key of Object.keys(process.env)) {
    if (/^(AEGIS_|SLACK_|SMTP_|EMAIL_|RESEND_|PG[A-Z]|DATABASE_URL$|DEEPSEEK_|ANTHROPIC_)/i.test(key)) delete process.env[key];
  }
  Object.assign(process.env, {
    NODE_ENV: 'development',
    PORT: String(port),
    AEGIS_DATA: path.resolve(__dirname, '..', '..', 'data', 'bluebix-sandbox'),
    AEGIS_DEMO: '1',
    AEGIS_BASE_URL: origin,
  });

  const fetch = globalThis.fetch;
  globalThis.fetch = async (input, options) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const fixture = url.pathname.startsWith('/mock-hrms/') || url.pathname === '/api/webhooks/hrms/bluebix';
    if (url.origin !== origin || !fixture) throw new Error('The sandbox uses the sample HRMS and the local message outbox.');
    return fetch(input, { ...options, redirect: 'error' });
  };
}

function rejectsHost(req) {
  return active && ![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host);
}

function blocksIntegration(method, pathname) {
  if (!active || method === 'GET') return false;
  return /^\/api\/(?:ai|integrations)(?:\/|$)/.test(pathname)
    || (pathname.startsWith('/api/connectors') && !/^\/api\/connectors\/[^/]+\/sync$/.test(pathname));
}

module.exports = { configure, isActive: () => active, rejectsHost, blocksIntegration, sessionCookie: () => active ? 'aegis_sandbox_sid' : 'aegis_sid' };
