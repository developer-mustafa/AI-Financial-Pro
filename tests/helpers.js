/**
 * Shared test fixtures.
 *
 * These helpers build *plain* domain records (not services) so the pure
 * calculation and validation suites can run without a DOM or a store.
 */

import { Store, createEmptyState } from '../src/core/state.js';
import { DEFAULT_PREFERENCES } from '../src/config/defaults.js';

/** A Store instance seeded with explicit state (bypasses localStorage). */
export function makeStore(overrides = {}) {
  const store = new Store();
  store.state = {
    ...createEmptyState(),
    ...overrides,
    preferences: { ...DEFAULT_PREFERENCES, ...(overrides.preferences || {}) }
  };
  store.ready = true;
  return store;
}

export function makeAccount(overrides = {}) {
  return {
    id: 'acc_cash',
    name: 'Cash',
    type: 'cash',
    currency: 'BDT',
    openingBalanceMinor: 0,
    openingBalanceDate: '2026-01-01',
    color: '#6366f1',
    icon: 'wallet',
    archived: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  };
}

export function makeCategory(overrides = {}) {
  return {
    id: 'cat_food',
    name: 'Food',
    type: 'expense',
    parentId: null,
    icon: 'tag',
    color: '#64748b',
    archived: false,
    isDefault: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  };
}

let txCounter = 0;
export function makeTransaction(overrides = {}) {
  txCounter += 1;
  return {
    id: `txn_${txCounter}`,
    type: 'expense',
    amountMinor: 10000,
    currency: 'BDT',
    categoryId: 'cat_food',
    accountId: 'acc_cash',
    toAccountId: null,
    date: '2026-10-01',
    description: 'Test transaction',
    payee: '',
    paymentMethod: 'cash',
    tags: [],
    notes: '',
    status: 'posted',
    recurringRuleId: null,
    occurrenceKey: null,
    createdAt: `2026-10-01T00:00:${String(txCounter).padStart(2, '0')}.000Z`,
    updatedAt: `2026-10-01T00:00:${String(txCounter).padStart(2, '0')}.000Z`,
    ...overrides
  };
}

/** Minimal in-memory Storage implementation for adapter tests. */
export function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    get length() {
      return map.size;
    },
    key(index) {
      return [...map.keys()][index] ?? null;
    },
    getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      map.set(key, String(value));
    },
    removeItem(key) {
      map.delete(key);
    },
    clear() {
      map.clear();
    }
  };
}
