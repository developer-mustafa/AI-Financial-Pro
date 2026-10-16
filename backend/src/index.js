// src/index.js
// SpendWise API — Cloudflare Worker entry point (ES module format).
// Responsibilities: CORS, security headers, preflight, body-size cap, per-IP
// rate limiting, routing, tenant-scoped handlers, and a single top-level error
// boundary that logs real errors server-side but returns safe JSON envelopes.

import {
  HttpError,
  corsHeaders,
  error,
  json,
  pruneRateStore,
  rateLimit,
  rateLimitHeaders,
  resolveRequestId,
  securityHeaders,
  withHeaders,
} from './http.js';
import { createDb } from './db.js';
import { requireAuth } from './auth.js';
import { resolveTenantContext } from './tenant.js';
import { isResource } from './validate.js';

import * as healthRoutes from './routes/health.js';
import * as authRoutes from './routes/auth.js';
import * as stateRoutes from './routes/state.js';
import * as crudRoutes from './routes/crud.js';
import * as prefsRoutes from './routes/preferences.js';
import * as syncRoutes from './routes/sync.js';
import * as adminRoutes from './routes/admin.js';
import * as tenantRoutes from './routes/tenant.js';
import * as platformRoutes from './routes/platform.js';
import * as aiRoutes from './routes/ai.js';

const MAX_BODY_BYTES = 1024 * 1024; // 1 MiB
const RATE_LIMIT = 120; // requests
const RATE_WINDOW_MS = 60_000; // per minute
const RATE_STORE_MAX = 5000;

// In-memory rate-limit store. Best-effort only (Workers isolates are ephemeral
// and per-colo); it exists to blunt obvious abuse, not as a hard guarantee.
const rateStore = new Map();

// Path segments under /api that must never exist (no raw-SQL surface).
const FORBIDDEN_SEGMENTS = new Set(['sql', 'raw', 'exec', 'execute', 'query', 'unsafe', 'rpc']);

export default {
  /**
   * @param {Request} request
   * @param {Record<string, unknown>} env
   * @param {{waitUntil?: (p: Promise<any>) => void}} ctx
   */
  async fetch(request, env, ctx) {
    const startedAt = Date.now();
    const requestId = resolveRequestId(request);
    // Per-request telemetry the route handlers may enrich (rate limit, user).
    const trace = { requestId, rateLimit: null, userId: null };

    let response;
    try {
      response = await handle(request, env, trace);
    } catch (e) {
      response = handleError(e);
    }

    const base = {
      ...corsHeaders(request, env),
      ...securityHeaders(),
      'X-Request-Id': requestId,
      ...rateLimitHeaders(trace.rateLimit),
    };
    const final = withHeaders(response, base);
    logRequest(request, final, trace, Date.now() - startedAt);
    return final;
  },
};

/**
 * Emit one structured access-log line per request (Workers Logs captures
 * console output). Keeps field names stable so log queries stay useful.
 */
function logRequest(request, response, trace, durationMs) {
  let path = '/';
  try {
    path = new URL(request.url).pathname;
  } catch {
    /* keep the default */
  }
  const line = {
    t: new Date().toISOString(),
    level: response.status >= 500 ? 'error' : 'info',
    msg: 'request',
    requestId: trace.requestId,
    method: request.method,
    path,
    status: response.status,
    durationMs,
  };
  if (trace.userId) line.userId = trace.userId;
  if (trace.rateLimit) line.rateRemaining = trace.rateLimit.remaining;
  const ray = request.headers.get('CF-Ray');
  if (ray) line.ray = ray;
  console.log(JSON.stringify(line));
}

async function handle(request, env, trace = {}) {
  const method = request.method.toUpperCase();
  const url = new URL(request.url);
  const segments = url.pathname.split('/').filter(Boolean);

  // CORS preflight.
  if (method === 'OPTIONS') return new Response(null, { status: 204 });

  // Friendly banner for the bare host root. An API base URL is only a prefix,
  // so opening it in a browser would otherwise show a confusing 404. This is
  // purely informational: every real endpoint still lives under /api.
  if (segments.length === 0) {
    if (method === 'GET' || method === 'HEAD') {
      return json({
        ok: true,
        service: 'spendwise-api',
        message: 'SpendWise API is running. Endpoints live under /api.',
        health: '/api/health',
      });
    }
    return error('not_found', 'Not found', 404);
  }

  // Everything lives under /api. Anything else is 404.
  if (segments[0] !== 'api') return error('not_found', 'Not found', 404);

  // Explicitly refuse any raw-SQL execution surface.
  const second = (segments[1] || '').toLowerCase();
  if (FORBIDDEN_SEGMENTS.has(second)) {
    return error('forbidden', 'Raw SQL execution is not supported', 403);
  }

  // Best-effort per-IP + method rate limit.
  const key = `${clientIp(request)}:${method}`;
  const rl = rateLimit(rateStore, key, { limit: RATE_LIMIT, windowMs: RATE_WINDOW_MS });
  trace.rateLimit = rl;
  if (rateStore.size > RATE_STORE_MAX) pruneRateStore(rateStore, { windowMs: RATE_WINDOW_MS });
  if (!rl.ok) {
    return json(
      { error: { code: 'rate_limited', message: 'Too many requests' } },
      429,
      { 'Retry-After': String(rl.retryAfter || 1) },
    );
  }

  // Early body-size rejection (parseJson enforces the real cap as well).
  const declaredLength = request.headers.get('content-length');
  if (declaredLength != null && Number(declaredLength) > MAX_BODY_BYTES) {
    return error('payload_too_large', 'Request body is too large', 413);
  }

  // Resolve the route first so we can special-case health.
  const route = matchRoute(method, segments);
  if (!route) return error('not_found', 'Not found', 404);

  // Build the DB client (may fail if DATABASE_URL is missing).
  let db = null;
  let dbError = null;
  try {
    db = createDb(env);
  } catch (e) {
    dbError = e;
    console.error('[api] database client unavailable:', (e && e.message) || e);
  }

  const ctx = {
    request,
    env,
    db,
    dbError,
    url,
    params: route.params,
    user: null,
    userId: null,
    requestId: trace.requestId,
  };

  if (route.name === 'health') return healthRoutes.health(ctx);

  if (!db) return error('server_misconfigured', 'Database is not configured', 500);

  const needsAuth = route.name !== 'auth.register' && route.name !== 'auth.login';
  if (needsAuth) {
    const auth = await requireAuth(request, env);
    ctx.userId = auth.userId;
    ctx.user = auth.user;
    trace.userId = auth.userId;
    // Super-admin surface: require the admin role on top of authentication.
    if (route.admin && (!ctx.user || ctx.user.role !== 'admin')) {
      return error('forbidden', 'Administrator access required', 403);
    }
    // Tenant-scoped surface: resolve the tenant the caller may act within.
    // The `X-Tenant-Id` header is a selector only; membership is verified here
    // and never trusted from the client. Absent header -> personal workspace.
    if (route.tenant) {
      const resolved = await resolveTenantContext(db, ctx.user, request.headers.get('X-Tenant-Id'));
      ctx.tenant = resolved.tenant;
      ctx.tenantId = resolved.tenantId;
      ctx.role = resolved.role;
      ctx.membership = resolved.membership;
    }
  }

  switch (route.name) {
    case 'auth.register':
      return authRoutes.register(ctx);
    case 'auth.login':
      return authRoutes.login(ctx);
    case 'auth.logout':
      return authRoutes.logout(ctx);
    case 'auth.me':
      return authRoutes.me(ctx);
    case 'state.get':
      return stateRoutes.getState(ctx);
    case 'state.put':
      return stateRoutes.putState(ctx);
    case 'prefs.get':
      return prefsRoutes.getPreferences(ctx);
    case 'prefs.put':
      return prefsRoutes.putPreferences(ctx);
    case 'sync':
      return syncRoutes.sync(ctx);
    case 'crud.list':
      return crudRoutes.list(ctx);
    case 'crud.get':
      return crudRoutes.getOne(ctx);
    case 'crud.create':
      return crudRoutes.create(ctx);
    case 'crud.update':
      return crudRoutes.update(ctx);
    case 'crud.remove':
      return crudRoutes.remove(ctx);
    case 'admin.users.list':
      return adminRoutes.listUsers(ctx);
    case 'admin.users.create':
      return adminRoutes.createUser(ctx);
    case 'admin.users.get':
      return adminRoutes.getUser(ctx);
    case 'admin.users.update':
      return adminRoutes.updateUser(ctx);
    case 'admin.users.remove':
      return adminRoutes.deleteUser(ctx);
    case 'tenants.list':
      return tenantRoutes.listMyTenants(ctx);
    case 'tenants.current':
      return tenantRoutes.getCurrentTenant(ctx);
    case 'tenants.current.update':
      return tenantRoutes.updateCurrentTenant(ctx);
    case 'tenants.members.list':
      return tenantRoutes.listMembers(ctx);
    case 'tenants.members.add':
      return tenantRoutes.addMember(ctx);
    case 'tenants.members.update':
      return tenantRoutes.updateMember(ctx);
    case 'tenants.members.remove':
      return tenantRoutes.removeMember(ctx);
    case 'tenants.audit':
      return tenantRoutes.listTenantAudit(ctx);
    case 'platform.overview':
      return platformRoutes.overview(ctx);
    case 'platform.tenants.list':
      return platformRoutes.listTenants(ctx);
    case 'platform.tenants.create':
      return platformRoutes.createTenant(ctx);
    case 'platform.tenants.get':
      return platformRoutes.getTenant(ctx);
    case 'platform.tenants.update':
      return platformRoutes.updateTenant(ctx);
    case 'platform.tenants.archive':
      return platformRoutes.archiveTenant(ctx);
    case 'platform.tenants.members.add':
      return platformRoutes.addTenantMember(ctx);
    case 'platform.tenants.members.update':
      return platformRoutes.updateTenantMember(ctx);
    case 'platform.tenants.members.remove':
      return platformRoutes.removeTenantMember(ctx);
    case 'platform.users.list':
      return platformRoutes.listUsers(ctx);
    case 'platform.users.create':
      return platformRoutes.createUser(ctx);
    case 'platform.users.memberships':
      return platformRoutes.listUserTenants(ctx);
    case 'platform.audit':
      return platformRoutes.listAudit(ctx);
    case 'ai.advisor':
      return aiRoutes.advisor(ctx);
    case 'ai.insights':
      return aiRoutes.insights(ctx);
    default:
      return error('not_found', 'Not found', 404);
  }
}

/**
 * Routing table. Returns { name, params } or null. Pure and side-effect free.
 */
function matchRoute(method, segments) {
  const p = segments.slice(1); // drop 'api'
  if (p.length === 0) return null;
  const a = p[0];
  const b = p[1];
  const rest = p.length - 2;

  if (a === 'health' && b === undefined && method === 'GET') return { name: 'health', params: {} };

  if (a === 'auth' && rest <= 0) {
    if (b === 'register' && method === 'POST') return { name: 'auth.register', params: {} };
    if (b === 'login' && method === 'POST') return { name: 'auth.login', params: {} };
    if (b === 'logout' && method === 'POST') return { name: 'auth.logout', params: {} };
    if (b === 'me' && method === 'GET') return { name: 'auth.me', params: {} };
    return null;
  }

  if (a === 'state' && b === undefined) {
    if (method === 'GET') return { name: 'state.get', params: {}, tenant: true };
    if (method === 'PUT') return { name: 'state.put', params: {}, tenant: true };
    return null;
  }

  if (a === 'preferences' && b === undefined) {
    if (method === 'GET') return { name: 'prefs.get', params: {} };
    if (method === 'PUT') return { name: 'prefs.put', params: {} };
    return null;
  }

  if (a === 'sync' && b === undefined && method === 'POST') return { name: 'sync', params: {}, tenant: true };

  // AI features. Read-only over the caller's own workspace; `tenant: true`
  // makes the router resolve+verify the workspace before the handler runs, and
  // each handler additionally requires explicit consent and enforces a quota.
  if (a === 'ai' && rest <= 0) {
    if (b === 'advisor' && method === 'POST') return { name: 'ai.advisor', params: {}, tenant: true };
    if (b === 'insights' && method === 'POST') return { name: 'ai.insights', params: {}, tenant: true };
    return null;
  }

  // Tenant self-management. Every route here resolves the caller's tenant
  // context; per-action permissions are enforced inside the handlers.
  if (a === 'tenants') {
    if (b === undefined && method === 'GET') return { name: 'tenants.list', params: {} };
    if (b === 'current') {
      if (p.length === 2) {
        if (method === 'GET') return { name: 'tenants.current', params: {}, tenant: true };
        if (method === 'PATCH' || method === 'PUT') return { name: 'tenants.current.update', params: {}, tenant: true };
        return null;
      }
      if (p.length === 3 && p[2] === 'members') {
        if (method === 'GET') return { name: 'tenants.members.list', params: {}, tenant: true };
        if (method === 'POST') return { name: 'tenants.members.add', params: {}, tenant: true };
        return null;
      }
      if (p.length === 3 && p[2] === 'audit') {
        if (method === 'GET') return { name: 'tenants.audit', params: {}, tenant: true };
        return null;
      }
      if (p.length === 4 && p[2] === 'members' && p[3]) {
        let userId;
        try {
          userId = decodeURIComponent(p[3]);
        } catch {
          return null;
        }
        if (!userId) return null;
        if (method === 'PATCH' || method === 'PUT') return { name: 'tenants.members.update', params: { userId }, tenant: true };
        if (method === 'DELETE') return { name: 'tenants.members.remove', params: { userId }, tenant: true };
        return null;
      }
    }
    return null;
  }

  // Platform administration (PLATFORM_ADMIN only; `admin: true`).
  if (a === 'platform') {
    if (b === 'overview' && p.length === 2 && method === 'GET') return { name: 'platform.overview', params: {}, admin: true };

    if (b === 'audit' && p.length === 2 && method === 'GET') return { name: 'platform.audit', params: {}, admin: true };

    if (b === 'users') {
      if (p.length === 2) {
        if (method === 'GET') return { name: 'platform.users.list', params: {}, admin: true };
        if (method === 'POST') return { name: 'platform.users.create', params: {}, admin: true };
        return null;
      }
      if (p.length === 4 && p[2] && p[3] === 'memberships' && method === 'GET') {
        let id;
        try {
          id = decodeURIComponent(p[2]);
        } catch {
          return null;
        }
        if (!id) return null;
        return { name: 'platform.users.memberships', params: { id }, admin: true };
      }
      return null;
    }

    if (b === 'tenants') {
      if (p.length === 2) {
        if (method === 'GET') return { name: 'platform.tenants.list', params: {}, admin: true };
        if (method === 'POST') return { name: 'platform.tenants.create', params: {}, admin: true };
        return null;
      }
      if (p.length === 3 && p[2]) {
        let id;
        try {
          id = decodeURIComponent(p[2]);
        } catch {
          return null;
        }
        if (!id) return null;
        if (method === 'GET') return { name: 'platform.tenants.get', params: { id }, admin: true };
        if (method === 'PATCH' || method === 'PUT') return { name: 'platform.tenants.update', params: { id }, admin: true };
        if (method === 'DELETE') return { name: 'platform.tenants.archive', params: { id }, admin: true };
        return null;
      }
      if (p.length === 4 && p[2] && p[3] === 'members') {
        let id;
        try {
          id = decodeURIComponent(p[2]);
        } catch {
          return null;
        }
        if (!id) return null;
        if (method === 'POST') return { name: 'platform.tenants.members.add', params: { id }, admin: true };
        return null;
      }
      if (p.length === 5 && p[2] && p[3] === 'members' && p[4]) {
        let id;
        let userId;
        try {
          id = decodeURIComponent(p[2]);
          userId = decodeURIComponent(p[4]);
        } catch {
          return null;
        }
        if (!id || !userId) return null;
        if (method === 'PATCH' || method === 'PUT') return { name: 'platform.tenants.members.update', params: { id, userId }, admin: true };
        if (method === 'DELETE') return { name: 'platform.tenants.members.remove', params: { id, userId }, admin: true };
        return null;
      }
      return null;
    }

    return null;
  }

  // Super-admin user management. `admin: true` makes the router enforce the
  // role check after authentication.
  if (a === 'admin' && b === 'users') {
    if (p.length === 2) {
      if (method === 'GET') return { name: 'admin.users.list', params: {}, admin: true };
      if (method === 'POST') return { name: 'admin.users.create', params: {}, admin: true };
      return null;
    }
    if (p.length === 3 && p[2]) {
      let id;
      try {
        id = decodeURIComponent(p[2]);
      } catch {
        return null;
      }
      if (!id) return null;
      if (method === 'GET') return { name: 'admin.users.get', params: { id }, admin: true };
      if (method === 'PATCH' || method === 'PUT') return { name: 'admin.users.update', params: { id }, admin: true };
      if (method === 'DELETE') return { name: 'admin.users.remove', params: { id }, admin: true };
      return null;
    }
    return null;
  }

  if (isResource(a)) {
    if (b === undefined) {
      if (method === 'GET') return { name: 'crud.list', params: { resource: a }, tenant: true };
      if (method === 'POST') return { name: 'crud.create', params: { resource: a }, tenant: true };
      return null;
    }
    if (rest !== 0) return null;
    let id;
    try {
      id = decodeURIComponent(b);
    } catch {
      return null;
    }
    if (method === 'GET') return { name: 'crud.get', params: { resource: a, id }, tenant: true };
    if (method === 'PATCH' || method === 'PUT') return { name: 'crud.update', params: { resource: a, id }, tenant: true };
    if (method === 'DELETE') return { name: 'crud.remove', params: { resource: a, id }, tenant: true };
    return null;
  }

  return null;
}

function clientIp(request) {
  const headers = request.headers;
  const cf = headers.get('CF-Connecting-IP');
  if (cf) return cf.trim();
  const forwarded = headers.get('X-Forwarded-For');
  if (forwarded) return forwarded.split(',')[0].trim();
  return 'unknown';
}

function handleError(e) {
  if (e instanceof HttpError) return error(e.code, e.message, e.status);
  // Log the real cause server-side only; never return stack traces or details.
  console.error('[api] unhandled error:', (e && e.stack) || e);
  return error('internal_error', 'An unexpected error occurred', 500);
}
