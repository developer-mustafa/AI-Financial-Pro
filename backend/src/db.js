// src/db.js
// All database access goes through here. This is the ONLY module that imports
// @neondatabase/serverless at module top level.

import { neon } from '@neondatabase/serverless';
import { HttpError } from './http.js';

/** Cache one neon() client per env object (Workers reuse the env binding). */
const clientCache = new WeakMap();

/**
 * Return a configured Neon HTTP client for this environment.
 * Throws a clear, non-secret error when DATABASE_URL is missing.
 * @param {Record<string, unknown>} env
 */
export function getSql(env) {
  const url = env && env.DATABASE_URL;
  if (typeof url !== 'string' || url.trim() === '') {
    throw new Error('Database is not configured: missing DATABASE_URL secret');
  }
  const existing = clientCache.get(env);
  if (existing) return existing;

  const sql = neon(url, { arrayMode: false, fullResults: false });
  clientCache.set(env, sql);
  return sql;
}

/**
 * Build a small DB façade bound to an env. Every route uses this.
 */
export function createDb(env) {
  const sql = getSql(env);

  const db = {
    sql,

    /**
     * Run one parameterized query. `params` values are always bound, never
     * interpolated into the SQL text.
     * @param {string} text
     * @param {unknown[]} [params]
     */
    query(text, params = []) {
      return sql(text, params);
    },

    /**
     * Execute a list of `{ text, params }` statements atomically.
     * Uses the driver's transaction API so all statements commit together.
     * @param {Array<{text:string, params?:unknown[]}>} statements
     */
    async batch(statements) {
      const list = (statements || []).filter(Boolean);
      if (list.length === 0) return [];
      if (list.length === 1) {
        // A single statement is already atomic.
        return [await sql(list[0].text, list[0].params || [])];
      }
      return sql.transaction(list.map((s) => sql(s.text, s.params || [])));
    },

    /**
     * Transactional helper.
     *
     * Because the Neon HTTP driver sends each statement as its own HTTP
     * request, a real multi-statement transaction is expressed by collecting
     * all statements first and sending them as one batch. `fn` receives a
     * collector `q(text, params)` and must NOT depend on the results of
     * earlier statements (it only builds the statement list). It may return an
     * array of additional `{ text, params }` statements.
     *
     * All our write flows (state replace, sync upsert) know their full
     * statement list up front, so this matches how the driver works.
     *
     * @param {(q:(text:string, params?:unknown[])=>void)=>void|Array<{text:string,params?:unknown[]}>} fn
     */
    async tx(fn) {
      const statements = [];
      const q = (text, params = []) => {
        statements.push({ text, params });
      };
      const maybe = fn(q);
      if (Array.isArray(maybe)) statements.push(...maybe);
      return db.batch(statements);
    },
  };

  return db;
}

// ---------------------------------------------------------------------------
// Value coercion helpers (Neon returns bigints as strings, etc.)
// ---------------------------------------------------------------------------

/** bigint/numeric/string -> finite Number, null-safe. */
export function num(v) {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Nullable numeric: preserves null. */
export function numOrNull(v) {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Coerce Postgres boolean-ish values to a real boolean. */
export function bool(v) {
  if (v === true || v === false) return v;
  if (v === null || v === undefined) return false;
  if (typeof v === 'string') return v === 't' || v === 'true' || v === '1';
  if (typeof v === 'number') return v !== 0;
  return Boolean(v);
}

/** Parse jsonb that may arrive as a string or an already-parsed value. */
export function json(v, fallback) {
  if (v === null || v === undefined) return fallback;
  if (typeof v === 'string') {
    try {
      return JSON.parse(v);
    } catch {
      return fallback;
    }
  }
  return v;
}

/** Normalize a date/timestamp column value to 'YYYY-MM-DD' (or null). */
export function dateStr(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    return v.toISOString().slice(0, 10);
  }
  const s = String(v);
  return s.length >= 10 ? s.slice(0, 10) : s;
}

/** Normalize a timestamp column value to an ISO string (or null). */
export function timestampStr(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  const s = String(v);
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toISOString();
}

/** Ensure an array value (text[] / int[]) is a real array. */
export function arr(v) {
  if (Array.isArray(v)) return v;
  if (v === null || v === undefined) return [];
  if (typeof v === 'string') {
    // Postgres array literal fallback: {a,b}
    const s = v.trim();
    if (s.startsWith('{') && s.endsWith('}')) {
      const inner = s.slice(1, -1);
      if (inner.trim() === '') return [];
      return inner.split(',').map((x) => x.replace(/^"|"$/g, ''));
    }
    return [v];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Postgres error mapping (never leak raw DB details to clients)
// ---------------------------------------------------------------------------

/**
 * Convert known Postgres error codes into safe HttpErrors. Returns null for
 * unknown errors so the caller can re-throw and the top-level handler can log
 * the real cause without exposing it.
 *
 * @param {any} e
 * @returns {HttpError|null}
 */
export function mapDbError(e) {
  switch (e && e.code) {
    case '23505': // unique_violation
      return new HttpError(409, 'conflict', 'A record with this identifier already exists');
    case '23503': // foreign_key_violation
      return new HttpError(400, 'bad_reference', 'A referenced record does not exist');
    case '23514': // check_violation
      return new HttpError(400, 'validation_error', 'A value violates a database constraint');
    case '22P02': // invalid_text_representation
    case '22007': // invalid_datetime_format
    case '22008': // datetime_field_overflow
    case '22003': // numeric_value_out_of_range
      return new HttpError(400, 'validation_error', 'A value has an invalid format');
    default:
      return null;
  }
}
