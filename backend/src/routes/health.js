// src/routes/health.js
import { json } from '../http.js';

/**
 * GET /api/health
 * Always returns 200. Runs `SELECT 1` and reports db connectivity separately
 * so uptime checks and the frontend can distinguish "API up" from "DB up".
 */
export async function health(ctx) {
  let db = 'error';
  if (ctx.db) {
    try {
      const rows = await ctx.db.query('SELECT 1 AS ok');
      if (Array.isArray(rows)) db = 'ok';
    } catch (e) {
      console.error('[health] database check failed:', (e && e.message) || e);
      db = 'error';
    }
  } else if (ctx.dbError) {
    console.error('[health] database client unavailable:', (ctx.dbError && ctx.dbError.message) || ctx.dbError);
  }

  return json({
    ok: true,
    service: 'spendwise-api',
    db,
    time: new Date().toISOString(),
  });
}
