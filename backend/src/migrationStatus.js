// src/migrationStatus.js
// Pure helpers for reporting migration state.
//
// Deliberately imports NOTHING (no DB driver), so it is unit-testable with plain
// `node --test`. The scripts/migrate-status.mjs CLI does the (read-only) IO and
// calls computeMigrationStatus() to diff the files on disk against the ledger.

/**
 * Compare migration files on disk with the versions recorded in
 * `schema_migrations`.
 *
 * @param {string[]} files            filenames from backend/migrations/
 * @param {Iterable<string>} applied  versions recorded in schema_migrations
 * @returns {{applied:string[], pending:string[], unknown:string[]}}
 *   - applied: files present on disk AND recorded as applied
 *   - pending: files present on disk but NOT yet recorded (safe to run)
 *   - unknown: recorded versions with NO file on disk (history drift)
 */
export function computeMigrationStatus(files, applied) {
  const onDisk = [...(files || [])]
    .filter((f) => typeof f === 'string' && f.toLowerCase().endsWith('.sql'))
    .sort();
  const onDiskSet = new Set(onDisk);
  const appliedSet = new Set(applied ? [...applied] : []);

  const appliedList = [];
  const pending = [];
  for (const file of onDisk) {
    if (appliedSet.has(file)) appliedList.push(file);
    else pending.push(file);
  }

  const unknown = [...appliedSet].filter((v) => !onDiskSet.has(v)).sort();

  return { applied: appliedList, pending, unknown };
}
