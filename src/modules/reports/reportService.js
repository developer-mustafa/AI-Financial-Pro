/**
 * Reports & analytics data layer.
 *
 * Every number here comes from `utils/calculations.js`, so the documented rules
 * apply uniformly: posted-only, transfers excluded from income/expense, refunds
 * counted as income, and never mixing currencies.
 */

import { store as defaultStore, RESOURCES } from '../../core/state.js';
import { resolveRange, compareISO } from '../../utils/date.js';
import { normalizeCurrency } from '../../utils/currency.js';
import {
  periodSummary, monthlyCashflow, categoryBreakdown, categoryTrend,
  accountBalances, accountMovements, budgetOverview, goalProgress, eligibleTransactions
} from '../../utils/calculations.js';

export function createReportService({ store = defaultStore } = {}) {
  const transactions = () => store.list(RESOURCES.TRANSACTIONS);
  const categories = () => store.list(RESOURCES.CATEGORIES);
  const accounts = () => store.list(RESOURCES.ACCOUNTS);

  return {
    transactions,
    categories,

    resolveRange(preset, extra = {}) {
      return resolveRange(preset, { weekStart: store.preferences.weekStart ?? 0, ...extra });
    },

    summary(range, currency) {
      return periodSummary(transactions(), { from: range.from, to: range.to, currency });
    },

    monthly(range, currency, { openingBalanceMinor = 0 } = {}) {
      return monthlyCashflow(transactions(), {
        from: range.from,
        to: range.to,
        currency,
        openingBalanceMinor
      });
    },

    expenseBreakdown(range, currency, { limit = null } = {}) {
      return categoryBreakdown(transactions(), categories(), { type: 'expense', from: range.from, to: range.to, currency, limit });
    },

    incomeBreakdown(range, currency, { limit = null } = {}) {
      return categoryBreakdown(transactions(), categories(), { type: 'income', from: range.from, to: range.to, currency, limit });
    },

    trend(range, currency, { limit = 6 } = {}) {
      return categoryTrend(transactions(), categories(), { from: range.from, to: range.to, currency, limit });
    },

    /** Largest transactions of a type in the range (for "biggest expenses"). */
    largest(range, currency, { type = 'expense', limit = 10 } = {}) {
      return eligibleTransactions(transactions(), { from: range.from, to: range.to, currency, type })
        .sort((a, b) => b.amountMinor - a.amountMinor || compareISO(b.date, a.date))
        .slice(0, limit);
    },

    accounts() {
      const list = accounts();
      const balances = accountBalances(list, transactions());
      return list.map((account) => ({
        account,
        balanceMinor: balances.get(account.id) || 0,
        movementCount: accountMovements(account, transactions(), {}).length
      }));
    },

    budgets() {
      return budgetOverview(store.list(RESOURCES.BUDGETS), transactions(), {
        weekStart: store.preferences.weekStart ?? 0,
        categories: categories()
      });
    },

    goals() {
      return store
        .list(RESOURCES.GOALS)
        .map((goal) => ({ goal, progress: goalProgress(goal) }))
        .sort((a, b) => b.progress.percent - a.progress.percent);
    },

    /** Flat rows for the printable/exportable summary. */
    summaryRows(range, currency) {
      const monthly = monthlyCashflow(transactions(), { from: range.from, to: range.to, currency });
      const expense = categoryBreakdown(transactions(), categories(), { type: 'expense', from: range.from, to: range.to, currency });
      return {
        monthly,
        expense,
        netTotals: monthly.reduce(
          (acc, row) => ({ income: acc.income + row.incomeMinor, expense: acc.expense + row.expenseMinor }),
          { income: 0, expense: 0 }
        )
      };
    },

    currencies() {
      const set = new Set();
      for (const tx of transactions()) set.add(normalizeCurrency(tx.currency));
      for (const account of accounts()) set.add(normalizeCurrency(account.currency));
      const preferred = normalizeCurrency(store.preferences.currency);
      const list = [...set];
      return list.includes(preferred) ? [preferred, ...list.filter((c) => c !== preferred)] : list;
    }
  };
}
