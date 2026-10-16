// test/neonAuth.test.mjs
// Plain `node --test` suite for Neon Auth (Managed Better Auth) token
// verification and identity linking.
//
// These tests generate a real Ed25519 key pair with WebCrypto, sign real
// JWTs, and verify them against a synthetic JWKS served through an injected
// fetch. Nothing here touches the network or the database driver.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  neonAuthConfig,
  createJwksCache,
  verifyNeonAuthToken,
  DEFAULT_JWKS_TTL_MS,
} from '../src/neonAuth.js';

import {
  extractBearerToken,
  peekTokenAlgorithm,
  ensureNeonUser,
  requireAuth,
  userToApi,
  adminEmails,
  isAdminEmail,
  promoteAdminIfListed,
  assertActive,
} from '../src/auth.js';

import { HttpError } from '../src/http.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const AUTH_ORIGIN = 'https://ep-test.neonauth.example.neon.tech';
const AUTH_BASE = `${AUTH_ORIGIN}/expense-tracker-pro/auth`;
const JWKS_URL = `${AUTH_BASE}/.well-known/jwks.json`;
const KID = 'test-key-1';

const ENV = { NEON_AUTH_BASE_URL: AUTH_BASE };

function b64url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlJson(value) {
  return b64url(new TextEncoder().encode(JSON.stringify(value)));
}

async function makeKeyPair() {
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  return { pair, publicJwk: { ...jwk, kid: KID, alg: 'EdDSA', use: 'sig' } };
}

async function signJwt(pair, claims, { alg = 'EdDSA', kid = KID, tamper } = {}) {
  const header = { alg, typ: 'JWT', kid };
  const h = b64urlJson(tampered(header, tamper));
  const p = b64urlJson(claims);
  const data = `${h}.${p}`;
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, pair.privateKey, new TextEncoder().encode(data)));
  return `${data}.${b64url(sig)}`;
}

// `tamper` lets a test bend one part of the token without re-signing it the
// "right" way (used for the signature-tampering case, which re-signs a
// *different* payload under the original signature).
function tampered(header, tamper) {
  if (tamper === 'alg-none') return { ...header, alg: 'none' };
  return header;
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function baseClaims(overrides = {}) {
  return {
    sub: '3f1c0d2e-4a5b-4c6d-8e9f-0a1b2c3d4e5f',
    email: 'person@example.com',
    name: 'Test Person',
    emailVerified: true,
    role: 'authenticated',
    iss: AUTH_ORIGIN,
    aud: AUTH_ORIGIN,
    iat: nowSeconds() - 5,
    exp: nowSeconds() + 600,
    ...overrides,
  };
}

/** fetch stub that serves one JWKS document and counts calls. */
function jwksFetch(keys, { fail = false } = {}) {
  const calls = { count: 0 };
  const impl = async (url) => {
    calls.count += 1;
    assert.equal(url, JWKS_URL);
    if (fail) throw new Error('network down');
    return new Response(JSON.stringify({ keys }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  impl.calls = calls;
  return impl;
}

function statusCode(e) {
  return e instanceof HttpError ? e.status : null;
}

// ---------------------------------------------------------------------------
// neonAuthConfig
// ---------------------------------------------------------------------------

test('neonAuthConfig derives the JWKS URL and issuer from the base URL', () => {
  const config = neonAuthConfig(ENV);
  assert.equal(config.baseUrl, AUTH_BASE);
  assert.equal(config.jwksUrl, JWKS_URL);
  assert.equal(config.issuer, AUTH_ORIGIN);
  assert.equal(config.configured, true);
});

test('neonAuthConfig respects an explicit JWKS override and tolerates junk', () => {
  const config = neonAuthConfig({ NEON_AUTH_BASE_URL: `${AUTH_BASE}/`, NEON_AUTH_JWKS_URL: 'https://keys.example/jwks.json' });
  assert.equal(config.baseUrl, AUTH_BASE);
  assert.equal(config.jwksUrl, 'https://keys.example/jwks.json');
  assert.equal(config.configured, true);

  const missing = neonAuthConfig({});
  assert.equal(missing.configured, false);
  assert.equal(missing.jwksUrl, '');
});

// ---------------------------------------------------------------------------
// verifyNeonAuthToken — happy path
// ---------------------------------------------------------------------------

test('verifies a well-formed Neon Auth token', async () => {
  const { pair, publicJwk } = await makeKeyPair();
  const token = await signJwt(pair, baseClaims());
  const fetchImpl = jwksFetch([publicJwk]);
  const jwksCache = createJwksCache({ fetchImpl });

  const identity = await verifyNeonAuthToken(token, ENV, { jwksCache });
  assert.equal(identity.sub, '3f1c0d2e-4a5b-4c6d-8e9f-0a1b2c3d4e5f');
  assert.equal(identity.email, 'person@example.com');
  assert.equal(identity.name, 'Test Person');
  assert.equal(identity.emailVerified, true);
  assert.equal(fetchImpl.calls.count, 1);
});

test('caches the JWKS across verifications', async () => {
  const { pair, publicJwk } = await makeKeyPair();
  const fetchImpl = jwksFetch([publicJwk]);
  const jwksCache = createJwksCache({ fetchImpl });

  await verifyNeonAuthToken(await signJwt(pair, baseClaims()), ENV, { jwksCache });
  await verifyNeonAuthToken(await signJwt(pair, baseClaims({ sub: '11111111-2222-4333-8444-555555555555' })), ENV, { jwksCache });
  assert.equal(fetchImpl.calls.count, 1, 'second token must reuse the cached keys');

  // An expired cache entry forces one refetch.
  const shortCache = createJwksCache({ fetchImpl, ttlMs: -1 });
  await verifyNeonAuthToken(await signJwt(pair, baseClaims()), ENV, { jwksCache: shortCache });
  assert.ok(DEFAULT_JWKS_TTL_MS > 0);
});

// ---------------------------------------------------------------------------
// verifyNeonAuthToken — rejection paths
// ---------------------------------------------------------------------------

test('rejects a tampered payload', async () => {
  const { pair, publicJwk } = await makeKeyPair();
  const token = await signJwt(pair, baseClaims());
  const [h, , s] = token.split('.');
  const forged = `${h}.${b64urlJson(baseClaims({ email: 'attacker@example.com' }))}.${s}`;

  await assert.rejects(
    verifyNeonAuthToken(forged, ENV, { jwksCache: createJwksCache({ fetchImpl: jwksFetch([publicJwk]) }) }),
    (e) => statusCode(e) === 401,
  );
});

test('rejects an expired token', async () => {
  const { pair, publicJwk } = await makeKeyPair();
  const token = await signJwt(pair, baseClaims({ exp: nowSeconds() - 1 }));
  await assert.rejects(
    verifyNeonAuthToken(token, ENV, { jwksCache: createJwksCache({ fetchImpl: jwksFetch([publicJwk]) }) }),
    (e) => statusCode(e) === 401,
  );
});

test('rejects a wrong issuer, wrong algorithm, and a token signed by another key', async () => {
  const { pair, publicJwk } = await makeKeyPair();
  const other = await makeKeyPair();
  const cache = createJwksCache({ fetchImpl: jwksFetch([publicJwk]) });

  await assert.rejects(
    verifyNeonAuthToken(await signJwt(pair, baseClaims({ iss: 'https://evil.example' })), ENV, { jwksCache: cache }),
    (e) => statusCode(e) === 401,
  );
  await assert.rejects(
    verifyNeonAuthToken(await signJwt(pair, baseClaims(), { alg: 'HS256' }), ENV, { jwksCache: cache }),
    (e) => statusCode(e) === 401,
  );
  await assert.rejects(
    verifyNeonAuthToken(await signJwt(other.pair, baseClaims()), ENV, { jwksCache: cache }),
    (e) => statusCode(e) === 401,
  );
  await assert.rejects(
    verifyNeonAuthToken('not-a-token', ENV, { jwksCache: cache }),
    (e) => statusCode(e) === 401,
  );
});

test('rejects an unknown kid after one forced refetch', async () => {
  const { pair, publicJwk } = await makeKeyPair();
  const fetchImpl = jwksFetch([publicJwk]);
  const token = await signJwt(pair, baseClaims(), { kid: 'missing-kid' });

  await assert.rejects(
    verifyNeonAuthToken(token, ENV, { jwksCache: createJwksCache({ fetchImpl }) }),
    (e) => statusCode(e) === 401,
  );
  assert.equal(fetchImpl.calls.count, 2, 'should refetch once for an unknown kid');
});

test('reports 503 when the JWKS cannot be fetched or auth is not configured', async () => {
  const { pair } = await makeKeyPair();
  const token = await signJwt(pair, baseClaims());

  await assert.rejects(
    verifyNeonAuthToken(token, ENV, { jwksCache: createJwksCache({ fetchImpl: jwksFetch([], { fail: true }) }) }),
    (e) => statusCode(e) === 503,
  );
  await assert.rejects(
    verifyNeonAuthToken(token, {}, { jwksCache: createJwksCache({ fetchImpl: jwksFetch([]) }) }),
    (e) => statusCode(e) === 503,
  );
});

// ---------------------------------------------------------------------------
// Token routing
// ---------------------------------------------------------------------------

test('peekTokenAlgorithm reads the header without verifying and is safe on junk', async () => {
  const { pair } = await makeKeyPair();
  assert.equal(peekTokenAlgorithm(await signJwt(pair, baseClaims())), 'EdDSA');
  assert.equal(peekTokenAlgorithm('a.b.c'), null);
  assert.equal(peekTokenAlgorithm(''), null);
  assert.equal(peekTokenAlgorithm(null), null);
});

test('extractBearerToken tolerates casing and rejects malformed headers', () => {
  const withHeader = (value) => new Request('https://api.example/api/state', value ? { headers: { Authorization: value } } : {});
  assert.equal(extractBearerToken(withHeader('Bearer abc.def.ghi')), 'abc.def.ghi');
  assert.equal(extractBearerToken(withHeader('bearer   tok')), 'tok');
  assert.throws(() => extractBearerToken(withHeader('')), (e) => statusCode(e) === 401);
  assert.throws(() => extractBearerToken(withHeader('Basic abc')), (e) => statusCode(e) === 401);
});

test('requireAuth reports 503 for an EdDSA token when Neon Auth is unconfigured', async () => {
  const { pair } = await makeKeyPair();
  const token = await signJwt(pair, baseClaims());
  const request = new Request('https://api.example/api/state', { headers: { Authorization: `Bearer ${token}` } });

  // No NEON_AUTH_BASE_URL in env: the token kind is recognised, then the
  // verifier fails closed before any database access is attempted.
  await assert.rejects(requireAuth(request, {}), (e) => statusCode(e) === 503);
});

// ---------------------------------------------------------------------------
// ensureNeonUser — identity linking
// ---------------------------------------------------------------------------

/** Tiny scripted stand-in for the db façade. */
function fakeDb({ rows = [], onQuery = null } = {}) {
  const calls = [];
  return {
    calls,
    async query(text, params = []) {
      calls.push({ text, params });
      if (onQuery) {
        const result = onQuery(text, params);
        if (result) return result;
      }
      if (/FROM users WHERE neon_auth_user_id/.test(text)) {
        return rows.filter((r) => r.neon_auth_user_id === params[0]);
      }
      if (/lower\(email\)/.test(text)) {
        return rows.filter((r) => (r.email || '').toLowerCase() === params[0]);
      }
      return [];
    },
  };
}

const APP_USER = {
  id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  email: 'person@example.com',
  name: 'Test Person',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

test('ensureNeonUser returns an already-linked row without writing', async () => {
  const db = fakeDb({ rows: [{ ...APP_USER, neon_auth_user_id: baseClaims().sub }] });
  const row = await ensureNeonUser(db, baseClaims());
  assert.equal(row.id, APP_USER.id);
  assert.equal(db.calls.length, 1, 'only the lookup should run');
});

test('ensureNeonUser links an existing password account by email', async () => {
  const db = fakeDb({
    rows: [{ ...APP_USER, neon_auth_user_id: null }],
    onQuery: (text, params) =>
      /UPDATE users SET neon_auth_user_id/.test(text) ? [{ ...APP_USER, neon_auth_user_id: params[1] }] : null,
  });
  const row = await ensureNeonUser(db, baseClaims());
  assert.equal(row.id, APP_USER.id);
  const update = db.calls.find((c) => /UPDATE users SET neon_auth_user_id/.test(c.text));
  assert.deepEqual(update.params, [APP_USER.id, baseClaims().sub]);
});

test('ensureNeonUser creates a row keyed by the Neon Auth user id with a sentinel hash', async () => {
  const db = fakeDb({
    onQuery: (text, params) =>
      /INSERT INTO users/.test(text)
        ? [{ id: params[0], email: params[1], name: params[3], created_at: null, updated_at: null }]
        : null,
  });
  const row = await ensureNeonUser(db, baseClaims());
  assert.equal(row.id, baseClaims().sub);
  const insert = db.calls.find((c) => /INSERT INTO users/.test(c.text));
  assert.equal(insert.params[2], 'neon-auth$managed');
  assert.match(insert.text, /'neon'/);
});

test('ensureNeonUser fails closed without a uuid subject or a valid email', async () => {
  const db = fakeDb();
  await assert.rejects(ensureNeonUser(db, { sub: 'not-a-uuid', email: 'a@b.co' }), (e) => statusCode(e) === 401);
  await assert.rejects(ensureNeonUser(db, { sub: APP_USER.id, email: 'nope' }), (e) => statusCode(e) === 401);
  assert.equal(db.calls.length, 0);
});

test('userToApi never exposes the password hash', () => {
  const api = userToApi({ ...APP_USER, password_hash: 'pbkdf2$1$a$b' });
  assert.deepEqual(Object.keys(api).sort(), ['createdAt', 'email', 'id', 'name', 'role', 'updatedAt']);
});

// ---------------------------------------------------------------------------
// Super-admin bootstrap and suspension
// ---------------------------------------------------------------------------

test('adminEmails parses, trims and lowercases the ADMIN_EMAILS list', () => {
  assert.deepEqual(adminEmails({ ADMIN_EMAILS: ' A@B.com , ,c@d.com' }), ['a@b.com', 'c@d.com']);
  assert.deepEqual(adminEmails({}), []);
  assert.deepEqual(adminEmails({ ADMIN_EMAILS: '' }), []);
});

test('isAdminEmail matches case-insensitively and only listed addresses', () => {
  const env = { ADMIN_EMAILS: 'owner@example.com' };
  assert.equal(isAdminEmail(env, 'Owner@Example.com'), true);
  assert.equal(isAdminEmail(env, 'other@example.com'), false);
  assert.equal(isAdminEmail({}, 'owner@example.com'), false, 'no list means no admins');
});

test('promoteAdminIfListed promotes a listed user exactly once', async () => {
  const db = fakeDb({ onQuery: (text) => (/UPDATE users SET role/.test(text) ? [{ ...APP_USER, role: 'admin', status: 'active' }] : null) });
  const promoted = await promoteAdminIfListed(db, { ADMIN_EMAILS: 'person@example.com' }, { ...APP_USER, role: 'user' });
  assert.equal(promoted.role, 'admin');
  assert.equal(db.calls.filter((c) => /UPDATE users SET role/.test(c.text)).length, 1);

  // Already an admin: no write.
  const db2 = fakeDb();
  await promoteAdminIfListed(db2, { ADMIN_EMAILS: 'person@example.com' }, { ...APP_USER, role: 'admin' });
  assert.equal(db2.calls.length, 0);

  // Not listed: no write.
  const db3 = fakeDb();
  await promoteAdminIfListed(db3, { ADMIN_EMAILS: 'someone@else.com' }, { ...APP_USER, role: 'user' });
  assert.equal(db3.calls.length, 0);
});

test('assertActive rejects suspended accounts with 403 and allows active ones', () => {
  assert.doesNotThrow(() => assertActive({ status: 'active' }));
  assert.doesNotThrow(() => assertActive({ status: undefined }));
  assert.throws(() => assertActive({ status: 'suspended' }), (e) => statusCode(e) === 403 && e.code === 'account_suspended');
});
