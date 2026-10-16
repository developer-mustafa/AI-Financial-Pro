// src/routes/admin.js
// Super-admin user management. Every handler in this file runs ONLY after the
// router (src/index.js) has authenticated the caller AND confirmed that
// `ctx.user.role === 'admin'`; nothing here re-checks the caller's role.
//
// Scope: manage the *accounts* of this deployment. It does not expose, read or
// mutate any finance data belonging to other users — tenant isolation is
// unchanged and every finance query elsewhere still filters on `user_id`.
//
// Safety rules baked in:
//   * an admin can never change their own role or status, and can never delete
//     themselves, so a deployment cannot be locked out by accident;
//   * role/status are validated against a hard allow-list before any SQL;
//   * the record id is checked to be a UUID so a bad id is a clean 404 rather
//     than a driver error.

import { HttpError, json, parseJson, readQuery } from '../http.js';
import { mapDbError } from '../db.js';
import { assertEmail, assertPassword, hashPassword, normalizeEmail } from '../auth.js';
import { ensurePersonalTenant } from '../tenant.js';
import { writeAudit, actorFromContext } from '../audit.js';

// Columns needed to render a user in the admin list. Never password_hash.
const ADMIN_COLUMNS = 'id, email, name, role, status, auth_provider, created_at, updated_at';

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const MAX_SEARCH = 120;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Map a users row to the admin-facing shape (includes role/status/provider). */
function adminUser(row) {
  return {
    id: row.id,
    email: row.email,
    name: row.name ?? '',
    role: row.role === 'admin' ? 'admin' : 'user',
    status: row.status === 'suspended' ? 'suspended' : 'active',
    provider: row.auth_provider === 'neon' ? 'neon' : 'password',
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function toIso(v) {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString();
}

/** Re-throw known Postgres errors as safe HttpErrors. */
function translate(e) {
  const mapped = mapDbError(e);
  if (mapped) throw mapped;
  throw e;
}

function clampInt(raw, fallback, min, max) {
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

/** Validate a :id path segment; a non-UUID can never exist, so it is a 404. */
function requireUuid(id) {
  const value = typeof id === 'string' ? id.trim() : '';
  if (!UUID_RE.test(value)) throw new HttpError(404, 'not_found', 'User not found');
  return value;
}

/**
 * GET /api/admin/users?limit=&offset=&q=
 * -> 200 { items, total, limit, offset }
 */
export async function listUsers(ctx) {
  const query = readQuery(ctx.request);
  const limit = clampInt(query.get('limit'), DEFAULT_LIMIT, 1, MAX_LIMIT);
  const offset = clampInt(query.get('offset'), 0, 0, 1_000_000_000);
  const search = String(query.get('q') || '').trim().toLowerCase().slice(0, MAX_SEARCH);

  const params = [];
  let where = '';
  if (search) {
    params.push(`%${search}%`);
    where = 'WHERE lower(email) LIKE $1 OR lower(name) LIKE $1';
  }

  const countRows = await ctx.db.query(`SELECT count(*)::int AS total FROM users ${where}`, params);
  const total = Number((countRows && countRows[0] && countRows[0].total) || 0);

  params.push(limit, offset);
  const rows = await ctx.db.query(
    `SELECT ${ADMIN_COLUMNS} FROM users ${where} ORDER BY created_at DESC, id LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );

  return json({ items: (rows || []).map(adminUser), total, limit, offset });
}

/**
 * GET /api/admin/users/:id -> 200 { user } (404 when unknown)
 */
export async function getUser(ctx) {
  const id = requireUuid(ctx.params.id);
  const rows = await ctx.db.query(`SELECT ${ADMIN_COLUMNS} FROM users WHERE id = $1`, [id]);
  if (!rows || rows.length === 0) throw new HttpError(404, 'not_found', 'User not found');
  return json({ user: adminUser(rows[0]) });
}

/**
 * POST /api/admin/users  { email, password, name?, role? } -> 201 { user }
 * Creates an account out of band (the user can then sign in with the password).
 */
export async function createUser(ctx) {
  const body = await parseJson(ctx.request);
  const email = normalizeEmail(body.email);
  assertEmail(email);
  assertPassword(body.password);

  const role = body.role === undefined ? 'user' : body.role;
  if (role !== 'user' && role !== 'admin') {
    throw new HttpError(400, 'validation_error', 'role must be "user" or "admin"');
  }

  const rawName = body.name;
  if (rawName !== undefined && rawName !== null && typeof rawName !== 'string') {
    throw new HttpError(400, 'validation_error', 'name must be a string');
  }
  const name = (typeof rawName === 'string' ? rawName.trim() : '').slice(0, 120);

  const passwordHash = await hashPassword(body.password);

  let rows;
  try {
    rows = await ctx.db.query(
      `INSERT INTO users (email, password_hash, name, role)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (email) DO NOTHING
       RETURNING ${ADMIN_COLUMNS}`,
      [email, passwordHash, name, role],
    );
  } catch (e) {
    translate(e);
  }

  if (!rows || rows.length === 0) {
    throw new HttpError(409, 'email_taken', 'An account with this email already exists');
  }

  // Give the new account a personal workspace it owns, so it can use the
  // tenant-scoped finance APIs straight away.
  await ensurePersonalTenant(ctx.db, { userId: rows[0].id, email: rows[0].email, name: rows[0].name });

  await writeAudit(ctx.db, {
    ...actorFromContext(ctx), action: 'admin.user.create', targetType: 'user', targetId: rows[0].id,
    detail: { role },
  });

  return json({ user: adminUser(rows[0]) }, 201);
}

/**
 * PATCH /api/admin/users/:id  { role?, status?, name? } -> 200 { user }
 * Partial update. An admin cannot modify their own role or status.
 */
export async function updateUser(ctx) {
  const id = requireUuid(ctx.params.id);
  if (id === ctx.userId) {
    throw new HttpError(400, 'cannot_modify_self', 'You cannot change your own role or status');
  }

  const body = await parseJson(ctx.request);
  const sets = [];
  const params = [];

  if (body.role !== undefined) {
    if (body.role !== 'user' && body.role !== 'admin') {
      throw new HttpError(400, 'validation_error', 'role must be "user" or "admin"');
    }
    params.push(body.role);
    sets.push(`role = $${params.length}`);
  }

  if (body.status !== undefined) {
    if (body.status !== 'active' && body.status !== 'suspended') {
      throw new HttpError(400, 'validation_error', 'status must be "active" or "suspended"');
    }
    params.push(body.status);
    sets.push(`status = $${params.length}`);
  }

  if (body.name !== undefined) {
    if (typeof body.name !== 'string') {
      throw new HttpError(400, 'validation_error', 'name must be a string');
    }
    params.push(body.name.trim().slice(0, 120));
    sets.push(`name = $${params.length}`);
  }

  if (sets.length === 0) {
    throw new HttpError(400, 'validation_error', 'Provide at least one of: role, status, name');
  }

  params.push(id);
  const rows = await ctx.db.query(
    `UPDATE users SET ${sets.join(', ')}, updated_at = now()
     WHERE id = $${params.length} RETURNING ${ADMIN_COLUMNS}`,
    params,
  );
  if (!rows || rows.length === 0) throw new HttpError(404, 'not_found', 'User not found');

  await writeAudit(ctx.db, {
    ...actorFromContext(ctx), action: 'admin.user.update', targetType: 'user', targetId: id,
    detail: {
      role: body.role ?? null,
      status: body.status ?? null,
      ...(body.name !== undefined ? { nameChanged: true } : {}),
    },
  });

  return json({ user: adminUser(rows[0]) });
}

/**
 * DELETE /api/admin/users/:id -> 204
 * Deletes the account and (via ON DELETE CASCADE) all of its finance rows.
 * An admin cannot delete themselves.
 */
export async function deleteUser(ctx) {
  const id = requireUuid(ctx.params.id);
  if (id === ctx.userId) {
    throw new HttpError(400, 'cannot_delete_self', 'You cannot delete your own account');
  }

  const rows = await ctx.db.query('DELETE FROM users WHERE id = $1 RETURNING id', [id]);
  if (!rows || rows.length === 0) throw new HttpError(404, 'not_found', 'User not found');

  await writeAudit(ctx.db, {
    ...actorFromContext(ctx), action: 'admin.user.delete', targetType: 'user', targetId: id,
  });

  return new Response(null, { status: 204 });
}
