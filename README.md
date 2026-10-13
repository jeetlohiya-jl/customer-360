# Customer 360

Cirkla's internal customer-intelligence app: Gmail-sourced business knowledge with a Slack assistant. This repository is at **Phase 2**: Workspace sign-in plus a **Gmail connection proof of concept**. An employee can connect their own mailbox (read-only `gmail.metadata`), see up to five recent message headers fetched live from the Gmail API, and disconnect. The UI follows the Cirkla visual identity.

**Not included yet:** email import or storage, background sync, push notifications, AI extraction, Slack. Slack is hard-disabled (`FEATURE_SLACK` must be `off`).

Architecture and policies: see the Customer 360 architecture plan (revision 3) shared with the team. The Phase 1 report is in [`docs/phases/phase-1.md`](docs/phases/phase-1.md).

## Stack

| Part | Choice |
| --- | --- |
| Web app | Next.js 16 (App Router), React 19, TypeScript strict |
| Auth | Supabase Auth, Google provider, restricted to the `gocirkla.com` Workspace |
| Database | Supabase Postgres (local stack for development; hosted project later) |
| Validation | Zod (environment and inputs) |
| Tests | Vitest (unit), pgTAP (database), Node scripts (bundle and header checks) |
| CI | GitHub Actions: app checks, database tests, gitleaks secret scan |

## Prerequisites

- **Node.js 22.12 or newer** (`node -v`). Install from nodejs.org or with `nvm install 22`.
- **Git**.
- **Docker Desktop** (optional): only to run the local Supabase stack. Without Docker you can still run unit tests, the build and the header checks, and CI runs the database tests for you.

## Quick start

Run these in a terminal (macOS Terminal, Windows PowerShell or Git Bash), inside the repository folder.

```bash
npm ci                        # install the exact dependency versions from package-lock.json
cp .env.example .env.local    # create your local config (Windows PowerShell: Copy-Item .env.example .env.local)
npm test                      # unit tests (no network, no database)
```

### Run the app locally (needs Docker)

```bash
npm run db:start              # starts a local Supabase stack in Docker and applies migrations + synthetic seed
npx supabase@2.120.0 status   # shows the local API URL and the "anon"/publishable key
```

Put the URL and key from `status` into `.env.local` (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`), then:

```bash
npm run dev                   # http://localhost:3000
```

You'll see the sign-in page. **Real Google sign-in needs a Google OAuth client**, which is created at the Phase 1 review checkpoint (see "Hosted setup"). To test sign-in locally after that: in `supabase/config.toml` set `[auth.external.google] enabled = true`, export `SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID` and `SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET` in your shell (never commit them), and restart with `npm run db:stop && npm run db:start`.

Stop the local stack with `npm run db:stop`.

## Commands

| Command | What it does |
| --- | --- |
| `npm run lint` | ESLint (Next.js core-web-vitals + TypeScript rules) |
| `npm run typecheck` | TypeScript, no emit |
| `npm test` | Unit tests (Vitest) |
| `npm run build` | Production build. Needs the variables from `.env.example` set (use `.env.local`) |
| `npm run check:bundle` | After a build: fails if any server-only variable name or value appears in browser files |
| `npm run check:headers` | After a build: starts the app on port 3999 and verifies security headers, CSP nonce, redirects and the health endpoint |
| `npm run verify` | All of the above in order |
| `npm run db:start` / `db:stop` / `db:reset` | Local Supabase stack (Docker) |
| `npm run db:test` | pgTAP database tests on the local Supabase stack |
| `npm run db:test:local` | Same tests on a temporary plain PostgreSQL (no Docker; needs PostgreSQL 16 + pgTAP + pg_prove installed) |

## Configuration

Every variable is listed in [`.env.example`](.env.example) with placeholders only. Rules:

- `NEXT_PUBLIC_*` values are shipped to browsers. Only `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` are allowed. The app refuses to start if any other `NEXT_PUBLIC_` variable exists.
- Secrets never go in the repository. Locally they live in `.env.local` (git-ignored). In Vercel they go in Project Settings → Environment Variables.
- A missing or malformed variable stops the app: every request returns HTTP 500, and the log names the variable, never its value.

## Security model (Phase 1)

- **Sign-in:** Google only, identity scopes only (`openid email profile`). The server checks the verified email is exactly `@gocirkla.com` **and** Google's hosted-domain (`hd`) claim is `gocirkla.com`, so consumer Google accounts using a company address are rejected.
- **Database enforcement:** a trigger on `auth.users` rejects any identity that fails the same check, even if app code were bypassed.
- **Row Level Security** on every table. Members see only their own row; admins see all users and the audit log; departed users see nothing. No table is writable by clients; changes go through checked functions that write the audit log.
- **Roles:** the first admin is set once with `private.grant_initial_admin(email)` by the database owner. After that, only admins grant roles, and an admin can't change their own role, so there's always at least one admin.
- **Headers:** per-request nonce Content-Security-Policy (no inline scripts), HSTS, frame denial, nosniff, strict referrer policy, permissions policy.
- **Secrets:** CI scans the browser bundle for server-only values and scans git history with gitleaks.

## Gmail connection (Phase 2)

- Turn on with `FEATURE_GMAIL=on` plus `GOOGLE_GMAIL_CLIENT_ID`, `GOOGLE_GMAIL_CLIENT_SECRET` and `TOKEN_ENCRYPTION_KEY` (see `.env.example`). The app refuses to start if any is missing.
- The Google OAuth client "Customer 360 - Gmail" needs these redirect URIs: `http://localhost:3000/api/oauth/gmail/callback` and `https://<production-domain>/api/oauth/gmail/callback`.
- Only `https://www.googleapis.com/auth/gmail.metadata` is requested (headers and labels, never bodies). A unit test fails if any other Gmail scope appears in the code.
- The refresh token is encrypted (AES-256-GCM) before it reaches the database and stored in `private.gmail_connections`, reachable only through functions that act on the signed-in user.
- Apply the migration with `npx supabase@2.120.0 db push --dry-run` (review), then `db push`.
- Details, tests and limitations: [`docs/phases/phase-2.md`](docs/phases/phase-2.md).

## Customer list and matching (Stage 3.0)

- Admin pages under `/customers`: CSV import with preview, customer pages, review queue, name checker. No Gmail access.
- CSV template: [`docs/templates/customers-template.csv`](docs/templates/customers-template.csv).
- Migration `20261013000005_customer_master.sql`: review it, run `npx supabase@2.120.0 db push --dry-run`, apply only after approval.
- Details: [`docs/phases/phase-3.0.md`](docs/phases/phase-3.0.md).

## Hosted setup (at the Phase 1 review checkpoint, not before)

Follow section 7 ("Final setup checklist") of the architecture plan: Supabase project in `us-east-1`, Google Cloud project with an **Internal** OAuth consent screen and a "Sign-in" OAuth client, Vercel project with function region `iad1`. Hosted migrations will run only through an approved GitHub Actions workflow in a later phase. **Do not run `supabase db push` against a hosted project.**

After the first real sign-in on the hosted project, make yourself the first admin in the Supabase SQL editor:

```sql
select private.grant_initial_admin('your.name@gocirkla.com');
```

## Rollback

- **App:** in Vercel, open Deployments and use "Instant Rollback" on the previous deployment. In git, `git revert <commit>` (never force-push).
- **Database (local or disposable only):** run the scripts in `supabase/rollback/` in reverse order (`…003…`, then `…002…`, then `…001…`). They are tested by `npm run db:test:local`. The `…002…` rollback drops `app_users` and `audit_log`; it must never be run against a hosted database without explicit approval.

## Project structure

```text
app/                    routes: /login, /auth/callback, /dashboard, /admin, /api/health
lib/env.ts              environment schema (fails closed)
lib/auth/               Workspace domain checks, sign-in scopes, session helpers
lib/security/headers.ts CSP and security headers
lib/supabase/           server and proxy Supabase clients (anon key + user session only)
proxy.ts                per-request CSP nonce, session refresh, sign-in redirect
instrumentation.ts      validates configuration at server start
supabase/migrations/    schema, triggers, functions, RLS
supabase/tests/         pgTAP tests
supabase/rollback/      reverse migrations
supabase/seed.sql       synthetic local users only
tests/unit/             Vitest tests
scripts/                bundle scan, header checks, no-Docker database test runner
docs/phases/            phase reports
```
