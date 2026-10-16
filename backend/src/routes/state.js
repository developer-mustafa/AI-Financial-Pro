// src/routes/state.js
import { json, parseJson, HttpError } from '../http.js';
import { mapDbError } from '../db.js';
import { buildInsert, rowToApi, validateState } from '../validate.js';

function translate(e) {
  const mapped = mapDbError(e);
  if (mapped) throw mapped;
  throw e;
}

function parseJsonb(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  }
  return value;
}

const INSERT_ORDER = ['accounts', 'categories', 'transactions', 'budgets', 'recurring_rules', 'goals'];

/**
 * GET /api/state
 * -> { schemaVersion, transactions, categories, accounts, budgets,
 *      recurringRules, goals, preferences, metadata{createdAt,updatedAt} }
 */
export async function getState(ctx) {
  const { db, userId, user, tenantId } = ctx;

  const [transactions, categories, accounts, budgets, recurringRules, goals, prefs, meta] = await Promise.all([
    db.query('SELECT * FROM transactions WHERE tenant_id = $1 ORDER BY date DESC, created_at DESC', [tenantId]),
    db.query('SELECT * FROM categories WHERE tenant_id = $1 ORDER BY created_at ASC', [tenantId]),
    db.query('SELECT * FROM accounts WHERE tenant_id = $1 ORDER BY created_at ASC', [tenantId]),
    db.query('SELECT * FROM budgets WHERE tenant_id = $1 ORDER BY created_at ASC', [tenantId]),
    db.query('SELECT * FROM recurring_rules WHERE tenant_id = $1 ORDER BY created_at ASC', [tenantId]),
    db.query('SELECT * FROM goals WHERE tenant_id = $1 ORDER BY created_at ASC', [tenantId]),
    db.query('SELECT data, updated_at FROM preferences WHERE user_id = $1', [userId]),
    db.query('SELECT schema_version, created_at, updated_at FROM app_metadata WHERE user_id = $1', [userId]),
  ]);

  const metaRow = meta && meta[0];
  const prefRow = prefs && prefs[0];

  return json({
    schemaVersion: metaRow ? Number(metaRow.schema_version) || 1 : 1,
    transactions: transactions.map((r) => rowToApi('transactions', r)),
    categories: categories.map((r) => rowToApi('categories', r)),
    accounts: accounts.map((r) => rowToApi('accounts', r)),
    budgets: budgets.map((r) => rowToApi('budgets', r)),
    recurringRules: recurringRules.map((r) => rowToApi('recurring-rules', r)),
    goals: goals.map((r) => rowToApi('goals', r)),
    preferences: prefRow ? parseJsonb(prefRow.data, {}) : {},
    metadata: {
      createdAt: metaRow ? toIso(metaRow.created_at) : user.createdAt || null,
      updatedAt: metaRow ? toIso(metaRow.updated_at) : user.updatedAt || null,
    },
  });
}

/**
 * PUT /api/state  { state }
 * Validates the whole payload, then in ONE transaction replaces the current
 * tenant's rows for every entity and upserts the caller's preferences +
 * app_metadata. Finance statements are scoped by `tenant_id` (never another
 * workspace); preferences/app_metadata stay per-user. `tenant_id` is injected
 * server-side by buildInsert.
 */
export async function putState(ctx) {
  const body = await parseJson(ctx.request);
  const payload = body && body.state !== undefined ? body.state : body;
  if (payload === undefined || payload === null) {
    throw new HttpError(400, 'validation_error', 'state is required');
  }

  const result = validateState(payload);
  const userId = ctx.userId;
  const tenantId = ctx.tenantId;

  // Resolve category parent references: drop parents not present in the payload
  // (and self-references) so the self-FK can never fail.
  const categoryIds = new Set(result.rows.categories.map((r) => r.id));
  const parentPairs = [];
  const categoriesForInsert = result.rows.categories.map((r) => {
    let parentId = r.parent_id;
    if (parentId && (!categoryIds.has(parentId) || parentId === r.id)) parentId = null;
    if (parentId) parentPairs.push({ id: r.id, parent_id: parentId });
    return { ...r, parent_id: null };
  });

  const statements = [];

  // Replace all rows of this tenant. Children/deletes ordered safely.
  for (const table of ['transactions', 'budgets', 'recurring_rules', 'goals', 'accounts', 'categories']) {
    statements.push({ text: `DELETE FROM ${table} WHERE tenant_id = $1`, params: [tenantId] });
  }

  for (const resource of INSERT_ORDER) {
    const rows = resource === 'categories' ? categoriesForInsert : result.rows[resource];
    if (rows.length > 0) statements.push(buildInsert(resource, rows, userId, tenantId));
  }

  if (parentPairs.length > 0) {
    statements.push({
      text:
        `UPDATE categories c SET parent_id = v.pid, updated_at = now() ` +
        `FROM (SELECT val->>'id' AS id, val->>'parent_id' AS pid ` +
        `FROM jsonb_array_elements($1::jsonb) AS t(val) WHERE val->>'parent_id' IS NOT NULL) v ` +
        `WHERE c.id = v.id AND c.tenant_id = $2`,
      params: [JSON.stringify(parentPairs), tenantId],
    });
  }

  statements.push({
    text:
      `INSERT INTO preferences (user_id, data, updated_at) VALUES ($1, $2::jsonb, now()) ` +
      `ON CONFLICT (user_id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
    params: [userId, JSON.stringify(result.preferences)],
  });

  statements.push({
    text:
      `INSERT INTO app_metadata (user_id, schema_version, created_at, updated_at) VALUES ($1, $2, now(), now()) ` +
      `ON CONFLICT (user_id) DO UPDATE SET schema_version = EXCLUDED.schema_version, updated_at = now()`,
    params: [userId, result.schemaVersion],
  });

  try {
    await ctx.db.batch(statements);
  } catch (e) {
    translate(e);
  }

  return json({ ok: true, counts: result.counts });
}

function toIso(v) {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString();
}
