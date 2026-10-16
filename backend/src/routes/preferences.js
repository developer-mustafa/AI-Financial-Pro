// src/routes/preferences.js
import { json, parseJson, HttpError } from '../http.js';
import { mapDbError } from '../db.js';
import { validatePreferences } from '../validate.js';

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

function toIso(v) {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString();
}

/** GET /api/preferences -> { preferences, updatedAt } */
export async function getPreferences(ctx) {
  const rows = await ctx.db.query('SELECT data, updated_at FROM preferences WHERE user_id = $1', [ctx.userId]);
  const row = rows && rows[0];
  return json({
    preferences: row ? parseJsonb(row.data, {}) : {},
    updatedAt: row ? toIso(row.updated_at) : null,
  });
}

/** PUT /api/preferences  { preferences } (or a raw object) -> { preferences } */
export async function putPreferences(ctx) {
  const body = await parseJson(ctx.request);
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'validation_error', 'Request body must be a JSON object');
  }
  const data = body.preferences !== undefined ? body.preferences : body;
  const prefs = validatePreferences(data);

  try {
    await ctx.db.query(
      `INSERT INTO preferences (user_id, data, updated_at) VALUES ($1, $2::jsonb, now())
       ON CONFLICT (user_id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
      [ctx.userId, JSON.stringify(prefs)],
    );
  } catch (e) {
    translate(e);
  }

  return json({ preferences: prefs });
}
