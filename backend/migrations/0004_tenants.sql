-- ===========================================================================
-- SpendWise schema migration
-- ===========================================================================
-- version      : 0004
-- name         : tenants
-- target       : NeonDB PostgreSQL (database: expense-tracker-pro)
-- authored     : 2026-10-16
--
-- WHY
-- ---
-- Turn the single-user data model into an explicit multi-tenant model:
--
--     Platform -> Tenants -> Tenant members -> Tenant-owned finance data
--
-- Until now every finance row was owned by exactly one `users.id`. This
-- migration introduces a first-class `tenants` table, a `tenant_members`
-- membership table with tenant-level roles, and an append-only `audit_logs`
-- table for platform/tenant administration. Every finance table gains a
-- `tenant_id` that becomes the authoritative isolation key, while the existing
-- `user_id` column is KEPT as the author/creator of each row.
--
-- SAFETY / NON-DESTRUCTIVE GUARANTEE
-- ----------------------------------
-- This migration only ADDS objects and BACKFILLS ownership:
--   * CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS
--   * ALTER TABLE ... ADD COLUMN IF NOT EXISTS
--   * guarded ADD CONSTRAINT (probed against pg_constraint)
--   * INSERT ... ON CONFLICT DO NOTHING (backfill)
--   * UPDATE ... WHERE tenant_id IS NULL (backfill, only fills the new column)
--   * ALTER COLUMN ... SET NOT NULL (safe to repeat; a no-op when already set)
-- It never issues DROP, TRUNCATE, DELETE, RENAME or ALTER COLUMN TYPE, and it
-- never rewrites existing columns. Existing rows keep their ids, user_id, and
-- every financial value. It is safe to run repeatedly.
--
-- HOW HISTORICAL DATA IS ASSIGNED (no guessing)
-- ---------------------------------------------
-- A tenant is created ONLY for an existing user, and it is a personal
-- workspace OWNED BY THAT EXACT USER:
--
--     tenants.personal_owner_user_id = users.id
--     tenant_members(tenant, that user, 'TENANT_ADMIN', 'active')
--
-- Every existing finance row (which already carries a trustworthy `user_id`
-- foreign key) is then assigned to the personal tenant of that same user. No
-- row is ever assigned to an unrelated tenant. A unique partial index enforces
-- at most one personal tenant per user.
--
-- ROLLBACK
-- --------
-- A best-effort down migration lives at
-- `backend/migrations/rollback/0004_tenants.down.sql` (NOT applied
-- automatically: the runner only reads `backend/migrations/*.sql`). It drops
-- the added constraints/indexes/columns and the new tables, in an order that
-- respects foreign keys. Losing the new tables is expected; no pre-existing
-- column or row is dropped.
--
-- Do NOT wrap in BEGIN/COMMIT here — scripts/migrate.mjs wraps the whole file
-- in a single transaction and records the version in schema_migrations.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- tenants
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tenants (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                   text NOT NULL,
  slug                   text,
  type                   text NOT NULL DEFAULT 'organization',
  status                 text NOT NULL DEFAULT 'active',
  owner_user_id          uuid REFERENCES users(id) ON DELETE SET NULL,
  personal_owner_user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  settings               jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

-- At most one personal ("my own workspace") tenant per user. Partial so shared
-- organization tenants (NULL) never collide.
CREATE UNIQUE INDEX IF NOT EXISTS tenants_personal_owner_key
  ON tenants (personal_owner_user_id)
  WHERE personal_owner_user_id IS NOT NULL;

-- Slugs are optional but unique (case-insensitive) when present.
CREATE UNIQUE INDEX IF NOT EXISTS tenants_slug_key
  ON tenants (lower(slug))
  WHERE slug IS NOT NULL;

CREATE INDEX IF NOT EXISTS tenants_status_idx ON tenants (status);

-- Constrain the new columns. Postgres has no "ADD CONSTRAINT IF NOT EXISTS",
-- so probe the catalog first; the whole file runs in one transaction.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tenants_status_check' AND conrelid = 'tenants'::regclass
  ) THEN
    ALTER TABLE tenants ADD CONSTRAINT tenants_status_check
      CHECK (status IN ('active', 'suspended', 'archived'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tenants_type_check' AND conrelid = 'tenants'::regclass
  ) THEN
    ALTER TABLE tenants ADD CONSTRAINT tenants_type_check
      CHECK (type IN ('personal', 'organization'));
  END IF;
END $$;


-- ---------------------------------------------------------------------------
-- tenant_members
-- ---------------------------------------------------------------------------
-- `role` is the TENANT-level role. Platform-level privileges remain solely on
-- `users.role` and are never derived from this table.
CREATE TABLE IF NOT EXISTS tenant_members (
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       text NOT NULL DEFAULT 'TENANT_MEMBER',
  status     text NOT NULL DEFAULT 'active',
  invited_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);

-- "Which tenants can this user see?" is the hot membership lookup.
CREATE INDEX IF NOT EXISTS tenant_members_user_idx ON tenant_members (user_id, status);
CREATE INDEX IF NOT EXISTS tenant_members_tenant_idx ON tenant_members (tenant_id, status);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tenant_members_role_check' AND conrelid = 'tenant_members'::regclass
  ) THEN
    ALTER TABLE tenant_members ADD CONSTRAINT tenant_members_role_check
      CHECK (role IN ('TENANT_ADMIN', 'TENANT_MEMBER'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tenant_members_status_check' AND conrelid = 'tenant_members'::regclass
  ) THEN
    ALTER TABLE tenant_members ADD CONSTRAINT tenant_members_status_check
      CHECK (status IN ('active', 'suspended'));
  END IF;
END $$;


-- ---------------------------------------------------------------------------
-- audit_logs (append-only administrative trail)
-- ---------------------------------------------------------------------------
-- Deliberately stores NO credentials, tokens or financial records: only who did
-- what to which target and whether it succeeded.
CREATE TABLE IF NOT EXISTS audit_logs (
  id            bigserial PRIMARY KEY,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_email   text NOT NULL DEFAULT '',
  action        text NOT NULL,
  target_type   text NOT NULL DEFAULT '',
  target_id     text,
  tenant_id     uuid REFERENCES tenants(id) ON DELETE SET NULL,
  outcome       text NOT NULL DEFAULT 'success',
  detail        jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip            text,
  request_id    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_logs_created_idx ON audit_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_tenant_idx  ON audit_logs (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_actor_idx   ON audit_logs (actor_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_action_idx  ON audit_logs (action, created_at DESC);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'audit_logs_outcome_check' AND conrelid = 'audit_logs'::regclass
  ) THEN
    ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_outcome_check
      CHECK (outcome IN ('success', 'failure', 'denied'));
  END IF;
END $$;


-- ===========================================================================
-- Tenant ownership on the existing finance tables.
-- Additive columns first; they are backfilled below and only then made NOT NULL.
-- ===========================================================================
ALTER TABLE accounts        ADD COLUMN IF NOT EXISTS tenant_id uuid;
ALTER TABLE categories      ADD COLUMN IF NOT EXISTS tenant_id uuid;
ALTER TABLE transactions    ADD COLUMN IF NOT EXISTS tenant_id uuid;
ALTER TABLE budgets         ADD COLUMN IF NOT EXISTS tenant_id uuid;
ALTER TABLE recurring_rules ADD COLUMN IF NOT EXISTS tenant_id uuid;
ALTER TABLE goals           ADD COLUMN IF NOT EXISTS tenant_id uuid;


-- ===========================================================================
-- BACKFILL — create a personal workspace for every existing user.
-- ===========================================================================
INSERT INTO tenants (name, type, status, owner_user_id, personal_owner_user_id)
SELECT
  COALESCE(NULLIF(btrim(u.name), ''), u.email) || ' Personal',
  'personal',
  'active',
  u.id,
  u.id
FROM users u
WHERE NOT EXISTS (
  SELECT 1 FROM tenants t WHERE t.personal_owner_user_id = u.id
);

-- Every user is the TENANT_ADMIN of their own personal workspace.
INSERT INTO tenant_members (tenant_id, user_id, role, status)
SELECT t.id, t.personal_owner_user_id, 'TENANT_ADMIN', 'active'
FROM tenants t
WHERE t.personal_owner_user_id IS NOT NULL
ON CONFLICT (tenant_id, user_id) DO NOTHING;

-- Historical finance rows: assigned to the personal tenant of their own author.
UPDATE accounts a
   SET tenant_id = t.id
  FROM tenants t
 WHERE a.tenant_id IS NULL AND t.personal_owner_user_id = a.user_id;

UPDATE categories c
   SET tenant_id = t.id
  FROM tenants t
 WHERE c.tenant_id IS NULL AND t.personal_owner_user_id = c.user_id;

UPDATE transactions x
   SET tenant_id = t.id
  FROM tenants t
 WHERE x.tenant_id IS NULL AND t.personal_owner_user_id = x.user_id;

UPDATE budgets b
   SET tenant_id = t.id
  FROM tenants t
 WHERE b.tenant_id IS NULL AND t.personal_owner_user_id = b.user_id;

UPDATE recurring_rules r
   SET tenant_id = t.id
  FROM tenants t
 WHERE r.tenant_id IS NULL AND t.personal_owner_user_id = r.user_id;

UPDATE goals g
   SET tenant_id = t.id
  FROM tenants t
 WHERE g.tenant_id IS NULL AND t.personal_owner_user_id = g.user_id;


-- ===========================================================================
-- Foreign keys, NOT NULL and indexes on the new tenant columns.
-- ===========================================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'accounts_tenant_id_fkey' AND conrelid = 'accounts'::regclass
  ) THEN
    ALTER TABLE accounts ADD CONSTRAINT accounts_tenant_id_fkey
      FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'categories_tenant_id_fkey' AND conrelid = 'categories'::regclass
  ) THEN
    ALTER TABLE categories ADD CONSTRAINT categories_tenant_id_fkey
      FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'transactions_tenant_id_fkey' AND conrelid = 'transactions'::regclass
  ) THEN
    ALTER TABLE transactions ADD CONSTRAINT transactions_tenant_id_fkey
      FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'budgets_tenant_id_fkey' AND conrelid = 'budgets'::regclass
  ) THEN
    ALTER TABLE budgets ADD CONSTRAINT budgets_tenant_id_fkey
      FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'recurring_rules_tenant_id_fkey' AND conrelid = 'recurring_rules'::regclass
  ) THEN
    ALTER TABLE recurring_rules ADD CONSTRAINT recurring_rules_tenant_id_fkey
      FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'goals_tenant_id_fkey' AND conrelid = 'goals'::regclass
  ) THEN
    ALTER TABLE goals ADD CONSTRAINT goals_tenant_id_fkey
      FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
  END IF;
END $$;

-- Everything above backfilled every row, so the column is total. Idempotent.
ALTER TABLE accounts        ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE categories      ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE transactions    ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE budgets         ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE recurring_rules ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE goals           ALTER COLUMN tenant_id SET NOT NULL;

-- Tenant-scoped listing/aggregation indexes (the new primary access path).
CREATE INDEX IF NOT EXISTS accounts_tenant_id_idx        ON accounts        (tenant_id);
CREATE INDEX IF NOT EXISTS categories_tenant_id_idx      ON categories      (tenant_id);
CREATE INDEX IF NOT EXISTS transactions_tenant_id_idx    ON transactions    (tenant_id);
CREATE INDEX IF NOT EXISTS budgets_tenant_id_idx         ON budgets         (tenant_id);
CREATE INDEX IF NOT EXISTS recurring_rules_tenant_id_idx ON recurring_rules (tenant_id);
CREATE INDEX IF NOT EXISTS goals_tenant_id_idx           ON goals           (tenant_id);

CREATE INDEX IF NOT EXISTS transactions_tenant_date_idx     ON transactions (tenant_id, date DESC);
CREATE INDEX IF NOT EXISTS transactions_tenant_category_idx ON transactions (tenant_id, category_id);
CREATE INDEX IF NOT EXISTS transactions_tenant_account_idx  ON transactions (tenant_id, account_id);
