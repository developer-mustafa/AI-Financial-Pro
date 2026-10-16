-- ===========================================================================
-- SpendWise schema migration
-- ===========================================================================
-- version      : 0003
-- name         : admin
-- target       : NeonDB PostgreSQL (database: expense-tracker-pro)
-- authored     : 2026-10-16
--
-- WHY
-- ---
-- Introduce a super-admin role and an account status so an administrator can
-- manage the users of this deployment (list / create / suspend / promote /
-- delete). Tenant isolation is unchanged: every finance row still belongs to
-- exactly one `users.id`; the admin role only unlocks the /api/admin/* surface.
--
-- This migration is additive and non-destructive:
--   * ADD COLUMN IF NOT EXISTS on `users` only, both with safe defaults so
--     every existing row is a normal active user;
--   * two CHECK constraints, each guarded by a pg_constraint probe so the file
--     is safe to run repeatedly;
--   * one small partial index to look up administrators.
-- It never drops, truncates, renames or rewrites existing rows.
--
-- BOOTSTRAP
-- ---------
-- There is deliberately no hard-coded admin. The first administrator is the
-- account whose email appears in the Worker's `ADMIN_EMAILS` variable: on the
-- first successful sign-in that row is promoted to role 'admin' in
-- application code (see backend/src/auth.js). Everyone else defaults to
-- 'user'.
-- ===========================================================================

ALTER TABLE users ADD COLUMN IF NOT EXISTS role   text NOT NULL DEFAULT 'user';
ALTER TABLE users ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';

-- Constrain the two new columns. Postgres has no "ADD CONSTRAINT IF NOT
-- EXISTS", so probe the catalog first; the whole file runs in one transaction.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'users_role_check' AND conrelid = 'users'::regclass
  ) THEN
    ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('user', 'admin'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'users_status_check' AND conrelid = 'users'::regclass
  ) THEN
    ALTER TABLE users ADD CONSTRAINT users_status_check CHECK (status IN ('active', 'suspended'));
  END IF;
END $$;

-- The admin list only ever filters by role; a partial index keeps it tiny.
CREATE INDEX IF NOT EXISTS users_role_admin_idx ON users (role) WHERE role = 'admin';
