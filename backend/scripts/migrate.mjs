#!/usr/bin/env node
// scripts/migrate.mjs
// Plain Node 22 migration runner for the SpendWise schema.
//
// - Reads DATABASE_URL from process.env, falling back to backend/.dev.vars
//   and backend/.env (tiny hand-rolled parser; no dotenv dependency).
// - Applies every backend/migrations/*.sql in filename order that has not yet
//   been recorded in schema_migrations.
// - Wraps each file's statements in a single transaction and records the
//   version in the same transaction.
// - Supports --dry-run and never prints the connection string (password is
//   redacted in all output).
//
// Usage:
//   npm run migrate
//   npm run migrate -- --dry-run
//   node scripts/migrate.mjs --help

import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { neon } from '@neondatabase/serverless';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_DIR = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = path.join(BACKEND_DIR, 'migrations');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const HELP = args.includes('--help') || args.includes('-h');

// ---------------------------------------------------------------------------
// Tiny .env / .dev.vars parser
// ---------------------------------------------------------------------------
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
        console.warn(`[migrate] could not read ${name}: ${e.message}`);
      }
    }
  }
  return merged;
}

function redact(connectionString) {
  try {
    const u = new URL(connectionString);
    if (u.username) u.username = u.username ? '****' : '';
    u.password = '****';
    return u.toString();
  } catch {
    return '<connection string present but unparseable>';
  }
}

// ---------------------------------------------------------------------------
// SQL statement splitter (handles quotes, dollar-quotes and comments)
// ---------------------------------------------------------------------------
function splitStatements(sql) {
  const out = [];
  let current = '';
  let i = 0;
  const n = sql.length;
  let state = 'normal'; // normal | single | double | line | block | dollar
  let dollarTag = '';

  const isOnlyComment = (s) => {
    const stripped = s
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/--[^\n]*/g, '')
      .trim();
    return stripped.length === 0;
  };

  while (i < n) {
    const ch = sql[i];

    if (state === 'normal') {
      if (ch === "'") { state = 'single'; current += ch; i += 1; continue; }
      if (ch === '"') { state = 'double'; current += ch; i += 1; continue; }
      if (ch === '-' && sql[i + 1] === '-') { state = 'line'; current += ch; i += 1; continue; }
      if (ch === '/' && sql[i + 1] === '*') { state = 'block'; current += ch; i += 1; continue; }
      if (ch === '$') {
        const m = /^\$[A-Za-z_0-9]*\$/.exec(sql.slice(i));
        if (m) { dollarTag = m[0]; state = 'dollar'; current += dollarTag; i += dollarTag.length; continue; }
      }
      if (ch === ';') {
        if (!isOnlyComment(current)) out.push(current.trim());
        current = '';
        i += 1;
        continue;
      }
      current += ch;
      i += 1;
      continue;
    }

    if (state === 'single') {
      if (ch === "'") {
        if (sql[i + 1] === "'") { current += "''"; i += 2; continue; }
        state = 'normal';
        current += ch;
        i += 1;
        continue;
      }
      current += ch;
      i += 1;
      continue;
    }

    if (state === 'double') {
      if (ch === '"') {
        if (sql[i + 1] === '"') { current += '""'; i += 2; continue; }
        state = 'normal';
        current += ch;
        i += 1;
        continue;
      }
      current += ch;
      i += 1;
      continue;
    }

    if (state === 'line') {
      current += ch;
      i += 1;
      if (ch === '\n') state = 'normal';
      continue;
    }

    if (state === 'block') {
      if (ch === '*' && sql[i + 1] === '/') { current += '*/'; i += 2; state = 'normal'; continue; }
      current += ch;
      i += 1;
      continue;
    }

    // state === 'dollar'
    if (sql.startsWith(dollarTag, i)) {
      current += dollarTag;
      i += dollarTag.length;
      state = 'normal';
      continue;
    }
    current += ch;
    i += 1;
  }

  if (!isOnlyComment(current)) out.push(current.trim());
  return out.filter((s) => s.length > 0);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  if (HELP) {
    console.log(`SpendWise migration runner

Usage:
  npm run migrate               apply pending migrations
  npm run migrate -- --dry-run  show what would run, change nothing
  node scripts/migrate.mjs --help

Reads DATABASE_URL from process.env, or from backend/.dev.vars / backend/.env.`);
    return;
  }

  const fileEnv = await loadEnvFiles();
  const databaseUrl = process.env.DATABASE_URL || fileEnv.DATABASE_URL;

  if (!databaseUrl) {
    console.error(
      '[migrate] DATABASE_URL is not set. Set it in the environment or in ' +
        'backend/.dev.vars (see .dev.vars.example).',
    );
    process.exitCode = 1;
    return;
  }

  console.log(`[migrate] target: ${redact(databaseUrl)}`);
  console.log(`[migrate] migrations dir: ${MIGRATIONS_DIR}`);
  if (DRY_RUN) console.log('[migrate] DRY RUN — no changes will be made');

  let files;
  try {
    files = (await readdir(MIGRATIONS_DIR))
      .filter((f) => f.toLowerCase().endsWith('.sql'))
      .sort();
  } catch (e) {
    console.error(`[migrate] cannot read migrations directory: ${e.message}`);
    process.exitCode = 1;
    return;
  }

  if (files.length === 0) {
    console.log('[migrate] no .sql files found — nothing to do');
    return;
  }

  const sql = neon(databaseUrl, { arrayMode: false, fullResults: false });

  try {
    if (!DRY_RUN) {
      await sql(
        `CREATE TABLE IF NOT EXISTS schema_migrations (
           version    text PRIMARY KEY,
           applied_at timestamptz NOT NULL DEFAULT now()
         )`,
      );
    }

    let appliedVersions = new Set();
    if (!DRY_RUN) {
      const rows = await sql('SELECT version FROM schema_migrations ORDER BY version');
      appliedVersions = new Set(rows.map((r) => r.version));
    }

    const applied = [];
    const skipped = [];
    let failedVersion = null;

    for (const file of files) {
      const version = file;
      if (appliedVersions.has(version)) {
        skipped.push(version);
        continue;
      }

      const fullPath = path.join(MIGRATIONS_DIR, file);
      const text = await readFile(fullPath, 'utf8');
      const statements = splitStatements(text);

      if (statements.length === 0) {
        console.log(`[migrate] ${version}: no executable statements (skipped)`);
        skipped.push(version);
        continue;
      }

      if (DRY_RUN) {
        console.log(`[migrate] would apply ${version} (${statements.length} statement(s))`);
        applied.push(version);
        continue;
      }

      console.log(`[migrate] applying ${version} (${statements.length} statement(s)) ...`);
      const queries = statements.map((s) => sql(s));
      queries.push(sql('INSERT INTO schema_migrations (version) VALUES ($1)', [version]));

      try {
        await sql.transaction(queries);
        applied.push(version);
        console.log(`[migrate]   ✓ ${version} applied`);
      } catch (e) {
        failedVersion = version;
        console.error(`[migrate]   ✗ ${version} FAILED`);
        console.error(`[migrate]   reason: ${(e && e.message) || e}`);
        if (e && e.code) console.error(`[migrate]   code: ${e.code}`);
        throw e;
      }
    }

    console.log('');
    console.log('[migrate] summary');
    console.log(`  applied: ${applied.length}${applied.length ? ` -> ${applied.join(', ')}` : ''}`);
    console.log(`  skipped (already applied): ${skipped.length}${skipped.length ? ` -> ${skipped.join(', ')}` : ''}`);
    if (DRY_RUN) console.log('  (dry run: nothing was written)');

    if (failedVersion) {
      process.exitCode = 1;
    }
  } catch (e) {
    console.error('');
    console.error(`[migrate] migration failed: ${(e && e.message) || e}`);
    console.error('[migrate] The failing file was rolled back (each file runs in a transaction).');
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(`[migrate] unexpected error: ${(e && e.stack) || e}`);
  process.exitCode = 1;
});
