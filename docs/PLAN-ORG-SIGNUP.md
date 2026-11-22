# Plan: organisation sign-up (self-serve workspaces)

Handoff for continuing in another tool. Written 2026-11-22 on branch `ranjith-dev`.

## Where things stand

- Aegis runs as one Node server (`server/index.js`) serving the classic UI in `public/` (vanilla JS in `public/app.js`, styles in `public/tokens.css` and `public/system.css`).
- Data is multi-tenant already: every table has `tenant_id`, and every route reads the tenant from the session. The `tenants`, `users` and `sessions` tables are in `server/lib/db.js`.
- **New organisations cannot create a workspace.** Workspaces exist only from:
  - `server/seed.js` (demo data, `AEGIS_DEMO=1`): `tenant()` and `user()` helpers create Bluebix and Northstar.
  - `server/lib/provision-bluebix.js` via `node server/index.js --provision-bluebix` (production, one fixed pilot tenant, admin from `AEGIS_PILOT_ADMIN_*` env vars).
- Once a workspace exists, everything else is self-serve: Company setup (guided 5 steps), Connections (HRMS connector, Slack), Settings (AI provider key, users and roles).
- **Uncommitted work on `ranjith-dev`:** the Company setup redesign (`public/app.js`, `public/system.css`, `server/views.js` `setupState` now returns `gap_items` and `source`). 56/56 tests pass. Commit it before starting sign-up.

## Goal

A new organisation can go to the sign-in screen, choose "Create a workspace", enter its details, and land in Company setup as the first administrator, with its data fully separate from every other organisation.

## Scope (first version)

1. **Sign-up form** (public, no login): organisation name, admin full name, work email, password (12+ characters), and a tick box agreeing to the terms. Optional: organisation type (healthcare staffing, other).
2. **Create workspace** in one database transaction:
   - `tenants` row: new `id`, unique `slug` derived from the name (add a number if taken), `kind = 'customer'`, random `webhook_secret` (24 bytes hex), `created_at`.
   - First `users` row with `role = 'admin'`, password hashed with `hashPassword` from `server/lib/util.js`.
   - Default `schedules` row for the daily digest (see `schedules()` in `server/seed.js`).
   - Audit entry `WORKSPACE_CREATED` via `P.audit` (the type already exists).
   - Start a session (same cookie as `POST /api/login`) and return `{ ok: true }`.
3. **Land in Company setup** (`#setup`). It already guides an empty workspace step by step.
4. **Email verification** before the workspace can send messages to workers or connect Slack. Until verified, show a banner: "Check your inbox to confirm your email." Store `email_verified_at` on `users`. In development, log the link to the console. Real email uses the existing Resend integration in `server/channels.js` (`RESEND_API_KEY`).

Not in this version: billing, custom domains, SSO, inviting other admins by email (Settings > Users already adds users by hand), and cloud hosting (the user has said not to build hosting or cloud storage until asked).

## Backend changes

- `server/routes.js`
  - `POST /api/signup` (public). Validate: name 2 to 120 characters, email format, email not already in `users` (users.email is globally UNIQUE; return a neutral 409 "An account already exists for this email. Sign in instead."), password 12+ characters, terms accepted. Rate-limit per IP (like the 20-per-token limit on `/api/submit/:token`).
  - `GET /api/verify-email/:token` (public). Marks `email_verified_at`, redirects to `/#setup`.
  - `GET /api/public/info`: add `signup: true` when sign-up is enabled (env `AEGIS_SIGNUP=1`; default on in development, off in production until the team switches it on).
- `server/lib/db.js`: add `email_verified_at TEXT` to `users` and a `verify_tokens(token_hash, user_id, expires_at)` table. Follow the existing migration pattern in that file for both SQLite and Postgres.
- New `server/lib/workspace.js` with `createWorkspace({ orgName, adminName, email, password })`, reused by `/api/signup` and by `provision-bluebix.js`, so both paths create identical workspaces.
- Block the risky actions until the email is verified: sending worker follow-ups, connecting Slack, adding an HRMS connector. Return 403 "Confirm your email first." The UI shows the banner.

## Frontend changes (`public/app.js`)

- Sign-in screen (`showLogin`): add "Create a workspace" below the sign-in form when `info.signup` is true.
- New sign-up screen in the same visual style as the sign-in screen: one column, plain labels, inline validation messages under each field, button "Create workspace", link "Already have an account? Sign in".
- After sign-up: load the app and go to `#setup`. Show a dismissible banner until the email is verified.
- Copy: sentence case, short, specific. Errors say what happened and how to fix it.

## Tests (`test/workflow.test.js`, Node test runner, `npm test`)

1. Sign-up creates a tenant, an admin user, a digest schedule and a `WORKSPACE_CREATED` audit entry. The session cookie works for `GET /api/me`.
2. The new workspace sees **none** of Bluebix's workers, cases, evidence, audit entries, dashboards or reports (check each list endpoint).
3. A duplicate email returns 409. A short password returns 400. Repeated attempts are rate-limited.
4. Before verification, `POST /api/cases/:id/follow-up` and connecting Slack return 403. After `GET /api/verify-email/:token` they work.
5. A verify token cannot be used twice and expires.
6. `--provision-bluebix` still works and now uses `createWorkspace`.

## Acceptance check by hand

1. Start the demo server (`.claude/launch.json` config `aegis-api-check`, port 4101).
2. Sign out, choose "Create a workspace", sign up as a new organisation.
3. You land on Company setup with "0 of 5 steps done". Complete the steps (add a worker, confirm the location, activate a pack, choose the channel).
4. Sign out, sign in as `sathinath@bluebix.demo` and confirm none of the new organisation's data appears.

## Design rules the user expects

- Product grade, not template: no icon tiles with badges on every card, no rainbow bars, no all-caps labels, no "A · B · C" text strings, no fade-in on every panel.
- Reuse the existing patterns: panels with a plain heading and a one-line subtitle, tables with a bold name and grey line under it, colour only where it means status.
- Check every screen at 1440px, 1280px and phone width (390px), and confirm the numbers on screen match the API.
- Show before/after screenshots to the user. Commit only when asked.
- Never claim "100% compliant"; say "all checks in the defined scope pass".

## Security notes

- Never log passwords or tokens. Store only hashes of session and verify tokens (as the code already does for sessions).
- Use generic wording for "email already exists" if account enumeration becomes a concern.
- Keep `x-aegis-client: web` required on POST routes (the existing CSRF guard); `POST /api/signup` should require it too.
- Change the database password that was found in git history earlier, if not done yet.
