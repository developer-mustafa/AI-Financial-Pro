// src/routes/crud.js
import { json, parseJson, HttpError } from '../http.js';
import { mapDbError } from '../db.js';
import {
  buildInsert,
  buildUpdate,
  getSpec,
  resolveSort,
  rowToApi,
  validateRecord,
} from '../validate.js';

function translate(e) {
  const mapped = mapDbError(e);
  if (mapped) throw mapped;
  throw e;
}

function parseLimit(value) {
  if (value == null || value === '') return 50;
  const n = Number(value);
  if (!Number.isInteger(n)) throw new HttpError(400, 'invalid_pagination', 'limit must be an integer');
  return Math.min(200, Math.max(1, n));
}

function parseOffset(value) {
  if (value == null || value === '') return 0;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new HttpError(400, 'invalid_pagination', 'offset must be a non-negative integer');
  return n;
}

/**
 * GET /api/<resource>?limit=&offset=&sort=&order=
 * -> { items, total, limit, offset }
 *
 * Scoped to the caller's resolved tenant: a member only ever sees the finance
 * rows of the workspace they are currently acting in.
 */
export async function list(ctx) {
  const resource = ctx.params.resource;
  const spec = getSpec(resource);

  const limit = parseLimit(ctx.url.searchParams.get('limit'));
  const offset = parseOffset(ctx.url.searchParams.get('offset'));
  const { col, dir } = resolveSort(
    resource,
    ctx.url.searchParams.get('sort'),
    ctx.url.searchParams.get('order'),
  );

  // `spec.table`, `col` and `dir` are all hard-coded / allow-listed values.
  const rows = await ctx.db.query(
    `SELECT * FROM ${spec.table} WHERE tenant_id = $1 ORDER BY ${col} ${dir} LIMIT $2 OFFSET $3`,
    [ctx.tenantId, limit, offset],
  );
  const totalRows = await ctx.db.query(
    `SELECT COUNT(*)::int AS total FROM ${spec.table} WHERE tenant_id = $1`,
    [ctx.tenantId],
  );
  const total = totalRows && totalRows[0] ? Number(totalRows[0].total) || 0 : 0;

  return json({ items: rows.map((r) => rowToApi(resource, r)), total, limit, offset });
}

/** GET /api/<resource>/:id -> record or 404 (tenant-scoped) */
export async function getOne(ctx) {
  const resource = ctx.params.resource;
  const spec = getSpec(resource);
  const rows = await ctx.db.query(
    `SELECT * FROM ${spec.table} WHERE id = $1 AND tenant_id = $2`,
    [ctx.params.id, ctx.tenantId],
  );
  if (!rows || rows.length === 0) throw new HttpError(404, 'not_found', 'Record not found');
  return json(rowToApi(resource, rows[0]));
}

/** POST /api/<resource> -> 201 record (client supplies id; duplicate -> 409) */
export async function create(ctx) {
  const resource = ctx.params.resource;
  const body = await parseJson(ctx.request);
  const row = validateRecord(resource, body, { mode: 'full' });
  // author = authenticated user, owner = resolved tenant; both server-derived.
  const statement = buildInsert(resource, [row], ctx.userId, ctx.tenantId);
  try {
    const rows = await ctx.db.query(statement.text, statement.params);
    return json(rowToApi(resource, rows[0]), 201);
  } catch (e) {
    translate(e);
  }
}

/** PATCH /api/<resource>/:id -> 200 updated record or 404 (tenant-scoped) */
export async function update(ctx) {
  const resource = ctx.params.resource;
  const body = await parseJson(ctx.request);
  const row = validateRecord(resource, body, { mode: 'patch' });
  const statement = buildUpdate(resource, row, ctx.params.id, ctx.userId, ctx.tenantId);
  if (!statement) throw new HttpError(400, 'validation_error', 'No valid fields to update');
  try {
    const rows = await ctx.db.query(statement.text, statement.params);
    if (!rows || rows.length === 0) throw new HttpError(404, 'not_found', 'Record not found');
    return json(rowToApi(resource, rows[0]));
  } catch (e) {
    translate(e);
  }
}

/** DELETE /api/<resource>/:id -> 204 or 404 (tenant-scoped) */
export async function remove(ctx) {
  const resource = ctx.params.resource;
  const spec = getSpec(resource);
  const rows = await ctx.db.query(
    `DELETE FROM ${spec.table} WHERE id = $1 AND tenant_id = $2 RETURNING id`,
    [ctx.params.id, ctx.tenantId],
  );
  if (!rows || rows.length === 0) throw new HttpError(404, 'not_found', 'Record not found');
  return new Response(null, { status: 204 });
}
