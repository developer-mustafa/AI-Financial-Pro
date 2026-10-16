// src/tenant.js
// Tenant context, tenant-level roles and tenant permissions.
//
// This module is PURE with respect to the database driver: it never imports
// ./db.js, so it can be unit-tested with plain `node --test`. Callers pass an
// object shaped like the app's DB façade (`{ query(text, params) }`).
//
// Two privilege layers are kept strictly separate:
//
//   * PLATFORM privileges live on `users.role` ('user' | 'admin'). 'admin'
//     means PLATFORM_ADMIN. They are granted only by a trusted server-side
//     process (ADMIN_EMAILS bootstrap / an existing admin), never by a client.
//
//   * TENANT privileges live on `tenant_members.role`
//     ('TENANT_ADMIN' | 'TENANT_MEMBER'). They only ever apply inside the one
//     tenant the membership belongs to.
//
// Identity is ALWAYS derived server-side: the authenticated `users.id` comes
// from a verified token, and the tenant is resolved from `tenant_members`.
// A client-supplied `X-Tenant-Id` header is only ever a *selector* — it is
// treated as a request to act within a tenant and is rejected unless an active
// membership for that exact user exists.

import { HttpError } from './http.js';

/* -------------------------------------------------------------------------- *
 * Roles, statuses and permissions
 * -------------------------------------------------------------------------- */

export const PLATFORM_ROLES = ['user', 'admin'];
export const TENANT_ROLES = ['TENANT_ADMIN', 'TENANT_MEMBER'];
export const TENANT_MEMBER_STATUSES = ['active', 'suspended'];
export const TENANT_STATUSES = ['active', 'suspended', 'archived'];

/**
 * Permission matrix for tenant-level roles. Keeping it as data (not scattered
 * `if (role === ...)` checks) means a route declares the permission it needs and
 * the matrix is the single place that decides who has it.
 */
export const TENANT_PERMISSIONS = Object.freeze({
  TENANT_ADMIN: Object.freeze([
    'tenant.read',
    'tenant.update',
    'member.read',
    'member.manage',
    'audit.read',
    'finance.read',
    'finance.write',
  ]),
  TENANT_MEMBER: Object.freeze(['tenant.read', 'finance.read', 'finance.write']),
});

/** Coerce any stored tenant role to the two-value public set (deny by default). */
export function normalizeTenantRole(value) {
  return value === 'TENANT_ADMIN' ? 'TENANT_ADMIN' : 'TENANT_MEMBER';
}

/** Coerce a stored membership status. Anything unexpected counts as suspended. */
export function normalizeMemberStatus(value) {
  return value === 'active' ? 'active' : 'suspended';
}

/** Coerce a stored tenant status. Anything unexpected counts as active (legacy rows). */
export function normalizeTenantStatus(value) {
  return TENANT_STATUSES.includes(value) ? value : 'active';
}

/** True when `role` may perform `permission` inside a tenant. */
export function canTenant(role, permission) {
  const list = TENANT_PERMISSIONS[normalizeTenantRole(role)] || [];
  return list.includes(permission);
}

/** Throw 403 unless the caller's tenant role may perform `permission`. */
export function requirePermission(role, permission) {
  if (!canTenant(role, permission)) {
    throw new HttpError(403, 'forbidden', 'Your role does not allow this action');
  }
}

export function isUuid(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/* -------------------------------------------------------------------------- *
 * Row -> API mapping
 * -------------------------------------------------------------------------- */

function toIso(v) {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString();
}

/** Public shape of a tenant row. Never exposes an owner's credentials. */
export function tenantToApi(row) {
  return {
    id: row.id,
    name: row.name ?? '',
    slug: row.slug ?? null,
    type: row.type === 'personal' ? 'personal' : 'organization',
    status: normalizeTenantStatus(row.status),
    isPersonal: Boolean(row.personal_owner_user_id),
    settings: row.settings && typeof row.settings === 'object' ? row.settings : {},
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

/** Public shape of a tenant membership (joins an (optional) users row). */
export function membershipToApi(row) {
  return {
    tenantId: row.tenant_id ?? row.id,
    userId: row.user_id ?? null,
    role: normalizeTenantRole(row.member_role ?? row.role),
    status: normalizeMemberStatus(row.member_status ?? row.status),
    email: row.email ?? null,
    name: row.name ?? null,
    createdAt: toIso(row.created_at),
  };
}

/** A tenant (with the caller's membership merged in) for the tenant switcher. */
export function membershipTenantToApi(row) {
  return {
    ...tenantToApi(row),
    role: normalizeTenantRole(row.member_role),
    membershipStatus: normalizeMemberStatus(row.member_status),
  };
}

/* -------------------------------------------------------------------------- *
 * Access assertions
 * -------------------------------------------------------------------------- */

/** Reject a suspended membership. */
export function assertMembershipActive(row) {
  if (row && normalizeMemberStatus(row.member_status ?? row.status) === 'suspended') {
    throw new HttpError(403, 'membership_suspended', 'Your access to this workspace is suspended');
  }
}

/**
 * Reject a tenant that is not usable. Suspension is a deliberate administrative
 * action: the data is preserved, but normal application access is blocked with
 * a clear, non-sensitive message.
 */
export function assertTenantAccessible(tenant) {
  const status = normalizeTenantStatus(tenant?.status);
  if (status === 'suspended') {
    throw new HttpError(403, 'tenant_suspended', 'This workspace is suspended. Contact an administrator.');
  }
  if (status === 'archived') {
    throw new HttpError(403, 'tenant_archived', 'This workspace is archived.');
  }
}

/* -------------------------------------------------------------------------- *
 * Personal ("my own") tenants
 * -------------------------------------------------------------------------- */

/**
 * Return the user's personal tenant, creating it (and their TENANT_ADMIN
 * membership) atomically when it does not exist yet. Safe under concurrency:
 * the partial unique index on `personal_owner_user_id` is the conflict target.
 *
 * @param {{query: Function}} db
 * @param {{userId:string, email?:string, name?:string}} owner
 * @returns {Promise<object>} the tenants row
 */
export async function ensurePersonalTenant(db, { userId, email = '', name = '' } = {}) {
  const label = (typeof name === 'string' && name.trim()) || email || 'Personal';
  const tenantName = `${String(label).trim().slice(0, 100)} Personal`;

  const existing = await db.query(
    'SELECT * FROM tenants WHERE personal_owner_user_id = $1 LIMIT 1',
    [userId],
  );
  if (existing && existing.length) return existing[0];

  const created = await db.query(
    `WITH ins AS (
       INSERT INTO tenants (name, type, status, owner_user_id, personal_owner_user_id)
       VALUES ($1, 'personal', 'active', $2, $2)
       ON CONFLICT (personal_owner_user_id) WHERE personal_owner_user_id IS NOT NULL DO NOTHING
       RETURNING *
     ), member AS (
       INSERT INTO tenant_members (tenant_id, user_id, role, status)
       SELECT id, $2, 'TENANT_ADMIN', 'active' FROM ins
       ON CONFLICT (tenant_id, user_id) DO NOTHING
     )
     SELECT * FROM ins`,
    [tenantName, userId],
  );

  if (created && created.length) return created[0];

  // Lost a race (another request created it first): read the winner.
  const again = await db.query(
    'SELECT * FROM tenants WHERE personal_owner_user_id = $1 LIMIT 1',
    [userId],
  );
  if (again && again.length) return again[0];
  throw new HttpError(500, 'tenant_error', 'Could not resolve a workspace for this account');
}

/* -------------------------------------------------------------------------- *
 * Tenant context resolution
 * -------------------------------------------------------------------------- */

/**
 * All tenants this user is an active member of, personal workspace first.
 * @returns {Promise<object[]>} tenants rows with member_role/member_status
 */
export async function listMemberships(db, userId, { includeInactive = false } = {}) {
  const rows = await db.query(
    `SELECT t.*, m.role AS member_role, m.status AS member_status, m.created_at AS member_created_at
       FROM tenant_members m
       JOIN tenants t ON t.id = m.tenant_id
      WHERE m.user_id = $1
      ORDER BY (t.personal_owner_user_id = $1) DESC, t.created_at ASC`,
    [userId],
  );
  if (includeInactive) return rows || [];
  return (rows || []).filter((r) => normalizeMemberStatus(r.member_status) === 'active');
}

/**
 * Resolve the tenant the request may act within.
 *
 * When `headerTenantId` is provided it is used as the requested tenant and an
 * active membership is REQUIRED (never trusted). When it is absent, the user's
 * personal tenant is used, which gives single-workspace accounts a natural,
 * backward-compatible default.
 *
 * @param {{query: Function}} db
 * @param {{id:string, email:string, name?:string}} user authenticated user
 * @param {string|null} headerTenantId raw `X-Tenant-Id` header value
 * @returns {Promise<{tenant:object, tenantId:string, role:string, membership:object}>}
 */
export async function resolveTenantContext(db, user, headerTenantId = null) {
  const userId = user?.id;
  if (!userId) throw new HttpError(401, 'unauthorized', 'Authentication required');

  const requested = typeof headerTenantId === 'string' ? headerTenantId.trim() : '';
  if (requested) {
    if (!isUuid(requested)) {
      throw new HttpError(400, 'invalid_tenant', 'Invalid workspace identifier');
    }
    const rows = await db.query(
      `SELECT t.*, m.role AS member_role, m.status AS member_status
         FROM tenant_members m
         JOIN tenants t ON t.id = m.tenant_id
        WHERE m.tenant_id = $1 AND m.user_id = $2`,
      [requested, userId],
    );
    if (!rows || rows.length === 0) {
      // Deliberately 403 with a generic message: a non-member must not be able
      // to probe which tenant ids exist.
      throw new HttpError(403, 'not_a_member', 'You do not have access to this workspace');
    }
    const row = rows[0];
    assertMembershipActive(row);
    assertTenantAccessible(row);
    return {
      tenant: tenantToApi(row),
      tenantId: row.id,
      role: normalizeTenantRole(row.member_role),
      membership: membershipToApi({ ...row, tenant_id: row.id }),
    };
  }

  const tenant = await ensurePersonalTenant(db, { userId, email: user.email, name: user.name });
  assertTenantAccessible(tenant);
  const membership = await db.query(
    'SELECT role, status FROM tenant_members WHERE tenant_id = $1 AND user_id = $2',
    [tenant.id, userId],
  );
  const row = membership && membership[0] ? membership[0] : { role: 'TENANT_ADMIN', status: 'active' };
  // Defense in depth: a suspended membership must block access on the personal
  // path too, not only when an explicit tenant id is selected.
  assertMembershipActive(row);
  return {
    tenant: tenantToApi(tenant),
    tenantId: tenant.id,
    role: normalizeTenantRole(row.role),
    membership: membershipToApi({ tenant_id: tenant.id, user_id: userId, role: row.role, status: row.status }),
  };
}
