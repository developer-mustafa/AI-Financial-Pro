#!/usr/bin/env node
// scripts/preflight-tenancy.mjs
// READ-ONLY pre-migration checks for 0004_tenants.sql.
//
// It is strictly read-only: only SELECTs against catalogs and counts. Run it
// BEFORE `npm run migrate` to predict whether 0004 can apply cleanly to the
// current database, and to size the locking/backfill impact.
//
// Usage:
//   npm run preflight:tenancy
//
// Reads DATABASE_URL from the environment, then backend/.dev.vars / backend/.env
// (same tiny parser as the other scripts). The password is never printed.

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { neon } from '@neondatabase/serverless';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_DIR = path.resolve(__dirname, '..');

const FINANCE_TABLES = ['accounts', 'categories', 'transactions', 'budgets', 'recurring_rules', 'goals'];
const REQUIRED_TABLES = ['users', ...FINANCE_TABLES];
const NEW_OBJECTS = ['tenants', 'tenant_members', 'audit_logs'];

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

async function tableExists(sql, name) {
  const rows = await sql(`SELECT to_regclass('public.${name}') IS NOT NULL AS present`);
  return Boolean(rows && rows[0] && rows[0].present);
}

async function columnExists(sql, table, column) {
  const rows = await sql(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2
     ) AS present`,
    [table, column],
  );
  return Boolean(rows && rows[0] && rows[0].present);
}

async function scalar(sql, text, params = []) {
  const rows = await sql(text, params);
  return Number((rows && rows[0] && (rows[0].n ?? rows[0].count)) || 0);
}

async function main() {
  const fileEnv = await loadEnvFiles();
  const databaseUrl = process.env.DATABASE_URL || fileEnv.DATABASE_URL;
  if (!databaseUrl) {
    console.error('[preflight] DATABASE_URL is not set (environment, backend/.dev.vars or backend/.env).');
    process.exitCode = 1;
    return;
  }

  console.log(`[preflight] target: ${redact(databaseUrl)}`);
  const sql = neon(databaseUrl, { arrayMode: false, fullResults: false });

  const problems = [];
  const warnings = [];

  try {
    const ident = await sql('SELECT current_database() AS db, current_user AS usr, version() AS pg');
    console.log(`[preflight] database: ${ident[0].db} | role: ${ident[0].usr}`);
    console.log(`[preflight] engine  : ${String(ident[0].pg).split(',')[0]}`);
  } catch (e) {
    console.error(`[preflight] cannot connect: ${(e && e.message) || e}`);
    process.exitCode = 1;
    return;
  }

  // --- ledger ---------------------------------------------------------------
  let ledger = [];
  let ledgerPresent = true;
  try {
    const rows = await sql('SELECT version FROM schema_migrations ORDER BY version');
    ledger = rows.map((r) => r.version);
  } catch (e) {
    if (e && (e.code === '42P01' || /schema_migrations/.test(String(e.message)))) ledgerPresent = false;
    else throw e;
  }
  console.log('');
  console.log(`[preflight] ledger   : ${ledgerPresent ? ledger.join(', ') || '(present, empty)' : 'absent'}`);
  if (ledger.includes('0004_tenants.sql')) warnings.push('0004_tenants.sql is ALREADY recorded as applied for this database.');

  // --- required pre-existing tables ----------------------------------------
  console.log('');
  console.log('[preflight] required tables (0001 schema):');
  for (const table of REQUIRED_TABLES) {
    const present = await tableExists(sql, table);
    console.log(`  ${present ? '✓' : '✗'} ${table}`);
    if (!present) problems.push(`required table '${table}' is missing — 0004 would fail`);
  }

  // --- new objects (idempotency) -------------------------------------------
  console.log('');
  console.log('[preflight] objects added by 0004 (should be absent if not yet applied):');
  for (const obj of NEW_OBJECTS) {
    const present = await tableExists(sql, obj);
    console.log(`  ${present ? '•' : '·'} ${obj}${present ? ' (already exists — migration is idempotent)' : ' (will be created)'}`);
  }

  // --- finance tables: column + backfill readiness --------------------------
  console.log('');
  console.log('[preflight] finance tables (backfill readiness):');
  let totalRows = 0;
  for (const table of FINANCE_TABLES) {
    if (!(await tableExists(sql, table))) continue;
    const hasTenantCol = await columnExists(sql, table, 'tenant_id');
    const count = await scalar(sql, `SELECT count(*)::int AS n FROM ${table}`);
    totalRows += count;
    const nullUser = await scalar(sql, `SELECT count(*)::int AS n FROM ${table} WHERE user_id IS NULL`);
    const orphanUser = await scalar(
      sql,
      `SELECT count(*)::int AS n FROM ${table} r WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = r.user_id)`,
    );
    console.log(`  ${table}: ${count} row(s); tenant_id column: ${hasTenantCol ? 'yes' : 'no'}; null user_id: ${nullUser}; orphan user_id: ${orphanUser}`);
    if (hasTenantCol) warnings.push(`${table}.tenant_id already exists (partial previous run?)`);
    if (nullUser > 0) problems.push(`${table} has ${nullUser} row(s) with NULL user_id — backfill cannot assign them, SET NOT NULL would fail`);
    if (orphanUser > 0) problems.push(`${table} has ${orphanUser} row(s) whose user_id has no users row — SET NOT NULL would fail`);
  }

  // --- users ----------------------------------------------------------------
  if (await tableExists(sql, 'users')) {
    const users = await scalar(sql, 'SELECT count(*)::int AS n FROM users');
    const blankEmail = await scalar(sql, "SELECT count(*)::int AS n FROM users WHERE email IS NULL OR btrim(email) = ''");
    console.log('');
    console.log(`[preflight] users: ${users} row(s); blank/NULL email: ${blankEmail}`);
    if (blankEmail > 0) problems.push(`${blankEmail} user row(s) with a blank email — a personal workspace name falls back to email`);
  }

  // --- summary --------------------------------------------------------------
  console.log('');
  console.log(`[preflight] total finance rows to backfill: ${totalRows}`);
  if (problems.length) {
    console.log('');
    console.log(`[preflight] ${problems.length} BLOCKING problem(s):`);
    for (const p of problems) console.log(`  ✗ ${p}`);
  }
  if (warnings.length) {
    console.log('');
    console.log(`[preflight] ${warnings.length} warning(s):`);
    for (const w of warnings) console.log(`  ⚠ ${w}`);
  }
  console.log('');
  if (problems.length === 0) {
    console.log('[preflight] OK — no blocking issues detected. 0004 should apply cleanly.');
  } else {
    console.log('[preflight] NOT READY — resolve the blocking problems before migrating.');
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(`[preflight] unexpected error: ${(e && e.stack) || e}`);
  process.exitCode = 1;
});
