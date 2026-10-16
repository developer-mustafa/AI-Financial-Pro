# SpendWise API (`spendwise-api`)

Backend for the SpendWise expense tracker. Cloudflare Workers (ES modules) +
[`@neondatabase/serverless`](https://github.com/neondatabase/serverless) + NeonDB
PostgreSQL. Vanilla JavaScript only — no TypeScript, no frameworks, no Express.

---

## Architecture

```
                         HTTPS + Bearer token
  ┌───────────────────┐        (CORS origin allow-list)        ┌──────────────────────┐
  │  SpendWise        │  ────────────────────────────────────▶ │  Cloudflare Worker   │
  │  frontend         │                                        │  (this project)      │
  │  (vanilla JS)     │  ◀──────────────────────────────────── │  src/index.js        │
  └───────────────────┘        JSON  { data | error }          │  routes/*.js         │
                                                               │  validate.js         │
                                                               │  auth.js (WebCrypto) │
                                                               │  http.js (CORS/rate) │
                                                               └──────────┬───────────┘
                                                                          │  parameterized SQL
                                                                          │  (Neon HTTP driver)
                                                               ┌──────────▼───────────┐
                                                               │  NeonDB PostgreSQL    │
                                                               │  expense-tracker-pro  │
                                                               │  users, accounts,     │
                                                               │  categories,          │
                                                               │  transactions,        │
                                                               │  budgets,             │
                                                               │  recurring_rules,     │
                                                               │  goals, preferences,  │
                                                               │  app_metadata,        │
                                                                │  tenants,             │
                                                                │  tenant_members,      │
                                                                │  audit_logs           │
                                                               └───────────────────────┘
```

Secrets (`DATABASE_URL`, `AUTH_SECRET`) live only in Worker bindings and are
never sent to the browser.

Money is stored as **integer minor units** (`bigint`, e.g. poisha/cents) with a
`_minor` column suffix. See the header of `migrations/0001_init.sql` for why.

---

## Files

```
backend/
├── package.json            scripts: dev, deploy, migrate, verify:tenancy, test
├── wrangler.toml           worker config + secret instructions
├── .dev.vars.example       local secret template (copy to .dev.vars)
├── .gitignore              ignores node_modules, .dev.vars, .env, .wrangler
├── README.md
├── migrations/
│   ├── 0001_init.sql       idempotent, non-destructive schema
│   ├── 0002_neon_auth.sql  adds users.neon_auth_user_id / auth_provider (additive)
│   ├── 0003_admin.sql      adds users.role / users.status for the admin role (additive)
│   ├── 0004_tenants.sql    tenants + tenant_members + audit_logs + per-table tenant_id
│   └── rollback/
│       └── 0004_tenants.down.sql   manual rollback (never applied automatically)
├── scripts/
│   ├── migrate.mjs         plain-node migration runner (--dry-run)
│   └── verify-tenancy.mjs  read-only post-migration tenancy invariant checks
├── src/
│   ├── index.js            routing + middleware (thin)
│   ├── http.js             CORS, headers, errors, body cap, rate limiter
│   ├── auth.js             PBKDF2 passwords, HMAC tokens, request auth (WebCrypto)
│   ├── neonAuth.js         Neon Auth JWT verification (EdDSA + JWKS cache)
│   ├── tenant.js           tenant context, tenant roles/permissions, provisioning
│   ├── audit.js            append-only administrative audit trail
│   ├── db.js               Neon client + query/batch/tx helpers
│   ├── validate.js         field whitelists, coercion, SQL builders
│   └── routes/
│       ├── health.js
│       ├── auth.js
│       ├── admin.js        super-admin user management (role-gated)
│       ├── tenant.js       the caller's own workspace: profile, members, audit
│       ├── platform.js     platform administration: tenants, users, audit (role-gated)
│       ├── state.js
│       ├── crud.js
│       ├── preferences.js
│       └── sync.js
└── test/
    ├── api.test.mjs        node --test suite (no DB / no Workers needed)
    ├── tenant.test.mjs     roles/permissions, tenant context, scoped SQL builders
    └── neonAuth.test.mjs   real Ed25519 JWTs vs. a synthetic JWKS
```

---

## API endpoints

All responses are JSON. Errors use `{ "error": { "code", "message" } }`.
`Authorization: Bearer <token>` is required everywhere except `/api/health`,
`/api/auth/register`, and `/api/auth/login`.

The bearer token may be **either**:

- the Worker's own HS256 token (email + password accounts), or
- a **Neon Auth** EdDSA/Ed25519 JWT from Managed Better Auth (magic link, and any OAuth
  provider you enable), verified against the JWKS endpoint. See
  [Magic-link sign-in](#magic-link-sign-in-neon-auth).

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/health` | no | `{ok, service, db:'ok'\|'error', time}` (200 even if DB is down) |
| POST | `/api/auth/register` | no | `{email,password,name?}` → 201 `{token,user,memberships,defaultTenantId}` |
| POST | `/api/auth/login` | no | `{email,password}` → 200 `{token,user,memberships,defaultTenantId}` |
| POST | `/api/auth/logout` | yes | 204 (stateless token — client discards it) |
| GET | `/api/auth/me` | yes | `{user,memberships,defaultTenantId}` (provisions the personal workspace on first call) |
| GET | `/api/state` | yes | full state blob (camelCase) |
| PUT | `/api/state` | yes | `{state}` → `{ok,counts}` (one transaction, replaces this user's rows) |
| GET | `/api/transactions` | yes | `{items,total,limit,offset}` `?limit=&offset=&sort=&order=` |
| GET | `/api/transactions/:id` | yes | record or 404 |
| POST | `/api/transactions` | yes | 201 record (client supplies `id`; duplicate → 409) |
| PATCH | `/api/transactions/:id` | yes | 200 record or 404 |
| DELETE | `/api/transactions/:id` | yes | 204 or 404 |
| … | `/api/categories`, `/api/accounts`, `/api/budgets`, `/api/recurring-rules`, `/api/goals` | yes | same CRUD shape as transactions |
| GET | `/api/preferences` | yes | `{preferences,updatedAt}` |
| PUT | `/api/preferences` | yes | `{preferences}` → `{preferences}` |
| POST | `/api/sync` | yes | `{changes:[{resource,op:'upsert'\|'delete',record\|id}]}` → `{applied,failed}` (max 500) |
| GET | `/api/tenants` | yes | workspaces the caller is an active member of |
| GET | `/api/tenants/current` | yes | `{tenant,role,tenantId}` for the resolved workspace |
| PATCH | `/api/tenants/current` | tenant admin | `{name?,slug?,settings?}` → `{tenant}` |
| GET | `/api/tenants/current/members` | tenant admin | `{items}` |
| POST | `/api/tenants/current/members` | tenant admin | `{email,role?}` → 201 `{member}` |
| PATCH | `/api/tenants/current/members/:userId` | tenant admin | `{role?,status?}` → `{member}` |
| DELETE | `/api/tenants/current/members/:userId` | tenant admin | 204 (membership only) |
| GET | `/api/tenants/current/audit` | tenant admin | `{items,total,limit,offset}` |
| GET | `/api/platform/overview` | **platform admin** | platform totals + usage |
| GET | `/api/platform/tenants` | **platform admin** | `{items,total,limit,offset}` `?q=&status=&type=&sort=&order=` |
| POST | `/api/platform/tenants` | **platform admin** | `{name,slug?,ownerEmail?}` → 201 `{tenant}` |
| GET | `/api/platform/tenants/:id` | **platform admin** | `{tenant,members}` |
| PATCH | `/api/platform/tenants/:id` | **platform admin** | `{name?,slug?,status?,settings?}` (activate/suspend/archive) |
| DELETE | `/api/platform/tenants/:id` | **platform admin** | soft **archive** only (`?hard=true` → 403) |
| POST | `/api/platform/tenants/:id/members` | **platform admin** | `{email,role?}` → 201 `{member}` |
| PATCH | `/api/platform/tenants/:id/members/:userId` | **platform admin** | `{role?,status?}` → `{member}` |
| DELETE | `/api/platform/tenants/:id/members/:userId` | **platform admin** | 204 (membership only) |
| GET | `/api/platform/users` | **platform admin** | `{items,total,limit,offset}` `?q=` |
| POST | `/api/platform/users` | **platform admin** | `{email,password,name?,role?}` → 201 `{user}` |
| GET | `/api/platform/users/:id/memberships` | **platform admin** | `{items}` memberships |
| GET | `/api/platform/audit` | **platform admin** | `{items,total,limit,offset}` `?tenantId=&actorId=&action=` |
| GET | `/api/admin/users` | **admin** | `{items,total,limit,offset}` `?limit=&offset=&q=` |
| POST | `/api/admin/users` | **admin** | `{email,password,name?,role?}` → 201 `{user}` |
| GET | `/api/admin/users/:id` | **admin** | `{user}` or 404 |
| PATCH | `/api/admin/users/:id` | **admin** | `{role?,status?,name?}` → `{user}` |
| DELETE | `/api/admin/users/:id` | **admin** | 204 or 404 (cascades to that user's finance rows) |
| GET | `/api/tenants` | yes | the caller's active workspaces `{tenants:[…]}` (for the switcher) |
| GET | `/api/tenants/current` | yes (tenant) | `{tenant,role,tenantId}` for the resolved `X-Tenant-Id` |
| PATCH | `/api/tenants/current` | **tenant admin** | `{name?,slug?,settings?}` → `{tenant}` |
| GET | `/api/tenants/current/members` | yes (tenant) | `{items}` memberships of the current workspace |
| POST | `/api/tenants/current/members` | **tenant admin** | `{email,role?}` → 201 `{member}` (existing account only) |
| PATCH | `/api/tenants/current/members/:userId` | **tenant admin** | `{role?,status?}` → `{member}` |
| DELETE | `/api/tenants/current/members/:userId` | **tenant admin** | 204 (removes the **membership**, not the account) |
| GET | `/api/tenants/current/audit` | yes (tenant) | `{items,total,limit,offset}` audit rows for this workspace |
| GET | `/api/platform/overview` | **admin** | `{tenants,users,usage}` platform totals |
| GET | `/api/platform/tenants` | **admin** | `{items,total,…}` `?q=&status=&type=&sort=&order=&limit=&offset=` |
| POST | `/api/platform/tenants` | **admin** | `{name,slug?,ownerEmail?}` → 201 `{tenant}` |
| GET | `/api/platform/tenants/:id` | **admin** | `{tenant,members}` |
| PATCH | `/api/platform/tenants/:id` | **admin** | `{name?,slug?,status?,settings?}` → `{tenant}` |
| DELETE | `/api/platform/tenants/:id` | **admin** | **soft archive** `{tenant}` (`?hard=true` → 403) |
| POST | `/api/platform/tenants/:id/members` | **admin** | `{email,role?}` → 201 `{member}` |
| PATCH | `/api/platform/tenants/:id/members/:userId` | **admin** | `{role?,status?}` → `{member}` |
| DELETE | `/api/platform/tenants/:id/members/:userId` | **admin** | 204 (membership only) |
| GET | `/api/platform/users` | **admin** | `{items,total,…}` `?q=&limit=&offset=` |
| GET | `/api/platform/users/:id/memberships` | **admin** | `{items}` every workspace that user belongs to |
| GET | `/api/platform/audit` | **admin** | `{items,total,…}` `?tenantId=&actorId=&action=&limit=&offset=` |

Anything else → 404 JSON. There is **no** raw-SQL endpoint; `/api/sql`,
`/api/query`, `/api/exec`, `/api/raw`, etc. are explicitly refused with 403.

`/api/admin/*` requires the caller's own `users.role` to be `admin`; any other
account receives **403**. See [Super-admin & user management](#super-admin--user-management).

`/api/platform/*` is the platform-admin surface: it also requires `users.role === 'admin'`
and is documented under [Multi-tenancy](#multi-tenancy). Every finance route
(`/api/state`, `/api/<resource>`, `/api/sync`) is **tenant-scoped**: an optional
`X-Tenant-Id` request header *selects* a workspace but is honoured only when the caller has
an active membership in it (otherwise `403`); with no header the caller's personal
workspace is used.
`/api/platform/*` is likewise gated on `users.role === 'admin'` and never grants
implicit access to a workspace's finance data — see
[Multi-tenancy](#multi-tenancy--workspaces).

State shape returned by `GET /api/state`:

```json
{
  "schemaVersion": 1,
  "transactions": [], "categories": [], "accounts": [],
  "budgets": [], "recurringRules": [], "goals": [],
  "preferences": {},
  "metadata": { "createdAt": "", "updatedAt": "" }
}
```

---

## Security notes

- **Tenant isolation:** every finance query filters on a server-resolved `tenant_id`
  (with `user_id` kept as the row author). A request for another tenant's record returns
  **404**, never 403-with-data, and a forged/foreign `X-Tenant-Id` returns **403**.
- **Parameterized SQL only.** User values are always bound. SQL identifiers
  (table/column/sort) come only from hard-coded allow-lists.
- **Passwords:** PBKDF2-SHA256, 150 000 iterations, 16-byte random salt,
  32-byte key, stored as `pbkdf2$<iterations>$<saltB64>$<hashB64>`. Verified
  with a constant-time comparison.
- **Tokens:** compact HS256 `header.payload.signature` signed with
  `AUTH_SECRET`; carries `sub`, `iat`, `exp` (7 days), `jti`; verified with a
  constant-time signature compare and an expiry check. `AUTH_SECRET` must be
  ≥ 32 chars or the API fails closed with 500.
- **Neon Auth tokens (magic link):** verified **statelessly** against the published
  JWKS — Ed25519 signature (WebCrypto, 64-byte check), `alg === 'EdDSA'`, `exp`/`nbf`,
  `iss`/`aud` equal to the configured auth origin, and a known `kid` (one forced JWKS
  refetch on rotation). Keys are cached per isolate for 1 h. The header `alg` selects
  the verifier, so an "alg: HS256" token is only ever checked with the app secret and
  an "alg: EdDSA" token only with the JWKS. JWKS outages return **503** and never fall
  back to the legacy path.
- **Identity linking:** a verified Neon Auth `sub` maps to a `users` row — matched by
  `neon_auth_user_id`, then by case-insensitive email (linked in place so the same person
  keeps their data), otherwise inserted with a **sentinel password hash** that can never
  verify. Linking is refused (**403** `email_not_verified`) until the identity's email is
  verified, so an unverified address cannot take over an existing account. Each user keeps
  a personal workspace, and every finance row is keyed by its `tenant_id`.
- **Membership-verified tenant context:** a `X-Tenant-Id` header is only a selector — it
  is matched against an **active** `tenant_members` row for the authenticated user, and a
  suspended/archived workspace is refused with **403**. Platform-admin status grants no
  implicit access to finance data (the `/api/platform/*` surface is separate).
- **Administrative audit:** privileged actions append a row to `audit_logs` (actor,
  action, target, outcome, time). Audit writes are best-effort and never record
  credentials, tokens or financial values.
- **CORS:** origin allow-list from `ALLOWED_ORIGINS`; no-`Origin` and
  same-origin requests are processed. CORS is not authorization.
- **Rate limiting:** in-memory fixed window, 120 req/min per IP+method (429 +
  `Retry-After`). Every response also carries `X-RateLimit-Limit`,
  `X-RateLimit-Remaining` and `X-RateLimit-Reset`. Best-effort per isolate.
- **Body cap:** 1 MiB (413).
- **Headers:** `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
  `X-Frame-Options: DENY`, and `Strict-Transport-Security` (2 years, subdomains,
  not preloaded).
- **Request correlation:** every response echoes `X-Request-Id` — a trusted inbound
  `X-Request-Id`/`CF-Ray` when present, otherwise a generated id (unsafe inbound
  values are rejected to prevent header/log injection). The id is also exposed to
  handlers as `ctx.requestId`.
- **Structured logging:** one JSON access-log line per request
  (`requestId`, `method`, `path`, `status`, `durationMs`, and `userId` once known)
  via `console.log`, captured by Workers Logs. Real errors are logged server-side;
  clients get a generic `{error:{code,message}}` with no SQL, stack traces, or
  secrets.

---

## Local development

```bash
cd backend
npm install
cp .dev.vars.example .dev.vars      # then fill in real values
npm run migrate                     # apply migrations to your Neon DB
npm run dev                         # wrangler dev -> http://localhost:8787
```

`.dev.vars` (git-ignored) must contain:

```
DATABASE_URL="postgresql://USER:PASSWORD@HOST/expense-tracker-pro?sslmode=require"
AUTH_SECRET="<32+ random chars>"
```

Generate `AUTH_SECRET` with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Magic-link sign-in additionally needs two **public** (non-secret) values. They are set in
`wrangler.toml → [vars]` and may be overridden in `.dev.vars` for local work:

```
NEON_AUTH_BASE_URL="https://<endpoint>.neonauth.<region>.aws.neon.tech/<db>/auth"
NEON_AUTH_JWKS_URL=""   # optional; defaults to "${NEON_AUTH_BASE_URL}/.well-known/jwks.json"
```

Leave them empty to disable magic-link tokens; the Worker then only accepts its own
password tokens (an EdDSA token is refused with 503).

Run the tests (no database or Cloudflare account needed):

```bash
npm test
```

---

## Magic-link sign-in (Neon Auth)

The frontend talks to **Managed Better Auth** directly for sign-in; the Worker only
*verifies* the resulting token. No shared secret exists between the two.

```
  browser ──(email)──▶ POST <auth>/sign-in/magic-link        (HTTP-only cookie on <auth>)
     ▲                                                            │
     └────────────── email link ──▶ GET <auth>/magic-link/verify ─┘  → redirect back to the app
  browser ──GET <auth>/token──▶ short-lived EdDSA JWT (≈15 min)
  browser ──Authorization: Bearer <jwt>──▶ Worker
  Worker  ──GET <auth>/.well-known/jwks.json──▶ cache 1 h → verify Ed25519 signature + claims
  Worker  ──users lookup/insert by neon_auth_user_id (or email)──▶ NeonDB
```

Enable it once, in the Neon Console (project → **Settings → Better Auth**):

1. **Magic Link → Enable Magic Link.** Set the link expiry; enable *allow new user
   registration* if you want sign-ups (otherwise only existing accounts can sign in).
2. **Trusted origins:** add every origin the app is served from
   (`http://localhost:5173`, `http://127.0.0.1:5500`, and your production origin).
   `allow localhost` is on by default.
3. Copy the **Auth Base URL** into `NEON_AUTH_BASE_URL` (`wrangler.toml` `[vars]`).
4. Apply the new migration: `npm run migrate` (adds `users.neon_auth_user_id` and
   `users.auth_provider`; additive and safe to re-run).
5. Deploy, then set `runtime-config.js → neonAuthUrl` to the same base URL.

> **Email delivery:** the shared sender (`auth@mail.myneon.app`) is for
> development/testing only. Configure custom SMTP in the Console before production use.

Errors to expect:

| Situation | Response |
|---|---|
| No/invalid bearer token | `401 unauthorized` |
| Token expired, tampered, wrong issuer, or unknown `kid` after a refetch | `401 unauthorized` |
| `NEON_AUTH_BASE_URL` unset but an EdDSA token arrives | `503 auth_unavailable` |
| JWKS endpoint unreachable | `503 auth_unavailable` |

---

## Super-admin & user management

SpendWise has one privileged role, **`admin`**, stored in `users.role`
(`'user'` default, `'admin'` privileged) alongside `users.status`
(`'active'` default, `'suspended'`). Migration `0003_admin.sql` adds both.

### Creating the first administrator (bootstrap)

There is **no** seeded or hard-coded admin account. The first administrator is
whichever account's email is listed in the `ADMIN_EMAILS` **Worker secret**
(never a `[vars]` entry — admin emails are not public config):

```bash
cd backend
npx wrangler secret put ADMIN_EMAILS
# paste: owner@example.com,ops@example.com   (comma-separated)
```

The promotion happens automatically on that account's **first successful
sign-in** (password or magic link): the row's `role` flips to `admin`. Remove
an address from `ADMIN_EMAILS` and the account keeps the `admin` role it
already has — the secret only ever grants, never revokes. To revoke, use
`PATCH /api/admin/users/:id { "role": "user" }` from another admin.

For local development, put `ADMIN_EMAILS` in `backend/.dev.vars` (git-ignored;
see `.dev.vars.example`). Leaving it empty disables the bootstrap entirely, so a
fresh deployment has **no** administrator until you set it.

### Managing users

Once an admin is signed in, the API and the app's **User Management** screen
(sidebar → System → *User Management*, `/admin`) can:

- list and search every account (`?q=` matches email or name);
- create an account with a password, optionally already an admin;
- promote / demote (`role`) and suspend / reactivate (`status`);
- delete an account, which cascades to all of that user's finance rows.

The super-admin surface manages *accounts*, not other tenants' data: an admin can
create/promote/suspend/delete accounts and read platform usage, but `/api/admin/*`
never returns another workspace's transactions, and every finance query still filters
on the server-resolved `tenant_id`. The tenant-aware administration surface is
`/api/platform/*` (see [Multi-tenancy](#multi-tenancy)).

### Guards

| Situation | Response |
|---|---|
| No/invalid token | `401 unauthorized` |
| Authenticated but not an admin | `403 forbidden` |
| Admin changes their own role/status | `400 cannot_modify_self` |
| Admin deletes their own account | `400 cannot_delete_self` |
| Account is suspended (login, or any request with an old token) | `403 account_suspended` |
| Unknown or malformed `:id` | `404 not_found` |

Because self-modification is blocked, a deployment can never be locked out by
removing its last administrator.

---

## Multi-tenancy

The data model is **Platform → tenants → tenant members → tenant-owned finance
data**. Migration `0004_tenants.sql` adds it; every finance table gains a
`tenant_id` (the authoritative isolation key) while `user_id` stays as the row's
author.

### Tables

| Table | Purpose |
|---|---|
| `tenants` | a workspace: `name`, `slug`, `type` (`personal`\|`organization`), `status` (`active`\|`suspended`\|`archived`), `owner_user_id`, `personal_owner_user_id`, `settings` |
| `tenant_members` | membership + **tenant-level** role (`TENANT_ADMIN`\|`TENANT_MEMBER`), status (`active`\|`suspended`), `invited_by`. PK `(tenant_id, user_id)` |
| `audit_logs` | append-only administrative trail (actor, action, target, tenant, outcome, detail, ip, request_id). Never stores credentials, tokens or financial values |

### Two privilege layers (never mixed)

- **Platform role** — `users.role` (`'user'` \| `'admin'` = `PLATFORM_ADMIN`). Granted only
  server-side (the `ADMIN_EMAILS` bootstrap on first sign-in, or an existing platform
  admin). **Public signup can never create a platform admin**, and a client-supplied role
  is ignored.
- **Tenant role** — `tenant_members.role`. Applies only inside the workspace the
  membership belongs to. `TENANT_ADMIN` may manage the workspace and its members;
  `TENANT_MEMBER` may read and write finance data. The matrix lives in `src/tenant.js`
  (`TENANT_PERMISSIONS`) and routes declare the permission they need.

### How the request is authorized

1. The Worker verifies the bearer token (own HS256, or a Neon Auth JWT).
2. The authenticated `users.id` is the only identity used.
3. `resolveTenantContext()` resolves the workspace: an `X-Tenant-Id` header is treated as a
   *selector* and **requires an active membership**; without it the caller's **personal
   workspace** is used (backward-compatible default). A non-member gets `403`
   (`not_a_member`) — which is also why a foreign tenant id is not probeable.
4. Suspended/archived tenants and suspended memberships are refused with clear, non-sensitive
   messages.
5. Every finance statement is scoped by the resolved `tenant_id`; inserts get `tenant_id`
   injected server-side; a cross-tenant record is `404`.

### Existing-data migration (no guessing)

`0004_tenants.sql` is additive and non-destructive. It creates one **personal workspace per
existing user** (`personal_owner_user_id = users.id`, that user as its `TENANT_ADMIN`) and
assigns each existing finance row (which already carries a trustworthy `user_id`) to the
personal workspace of that same author. A partial unique index enforces one personal
workspace per user. It never drops, truncates, renames or type-changes existing objects and
is safe to re-run. A manual rollback (never applied automatically) lives at
`migrations/rollback/0004_tenants.down.sql`.

After applying it, verify the invariants (read-only, exits non-zero on failure):

```bash
cd backend
npm run verify:tenancy
```

### Tenant lifecycle

Suspension (`status = 'suspended'`) blocks normal application access through backend
authorization while preserving all data; reactivation is `status = 'active'`. Deletion is a
**soft archive** — irreversible hard deletion is intentionally disabled
(`?hard=true` → `403`) pending an explicit retention policy. Deleting a *user account*
still cascades to that user's own finance rows.

### Row-Level Security

RLS was evaluated as a defense-in-depth layer but is **not enabled**. The Worker accesses
Neon over the HTTP driver without a per-request database role or session GUC that policies
could key on, so isolation is enforced in the query/service layer instead (every statement
carries a server-derived `tenant_id`). No part of the design claims RLS protection.

### Multi-workspace users

One account can belong to many workspaces. The frontend fetches the accessible list from
`GET /api/tenants`, offers a switcher, and the Worker re-validates the selection on **every**
request — a client can never switch into a workspace it is not a member of.

---

## Running the migration against Neon

The migration runner reads `DATABASE_URL` from the environment, then falls back
to `backend/.dev.vars` / `backend/.env`. It records applied files in
`schema_migrations` and wraps each file in a transaction. The password is
redacted in all output.

```bash
cd backend

# READ-ONLY: prove the database is ready for 0004 (tables, backfill, no blockers)
npm run preflight:tenancy

# READ-ONLY: which migrations are applied vs pending (reads schema_migrations)
npm run migrate:status

# READ-ONLY: logical snapshot of every table (restore reference) — writes a local file only
npm run snapshot:data -- <output-dir>

# preview only — no changes written
npm run migrate -- --dry-run

# apply
npm run migrate

# READ-ONLY invariant check afterwards (exit code 1 on any violation)
npm run verify:tenancy
```

`npm run verify:tenancy` is a **read-only** post-migration audit: it asserts every
finance row has a `tenant_id`, every personal workspace has exactly one owner
membership, no membership references a missing user/tenant, and every
`tenant_id` matches the row's author's personal tenant for legacy data. It never
writes and is safe to run any time.

`migrations/0001_init.sql` is idempotent and non-destructive (`CREATE TABLE IF
NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, `ALTER TABLE ... ADD COLUMN IF NOT
EXISTS`). `migrations/0004_tenants.sql` follows the same rules (it only adds
tables/columns/indexes, backfills `tenant_id`, and guards `ADD CONSTRAINT` with a
catalog probe). Neither file drops, truncates, renames, or deletes anything, and
both are safe to re-run against the existing `expense-tracker-pro` database.

---

## Setting secrets (Cloudflare)

`wrangler secret put` prompts for the value, so it is not written to shell
history or the repo:

```bash
cd backend
npx wrangler secret put DATABASE_URL    # paste the Neon connection string
npx wrangler secret put AUTH_SECRET     # paste 32+ random chars (same generator as above)
npx wrangler secret put ADMIN_EMAILS    # optional: comma-separated platform-admin emails

npx wrangler secret list                # verify names (values are never shown)
```

The Neon Auth URLs are **not** secrets — put them in `wrangler.toml → [vars]` (they are
public and shipped to the browser anyway) and redeploy:

```toml
NEON_AUTH_BASE_URL = "https://<endpoint>.neonauth.<region>.aws.neon.tech/<db>/auth"
NEON_AUTH_JWKS_URL = ""   # optional override
```

---

## Deployment

For the full, approval-gated production sequence (backup → migrate → deploy → secret
rotation → verification), see
[`docs/PRODUCTION_RUNBOOK.md`](../docs/PRODUCTION_RUNBOOK.md).

```bash
cd backend
npm run deploy
```

Then add the deployed frontend origin(s) to `ALLOWED_ORIGINS` in
`wrangler.toml` and redeploy. Verify connectivity:

```bash
curl -s https://<worker>.workers.dev/api/health
# -> {"ok":true,"service":"spendwise-api","db":"ok","time":"..."}
```

---

## Smoke tests (curl)

Set these first:

```bash
API="http://localhost:8787"          # or your deployed Worker URL
```

### Health

```bash
curl -s "$API/api/health"
```

### Auth

```bash
# register
curl -s -X POST "$API/api/auth/register" \
  -H 'content-type: application/json' \
  -d '{"email":"demo@example.com","password":"correct-horse-battery","name":"Demo"}'

# login -> capture token
TOKEN=$(curl -s -X POST "$API/api/auth/login" \
  -H 'content-type: application/json' \
  -d '{"email":"demo@example.com","password":"correct-horse-battery"}' \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).token))")

# me
curl -s "$API/api/auth/me" -H "authorization: Bearer $TOKEN"

# logout
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$API/api/auth/logout" -H "authorization: Bearer $TOKEN"
```

### CRUD (transactions shown; same pattern for categories, accounts, budgets, recurring-rules, goals)

```bash
# create
curl -s -X POST "$API/api/transactions" -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"id":"tx-1","type":"expense","amountMinor":1250,"accountId":"acc-1","date":"2024-03-15","description":"Lunch"}'

# list (limit / offset / sort / order)
curl -s "$API/api/transactions?limit=50&offset=0&sort=date&order=desc" -H "authorization: Bearer $TOKEN"

# get one
curl -s "$API/api/transactions/tx-1" -H "authorization: Bearer $TOKEN"

# update
curl -s -X PATCH "$API/api/transactions/tx-1" -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"amountMinor":1500}'

# delete
curl -s -o /dev/null -w '%{http_code}\n' -X DELETE "$API/api/transactions/tx-1" -H "authorization: Bearer $TOKEN"
```

### State (full read / replace)

```bash
curl -s "$API/api/state" -H "authorization: Bearer $TOKEN"

curl -s -X PUT "$API/api/state" -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"state":{"schemaVersion":1,"transactions":[],"categories":[],"accounts":[],"budgets":[],"recurringRules":[],"goals":[],"preferences":{}}}'
```

### Preferences

```bash
curl -s "$API/api/preferences" -H "authorization: Bearer $TOKEN"

curl -s -X PUT "$API/api/preferences" -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"preferences":{"theme":"dark","currency":"BDT"}}'
```

### Batch sync

```bash
curl -s -X POST "$API/api/sync" -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"changes":[{"resource":"accounts","op":"upsert","record":{"id":"acc-1","name":"Cash","type":"cash"}},{"resource":"transactions","op":"delete","id":"tx-999"}]}'
```

### Negative checks

```bash
# no token -> 401
curl -s -o /dev/null -w '%{http_code}\n' "$API/api/state"
# unknown path -> 404
curl -s -o /dev/null -w '%{http_code}\n' "$API/api/nope"
# raw SQL attempt -> 403
curl -s -o /dev/null -w '%{http_code}\n' "$API/api/sql"
```

---

## Rotating credentials (REQUIRED)

A NeonDB `DATABASE_URL` was previously pasted in **plaintext into a planning
file**. Treat that credential as **potentially exposed**. The connection string
is intentionally not reproduced anywhere in this repository. Rotate it now:

1. In the Neon console, open the project and reset the role password
   (**Roles → the role used by the connection → Reset password**), or create a
   new role and grant it access to `expense-tracker-pro`. This invalidates the
   leaked password.
2. Rebuild the connection string with the new password (keep
   `...?sslmode=require`, use the pooled host for Workers).
3. Update the secret in every environment:
   - Production: `npx wrangler secret put DATABASE_URL` (paste the new value).
   - Local: edit `backend/.dev.vars`.
4. Redeploy: `npm run deploy`.
5. Verify: `curl -s https://<worker>.workers.dev/api/health` must show
   `"db":"ok"`.
6. Also rotate `AUTH_SECRET` if it was ever exposed
   (`npx wrangler secret put AUTH_SECRET`); this invalidates all issued tokens
   and forces users to sign in again.
7. Confirm the old credential no longer works, and remove it from any planning
   notes, chat logs, or tickets where it was pasted.

---

## Unverified without a Cloudflare/Neon account

The following require live infrastructure and were **not** executed here:

- `wrangler dev` / `wrangler deploy` (disabled on purpose in this task).
- Running `npm run migrate` against the real Neon database.
- End-to-end HTTP requests and live SQL execution.

The unit tests (`npm test`, **112 tests** across `api.test.mjs`, `tenant.test.mjs`,
`migrationStatus.test.mjs` and
`neonAuth.test.mjs`) exercise passwords, tokens, validation, CORS, security headers,
request-id correlation, rate-limit math, JSON
parsing, the SQL builders, the multi-tenant role/permission matrix, tenant-context
resolution (including rejection of manipulated tenant ids), personal-workspace
provisioning and the Neon-Auth email-verification gate directly, and pass without any
account. The Worker bundle also builds cleanly (`wrangler deploy --dry-run`, ~390 KiB).
