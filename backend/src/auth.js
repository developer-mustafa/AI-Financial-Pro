// src/auth.js
// Authentication primitives implemented with WebCrypto only (no bcrypt, no
// node:crypto dependency), so the same code runs in Cloudflare Workers and in
// Node 22 for tests.
//
// NOTE: this module must NOT statically import ./db.js, so that unit tests can
// import it without pulling in @neondatabase/serverless. requireAuth() lazily
// imports the DB module at call time.

import { HttpError, assert } from './http.js';
import { verifyNeonAuthToken } from './neonAuth.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

export const PBKDF2_ITERATIONS = 150000;
export const SALT_BYTES = 16;
export const KEY_BITS = 256; // 32-byte derived key
export const TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days
export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 200;
export const MIN_SECRET_LENGTH = 32;

// A password hash that can never verify. Used for rows whose only credential
// lives in Neon Auth (magic link), so the `password_hash NOT NULL` constraint is
// satisfied without inventing a usable password: verifyPassword() rejects the
// format outright and always fails closed.
export const NEON_PASSWORD_SENTINEL = 'neon-auth$managed';

// ---------------------------------------------------------------------------
// Roles and account status (super-admin surface)
// ---------------------------------------------------------------------------

export const ROLES = ['user', 'admin'];
export const USER_STATUSES = ['active', 'suspended'];

/** Coerce any stored role value to the two-value public set. */
export function normalizeRole(value) {
  return value === 'admin' ? 'admin' : 'user';
}

/** Coerce any stored status value to the two-value public set. */
export function normalizeStatus(value) {
  return value === 'suspended' ? 'suspended' : 'active';
}

/**
 * Emails that should be administrators, from the comma-separated `ADMIN_EMAILS`
 * Worker variable. This is the bootstrap mechanism: the first admin is simply
 * the account whose address is listed here.
 * @returns {string[]} lowercase, trimmed, non-empty
 */
export function adminEmails(env) {
  const raw = env && env.ADMIN_EMAILS;
  if (typeof raw !== 'string') return [];
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** True when `email` is listed in ADMIN_EMAILS. */
export function isAdminEmail(env, email) {
  const list = adminEmails(env);
  if (list.length === 0) return false;
  return list.includes(normalizeEmail(email));
}

/**
 * Promote a user row to 'admin' when their email is listed in ADMIN_EMAILS.
 * Applied on every authenticated request, but performs no write once the row
 * already has the admin role (or the email is not listed), so the common path
 * stays a single cheap string check.
 *
 * @param {{query: (text:string, params?:unknown[]) => Promise<any[]>}} db
 * @param {Record<string, unknown>} env
 * @param {any} row a users row
 * @returns {Promise<any>} the (possibly updated) row
 */
export async function promoteAdminIfListed(db, env, row) {
  if (!row || normalizeRole(row.role) === 'admin') return row;
  if (!isAdminEmail(env, row.email)) return row;
  const updated = await db.query(
    `UPDATE users SET role = 'admin', updated_at = now()
     WHERE id = $1 RETURNING ${USER_COLUMNS}`,
    [row.id],
  );
  return updated && updated.length ? updated[0] : row;
}

/** Reject a suspended account. 403, never 401, so the client can explain it. */
export function assertActive(row) {
  if (row && normalizeStatus(row.status) === 'suspended') {
    throw new HttpError(403, 'account_suspended', 'This account has been suspended');
  }
}

// ---------------------------------------------------------------------------
// base64url helpers (binary-safe, no dependence on btoa quirks)
// ---------------------------------------------------------------------------

export function bytesToBase64Url(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlToBytes(str) {
  const padded = str.length % 4 === 0 ? str : str + '='.repeat(4 - (str.length % 4));
  const b64 = padded.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

/** Constant-time byte comparison. */
export function timingSafeEqual(a, b) {
  if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array)) return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

// ---------------------------------------------------------------------------
// Password hashing (PBKDF2-SHA256)
// ---------------------------------------------------------------------------

async function deriveBits(password, salt, iterations) {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    keyMaterial,
    KEY_BITS,
  );
  return new Uint8Array(bits);
}

/**
 * @param {string} password
 * @returns {Promise<string>} `pbkdf2$<iterations>$<saltB64>$<hashB64>`
 */
export async function hashPassword(password) {
  assertPassword(password);
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const key = await deriveBits(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${bytesToBase64Url(salt)}$${bytesToBase64Url(key)}`;
}

/**
 * Verify a password against a stored hash. Fails closed on malformed input.
 * @param {string} password
 * @param {string} stored
 * @returns {Promise<boolean>}
 */
export async function verifyPassword(password, stored) {
  try {
    if (typeof password !== 'string' || typeof stored !== 'string') return false;
    const parts = stored.split('$');
    if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
    const iterations = Number.parseInt(parts[1], 10);
    if (!Number.isInteger(iterations) || iterations < 1 || iterations > 2_000_000) return false;
    const salt = base64UrlToBytes(parts[2]);
    const expected = base64UrlToBytes(parts[3]);
    if (salt.length === 0 || expected.length === 0) return false;
    const actual = await deriveBits(password, salt, iterations);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Email + password policy
// ---------------------------------------------------------------------------

export function normalizeEmail(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

export function isValidEmail(email) {
  if (typeof email !== 'string') return false;
  if (email.length < 3 || email.length > 254) return false;
  if (/\s/.test(email)) return false;
  const at = email.indexOf('@');
  if (at <= 0 || at !== email.lastIndexOf('@')) return false;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (!local || !domain) return false;
  if (!domain.includes('.')) return false;
  if (domain.startsWith('.') || domain.endsWith('.') || domain.includes('..')) return false;
  return /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(email);
}

export function assertPassword(password) {
  assert(typeof password === 'string', 'Password must be a string');
  assert(password.length >= MIN_PASSWORD_LENGTH, `Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  assert(password.length <= MAX_PASSWORD_LENGTH, `Password must be at most ${MAX_PASSWORD_LENGTH} characters`);
  assert(password.trim().length > 0, 'Password must not be only whitespace');
}

export function assertEmail(email) {
  assert(isValidEmail(email), 'A valid email address is required');
}

// ---------------------------------------------------------------------------
// Tokens (compact JWT-like HS256, no external library)
// ---------------------------------------------------------------------------

function getSecret(env) {
  const secret = env && env.AUTH_SECRET;
  if (typeof secret !== 'string' || secret.length < MIN_SECRET_LENGTH) {
    // Log server-side; never surface the reason to the client.
    console.error(
      `[auth] AUTH_SECRET is missing or shorter than ${MIN_SECRET_LENGTH} characters; refusing to issue/verify tokens`,
    );
    throw new HttpError(500, 'server_misconfigured', 'Server authentication is not configured');
  }
  return secret;
}

async function hmacSign(secret, data) {
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return new Uint8Array(signature);
}

function randomJti() {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(12)));
}

/**
 * Create a signed token.
 * @param {Record<string, unknown>} payload  e.g. { sub: userId }
 * @param {Record<string, unknown>} env
 * @param {{ now?: number, ttlSeconds?: number }} [opts]  now is epoch ms
 */
export async function createToken(payload, env, opts = {}) {
  const secret = getSecret(env);
  const nowMs = opts.now ?? Date.now();
  const ttl = opts.ttlSeconds ?? TOKEN_TTL_SECONDS;
  const iat = Math.floor(nowMs / 1000);
  const exp = iat + ttl;

  const header = { alg: 'HS256', typ: 'JWT' };
  const body = { ...payload, iat, exp, jti: randomJti() };

  const h = bytesToBase64Url(enc.encode(JSON.stringify(header)));
  const p = bytesToBase64Url(enc.encode(JSON.stringify(body)));
  const data = `${h}.${p}`;
  const sig = await hmacSign(secret, data);
  return `${data}.${bytesToBase64Url(sig)}`;
}

/**
 * Verify a token's signature and expiry. Throws HttpError(401) on any problem.
 * @returns {Promise<Record<string, unknown>>} decoded payload
 */
export async function verifyToken(token, env, opts = {}) {
  const secret = getSecret(env);
  const invalid = () => new HttpError(401, 'unauthorized', 'Invalid or expired token');
  const nowMs = opts.now ?? Date.now();

  if (typeof token !== 'string') throw invalid();
  const parts = token.split('.');
  if (parts.length !== 3) throw invalid();
  const [h, p, s] = parts;
  if (!h || !p || !s) throw invalid();

  const expected = await hmacSign(secret, `${h}.${p}`);
  let provided;
  try {
    provided = base64UrlToBytes(s);
  } catch {
    throw invalid();
  }
  if (!timingSafeEqual(expected, provided)) throw invalid();

  let payload;
  try {
    payload = JSON.parse(dec.decode(base64UrlToBytes(p)));
  } catch {
    throw invalid();
  }
  if (!payload || typeof payload !== 'object') throw invalid();
  if (typeof payload.sub !== 'string' || payload.sub.length === 0) throw invalid();
  if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) throw invalid();
  if (payload.exp * 1000 <= nowMs) throw invalid();
  return payload;
}

// ---------------------------------------------------------------------------
// Request authentication
// ---------------------------------------------------------------------------

const USER_COLUMNS = 'id, email, name, role, status, created_at, updated_at';

/** Pull the bearer token out of the Authorization header. */
export function extractBearerToken(request) {
  const header = request.headers.get('Authorization') || '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) throw new HttpError(401, 'unauthorized', 'Missing or malformed Authorization header');
  return match[1];
}

/**
 * Read the JWT header without verifying anything. This only decides WHICH
 * verification path to take (the app's own HS256 tokens vs. a Neon Auth EdDSA
 * token); it is never a security decision on its own.
 *
 * @param {string} token
 * @returns {string|null} the `alg` value, or null when the token is malformed
 */
export function peekTokenAlgorithm(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[0]) return null;
  try {
    const header = JSON.parse(dec.decode(base64UrlToBytes(parts[0])));
    return typeof header?.alg === 'string' ? header.alg : null;
  } catch {
    return null;
  }
}

function isUuid(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/**
 * Map a Neon Auth identity onto an app user row, creating one when needed.
 *
 * Order of resolution:
 *   1. an existing row already linked to this Neon Auth user id;
 *   2. a row with the same (case-insensitive) email — linked in place, so a
 *      magic-link sign-in reaches the same finance data as the password login;
 *   3. a brand new row keyed by the Neon Auth user id.
 *
 * Never mutates an existing profile: no email/name rewriting on every request.
 *
 * @param {{query: (text:string, params?:unknown[]) => Promise<any[]>}} db
 * @param {{sub:string, email:string|null, name?:string}} identity
 */
export async function ensureNeonUser(db, identity) {
  const sub = typeof identity?.sub === 'string' ? identity.sub : '';
  if (!isUuid(sub)) throw new HttpError(401, 'unauthorized', 'Authentication required');

  const email = normalizeEmail(identity?.email || '');
  if (!isValidEmail(email)) throw new HttpError(401, 'unauthorized', 'Authentication required');
  const name = String(identity?.name || '').trim().slice(0, 120);

  // SECURITY: an unverified Neon Auth email must never link to (or create) an
  // app account, otherwise anyone who can claim an address could take over the
  // finance data behind it. Verified server-side from the signed token claim.
  if (identity?.emailVerified !== true) {
    throw new HttpError(403, 'email_not_verified', 'Verify your email address before signing in');
  }

  const linked = await db.query(`SELECT ${USER_COLUMNS} FROM users WHERE neon_auth_user_id = $1`, [sub]);
  if (linked.length) return linked[0];

  const byEmail = await db.query(`SELECT ${USER_COLUMNS} FROM users WHERE lower(email) = $1`, [email]);
  if (byEmail.length) {
    const row = byEmail[0];
    const updated = await db.query(
      `UPDATE users SET neon_auth_user_id = $2, updated_at = now()
       WHERE id = $1 AND neon_auth_user_id IS NULL
       RETURNING ${USER_COLUMNS}`,
      [row.id, sub],
    );
    // Losing the race means another request linked it first; either way the
    // effective tenant is the same app user.
    return updated.length ? updated[0] : row;
  }

  try {
    const created = await db.query(
      `INSERT INTO users (id, email, password_hash, name, auth_provider, neon_auth_user_id)
       VALUES ($1, $2, $3, $4, 'neon', $1)
       RETURNING ${USER_COLUMNS}`,
      [sub, email, NEON_PASSWORD_SENTINEL, name],
    );
    return created[0];
  } catch (e) {
    // Concurrent first request for the same identity: fall back to a read.
    const again = await db.query(`SELECT ${USER_COLUMNS} FROM users WHERE neon_auth_user_id = $1`, [sub]);
    if (again.length) return again[0];
    const retryEmail = await db.query(`SELECT ${USER_COLUMNS} FROM users WHERE lower(email) = $1`, [email]);
    if (retryEmail.length) return retryEmail[0];
    throw e;
  }
}

/**
 * Authenticate the request and load the caller's user row.
 *
 * Accepts two token kinds:
 *   * the app's own HS256 session tokens (email + password accounts), and
 *   * Managed Better Auth (Neon Auth) EdDSA access tokens (magic link / OAuth).
 *
 * The token's header `alg` selects the verifier; a token that claims HS256 is
 * only ever checked with the app secret and vice versa.
 *
 * @returns {Promise<{userId:string, user:object}>}
 */
export async function requireAuth(request, env) {
  const token = extractBearerToken(request);
  const algorithm = peekTokenAlgorithm(token);

  if (algorithm === 'EdDSA') {
    const identity = await verifyNeonAuthToken(token, env);
    // Lazy import keeps this module free of the DB driver at load time.
    const { createDb } = await import('./db.js');
    const db = createDb(env);
    const row = await ensureNeonUser(db, identity);
    const active = await promoteAdminIfListed(db, env, row);
    assertActive(active);
    return { userId: active.id, user: userToApi(active) };
  }

  const payload = await verifyToken(token, env);

  // Lazy import keeps this module free of the DB driver at load time.
  const { createDb } = await import('./db.js');
  const db = createDb(env);
  const rows = await db.query(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [payload.sub]);
  if (!rows.length) throw new HttpError(401, 'unauthorized', 'Authentication required');

  const row = await promoteAdminIfListed(db, env, rows[0]);
  assertActive(row);
  return { userId: row.id, user: userToApi(row) };
}

/** Map a users row to the public camelCase shape (never password_hash). */
export function userToApi(row) {
  return {
    id: row.id,
    email: row.email,
    name: row.name ?? '',
    role: normalizeRole(row.role),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function toIso(v) {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString();
}
