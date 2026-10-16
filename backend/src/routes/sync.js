// src/routes/sync.js
import { json, parseJson, HttpError } from '../http.js';
import { mapDbError } from '../db.js';
import { buildUpsert, getSpec, isResource, validateRecord } from '../validate.js';

const MAX_CHANGES = 500;

function toErrorInfo(e) {
  if (e instanceof HttpError) return { code: e.code, message: e.message };
  const mapped = mapDbError(e);
  if (mapped) return { code: mapped.code, message: mapped.message };
  console.error('[sync] unexpected change failure:', (e && e.stack) || e);
  return { code: 'internal_error', message: 'Change could not be applied' };
}

async function applyChange(ctx, change) {
  if (!change || typeof change !== 'object' || Array.isArray(change)) {
    throw new HttpError(400, 'validation_error', 'Each change must be an object');
  }
  const { resource, op } = change;
  if (!isResource(resource)) throw new HttpError(400, 'validation_error', 'Unknown resource');

  if (op === 'upsert') {
    const row = validateRecord(resource, change.record, { mode: 'full' });
    const statement = buildUpsert(resource, row, ctx.userId, ctx.tenantId);
    let rows;
    try {
      rows = await ctx.db.query(statement.text, statement.params);
    } catch (e) {
      const mapped = mapDbError(e);
      if (mapped) throw mapped;
      throw e;
    }
    // The ON CONFLICT guard only updates rows that belong to the resolved
    // tenant; an empty result means the id belongs to another workspace.
    // Report it without leaking which.
    if (!rows || rows.length === 0) {
      throw new HttpError(409, 'conflict', 'Identifier is already in use');
    }
    return;
  }

  if (op === 'delete') {
    const id = change.id;
    if (typeof id !== 'string' || id.trim() === '') {
      throw new HttpError(400, 'validation_error', 'id is required for a delete change');
    }
    const spec = getSpec(resource);
    // Always scoped to the resolved tenant; deleting another workspace's id
    // affects 0 rows.
    await ctx.db.query(`DELETE FROM ${spec.table} WHERE id = $1 AND tenant_id = $2`, [id, ctx.tenantId]);
    return;
  }

  throw new HttpError(400, 'validation_error', "op must be 'upsert' or 'delete'");
}

/**
 * POST /api/sync  { changes: [{ resource, op, record|id }] }
 * -> 200 { applied, failed: [{ index, error }] }
 * Each change is applied in its own transaction (single atomic statement); a
 * failure is isolated and reported by index without aborting the batch.
 */
export async function sync(ctx) {
  const body = await parseJson(ctx.request);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'validation_error', 'Request body must be a JSON object');
  }
  const changes = body.changes;
  if (!Array.isArray(changes)) throw new HttpError(400, 'validation_error', 'changes must be an array');
  if (changes.length > MAX_CHANGES) {
    throw new HttpError(413, 'too_many_changes', `At most ${MAX_CHANGES} changes per request`);
  }

  let applied = 0;
  const failed = [];
  for (let i = 0; i < changes.length; i += 1) {
    try {
      await applyChange(ctx, changes[i]);
      applied += 1;
    } catch (e) {
      failed.push({ index: i, error: toErrorInfo(e) });
    }
  }

  return json({ applied, failed });
}
