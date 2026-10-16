// src/neonAuth.js
//
// Verification of Managed Better Auth (Neon Auth) access tokens.
//
// The browser signs in with Neon Auth (email magic link or password) and sends
// the resulting JWT as `Authorization: Bearer <jwt>` to this Worker. Neon Auth
// signs those tokens with EdDSA (Ed25519) and publishes the public keys at a
// JWKS endpoint, so the Worker can verify them statelessly — no shared secret
// with the auth service and no database round-trip.
//
// This module MUST NOT import ./db.js so it stays unit-testable with plain
// `node --test` (no driver, no network). All I/O goes through an injectable
// `fetchImpl`.
//
// Verification rules (all must hold):
//   * header.alg === 'EdDSA' and header.kid matches a key in the JWKS
//   * signature is valid for `<header>.<payload>` (Ed25519, 64-byte signature)
//   * payload.sub / payload.exp are present; exp is in the future
//   * iss (and aud, when present) match the configured Neon Auth origin
//
// Anything else fails closed with HttpError(401). JWKS *fetch* failures are
// reported as HttpError(503) so a transient auth-service outage is not
// mistaken for a bad token.

import { HttpError } from './http.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

/** How long a fetched JWKS is trusted, per isolate, before a refetch. */
export const DEFAULT_JWKS_TTL_MS = 60 * 60 * 1000; // 1 hour
/** Ed25519 signatures are always 64 bytes. */
const ED25519_SIGNATURE_BYTES = 64;

// ---------------------------------------------------------------------------
// base64url
// ---------------------------------------------------------------------------

function base64UrlToBytes(str) {
  const padded = str.length % 4 === 0 ? str : str + '='.repeat(4 - (str.length % 4));
  const b64 = padded.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

function decodeSegment(segment, what) {
  try {
    const parsed = JSON.parse(dec.decode(base64UrlToBytes(segment)));
    if (!parsed || typeof parsed !== 'object') throw new Error('not an object');
    return parsed;
  } catch {
    throw new HttpError(401, 'unauthorized', `Invalid or expired token (bad ${what})`);
  }
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Resolve the public Neon Auth settings from the Worker environment.
 * Both values are public (they are handed to the browser anyway): they are
 * `[vars]` entries, not secrets.
 *
 * @param {Record<string, unknown>} env
 * @returns {{baseUrl:string, jwksUrl:string, issuer:string|null, configured:boolean}}
 */
export function neonAuthConfig(env) {
  const rawBase = env && typeof env.NEON_AUTH_BASE_URL === 'string' ? env.NEON_AUTH_BASE_URL.trim() : '';
  const baseUrl = rawBase.replace(/\/+$/, '');

  let issuer = null;
  if (baseUrl) {
    try {
      issuer = new URL(baseUrl).origin;
    } catch {
      issuer = null;
    }
  }

  const rawJwks = env && typeof env.NEON_AUTH_JWKS_URL === 'string' ? env.NEON_AUTH_JWKS_URL.trim() : '';
  const jwksUrl = rawJwks || (baseUrl ? `${baseUrl}/.well-known/jwks.json` : '');

  return { baseUrl, jwksUrl, issuer, configured: Boolean(baseUrl && jwksUrl && issuer) };
}

// ---------------------------------------------------------------------------
// JWKS cache
// ---------------------------------------------------------------------------

/**
 * Small in-memory JWKS cache. One cache per isolate is fine: keys rotate
 * rarely and an unknown `kid` forces a single refetch.
 *
 * @param {{fetchImpl?: Function, ttlMs?: number, now?: () => number}} [options]
 */
export function createJwksCache({ fetchImpl = globalThis.fetch, ttlMs = DEFAULT_JWKS_TTL_MS, now = () => Date.now() } = {}) {
  let cached = null; // { url, keys, expiresAt }
  let inFlight = null;

  async function load(url) {
    if (typeof fetchImpl !== 'function') {
      throw new HttpError(503, 'auth_unavailable', 'Authentication service is unavailable');
    }

    let response;
    try {
      response = await fetchImpl(url, { headers: { accept: 'application/json' } });
    } catch (e) {
      throw new HttpError(503, 'auth_unavailable', 'Authentication service is unavailable');
    }
    if (!response || !response.ok) {
      throw new HttpError(503, 'auth_unavailable', 'Authentication service is unavailable');
    }

    let body;
    try {
      body = await response.json();
    } catch {
      throw new HttpError(503, 'auth_unavailable', 'Authentication service is unavailable');
    }

    const keys = Array.isArray(body?.keys) ? body.keys.filter((k) => k && typeof k === 'object') : [];
    if (keys.length === 0) {
      throw new HttpError(503, 'auth_unavailable', 'Authentication service is unavailable');
    }
    return keys;
  }

  return {
    /**
     * @param {string} url
     * @param {{force?: boolean}} [options]
     * @returns {Promise<Array<object>>}
     */
    async get(url, { force = false } = {}) {
      if (!url) throw new HttpError(503, 'auth_unavailable', 'Authentication service is unavailable');
      if (!force && cached && cached.url === url && cached.expiresAt > now()) return cached.keys;
      if (inFlight && inFlight.url === url) return inFlight.promise;

      const promise = load(url)
        .then((keys) => {
          cached = { url, keys, expiresAt: now() + ttlMs };
          return keys;
        })
        .finally(() => {
          if (inFlight && inFlight.promise === promise) inFlight = null;
        });

      inFlight = { url, promise };
      return promise;
    },

    /** Drop the cache (used after a `kid` miss). */
    clear() {
      cached = null;
    },
  };
}

// ---------------------------------------------------------------------------
// Key import + signature verification
// ---------------------------------------------------------------------------

function findKey(keys, kid) {
  if (kid) {
    const match = keys.find((k) => k.kid === kid);
    if (match) return match;
  }
  // Single-key sets are common; only fall back when the kid is absent.
  if (!kid && keys.length === 1) return keys[0];
  return null;
}

async function importEd25519(jwk) {
  if (!jwk || jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string') {
    throw new HttpError(401, 'unauthorized', 'Invalid or expired token (unsupported key)');
  }
  // `alg` is deliberately omitted: the Secure Curves spec dropped it and some
  // runtimes reject a JWK that carries it.
  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: 'OKP', crv: 'Ed25519', x: jwk.x },
    { name: 'Ed25519' },
    false,
    ['verify'],
  );
  return key;
}

// ---------------------------------------------------------------------------
// Token verification
// ---------------------------------------------------------------------------

/**
 * Verify a Neon Auth access token.
 *
 * @param {string} token
 * @param {Record<string, unknown>} env
 * @param {{jwksCache?: ReturnType<typeof createJwksCache>, fetchImpl?: Function, nowMs?: number}} [options]
 * @returns {Promise<{sub:string, email:string|null, name:string, emailVerified:boolean, role:string|null, claims:object}>}
 */
export async function verifyNeonAuthToken(token, env, options = {}) {
  const config = neonAuthConfig(env);
  if (!config.configured) {
    throw new HttpError(503, 'auth_unavailable', 'Authentication service is unavailable');
  }

  const invalid = () => new HttpError(401, 'unauthorized', 'Invalid or expired token');

  if (typeof token !== 'string' || token.length === 0) throw invalid();
  const parts = token.split('.');
  if (parts.length !== 3) throw invalid();
  const [h, p, s] = parts;
  if (!h || !p || !s) throw invalid();

  const header = decodeSegment(h, 'header');
  if (header.alg !== 'EdDSA') throw invalid();

  const payload = decodeSegment(p, 'payload');
  if (typeof payload.sub !== 'string' || payload.sub.length === 0) throw invalid();
  if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) throw invalid();

  const nowMs = options.nowMs ?? Date.now();
  if (payload.exp * 1000 <= nowMs) throw invalid();
  if (typeof payload.nbf === 'number' && Number.isFinite(payload.nbf) && payload.nbf * 1000 > nowMs + 60_000) {
    throw invalid();
  }

  // The issuer of the token must be the Neon Auth origin. `aud` is set to the
  // same value by Managed Better Auth; accept the base URL too for safety.
  const acceptable = new Set([config.issuer, config.baseUrl]);
  if (typeof payload.iss !== 'string' || !acceptable.has(payload.iss)) throw invalid();
  if (payload.aud !== undefined) {
    const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!auds.some((a) => typeof a === 'string' && acceptable.has(a))) throw invalid();
  }

  let signature;
  try {
    signature = base64UrlToBytes(s);
  } catch {
    throw invalid();
  }
  if (signature.length !== ED25519_SIGNATURE_BYTES) throw invalid();

  const jwks = options.jwksCache || createJwksCache({ fetchImpl: options.fetchImpl });
  let keys = await jwks.get(config.jwksUrl);
  let jwk = findKey(keys, typeof header.kid === 'string' ? header.kid : null);

  if (!jwk) {
    // Key rotation: refetch once before giving up.
    jwks.clear();
    keys = await jwks.get(config.jwksUrl, { force: true });
    jwk = findKey(keys, typeof header.kid === 'string' ? header.kid : null);
  }
  if (!jwk) throw invalid();

  let key;
  try {
    key = await importEd25519(jwk);
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw invalid();
  }

  let ok = false;
  try {
    ok = await crypto.subtle.verify({ name: 'Ed25519' }, key, signature, enc.encode(`${h}.${p}`));
  } catch {
    ok = false;
  }
  if (!ok) throw invalid();

  return {
    sub: payload.sub,
    email: typeof payload.email === 'string' ? payload.email : null,
    name: typeof payload.name === 'string' ? payload.name : '',
    emailVerified: payload.emailVerified === true,
    role: typeof payload.role === 'string' ? payload.role : null,
    claims: payload,
  };
}
