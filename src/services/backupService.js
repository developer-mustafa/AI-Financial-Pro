/**
 * Full-dataset JSON backup + safe restore.
 *
 * A backup is a versioned envelope so a future schema can be migrated on
 * import. Restoring ALWAYS snapshots the current dataset to localStorage first,
 * and the UI requires an explicit confirmation before anything is replaced.
 */

import { appConfig } from '../config/appConfig.js';
import { nowISO } from '../utils/date.js';
import { downloadJson } from './exportService.js';
import { snapshotLocalState } from './storageService.js';
import { countState } from './exportService.js';

export const BACKUP_FORMAT = 'spendwise-backup';

/** The subset of state that belongs in a backup. */
export function backupPayload(state) {
  return {
    transactions: state.transactions,
    categories: state.categories,
    accounts: state.accounts,
    budgets: state.budgets,
    recurringRules: state.recurringRules,
    goals: state.goals,
    preferences: state.preferences
  };
}

export function buildBackup(state, { note = '' } = {}) {
  return {
    format: BACKUP_FORMAT,
    app: appConfig.appName,
    appVersion: appConfig.version,
    schemaVersion: state.schemaVersion ?? appConfig.schemaVersion,
    exportedAt: nowISO(),
    note: String(note).slice(0, 200),
    counts: countState(state),
    data: backupPayload(state)
  };
}

export function serializeBackup(state, options) {
  return JSON.stringify(buildBackup(state, options), null, 2);
}

/** Downloads a `.json` backup. @returns {{name:string, bytes:number}} */
export function downloadBackup(state, options) {
  return downloadJson('spendwise-backup', buildBackup(state, options));
}

/**
 * Replaces the dataset with a validated backup.
 * @param {object} store application store
 * @param {object} state already-migrated state from importService.parseBackupJson
 * @returns {{snapshotKey:string|null, before:object, after:object}}
 */
export function restoreState(store, state) {
  const before = countState(store.get());
  const snapshotKey = snapshotLocalState(store.get());
  store.replaceState(state, 'restore-backup');
  return { snapshotKey, before, after: countState(store.get()) };
}

/** Human-readable summary of a backup envelope (used in the restore dialog). */
export function summarizeBackup(envelope, { locale = 'en-US' } = {}) {
  const counts = envelope?.counts || countState(envelope?.data || {});
  return {
    exportedAt: envelope?.exportedAt || null,
    appVersion: envelope?.appVersion || '—',
    schemaVersion: envelope?.schemaVersion ?? 0,
    counts,
    label: `${counts.transactions} transactions · ${counts.accounts} accounts · ${counts.categories} categories`
  };
}

export const backupFilenameHint = () => `spendwise-backup-${nowISO().slice(0, 10)}.json`;
