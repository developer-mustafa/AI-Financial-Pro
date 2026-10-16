/**
 * Budget domain service.
 *
 * BUSINESS RULES (mirrored from utils/calculations.js):
 *  - Only POSTED EXPENSE transactions count towards a budget.
 *  - Transfers and income never count, even inside the budget window.
 *  - Refunds are income, so they never reduce budget utilisation.
 *  - A "monthly" budget repeats every month between startDate and endDate; it is
 *    only active while today falls inside that span.
 *  - Category budgets include every descendant category.
 *  - Amounts are compared in the budget's own currency; other currencies are
 *    never mixed in.
 */

import { store as defaultStore, RESOURCES } from '../../core/state.js';
import { ids } from '../../utils/ids.js';
import { todayISO, nowISO } from '../../utils/date.js';
import { validateBudget } from '../../utils/validation.js';
import { budgetStatus, budgetOverview, budgetAlerts, budgetWindow } from '../../utils/calculations.js';

export function createBudgetService({ store = defaultStore } = {}) {
  const all = () => store.list(RESOURCES.BUDGETS);

  function validate(input, { excludeId = null } = {}) {
    return validateBudget(input, {
      categories: store.list(RESOURCES.CATEGORIES),
      preferences: store.preferences,
      budgets: all(),
      excludeId
    });
  }

  const options = (extra = {}) => ({
    today: todayISO(),
    weekStart: store.preferences.weekStart ?? 0,
    categories: store.list(RESOURCES.CATEGORIES),
    ...extra
  });

  const service = {
    all,
    get: (id) => store.byId(RESOURCES.BUDGETS, id),
    active: () => all().filter((budget) => !budget.archived && budget.status === 'active'),
    validate,

    add(input) {
      const result = validate(input);
      if (!result.ok) return { ok: false, errors: result.errors };
      const record = { ...result.value, id: result.value.id || ids.budget(), createdAt: nowISO(), updatedAt: nowISO() };
      store.apply('budget:add', (draft) => {
        draft.budgets = [...draft.budgets, record];
        return [{ resource: RESOURCES.BUDGETS, op: 'upsert', record }];
      });
      return { ok: true, record };
    },

    update(id, input) {
      const existing = store.byId(RESOURCES.BUDGETS, id);
      if (!existing) return { ok: false, errors: { id: 'That budget no longer exists.' } };
      const result = validate({ ...existing, ...input, id }, { excludeId: id });
      if (!result.ok) return { ok: false, errors: result.errors };
      const record = { ...result.value, id, createdAt: existing.createdAt, updatedAt: nowISO() };
      store.apply('budget:update', (draft) => {
        draft.budgets = draft.budgets.map((budget) => (budget.id === id ? record : budget));
        return [{ resource: RESOURCES.BUDGETS, op: 'upsert', record }];
      });
      return { ok: true, record };
    },

    /** Pausing keeps the rule and its history but stops alerts/utilisation. */
    pause(id) {
      const existing = store.byId(RESOURCES.BUDGETS, id);
      if (!existing) return { ok: false, errors: { id: 'That budget no longer exists.' } };
      return service.update(id, { ...existing, status: 'paused' });
    },

    resume(id) {
      const existing = store.byId(RESOURCES.BUDGETS, id);
      if (!existing) return { ok: false, errors: { id: 'That budget no longer exists.' } };
      return service.update(id, { ...existing, status: 'active' });
    },

    archive(id) {
      const existing = store.byId(RESOURCES.BUDGETS, id);
      if (!existing) return { ok: false, errors: { id: 'That budget no longer exists.' } };
      if (existing.archived) return { ok: true, record: existing };
      return service.update(id, { ...existing, archived: true });
    },

    restore(id) {
      const existing = store.byId(RESOURCES.BUDGETS, id);
      if (!existing) return { ok: false, errors: { id: 'That budget no longer exists.' } };
      const clash = all().find(
        (budget) =>
          budget.id !== id &&
          !budget.archived &&
          budget.period === existing.period &&
          budget.name.trim().toLowerCase() === existing.name.trim().toLowerCase()
      );
      if (clash) return { ok: false, errors: { name: `An active budget named “${clash.name}” already exists. Rename one of them first.` } };
      return service.update(id, { ...existing, archived: false });
    },

    /** Budgets are standalone records, so a hard delete is always safe. */
    remove(id) {
      const existing = store.byId(RESOURCES.BUDGETS, id);
      if (!existing) return { ok: false, errors: { id: 'That budget no longer exists.' } };
      store.apply('budget:delete', (draft) => {
        draft.budgets = draft.budgets.filter((budget) => budget.id !== id);
        return [{ resource: RESOURCES.BUDGETS, op: 'delete', id }];
      });
      return { ok: true, record: existing };
    },

    /** Live utilisation of one budget, or null when it is inactive today. */
    status(id, extra = {}) {
      const budget = store.byId(RESOURCES.BUDGETS, id);
      if (!budget) return null;
      return budgetStatus(budget, store.list(RESOURCES.TRANSACTIONS), options(extra));
    },

    /** Every budget active today with utilisation, worst-first. */
    overview(extra = {}) {
      return budgetOverview(all(), store.list(RESOURCES.TRANSACTIONS), options(extra));
    },

    /** Rows for the list screen: evaluated budgets first, inactive ones after. */
    rows(extra = {}) {
      const evaluated = new Map(service.overview(extra).map((row) => [row.budget.id, row.status]));
      return all()
        .map((budget) => ({ budget, status: evaluated.get(budget.id) || null }))
        .sort((a, b) => {
          const activeA = a.status ? 1 : 0;
          const activeB = b.status ? 1 : 0;
          if (activeA !== activeB) return activeB - activeA;
          return (b.status?.percent || -1) - (a.status?.percent || -1) || a.budget.name.localeCompare(b.budget.name);
        });
    },

    alerts(extra = {}) {
      const state = store.get();
      return budgetAlerts(state.budgets, state.transactions, {
        ...options(extra),
        thresholds: state.preferences.alertThresholds || [75, 90, 100],
        acknowledged: extra.acknowledged || {}
      });
    },

    window: (id) => {
      const budget = store.byId(RESOURCES.BUDGETS, id);
      return budget ? budgetWindow(budget, todayISO(), store.preferences.weekStart ?? 0) : null;
    },

    /** Total limit minus total spent across all budgets active today. */
    remainingTotal(extra = {}) {
      const rows = service.overview(extra);
      let limitMinor = 0;
      let spentMinor = 0;
      for (const { budget, status } of rows) {
        limitMinor += Number(budget.limitMinor) || 0;
        spentMinor += status.spentMinor;
      }
      return { limitMinor, spentMinor, remainingMinor: limitMinor - spentMinor, count: rows.length };
    },

    /** True when at least one active budget uses a given category. */
    categoriesInUse() {
      return new Set(all().filter((budget) => !budget.archived && budget.categoryId).map((budget) => budget.categoryId));
    },

    categoryOptions() {
      return store.orderedCategories('expense').map((category) => ({
        value: category.id,
        label: `${'— '.repeat(category.depth)}${category.name}${category.archived ? ' (archived)' : ''}`
      }));
    }
  };

  return service;
}
