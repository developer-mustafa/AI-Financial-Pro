// src/http.js
// Pure HTTP helpers. This module MUST NOT import @neondatabase/serverless or
// any DB module so that it can be unit-tested with plain `node --test`.

/**
 * Typed error that the top-level handler turns into a JSON error envelope.
 */
export class HttpError extends Error {
  /**
   * @param {number} status HTTP status code
   * @param {string} code   stable machine-readable error code
   * @param {string} message safe, client-facing message
   */
  constructor(status, code, message) {
    super(message || 'Request failed');
    this.name = 'HttpError';
    this.status = Number.isInteger(status) ? status : 500;
    this.code = code || 'error';
  }
}

export const MAX_BODY_BYTES = 1024 * 1024; // 1 MiB

/**
 * JSON success/data response.
 * @param {unknown} data
 * @param {number} [status]
 * @param {Record<string,string>} [extraHeaders]
 */
export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...extraHeaders,
    },
  });
}

/**
 * JSON error envelope: { error: { code, message } }.
 */
export function error(code, message, status = 400, extraHeaders = {}) {
  return json({ error: { code, message } }, status, extraHeaders);
}

/**
 * Throw an HttpError when `cond` is falsy.
 */
export function assert(cond, message, status = 400, code = 'validation_error') {
  if (!cond) throw new HttpError(status, code, message);
}

/**
 * Read and parse a JSON request body with a hard byte cap.
 * - malformed JSON -> HttpError 400
 * - missing/empty body -> {}
 * - over the cap -> HttpError 413 (enforced while streaming, not just after)
 */
export async function parseJson(request, maxBytes = MAX_BODY_BYTES) {
  const declared = request.headers.get('content-length');
  if (declared != null && Number(declared) > maxBytes) {
    throw new HttpError(413, 'payload_too_large', 'Request body is too large');
  }

  let buf;
  const stream = request.body;
  if (stream && typeof stream.getReader === 'function') {
    const reader = stream.getReader();
    const chunks = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          total += value.byteLength;
          if (total > maxBytes) {
            try {
              await reader.cancel();
            } catch {
              /* ignore */
            }
            throw new HttpError(413, 'payload_too_large', 'Request body is too large');
          }
          chunks.push(value);
        }
      }
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(400, 'invalid_body', 'Could not read request body');
    }
    buf = concatChunks(chunks, total);
  } else {
    try {
      buf = new Uint8Array(await request.arrayBuffer());
    } catch {
      throw new HttpError(400, 'invalid_body', 'Could not read request body');
    }
    if (buf.byteLength > maxBytes) {
      throw new HttpError(413, 'payload_too_large', 'Request body is too large');
    }
  }

  if (buf.byteLength === 0) return {};

  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    throw new HttpError(400, 'invalid_json', 'Request body must be valid UTF-8');
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'invalid_json', 'Request body must be valid JSON');
  }
}

function concatChunks(chunks, total) {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Return the allowed request origin for this request, or null.
 * - Requests with no Origin header are always processed (same-origin, curl,
 *   server-to-server); no CORS header is required for them.
 * - An Origin that matches the request's own origin is always allowed.
 * - Otherwise the Origin must be present in env.ALLOWED_ORIGINS.
 */
export function allowedOrigin(request, env) {
  const origin = request.headers.get('Origin');
  if (!origin) return null;

  let selfOrigin = null;
  try {
    selfOrigin = new URL(request.url).origin;
  } catch {
    selfOrigin = null;
  }
  if (selfOrigin && origin === selfOrigin) return origin;

  const list = String((env && env.ALLOWED_ORIGINS) || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return list.includes(origin) ? origin : null;
}

/**
 * Compute CORS response headers for a request. Never throws.
 */
export function corsHeaders(request, env) {
  const headers = {
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
  const origin = allowedOrigin(request, env);
  if (origin) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Credentials'] = 'true';
  }
  return headers;
}

/**
 * Security headers applied to every response.
 */
export function securityHeaders() {
  return {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    // HSTS. Only honored by browsers over HTTPS, so it is harmless on
    // http://localhost. Two years + subdomains; deliberately *not* preloaded
    // (preload is a hard-to-reverse commitment).
    'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
  };
}

/**
 * Merge extra headers onto an existing Response without consuming the body.
 */
export function withHeaders(response, extraHeaders = {}) {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(extraHeaders)) {
    if (v != null) headers.set(k, String(v));
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Query-string reader. Returns a small wrapper with typed accessors so routes
 * never touch untrusted values without validation.
 */
export function readQuery(request) {
  let params;
  try {
    params = new URL(request.url).searchParams;
  } catch {
    params = new URLSearchParams();
  }
  return {
    raw: params,
    get(name) {
      const v = params.get(name);
      return v == null ? null : v;
    },
  };
}

/**
 * Fixed-window rate limiter (in-memory). Pure and testable: pass `now` to
 * control the clock and your own `store` Map.
 *
 * @param {Map} store
 * @param {string} key
 * @param {{limit?:number, windowMs?:number, now?:number}} [opts]
 * @returns {{ok:boolean, limit:number, remaining:number, resetAt:number, retryAfter?:number, bucket:number}}
 */
export function rateLimit(store, key, opts = {}) {
  const limit = opts.limit ?? 120;
  const windowMs = opts.windowMs ?? 60000;
  const now = opts.now ?? Date.now();

  const bucket = Math.floor(now / windowMs);
  const entry = store.get(key);

  if (!entry || entry.bucket !== bucket) {
    store.set(key, { bucket, count: 1 });
    return { ok: true, limit, remaining: limit - 1, resetAt: (bucket + 1) * windowMs, bucket };
  }

  entry.count += 1;
  if (entry.count > limit) {
    return {
      ok: false,
      limit,
      remaining: 0,
      resetAt: (bucket + 1) * windowMs,
      retryAfter: Math.max(1, Math.ceil(((bucket + 1) * windowMs - now) / 1000)),
      bucket,
    };
  }
  return { ok: true, limit, remaining: limit - entry.count, resetAt: (bucket + 1) * windowMs, bucket };
}

/**
 * Best-effort pruning so the in-memory rate-limit store cannot grow forever.
 */
export function pruneRateStore(store, opts = {}) {
  const windowMs = opts.windowMs ?? 60000;
  const now = opts.now ?? Date.now();
  const cutoffBucket = Math.floor(now / windowMs) - 1;
  for (const [key, entry] of store) {
    if (!entry || entry.bucket < cutoffBucket) store.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Request correlation (observability)
// ---------------------------------------------------------------------------

// Accept only opaque, header-safe ids. Anything else is ignored and replaced,
// which prevents log injection / response-header injection via X-Request-Id.
const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{8,128}$/;

/**
 * Return a trustworthy inbound request id, or null.
 * Prefers an explicit `X-Request-Id` (so a caller can correlate), then the
 * Cloudflare-provided `CF-Ray`, which is always present on real edge traffic.
 */
export function requestIdOf(request) {
  try {
    const header = request.headers.get('X-Request-Id');
    if (header && REQUEST_ID_RE.test(header)) return header;
    const ray = request.headers.get('CF-Ray');
    if (ray && REQUEST_ID_RE.test(ray)) return ray;
  } catch {
    /* malformed request: fall through to a generated id */
  }
  return null;
}

/**
 * Generate a new random request id. Uses crypto.randomUUID when available.
 */
export function newRequestId() {
  try {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
      return globalThis.crypto.randomUUID();
    }
  } catch {
    /* fall through */
  }
  return `req_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Resolve the id to echo on the response and use in logs.
 */
export function resolveRequestId(request) {
  return requestIdOf(request) || newRequestId();
}

/**
 * Map a `rateLimit()` result onto standard `X-RateLimit-*` response headers.
 * Safe to call with null/undefined (returns {}).
 */
export function rateLimitHeaders(result) {
  if (!result) return {};
  const headers = {};
  if (Number.isFinite(result.limit)) headers['X-RateLimit-Limit'] = String(result.limit);
  if (Number.isFinite(result.remaining)) {
    headers['X-RateLimit-Remaining'] = String(Math.max(0, result.remaining));
  }
  if (Number.isFinite(result.resetAt)) {
    headers['X-RateLimit-Reset'] = String(Math.ceil(result.resetAt / 1000));
  }
  return headers;
}
