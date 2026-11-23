'use strict';
// Startup checks. In production (NODE_ENV=production) Aegis refuses to start with
// settings that would be unsafe, instead of quietly running in a weaker mode.
const isProd = () => process.env.NODE_ENV === 'production';

function productionProblems(env = process.env) {
  const out = [];
  if (env.AEGIS_DEMO === '1') out.push('AEGIS_DEMO=1 loads demo accounts with a published password. Set AEGIS_DEMO=0.');
  const secret = env.AEGIS_SECRET || '';
  if (!secret) out.push('AEGIS_SECRET is not set. It encrypts documents and connector keys, so it must be set and kept safe. Make one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  else if (secret === 'change-me' || secret.length < 32) out.push('AEGIS_SECRET is too short or still the example value. Use at least 32 random characters.');
  if (!/^https:\/\//.test(env.AEGIS_BASE_URL || '')) out.push('AEGIS_BASE_URL must start with https:// (worker links and secure cookies depend on it).');
  return out;
}

module.exports = { isProd, productionProblems };
