-- ===========================================================================
-- SpendWise schema migration
-- ===========================================================================
-- version      : 0002
-- name         : neon_auth
-- target       : NeonDB PostgreSQL (database: expense-tracker-pro)
-- authored     : 2026-10-16
--
-- WHY
-- ---
-- Sign-in can now happen through Managed Better Auth (Neon Auth) using an
-- email magic link, in addition to the Worker's own email + password accounts.
-- Neon Auth stores its identities in the `neon_auth` schema of THIS database,
-- so the app's `users` row can reference the Neon Auth user id directly.
--
-- This migration is additive and non-destructive:
--   * ADD COLUMN IF NOT EXISTS on `users` only
--   * one partial unique index on the new column
-- It never drops, truncates, renames or rewrites existing rows, and it is safe
-- to run repeatedly.
--
-- LINKING RULES (enforced in application code, see backend/src/auth.js)
-- ------------------------------------------------------------------
--   users.id                 remains the tenant key used by every finance table
--   users.neon_auth_user_id  the Neon Auth (`neon_auth.user.id`) identity that
--                            may sign in for this user, or NULL
--   users.auth_provider      'password' (self-hosted account) or 'neon'
--
-- A magic-link sign-in first looks up `neon_auth_user_id`, then falls back to a
-- case-insensitive email match (which links an existing password account), and
-- only then creates a new `users` row. Rows created this way get a sentinel
-- password hash that can never be verified, so password login stays impossible
-- for them until a password is explicitly set.
-- ===========================================================================

ALTER TABLE users ADD COLUMN IF NOT EXISTS neon_auth_user_id uuid;
ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_provider text NOT NULL DEFAULT 'password';

-- One Neon Auth identity may map to at most one app user. Partial so the many
-- password-only rows (NULL) do not collide.
CREATE UNIQUE INDEX IF NOT EXISTS users_neon_auth_user_id_key
  ON users (neon_auth_user_id)
  WHERE neon_auth_user_id IS NOT NULL;
