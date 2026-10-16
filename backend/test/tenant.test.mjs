// test/tenant.test.mjs
// Multi-tenant server logic: roles/permissions, tenant context resolution,
// personal-workspace provisioning, tenant-scoped SQL builders and the
// Neon-Auth email-verification gate.
//
// Like the rest of this suite, it imports ONLY pure modules (no ./db.js), so
// @neondatabase/serverless is never loaded and no database is required.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TENANT_ROLES,
  TENANT_PERMISSIONS,
  normalizeTenantRole,
  normalizeTenantStatus,
  normalizeMemberStatus,
  canTenant,
  requirePermission,
  isUuid,
  tenantToApi,
  membershipToApi,
  assertMembershipActive,
  assertTenantAccessible,
  resolveTenantContext,
  ensurePersonalTenant,
  listMemberships,
} from '../src/tenant.js';

import { buildInsert, buildUpsert, buildUpdate } from '../src/validate.js';

import { ensureNeonUser, NEON_PASSWORD_SENTINEL } from '../src/auth.js';

import { HttpError } from '../src/http.js';

const USER = { id: '11111111-2222-4333-8444-555555555555', email: 'owner@example.com', name: 'Owner' };
const OTHER_TENANT = '99999999-8888-4777-8666-555555555555';

function statusCode(e) {
  return e instanceof HttpError ? e.status : null;
}

/** A tiny scripted db façade: the first matching rule wins. */
function scriptedDb(rules) {
  const calls = [];
  return {
    calls,
    async query(text, params = []) {
      calls.push({ text, params });
      for (const rule of rules) {
        if (rule.match.test(text)) return typeof rule.rows === 'function' ? rule.rows(params, text) : rule.rows;
      }
      return [];
    },
  };
}

// ---------------------------------------------------------------------------
// Roles and permissions
// ---------------------------------------------------------------------------

test('tenant roles are the two-value set', () => {
  assert.deepEqual(TENANT_ROLES, ['TENANT_ADMIN', 'TENANT_MEMBER']);
});

test('normalizeTenantRole denies anything unrecognised to TENANT_MEMBER', () => {
  assert.equal(normalizeTenantRole('TENANT_ADMIN'), 'TENANT_ADMIN');
  assert.equal(normalizeTenantRole('TENANT_MEMBER'), 'TENANT_MEMBER');
  assert.equal(normalizeTenantRole('admin'), 'TENANT_MEMBER');
  assert.equal(normalizeTenantRole(undefined), 'TENANT_MEMBER');
  assert.equal(normalizeTenantRole('PLATFORM_ADMIN'), 'TENANT_MEMBER');
});

test('tenant status and member status normalise defensively', () => {
  assert.equal(normalizeTenantStatus('suspended'), 'suspended');
  assert.equal(normalizeTenantStatus('weird'), 'active');
  assert.equal(normalizeMemberStatus('active'), 'active');
  assert.equal(normalizeMemberStatus('weird'), 'suspended');
});

test('TENANT_ADMIN can manage, TENANT_MEMBER cannot', () => {
  assert.equal(canTenant('TENANT_ADMIN', 'member.manage'), true);
  assert.equal(canTenant('TENANT_ADMIN', 'audit.read'), true);
  assert.equal(canTenant('TENANT_MEMBER', 'member.manage'), false);
  assert.equal(canTenant('TENANT_MEMBER', 'finance.write'), true);
  assert.equal(canTenant('TENANT_MEMBER', 'audit.read'), false);
  // An unknown role is treated as the least-privileged member.
  assert.equal(canTenant('nope', 'finance.write'), true);
  assert.equal(canTenant('nope', 'member.manage'), false);
});

test('requirePermission throws a 403 for a disallowed action', () => {
  assert.throws(() => requirePermission('TENANT_MEMBER', 'member.manage'), (e) => statusCode(e) === 403);
  assert.doesNotThrow(() => requirePermission('TENANT_ADMIN', 'member.manage'));
});

test('the permission matrix only lists known permissions', () => {
  const known = new Set(['tenant.read', 'tenant.update', 'member.read', 'member.manage', 'audit.read', 'finance.read', 'finance.write']);
  for (const role of Object.keys(TENANT_PERMISSIONS)) {
    for (const permission of TENANT_PERMISSIONS[role]) assert.ok(known.has(permission), `${role} -> ${permission}`);
  }
});

test('isUuid accepts only uuid-shaped strings', () => {
  assert.equal(isUuid(USER.id), true);
  assert.equal(isUuid('abc'), false);
  assert.equal(isUuid(null), false);
});

// ---------------------------------------------------------------------------
// Row -> API mapping
// ---------------------------------------------------------------------------

test('tenantToApi never leaks the personal owner id as an email, and flags personal', () => {
  const api = tenantToApi({
    id: OTHER_TENANT, name: 'Acme', type: 'personal', status: 'suspended',
    personal_owner_user_id: USER.id, settings: { brand: 'x' }, created_at: null, updated_at: null,
  });
  assert.equal(api.isPersonal, true);
  assert.equal(api.status, 'suspended');
  assert.deepEqual(api.settings, { brand: 'x' });
  assert.equal('personal_owner_user_id' in api, false);
});

test('membershipToApi maps role/status and includes an optional user identity', () => {
  const api = membershipToApi({ tenant_id: OTHER_TENANT, user_id: USER.id, member_role: 'TENANT_ADMIN', member_status: 'active', email: 'a@b.co', name: 'A' });
  assert.equal(api.tenantId, OTHER_TENANT);
  assert.equal(api.role, 'TENANT_ADMIN');
  assert.equal(api.status, 'active');
  assert.equal(api.email, 'a@b.co');
});

// ---------------------------------------------------------------------------
// resolveTenantContext
// ---------------------------------------------------------------------------

test('a header tenant is honoured only with an active membership', async () => {
  const db = scriptedDb([
    { match: /FROM tenant_members/, rows: [{ id: OTHER_TENANT, name: 'Acme', type: 'organization', status: 'active', personal_owner_user_id: null, member_role: 'TENANT_ADMIN', member_status: 'active' }] },
  ]);
  const ctx = await resolveTenantContext(db, USER, OTHER_TENANT);
  assert.equal(ctx.tenantId, OTHER_TENANT);
  assert.equal(ctx.role, 'TENANT_ADMIN');
});

test('a manipulated/unknown tenant id is refused with 403 (no probing)', async () => {
  const db = scriptedDb([{ match: /FROM tenant_members/, rows: [] }]);
  await assert.rejects(resolveTenantContext(db, USER, OTHER_TENANT), (e) => statusCode(e) === 403);
});

test('a non-uuid tenant id is a 400, not a database error', async () => {
  const db = scriptedDb([]);
  await assert.rejects(resolveTenantContext(db, USER, 'not-a-uuid'), (e) => statusCode(e) === 400);
  assert.equal(db.calls.length, 0);
});

test('a suspended tenant blocks access for its members', async () => {
  const db = scriptedDb([
    { match: /FROM tenant_members/, rows: [{ id: OTHER_TENANT, name: 'Acme', status: 'suspended', type: 'organization', member_role: 'TENANT_ADMIN', member_status: 'active' }] },
  ]);
  await assert.rejects(resolveTenantContext(db, USER, OTHER_TENANT), (e) => statusCode(e) === 403);
});

test('a suspended membership is refused', async () => {
  const db = scriptedDb([
    { match: /FROM tenant_members/, rows: [{ id: OTHER_TENANT, name: 'Acme', status: 'active', type: 'organization', member_role: 'TENANT_MEMBER', member_status: 'suspended' }] },
  ]);
  await assert.rejects(resolveTenantContext(db, USER, OTHER_TENANT), (e) => statusCode(e) === 403);
});

test('without a header the personal workspace is used (backward compatible)', async () => {
  const personal = { id: OTHER_TENANT, name: 'Owner Personal', type: 'personal', status: 'active', personal_owner_user_id: USER.id };
  const db = scriptedDb([
    { match: /SELECT \* FROM tenants WHERE personal_owner_user_id/, rows: [personal] },
    { match: /SELECT role, status FROM tenant_members/, rows: [{ role: 'TENANT_ADMIN', status: 'active' }] },
  ]);
  const ctx = await resolveTenantContext(db, USER, null);
  assert.equal(ctx.tenantId, OTHER_TENANT);
  assert.equal(ctx.role, 'TENANT_ADMIN');
});

// ---------------------------------------------------------------------------
// Authorization edge cases (explicit negative coverage)
// ---------------------------------------------------------------------------

test('an archived tenant is refused with tenant_archived (not only suspended)', async () => {
  const db = scriptedDb([
    { match: /FROM tenant_members/, rows: [{ id: OTHER_TENANT, name: 'Old Co', status: 'archived', type: 'organization', member_role: 'TENANT_ADMIN', member_status: 'active' }] },
  ]);
  await assert.rejects(
    resolveTenantContext(db, USER, OTHER_TENANT),
    (e) => statusCode(e) === 403 && e.code === 'tenant_archived',
  );
});

test('assertTenantAccessible allows active/legacy status and blocks suspended/archived', () => {
  assert.doesNotThrow(() => assertTenantAccessible({ status: 'active' }));
  // An unexpected/legacy status normalises to 'active', never an accidental lockout.
  assert.doesNotThrow(() => assertTenantAccessible({ status: 'weird' }));
  assert.throws(() => assertTenantAccessible({ status: 'suspended' }), (e) => statusCode(e) === 403 && e.code === 'tenant_suspended');
  assert.throws(() => assertTenantAccessible({ status: 'archived' }), (e) => statusCode(e) === 403 && e.code === 'tenant_archived');
});

test('assertMembershipActive blocks a suspended membership and allows active/null', () => {
  assert.doesNotThrow(() => assertMembershipActive({ member_status: 'active' }));
  assert.doesNotThrow(() => assertMembershipActive({ status: 'active' }));
  assert.doesNotThrow(() => assertMembershipActive(null));
  assert.throws(() => assertMembershipActive({ member_status: 'suspended' }), (e) => statusCode(e) === 403 && e.code === 'membership_suspended');
});

test('a blank or whitespace-only X-Tenant-Id is treated as absent, never a 400', async () => {
  const personal = { id: OTHER_TENANT, name: 'Owner Personal', type: 'personal', status: 'active', personal_owner_user_id: USER.id };
  for (const header of ['', '   ', '\t']) {
    const db = scriptedDb([
      { match: /SELECT \* FROM tenants WHERE personal_owner_user_id/, rows: [personal] },
      { match: /SELECT role, status FROM tenant_members/, rows: [{ role: 'TENANT_ADMIN', status: 'active' }] },
    ]);
    const ctx = await resolveTenantContext(db, USER, header);
    assert.equal(ctx.tenantId, OTHER_TENANT, `header ${JSON.stringify(header)} should resolve the personal workspace`);
    assert.equal(ctx.role, 'TENANT_ADMIN');
  }
});

test('an uppercase uuid X-Tenant-Id is accepted (uuid match is case-insensitive)', async () => {
  const db = scriptedDb([
    { match: /FROM tenant_members/, rows: [{ id: OTHER_TENANT, name: 'Acme', type: 'organization', status: 'active', member_role: 'TENANT_MEMBER', member_status: 'active' }] },
  ]);
  const ctx = await resolveTenantContext(db, USER, OTHER_TENANT.toUpperCase());
  assert.equal(ctx.tenantId, OTHER_TENANT);
  assert.equal(ctx.role, 'TENANT_MEMBER');
});

test('a suspended personal membership is refused even without a header', async () => {
  const personal = { id: OTHER_TENANT, name: 'Owner Personal', type: 'personal', status: 'active', personal_owner_user_id: USER.id };
  const db = scriptedDb([
    { match: /SELECT \* FROM tenants WHERE personal_owner_user_id/, rows: [personal] },
    { match: /SELECT role, status FROM tenant_members/, rows: [{ role: 'TENANT_ADMIN', status: 'suspended' }] },
  ]);
  await assert.rejects(
    resolveTenantContext(db, USER, null),
    (e) => statusCode(e) === 403 && e.code === 'membership_suspended',
  );
});

test('requirePermission denies unknown permissions even for an admin', () => {
  assert.throws(() => requirePermission('TENANT_ADMIN', 'superuser.everything'), (e) => statusCode(e) === 403);
  assert.throws(() => requirePermission('TENANT_MEMBER', 'tenant.update'), (e) => statusCode(e) === 403);
  assert.throws(() => requirePermission('TENANT_MEMBER', 'member.manage'), (e) => statusCode(e) === 403);
  assert.doesNotThrow(() => requirePermission('TENANT_MEMBER', 'finance.read'));
  assert.doesNotThrow(() => requirePermission('TENANT_ADMIN', 'member.manage'));
});

test('an unauthenticated resolveTenantContext is 401 before any query', async () => {
  const db = scriptedDb([]);
  await assert.rejects(resolveTenantContext(db, null, OTHER_TENANT), (e) => statusCode(e) === 401);
  await assert.rejects(resolveTenantContext(db, {}, null), (e) => statusCode(e) === 401);
  assert.equal(db.calls.length, 0, 'no database access may happen without an authenticated user');
});

// ---------------------------------------------------------------------------
// ensurePersonalTenant
// ---------------------------------------------------------------------------

test('ensurePersonalTenant returns an existing personal workspace', async () => {
  const personal = { id: OTHER_TENANT, personal_owner_user_id: USER.id };
  const db = scriptedDb([{ match: /SELECT \* FROM tenants WHERE personal_owner_user_id/, rows: [personal] }]);
  const tenant = await ensurePersonalTenant(db, { userId: USER.id, email: USER.email });
  assert.equal(tenant.id, OTHER_TENANT);
  assert.equal(db.calls.length, 1);
});

test('ensurePersonalTenant creates the workspace and an admin membership atomically', async () => {
  const created = { id: OTHER_TENANT, name: 'Owner Personal', personal_owner_user_id: USER.id };
  const db = scriptedDb([
    { match: /SELECT \* FROM tenants WHERE personal_owner_user_id/, rows: [] },
    { match: /WITH ins AS/, rows: [created] },
  ]);
  const tenant = await ensurePersonalTenant(db, { userId: USER.id, email: USER.email, name: 'Owner' });
  assert.equal(tenant.id, OTHER_TENANT);
  const insert = db.calls.find((c) => /WITH ins AS/.test(c.text));
  assert.match(insert.text, /'TENANT_ADMIN'/);
});

test('listMemberships hides non-active memberships by default', async () => {
  const db = scriptedDb([
    { match: /FROM tenant_members/, rows: [
      { id: 'a', member_status: 'active', member_role: 'TENANT_ADMIN' },
      { id: 'b', member_status: 'suspended', member_role: 'TENANT_MEMBER' },
    ] },
  ]);
  const rows = await listMemberships(db, USER.id);
  assert.deepEqual(rows.map((r) => r.id), ['a']);
  const all = await listMemberships(db, USER.id, { includeInactive: true });
  assert.equal(all.length, 2);
});

// ---------------------------------------------------------------------------
// Tenant-scoped SQL builders
// ---------------------------------------------------------------------------

const TX_ROW = {
  id: 'tx-1', type: 'expense', amount_minor: 100, currency: 'BDT',
  category_id: null, account_id: 'acc-1', to_account_id: null, date: '2024-03-15',
};

test('buildInsert injects tenant_id server-side when a tenant is supplied', () => {
  const stmt = buildInsert('transactions', [TX_ROW], USER.id, OTHER_TENANT);
  assert.match(stmt.text, /tenant_id/);
  const payload = JSON.parse(stmt.params[0]);
  assert.equal(payload[0].tenant_id, OTHER_TENANT);
  assert.equal(payload[0].user_id, USER.id);
});

test('buildInsert omits tenant_id for legacy callers (no tenant context)', () => {
  const stmt = buildInsert('transactions', [TX_ROW], USER.id);
  assert.doesNotMatch(stmt.text, /tenant_id/);
  assert.equal(JSON.parse(stmt.params[0])[0].tenant_id, undefined);
});

test('buildUpsert guards on tenant_id (shared workspace) when supplied', () => {
  const stmt = buildUpsert('transactions', TX_ROW, USER.id, OTHER_TENANT);
  assert.match(stmt.text, /WHERE transactions\.tenant_id = EXCLUDED\.tenant_id/);
  // tenant_id must never be rewritten from the incoming row's values
  assert.doesNotMatch(stmt.text, /tenant_id = EXCLUDED\.tenant_id,/);
});

test('buildUpsert keeps the author guard for legacy callers', () => {
  const stmt = buildUpsert('transactions', TX_ROW, USER.id);
  assert.match(stmt.text, /WHERE transactions\.user_id = EXCLUDED\.user_id/);
});

test('buildUpdate scopes on tenant_id when supplied, else on user_id', () => {
  const scoped = buildUpdate('transactions', { description: 'x' }, 'tx-1', USER.id, OTHER_TENANT);
  assert.match(scoped.text, /AND tenant_id = \$\d+/);
  assert.doesNotMatch(scoped.text, /user_id = \$\d+/);

  const legacy = buildUpdate('transactions', { description: 'x' }, 'tx-1', USER.id);
  assert.match(legacy.text, /AND user_id = \$\d+/);
});

// ---------------------------------------------------------------------------
// Neon Auth email verification gate
// ---------------------------------------------------------------------------

test('ensureNeonUser refuses an unverified email before touching the database', async () => {
  const db = scriptedDb([]);
  await assert.rejects(
    ensureNeonUser(db, { sub: USER.id, email: USER.email, emailVerified: false }),
    (e) => statusCode(e) === 403,
  );
  // Missing claim must also fail closed.
  await assert.rejects(
    ensureNeonUser(db, { sub: USER.id, email: USER.email }),
    (e) => statusCode(e) === 403,
  );
  assert.equal(db.calls.length, 0, 'no lookup/link may happen for an unverified email');
});

test('ensureNeonUser still links a verified email', async () => {
  const db = scriptedDb([
    { match: /FROM users WHERE neon_auth_user_id/, rows: [] },
    { match: /lower\(email\)/, rows: [{ id: USER.id, email: USER.email, name: 'Owner', neon_auth_user_id: null }] },
    { match: /UPDATE users SET neon_auth_user_id/, rows: [{ id: USER.id, email: USER.email, name: 'Owner', neon_auth_user_id: USER.id }] },
  ]);
  const row = await ensureNeonUser(db, { sub: USER.id, email: USER.email, emailVerified: true });
  assert.equal(row.id, USER.id);
  assert.equal(typeof NEON_PASSWORD_SENTINEL, 'string');
});
