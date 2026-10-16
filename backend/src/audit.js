// src/audit.js
// Append-only audit trail for privileged (platform / tenant admin) actions.
//
// Rules:
//   * NEVER record credentials, tokens or full financial records. `detail`
//     carries only small, intentional metadata (e.g. the new status, a role).
//   * Auditing is BEST-EFFORT: a failure to write an audit row must never turn
//     a successful administrative action into a 500, nor leak DB internals.
//   * The actor is always derived server-side from the authenticated request.

const MAX_DETAIL_BYTES = 4000;

/**
 * Keep `detail` small, flat-ish and JSON-serializable. Anything too large is
 * replaced with a truncation marker rather than stored.
 */
function sanitizeDetail(detail) {
  if (detail === undefined || detail === null) return {};
  if (typeof detail !== 'object' || Array.isArray(detail)) return { value: String(detail).slice(0, 500) };
  let serialized;
  try {
    serialized = JSON.stringify(detail);
  } catch {
    return { note: 'unserializable detail omitted' };
  }
  if (serialized.length > MAX_DETAIL_BYTES) {
    return { note: 'detail truncated', keys: Object.keys(detail).slice(0, 20) };
  }
  return detail;
}

function clientIpOf(request) {
  if (!request || !request.headers) return null;
  const cf = request.headers.get('CF-Connecting-IP');
  if (cf) return cf.trim().slice(0, 60);
  const fwd = request.headers.get('X-Forwarded-For');
  if (fwd) return fwd.split(',')[0].trim().slice(0, 60);
  return null;
}

/**
 * Record one administrative action. Resolves to `true` when written, `false`
 * when the audit write failed (the caller's action still succeeds).
 *
 * @param {{query: Function}} db
 * @param {{
 *   actorUserId?: string|null,
 *   actorEmail?: string|null,
 *   action: string,
 *   targetType?: string,
 *   targetId?: string|null,
 *   tenantId?: string|null,
 *   outcome?: 'success'|'failure'|'denied',
 *   detail?: object,
 *   request?: Request|null,
 * }} entry
 * @returns {Promise<boolean>}
 */
export async function writeAudit(db, entry = {}) {
  const action = String(entry.action || '').trim().slice(0, 120);
  if (!action) return false;

  const params = [
    entry.actorUserId || null,
    String(entry.actorEmail || '').slice(0, 254),
    action,
    String(entry.targetType || '').slice(0, 60),
    entry.targetId != null ? String(entry.targetId).slice(0, 200) : null,
    entry.tenantId || null,
    ['success', 'failure', 'denied'].includes(entry.outcome) ? entry.outcome : 'success',
    JSON.stringify(sanitizeDetail(entry.detail)),
    clientIpOf(entry.request),
    entry.requestId ? String(entry.requestId).slice(0, 120) : null,
  ];

  try {
    await db.query(
      `INSERT INTO audit_logs
         (actor_user_id, actor_email, action, target_type, target_id, tenant_id, outcome, detail, ip, request_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)`,
      params,
    );
    return true;
  } catch (e) {
    // Never surface an audit failure to the caller; log server-side and move on.
    console.error('[audit] failed to record action:', action, (e && e.message) || e);
    return false;
  }
}

/** Convenience: build an actor descriptor from a resolved ctx. */
export function actorFromContext(ctx) {
  return {
    actorUserId: ctx?.userId || null,
    actorEmail: ctx?.user?.email || null,
    request: ctx?.request || null,
  };
}
