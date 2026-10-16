/**
 * Feature coverage.
 *
 * Unit tests prove individual rules; this suite proves the *screens'* features
 * work end to end by driving the real domain services over the real store
 * mutation path (`store.apply`). If a user can do it in the UI, there is a
 * test here that does it without the DOM.
 *
 * Covered: accounts (CRUD, archive, transfers, net worth), categories
 * (tree, roll-up, safe delete), budgets (utilisation, alerts, pause), reports
 * (summary, breakdown, largest), recurring due items, notifications
 * (badge/ack), CSV export rows for every resource, JSON backup round-trip and
 * preference persistence.
 */

import { describe, it, expect } from 'vitest';
import { RESOURCES } from '../src/core/state.js';
import { createAccountService } from '../src/modules/accounts/accountService.js';
import { createCategoryService } from '../src/modules/categories/categoryService.js';
import { createBudgetService } from '../src/modules/budgets/budgetService.js';
import { createReportService } from '../src/modules/reports/reportService.js';
import { createTransactionService } from '../src/modules/transactions/transactionService.js';
import { createRecurringService } from '../src/modules/recurring/recurringService.js';
import { createNotificationService } from '../src/services/notificationService.js';
import { createUiPreferences } from '../src/services/storageService.js';
import { buildBackup, serializeBackup, restoreState, summarizeBackup } from '../src/services/backupService.js';
import { parseBackupJson } from '../src/services/importService.js';
import {
  categoryRows, accountRows, budgetRows, goalRows, recurringRows,
  CATEGORY_HEADERS, ACCOUNT_HEADERS, BUDGET_HEADERS, GOAL_HEADERS, RECURRING_HEADERS
} from '../src/services/exportService.js';
import { makeStore, makeAccount, makeCategory, makeTransaction, memoryStorage } from './helpers.js';

const uiPrefsForTest = () => createUiPreferences({ key: 'spendwise.test.ui', storage: memoryStorage() });

/* ------------------------------------------------------------------------- */

describe('accounts feature', () => {
  const seed = () =>
    makeStore({
      accounts: [makeAccount({ id: 'acc_cash', name: 'Cash' })],
      categories: [makeCategory({ id: 'cat_food', name: 'Food' })]
    });

  it('creates, renames, archives, restores and guards deletion', () => {
    const store = seed();
    const accounts = createAccountService({ store });

    const added = accounts.add({ name: 'Bank', type: 'bank', currency: 'BDT', openingBalanceMinor: 500000 });
    expect(added.ok, JSON.stringify(added.errors)).toBe(true);
    expect(store.preferences.defaultAccountId).toBe(added.record.id);

    expect(accounts.update(added.record.id, { name: 'Main Bank' }).ok).toBe(true);
    expect(accounts.get(added.record.id).name).toBe('Main Bank');

    expect(accounts.archive(added.record.id).ok).toBe(true);
    expect(accounts.active().map((a) => a.id)).not.toContain(added.record.id);
    expect(accounts.restore(added.record.id).ok).toBe(true);
    expect(accounts.get(added.record.id).archived).toBe(false);

    // A used account can never be hard-deleted, only archived.
    store.apply('seed-tx', (draft) => {
      draft.transactions = [makeTransaction({ accountId: added.record.id, categoryId: 'cat_food' })];
      return [];
    });
    const removed = accounts.remove(added.record.id);
    expect(removed.ok).toBe(false);
    expect(removed.errors.id).toMatch(/archive/i);
  });

  it('moves money with a transfer and totals net worth per currency', () => {
    const store = makeStore({
      accounts: [
        makeAccount({ id: 'acc_cash', name: 'Cash' }),
        makeAccount({ id: 'acc_savings', name: 'Savings', type: 'savings' }),
        makeAccount({ id: 'acc_usd', name: 'US wallet', currency: 'USD' })
      ]
    });
    const accounts = createAccountService({ store });
    const transactions = createTransactionService({ store });

    // Only same-currency, active accounts are valid transfer targets.
    expect(accounts.transferTargets('acc_cash').map((a) => a.id)).toEqual(['acc_savings']);

    const moved = accounts.transfer({ fromAccountId: 'acc_cash', toAccountId: 'acc_savings', amount: 25000, date: '2026-10-15' }, transactions);
    expect(moved.ok, JSON.stringify(moved.errors)).toBe(true);

    const balances = accounts.balances();
    expect(balances.get('acc_cash')).toBe(-25000);
    expect(balances.get('acc_savings')).toBe(25000);
    expect(accounts.netWorth().get('BDT')).toBe(0);
    expect(accounts.netWorth().get('USD')).toBe(0);
  });
});

/* ------------------------------------------------------------------------- */

describe('categories feature', () => {
  it('builds a tree, rolls totals up and refuses unsafe deletes', () => {
    const store = makeStore({
      accounts: [makeAccount({ id: 'acc_cash' })],
      categories: [makeCategory({ id: 'cat_food', name: 'Food' })]
    });
    const categories = createCategoryService({ store });

    const child = categories.add({ name: 'Groceries', type: 'expense', parentId: 'cat_food' });
    expect(child.ok, JSON.stringify(child.errors)).toBe(true);
    expect(categories.children('cat_food').map((c) => c.id)).toContain(child.record.id);
    expect(categories.descendants('cat_food').map((c) => c.id)).toContain(child.record.id);

    // A duplicate at the same level is rejected.
    expect(categories.add({ name: 'Groceries', type: 'expense', parentId: 'cat_food' }).ok).toBe(false);

    // Parent options exclude the node and its descendants (no cycles).
    const options = categories.parentOptions('expense', 'cat_food').map((o) => o.value);
    expect(options).not.toContain('cat_food');
    expect(options).not.toContain(child.record.id);

    // Spending on the child rolls up into the parent's totals.
    store.apply('seed-tx', (draft) => {
      draft.transactions = [makeTransaction({ categoryId: child.record.id, accountId: 'acc_cash', amountMinor: 4000 })];
      return [];
    });
    expect(categories.stats().get('cat_food').expenseMinor).toBe(4000);

    // A parent with children cannot be deleted; a used leaf must be archived.
    expect(categories.remove('cat_food').ok).toBe(false); // blocked: has a subcategory
    const leafDel = categories.remove(child.record.id);
    expect(leafDel.ok).toBe(false);
    expect(leafDel.errors.id).toMatch(/archive/i);

    expect(categories.archive('cat_food').ok).toBe(true);
    expect(categories.active('expense').map((c) => c.id)).not.toContain('cat_food');
  });
});

/* ------------------------------------------------------------------------- */

describe('budgets feature', () => {
  function setup() {
    const store = makeStore({
      accounts: [makeAccount({ id: 'acc_cash' }), makeAccount({ id: 'acc_savings', type: 'savings' })],
      categories: [
        makeCategory({ id: 'cat_food', name: 'Food' }),
        makeCategory({ id: 'cat_salary', name: 'Salary', type: 'income' })
      ]
    });
    const budgets = createBudgetService({ store });
    const transactions = createTransactionService({ store });
    const added = budgets.add({
      name: 'Food plan',
      period: 'monthly',
      scope: 'category',
      categoryId: 'cat_food',
      limitMinor: 100000,
      currency: 'BDT',
      startDate: '2026-01-01',
      endDate: '2026-12-31',
      alertThresholds: [75, 90, 100]
    });
    expect(added.ok, JSON.stringify(added.errors)).toBe(true);
    return { store, budgets, transactions, budget: added.record };
  }

  const post = (transactions, input) => {
    const result = transactions.add({
      accountId: 'acc_cash',
      paymentMethod: 'cash',
      status: 'posted',
      description: 'x',
      ...input
    });
    expect(result.ok, JSON.stringify(result.errors)).toBe(true);
    return result.record;
  };

  it('counts only posted expenses, ignoring income, transfers and pending rows', () => {
    const { budgets, transactions, budget } = setup();

    post(transactions, { type: 'expense', amountMinor: 60000, categoryId: 'cat_food', date: '2026-10-10' });
    post(transactions, { type: 'expense', amountMinor: 20000, categoryId: 'cat_food', date: '2026-10-12', status: 'pending' });
    post(transactions, { type: 'income', amountMinor: 999999, categoryId: 'cat_salary', date: '2026-10-11' });
    post(transactions, { type: 'transfer', amountMinor: 50000, accountId: 'acc_cash', toAccountId: 'acc_savings', categoryId: null, date: '2026-10-13' });

    const status = budgets.status(budget.id);
    expect(status.spentMinor).toBe(60000);
    expect(status.percent).toBeCloseTo(60, 5);
    expect(status.remainingMinor).toBe(40000);
    expect(status.state).toBe('ok');
  });

  it('raises threshold alerts, pauses/resumes and removes', () => {
    const { budgets, transactions, budget } = setup();
    post(transactions, { type: 'expense', amountMinor: 110000, categoryId: 'cat_food', date: '2026-10-10' });

    const alerts = budgets.alerts();
    expect(alerts).toHaveLength(1);
    expect(alerts[0].level).toBe(100);
    expect(alerts[0].budget.id).toBe(budget.id);

    const remaining = budgets.remainingTotal();
    expect(remaining.remainingMinor).toBe(remaining.limitMinor - remaining.spentMinor);

    // Pausing removes it from today's active set without losing the rule.
    expect(budgets.pause(budget.id).ok).toBe(true);
    expect(budgets.overview()).toHaveLength(0);
    expect(budgets.resume(budget.id).ok).toBe(true);
    expect(budgets.overview()).toHaveLength(1);

    expect(budgets.remove(budget.id).ok).toBe(true);
    expect(budgets.all()).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------------- */

describe('reports feature', () => {
  it('aggregates income, expense, breakdowns and largest transactions', () => {
    const store = makeStore({
      accounts: [makeAccount({ id: 'acc_cash' })],
      categories: [makeCategory({ id: 'cat_food', name: 'Food' }), makeCategory({ id: 'cat_salary', name: 'Salary', type: 'income' })],
      transactions: [
        makeTransaction({ id: 'i1', type: 'income', amountMinor: 500000, categoryId: 'cat_salary', date: '2026-10-05' }),
        makeTransaction({ id: 'e1', type: 'expense', amountMinor: 60000, categoryId: 'cat_food', date: '2026-10-10' }),
        makeTransaction({ id: 'e2', type: 'expense', amountMinor: 20000, categoryId: 'cat_food', date: '2026-09-10' })
      ]
    });
    const reports = createReportService({ store });
    const range = reports.resolveRange('thisMonth', { today: '2026-10-16' });

    const summary = reports.summary(range, 'BDT');
    expect(summary.incomeMinor).toBe(500000);
    expect(summary.expenseMinor).toBe(60000);
    expect(summary.netMinor).toBe(440000);

    const expense = reports.expenseBreakdown(range, 'BDT');
    expect(expense[0].categoryId).toBe('cat_food');
    expect(expense[0].totalMinor).toBe(60000);

    expect(reports.monthly(range, 'BDT').length).toBeGreaterThanOrEqual(1);

    const largest = reports.largest(range, 'BDT', { type: 'expense' });
    expect(largest[0].id).toBe('e1');

    expect(reports.currencies()).toContain('BDT');
  });
});

/* ------------------------------------------------------------------------- */

describe('notifications feature', () => {
  it('surfaces budget breaches, acknowledges them and marks the bell seen', () => {
    const uiPrefs = uiPrefsForTest();
    const store = makeStore({
      accounts: [makeAccount({ id: 'acc_cash' })],
      categories: [makeCategory({ id: 'cat_food' })]
    });
    const budgets = createBudgetService({ store });
    const budget = budgets.add({
      name: 'Food', period: 'monthly', scope: 'category', categoryId: 'cat_food',
      limitMinor: 100000, currency: 'BDT', startDate: '2026-01-01', endDate: '2026-12-31'
    }).record;
    store.apply('seed-tx', (draft) => {
      draft.transactions = [makeTransaction({ amountMinor: 110000, categoryId: 'cat_food', accountId: 'acc_cash', date: '2026-10-10' })];
      return [];
    });

    const notifications = createNotificationService({ store, uiPrefs });
    expect(notifications.alertCount()).toBe(1);
    const alerts = notifications.budgetAlerts();
    expect(alerts[0].level).toBe(100);
    expect(notifications.badgeCount()).toBeGreaterThanOrEqual(1);

    notifications.acknowledge(budget.id, 100);
    expect(notifications.alertCount()).toBe(0);

    notifications.markSeen();
    expect(notifications.seenAt()).toBeTruthy();
  });

  it('counts due recurring occurrences', () => {
    const uiPrefs = uiPrefsForTest();
    const store = makeStore({
      accounts: [makeAccount({ id: 'acc_cash' })],
      categories: [makeCategory({ id: 'cat_rent', name: 'Rent' })]
    });
    const transactions = createTransactionService({ store });
    const recurring = createRecurringService({ store, transactions });

    const added = recurring.add({
      name: 'Rent', type: 'expense', amountMinor: 2000000, currency: 'BDT',
      accountId: 'acc_cash', categoryId: 'cat_rent', frequency: 'monthly',
      intervalCount: 1, startDate: '2026-10-01', nextDueDate: '2026-10-01'
    });
    expect(added.ok, JSON.stringify(added.errors)).toBe(true);

    const notifications = createNotificationService({ store, uiPrefs });
    expect(notifications.dueCount()).toBeGreaterThanOrEqual(1);
    expect(notifications.badgeCount()).toBeGreaterThanOrEqual(1);
  });
});

/* ------------------------------------------------------------------------- */

describe('export rows feature', () => {
  it('builds named, header-aligned CSV rows for every resource', () => {
    const categories = [makeCategory({ id: 'cat_food', name: 'Food' })];
    const accounts = [makeAccount({ id: 'acc_cash', name: 'Cash' })];

    const [catHeader, catRow] = categoryRows(categories);
    expect(catHeader).toEqual(CATEGORY_HEADERS);
    expect(catRow[catHeader.indexOf('name')]).toBe('Food');

    const [accHeader, accRow] = accountRows(accounts, new Map([['acc_cash', 12345]]));
    expect(accHeader).toEqual(ACCOUNT_HEADERS);
    expect(accRow[accHeader.indexOf('balanceMinor')]).toBe(12345);

    const budget = {
      id: 'b1', name: 'Food', period: 'monthly', scope: 'category', categoryId: 'cat_food',
      limitMinor: 100000, currency: 'BDT', startDate: '2026-01-01', endDate: '2026-12-31',
      alertThresholds: [75], status: 'active', archived: false, createdAt: '', updatedAt: ''
    };
    const [budgetHeader, budgetRow] = budgetRows([{ budget, status: { spentMinor: 5000, percent: 5 } }], { categories });
    expect(budgetHeader).toEqual(BUDGET_HEADERS);
    expect(budgetRow[budgetHeader.indexOf('spentMinor')]).toBe(5000);

    const goal = {
      id: 'g1', name: 'Trip', targetMinor: 100000, savedMinor: 25000, currency: 'BDT',
      targetDate: '2026-12-31', accountId: 'acc_cash', status: 'active', archived: false, createdAt: '', updatedAt: ''
    };
    const [goalHeader, goalRow] = goalRows([{ goal, progress: { percent: 25, remainingMinor: 75000 } }], { accounts });
    expect(goalHeader).toEqual(GOAL_HEADERS);
    expect(goalRow[goalHeader.indexOf('remainingMinor')]).toBe(75000);

    const rule = {
      id: 'r1', name: 'Rent', type: 'expense', amountMinor: 20000, currency: 'BDT',
      categoryId: 'cat_food', accountId: 'acc_cash', toAccountId: null, frequency: 'monthly',
      intervalCount: 1, startDate: '2026-01-01', nextDueDate: '2026-11-01', endDate: null,
      status: 'active', notes: '', createdAt: '', updatedAt: ''
    };
    const [ruleHeader, ruleRow] = recurringRows([{ rule, monthlyEquivalentMinor: 20000 }], { categories, accounts });
    expect(ruleHeader).toEqual(RECURRING_HEADERS);
    expect(ruleRow[ruleHeader.indexOf('monthlyEquivalentMinor')]).toBe(20000);
  });
});

/* ------------------------------------------------------------------------- */

describe('backup & restore feature', () => {
  it('round-trips a backup through serialize, parse and restore', () => {
    const store = makeStore({
      accounts: [makeAccount({ id: 'acc_cash' })],
      categories: [makeCategory({ id: 'cat_food' })],
      transactions: [makeTransaction({ id: 't1' })]
    });

    const envelope = buildBackup(store.get(), { note: 'unit test' });
    expect(envelope.format).toBe('spendwise-backup');
    expect(summarizeBackup(envelope).counts.transactions).toBe(1);

    const parsed = parseBackupJson(serializeBackup(store.get()));
    expect(parsed.ok).toBe(true);
    expect(parsed.meta.counts.transactions).toBe(1);

    // Wipe, then restore from the parsed backup.
    store.replaceState({ ...store.get(), transactions: [] }, 'wipe');
    expect(store.list(RESOURCES.TRANSACTIONS)).toHaveLength(0);

    const outcome = restoreState(store, parsed.state);
    expect(outcome.after.transactions).toBe(1);
    expect(store.list(RESOURCES.TRANSACTIONS)).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------------- */

describe('preferences feature', () => {
  it('persists a preference patch through the store', () => {
    const store = makeStore();
    store.apply('preferences:update', (draft) => {
      draft.preferences = { ...draft.preferences, currency: 'USD', density: 'compact', defaultRange: 'last3Months' };
      return [{ resource: RESOURCES.PREFERENCES, op: 'upsert', record: draft.preferences }];
    });
    expect(store.preferences.currency).toBe('USD');
    expect(store.preferences.density).toBe('compact');
    expect(store.preferences.defaultRange).toBe('last3Months');
  });
});
