// test/migrationStatus.test.mjs
// Pure tests for the read-only migration status helper. No DB / driver needed.

import test from 'node:test';
import assert from 'node:assert/strict';

import { computeMigrationStatus } from '../src/migrationStatus.js';

const FILES = ['0004_tenants.sql', '0001_init.sql', '0003_admin.sql', '0002_neon_auth.sql'];

test('all files pending when nothing has been applied', () => {
  const s = computeMigrationStatus(FILES, []);
  assert.deepEqual(s.applied, []);
  assert.deepEqual(s.pending, ['0001_init.sql', '0002_neon_auth.sql', '0003_admin.sql', '0004_tenants.sql']);
  assert.deepEqual(s.unknown, []);
});

test('applied files are removed from pending and returned sorted', () => {
  const s = computeMigrationStatus(FILES, ['0001_init.sql', '0003_admin.sql']);
  assert.deepEqual(s.applied, ['0001_init.sql', '0003_admin.sql']);
  assert.deepEqual(s.pending, ['0002_neon_auth.sql', '0004_tenants.sql']);
  assert.deepEqual(s.unknown, []);
});

test('fully applied means no pending work', () => {
  const s = computeMigrationStatus(FILES, FILES);
  assert.deepEqual(s.pending, []);
  assert.equal(s.applied.length, 4);
});

test('a recorded version with no file on disk is reported as drift', () => {
  const s = computeMigrationStatus(FILES, ['0001_init.sql', '0009_removed.sql']);
  assert.deepEqual(s.unknown, ['0009_removed.sql']);
  assert.deepEqual(s.pending, ['0002_neon_auth.sql', '0003_admin.sql', '0004_tenants.sql']);
});

test('input order does not matter and non-sql files are ignored', () => {
  const s = computeMigrationStatus(['b.sql', 'a.sql', 'notes.txt', 'README.md'], []);
  assert.deepEqual(s.pending, ['a.sql', 'b.sql']);
});

test('empty / malformed input is handled safely', () => {
  assert.deepEqual(computeMigrationStatus([], []), { applied: [], pending: [], unknown: [] });
  assert.deepEqual(computeMigrationStatus(null, null), { applied: [], pending: [], unknown: [] });
  assert.deepEqual(
    computeMigrationStatus([null, 42, 'x.sql'], undefined),
    { applied: [], pending: ['x.sql'], unknown: [] },
  );
});
