#!/usr/bin/env node
// scripts/snapshot-data.mjs
// READ-ONLY logical snapshot of every base table in the `public` schema.
//
// It never writes to the database. It SELECTs * from each base table and writes
// a single JSON file, so there is a restore reference before a migration.
//
// Usage:
//   node scripts/snapshot-data.mjs <output-dir>
//
// Reads DATABASE_URL from the environment, then backend/.dev.vars / backend/.env.
// The password is never printed.
//
// SECURITY: the output contains real data (including users.password_hash).
// Treat it as sensitive: keep it off the repo, do not commit it, and delete it
// once the migration has been verified.

import { mkdir, writeFile, readFile } from 'node:fs/promises';
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

function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

async function main() {
  const outDirArg = process.argv.slice(2).find((a) => !a.startsWith('--'));
  const outDir = path.resolve(outDirArg || path.join(BACKEND_DIR, '..', 'backups'));

  const fileEnv = await loadEnvFiles();
  const databaseUrl = process.env.DATABASE_URL || fileEnv.DATABASE_URL;
  if (!databaseUrl) {
    console.error('[snapshot] DATABASE_URL is not set (environment, backend/.dev.vars or backend/.env).');
    process.exitCode = 1;
    return;
  }

  console.log(`[snapshot] target: ${redact(databaseUrl)}`);
  const sql = neon(databaseUrl, { arrayMode: false, fullResults: false });

  const dbRows = await sql('SELECT current_database() AS db');
  const database = dbRows[0].db;

  const tableRows = await sql(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name`,
  );
  const tables = tableRows.map((r) => r.table_name);

  const snapshot = { generatedAt: new Date().toISOString(), database, tables: {} };
  for (const table of tables) {
    const rows = await sql(`SELECT * FROM public.${quoteIdent(table)}`);
    snapshot.tables[table] = rows;
    console.log(`[snapshot]   ${table}: ${rows.length} row(s)`);
  }

  await mkdir(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outFile = path.join(outDir, `snapshot-${stamp}.json`);
  await writeFile(outFile, JSON.stringify(snapshot, null, 2), 'utf8');

  console.log('');
  console.log(`[snapshot] wrote ${outFile}`);
  console.log('[snapshot] READ-ONLY complete. Keep this file off the repo and delete it after verification.');
}

main().catch((e) => {
  console.error(`[snapshot] unexpected error: ${(e && e.stack) || e}`);
  process.exitCode = 1;
});
