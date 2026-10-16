// src/routes/tenant.js
// Tenant-scoped management: the caller's own workspace profile, its members
// and its audit trail.
//
// Authorization model
// -------------------
// The router (src/index.js) has already authenticated the caller and resolved
// the tenant context from `X-Tenant-Id` (or the personal workspace). `ctx.role`
// is the caller's TENANT role for THAT tenant and is the only thing that
// grants access here. A TENANT_ADMIN can only ever act inside the tenant that
// was resolved for them — there is no code path that accepts a tenant id for a
// write without a membership check.
//
// Personal workspaces (`type === 'personal'`) are single-member by design:
// member management is refused for them, but profile/audit access still works.

import { HttpError, json, parseJson, readQuery } from '../http.js';
import { mapDbError } from '../db.js';
import { normalizeEmail } from '../auth.js';
import { requirePermission, isUuid, membershipToApi, tenantToApi } from '../tenant.js';
import { writeAudit, actorFromContext } from '../audit.js';

const MEMBER_COLUMNS = 'm.user_id, m.tenant_id, m.role AS member_role, m.status AS member_status, m.created_at, u.email, u.name';
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

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

/**
 * GET /api/tenants -> { tenants: [...] }
 * Every active tenant the caller belongs to. Purely self-scoped.
 */
export async function listMyTenants(ctx) {
  const rows = await ctx.db.query(
    `SELECT t.id, t.name, t.slug, t.type, t.status, t.personal_owner_user_id, t.created_at, t.updated_at,
            m.role AS member_role, m.status AS member_status
       FROM tenant_members m
       JOIN tenants t ON t.id = m.tenant_id
      WHERE m.user_id = $1 AND m.status = 'active'
      ORDER BY (t.personal_owner_user_id = $1) DESC, t.created_at ASC`,
    [ctx.userId],
  );
  return json({
    tenants: (rows || []).map((row) => ({
      ...tenantToApi(row),
      role: row.member_role === 'TENANT_ADMIN' ? 'TENANT_ADMIN' : 'TENANT_MEMBER',
    })),
  });
}

/** GET /api/tenants/current -> { tenant, role, permissions } */
export async function getCurrentTenant(ctx) {
  return json({
    tenant: ctx.tenant,
    role: ctx.role,
    tenantId: ctx.tenantId,
  });
}

/**
 * PATCH /api/tenants/current  { name?, slug?, settings? } -> { tenant }
 * Requires tenant.update (TENANT_ADMIN).
 */
export async function updateCurrentTenant(ctx) {
  requirePermission(ctx.role, 'tenant.update');
  const body = await parseJson(ctx.request);

  const sets = [];
  const params = [];

  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || body.name.trim().length === 0 || body.name.trim().length > 120) {
      throw new HttpError(400, 'validation_error', 'name must be a non-empty string of at most 120 characters');
    }
    params.push(body.name.trim());
    sets.push(`name = $${params.length}`);
  }

  if (body.slug !== undefined) {
    if (body.slug === null || body.slug === '') {
      sets.push('slug = NULL');
    } else if (typeof body.slug === 'string' && /^[a-z0-9][a-z0-9-]{1,60}$/.test(body.slug.trim().toLowerCase())) {
      params.push(body.slug.trim().toLowerCase());
      sets.push(`slug = $${params.length}`);
    } else {
      throw new HttpError(400, 'validation_error', 'slug must be 2-61 lowercase letters, digits or dashes');
    }
  }

  if (body.settings !== undefined) {
    if (body.settings === null || typeof body.settings !== 'object' || Array.isArray(body.settings)) {
      throw new HttpError(400, 'validation_error', 'settings must be a JSON object');
    }
    let serialized;
    try {
      serialized = JSON.stringify(body.settings);
    } catch {
      throw new HttpError(400, 'validation_error', 'settings must be JSON-serializable');
    }
    if (serialized.length > 20000) throw new HttpError(400, 'validation_error', 'settings are too large');
    params.push(serialized);
    sets.push(`settings = $${params.length}::jsonb`);
  }

  if (sets.length === 0) {
    throw new HttpError(400, 'validation_error', 'Provide at least one of: name, slug, settings');
  }

  params.push(ctx.tenantId);
  let rows;
  try {
    rows = await ctx.db.query(
      `UPDATE tenants SET ${sets.join(', ')}, updated_at = now()
        WHERE id = $${params.length} RETURNING *`,
      params,
    );
  } catch (e) {
    translate(e);
  }
  if (!rows || rows.length === 0) throw new HttpError(404, 'not_found', 'Workspace not found');

  await writeAudit(ctx.db, {
    ...actorFromContext(ctx),
    action: 'tenant.update',
    targetType: 'tenant',
    targetId: ctx.tenantId,
    tenantId: ctx.tenantId,
    detail: { fields: Object.keys(body).filter((k) => ['name', 'slug', 'settings'].includes(k)) },
  });

  return json({ tenant: tenantToApi(rows[0]) });
}

/** GET /api/tenants/current/members -> { items } (member.read) */
export async function listMembers(ctx) {
  requirePermission(ctx.role, 'member.read');
  const rows = await ctx.db.query(
    `SELECT ${MEMBER_COLUMNS}
       FROM tenant_members m
       JOIN users u ON u.id = m.user_id
      WHERE m.tenant_id = $1
      ORDER BY (m.role = 'TENANT_ADMIN') DESC, u.email ASC`,
    [ctx.tenantId],
  );
  return json({ items: (rows || []).map((row) => ({ ...membershipToApi(row), email: row.email, name: row.name })) });
}

/**
 * POST /api/tenants/current/members  { email, role? } -> 201 { member }
 * Adds an EXISTING account to this workspace. Requires member.manage.
 */
export async function addMember(ctx) {
  requirePermission(ctx.role, 'member.manage');
  assertOrganization(ctx.tenant);

  const body = await parseJson(ctx.request);
  const email = normalizeEmail(body.email);
  if (!email || email.length > 254) throw new HttpError(400, 'validation_error', 'A valid email address is required');

  const role = body.role === undefined ? 'TENANT_MEMBER' : body.role;
  if (role !== 'TENANT_ADMIN' && role !== 'TENANT_MEMBER') {
    throw new HttpError(400, 'validation_error', 'role must be "TENANT_ADMIN" or "TENANT_MEMBER"');
  }

  const users = await ctx.db.query('SELECT id, email, name FROM users WHERE lower(email) = $1', [email]);
  const target = users && users[0];
  if (!target) {
    await writeAudit(ctx.db, {
      ...actorFromContext(ctx), action: 'tenant.member.add', targetType: 'user', targetId: email,
      tenantId: ctx.tenantId, outcome: 'failure', detail: { reason: 'user_not_found' },
    });
    throw new HttpError(404, 'user_not_found', 'No account with that email address exists yet');
  }

  let rows;
  try {
    rows = await ctx.db.query(
      `INSERT INTO tenant_members (tenant_id, user_id, role, status, invited_by)
       VALUES ($1, $2, $3, 'active', $4)
       ON CONFLICT (tenant_id, user_id) DO NOTHING
       RETURNING tenant_id, user_id, role AS member_role, status AS member_status, created_at`,
      [ctx.tenantId, target.id, role, ctx.userId],
    );
  } catch (e) {
    translate(e);
  }
  if (!rows || rows.length === 0) {
    throw new HttpError(409, 'already_member', 'That account is already a member of this workspace');
  }

  await writeAudit(ctx.db, {
    ...actorFromContext(ctx), action: 'tenant.member.add', targetType: 'user', targetId: target.id,
    tenantId: ctx.tenantId, detail: { role },
  });

  return json({ member: { ...membershipToApi(rows[0]), email: target.email, name: target.name } }, 201);
}

/**
 * PATCH /api/tenants/current/members/:userId  { role?, status? } -> { member }
 * Requires member.manage. Guards against removing the last administrator and
 * against changing your own role.
 */
export async function updateMember(ctx) {
  requirePermission(ctx.role, 'member.manage');
  const targetId = requireUuid(ctx.params.userId, 'Member not found');

  const body = await parseJson(ctx.request);
  const sets = [];
  const params = [];

  let nextRole = null;
  if (body.role !== undefined) {
    if (body.role !== 'TENANT_ADMIN' && body.role !== 'TENANT_MEMBER') {
      throw new HttpError(400, 'validation_error', 'role must be "TENANT_ADMIN" or "TENANT_MEMBER"');
    }
    if (targetId === ctx.userId && body.role !== 'TENANT_ADMIN') {
      throw new HttpError(400, 'cannot_modify_self', 'You cannot remove your own administrator role');
    }
    nextRole = body.role;
    params.push(body.role);
    sets.push(`role = $${params.length}`);
  }

  if (body.status !== undefined) {
    if (body.status !== 'active' && body.status !== 'suspended') {
      throw new HttpError(400, 'validation_error', 'status must be "active" or "suspended"');
    }
    if (targetId === ctx.userId && body.status === 'suspended') {
      throw new HttpError(400, 'cannot_modify_self', 'You cannot suspend your own membership');
    }
    params.push(body.status);
    sets.push(`status = $${params.length}`);
  }

  if (sets.length === 0) throw new HttpError(400, 'validation_error', 'Provide role and/or status');

  if (nextRole === 'TENANT_MEMBER') {
    await assertNotLastAdmin(ctx, targetId);
  }

  params.push(ctx.tenantId, targetId);
  let rows;
  try {
    rows = await ctx.db.query(
      `UPDATE tenant_members SET ${sets.join(', ')}, updated_at = now()
        WHERE tenant_id = $${params.length - 1} AND user_id = $${params.length}
        RETURNING tenant_id, user_id, role AS member_role, status AS member_status, created_at`,
      params,
    );
  } catch (e) {
    translate(e);
  }
  if (!rows || rows.length === 0) throw new HttpError(404, 'not_found', 'Member not found');

  await writeAudit(ctx.db, {
    ...actorFromContext(ctx), action: 'tenant.member.update', targetType: 'user', targetId,
    tenantId: ctx.tenantId, detail: { role: body.role ?? null, status: body.status ?? null },
  });

  return json({ member: membershipToApi(rows[0]) });
}

/**
 * DELETE /api/tenants/current/members/:userId -> 204
 * Requires member.manage. Removes the MEMBERSHIP only — the user account and
 * its data in other tenants are untouched.
 */
export async function removeMember(ctx) {
  requirePermission(ctx.role, 'member.manage');
  const targetId = requireUuid(ctx.params.userId, 'Member not found');

  if (targetId === ctx.userId) {
    throw new HttpError(400, 'cannot_remove_self', 'You cannot remove your own membership');
  }
  if (ctx.tenant?.isPersonal) {
    throw new HttpError(400, 'not_allowed', 'A personal workspace has no removable members');
  }
  await assertNotLastAdmin(ctx, targetId);

  const rows = await ctx.db.query(
    'DELETE FROM tenant_members WHERE tenant_id = $1 AND user_id = $2 RETURNING user_id',
    [ctx.tenantId, targetId],
  );
  if (!rows || rows.length === 0) throw new HttpError(404, 'not_found', 'Member not found');

  await writeAudit(ctx.db, {
    ...actorFromContext(ctx), action: 'tenant.member.remove', targetType: 'user', targetId, tenantId: ctx.tenantId,
  });

  return new Response(null, { status: 204 });
}

/**
 * GET /api/tenants/current/audit?limit=&offset= -> { items, total }
 * Requires audit.read. Only ever returns this tenant's audit rows.
 */
export async function listTenantAudit(ctx) {
  requirePermission(ctx.role, 'audit.read');
  const query = readQuery(ctx.request);
  const limit = clampInt(query.get('limit'), DEFAULT_LIMIT, 1, MAX_LIMIT);
  const offset = clampInt(query.get('offset'), 0, 0, 1_000_000_000);

  const countRows = await ctx.db.query('SELECT count(*)::int AS total FROM audit_logs WHERE tenant_id = $1', [ctx.tenantId]);
  const total = Number((countRows && countRows[0] && countRows[0].total) || 0);

  const rows = await ctx.db.query(
    `SELECT id, actor_user_id, actor_email, action, target_type, target_id, tenant_id, outcome, detail, created_at
       FROM audit_logs
      WHERE tenant_id = $1
      ORDER BY created_at DESC, id DESC
      LIMIT $2 OFFSET $3`,
    [ctx.tenantId, limit, offset],
  );

  return json({ items: (rows || []).map(auditToApi), total, limit, offset });
}

/* -------------------------------------------------------------------------- *
 * helpers
 * -------------------------------------------------------------------------- */

function assertOrganization(tenant) {
  if (tenant?.isPersonal) {
    throw new HttpError(400, 'not_allowed', 'A personal workspace cannot have additional members');
  }
}

function requireUuid(value, message) {
  const id = typeof value === 'string' ? value.trim() : '';
  if (!isUuid(id)) throw new HttpError(404, 'not_found', message || 'Not found');
  return id;
}

/** Refuse an action that would leave the tenant with no active administrator. */
async function assertNotLastAdmin(ctx, excludingUserId) {
  const rows = await ctx.db.query(
    `SELECT count(*)::int AS n
       FROM tenant_members
      WHERE tenant_id = $1 AND role = 'TENANT_ADMIN' AND status = 'active' AND user_id <> $2`,
    [ctx.tenantId, excludingUserId],
  );
  const remaining = Number((rows && rows[0] && rows[0].n) || 0);
  if (remaining === 0) {
    throw new HttpError(400, 'last_admin', 'A workspace must keep at least one active administrator');
  }
}

export function auditToApi(row) {
  return {
    id: row.id != null ? String(row.id) : null,
    actorUserId: row.actor_user_id || null,
    actorEmail: row.actor_email || null,
    action: row.action,
    targetType: row.target_type || null,
    targetId: row.target_id || null,
    tenantId: row.tenant_id || null,
    outcome: row.outcome || 'success',
    detail: row.detail && typeof row.detail === 'object' ? row.detail : {},
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : (row.created_at || null),
  };
}
