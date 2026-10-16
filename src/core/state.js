/**
 * Central application state.
 *
 * Design:
 *  - ONE plain object holds every persisted entity plus preferences.
 *  - Mutations go through `apply(reason, mutator)`. The mutator receives a
 *    shallow-cloned draft and must replace the arrays it touches; it returns a
 *    list of `changes` describing what happened. Those changes are what the
 *    persistence adapter forwards to localStorage / the cloud API.
 *  - Derived values are NEVER stored; they are recomputed from source records
 *    by the pure functions in utils/calculations.js.
 *  - Synthetic change events let views re-render without polling.
 */

import { appConfig } from '../config/appConfig.js';
import { DEFAULT_PREFERENCES, buildSeedData } from '../config/defaults.js';
import { nowISO, todayISO } from '../utils/date.js';
import { ids } from '../utils/ids.js';
import { bus, EVENTS } from './eventBus.js';

export const RESOURCES = Object.freeze({
  TRANSACTIONS: 'transactions',
  CATEGORIES: 'categories',
  ACCOUNTS: 'accounts',
  BUDGETS: 'budgets',
  RECURRING: 'recurringRules',
  GOALS: 'goals',
  PREFERENCES: 'preferences'
});

const ARRAY_RESOURCES = [
  RESOURCES.TRANSACTIONS,
  RESOURCES.CATEGORIES,
  RESOURCES.ACCOUNTS,
  RESOURCES.BUDGETS,
  RESOURCES.RECURRING,
  RESOURCES.GOALS
];

export function createEmptyState(now = nowISO()) {
  return {
    schemaVersion: appConfig.schemaVersion,
    transactions: [],
    categories: [],
    accounts: [],
    budgets: [],
    recurringRules: [],
    goals: [],
    preferences: { ...DEFAULT_PREFERENCES },
    metadata: { createdAt: now, updatedAt: now, seeded: false }
  };
}

/** Defensive normaliser for data coming from storage, a backup, or the cloud. */
export function normalizeState(raw, { seed = false } = {}) {
  const base = createEmptyState();
  if (!raw || typeof raw !== 'object') return seed ? seededState() : base;

  const state = {
    schemaVersion: Number.isFinite(Number(raw.schemaVersion)) ? Number(raw.schemaVersion) : appConfig.schemaVersion,
    transactions: [],
    categories: [],
    accounts: [],
    budgets: [],
    recurringRules: [],
    goals: [],
    preferences: { ...DEFAULT_PREFERENCES, ...(typeof raw.preferences === 'object' && raw.preferences ? raw.preferences : {}) },
    metadata: {
      createdAt: typeof raw.metadata?.createdAt === 'string' ? raw.metadata.createdAt : base.metadata.createdAt,
      updatedAt: typeof raw.metadata?.updatedAt === 'string' ? raw.metadata.updatedAt : base.metadata.updatedAt,
      seeded: Boolean(raw.metadata?.seeded)
    }
  };

  for (const resource of ARRAY_RESOURCES) {
    const list = Array.isArray(raw[resource]) ? raw[resource] : [];
    state[resource] = list.filter((item) => item && typeof item === 'object' && typeof item.id === 'string' && item.id);
  }

  // `alertThresholds` is iterated while the notification bell renders at
  // start-up, so a malformed value from older storage must not survive here.
  const rawThresholds = state.preferences.alertThresholds;
  const thresholds = (Array.isArray(rawThresholds) ? rawThresholds : [])
    .map((value) => Math.round(Number(value)))
    .filter((value) => Number.isFinite(value) && value > 0);
  state.preferences.alertThresholds = thresholds.length ? thresholds : [...DEFAULT_PREFERENCES.alertThresholds];

  return state;
}

/** First-run state: default categories + a starter cash account. */
export function seededState(now = nowISO()) {
  const state = createEmptyState(now);
  const seed = buildSeedData(() => ids.category(), now, state.preferences.currency);
  state.categories = seed.categories;
  state.accounts = seed.accounts;
  state.preferences.defaultAccountId = seed.cashAccountId;
  state.metadata.seeded = true;
  return state;
}

export class Store {
  /**
   * @param {{persistence?: object, onError?: (error:Error)=>void}} options
   */
  constructor({ persistence = null, onError = null } = {}) {
    this.persistence = persistence;
    this.onError = onError;
    this.state = createEmptyState();
    this.ready = false;
    this.listeners = new Set();
    this.persistError = null;
    this.pendingChanges = [];
    this.persistTimer = null;
  }

  /* ------------------------------ lifecycle ------------------------------ */

  async init({ seedIfEmpty = true } = {}) {
    let loaded = null;
    if (this.persistence) {
      try {
        loaded = await this.persistence.load();
      } catch (error) {
        this.persistError = error;
        this.onError?.(error);
      }
    }
    if (loaded) {
      this.state = normalizeState(loaded, { seed: false });
    } else if (seedIfEmpty) {
      this.state = seededState();
      this.queuePersist([{ resource: '*', op: 'replace' }]);
    } else {
      this.state = createEmptyState();
    }
    this.ready = true;
    this.emit([{ resource: '*', op: 'init' }], 'init');
    return this.state;
  }

  get() {
    return this.state;
  }

  get preferences() {
    return this.state.preferences;
  }

  /** @returns {() => void} unsubscribe */
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(changes, reason) {
    const payload = { state: this.state, changes, reason };
    for (const listener of [...this.listeners]) {
      try {
        listener(payload);
      } catch (error) {
        console.error('[store] subscriber failed', error);
      }
    }
    bus.emit(EVENTS.DATA_CHANGED, payload);
  }

  /* ------------------------------ mutation ------------------------------ */

  /**
   * Applies a mutation.
   * @param {string} reason short description used in logs/audit
   * @param {(draft: object) => Array<object>|void} mutator
   * @returns {Array<object>} the change list
   */
  apply(reason, mutator) {
    if (typeof mutator !== 'function') throw new TypeError('store.apply requires a mutator function');
    const draft = { ...this.state, metadata: { ...this.state.metadata, updatedAt: nowISO() } };
    const changes = mutator(draft) || [];
    this.state = draft;
    if (changes.length) this.queuePersist(changes);
    this.emit(changes, reason);
    return changes;
  }

  /** Replaces the whole state (restore/import/cloud refresh). */
  replaceState(nextState, reason = 'replace') {
    this.state = normalizeState(nextState);
    const changes = [{ resource: '*', op: 'replace' }];
    this.queuePersist(changes);
    this.emit(changes, reason);
    return changes;
  }

  /**
   * Replace the in-memory state WITHOUT writing it back to persistence.
   *
   * Used when the dataset changes out from under the app — most importantly
   * when the user switches workspace: the new workspace's records are fetched
   * from the cloud and must never be echoed back over them. Pending (unflushed)
   * changes from the previous workspace are dropped, so flush them first.
   */
  hydrate(nextState, reason = 'hydrate') {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.pendingChanges = [];
    this.state = nextState ? normalizeState(nextState) : createEmptyState();
    this.emit([{ resource: '*', op: 'replace' }], reason);
    return this.state;
  }

  /** Adds any missing default categories/accounts without deleting data. */
  restoreDefaults() {
    return this.apply('restore-defaults', (draft) => {
      const now = nowISO();
      const seed = buildSeedData(() => ids.category(), now, draft.preferences.currency);
      const existingKeys = new Set(draft.categories.map((c) => `${c.type}::${c.name.trim().toLowerCase()}`));
      const additions = seed.categories.filter((c) => !existingKeys.has(`${c.type}::${c.name.trim().toLowerCase()}`));
      draft.categories = [...draft.categories, ...additions];

      const changes = additions.map((category) => ({ resource: RESOURCES.CATEGORIES, op: 'upsert', record: category }));

      if (draft.accounts.length === 0) {
        draft.accounts = seed.accounts;
        draft.preferences = { ...draft.preferences, defaultAccountId: seed.cashAccountId };
        changes.push({ resource: RESOURCES.ACCOUNTS, op: 'upsert', record: seed.accounts[0] });
        changes.push({ resource: RESOURCES.PREFERENCES, op: 'upsert', record: draft.preferences });
      }
      return changes;
    });
  }

  /* ------------------------------ persistence ------------------------------ */

  /** Batches rapid mutations into a single write. */
  queuePersist(changes) {
    this.pendingChanges.push(...changes);
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.flush();
    }, 350);
  }

  async flush({ immediate = false } = {}) {
    if (!this.persistence) return;
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    const changes = this.pendingChanges.splice(0, this.pendingChanges.length);
    const replaceAll = changes.some((change) => change.resource === '*' || change.op === 'replace');
    const payload = replaceAll ? [{ resource: '*', op: 'replace' }] : changes;
    if (payload.length === 0 && !immediate) return;
    try {
      await this.persistence.save(this.state, payload);
      this.persistError = null;
    } catch (error) {
      this.persistError = error;
      this.onError?.(error);
      // Put the work back so a later flush (or explicit retry) can succeed.
      if (!replaceAll) this.pendingChanges.unshift(...changes);
    }
  }

  /* ------------------------------ lookups ------------------------------ */

  list(resource) {
    const value = this.state[resource];
    return Array.isArray(value) ? value : [];
  }

  byId(resource, id) {
    if (!id) return null;
    return this.list(resource).find((item) => item.id === id) || null;
  }

  activeAccounts() {
    return this.list(RESOURCES.ACCOUNTS).filter((account) => !account.archived);
  }

  activeCategories(type = null) {
    return this.list(RESOURCES.CATEGORIES).filter((category) => !category.archived && (!type || category.type === type));
  }

  categoryName(id) {
    return this.byId(RESOURCES.CATEGORIES, id)?.name || (id ? 'Deleted category' : 'Uncategorised');
  }

  accountName(id) {
    return this.byId(RESOURCES.ACCOUNTS, id)?.name || (id ? 'Deleted account' : '—');
  }

  /** Sorted category list (parents first, children after their parent). */
  orderedCategories(type = null) {
    const list = this.list(RESOURCES.CATEGORIES).filter((category) => !type || category.type === type);
    const byParent = new Map();
    for (const category of list) {
      const key = category.parentId || null;
      const bucket = byParent.get(key) || [];
      bucket.push(category);
      byParent.set(key, bucket);
    }
    const sortFn = (a, b) => a.name.localeCompare(b.name);
    const out = [];
    const walk = (parentId, depth) => {
      for (const category of (byParent.get(parentId) || []).sort(sortFn)) {
        out.push({ ...category, depth });
        walk(category.id, depth + 1);
      }
    };
    walk(null, 0);
    return out;
  }

  /** Aggregated usage counters used by the category/account managers. */
  usageCounts() {
    const counts = { category: new Map(), account: new Map() };
    for (const tx of this.list(RESOURCES.TRANSACTIONS)) {
      if (tx.categoryId) counts.category.set(tx.categoryId, (counts.category.get(tx.categoryId) || 0) + 1);
      if (tx.accountId) counts.account.set(tx.accountId, (counts.account.get(tx.accountId) || 0) + 1);
      if (tx.toAccountId) counts.account.set(tx.toAccountId, (counts.account.get(tx.toAccountId) || 0) + 1);
    }
    return counts;
  }

  /** True when the user has not recorded anything yet. */
  isEmpty() {
    return this.list(RESOURCES.TRANSACTIONS).length === 0;
  }

  storageUsage() {
    try {
      const raw = localStorage.getItem(appConfig.storage.state) || '';
      return { bytes: raw.length, date: todayISO() };
    } catch {
      return { bytes: 0, date: todayISO() };
    }
  }
}

/** Application-wide singleton. The persistence adapter is attached in app.js. */
export const store = new Store();
