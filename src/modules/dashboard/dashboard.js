/**
 * Dashboard data aggregation.
 *
 * A thin, pure-ish layer over `utils/calculations.js` that assembles everything
 * the dashboard needs from the store in one place. Keeping it out of the view
 * makes the numbers testable and keeps the rendering code declarative.
 *
 * All money is minor units; reporting is posted-only and single-currency, as
 * enforced by the calculation layer.
 */

import { store as defaultStore, RESOURCES } from '../../core/state.js';
import { resolveRange, compareISO } from '../../utils/date.js';
import { normalizeCurrency } from '../../utils/currency.js';
import {
  netWorthByCurrency, periodSummary, recentMonthlyComparison, categoryBreakdown,
  budgetAlerts as computeBudgetAlerts, goalProgress, transactionCountByMonth
} from '../../utils/calculations.js';

export function createDashboardService({ store = defaultStore } = {}) {
  const transactions = () => store.list(RESOURCES.TRANSACTIONS);
  const categories = () => store.list(RESOURCES.CATEGORIES);

  return {
    transactions,

    resolveRange(preset, extra = {}) {
      return resolveRange(preset, { weekStart: store.preferences.weekStart ?? 0, ...extra });
    },

    netWorth() {
      return netWorthByCurrency(store.list(RESOURCES.ACCOUNTS), transactions());
    },

    summary(range, currency) {
      return periodSummary(transactions(), { from: range.from, to: range.to, currency });
    },

    cashflow({ months = 6, currency = null } = {}) {
      return recentMonthlyComparison(transactions(), { count: months, currency });
    },

    breakdown(range, currency, { type = 'expense', limit = 8 } = {}) {
      return categoryBreakdown(transactions(), categories(), {
        type,
        from: range.from,
        to: range.to,
        currency,
        limit
      });
    },

    monthlyCounts(range) {
      return transactionCountByMonth(transactions(), { from: range.from, to: range.to });
    },

    budgetAlerts() {
      return computeBudgetAlerts(store.list(RESOURCES.BUDGETS), transactions(), {
        thresholds: store.preferences.alertThresholds || [75, 90, 100],
        weekStart: store.preferences.weekStart ?? 0,
        categories: categories()
      });
    },

    activeBudgets() {
      return store.list(RESOURCES.BUDGETS).filter((budget) => !budget.archived && budget.status === 'active');
    },

    /** Active goals with live progress, closest to completion first. */
    goalHighlights(limit = 4, currency = null) {
      const code = currency ? normalizeCurrency(currency) : null;
      return store
        .list(RESOURCES.GOALS)
        .filter((goal) => !goal.archived && goal.status === 'active')
        .filter((goal) => !code || normalizeCurrency(goal.currency) === code)
        .map((goal) => ({ goal, progress: goalProgress(goal) }))
        .sort((a, b) => b.progress.percent - a.progress.percent || a.goal.name.localeCompare(b.goal.name))
        .slice(0, limit);
    },

    /** Newest transactions, optionally restricted to a currency. */
    recent(limit = 6, currency = null) {
      const code = currency ? normalizeCurrency(currency) : null;
      return store
        .list(RESOURCES.TRANSACTIONS)
        .filter((tx) => !code || normalizeCurrency(tx.currency) === code)
        .sort((a, b) => compareISO(b.date, a.date) || String(b.createdAt).localeCompare(String(a.createdAt)))
        .slice(0, limit);
    },

    /** Distinct currencies actually in use, preferred currency first. */
    currencies() {
      const set = new Set();
      for (const tx of transactions()) set.add(normalizeCurrency(tx.currency));
      for (const account of store.list(RESOURCES.ACCOUNTS)) set.add(normalizeCurrency(account.currency));
      const preferred = normalizeCurrency(store.preferences.currency);
      const list = [...set];
      return list.includes(preferred) ? [preferred, ...list.filter((c) => c !== preferred)] : list;
    }
  };
}
