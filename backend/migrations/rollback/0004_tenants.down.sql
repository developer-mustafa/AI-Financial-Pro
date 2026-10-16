-- ===========================================================================
-- SpendWise schema ROLLBACK for migration 0004 (tenants)
-- ===========================================================================
-- version : 0004 (down)
-- name    : tenants
--
-- THIS FILE IS NEVER APPLIED AUTOMATICALLY.
-- The migration runner (`backend/scripts/migrate.mjs`) only reads
-- `backend/migrations/*.sql`; files in this `rollback/` sub-directory are
-- ignored by design. Apply it by hand, ONLY after taking a backup:
--
--     psql "$DATABASE_URL" -f backend/migrations/rollback/0004_tenants.down.sql
--
-- WHAT IT UNDOES
-- --------------
-- It removes everything 0004 added:
--   * tenant_id foreign keys, indexes and the tenant_id columns themselves
--     (which also deletes the tenant ownership assignment on finance rows);
--   * the audit_logs, tenant_members and tenants tables.
--
-- WHAT IT DOES NOT TOUCH
-- ----------------------
-- It never drops `users` or any pre-existing finance column, and it never
-- modifies a pre-existing value. After running it, the application behaves as
-- before 0004 and finance data is again isolated solely by `user_id`.
--
-- ORDER MATTERS: dependent objects first, so no foreign key blocks a drop.
-- ===========================================================================

-- 1. Finance-table tenant columns and their constraints/indexes.
DROP INDEX IF EXISTS transactions_tenant_account_idx;
DROP INDEX IF EXISTS transactions_tenant_category_idx;
DROP INDEX IF EXISTS transactions_tenant_date_idx;
DROP INDEX IF EXISTS goals_tenant_id_idx;
DROP INDEX IF EXISTS recurring_rules_tenant_id_idx;
DROP INDEX IF EXISTS budgets_tenant_id_idx;
DROP INDEX IF EXISTS transactions_tenant_id_idx;
DROP INDEX IF EXISTS categories_tenant_id_idx;
DROP INDEX IF EXISTS accounts_tenant_id_idx;

ALTER TABLE goals           DROP CONSTRAINT IF EXISTS goals_tenant_id_fkey;
ALTER TABLE recurring_rules DROP CONSTRAINT IF EXISTS recurring_rules_tenant_id_fkey;
ALTER TABLE budgets         DROP CONSTRAINT IF EXISTS budgets_tenant_id_fkey;
ALTER TABLE transactions    DROP CONSTRAINT IF EXISTS transactions_tenant_id_fkey;
ALTER TABLE categories      DROP CONSTRAINT IF EXISTS categories_tenant_id_fkey;
ALTER TABLE accounts        DROP CONSTRAINT IF EXISTS accounts_tenant_id_fkey;

ALTER TABLE goals           DROP COLUMN IF EXISTS tenant_id;
ALTER TABLE recurring_rules DROP COLUMN IF EXISTS tenant_id;
ALTER TABLE budgets         DROP COLUMN IF EXISTS tenant_id;
ALTER TABLE transactions    DROP COLUMN IF EXISTS tenant_id;
ALTER TABLE categories      DROP COLUMN IF EXISTS tenant_id;
ALTER TABLE accounts        DROP COLUMN IF EXISTS tenant_id;

-- 2. New tables (audit_logs references tenants; drop it first).
DROP TABLE IF EXISTS audit_logs;
DROP TABLE IF EXISTS tenant_members;
DROP TABLE IF EXISTS tenants;
