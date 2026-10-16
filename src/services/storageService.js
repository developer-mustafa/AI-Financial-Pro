/**
 * Local persistence (LocalStorage) + schema migration.
 *
 * All storage access in the application goes through this adapter or the cloud
 * adapter — nothing else touches `localStorage`.
 *
 * LocalStorage is treated as a *cache of a small dataset*, not a database:
 *  - writes are debounced by the store,
 *  - quota failures surface as actionable errors,
 *  - malformed payloads are quarantined instead of crashing the app.
 */

import { appConfig } from '../config/appConfig.js';
import { nowISO } from '../utils/date.js';
import { normalizeState } from '../core/state.js';

export class StorageError extends Error {
  constructor(message, { code = 'storage_error', cause = null } = {}) {
    super(message);
    this.name = 'StorageError';
    this.code = code;
    this.cause = cause;
  }
}

/**
 * Ordered migrations. Each entry upgrades a payload from `from` to `from + 1`.
 * Add a new entry when `appConfig.schemaVersion` increases.
 */
const MIGRATIONS = [
  {
    from: 0,
    to: 1,
    describe: 'Initial versioned schema: adds metadata, normalises entity arrays and preferences.',
    up(raw) {
      const next = { ...raw };
      next.schemaVersion = 1;
      next.metadata = {
        createdAt: raw?.metadata?.createdAt || nowISO(),
        updatedAt: raw?.metadata?.updatedAt || nowISO(),
        seeded: Boolean(raw?.metadata?.seeded)
      };
      for (const key of ['transactions', 'categories', 'accounts', 'budgets', 'recurringRules', 'goals']) {
        if (!Array.isArray(next[key])) next[key] = [];
      }
      if (!next.preferences || typeof next.preferences !== 'object') next.preferences = {};
      return next;
    }
  }
];

/** Applies migrations until the payload matches the current schema version. */
export function migrate(raw) {
  let payload = raw;
  let version = Number.isFinite(Number(payload?.schemaVersion)) ? Number(payload.schemaVersion) : 0;
  const applied = [];
  for (const migration of MIGRATIONS) {
    if (version === migration.from) {
      payload = migration.up(payload);
      applied.push(`${migration.from}→${migration.to}`);
      version = migration.to;
    }
  }
  if (version > appConfig.schemaVersion) {
    throw new StorageError('This data was created by a newer version of SpendWise.', { code: 'schema_too_new' });
  }
  return { state: normalizeState(payload), applied };
}

function isQuotaError(error) {
  if (!error) return false;
  return (
    error.name === 'QuotaExceededError' ||
    error.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    error.code === 22 ||
    error.code === 1014
  );
}

/** Adapter consumed by `Store`. */
export function createLocalStorageAdapter({ key = appConfig.storage.state, storage = globalThis.localStorage } = {}) {
  const available = (() => {
    try {
      const probe = '__spendwise_probe__';
      storage.setItem(probe, '1');
      storage.removeItem(probe);
      return true;
    } catch {
      return false;
    }
  })();

  return {
    kind: 'local',
    available,

    /** @returns {Promise<object|null>} */
    async load() {
      if (!available) return null;
      let raw = null;
      try {
        raw = storage.getItem(key);
      } catch (error) {
        throw new StorageError('The browser blocked access to local storage.', { code: 'storage_blocked', cause: error });
      }
      if (!raw) return null;
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        // Quarantine the corrupt payload so the user can still recover it later.
        try {
          storage.setItem(`${key}.corrupt.${Date.now()}`, raw);
        } catch {
          /* ignore secondary failure */
        }
        throw new StorageError('Stored data was corrupted and has been set aside. Starting with an empty dataset.', {
          code: 'storage_corrupt',
          cause: error
        });
      }
      const { state } = migrate(parsed);
      return state;
    },

    /**
     * @param {object} state full application state
     */
    async save(state) {
      if (!available) throw new StorageError('Local storage is unavailable in this browser context.', { code: 'storage_unavailable' });
      try {
        storage.setItem(key, JSON.stringify(state));
      } catch (error) {
        if (isQuotaError(error)) {
          throw new StorageError(
            'Local storage is full. Export a backup and remove old transactions, or sign in to store data in the cloud.',
            { code: 'quota_exceeded', cause: error }
          );
        }
        throw new StorageError('The data could not be saved to this browser.', { code: 'storage_write_failed', cause: error });
      }
    },

    async clear() {
      if (!available) return;
      storage.removeItem(key);
    },

    /** Approximate size of the stored payload. */
    usage() {
      try {
        const raw = storage.getItem(key) || '';
        const approximateLimit = 5 * 1024 * 1024;
        return { bytes: raw.length, limit: approximateLimit, percent: Math.min(100, (raw.length / approximateLimit) * 100) };
      } catch {
        return { bytes: 0, limit: 0, percent: 0 };
      }
    },

    /** Lists quarantined corrupt payloads so Settings can offer recovery. */
    corruptKeys() {
      const keys = [];
      try {
        for (let i = 0; i < storage.length; i += 1) {
          const candidate = storage.key(i);
          if (candidate && candidate.startsWith(`${key}.corrupt.`)) keys.push(candidate);
        }
      } catch {
        /* ignore */
      }
      return keys.sort().reverse();
    },

    readRaw(key) {
      try {
        return storage.getItem(key);
      } catch {
        return null;
      }
    }
  };
}

/**
 * Small key/value helper for UI-only state (theme, acknowledged alerts,
 * sidebar state…). Deliberately separate from the finance dataset.
 */
export function createUiPreferences({ key = appConfig.storage.uiPrefs, storage = globalThis.localStorage } = {}) {
  const read = () => {
    try {
      const raw = storage.getItem(key);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  };
  return {
    get(name, fallback = null) {
      const data = read();
      return Object.prototype.hasOwnProperty.call(data, name) ? data[name] : fallback;
    },
    all() {
      return read();
    },
    set(name, value) {
      const data = read();
      data[name] = value;
      try {
        storage.setItem(key, JSON.stringify(data));
      } catch {
        /* UI preferences are non-critical */
      }
      return value;
    },
    remove(name) {
      const data = read();
      delete data[name];
      try {
        storage.setItem(key, JSON.stringify(data));
      } catch {
        /* ignore */
      }
    },
    clear() {
      try {
        storage.removeItem(key);
      } catch {
        /* ignore */
      }
    }
  };
}

/** Snapshot of the current dataset, saved before a destructive restore. */
export function snapshotLocalState(state, { storage = globalThis.localStorage, max = appConfig.limits.maxBackups } = {}) {
  const key = `${appConfig.storage.backupPrefix}.${Date.now()}`;
  try {
    storage.setItem(key, JSON.stringify(state));
    const keys = [];
    for (let i = 0; i < storage.length; i += 1) {
      const candidate = storage.key(i);
      if (candidate?.startsWith(`${appConfig.storage.backupPrefix}.`)) keys.push(candidate);
    }
    keys.sort().reverse().slice(max).forEach((stale) => storage.removeItem(stale));
    return key;
  } catch {
    return null;
  }
}

export function listSnapshots({ storage = globalThis.localStorage } = {}) {
  const out = [];
  try {
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (!key?.startsWith(`${appConfig.storage.backupPrefix}.`)) continue;
      const stamp = Number(key.split('.').pop());
      out.push({
        key,
        createdAt: Number.isFinite(stamp) ? new Date(stamp).toISOString() : null,
        bytes: (storage.getItem(key) || '').length
      });
    }
  } catch {
    /* ignore */
  }
  return out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}
