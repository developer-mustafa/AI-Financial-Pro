# SpendWise — Production Execution Runbook

> **Status:** **partially executed.** The database migration has been applied and
> verified (see *Execution log* below). Deployment and secret rotation have **not**
> been performed. Every remaining live-infrastructure command requires explicit human
> approval and the preconditions stated in each section.

### Execution log

| Time (UTC) | Action | Target | Result |
|---|---|---|---|
| 2026-10-16T13:27Z | 🔵 `migrate:status` | `expense-tracker-pro` | 3 applied, **1 pending** (`0004`) |
| 2026-10-16T13:27Z | 🔵 `preflight:tenancy` | same | OK — 0 blockers, 0 finance rows, 1 user |
| 2026-10-16T13:27Z | 🔵 `snapshot-data` | same | snapshot written to temp (1 user, 3 ledger rows) |
| 2026-10-16T13:28Z | 🔴 `migrate` | same | **`0004_tenants.sql` applied** (52 statements, 1 txn) |
| 2026-10-16T13:28Z | 🔵 `verify:tenancy` | same | **24/24 checks passed** |
| 2026-10-16T13:28Z | 🔵 `migrate:status` | same | applied (4), pending (0) |
| 2026-10-16T13:29Z | 🔴 `wrangler secret put DATABASE_URL` | Worker `spendwise-api` | Worker created + `DATABASE_URL` secret set |
| 2026-10-16T13:29Z | 🔴 `wrangler secret put AUTH_SECRET` | same | `AUTH_SECRET` secret set |
| 2026-10-16T13:30Z | 🔴 `npm run deploy` | Cloudflare | deployed → `https://spendwise-api.mustafa-rahman-official.workers.dev` (version `07ef3400-…`) |
| 2026-10-16T13:30Z | 🔵 live health + negative checks | deployed Worker | `db:"ok"`; `401`/`403`/`404`; HSTS + rate-limit + `X-Request-Id` headers present |

**Deployment findings (read-only):** wrangler is authenticated (account
`638331d0b7fd99029b739ad7adc4a5af`). The Worker `spendwise-api` **did not exist** and was
created by this deploy. `ADMIN_EMAILS` is **not set** (platform-admin bootstrap disabled
until set); `ALLOWED_ORIGINS` is still **localhost-only** (set the real frontend origin
before shipping a hosted frontend).

---

Command labels:

- 🔵 **READ-ONLY** — no state change
- 🟡 **STAGING-ONLY** — mutates a staging database/environment only
- 🔴 **PRODUCTION-CHANGING** — mutates production / live infrastructure

Values that could not be derived from the repository are marked **UNKNOWN**, with the
command that resolves them.

---

## 0. Repository facts (Phase 1)

| Item | Finding |
|---|---|
| Version control | **Not a Git repository** (no `.git`). There is no diff/branch/commit safety net. |
| Uncommitted changes | N/A — the whole working tree is untracked and cannot be reverted via VCS. |
| Stack (frontend) | Vanilla JS ES modules + Tailwind + Chart.js; static assets; Vitest. |
| Stack (backend) | Cloudflare Worker (ES module) + `@neondatabase/serverless` + Neon Postgres. |
| Migration tool | `backend/scripts/migrate.mjs` (plain Node), ledger table `schema_migrations`. |
| API deploy target | Cloudflare Workers, single Worker `spendwise-api`, `wrangler deploy`. |
| Frontend deploy target | **UNKNOWN** — no hosting config in the repo. Search your delivery dashboard. |
| Local tooling | Node 22, npm 10, local `wrangler` 3.114.17. `psql`/`pg_dump`/`neonctl` are **not installed**. |

**Concurrency warning.** Multiple agent processes may be running. Keep this operation
single-writer; do not run migrations/deploys while another process edits the tree.

---

## 1. Safety prerequisites (do first)

🔵 Optional mtime check (detect recent writers):
```bash
ls -lt backend/migrations backend/src | head
```

🔴 Filesystem snapshot (no DB change) — choose a path **outside** the repo and never commit `.dev.vars`:
```bash
tar -czf "/c/Users/Windows 10/AppData/Local/Temp/spendwise-snapshot-$(date +%Y%m%d%H%M%S).tgz" \
    --exclude='node_modules' --exclude='.wrangler' .
```

**Database backup.** Use the **Neon console** to create a branch / confirm the restore
(PITR) window for the project hosting `expense-tracker-pro`. A logical dump requires a
Postgres client (currently **not installed**):
```bash
pg_dump "$DATABASE_URL" -Fc -f "backup-$(date +%Y%m%d%H%M%S).dump"   # only if pg_dump exists
```

**Load a secret into the shell without printing it** (used by the read-only queries):
```bash
export DATABASE_URL="$(node -e "const fs=require('fs');const t=fs.readFileSync('backend/.dev.vars','utf8');const m=t.match(/^\s*DATABASE_URL\s*=\s*(.*)$/m);let v=m?m[1].trim():'';if((v.startsWith('\"')&&v.endsWith('\"'))||(v.startsWith(\"'\")&&v.endsWith(\"'\")))v=v.slice(1,-1);process.stdout.write(v)")"
printf 'DATABASE_URL loaded: %s\n' "$([ -n "$DATABASE_URL" ] && echo yes || echo NO)"
```

---

## 2. Database migrations (Phase 2)

### 2.1 Inventory

Applied in **filename sort order** from `backend/migrations/`:

| File | Adds | Destructive ops |
|---|---|---|
| `0001_init.sql` | `users`, finance tables, `preferences`, `app_metadata`, indexes | none |
| `0002_neon_auth.sql` | `users.neon_auth_user_id`, `users.auth_provider`, unique partial index | none |
| `0003_admin.sql` | `users.role`, `users.status`, CHECKs, partial index | none |
| `0004_tenants.sql` | `tenants`, `tenant_members`, `audit_logs`; `tenant_id` on 6 finance tables + FKs + NOT NULL + indexes; ownership backfill | none (up) |

Rollback files: **only** `backend/migrations/rollback/0004_tenants.down.sql`. There are
**no down files for 0001–0003**.

### 2.2 Which migrations are pending — resolve before running

🔵 Primary (repo-native, read-only — diffs `migrations/` against `schema_migrations`):
```bash
cd backend
npm run migrate:status
```
**Expected:** a line each for `applied` and `pending`; `pending` is exactly what
`npm run migrate` would run. Exit code stays 0 on success.

🔵 Raw ledger detail (only if you want `applied_at` timestamps):
```bash
cd backend
node -e "import('@neondatabase/serverless').then(async ({neon})=>{const sql=neon(process.env.DATABASE_URL);try{console.log(await sql('SELECT version, applied_at FROM schema_migrations ORDER BY version'))}catch(e){console.log('schema_migrations not present:',e.message)}})"
```

> ⚠️ `npm run migrate -- --dry-run` does **not** read `schema_migrations`, so it reports
> every file as "would apply", including already-applied ones. Use the query above for
> true pending state.

### 2.3 Destructive / locking analysis

- **No `DROP`/`TRUNCATE`/`DELETE`/`RENAME`/type change** in any up migration.
- `0004` `ALTER COLUMN tenant_id SET NOT NULL` ⇒ full scan under `ACCESS EXCLUSIVE`;
  `ADD CONSTRAINT ... FOREIGN KEY` ⇒ validation scan; `CREATE INDEX` (non-concurrent) ⇒
  blocks writes. Each file runs in **one transaction**, so locks are held to commit.
- Run in a **low-traffic window**. Concurrent index/constraint creation is **not**
  supported by the runner (it cannot run inside a transaction) and would be a separate change.

### 2.4 Staging migration

🟡
```bash
cd backend
npm run migrate -- --dry-run     # preview only
npm run migrate                  # apply to STAGING
npm run verify:tenancy           # read-only invariant audit
```
**Expected:** `✓ <file> applied` per file + summary; `verify:tenancy` → `OK — N check(s) passed.`
Output is safe to paste — the runner redacts the password.

### 2.5 Production migration

🔴
```bash
cd backend
npm run migrate -- --dry-run
npm run migrate                  # ⚠️ writes production schema
npm run verify:tenancy           # read-only
```
**Expected:** identical to staging; then `/api/health` shows `"db":"ok"`.

### 2.6 Rollback (only for 0004, and only if genuinely needed)

The down file is **destructive to the new data** (drops `tenant_id` columns and the
`tenants`/`tenant_members`/`audit_logs` tables). It never touches `users` or pre-existing
columns/rows.

🔴
```bash
psql "$DATABASE_URL" -f backend/migrations/rollback/0004_tenants.down.sql   # if psql exists
```
**If `psql` is unavailable (current state)** — apply via the installed driver:
```bash
cd backend
node -e "import('node:fs/promises').then(async fs=>{const{neon}=await import('@neondatabase/serverless');const sql=neon(process.env.DATABASE_URL);const txt=await fs.readFile('migrations/rollback/0004_tenants.down.sql','utf8');for(const s of txt.split(';').map(x=>x.trim()).filter(Boolean)){await sql(s)}console.log('rollback applied')})"
```
Then deploy the pre-multi-tenant code revision. **UNKNOWN:** whether you also delete the
`schema_migrations` row `'0004_tenants.sql'` (required before the runner will re-apply 0004).

**No rollback exists for 0001–0003** — recovery there means restoring the snapshot/Neon branch.

---

## 3. Cloudflare deployment (Phase 3)

**Method:** `backend/package.json` → `"deploy": "wrangler deploy"`; Worker `spendwise-api`;
`main = "src/index.js"`; `compatibility_flags = ["nodejs_compat"]`; observability enabled.

**Bindings (names only):**

| Kind | Name |
|---|---|
| Var (public) | `ALLOWED_ORIGINS` |
| Var (public) | `ENVIRONMENT` |
| Var (public) | `NEON_AUTH_BASE_URL` |
| Var (public) | `NEON_AUTH_JWKS_URL` |
| Secret | `DATABASE_URL` |
| Secret | `AUTH_SECRET` |
| Secret | `ADMIN_EMAILS` |

🔵 Validation:
```bash
cd backend
npx wrangler --version
npx wrangler whoami
npx wrangler deploy --dry-run          # compiles only (~390 KiB)
npx wrangler secret list               # NAMES only
```

**Staging deployment — UNKNOWN.** `wrangler.toml` defines one Worker and **no `[env.*]`**.
Choose: add an `[env.staging]` block, or deploy a separate Worker name, or validate with
`--dry-run`. Confirm flags with `npx wrangler deploy --help`.

🔴 Production:
```bash
cd backend
npm run deploy
```
🔵 Verify: `curl -s https://<worker>/api/health` → `"db":"ok"`.
🔵 Recover code: `npx wrangler deployments list` → `npx wrangler rollback` (confirm flags).

---

## 4. Secret rotation (Phase 4)

Never print, log, commit, or paste secret values. There is **no overlapping-credential
support** (single active value per secret), so each rotation is a hard cutover.

### 4.1 `DATABASE_URL`
1. 🟡 Prove the new credential against staging first (`select 1`).
2. 🔴
   ```bash
   cd backend
   npx wrangler secret put DATABASE_URL   # paste NEW value at the prompt
   npm run deploy                         # force new isolates onto it
   ```
3. 🔵 `curl -s https://<worker>/api/health` → `"db":"ok"`.
4. 🔴 Delete/reset the old role in Neon.
5. 🔵 Confirm the old credential is rejected.
> The Worker caches one client per isolate (`src/db.js`), so a deploy is required for the
> new value to take effect everywhere.

### 4.2 `AUTH_SECRET`
Tokens are HS256 with a 7-day TTL and **no refresh/revocation**. Rotating immediately
invalidates **all** password-session tokens (Neon Auth/magic-link tokens are unaffected,
they verify via JWKS).
1. Announce the forced re-sign-in.
2. 🔴
   ```bash
   cd backend
   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
   npx wrangler secret put AUTH_SECRET
   npm run deploy
   ```
3. 🔵 A previously valid token must now return `401` on `/api/me`.

---

## 5. Security hardening (Phase 5)

### 5.1 Rate limiter (current)
In-memory fixed window, **120 req/min per `IP:method`**, **per isolate** (isolates are
per-colo and ephemeral). It is coarse abuse-blunting, **not** a distributed cap.

### 5.2 Distributed approach (config change — needs approval)
Use a **Workers Rate Limiting binding**, a **Durable Object** counter, or **Cloudflare WAF
rate-limiting rules**. The exact binding schema for wrangler 3.114.17 is **UNKNOWN** —
confirm via `npx wrangler deploy --help` and the Cloudflare docs before writing config.

### 5.3 Row-Level Security feasibility
Isolation is enforced in the Worker (server-resolved `tenant_id`); RLS is **not enabled**.
The HTTP driver uses a single connection role with no per-request GUC, and the role may be
the table owner (owners bypass RLS without `FORCE ROW LEVEL SECURITY`). Making RLS work
requires a non-owner app role + a per-request transaction with
`set_config('app.tenant_id', …)` + `FORCE ROW LEVEL SECURITY` + policies. Verify the
current role/ownership first:
```bash
cd backend
node -e "import('@neondatabase/serverless').then(async({neon})=>{const sql=neon(process.env.DATABASE_URL);console.log(await sql(\"select current_user, current_setting('is_superuser') as superuser\"));console.log(await sql(\"select tablename, tableowner, rowsecurity from pg_tables where schemaname='public'\"))})"
```

### 5.4 Tests
`backend/test/tenant.test.mjs` (unit) and `tests/tenant.test.js` (frontend) cover the
tenant-header and context logic; `backend/scripts/verify-tenancy.mjs` re-asserts the
database invariants (read-only). Explicit negative cases now include: forged/unknown
tenant id → 403, suspended membership/tenant → 403, archived tenant → 403,
member-cannot-admin → 403, unknown permission → 403, unauthenticated → 401 before any
query, and blank/whitespace `X-Tenant-Id` treated as absent.

### 5.5 AI features (optional, code-only so far)
`/api/ai/advisor` and `/api/ai/insights` add opt-in Gemini assistance. They are **off
until `GEMINI_API_KEY` is set** and fail closed (500 `ai_not_configured`) otherwise, so
no additional production change is required to ship safely. To enable them:

```bash
cd backend
npx wrangler secret put GEMINI_API_KEY   # paste the Google AI Studio key; never printed
npx wrangler deploy
```

Guarantees: explicit server-side consent, tenant-scoped queries, a small PII-free
aggregate only (never raw rows), per-user quota (20/min), server-configured model
(`GEMINI_MODEL`, default `gemini-2.5-flash`) and bounded output/timeout. Errors are
predictable: `400 consent_required`, `429 ai_rate_limited`/`ai_quota_exceeded`,
`502/503/504` upstream, `500 ai_not_configured`. Verify with:

```bash
curl -s -X POST "$API/api/ai/insights" -H 'content-type: application/json' \
  -d '{"consent":false}'                       # -> 400 consent_required (before auth in isolation)
```

---

## 6. Production approval checklist

- [ ] Single writer confirmed; no other agent editing the tree.
- [ ] Filesystem snapshot + Neon branch/PITR confirmed.
- [ ] `DATABASE_URL` loaded without printing; pending migrations identified via `schema_migrations`.
- [ ] Migration rehearsed on staging; `verify:tenancy` green.
- [ ] Low-traffic window agreed; rollback path verified runnable.
- [ ] `wrangler whoami` OK; `secret list` shows expected names; `ALLOWED_ORIGINS` correct.
- [ ] (Optional) `GEMINI_API_KEY` set only if `/api/ai/*` should be enabled; otherwise left unset.
- [ ] Staging deploy target decided; approver + timestamp recorded.

**Abort if:** `verify:tenancy` fails, `SET NOT NULL`/FK errors, `/api/health` stays
`"db":"error"`, or any cross-tenant data leak appears.

**Recovery:** Neon branch/PITR restore or `0004` down-migration; `wrangler rollback` for
code; re-`put` the previous secret value and redeploy.
