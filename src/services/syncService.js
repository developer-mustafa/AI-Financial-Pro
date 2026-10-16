/**
 * Cloud persistence adapter + sync orchestration (NeonDB via the Worker API).
 *
 * The Store has ONE persistence adapter at a time:
 *   - local  → localStorage (default, works offline, no account needed)
 *   - cloud  → the Worker API, which writes to NeonDB PostgreSQL
 *
 * Switching modes is an explicit user action (Settings → Cloud sync). Local
 * data is never deleted automatically, and a full-dataset push always requires
 * confirmation because it can overwrite cloud records.
 */

import { appConfig } from '../config/appConfig.js';
import { bus, EVENTS } from '../core/eventBus.js';
import { normalizeState } from '../core/state.js';
import { nowISO } from '../utils/date.js';

/** Frontend resource name → REST collection on the Worker. */
export const RESOURCE_PATHS = Object.freeze({
  transactions: '/api/transactions',
  categories: '/api/categories',
  accounts: '/api/accounts',
  budgets: '/api/budgets',
  recurringRules: '/api/recurring-rules',
  goals: '/api/goals',
  preferences: '/api/preferences'
});

export const SYNC_MODE = Object.freeze({ LOCAL: 'local', CLOUD: 'cloud' });

let lastStatus = { state: 'idle', message: '', lastSyncAt: null };

export function cloudStatus() {
  return { ...lastStatus };
}

function setStatus(patch) {
  lastStatus = { ...lastStatus, ...patch };
  bus.emit(EVENTS.CLOUD_STATUS, lastStatus);
}

/** Converts the store's change list into the `/api/sync` contract. */
export function toSyncChanges(changes) {
  const out = [];
  for (const change of changes) {
    if (!change || change.resource === '*') continue;
    if (change.resource === 'preferences') {
      out.push({ resource: 'preferences', op: 'upsert', record: change.record ?? undefined });
      continue;
    }
    if (!RESOURCE_PATHS[change.resource]) continue;
    if (change.op === 'delete') {
      if (change.id) out.push({ resource: change.resource, op: 'delete', id: change.id });
    } else if (change.record) {
      out.push({ resource: change.resource, op: 'upsert', record: change.record });
    }
  }
  return out.slice(0, 500);
}

/**
 * Store-compatible persistence adapter backed by the Worker API.
 */
export function createCloudAdapter({ client }) {
  return {
    kind: 'cloud',

    async load() {
      setStatus({ state: 'syncing', message: 'Loading your cloud data…' });
      try {
        const data = await client.get('/api/state', { timeout: 20000 });
        const usable = data && (Array.isArray(data.transactions) || data.metadata || data.preferences);
        setStatus({ state: 'idle', message: '', lastSyncAt: nowISO() });
        return usable ? normalizeState(data) : null;
      } catch (error) {
        setStatus({ state: 'error', message: error?.message || 'Cloud load failed.' });
        throw error;
      }
    },

    /**
     * @param {object} state
     * @param {Array<object>} changes
     */
    async save(state, changes) {
      const replaceAll = changes.some((change) => change.resource === '*');
      setStatus({ state: 'syncing', message: 'Saving…' });
      try {
        if (replaceAll) {
          await client.put('/api/state', { state }, { timeout: 30000 });
        } else {
          const payload = toSyncChanges(changes);
          if (payload.length === 0) {
            setStatus({ state: 'idle', message: '' });
            return;
          }
          const result = await client.post('/api/sync', { changes: payload }, { timeout: 30000 });
          if (Array.isArray(result?.failed) && result.failed.length > 0) {
            const first = result.failed[0];
            throw new Error(`Some records were rejected by the server (${result.failed.length}). First error: ${first?.error || 'unknown'}`);
          }
        }
        setStatus({ state: 'idle', message: '', lastSyncAt: nowISO() });
      } catch (error) {
        setStatus({ state: 'error', message: error?.message || 'Cloud save failed.' });
        throw error;
      }
    }
  };
}

/**
 * Migration/sync helpers used by Settings → Cloud sync and the sign-in flow.
 */
export function createSyncService({ client, store }) {
  return {
    /** Download the cloud dataset. */
    async pull() {
      const data = await client.get('/api/state', { timeout: 20000 });
      const usable = data && (Array.isArray(data.transactions) || data.metadata || data.preferences);
      return usable ? normalizeState(data) : null;
    },

    /** Upload the current in-memory dataset, replacing the cloud copy. */
    async push(state = store.get()) {
      setStatus({ state: 'syncing', message: 'Uploading…' });
      try {
        const result = await client.put('/api/state', { state }, { timeout: 30000 });
        setStatus({ state: 'idle', message: '', lastSyncAt: nowISO() });
        return result;
      } catch (error) {
        setStatus({ state: 'error', message: error?.message || 'Upload failed.' });
        throw error;
      }
    },

    /**
     * Non-destructive comparison so the user can decide what to do. Returns
     * counts for both sides — the app never merges silently.
     */
    async compare(localState, cloudState) {
      const count = (state) =>
        state
          ? {
              transactions: state.transactions?.length || 0,
              categories: state.categories?.length || 0,
              accounts: state.accounts?.length || 0,
              budgets: state.budgets?.length || 0,
              recurringRules: state.recurringRules?.length || 0,
              goals: state.goals?.length || 0
            }
          : null;
      const local = count(localState);
      const cloud = count(cloudState);
      const localOnly = [];
      const cloudOnly = [];
      if (local && cloud) {
        const localIds = new Set(localState.transactions.map((tx) => tx.id));
        const cloudIds = new Set(cloudState.transactions.map((tx) => tx.id));
        for (const id of localIds) if (!cloudIds.has(id)) localOnly.push(id);
        for (const id of cloudIds) if (!localIds.has(id)) cloudOnly.push(id);
      }
      return { local, cloud, localOnlyCount: localOnly.length, cloudOnlyCount: cloudOnly.length };
    },

    /** True when the browser is currently offline. */
    isOffline() {
      return typeof navigator !== 'undefined' && navigator.onLine === false;
    },

    /** Number of records that exist locally but not in the cloud copy. */
    diffCounts(localState, cloudState) {
      const resources = ['transactions', 'categories', 'accounts', 'budgets', 'recurringRules', 'goals'];
      const localIds = new Set((localState?.transactions || []).map((tx) => tx.id));
      const cloudIds = new Set((cloudState?.transactions || []).map((tx) => tx.id));
      const missing = [...localIds].filter((id) => !cloudIds.has(id)).length;
      const extra = [...cloudIds].filter((id) => !localIds.has(id)).length;
      return { resources, missing, extra };
    },

    get mode() {
      return store.persistence?.kind === 'cloud' ? SYNC_MODE.CLOUD : SYNC_MODE.LOCAL;
    },

    setMode(mode) {
      setStatus({ state: 'idle', message: '', mode });
    },

    status: cloudStatus,
    apiBaseUrl: appConfig.apiBaseUrl
  };
}
