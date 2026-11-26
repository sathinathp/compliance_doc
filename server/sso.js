'use strict';
// "Continue with Microsoft" and "Continue with Google" on the sign-in and sign-up screens.
//
// It uses the same Aegis registration with Microsoft and Google as the email connection
// (AEGIS_MICROSOFT_CLIENT_ID and friends), but asks only who the person is: their name and email.
// Aegis never sees their password.
//
// Which email counts:
//   Microsoft  the work account's userPrincipalName. Its domain must be one the company has proved it
//              owns in Microsoft 365, so nobody can claim someone else's address. Only work and
//              school accounts, not personal Microsoft accounts.
//   Google     the account email, only when Google says it is verified.
//
// A person with an Aegis account is signed in. A new person can create a workspace with their
// details filled in; their email is already confirmed by Microsoft or Google.
const crypto = require('crypto');
const { sha256, token } = require('./lib/util');
const E = require('./email');

const LOGIN = {
  microsoft: {
    name: 'Microsoft',
    authorize: 'https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize',
    token: 'https://login.microsoftonline.com/organizations/oauth2/v2.0/token',
    scope: 'openid profile email User.Read',
  },
  google: {
    name: 'Google',
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    scope: 'openid email profile',
  },
};
const available = () => { const a = E.available(); return { microsoft: a.microsoft, google: a.google }; };

const TTL = 10 * 60e3;
const pending = new Map(); // started sign-ins, by hashed state
const signups = new Map(); // confirmed people without an account, by hashed handle
function sweep() {
  const now = Date.now();
  for (const m of [pending, signups]) for (const [k, v] of m) if (v.expires < now) m.delete(k);
}

class SignInError extends Error { constructor(code, message) { super(message); this.code = code; } }

function start(provider) {
  const p = LOGIN[provider];
  if (!p) throw new SignInError('failed', 'Choose Microsoft or Google.');
  if (!available()[provider]) throw new SignInError('unavailable', `${p.name} sign-in is not set up on this server.`);
  sweep();
  const state = token(), verifier = crypto.randomBytes(32).toString('base64url');
  pending.set(sha256(state), { provider, verifier, expires: Date.now() + TTL });
  const q = new URLSearchParams({
    client_id: E.appKeys(provider).id, response_type: 'code', redirect_uri: E.redirectUri(), scope: p.scope, state,
    code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', prompt: 'select_account',
  });
  if (provider === 'microsoft') q.set('response_mode', 'query');
  return `${p.authorize}?${q}`;
}

const claims = (idToken) => { try { return JSON.parse(Buffer.from(String(idToken).split('.')[1], 'base64url').toString()); } catch { return {}; } };
const domain = (email) => email.split('@')[1] || '';

// Returns { email, name, provider } for the person who signed in, or throws a SignInError.
async function finish(q) {
  const state = q.get('state') || '', found = state && pending.get(sha256(state));
  if (!found || found.expires < Date.now()) throw new SignInError('expired', 'That sign-in took too long or was already used. Try again.');
  pending.delete(sha256(state));
  const p = LOGIN[found.provider];
  if (q.get('error')) {
    const desc = q.get('error_description') || '';
    if (/AADSTS65001|AADSTS90094|consent/i.test(desc)) throw new SignInError('consent', `Your organization needs to approve Aegis in ${p.name} before you can sign in with it. Ask your IT administrator, or sign in with your email and password.`);
    throw new SignInError('cancelled', `${p.name} sign-in was cancelled.`);
  }
  const keys = E.appKeys(found.provider);
  const tok = await E.call(p.token, E.form({
    client_id: keys.id, client_secret: keys.secret, grant_type: 'authorization_code', code: q.get('code') || '', redirect_uri: E.redirectUri(), code_verifier: found.verifier,
    ...(found.provider === 'microsoft' ? { scope: p.scope } : {}),
  }), p.name);
  if (!tok.ok || !tok.body.access_token) throw new SignInError('failed', E.tokenError(found.provider, tok.body));
  if (found.provider === 'microsoft') {
    const me = await E.call('https://graph.microsoft.com/v1.0/me?$select=displayName,mail,userPrincipalName', { headers: { authorization: `Bearer ${tok.body.access_token}` } }, 'Microsoft');
    if (!me.ok) throw new SignInError('failed', 'Microsoft did not share who signed in. Try again.');
    const upn = E.cleanEmail(me.body.userPrincipalName), mail = E.cleanEmail(me.body.mail);
    if (!upn.includes('@') || upn.includes('#ext#')) throw new SignInError('failed', 'Sign in with your own work account, not a guest account.');
    // mail is a second address; trust it only on the same proven domain.
    const emails = [upn, ...(mail && domain(mail) === domain(upn) && mail !== upn ? [mail] : [])];
    return { provider: 'microsoft', emails, email: mail && emails.includes(mail) ? mail : upn, name: String(me.body.displayName || '').trim() };
  }
  const c = claims(tok.body.id_token), email = E.cleanEmail(c.email);
  if (!email || c.email_verified !== true) throw new SignInError('failed', 'Google did not confirm this email address. Sign in with your email and password instead.');
  return { provider: 'google', emails: [email], email, name: String(c.name || '').trim() };
}

// Someone confirmed by Microsoft or Google who has no account yet can create a workspace for 15 minutes.
function holdSignup(person) {
  sweep();
  const handle = token();
  signups.set(sha256(handle), { ...person, expires: Date.now() + 15 * 60e3 });
  return handle;
}
const peekSignup = (handle) => { const s = handle && signups.get(sha256(handle)); return s && s.expires > Date.now() ? s : null; };
const takeSignup = (handle) => { const s = peekSignup(handle); if (s) signups.delete(sha256(handle)); return s; };

module.exports = { LOGIN, available, start, finish, holdSignup, peekSignup, takeSignup, SignInError };
