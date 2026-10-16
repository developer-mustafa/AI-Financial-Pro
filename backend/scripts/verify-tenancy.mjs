#!/usr/bin/env node
// scripts/verify-tenancy.mjs
// Post-migration verifier for the multi-tenant model (migration 0004_tenants).
//
// It is READ-ONLY: it never writes, updates or deletes anything. It runs a set
// of invariant checks and prints a report, exiting non-zero when any check
// fails — so it is safe to run in CI and immediately after a migration.
//
// Usage:
//   node scripts/verify-tenancy.mjs
//   npm run verify:tenancy
//
// Reads DATABASE_URL from process.env, falling back to backend/.dev.vars and
// backend/.env (the same tiny parser the migration runner uses). The connection
// string is never printed with its password.

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { neon } from '@neondatabase/serverless';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_DIR = path.resolve(__dirname, '..');

function parseEnvFile(content) {
  const out = {};
  for (let line of content.split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice(7).trim();
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

async function loadEnvFiles() {
  const merged = {};
  for (const name of ['.env', '.dev.vars']) {
    const file = path.join(BACKEND_DIR, name);
    if (existsSync(file)) {
      try {
        Object.assign(merged, parseEnvFile(await readFile(file, 'utf8')));
      } catch {
        /* ignore */
      }
    }
  }
  return merged;
}

function redact(connectionString) {
  try {
    const u = new URL(connectionString);
    if (u.username) u.username = '****';
    u.password = '****';
    return u.toString();
  } catch {
    return '<connection string present but unparseable>';
  }
}

// Each check returns { label, count, detail }. `count` MUST be 0 to pass.
const FINANCE_TABLES = ['accounts', 'categories', 'transactions', 'budgets', 'recurring_rules', 'goals'];

async function runChecks(sql) {
  const checks = [];
  const scalar = async (text, params = []) => {
    const rows = await sql(text, params);
    return Number((rows && rows[0] && rows[0].n) || 0);
  };

  // 0. Objects exist at all.
  const present = await sql(`
    SELECT
      to_regclass('public.tenants') IS NOT NULL        AS tenants,
      to_regclass('public.tenant_members') IS NOT NULL AS tenant_members,
      to_regclass('public.audit_logs') IS NOT NULL     AS audit_logs
  `);
  const p = present[0];
  if (!p.tenants || !p.tenant_members || !p.audit_logs) {
    checks.push({
      label: 'migration 0004 objects are present',
      count: 1,
      detail: `tenants=${p.tenants} tenant_members=${p.tenant_members} audit_logs=${p.audit_logs}`,
    });
    return checks; // everything below would error; report and stop.
  }
  checks.push({ label: 'migration 0004 objects are present', count: 0, detail: '' });

  // 1. Every user has exactly one personal workspace.
  const usersWithoutPersonal = await scalar(`
    SELECT count(*)::int AS n FROM users u
     WHERE NOT EXISTS (SELECT 1 FROM tenants t WHERE t.personal_owner_user_id = u.id)
  `);
  checks.push({ label: 'every user has a personal workspace', count: usersWithoutPersonal, detail: `${usersWithoutPersonal} user(s) without one` });

  // 2. No user has more than one personal workspace (defensive; the partial
  //    unique index already guarantees this).
  const duplicatePersonal = await scalar(`
    SELECT count(*)::int AS n FROM (
      SELECT personal_owner_user_id FROM tenants
       WHERE personal_owner_user_id IS NOT NULL
       GROUP BY personal_owner_user_id HAVING count(*) > 1
    ) d
  `);
  checks.push({ label: 'no user has duplicate personal workspaces', count: duplicatePersonal, detail: `${duplicatePersonal} duplicated owner(s)` });

  // 3. Personal-workspace owners are TENANT_ADMIN members of their workspace.
  const ownerNotAdmin = await scalar(`
    SELECT count(*)::int AS n FROM tenants t
     WHERE t.personal_owner_user_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM tenant_members m
          WHERE m.tenant_id = t.id
            AND m.user_id = t.personal_owner_user_id
            AND m.role = 'TENANT_ADMIN'
            AND m.status = 'active'
       )
  `);
  checks.push({ label: 'personal owners are active TENANT_ADMINs', count: ownerNotAdmin, detail: `${ownerNotAdmin} workspace(s) missing their owner admin` });

  // 4. Every finance row is tenant-owned (no NULL tenant_id).
  for (const table of FINANCE_TABLES) {
    const n = await scalar(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id IS NULL`);
    checks.push({ label: `${table}.tenant_id is populated`, count: n, detail: `${n} row(s) with NULL tenant_id` });
  }

  // 5. Every finance row's tenant actually exists.
  for (const table of FINANCE_TABLES) {
    const n = await scalar(
      `SELECT count(*)::int AS n FROM ${table} r
        WHERE r.tenant_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM tenants t WHERE t.id = r.tenant_id)`,
    );
    checks.push({ label: `${table}.tenant_id references an existing workspace`, count: n, detail: `${n} dangling reference(s)` });
  }

  // 6. The author of every finance row is a member of that row's workspace.
  //    (This is the core isolation invariant: no row is attributed to a user
  //    who cannot see its tenant.)
  for (const table of FINANCE_TABLES) {
    const n = await scalar(
      `SELECT count(*)::int AS n FROM ${table} r
        WHERE NOT EXISTS (
          SELECT 1 FROM tenant_members m
           WHERE m.tenant_id = r.tenant_id AND m.user_id = r.user_id
        )`,
    );
    checks.push({ label: `${table}: author belongs to the row's workspace`, count: n, detail: `${n} row(s) whose author is not a member` });
  }

  // 7. No orphan memberships.
  const orphanMembers = await scalar(`
    SELECT count(*)::int AS n FROM tenant_members m
     WHERE NOT EXISTS (SELECT 1 FROM tenants t WHERE t.id = m.tenant_id)
        OR NOT EXISTS (SELECT 1 FROM users u WHERE u.id = m.user_id)
  `);
  checks.push({ label: 'no orphan tenant memberships', count: orphanMembers, detail: `${orphanMembers} orphan(s)` });

  // 8. Every workspace has at least one active TENANT_ADMIN.
  const adminlessTenants = await scalar(`
    SELECT count(*)::int AS n FROM tenants t
     WHERE NOT EXISTS (
       SELECT 1 FROM tenant_members m
        WHERE m.tenant_id = t.id AND m.role = 'TENANT_ADMIN' AND m.status = 'active'
     )
  `);
  checks.push({ label: 'every workspace has an active administrator', count: adminlessTenants, detail: `${adminlessTenants} workspace(s) without one` });

  return checks;
}

async function main() {
  const fileEnv = await loadEnvFiles();
  const databaseUrl = process.env.DATABASE_URL || fileEnv.DATABASE_URL;
  if (!databaseUrl) {
    console.error('[verify-tenancy] DATABASE_URL is not set (environment, backend/.dev.vars or backend/.env).');
    process.exitCode = 1;
    return;
  }

  console.log(`[verify-tenancy] target: ${redact(databaseUrl)}`);
  const sql = neon(databaseUrl, { arrayMode: false, fullResults: false });

  let checks;
  try {
    checks = await runChecks(sql);
  } catch (e) {
    console.error(`[verify-tenancy] FAILED to run checks: ${(e && e.message) || e}`);
    process.exitCode = 1;
    return;
  }

  let failed = 0;
  console.log('');
  console.log('[verify-tenancy] results');
  for (const check of checks) {
    const ok = check.count === 0;
    if (!ok) failed += 1;
    console.log(`  ${ok ? '✓' : '✗'} ${check.label}${ok ? '' : ` — ${check.detail}`}`);
  }

  console.log('');
  if (failed === 0) {
    console.log(`[verify-tenancy] OK — ${checks.length} check(s) passed.`);
  } else {
    console.log(`[verify-tenancy] ${failed} of ${checks.length} check(s) FAILED — investigate before serving traffic.`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(`[verify-tenancy] unexpected error: ${(e && e.stack) || e}`);
  process.exitCode = 1;
});
