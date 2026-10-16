/**
 * Transaction domain service.
 *
 * Owns: filtering, sorting, paging, aggregation for the list views, plus the
 * CRUD operations. All state changes go through `store.apply`, so persistence
 * and re-rendering happen exactly once per operation.
 */

import { store as defaultStore, RESOURCES } from '../../core/state.js';
import { ids } from '../../utils/ids.js';
import { todayISO, nowISO, isWithin, compareISO, resolveRange } from '../../utils/date.js';
import { formatMoney, normalizeCurrency, toMinor } from '../../utils/currency.js';
import { validateTransaction } from '../../utils/validation.js';
import { eligibleTransactions, periodSummary, findDuplicates, transactionFingerprint } from '../../utils/calculations.js';

export const SORT_OPTIONS = [
  { value: 'date-desc', label: 'Newest first' },
  { value: 'date-asc', label: 'Oldest first' },
  { value: 'amount-desc', label: 'Amount: high → low' },
  { value: 'amount-asc', label: 'Amount: low → high' },
  { value: 'category-asc', label: 'Category A → Z' },
  { value: 'description-asc', label: 'Description A → Z' },
  { value: 'created-desc', label: 'Recently added' }
];

export const EMPTY_FILTERS = Object.freeze({
  q: '',
  type: '',
  categoryId: '',
  accountId: '',
  paymentMethod: '',
  status: '',
  from: '',
  to: '',
  min: '',
  max: '',
  tags: [],
  sort: 'date-desc',
  page: 1,
  pageSize: 25
});

/** Adds derived, searchable text to a transaction (category/account names). */
export function withSearchText(transaction, { categories = [], accounts = [] } = {}) {
  const category = categories.find((c) => c.id === transaction.categoryId);
  const account = accounts.find((a) => a.id === transaction.accountId);
  const toAccount = transaction.toAccountId ? accounts.find((a) => a.id === transaction.toAccountId) : null;
  const haystack = [
    transaction.description,
    transaction.payee,
    transaction.notes,
    (transaction.tags || []).join(' '),
    category?.name || '',
    account?.name || '',
    toAccount?.name || '',
    transaction.type
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return { ...transaction, $search: haystack, $categoryName: category?.name || '', $accountName: account?.name || '', $toAccountName: toAccount?.name || '' };
}

/** Pure filter step — unit-tested without a store. */
export function filterTransactions(transactions, filters = {}, context = {}) {
  const f = { ...EMPTY_FILTERS, ...filters };
  const term = String(f.q || '').trim().toLowerCase();
  const tags = (Array.isArray(f.tags) ? f.tags : String(f.tags || '').split(',')).map((t) => t.trim().toLowerCase()).filter(Boolean);
  const min = f.min === '' || f.min === null ? null : asMinor(f.min, context.currency);
  const max = f.max === '' || f.max === null ? null : asMinor(f.max, context.currency);

  return (transactions || [])
    .map((tx) => withSearchText(tx, context))
    .filter((tx) => {
      if (f.type && tx.type !== f.type) return false;
      if (f.categoryId && tx.categoryId !== f.categoryId) return false;
      if (f.accountId && tx.accountId !== f.accountId && tx.toAccountId !== f.accountId) return false;
      if (f.paymentMethod && tx.paymentMethod !== f.paymentMethod) return false;
      if (f.status && tx.status !== f.status) return false;
      if (f.from && compareISO(tx.date, f.from) < 0) return false;
      if (f.to && compareISO(tx.date, f.to) > 0) return false;
      if (min !== null && Number.isFinite(min) && (Number(tx.amountMinor) || 0) < min) return false;
      if (max !== null && Number.isFinite(max) && (Number(tx.amountMinor) || 0) > max) return false;
      if (tags.length && !tags.every((tag) => (tx.tags || []).some((candidate) => candidate.toLowerCase() === tag))) return false;
      if (term && !tx.$search.includes(term)) return false;
      return true;
    });
}

function asMinor(value, currency = 'BDT') {
  if (typeof value === 'number') return value;
  const cleaned = String(value).replace(/[^\d.\-]/g, '');
  if (!cleaned) return null;
  const numeric = Number(cleaned);
  if (!Number.isFinite(numeric)) return null;
  return toMinor(numeric, currency);
}

/** Pure sort step. */
export function sortTransactions(rows, sort = 'date-desc') {
  const list = [...rows];
  const byDate = (a, b) => compareISO(a.date, b.date) || String(a.createdAt).localeCompare(String(b.createdAt));
  switch (sort) {
    case 'date-asc':
      return list.sort(byDate);
    case 'amount-desc':
      return list.sort((a, b) => b.amountMinor - a.amountMinor || byDate(b, a));
    case 'amount-asc':
      return list.sort((a, b) => a.amountMinor - b.amountMinor || byDate(b, a));
    case 'category-asc':
      return list.sort((a, b) => a.$categoryName.localeCompare(b.$categoryName) || byDate(b, a));
    case 'description-asc':
      return list.sort((a, b) => (a.description || '').localeCompare(b.description || '') || byDate(b, a));
    case 'created-desc':
      return list.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    case 'date-desc':
    default:
      return list.sort((a, b) => byDate(b, a) || String(b.createdAt).localeCompare(String(a.createdAt)));
  }
}

export function paginate(rows, page = 1, pageSize = 25) {
  const total = rows.length;
  const size = Math.max(1, Number(pageSize) || 25);
  const pages = Math.max(1, Math.ceil(total / size));
  const current = Math.min(Math.max(1, Number(page) || 1), pages);
  const start = (current - 1) * size;
  return { slice: rows.slice(start, start + size), total, pages, page: current, pageSize: size, from: total ? start + 1 : 0, to: Math.min(total, start + size) };
}

/** Aggregates for the current filter set (used by the list header summary). */
export function summarize(rows, { includePending = false, currency = null } = {}) {
  const summary = periodSummary(rows, { includePending, currency });
  const transferCount = rows.filter((tx) => tx.type === 'transfer').length;
  const transferMinor = rows
    .filter((tx) => tx.type === 'transfer' && (!currency || normalizeCurrency(tx.currency) === normalizeCurrency(currency)))
    .reduce((sum, tx) => sum + (Number(tx.amountMinor) || 0), 0);
  return { ...summary, transferCount, transferMinor };
}

export function createTransactionService({ store = defaultStore } = {}) {
  const context = () => ({ categories: store.list(RESOURCES.CATEGORIES), accounts: store.list(RESOURCES.ACCOUNTS) });

  function validate(input, { excludeId = null } = {}) {
    const { categories, accounts } = context();
    const existing = store.list(RESOURCES.TRANSACTIONS);
    const current = excludeId ? existing.find((tx) => tx.id === excludeId) : null;
    return validateTransaction(input, {
      categories,
      accounts,
      existing,
      preferences: store.preferences,
      excludeId,
      currentAccountId: current?.accountId ?? null,
      currentCategoryId: current?.categoryId ?? null
    });
  }

  return {
    context,
    validate,

    get(id) {
      return store.byId(RESOURCES.TRANSACTIONS, id);
    },

    all() {
      return store.list(RESOURCES.TRANSACTIONS);
    },

    /** Creates a transaction. @returns {{ok:boolean, record?:object, errors?:object, warnings?:string[]}} */
    add(input) {
      const result = validate(input);
      if (!result.ok) return { ok: false, errors: result.errors, warnings: result.warnings };
      const record = { ...result.value, id: result.value.id || ids.transaction(), createdAt: nowISO(), updatedAt: nowISO() };
      store.apply('transaction:add', (draft) => {
        draft.transactions = [...draft.transactions, record];
        return [{ resource: RESOURCES.TRANSACTIONS, op: 'upsert', record }];
      });
      return { ok: true, record, warnings: result.warnings };
    },

    update(id, input) {
      const existing = store.byId(RESOURCES.TRANSACTIONS, id);
      if (!existing) return { ok: false, errors: { id: 'That transaction no longer exists.' } };
      const result = validate({ ...existing, ...input, id }, { excludeId: id });
      if (!result.ok) return { ok: false, errors: result.errors, warnings: result.warnings };
      const record = { ...result.value, id, createdAt: existing.createdAt, updatedAt: nowISO() };
      store.apply('transaction:update', (draft) => {
        draft.transactions = draft.transactions.map((tx) => (tx.id === id ? record : tx));
        return [{ resource: RESOURCES.TRANSACTIONS, op: 'upsert', record }];
      });
      return { ok: true, record, warnings: result.warnings };
    },

    /** Deletes one transaction. Account balances and reports follow automatically. */
    remove(id) {
      const existing = store.byId(RESOURCES.TRANSACTIONS, id);
      if (!existing) return { ok: false, errors: { id: 'That transaction no longer exists.' } };
      store.apply('transaction:delete', (draft) => {
        draft.transactions = draft.transactions.filter((tx) => tx.id !== id);
        return [{ resource: RESOURCES.TRANSACTIONS, op: 'delete', id }];
      });
      return { ok: true, record: existing };
    },

    /** Bulk delete with a single state update. */
    removeMany(idsToRemove) {
      const wanted = new Set(Array.isArray(idsToRemove) ? idsToRemove : [idsToRemove]);
      const removed = store.list(RESOURCES.TRANSACTIONS).filter((tx) => wanted.has(tx.id));
      if (removed.length === 0) return { ok: false, removed: 0 };
      store.apply('transaction:bulk-delete', (draft) => {
        draft.transactions = draft.transactions.filter((tx) => !wanted.has(tx.id));
        return removed.map((tx) => ({ resource: RESOURCES.TRANSACTIONS, op: 'delete', id: tx.id }));
      });
      return { ok: true, removed: removed.length };
    },

    /** Duplicates a transaction (today's date by default, new id). */
    duplicate(id, { date = todayISO() } = {}) {
      const existing = store.byId(RESOURCES.TRANSACTIONS, id);
      if (!existing) return { ok: false, errors: { id: 'That transaction no longer exists.' } };
      const copy = { ...existing, id: ids.transaction(), date, createdAt: nowISO(), updatedAt: nowISO(), occurrenceKey: null };
      store.apply('transaction:duplicate', (draft) => {
        draft.transactions = [...draft.transactions, copy];
        return [{ resource: RESOURCES.TRANSACTIONS, op: 'upsert', record: copy }];
      });
      return { ok: true, record: copy };
    },

    /** Bulk edit of a single field across selected rows. */
    bulkUpdate(idsToUpdate, patch) {
      const wanted = new Set(idsToUpdate);
      const updated = [];
      store.apply('transaction:bulk-update', (draft) => {
        draft.transactions = draft.transactions.map((tx) => {
          if (!wanted.has(tx.id)) return tx;
          const next = { ...tx, ...patch, updatedAt: nowISO() };
          updated.push(next);
          return next;
        });
        return updated.map((record) => ({ resource: RESOURCES.TRANSACTIONS, op: 'upsert', record }));
      });
      return { ok: true, updated: updated.length };
    },

    findDuplicates(candidate) {
      return findDuplicates(store.list(RESOURCES.TRANSACTIONS), candidate, { windowDays: 1 });
    },

    /**
     * Filtered + sorted + paged query used by every transaction list view.
     * @returns {{rows:Array, total:number, page:number, pages:number, pageSize:number, totals:object, filtered:Array}}
     */
    query(filters = {}) {
      const { categories, accounts } = context();
      const merged = { ...EMPTY_FILTERS, ...filters };
      const filterContext = { categories, accounts, currency: merged.currency || store.preferences.currency };
      const filtered = filterTransactions(store.list(RESOURCES.TRANSACTIONS), merged, filterContext);
      const sorted = sortTransactions(filtered, merged.sort);
      const page = paginate(sorted, merged.page, merged.pageSize);
      const totals = summarize(sorted, {
        includePending: merged.status === 'pending',
        currency: merged.currency || null
      });
      return { ...page, rows: page.slice, totals, filtered: sorted };
    },

    /** Count of transactions that reference a category/account (used by guards). */
    usageCount(kind, id) {
      return store.list(RESOURCES.TRANSACTIONS).filter((tx) =>
        kind === 'category' ? tx.categoryId === id : tx.accountId === id || tx.toAccountId === id
      ).length;
    },

    /** Recent transactions for dashboards. */
    recent(limit = 6, { currency = null } = {}) {
      const { categories, accounts } = context();
      return sortTransactions(
        filterTransactions(store.list(RESOURCES.TRANSACTIONS), { status: 'posted', currency }, { categories, accounts }),
        'date-desc'
      ).slice(0, limit);    },

    /** Totals for a preset range (dashboard summary cards). */
    summaryForRange(rangeId, { currency = null, customFrom = null, customTo = null } = {}) {
      const range = resolveRange(rangeId, {
        weekStart: store.preferences.weekStart ?? 0,
        customFrom,
        customTo
      });
      return { range, summary: periodSummary(store.list(RESOURCES.TRANSACTIONS), { from: range.from, to: range.to, currency }) };
    },

    /** Distinct tags currently in use (powers the tag filter). */
    tagSuggestions() {
      const tags = new Map();
      for (const tx of store.list(RESOURCES.TRANSACTIONS)) {
        for (const tag of tx.tags || []) tags.set(tag.toLowerCase(), tag);
      }
      return [...tags.values()].sort((a, b) => a.localeCompare(b));
    },

    formatAmount(tx, { locale = 'en-US', accounting = false } = {}) {
      return formatMoney(tx.amountMinor, { currency: tx.currency, locale, accounting });
    },

    /** Exports the current filter selection to CSV rows (used by Export). */
    fingerprint: transactionFingerprint,
    eligible: (options) => eligibleTransactions(store.list(RESOURCES.TRANSACTIONS), options)
  };
}
