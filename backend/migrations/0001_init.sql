-- ===========================================================================
-- SpendWise schema migration
-- ===========================================================================
-- version      : 0001
-- name         : init
-- target       : NeonDB PostgreSQL (database: expense-tracker-pro)
-- authored     : 2026-10-15
--
-- SAFETY / NON-DESTRUCTIVE GUARANTEE
-- ----------------------------------
-- This migration is idempotent and non-destructive. It only uses:
--   * CREATE TABLE IF NOT EXISTS
--   * CREATE INDEX IF NOT EXISTS
--   * ALTER TABLE ... ADD COLUMN IF NOT EXISTS
--   * CREATE UNIQUE INDEX IF NOT EXISTS
-- It never issues DROP, TRUNCATE, DELETE, RENAME, or ALTER COLUMN TYPE. It is
-- safe to run repeatedly against a database that already contains the project
-- data (this database was previously used as `expense-tracker-pro`), and it
-- will not remove or rename existing objects.
--
-- Run with:  npm run migrate            (from backend/)
--            npm run migrate -- --dry-run
-- Do NOT wrap in BEGIN/COMMIT here — scripts/migrate.mjs wraps the whole file
-- in a single transaction and records the version in schema_migrations.
--
-- MONEY REPRESENTATION
-- --------------------
-- Every monetary value is stored as an INTEGER in MINOR units (e.g. poisha /
-- cents) using bigint. Rationale:
--   * Exact arithmetic: no IEEE-754 rounding drift on add/subtract/total.
--   * Currency-aware precision can be applied by the application.
--   * bigint covers up to ~9.2e18 minor units, far beyond realistic balances,
--     while still fitting safely in a JS Number (<= 2^53) for the values the
--     API accepts (the API caps amounts at 1e15 minor units).
-- The "minor" suffix on every column name is intentional and must be kept.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  name          text NOT NULL DEFAULT '',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Emails are stored lowercased by the application; enforce case-insensitive
-- uniqueness at the database level as a second line of defence.
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_key ON users (lower(email));

-- ---------------------------------------------------------------------------
-- accounts (wallets / bank accounts / cards)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS accounts (
  id                   text PRIMARY KEY,
  user_id              uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name                 text NOT NULL,
  type                 text NOT NULL,
  currency             char(3) NOT NULL DEFAULT 'BDT',
  opening_balance_minor bigint NOT NULL DEFAULT 0,
  opening_balance_date date,
  color                text NOT NULL DEFAULT '#6366f1',
  icon                 text NOT NULL DEFAULT 'wallet',
  archived             boolean NOT NULL DEFAULT false,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- categories (income / expense, supports nesting via parent_id)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS categories (
  id         text PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       text NOT NULL,
  type       text NOT NULL CHECK (type IN ('income','expense')),
  parent_id  text REFERENCES categories(id) ON DELETE SET NULL,
  icon       text NOT NULL DEFAULT 'tag',
  color      text NOT NULL DEFAULT '#64748b',
  archived   boolean NOT NULL DEFAULT false,
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, type, name)
);

-- ---------------------------------------------------------------------------
-- transactions
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS transactions (
  id                text PRIMARY KEY,
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type              text NOT NULL CHECK (type IN ('income','expense','transfer')),
  amount_minor      bigint NOT NULL CHECK (amount_minor > 0),
  currency          char(3) NOT NULL DEFAULT 'BDT',
  category_id       text,
  account_id        text NOT NULL,
  to_account_id     text,
  date              date NOT NULL,
  description       text NOT NULL DEFAULT '',
  payee             text NOT NULL DEFAULT '',
  payment_method    text NOT NULL DEFAULT 'cash',
  tags              text[] NOT NULL DEFAULT '{}',
  notes             text NOT NULL DEFAULT '',
  status            text NOT NULL DEFAULT 'posted' CHECK (status IN ('posted','pending','draft')),
  recurring_rule_id text,
  occurrence_key    text,
  receipt_ref       text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (type <> 'transfer' OR (to_account_id IS NOT NULL AND to_account_id <> account_id))
);

-- A recurring rule must never generate the same occurrence twice for a user.
-- Partial unique index so NULL occurrence_key rows are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS transactions_user_occurrence_key
  ON transactions (user_id, occurrence_key)
  WHERE occurrence_key IS NOT NULL;

-- ---------------------------------------------------------------------------
-- budgets
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS budgets (
  id                text PRIMARY KEY,
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name              text NOT NULL,
  period            text NOT NULL CHECK (period IN ('weekly','monthly','yearly')),
  limit_minor       bigint NOT NULL CHECK (limit_minor > 0),
  currency          char(3) NOT NULL DEFAULT 'BDT',
  scope             text NOT NULL CHECK (scope IN ('overall','category')),
  category_id       text,
  start_date        date NOT NULL,
  end_date          date NOT NULL,
  alert_thresholds  int[] NOT NULL DEFAULT '{75,90,100}',
  status            text NOT NULL DEFAULT 'active',
  archived          boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- recurring_rules
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS recurring_rules (
  id                  text PRIMARY KEY,
  user_id             uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name                text NOT NULL,
  type                text NOT NULL CHECK (type IN ('income','expense','transfer')),
  amount_minor        bigint NOT NULL CHECK (amount_minor > 0),
  currency            char(3) NOT NULL DEFAULT 'BDT',
  category_id         text,
  account_id          text NOT NULL,
  to_account_id       text,
  frequency           text NOT NULL CHECK (frequency IN ('daily','weekly','monthly','yearly')),
  interval_count      int NOT NULL DEFAULT 1 CHECK (interval_count > 0),
  start_date          date NOT NULL,
  next_due_date       date NOT NULL,
  end_date            date,
  notes               text NOT NULL DEFAULT '',
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused')),
  last_generated_date date,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- goals
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS goals (
  id            text PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          text NOT NULL,
  target_minor  bigint NOT NULL CHECK (target_minor > 0),
  saved_minor   bigint NOT NULL DEFAULT 0,
  currency      char(3) NOT NULL DEFAULT 'BDT',
  target_date   date,
  account_id    text,
  icon          text NOT NULL DEFAULT 'target',
  color         text NOT NULL DEFAULT '#14b8a6',
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','archived')),
  contributions jsonb NOT NULL DEFAULT '[]'::jsonb,
  archived      boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- preferences (free-form client preferences blob, one row per user)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS preferences (
  user_id    uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  data       jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- app_metadata (per-user schema/version + sync bookkeeping)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_metadata (
  user_id        uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  schema_version int NOT NULL DEFAULT 1,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- ===========================================================================
-- Defensive column additions.
-- These are no-ops on a fresh database (the CREATE TABLEs above already define
-- every column) but make the migration safe to apply to an older/pre-existing
-- version of a table that is missing a column.
-- ===========================================================================
ALTER TABLE users            ADD COLUMN IF NOT EXISTS name         text NOT NULL DEFAULT '';
ALTER TABLE users            ADD COLUMN IF NOT EXISTS updated_at   timestamptz NOT NULL DEFAULT now();
ALTER TABLE accounts         ADD COLUMN IF NOT EXISTS currency     char(3) NOT NULL DEFAULT 'BDT';
ALTER TABLE accounts         ADD COLUMN IF NOT EXISTS archived     boolean NOT NULL DEFAULT false;
ALTER TABLE accounts         ADD COLUMN IF NOT EXISTS updated_at   timestamptz NOT NULL DEFAULT now();
ALTER TABLE categories       ADD COLUMN IF NOT EXISTS is_default   boolean NOT NULL DEFAULT false;
ALTER TABLE categories       ADD COLUMN IF NOT EXISTS archived     boolean NOT NULL DEFAULT false;
ALTER TABLE categories       ADD COLUMN IF NOT EXISTS updated_at   timestamptz NOT NULL DEFAULT now();
ALTER TABLE transactions     ADD COLUMN IF NOT EXISTS occurrence_key text;
ALTER TABLE transactions     ADD COLUMN IF NOT EXISTS receipt_ref    text;
ALTER TABLE transactions     ADD COLUMN IF NOT EXISTS updated_at     timestamptz NOT NULL DEFAULT now();
ALTER TABLE budgets          ADD COLUMN IF NOT EXISTS alert_thresholds int[] NOT NULL DEFAULT '{75,90,100}';
ALTER TABLE budgets          ADD COLUMN IF NOT EXISTS archived     boolean NOT NULL DEFAULT false;
ALTER TABLE recurring_rules  ADD COLUMN IF NOT EXISTS interval_count int NOT NULL DEFAULT 1;
ALTER TABLE recurring_rules  ADD COLUMN IF NOT EXISTS last_generated_date date;
ALTER TABLE recurring_rules  ADD COLUMN IF NOT EXISTS updated_at   timestamptz NOT NULL DEFAULT now();
ALTER TABLE goals            ADD COLUMN IF NOT EXISTS contributions jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE goals            ADD COLUMN IF NOT EXISTS archived     boolean NOT NULL DEFAULT false;
ALTER TABLE goals            ADD COLUMN IF NOT EXISTS updated_at   timestamptz NOT NULL DEFAULT now();

-- Re-assert the occurrence uniqueness after the defensive column add above.
CREATE UNIQUE INDEX IF NOT EXISTS transactions_user_occurrence_key
  ON transactions (user_id, occurrence_key)
  WHERE occurrence_key IS NOT NULL;

-- ===========================================================================
-- Indexes
-- ===========================================================================

-- One B-tree index on every user_id column (tenant isolation / listing).
CREATE INDEX IF NOT EXISTS accounts_user_id_idx        ON accounts        (user_id);
CREATE INDEX IF NOT EXISTS categories_user_id_idx      ON categories      (user_id);
CREATE INDEX IF NOT EXISTS transactions_user_id_idx    ON transactions    (user_id);
CREATE INDEX IF NOT EXISTS budgets_user_id_idx         ON budgets         (user_id);
CREATE INDEX IF NOT EXISTS recurring_rules_user_id_idx ON recurring_rules (user_id);
CREATE INDEX IF NOT EXISTS goals_user_id_idx           ON goals           (user_id);

-- Common transaction access patterns.
CREATE INDEX IF NOT EXISTS transactions_user_date_idx     ON transactions (user_id, date DESC);
CREATE INDEX IF NOT EXISTS transactions_user_category_idx ON transactions (user_id, category_id);
CREATE INDEX IF NOT EXISTS transactions_user_account_idx  ON transactions (user_id, account_id);
