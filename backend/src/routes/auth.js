// src/routes/auth.js
import { json, parseJson, HttpError } from '../http.js';
import { mapDbError } from '../db.js';
import {
  assertEmail,
  assertPassword,
  assertActive,
  createToken,
  hashPassword,
  normalizeEmail,
  promoteAdminIfListed,
  requireAuth,
  userToApi,
  verifyPassword,
} from '../auth.js';
import { ensurePersonalTenant, listMemberships, membershipTenantToApi } from '../tenant.js';

// A syntactically valid hash used when the email does not exist, so that login
// always performs the same PBKDF2 work (reduces user-enumeration timing).
const DUMMY_HASH = 'pbkdf2$150000$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

function translate(e) {
  const mapped = mapDbError(e);
  if (mapped) throw mapped;
  throw e;
}

/**
 * POST /api/auth/register  { email, password, name? }
 * -> 201 { token, user }
 */
export async function register(ctx) {
  const body = await parseJson(ctx.request);
  const email = normalizeEmail(body.email);
  assertEmail(email);
  assertPassword(body.password);

  const rawName = body.name;
  if (rawName !== undefined && rawName !== null && typeof rawName !== 'string') {
    throw new HttpError(400, 'validation_error', 'name must be a string');
  }
  const name = (typeof rawName === 'string' ? rawName.trim() : '').slice(0, 120);

  const passwordHash = await hashPassword(body.password);

  let rows;
  try {
    rows = await ctx.db.query(
      `INSERT INTO users (email, password_hash, name)
       VALUES ($1, $2, $3)
       ON CONFLICT (email) DO NOTHING
       RETURNING id, email, name, created_at, updated_at`,
      [email, passwordHash, name],
    );
  } catch (e) {
    translate(e);
  }

  if (!rows || rows.length === 0) {
    throw new HttpError(409, 'email_taken', 'An account with this email already exists');
  }

  // Bootstrap: this account becomes an administrator when its email is listed
  // in the ADMIN_EMAILS Worker variable.
  const row = await promoteAdminIfListed(ctx.db, ctx.env, rows[0]);
  const user = userToApi(row);

  // Every account gets a personal workspace it owns, so it can use the
  // tenant-scoped finance APIs immediately.
  await ensurePersonalTenant(ctx.db, { userId: user.id, email: user.email, name: user.name });
  const memberships = await membershipsFor(ctx.db, user.id);

  const token = await createToken({ sub: user.id }, ctx.env);
  return json({ token, user, memberships, defaultTenantId: memberships[0]?.tenantId || null }, 201);
}

/**
 * POST /api/auth/login  { email, password }
 * -> 200 { token, user }
 */
export async function login(ctx) {
  const body = await parseJson(ctx.request);
  const email = normalizeEmail(body.email);
  assertEmail(email);
  assertPassword(body.password);

  const rows = await ctx.db.query(
    `SELECT id, email, name, password_hash, role, status, created_at, updated_at
     FROM users WHERE lower(email) = $1`,
    [email],
  );
  const row = rows && rows[0];
  const ok = await verifyPassword(body.password, row ? row.password_hash : DUMMY_HASH);
  if (!row || !ok) {
    throw new HttpError(401, 'invalid_credentials', 'Invalid email or password');
  }

  // A suspended account proved its password but is not allowed in.
  assertActive(row);

  const promoted = await promoteAdminIfListed(ctx.db, ctx.env, row);
  const user = userToApi(promoted);
  await ensurePersonalTenant(ctx.db, { userId: user.id, email: user.email, name: user.name });
  const memberships = await membershipsFor(ctx.db, user.id);
  const token = await createToken({ sub: user.id }, ctx.env);
  return json({ token, user, memberships, defaultTenantId: memberships[0]?.tenantId || null }, 200);
}

/**
 * POST /api/auth/logout
 * Tokens are stateless; the client discards it. -> 204
 */
export async function logout() {
  return new Response(null, { status: 204 });
}

/**
 * GET /api/auth/me -> 200 { user, memberships, defaultTenantId }
 * The caller is already authenticated by the router; ctx.user is populated.
 */
export async function me(ctx) {
  let user = ctx.user;
  if (!user) {
    ({ user } = await requireAuth(ctx.request, ctx.env));
  }
  await ensurePersonalTenant(ctx.db, { userId: user.id, email: user.email, name: user.name });
  const memberships = await membershipsFor(ctx.db, user.id);
  return json({ user, memberships, defaultTenantId: memberships[0]?.tenantId || null });
}

/** Tenants this user may act in, personal workspace first. Never includes others. */
async function membershipsFor(db, userId) {
  const rows = await listMemberships(db, userId);
  return rows.map(membershipTenantToApi);
}
