/**
 * Store + local persistence. The store is the single mutation path, so these
 * tests pin down the change-list contract that persistence relies on.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Store, createEmptyState, normalizeState } from '../src/core/state.js';
import {
  createLocalStorageAdapter,
  migrate,
  snapshotLocalState,
  listSnapshots,
  createUiPreferences,
  StorageError
} from '../src/services/storageService.js';
import { appConfig } from '../src/config/appConfig.js';
import { memoryStorage, makeTransaction } from './helpers.js';

describe('Store lifecycle', () => {
  it('seeds default categories and an account on first run', async () => {
    const saved = [];
    const store = new Store({ persistence: { load: async () => null, save: async (state, changes) => saved.push({ state, changes }) } });
    await store.init();

    expect(store.ready).toBe(true);
    expect(store.list('categories').length).toBeGreaterThan(0);
    expect(store.list('accounts').length).toBe(1);
    expect(store.preferences.defaultAccountId).toBe(store.list('accounts')[0].id);

    await store.flush({ immediate: true });
    expect(saved.length).toBeGreaterThanOrEqual(1);
  });

  it('loads and normalises existing state instead of seeding', async () => {
    const existing = { ...createEmptyState(), transactions: [makeTransaction({ id: 'kept' })], metadata: { seeded: true } };
    const store = new Store({ persistence: { load: async () => existing, save: async () => {} } });
    await store.init();
    expect(store.list('transactions')).toHaveLength(1);
    expect(store.list('categories')).toHaveLength(0);
  });
});

describe('Store.apply', () => {
  it('returns the change list and notifies subscribers', () => {
    const store = new Store();
    const seen = [];
    const unsubscribe = store.subscribe((payload) => seen.push(payload));

    const tx = makeTransaction({ id: 't1' });
    const changes = store.apply('test:add', (draft) => {
      draft.transactions = [...draft.transactions, tx];
      return [{ resource: 'transactions', op: 'upsert', record: tx }];
    });

    expect(changes).toHaveLength(1);
    expect(store.list('transactions')).toHaveLength(1);
    expect(seen).toHaveLength(1);
    expect(seen[0].changes[0]).toMatchObject({ resource: 'transactions', op: 'upsert' });
    unsubscribe();
  });

  it('bumps metadata.updatedAt on every mutation', () => {
    const store = new Store();
    const before = store.state.metadata.updatedAt;
    store.apply('noop', (draft) => {
      draft.transactions = [...draft.transactions, makeTransaction({ id: 'x' })];
      return [];
    });
    expect(typeof store.state.metadata.updatedAt).toBe('string');
    expect(store.state.metadata.updatedAt >= before).toBe(true);
  });

  it('replaceState normalises and emits a full replacement', () => {
    const store = new Store();
    const changes = store.replaceState({ transactions: [{ id: 'a' }, { bad: true }] });
    expect(changes).toEqual([{ resource: '*', op: 'replace' }]);
    expect(store.list('transactions').map((tx) => tx.id)).toEqual(['a']);
  });
});

describe('normalizeState', () => {
  it('drops entities without a usable id and fills defaults', () => {
    const state = normalizeState({ transactions: [{ id: 'ok' }, { id: '' }, null], preferences: { currency: 'USD' } });
    expect(state.transactions).toHaveLength(1);
    expect(state.preferences.currency).toBe('USD');
    expect(state.preferences.weekStart).toBe(0);
  });
});

describe('localStorage adapter', () => {
  const key = appConfig.storage.state;

  it('round-trips state', async () => {
    const storage = memoryStorage();
    const adapter = createLocalStorageAdapter({ storage });
    await adapter.save({ ...createEmptyState(), transactions: [makeTransaction({ id: 't1' })] });
    const loaded = await adapter.load();
    expect(loaded.transactions.map((tx) => tx.id)).toEqual(['t1']);
  });

  it('quarantines a corrupt payload and reports it', async () => {
    const storage = memoryStorage({ [key]: '{not valid json' });
    const adapter = createLocalStorageAdapter({ storage });
    await expect(adapter.load()).rejects.toMatchObject({ code: 'storage_corrupt' });
    expect(adapter.corruptKeys()).toHaveLength(1);
  });

  it('reports usage and clears', async () => {
    const storage = memoryStorage();
    const adapter = createLocalStorageAdapter({ storage });
    await adapter.save(createEmptyState());
    expect(adapter.usage().bytes).toBeGreaterThan(0);
    await adapter.clear();
    expect(storage.getItem(key)).toBeNull();
  });
});

describe('migrate', () => {
  it('upgrades an unversioned payload to the current schema', () => {
    const { state, applied } = migrate({ transactions: [{ id: 't1' }] });
    expect(applied).toEqual(['0→1']);
    expect(state.schemaVersion).toBe(appConfig.schemaVersion);
    expect(state.transactions).toHaveLength(1);
  });

  it('refuses data from a newer schema', () => {
    expect(() => migrate({ schemaVersion: appConfig.schemaVersion + 5 })).toThrow(StorageError);
  });
});

describe('snapshots', () => {
  it('stores a snapshot and lists it', () => {
    const storage = memoryStorage();
    const key = snapshotLocalState({ ...createEmptyState(), transactions: [makeTransaction({ id: 'x' })] }, { storage });
    expect(key).toBeTruthy();
    const snapshots = listSnapshots({ storage });
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].key).toBe(key);
  });
});

describe('ui preferences', () => {
  let storage;
  beforeEach(() => {
    storage = memoryStorage();
  });

  it('stores and reads values with a fallback', () => {
    const prefs = createUiPreferences({ storage });
    expect(prefs.get('sidebarCollapsed', false)).toBe(false);
    prefs.set('sidebarCollapsed', true);
    expect(prefs.get('sidebarCollapsed')).toBe(true);
    prefs.remove('sidebarCollapsed');
    expect(prefs.get('sidebarCollapsed', false)).toBe(false);
  });
});
