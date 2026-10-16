// src/routes/platform.js
// Platform administration (PLATFORM_ADMIN only).
//
// Every handler runs ONLY after the router has authenticated the caller and
// confirmed `ctx.user.role === 'admin'` (route flag `admin: true`). The platform
// role is never read from a request body.
//
// Scope and safety
// ----------------
//   * Platform admins manage TENANTS and their MEMBERSHIPS. They do not get
//     implicit access to a tenant's financial records: the finance APIs require
//     a tenant membership like everyone else.
//   * Tenant deletion is a SOFT archive. No irreversible DELETE of a tenant is
//     exposed (the brief forbids it without explicit approval); archiving is
//     audited and reversible through the same endpoint.
//   * Sensitive operations write an audit_logs row. Audit rows never contain
//     credentials, tokens or financial values.

import { HttpError, json, parseJson, readQuery } from '../http.js';
import { mapDbError } from '../db.js';
import { hashPassword, assertPassword, normalizeEmail, assertEmail } from '../auth.js';
import { isUuid, normalizeTenantStatus, tenantToApi, membershipToApi } from '../tenant.js';
import { writeAudit, actorFromContext } from '../audit.js';
import { auditToApi } from './tenant.js';

const TENANT_SORTS = new Set(['created_at', 'updated_at', 'name', 'status']);
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const MAX_SEARCH = 120;
const TENANT_STATUSES = ['active', 'suspended', 'archived'];

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

function requireUuidParam(value, message) {
  const id = typeof value === 'string' ? value.trim() : '';
  if (!isUuid(id)) throw new HttpError(404, 'not_found', message || 'Not found');
  return id;
}

/* -------------------------------------------------------------------------- *
 * Overview
 * -------------------------------------------------------------------------- */

/** GET /api/platform/overview -> { tenants, users } */
export async function overview(ctx) {
  const [tenantRows, userRows] = await Promise.all([
    ctx.db.query(
      `SELECT
         count(*)::int                                                     AS total,
         count(*) FILTER (WHERE status = 'active')::int                    AS active,
         count(*) FILTER (WHERE status = 'suspended')::int                 AS suspended,
         count(*) FILTER (WHERE status = 'archived')::int                  AS archived,
         count(*) FILTER (WHERE type = 'organization')::int                AS organizations,
         count(*) FILTER (WHERE type = 'personal')::int                    AS personal
       FROM tenants`,
    ),
    ctx.db.query(
      `SELECT
         count(*)::int                                                     AS total,
         count(*) FILTER (WHERE role = 'admin')::int                       AS admins,
         count(*) FILTER (WHERE status = 'suspended')::int                 AS suspended
       FROM users`,
    ),
  ]);

  const [txRows, accountRows] = await Promise.all([
    ctx.db.query('SELECT count(*)::int AS n FROM transactions'),
    ctx.db.query('SELECT count(*)::int AS n FROM accounts'),
  ]);

  const t = (tenantRows && tenantRows[0]) || {};
  const u = (userRows && userRows[0]) || {};
  return json({
    tenants: {
      total: Number(t.total || 0),
      active: Number(t.active || 0),
      suspended: Number(t.suspended || 0),
      archived: Number(t.archived || 0),
      organizations: Number(t.organizations || 0),
      personal: Number(t.personal || 0),
    },
    users: {
      total: Number(u.total || 0),
      admins: Number(u.admins || 0),
      suspended: Number(u.suspended || 0),
    },
    usage: {
      transactions: Number((txRows?.[0]?.n) || 0),
      accounts: Number((accountRows?.[0]?.n) || 0),
    },
  });
}

/* -------------------------------------------------------------------------- *
 * Tenants
 * -------------------------------------------------------------------------- */

const TENANT_LIST_COLUMNS = `
  t.*,
  (SELECT count(*) FROM tenant_members m WHERE m.tenant_id = t.id AND m.status = 'active')::int AS member_count,
  (SELECT count(*) FROM transactions x WHERE x.tenant_id = t.id)::int                          AS transaction_count,
  (SELECT count(*) FROM accounts a WHERE a.tenant_id = t.id)::int                              AS account_count
`;

/** GET /api/platform/tenants?q=&status=&type=&sort=&order=&limit=&offset= */
export async function listTenants(ctx) {
  const query = readQuery(ctx.request);
  const limit = clampInt(query.get('limit'), DEFAULT_LIMIT, 1, MAX_LIMIT);
  const offset = clampInt(query.get('offset'), 0, 0, 1_000_000_000);
  const search = String(query.get('q') || '').trim().toLowerCase().slice(0, MAX_SEARCH);
  const status = String(query.get('status') || '').trim();
  const type = String(query.get('type') || '').trim();
  const sortParam = String(query.get('sort') || 'created_at').trim();
  const sort = TENANT_SORTS.has(sortParam) ? sortParam : 'created_at';
  const order = String(query.get('order') || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';

  const where = [];
  const params = [];
  if (search) {
    params.push(`%${search}%`);
    where.push(`(lower(t.name) LIKE $${params.length} OR lower(coalesce(t.slug, '')) LIKE $${params.length} OR t.id::text = $${params.length})`);
  }
  if (TENANT_STATUSES.includes(status)) {
    params.push(status);
    where.push(`t.status = $${params.length}`);
  }
  if (type === 'personal' || type === 'organization') {
    params.push(type);
    where.push(`t.type = $${params.length}`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const countRows = await ctx.db.query(`SELECT count(*)::int AS total FROM tenants t ${whereSql}`, params);
  const total = Number((countRows && countRows[0] && countRows[0].total) || 0);

  const listParams = [...params, limit, offset];
  const rows = await ctx.db.query(
    `SELECT ${TENANT_LIST_COLUMNS} FROM tenants t ${whereSql}
      ORDER BY t.${sort} ${order}, t.id
      LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`,
    listParams,
  );

  return json({
    items: (rows || []).map((row) => ({
      ...tenantToApi(row),
      memberCount: Number(row.member_count || 0),
      transactionCount: Number(row.transaction_count || 0),
      accountCount: Number(row.account_count || 0),
    })),
    total,
    limit,
    offset,
  });
}

/** GET /api/platform/tenants/:id -> { tenant, members, counts } */
export async function getTenant(ctx) {
  const id = requireUuidParam(ctx.params.id, 'Workspace not found');
  const rows = await ctx.db.query(`SELECT ${TENANT_LIST_COLUMNS} FROM tenants t WHERE t.id = $1`, [id]);
  if (!rows || rows.length === 0) throw new HttpError(404, 'not_found', 'Workspace not found');
  const row = rows[0];

  const members = await ctx.db.query(
    `SELECT m.user_id, m.tenant_id, m.role AS member_role, m.status AS member_status, m.created_at, u.email, u.name
       FROM tenant_members m JOIN users u ON u.id = m.user_id
      WHERE m.tenant_id = $1
      ORDER BY (m.role = 'TENANT_ADMIN') DESC, u.email ASC`,
    [id],
  );

  return json({
    tenant: {
      ...tenantToApi(row),
      memberCount: Number(row.member_count || 0),
      transactionCount: Number(row.transaction_count || 0),
      accountCount: Number(row.account_count || 0),
    },
    members: (members || []).map((m) => ({ ...membershipToApi(m), email: m.email, name: m.name })),
  });
}

/**
 * POST /api/platform/tenants  { name, slug?, ownerEmail? } -> 201 { tenant }
 * Creates an organization tenant. When `ownerEmail` names an existing account,
 * that account is added as its first TENANT_ADMIN.
 */
export async function createTenant(ctx) {
  const body = await parseJson(ctx.request);
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 120) : '';
  if (!name) throw new HttpError(400, 'validation_error', 'name is required');

  let slug = null;
  if (body.slug !== undefined && body.slug !== null && body.slug !== '') {
    if (typeof body.slug !== 'string' || !/^[a-z0-9][a-z0-9-]{1,60}$/.test(body.slug.trim().toLowerCase())) {
      throw new HttpError(400, 'validation_error', 'slug must be 2-61 lowercase letters, digits or dashes');
    }
    slug = body.slug.trim().toLowerCase();
  }

  let owner = null;
  if (body.ownerEmail !== undefined && body.ownerEmail !== null && body.ownerEmail !== '') {
    const email = normalizeEmail(body.ownerEmail);
    const users = await ctx.db.query('SELECT id, email, name FROM users WHERE lower(email) = $1', [email]);
    if (!users || users.length === 0) {
      throw new HttpError(404, 'user_not_found', 'No account with that email address exists yet');
    }
    owner = users[0];
  }

  let rows;
  try {
    rows = await ctx.db.query(
      `INSERT INTO tenants (name, slug, type, status, owner_user_id)
       VALUES ($1, $2, 'organization', 'active', $3)
       RETURNING *`,
      [name, slug, owner ? owner.id : ctx.userId],
    );
  } catch (e) {
    translate(e);
  }
  const tenant = rows[0];

  if (owner) {
    await ctx.db.query(
      `INSERT INTO tenant_members (tenant_id, user_id, role, status, invited_by)
       VALUES ($1, $2, 'TENANT_ADMIN', 'active', $3)
       ON CONFLICT (tenant_id, user_id) DO NOTHING`,
      [tenant.id, owner.id, ctx.userId],
    );
  }

  await writeAudit(ctx.db, {
    ...actorFromContext(ctx), action: 'platform.tenant.create', targetType: 'tenant', targetId: tenant.id,
    tenantId: tenant.id, detail: { name, slug, owner: owner ? owner.email : null },
  });

  return json({ tenant: tenantToApi(tenant) }, 201);
}

/**
 * PATCH /api/platform/tenants/:id  { name?, slug?, status?, settings? }
 * Status may be 'active' | 'suspended' | 'archived' (activate/suspend/reopen).
 */
export async function updateTenant(ctx) {
  const id = requireUuidParam(ctx.params.id, 'Workspace not found');
  const body = await parseJson(ctx.request);

  const sets = [];
  const params = [];

  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 120) {
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

  let nextStatus = null;
  if (body.status !== undefined) {
    if (!TENANT_STATUSES.includes(body.status)) {
      throw new HttpError(400, 'validation_error', 'status must be active, suspended or archived');
    }
    nextStatus = body.status;
    params.push(body.status);
    sets.push(`status = $${params.length}`);
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

  if (sets.length === 0) throw new HttpError(400, 'validation_error', 'Provide at least one of: name, slug, status, settings');

  params.push(id);
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

  const action = nextStatus ? `platform.tenant.${nextStatus === 'suspended' ? 'suspend' : nextStatus === 'archived' ? 'archive' : 'activate'}` : 'platform.tenant.update';
  await writeAudit(ctx.db, {
    ...actorFromContext(ctx), action, targetType: 'tenant', targetId: id, tenantId: id,
    detail: { fields: Object.keys(body).filter((k) => ['name', 'slug', 'status', 'settings'].includes(k)) },
  });

  return json({ tenant: tenantToApi(rows[0]) });
}

/**
 * DELETE /api/platform/tenants/:id -> 200 { tenant }
 * SOFT archive only. This deliberately does NOT hard-delete a tenant or its
 * data: irreversible deletion requires explicit approval and a retention policy.
 */
export async function archiveTenant(ctx) {
  const id = requireUuidParam(ctx.params.id, 'Workspace not found');
  const query = readQuery(ctx.request);
  if (String(query.get('hard') || '') === 'true') {
    throw new HttpError(403, 'not_allowed', 'Hard deletion is disabled. Archive the workspace instead.');
  }

  const rows = await ctx.db.query(
    `UPDATE tenants SET status = 'archived', updated_at = now() WHERE id = $1 RETURNING *`,
    [id],
  );
  if (!rows || rows.length === 0) throw new HttpError(404, 'not_found', 'Workspace not found');

  await writeAudit(ctx.db, {
    ...actorFromContext(ctx), action: 'platform.tenant.archive', targetType: 'tenant', targetId: id, tenantId: id,
  });

  return json({ tenant: tenantToApi(rows[0]) });
}

/* -------------------------------------------------------------------------- *
 * Tenant memberships (platform view)
 * -------------------------------------------------------------------------- */

/** POST /api/platform/tenants/:id/members  { email, role? } -> 201 { member } */
export async function addTenantMember(ctx) {
  const id = requireUuidParam(ctx.params.id, 'Workspace not found');
  const body = await parseJson(ctx.request);
  const email = normalizeEmail(body.email);
  if (!email || email.length > 254) throw new HttpError(400, 'validation_error', 'A valid email address is required');

  const role = body.role === undefined ? 'TENANT_MEMBER' : body.role;
  if (role !== 'TENANT_ADMIN' && role !== 'TENANT_MEMBER') {
    throw new HttpError(400, 'validation_error', 'role must be "TENANT_ADMIN" or "TENANT_MEMBER"');
  }

  const users = await ctx.db.query('SELECT id, email, name FROM users WHERE lower(email) = $1', [email]);
  const target = users && users[0];
  if (!target) throw new HttpError(404, 'user_not_found', 'No account with that email address exists yet');

  let rows;
  try {
    rows = await ctx.db.query(
      `INSERT INTO tenant_members (tenant_id, user_id, role, status, invited_by)
       VALUES ($1, $2, $3, 'active', $4)
       ON CONFLICT (tenant_id, user_id) DO NOTHING
       RETURNING tenant_id, user_id, role AS member_role, status AS member_status, created_at`,
      [id, target.id, role, ctx.userId],
    );
  } catch (e) {
    translate(e);
  }
  if (!rows || rows.length === 0) throw new HttpError(409, 'already_member', 'That account is already a member of this workspace');

  await writeAudit(ctx.db, {
    ...actorFromContext(ctx), action: 'platform.member.add', targetType: 'user', targetId: target.id, tenantId: id,
    detail: { role },
  });

  return json({ member: { ...membershipToApi(rows[0]), email: target.email, name: target.name } }, 201);
}

/** PATCH /api/platform/tenants/:id/members/:userId  { role?, status? } */
export async function updateTenantMember(ctx) {
  const id = requireUuidParam(ctx.params.id, 'Workspace not found');
  const targetId = requireUuidParam(ctx.params.userId, 'Member not found');
  const body = await parseJson(ctx.request);

  const sets = [];
  const params = [];
  if (body.role !== undefined) {
    if (body.role !== 'TENANT_ADMIN' && body.role !== 'TENANT_MEMBER') {
      throw new HttpError(400, 'validation_error', 'role must be "TENANT_ADMIN" or "TENANT_MEMBER"');
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
  if (sets.length === 0) throw new HttpError(400, 'validation_error', 'Provide role and/or status');

  params.push(id, targetId);
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
    ...actorFromContext(ctx), action: 'platform.member.update', targetType: 'user', targetId, tenantId: id,
    detail: { role: body.role ?? null, status: body.status ?? null },
  });

  return json({ member: membershipToApi(rows[0]) });
}

/** DELETE /api/platform/tenants/:id/members/:userId -> 204 (membership only) */
export async function removeTenantMember(ctx) {
  const id = requireUuidParam(ctx.params.id, 'Workspace not found');
  const targetId = requireUuidParam(ctx.params.userId, 'Member not found');

  const rows = await ctx.db.query(
    'DELETE FROM tenant_members WHERE tenant_id = $1 AND user_id = $2 RETURNING user_id',
    [id, targetId],
  );
  if (!rows || rows.length === 0) throw new HttpError(404, 'not_found', 'Member not found');

  await writeAudit(ctx.db, {
    ...actorFromContext(ctx), action: 'platform.member.remove', targetType: 'user', targetId, tenantId: id,
  });

  return new Response(null, { status: 204 });
}

/* -------------------------------------------------------------------------- *
 * Users across the platform
 * -------------------------------------------------------------------------- */

/** GET /api/platform/users?q=&limit=&offset= -> { items, total } with tenants */
export async function listUsers(ctx) {
  const query = readQuery(ctx.request);
  const limit = clampInt(query.get('limit'), DEFAULT_LIMIT, 1, MAX_LIMIT);
  const offset = clampInt(query.get('offset'), 0, 0, 1_000_000_000);
  const search = String(query.get('q') || '').trim().toLowerCase().slice(0, MAX_SEARCH);

  const params = [];
  let where = '';
  if (search) {
    params.push(`%${search}%`);
    where = 'WHERE lower(u.email) LIKE $1 OR lower(u.name) LIKE $1';
  }

  const countRows = await ctx.db.query(`SELECT count(*)::int AS total FROM users u ${where}`, params);
  const total = Number((countRows && countRows[0] && countRows[0].total) || 0);

  params.push(limit, offset);
  const rows = await ctx.db.query(
    `SELECT u.id, u.email, u.name, u.role, u.status, u.auth_provider, u.created_at, u.updated_at,
            (SELECT count(*) FROM tenant_members m WHERE m.user_id = u.id AND m.status = 'active')::int AS tenant_count
       FROM users u ${where}
      ORDER BY u.created_at DESC, u.id
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );

  return json({
    items: (rows || []).map((row) => ({
      id: row.id,
      email: row.email,
      name: row.name ?? '',
      role: row.role === 'admin' ? 'admin' : 'user',
      status: row.status === 'suspended' ? 'suspended' : 'active',
      provider: row.auth_provider === 'neon' ? 'neon' : 'password',
      tenantCount: Number(row.tenant_count || 0),
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
      updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
    })),
    total,
    limit,
    offset,
  });
}

/** GET /api/platform/users/:id/memberships -> { items } */
export async function listUserTenants(ctx) {
  const id = requireUuidParam(ctx.params.id, 'User not found');
  const rows = await ctx.db.query(
    `SELECT t.id AS tenant_id, t.name AS tenant_name, t.type AS tenant_type, t.status AS tenant_status,
            m.role AS member_role, m.status AS member_status, m.created_at
       FROM tenant_members m JOIN tenants t ON t.id = m.tenant_id
      WHERE m.user_id = $1
      ORDER BY (t.personal_owner_user_id = $1) DESC, t.created_at ASC`,
    [id],
  );
  return json({
    items: (rows || []).map((row) => ({
      tenantId: row.tenant_id,
      tenantName: row.tenant_name,
      tenantType: row.tenant_type === 'personal' ? 'personal' : 'organization',
      tenantStatus: normalizeTenantStatus(row.tenant_status),
      role: row.member_role === 'TENANT_ADMIN' ? 'TENANT_ADMIN' : 'TENANT_MEMBER',
      status: row.member_status === 'active' ? 'active' : 'suspended',
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    })),
  });
}

/* -------------------------------------------------------------------------- *
 * Audit trail
 * -------------------------------------------------------------------------- */

/** GET /api/platform/audit?tenantId=&action=&actorId=&limit=&offset= */
export async function listAudit(ctx) {
  const query = readQuery(ctx.request);
  const limit = clampInt(query.get('limit'), DEFAULT_LIMIT, 1, MAX_LIMIT);
  const offset = clampInt(query.get('offset'), 0, 0, 1_000_000_000);
  const tenantId = String(query.get('tenantId') || '').trim();
  const actorId = String(query.get('actorId') || '').trim();
  const action = String(query.get('action') || '').trim().slice(0, 120);

  const where = [];
  const params = [];
  if (isUuid(tenantId)) {
    params.push(tenantId);
    where.push(`tenant_id = $${params.length}`);
  }
  if (isUuid(actorId)) {
    params.push(actorId);
    where.push(`actor_user_id = $${params.length}`);
  }
  if (action) {
    params.push(`%${action}%`);
    where.push(`action LIKE $${params.length}`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const countRows = await ctx.db.query(`SELECT count(*)::int AS total FROM audit_logs ${whereSql}`, params);
  const total = Number((countRows && countRows[0] && countRows[0].total) || 0);

  const listParams = [...params, limit, offset];
  const rows = await ctx.db.query(
    `SELECT id, actor_user_id, actor_email, action, target_type, target_id, tenant_id, outcome, detail, created_at
       FROM audit_logs ${whereSql}
      ORDER BY created_at DESC, id DESC
      LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`,
    listParams,
  );

  return json({ items: (rows || []).map(auditToApi), total, limit, offset });
}

/* -------------------------------------------------------------------------- *
 * Platform user administration (create accounts out of band)
 * -------------------------------------------------------------------------- */

/** POST /api/platform/users  { email, password, name?, role? } -> 201 { user } */
export async function createUser(ctx) {
  const body = await parseJson(ctx.request);
  const email = normalizeEmail(body.email);
  assertEmail(email);
  assertPassword(body.password);

  const role = body.role === undefined ? 'user' : body.role;
  if (role !== 'user' && role !== 'admin') {
    throw new HttpError(400, 'validation_error', 'role must be "user" or "admin"');
  }
  const name = (typeof body.name === 'string' ? body.name.trim() : '').slice(0, 120);
  const passwordHash = await hashPassword(body.password);

  let rows;
  try {
    rows = await ctx.db.query(
      `INSERT INTO users (email, password_hash, name, role)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (email) DO NOTHING
       RETURNING id, email, name, role, status, auth_provider, created_at, updated_at`,
      [email, passwordHash, name, role],
    );
  } catch (e) {
    translate(e);
  }
  if (!rows || rows.length === 0) throw new HttpError(409, 'email_taken', 'An account with this email already exists');

  await writeAudit(ctx.db, {
    ...actorFromContext(ctx), action: 'platform.user.create', targetType: 'user', targetId: rows[0].id,
    detail: { role },
  });

  return json({ user: rows[0] }, 201);
}
