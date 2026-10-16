/**
 * CSV / JSON export.
 *
 * Rules:
 *  - UTF-8 output with a BOM so Excel opens non-ASCII data correctly.
 *  - RFC 4180 escaping and formula-injection neutralisation (utils/sanitize).
 *  - Amounts are exported both as minor units (`amountMinor`, authoritative
 *    integer) and as a decimal string (`amount`, for readability). Decimal
 *    values are re-derived from the integer, so they never drift.
 *  - Blob URLs are created and revoked by utils/dom.downloadFile.
 */

import { appConfig } from '../config/appConfig.js';
import { downloadFile } from '../utils/dom.js';
import { formatDate } from '../utils/date.js';
import { fromMinor } from '../utils/currency.js';
import { toCsv } from '../utils/sanitize.js';
import { stamp } from '../utils/ids.js';

const TYPE_LABELS = { income: 'Income', expense: 'Expense', transfer: 'Transfer' };

/** Builds a lookup helper for name resolution in exports. */
function resolvers({ categories = [], accounts = [] } = {}) {
  const categoryMap = new Map(categories.map((c) => [c.id, c]));
  const accountMap = new Map(accounts.map((a) => [a.id, a]));
  return {
    category: (id) => (id ? categoryMap.get(id)?.name || 'Deleted category' : ''),
    account: (id) => (id ? accountMap.get(id)?.name || 'Deleted account' : ''),
    raw: (id) => id || ''
  };
}

export const TRANSACTION_HEADERS = [
  'id', 'date', 'type', 'description', 'payee', 'category', 'categoryId', 'account', 'accountId',
  'toAccount', 'toAccountId', 'amount', 'amountMinor', 'currency', 'paymentMethod', 'status',
  'tags', 'notes', 'recurringRuleId', 'occurrenceKey', 'createdAt', 'updatedAt'
];

export function transactionRows(transactions, ctx = {}) {
  const resolve = resolvers(ctx);
  return [
    TRANSACTION_HEADERS,
    ...transactions.map((tx) => [
      tx.id,
      tx.date,
      TYPE_LABELS[tx.type] || tx.type,
      tx.description,
      tx.payee,
      resolve.category(tx.categoryId),
      tx.categoryId || '',
      resolve.account(tx.accountId),
      tx.accountId,
      tx.toAccountId ? resolve.account(tx.toAccountId) : '',
      tx.toAccountId || '',
      fromMinor(tx.amountMinor, tx.currency).toFixed(2),
      tx.amountMinor,
      tx.currency,
      tx.paymentMethod,
      tx.status,
      (tx.tags || []).join('; '),
      tx.notes,
      tx.recurringRuleId || '',
      tx.occurrenceKey || '',
      tx.createdAt,
      tx.updatedAt
    ])
  ];
}

export const CATEGORY_HEADERS = ['id', 'name', 'type', 'parentId', 'parentName', 'icon', 'color', 'archived', 'isDefault', 'createdAt', 'updatedAt'];

export function categoryRows(categories) {
  const map = new Map(categories.map((c) => [c.id, c]));
  return [
    CATEGORY_HEADERS,
    ...categories.map((c) => [
      c.id,
      c.name,
      c.type,
      c.parentId || '',
      c.parentId ? map.get(c.parentId)?.name || 'Deleted category' : '',
      c.icon,
      c.color,
      c.archived ? 'yes' : 'no',
      c.isDefault ? 'yes' : 'no',
      c.createdAt,
      c.updatedAt
    ])
  ];
}

export const ACCOUNT_HEADERS = ['id', 'name', 'type', 'currency', 'openingBalance', 'openingBalanceMinor', 'openingBalanceDate', 'color', 'icon', 'archived', 'balance', 'balanceMinor', 'createdAt', 'updatedAt'];

export function accountRows(accounts, balances = new Map()) {
  return [
    ACCOUNT_HEADERS,
    ...accounts.map((a) => {
      const balanceMinor = balances.get(a.id) ?? 0;
      return [
        a.id,
        a.name,
        a.type,
        a.currency,
        fromMinor(a.openingBalanceMinor, a.currency).toFixed(2),
        a.openingBalanceMinor,
        a.openingBalanceDate,
        a.color,
        a.icon,
        a.archived ? 'yes' : 'no',
        fromMinor(balanceMinor, a.currency).toFixed(2),
        balanceMinor,
        a.createdAt,
        a.updatedAt
      ];
    })
  ];
}

export const BUDGET_HEADERS = ['id', 'name', 'period', 'scope', 'category', 'categoryId', 'limit', 'limitMinor', 'currency', 'startDate', 'endDate', 'alertThresholds', 'status', 'archived', 'spent', 'spentMinor', 'percentUsed', 'createdAt', 'updatedAt'];

export function budgetRows(rows, ctx = {}) {
  const resolve = resolvers(ctx);
  return [
    BUDGET_HEADERS,
    ...rows.map(({ budget: b, status }) => [
      b.id,
      b.name,
      b.period,
      b.scope,
      b.categoryId ? resolve.category(b.categoryId) : 'Overall',
      b.categoryId || '',
      fromMinor(b.limitMinor, b.currency).toFixed(2),
      b.limitMinor,
      b.currency,
      b.startDate,
      b.endDate,
      (b.alertThresholds || []).join('; '),
      b.status,
      b.archived ? 'yes' : 'no',
      status ? fromMinor(status.spentMinor, b.currency).toFixed(2) : '',
      status?.spentMinor ?? '',
      status ? status.percent.toFixed(2) : '',
      b.createdAt,
      b.updatedAt
    ])
  ];
}

export const GOAL_HEADERS = ['id', 'name', 'target', 'targetMinor', 'saved', 'savedMinor', 'currency', 'targetDate', 'account', 'accountId', 'status', 'archived', 'percent', 'remainingMinor', 'createdAt', 'updatedAt'];

export function goalRows(rows, ctx = {}) {
  const resolve = resolvers(ctx);
  return [
    GOAL_HEADERS,
    ...rows.map(({ goal: g, progress }) => [
      g.id,
      g.name,
      fromMinor(g.targetMinor, g.currency).toFixed(2),
      g.targetMinor,
      fromMinor(g.savedMinor, g.currency).toFixed(2),
      g.savedMinor,
      g.currency,
      g.targetDate || '',
      g.accountId ? resolve.account(g.accountId) : '',
      g.accountId || '',
      g.status,
      g.archived ? 'yes' : 'no',
      progress ? progress.percent.toFixed(2) : '',
      progress?.remainingMinor ?? '',
      g.createdAt,
      g.updatedAt
    ])
  ];
}

export const RECURRING_HEADERS = ['id', 'name', 'type', 'amount', 'amountMinor', 'currency', 'category', 'categoryId', 'account', 'accountId', 'toAccount', 'frequency', 'intervalCount', 'startDate', 'nextDueDate', 'endDate', 'status', 'monthlyEquivalentMinor', 'notes', 'createdAt', 'updatedAt'];

export function recurringRows(rows, ctx = {}) {
  const resolve = resolvers(ctx);
  return [
    RECURRING_HEADERS,
    ...rows.map(({ rule: r, monthlyEquivalentMinor }) => [
      r.id,
      r.name,
      TYPE_LABELS[r.type] || r.type,
      fromMinor(r.amountMinor, r.currency).toFixed(2),
      r.amountMinor,
      r.currency,
      r.categoryId ? resolve.category(r.categoryId) : '',
      r.categoryId || '',
      resolve.account(r.accountId),
      r.accountId,
      r.toAccountId ? resolve.account(r.toAccountId) : '',
      r.frequency,
      r.intervalCount,
      r.startDate,
      r.nextDueDate,
      r.endDate || '',
      r.status,
      monthlyEquivalentMinor ?? '',
      r.notes,
      r.createdAt,
      r.updatedAt
    ])
  ];
}

/* --------------------------------------------------------------------------- *
 * Download helpers
 * --------------------------------------------------------------------------- */

const BOM = '\uFEFF';

/** Writes a CSV file (UTF-8 + BOM). @returns {{name:string, bytes:number}} */
export function downloadCsv(name, rows) {
  const filename = `${name}-${stamp()}.csv`;
  const csv = `${BOM}${toCsv(rows)}`;
  const bytes = downloadFile(filename, csv, 'text/csv');
  return { name: filename, bytes };
}

export function downloadJson(name, payload) {
  const filename = `${name}-${stamp()}.json`;
  const text = JSON.stringify(payload, null, 2);
  const bytes = downloadFile(filename, text, 'application/json');
  return { name: filename, bytes };
}

/** Convenience wrappers used by views and Settings. */
export function exportTransactions(transactions, ctx, name = 'spendwise-transactions') {
  return downloadCsv(name, transactionRows(transactions, ctx));
}

export function exportCategories(categories, name = 'spendwise-categories') {
  return downloadCsv(name, categoryRows(categories));
}

export function exportAccounts(accounts, balances, name = 'spendwise-accounts') {
  return downloadCsv(name, accountRows(accounts, balances));
}

export function exportBudgets(rows, ctx, name = 'spendwise-budgets') {
  return downloadCsv(name, budgetRows(rows, ctx));
}

export function exportGoals(rows, ctx, name = 'spendwise-goals') {
  return downloadCsv(name, goalRows(rows, ctx));
}

export function exportRecurring(rows, ctx, name = 'spendwise-recurring') {
  return downloadCsv(name, recurringRows(rows, ctx));
}

/** Human-readable workbook-ish "all data" JSON export. */
export function exportAllJson(state, { balances = new Map(), budgets = [], goals = [], recurring = [] } = {}) {
  return downloadJson('spendwise-full-export', {
    app: appConfig.appName,
    exportedAt: new Date().toISOString(),
    schemaVersion: state.schemaVersion,
    counts: countState(state),
    transactions: state.transactions,
    categories: state.categories,
    accounts: state.accounts.map((account) => ({ ...account, computedBalanceMinor: balances.get(account.id) ?? 0 })),
    budgets: budgets.map((row) => ({ ...row.budget, computed: row.status })),
    recurringRules: recurring.map((row) => ({ ...row.rule, monthlyEquivalentMinor: row.monthlyEquivalentMinor })),
    goals: goals.map((row) => ({ ...row.goal, computed: row.progress })),
    preferences: state.preferences
  });
}

export function countState(state) {
  return {
    transactions: state?.transactions?.length || 0,
    categories: state?.categories?.length || 0,
    accounts: state?.accounts?.length || 0,
    budgets: state?.budgets?.length || 0,
    recurringRules: state?.recurringRules?.length || 0,
    goals: state?.goals?.length || 0
  };
}

/** Stable, locale-independent date for filenames. */
export const exportStampedName = (base) => `${base}-${stamp()}`;
export const formatExportDate = (iso, locale) => formatDate(iso, { locale });
