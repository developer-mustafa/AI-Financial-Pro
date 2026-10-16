#!/usr/bin/env node
// scripts/migrate-status.mjs
// READ-ONLY migration status report.
//
// It never writes: it only reads schema_migrations (if present) and the
// migrations/ directory, then prints which files are applied and which are
// pending. Use it BEFORE `npm run migrate` to answer "what would run?" for real
// (the runner's --dry-run deliberately does not read the ledger).
//
// Usage:
//   npm run migrate:status
//
// Reads DATABASE_URL from the environment, falling back to backend/.dev.vars and
// backend/.env (same tiny parser as scripts/migrate.mjs). The password is never
// printed.

import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { neon } from '@neondatabase/serverless';
import { computeMigrationStatus } from '../src/migrationStatus.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_DIR = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = path.join(BACKEND_DIR, 'migrations');

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
      } catch (e) {
        console.warn(`[migrate:status] could not read ${name}: ${e.message}`);
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

async function main() {
  const fileEnv = await loadEnvFiles();
  const databaseUrl = process.env.DATABASE_URL || fileEnv.DATABASE_URL;
  if (!databaseUrl) {
    console.error('[migrate:status] DATABASE_URL is not set (environment, backend/.dev.vars or backend/.env).');
    process.exitCode = 1;
    return;
  }

  let files;
  try {
    files = await readdir(MIGRATIONS_DIR);
  } catch (e) {
    console.error(`[migrate:status] cannot read migrations directory: ${e.message}`);
    process.exitCode = 1;
    return;
  }

  console.log(`[migrate:status] target: ${redact(databaseUrl)}`);
  const sql = neon(databaseUrl, { arrayMode: false, fullResults: false });

  let applied = [];
  let ledgerExists = true;
  try {
    const rows = await sql('SELECT version FROM schema_migrations ORDER BY version');
    applied = rows.map((r) => r.version);
  } catch (e) {
    // Postgres 42P01 = undefined_table: the ledger is created on the first
    // real migration, so a missing table simply means "nothing applied yet".
    if (e && (e.code === '42P01' || /schema_migrations/.test(String(e.message)))) {
      ledgerExists = false;
    } else {
      console.error(`[migrate:status] FAILED to read schema_migrations: ${(e && e.message) || e}`);
      process.exitCode = 1;
      return;
    }
  }

  const { applied: appliedList, pending, unknown } = computeMigrationStatus(files, applied);

  console.log(`[migrate:status] ledger: ${ledgerExists ? 'present' : 'absent (nothing applied yet)'}`);
  console.log('');
  console.log(`  applied (${appliedList.length})${appliedList.length ? ` -> ${appliedList.join(', ')}` : ''}`);
  console.log(`  pending (${pending.length})${pending.length ? ` -> ${pending.join(', ')}` : ''}`);
  if (unknown.length) {
    console.log(`  ⚠ recorded but missing on disk (${unknown.length}) -> ${unknown.join(', ')}`);
  }
  console.log('');
  if (pending.length === 0) {
    console.log('[migrate:status] OK — the database is up to date with migrations/.');
  } else {
    console.log(`[migrate:status] ${pending.length} migration(s) pending. Review, then apply with: npm run migrate`);
  }
}

main().catch((e) => {
  console.error(`[migrate:status] unexpected error: ${(e && e.stack) || e}`);
  process.exitCode = 1;
});
