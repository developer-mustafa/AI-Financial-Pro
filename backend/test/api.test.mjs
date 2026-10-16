// test/api.test.mjs
// Plain `node --test` suite for the pure server-side logic.
//
// These tests intentionally import ONLY src/validate.js, src/auth.js and
// src/http.js. They never import src/db.js, so @neondatabase/serverless is not
// loaded and no Cloudflare runtime / database connection is required.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  hashPassword,
  verifyPassword,
  createToken,
  verifyToken,
  normalizeEmail,
  isValidEmail,
  assertPassword,
} from '../src/auth.js';

import {
  validateRecord,
  validateState,
  validatePreferences,
  resolveSort,
  rowToApi,
  buildInsert,
  buildUpsert,
  buildUpdate,
  isResource,
  getSpec,
  MAX_MINOR,
} from '../src/validate.js';

import {
  HttpError,
  json,
  error,
  parseJson,
  corsHeaders,
  allowedOrigin,
  securityHeaders,
  withHeaders,
  rateLimit,
  requestIdOf,
  newRequestId,
  resolveRequestId,
  rateLimitHeaders,
} from '../src/http.js';

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------

const ENV = { AUTH_SECRET: 'test-secret-that-is-definitely-long-enough-1234567890' };

function isHttpErrorWith(status, code) {
  return (e) => {
    assert.ok(e instanceof HttpError, `expected HttpError, got ${e && e.constructor && e.constructor.name}`);
    assert.equal(e.status, status);
    if (code) assert.equal(e.code, code);
    return true;
  };
}

function validTransaction(overrides = {}) {
  return {
    id: 'tx-1',
    type: 'expense',
    amountMinor: 1234,
    currency: 'BDT',
    categoryId: 'cat-food',
    accountId: 'acc-1',
    date: '2024-03-15',
    description: 'Lunch',
    payee: 'Cafe',
    paymentMethod: 'cash',
    tags: ['food', 'lunch'],
    notes: '',
    status: 'posted',
    ...overrides,
  };
}

// ===========================================================================
// auth.js
// ===========================================================================

test('password hash/verify round-trip succeeds', async () => {
  const hash = await hashPassword('correct horse battery staple');
  assert.match(hash, /^pbkdf2\$150000\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
  assert.equal(await verifyPassword('correct horse battery staple', hash), true);
});

test('password verify rejects the wrong password', async () => {
  const hash = await hashPassword('correct horse battery staple');
  assert.equal(await verifyPassword('wrong password', hash), false);
});

test('password verify fails closed on malformed stored hashes', async () => {
  assert.equal(await verifyPassword('x', 'not-a-hash'), false);
  assert.equal(await verifyPassword('x', 'bcrypt$1$2$3'), false);
  assert.equal(await verifyPassword('x', 'pbkdf2$0$AAAA$AAAA'), false);
  assert.equal(await verifyPassword('x', ''), false);
  assert.equal(await verifyPassword('x', undefined), false);
});

test('password policy rejects short, long, and whitespace-only passwords', () => {
  assert.throws(() => assertPassword('short'), isHttpErrorWith(400));
  assert.throws(() => assertPassword('        '), isHttpErrorWith(400));
  assert.throws(() => assertPassword('   \t  '), isHttpErrorWith(400));
  assert.throws(() => assertPassword('x'.repeat(201)), isHttpErrorWith(400));
  assert.throws(() => assertPassword(12345678), isHttpErrorWith(400));
  assert.doesNotThrow(() => assertPassword('12345678'));
});

test('email normalization and validation', () => {
  assert.equal(normalizeEmail('  USER@Example.COM '), 'user@example.com');
  assert.equal(isValidEmail('user@example.com'), true);
  assert.equal(isValidEmail('a.b+c@sub.example.co.uk'), true);
  assert.equal(isValidEmail('no-at-sign'), false);
  assert.equal(isValidEmail('two@@example.com'), false);
  assert.equal(isValidEmail('no@tld'), false);
  assert.equal(isValidEmail('spaces in@example.com'), false);
  assert.equal(isValidEmail(''), false);
});

test('token create/verify round-trip preserves subject and sets 7-day expiry', async () => {
  const token = await createToken({ sub: 'user-123' }, ENV);
  const parts = token.split('.');
  assert.equal(parts.length, 3);
  const payload = await verifyToken(token, ENV);
  assert.equal(payload.sub, 'user-123');
  assert.equal(typeof payload.jti, 'string');
  assert.ok(payload.jti.length > 0);
  const ttl = payload.exp - payload.iat;
  assert.equal(ttl, 7 * 24 * 60 * 60);
});

test('token verification rejects a tampered payload', async () => {
  const token = await createToken({ sub: 'user-123' }, ENV);
  const [h, p, s] = token.split('.');
  const decoded = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
  decoded.sub = 'attacker';
  const tamperedPayload = Buffer.from(JSON.stringify(decoded)).toString('base64url');
  const forged = `${h}.${tamperedPayload}.${s}`;
  await assert.rejects(() => verifyToken(forged, ENV), isHttpErrorWith(401, 'unauthorized'));
});

test('token verification rejects a tampered signature', async () => {
  const token = await createToken({ sub: 'user-123' }, ENV);
  const forged = `${token.slice(0, -2)}xx`;
  await assert.rejects(() => verifyToken(forged, ENV), isHttpErrorWith(401, 'unauthorized'));
});

test('token verification rejects malformed tokens', async () => {
  await assert.rejects(() => verifyToken('only.two', ENV), isHttpErrorWith(401));
  await assert.rejects(() => verifyToken('', ENV), isHttpErrorWith(401));
  await assert.rejects(() => verifyToken(null, ENV), isHttpErrorWith(401));
});

test('token verification rejects an expired token', async () => {
  // Issued 10 days ago with a 1-second lifetime.
  const tenDaysAgo = Date.now() - 10 * 24 * 60 * 60 * 1000;
  const token = await createToken({ sub: 'user-123' }, ENV, { now: tenDaysAgo, ttlSeconds: 1 });
  await assert.rejects(() => verifyToken(token, ENV), isHttpErrorWith(401));
});

test('tokens fail closed when AUTH_SECRET is missing or too short', async () => {
  await assert.rejects(() => createToken({ sub: 'u' }, {}), isHttpErrorWith(500, 'server_misconfigured'));
  await assert.rejects(
    () => createToken({ sub: 'u' }, { AUTH_SECRET: 'too-short' }),
    isHttpErrorWith(500, 'server_misconfigured'),
  );
  await assert.rejects(() => verifyToken('a.b.c', { AUTH_SECRET: 'short' }), isHttpErrorWith(500));
});

// ===========================================================================
// validate.js — amounts
// ===========================================================================

test('valid transaction passes validation and maps to snake_case', () => {
  const row = validateRecord('transactions', validTransaction(), { mode: 'full' });
  assert.equal(row.id, 'tx-1');
  assert.equal(row.amount_minor, 1234);
  assert.equal(row.account_id, 'acc-1');
  assert.equal(row.category_id, 'cat-food');
  assert.equal(row.payment_method, 'cash');
  assert.deepEqual(row.tags, ['food', 'lunch']);
  assert.equal(row.status, 'posted');
  assert.equal(row.currency, 'BDT');
});

test('amountMinor rejects NaN, Infinity, negative, zero and floats', () => {
  const base = validTransaction();
  assert.throws(
    () => validateRecord('transactions', { ...base, amountMinor: Number.NaN }),
    isHttpErrorWith(400, 'validation_error'),
  );
  assert.throws(
    () => validateRecord('transactions', { ...base, amountMinor: Number.POSITIVE_INFINITY }),
    isHttpErrorWith(400, 'validation_error'),
  );
  assert.throws(
    () => validateRecord('transactions', { ...base, amountMinor: -5 }),
    isHttpErrorWith(400, 'validation_error'),
  );
  assert.throws(
    () => validateRecord('transactions', { ...base, amountMinor: 0 }),
    isHttpErrorWith(400, 'validation_error'),
  );
  assert.throws(
    () => validateRecord('transactions', { ...base, amountMinor: 10.5 }),
    isHttpErrorWith(400, 'validation_error'),
  );
  assert.throws(
    () => validateRecord('transactions', { ...base, amountMinor: MAX_MINOR + 1 }),
    isHttpErrorWith(400, 'validation_error'),
  );
});

test('major-unit `amount` is converted to minor units only as a fallback', () => {
  const { amountMinor, ...withoutMinor } = validTransaction();
  const row = validateRecord('transactions', { ...withoutMinor, amount: 12.34 }, { mode: 'full' });
  assert.equal(row.amount_minor, 1234);
});

test('amountMinor takes precedence over amount when both are present', () => {
  const row = validateRecord('transactions', { ...validTransaction(), amount: 99.99 }, { mode: 'full' });
  assert.equal(row.amount_minor, 1234);
});

test('major-unit `amount` rejects non-positive and non-finite values', () => {
  const { amountMinor, ...withoutMinor } = validTransaction();
  assert.throws(
    () => validateRecord('transactions', { ...withoutMinor, amount: 0 }, { mode: 'full' }),
    isHttpErrorWith(400),
  );
  assert.throws(
    () => validateRecord('transactions', { ...withoutMinor, amount: Number.NaN }, { mode: 'full' }),
    isHttpErrorWith(400),
  );
});

// ===========================================================================
// validate.js — dates
// ===========================================================================

test('date validation accepts real dates and rejects malformed ones', () => {
  const base = validTransaction();
  assert.throws(() => validateRecord('transactions', { ...base, date: '2024-2-1' }), isHttpErrorWith(400));
  assert.throws(() => validateRecord('transactions', { ...base, date: '2024/01/01' }), isHttpErrorWith(400));
  assert.throws(() => validateRecord('transactions', { ...base, date: '2024-02-30' }), isHttpErrorWith(400));
  assert.throws(() => validateRecord('transactions', { ...base, date: '2023-02-29' }), isHttpErrorWith(400));
  assert.throws(() => validateRecord('transactions', { ...base, date: 'not-a-date' }), isHttpErrorWith(400));
  assert.throws(() => validateRecord('transactions', { ...base, date: '' }), isHttpErrorWith(400));
  assert.equal(validateRecord('transactions', { ...base, date: '2024-02-29' }).date, '2024-02-29');
  assert.equal(validateRecord('transactions', { ...base, date: '2024-12-31' }).date, '2024-12-31');
});

// ===========================================================================
// validate.js — transfers and enums
// ===========================================================================

test('transfers require a distinct destination account', () => {
  const base = validTransaction();
  assert.throws(
    () => validateRecord('transactions', { ...base, type: 'transfer' }, { mode: 'full' }),
    isHttpErrorWith(400),
  );
  assert.throws(
    () => validateRecord('transactions', { ...base, type: 'transfer', toAccountId: 'acc-1' }, { mode: 'full' }),
    isHttpErrorWith(400),
  );
  const row = validateRecord(
    'transactions',
    { ...base, type: 'transfer', toAccountId: 'acc-2' },
    { mode: 'full' },
  );
  assert.equal(row.type, 'transfer');
  assert.equal(row.to_account_id, 'acc-2');
});

test('unknown enum values are rejected', () => {
  const base = validTransaction();
  assert.throws(
    () => validateRecord('transactions', { ...base, type: 'refund' }, { mode: 'full' }),
    isHttpErrorWith(400),
  );
  assert.throws(
    () => validateRecord('transactions', { ...base, status: 'archived' }, { mode: 'full' }),
    isHttpErrorWith(400),
  );
  assert.throws(
    () => validateRecord('categories', { id: 'c1', name: 'Misc', type: 'transfer' }, { mode: 'full' }),
    isHttpErrorWith(400),
  );
});

test('currency must be a 3-letter code and is uppercased', () => {
  const base = validTransaction();
  assert.throws(() => validateRecord('transactions', { ...base, currency: 'BD' }, { mode: 'full' }), isHttpErrorWith(400));
  assert.throws(() => validateRecord('transactions', { ...base, currency: '123' }, { mode: 'full' }), isHttpErrorWith(400));
  assert.equal(validateRecord('transactions', { ...base, currency: 'usd' }, { mode: 'full' }).currency, 'USD');
});

// ===========================================================================
// validate.js — arrays and string caps
// ===========================================================================

test('tags enforce item count and item length caps', () => {
  const base = validTransaction();
  assert.throws(
    () => validateRecord('transactions', { ...base, tags: Array(21).fill('x') }, { mode: 'full' }),
    isHttpErrorWith(400),
  );
  assert.throws(
    () => validateRecord('transactions', { ...base, tags: ['x'.repeat(41)] }, { mode: 'full' }),
    isHttpErrorWith(400),
  );
  assert.throws(
    () => validateRecord('transactions', { ...base, tags: [''] }, { mode: 'full' }),
    isHttpErrorWith(400),
  );
  assert.throws(
    () => validateRecord('transactions', { ...base, tags: ['ok', 5] }, { mode: 'full' }),
    isHttpErrorWith(400),
  );
  const row = validateRecord('transactions', { ...base, tags: Array(20).fill('x'.repeat(40)) }, { mode: 'full' });
  assert.equal(row.tags.length, 20);
});

test('string length caps are enforced', () => {
  const base = validTransaction();
  assert.throws(
    () => validateRecord('transactions', { ...base, description: 'x'.repeat(201) }, { mode: 'full' }),
    isHttpErrorWith(400),
  );
  assert.throws(
    () => validateRecord('transactions', { ...base, notes: 'x'.repeat(2001) }, { mode: 'full' }),
    isHttpErrorWith(400),
  );
  assert.throws(
    () => validateRecord('categories', { id: 'c1', name: 'x'.repeat(121), type: 'expense' }, { mode: 'full' }),
    isHttpErrorWith(400),
  );
  assert.throws(
    () => validateRecord('categories', { id: 'c1', name: '   ', type: 'expense' }, { mode: 'full' }),
    isHttpErrorWith(400),
  );
});

// ===========================================================================
// validate.js — whitelisting
// ===========================================================================

test('unknown fields are silently dropped (whitelist)', () => {
  const row = validateRecord(
    'transactions',
    { ...validTransaction(), evil: 'DROP TABLE users', user_id: 'someone-else', userId: 'attacker' },
    { mode: 'full' },
  );
  assert.equal('evil' in row, false);
  assert.equal('user_id' in row, false);
  assert.equal('userId' in row, false);
  assert.equal('drop' in row, false);
});

test('patch mode only includes provided fields and ignores id', () => {
  const row = validateRecord('transactions', { id: 'hacked', description: 'Updated' }, { mode: 'patch' });
  assert.deepEqual(Object.keys(row), ['description']);
  assert.equal(row.description, 'Updated');
});

test('required fields are enforced in full mode', () => {
  assert.throws(() => validateRecord('transactions', { type: 'expense' }, { mode: 'full' }), isHttpErrorWith(400));
  assert.throws(
    () => validateRecord('transactions', { ...validTransaction(), id: undefined }, { mode: 'full' }),
    isHttpErrorWith(400),
  );
});

// ===========================================================================
// validate.js — sorting / SQL builders / mapping
// ===========================================================================

test('resolveSort maps camelCase and rejects unknown identifiers', () => {
  assert.deepEqual(resolveSort('transactions', 'amountMinor', 'asc'), { col: 'amount_minor', dir: 'ASC' });
  assert.deepEqual(resolveSort('transactions', 'date', 'desc'), { col: 'date', dir: 'DESC' });
  assert.deepEqual(resolveSort('transactions', null, null), { col: 'date', dir: 'DESC' });
  assert.throws(() => resolveSort('transactions', '; DROP TABLE users', null), isHttpErrorWith(400, 'invalid_sort'));
  assert.throws(() => resolveSort('transactions', 'password_hash', null), isHttpErrorWith(400, 'invalid_sort'));
  assert.throws(() => resolveSort('transactions', 'date', 'sideways'), isHttpErrorWith(400, 'invalid_sort'));
});

test('buildInsert is parameterized and injects user_id server-side', () => {
  const row = validateRecord('transactions', validTransaction(), { mode: 'full' });
  const stmt = buildInsert('transactions', [row], 'user-uuid-1');
  assert.match(stmt.text, /INSERT INTO transactions/);
  assert.match(stmt.text, /jsonb_array_elements\(\$1::jsonb\)/);
  assert.match(stmt.text, /\buser_id\b/);
  assert.equal(stmt.params.length, 1);
  const payload = JSON.parse(stmt.params[0]);
  assert.equal(payload[0].user_id, 'user-uuid-1');
  // No literal user data is concatenated into the SQL text.
  assert.equal(stmt.text.includes('Lunch'), false);
  assert.equal(stmt.text.includes('tx-1'), false);
});

test('buildUpsert guards updates so other users rows cannot be modified', () => {
  const row = validateRecord('transactions', validTransaction(), { mode: 'full' });
  const stmt = buildUpsert('transactions', row, 'user-uuid-1');
  assert.match(stmt.text, /ON CONFLICT \(id\) DO UPDATE/);
  assert.match(stmt.text, /WHERE transactions\.user_id = EXCLUDED\.user_id/);
  assert.equal(stmt.text.includes('Lunch'), false);
});

test('SQL casts are parenthesized so `::` does not bind to the JSON key', () => {
  const txRow = validateRecord('transactions', validTransaction(), { mode: 'full' });
  const txSql = buildInsert('transactions', [txRow], 'user-uuid-1').text;
  assert.match(txSql, /\(val->>'amount_minor'\)::bigint/);
  assert.match(txSql, /\(val->>'date'\)::date/);
  assert.match(txSql, /\(val->>'user_id'\)::uuid/);
  // The buggy form `val->>'col'::type` must never appear.
  assert.equal(/->>'\w+'::/.test(txSql), false);

  const goalRow = validateRecord('goals', { id: 'g1', name: 'Trip', targetMinor: 500000 }, { mode: 'full' });
  const goalSql = buildInsert('goals', [goalRow], 'user-uuid-1').text;
  assert.match(goalSql, /COALESCE\(val->'contributions', '\[\]'::jsonb\)/);
  assert.equal(/->>'\w+'::/.test(goalSql), false);

  const budgetRow = validateRecord(
    'budgets',
    { id: 'b1', name: 'Food', period: 'monthly', limitMinor: 1000, scope: 'overall', startDate: '2024-01-01', endDate: '2024-01-31' },
    { mode: 'full' },
  );
  const budgetSql = buildInsert('budgets', [budgetRow], 'user-uuid-1').text;
  assert.match(budgetSql, /ARRAY\(SELECT \(jsonb_array_elements_text\(COALESCE\(val->'alert_thresholds'/);
  assert.equal(/->>'\w+'::/.test(budgetSql), false);
});

test('buildUpdate is scoped by id and user_id and ignores id in SET', () => {
  const row = validateRecord('transactions', { description: 'x', amountMinor: 5 }, { mode: 'patch' });
  const stmt = buildUpdate('transactions', row, 'tx-1', 'user-1');
  assert.match(stmt.text, /UPDATE transactions SET/);
  assert.match(stmt.text, /WHERE id = \$\d+ AND user_id = \$\d+/);
  assert.equal(/SET id =/.test(stmt.text), false);
  assert.equal(stmt.text.includes('tx-1'), false);
  assert.equal(buildUpdate('transactions', {}, 'tx-1', 'user-1'), null);
});

test('buildUpdate encodes array columns as jsonb (no driver array guesswork)', () => {
  const row = validateRecord('transactions', { tags: ['a', 'b'] }, { mode: 'patch' });
  const stmt = buildUpdate('transactions', row, 'tx-1', 'user-1');
  assert.match(stmt.text, /tags = ARRAY\(SELECT jsonb_array_elements_text\(\$1::jsonb\)\)/);
  assert.equal(stmt.params[0], '["a","b"]');
});

test('rowToApi converts snake_case columns to camelCase typed values', () => {
  const row = {
    id: 'tx-1',
    type: 'expense',
    amount_minor: '1234',
    currency: 'BDT',
    category_id: 'cat-1',
    account_id: 'acc-1',
    to_account_id: null,
    date: '2024-03-15',
    description: 'Lunch',
    payee: 'Cafe',
    payment_method: 'cash',
    tags: ['food'],
    notes: '',
    status: 'posted',
    recurring_rule_id: null,
    occurrence_key: null,
    receipt_ref: null,
    created_at: '2024-03-15T10:00:00.000Z',
    updated_at: '2024-03-15T11:00:00.000Z',
  };
  const api = rowToApi('transactions', row);
  assert.equal(api.amountMinor, 1234);
  assert.equal(typeof api.amountMinor, 'number');
  assert.equal(api.categoryId, 'cat-1');
  assert.equal(api.accountId, 'acc-1');
  assert.deepEqual(api.tags, ['food']);
  assert.equal(api.date, '2024-03-15');
  assert.equal(api.createdAt, '2024-03-15T10:00:00.000Z');
});

test('resource whitelist', () => {
  assert.equal(isResource('transactions'), true);
  assert.equal(isResource('recurring-rules'), true);
  assert.equal(isResource('users'), false);
  assert.equal(isResource('sql'), false);
  assert.throws(() => getSpec('users'), isHttpErrorWith(404));
});

// ===========================================================================
// validate.js — state + preferences
// ===========================================================================

test('validateState normalizes records and counts them', () => {
  const result = validateState({
    schemaVersion: 1,
    transactions: [validTransaction()],
    categories: [{ id: 'cat-food', name: 'Food', type: 'expense' }],
    accounts: [{ id: 'acc-1', name: 'Cash', type: 'cash' }],
    budgets: [],
    recurringRules: [],
    goals: [],
    preferences: { theme: 'dark' },
  });
  assert.equal(result.counts.transactions, 1);
  assert.equal(result.counts.categories, 1);
  assert.equal(result.counts.accounts, 1);
  assert.equal(result.rows['recurring-rules'].length, 0);
  assert.equal(result.preferences.theme, 'dark');
  assert.equal(result.schemaVersion, 1);
});

test('validateState rejects bad records with a path in the message', () => {
  assert.throws(
    () => validateState({ transactions: [validTransaction({ amountMinor: -1 })] }),
    (e) => e instanceof HttpError && e.status === 400 && /transactions\[0\]/.test(e.message),
  );
});

test('validatePreferences rejects non-objects and oversized blobs', () => {
  assert.throws(() => validatePreferences([]), isHttpErrorWith(400));
  assert.throws(() => validatePreferences('nope'), isHttpErrorWith(400));
  assert.throws(() => validatePreferences({ big: 'x'.repeat(200001) }), isHttpErrorWith(400));
  assert.deepEqual(validatePreferences({ a: 1 }), { a: 1 });
});

// ===========================================================================
// http.js
// ===========================================================================

test('CORS allows configured origins and omits the header otherwise', () => {
  const env = { ALLOWED_ORIGINS: 'http://localhost:5173, http://127.0.0.1:5173' };
  const allowed = corsHeaders(
    new Request('https://api.example.com/api/health', { headers: { Origin: 'http://localhost:5173' } }),
    env,
  );
  assert.equal(allowed['Access-Control-Allow-Origin'], 'http://localhost:5173');

  const denied = corsHeaders(
    new Request('https://api.example.com/api/health', { headers: { Origin: 'https://evil.example.com' } }),
    env,
  );
  assert.equal(denied['Access-Control-Allow-Origin'], undefined);

  const noOrigin = corsHeaders(new Request('https://api.example.com/api/health'), env);
  assert.equal(noOrigin['Access-Control-Allow-Origin'], undefined);
  assert.equal(noOrigin.Vary, 'Origin');
});

test('same-origin requests are always allowed', () => {
  const env = { ALLOWED_ORIGINS: '' };
  const req = new Request('https://api.example.com/api/health', {
    headers: { Origin: 'https://api.example.com' },
  });
  assert.equal(allowedOrigin(req, env), 'https://api.example.com');
});

test('rate limiter enforces a fixed window and resets', () => {
  const store = new Map();
  const t0 = 1_700_000_000_000;
  for (let i = 0; i < 120; i += 1) {
    const r = rateLimit(store, 'ip:GET', { limit: 120, windowMs: 60000, now: t0 });
    assert.equal(r.ok, true, `request ${i + 1} should be allowed`);
  }
  const blocked = rateLimit(store, 'ip:GET', { limit: 120, windowMs: 60000, now: t0 });
  assert.equal(blocked.ok, false);
  assert.ok(blocked.retryAfter >= 1 && blocked.retryAfter <= 60);

  // Next window resets the counter.
  const fresh = rateLimit(store, 'ip:GET', { limit: 120, windowMs: 60000, now: t0 + 60000 });
  assert.equal(fresh.ok, true);
  assert.equal(fresh.remaining, 119);
});

test('parseJson rejects malformed JSON with 400', async () => {
  const req = new Request('https://x.test/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{ this is not json',
  });
  await assert.rejects(() => parseJson(req), isHttpErrorWith(400, 'invalid_json'));
});

test('parseJson rejects over-cap bodies with 413', async () => {
  const req = new Request('https://x.test/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: 'x'.repeat(100),
  });
  await assert.rejects(() => parseJson(req, 10), isHttpErrorWith(413, 'payload_too_large'));
});

test('parseJson parses valid JSON and returns {} for an empty body', async () => {
  const ok = new Request('https://x.test/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hello: 'world' }),
  });
  assert.deepEqual(await parseJson(ok), { hello: 'world' });

  const empty = new Request('https://x.test/', { method: 'POST' });
  assert.deepEqual(await parseJson(empty), {});
});

test('parseJson enforces the cap while streaming (no content-length)', async () => {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(8));
      controller.enqueue(new Uint8Array(8));
      controller.enqueue(new Uint8Array(8));
      controller.close();
    },
  });
  const req = new Request('https://x.test/', { method: 'POST', body: stream, duplex: 'half' });
  await assert.rejects(() => parseJson(req, 10), isHttpErrorWith(413, 'payload_too_large'));
});

test('parseJson parses a streamed body that is within the cap', async () => {
  const payload = new TextEncoder().encode(JSON.stringify({ streamed: true }));
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(payload);
      controller.close();
    },
  });
  const req = new Request('https://x.test/', { method: 'POST', body: stream, duplex: 'half' });
  assert.deepEqual(await parseJson(req, 1024), { streamed: true });
});

test('json() and error() produce the expected envelopes', async () => {
  const okRes = json({ a: 1 }, 201);
  assert.equal(okRes.status, 201);
  assert.match(okRes.headers.get('content-type'), /application\/json/);
  assert.deepEqual(await okRes.json(), { a: 1 });

  const errRes = error('bad_request', 'Nope', 422);
  assert.equal(errRes.status, 422);
  assert.deepEqual(await errRes.json(), { error: { code: 'bad_request', message: 'Nope' } });
});

test('withHeaders merges headers without disturbing status or body', async () => {
  const res = withHeaders(json({ ok: true }, 200), { 'X-Test': 'yes' });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('X-Test'), 'yes');
  assert.deepEqual(await res.json(), { ok: true });
});

test('securityHeaders sets the required hardening headers', () => {
  const h = securityHeaders();
  assert.equal(h['X-Content-Type-Options'], 'nosniff');
  assert.equal(h['Referrer-Policy'], 'no-referrer');
  assert.equal(h['X-Frame-Options'], 'DENY');
  assert.match(h['Strict-Transport-Security'], /max-age=\d+/);
  assert.match(h['Strict-Transport-Security'], /includeSubDomains/);
});

test('resolveRequestId trusts a valid X-Request-Id and echoes it', () => {
  const req = new Request('https://api.example.com/api/health', {
    headers: { 'X-Request-Id': 'trace-12345678' },
  });
  assert.equal(requestIdOf(req), 'trace-12345678');
  assert.equal(resolveRequestId(req), 'trace-12345678');
});

test('resolveRequestId falls back to CF-Ray, then generates one', () => {
  const ray = new Request('https://api.example.com/api/health', {
    headers: { 'CF-Ray': '7f2a1c3d4e5f6789-SIN' },
  });
  assert.equal(resolveRequestId(ray), '7f2a1c3d4e5f6789-SIN');

  const bare = new Request('https://api.example.com/api/health');
  const generated = resolveRequestId(bare);
  assert.ok(generated && generated !== 'undefined');
  // A generated id is always header-safe.
  assert.match(generated, /^[A-Za-z0-9._:-]{8,128}$/);
});

test('resolveRequestId rejects forged / unsafe inbound ids', () => {
  // Values that are valid HTTP header values but not acceptable ids.
  const withSpaces = new Request('https://api.example.com/api/health', {
    headers: { 'X-Request-Id': 'not a valid request id' },
  });
  assert.equal(requestIdOf(withSpaces), null);
  assert.match(resolveRequestId(withSpaces), /^[A-Za-z0-9._:-]{8,128}$/);

  const tooShort = new Request('https://api.example.com/api/health', {
    headers: { 'X-Request-Id': 'short' },
  });
  assert.equal(requestIdOf(tooShort), null);

  const tooLong = new Request('https://api.example.com/api/health', {
    headers: { 'X-Request-Id': 'a'.repeat(129) },
  });
  assert.equal(requestIdOf(tooLong), null);
});

test('newRequestId returns distinct header-safe ids', () => {
  const a = newRequestId();
  const b = newRequestId();
  assert.notEqual(a, b);
  assert.match(a, /^[A-Za-z0-9._:-]{8,128}$/);
});

test('rateLimitHeaders maps a limiter result to standard headers', () => {
  const headers = rateLimitHeaders({ limit: 120, remaining: 7, resetAt: 1_700_000_060_000 });
  assert.equal(headers['X-RateLimit-Limit'], '120');
  assert.equal(headers['X-RateLimit-Remaining'], '7');
  assert.equal(headers['X-RateLimit-Reset'], String(Math.ceil(1_700_000_060_000 / 1000)));

  // Never emits a negative remaining.
  const clamped = rateLimitHeaders({ limit: 10, remaining: -3, resetAt: 0 });
  assert.equal(clamped['X-RateLimit-Remaining'], '0');

  // Null/empty is safe.
  assert.deepEqual(rateLimitHeaders(null), {});
  assert.deepEqual(rateLimitHeaders(undefined), {});
});
