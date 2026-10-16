/**
 * Business-rule tests for the pure calculation layer.
 *
 * These encode the four documented money rules: posted-only reporting,
 * transfers never income/expense, refunds are income, and no cross-currency
 * maths.
 */

import { describe, it, expect } from 'vitest';
import {
  periodSummary,
  eligibleTransactions,
  accountBalance,
  netWorthByCurrency,
  accountBalanceLabelMinor,
  categoryBreakdown,
  monthlyCashflow,
  budgetStatus,
  budgetAlerts,
  goalProgress,
  advanceDueDate,
  recurringDueDates,
  pendingOccurrences,
  recurringMonthlyEquivalent,
  transactionFingerprint,
  findDuplicates,
  isCountable
} from '../src/utils/calculations.js';
import { makeAccount, makeCategory, makeTransaction } from './helpers.js';

const TODAY = '2026-10-15';

describe('periodSummary', () => {
  const transactions = [
    makeTransaction({ id: 'a', type: 'income', amountMinor: 500000, date: '2026-10-02', categoryId: 'cat_salary' }),
    makeTransaction({ id: 'b', type: 'expense', amountMinor: 120000, date: '2026-10-03' }),
    makeTransaction({ id: 'c', type: 'expense', amountMinor: 80000, date: '2026-10-04' }),
    // Excluded: pending
    makeTransaction({ id: 'd', type: 'expense', amountMinor: 999999, date: '2026-10-05', status: 'pending' }),
    // Excluded: transfer
    makeTransaction({ id: 'e', type: 'transfer', amountMinor: 250000, date: '2026-10-06', toAccountId: 'acc_savings' })
  ];

  it('counts posted income and expenses only', () => {
    const summary = periodSummary(transactions);
    expect(summary.incomeMinor).toBe(500000);
    expect(summary.expenseMinor).toBe(200000);
    expect(summary.netMinor).toBe(300000);
    expect(summary.pendingCount).toBe(0);
    expect(summary.incomeCount).toBe(1);
    expect(summary.expenseCount).toBe(2);
  });

  it('never treats a transfer as income or expense', () => {
    const summary = periodSummary(transactions);
    expect(summary.incomeMinor).toBe(500000);
    expect(summary.expenseMinor).toBe(200000);
    // Explicitly including pending pulls the pending expense in, but a transfer
    // still contributes to neither side of the ledger.
    const withPending = periodSummary(transactions, { includePending: true });
    expect(withPending.pendingCount).toBe(1);
    expect(withPending.expenseMinor).toBe(1199999);
    expect(withPending.incomeMinor).toBe(500000);
  });

  it('treats a refund (income) as income and does not reduce expenses', () => {
    const withRefund = [
      makeTransaction({ id: 'x', type: 'expense', amountMinor: 100000, date: '2026-10-10' }),
      makeTransaction({ id: 'y', type: 'income', amountMinor: 30000, date: '2026-10-11', categoryId: 'cat_refunds' })
    ];
    const summary = periodSummary(withRefund);
    expect(summary.expenseMinor).toBe(100000);
    expect(summary.incomeMinor).toBe(30000);
    expect(summary.netMinor).toBe(-70000);
  });

  it('reports savings rate as null when there is no income', () => {
    const summary = periodSummary([makeTransaction({ amountMinor: 5000 })]);
    expect(summary.savingsRate).toBeNull();
  });

  it('honours inclusive date bounds', () => {
    const rows = [
      makeTransaction({ id: 'p', date: '2026-09-30', amountMinor: 100 }),
      makeTransaction({ id: 'q', date: '2026-10-01', amountMinor: 200 }),
      makeTransaction({ id: 'r', date: '2026-10-31', amountMinor: 400 }),
      makeTransaction({ id: 's', date: '2026-11-01', amountMinor: 800 })
    ];
    const summary = periodSummary(rows, { from: '2026-10-01', to: '2026-10-31' });
    expect(summary.expenseMinor).toBe(600);
  });
});

describe('currency isolation', () => {
  it('never sums different currencies together', () => {
    const rows = [
      makeTransaction({ id: 'bdt', amountMinor: 100000, currency: 'BDT' }),
      makeTransaction({ id: 'usd', amountMinor: 5000, currency: 'USD' })
    ];
    expect(periodSummary(rows, { currency: 'BDT' }).expenseMinor).toBe(100000);
    expect(periodSummary(rows, { currency: 'USD' }).expenseMinor).toBe(5000);
    // Reporting callers always pass a currency so totals never cross-sum.
    expect(periodSummary(rows, { currency: 'EUR' }).expenseMinor).toBe(0);
  });

  it('eligibleTransactions filters by currency', () => {
    const rows = [
      makeTransaction({ id: 'bdt', currency: 'BDT' }),
      makeTransaction({ id: 'usd', currency: 'USD' })
    ];
    expect(eligibleTransactions(rows, { currency: 'USD' })).toHaveLength(1);
  });
});

describe('accountBalance', () => {
  it('computes opening + inflow − outflow', () => {
    const account = makeAccount({ id: 'acc_cash', openingBalanceMinor: 100000 });
    const transactions = [
      makeTransaction({ id: 'i', type: 'income', amountMinor: 50000, accountId: 'acc_cash' }),
      makeTransaction({ id: 'e', type: 'expense', amountMinor: 20000, accountId: 'acc_cash' })
    ];
    expect(accountBalance(account, transactions)).toBe(130000);
  });

  it('moves value between accounts for a transfer in both directions', () => {
    const cash = makeAccount({ id: 'acc_cash' });
    const savings = makeAccount({ id: 'acc_savings', name: 'Savings', type: 'savings' });
    const transfer = makeTransaction({
      id: 't', type: 'transfer', amountMinor: 40000, accountId: 'acc_cash', toAccountId: 'acc_savings', categoryId: null
    });
    expect(accountBalance(cash, [transfer])).toBe(-40000);
    expect(accountBalance(savings, [transfer])).toBe(40000);
  });

  it('ignores transactions in another currency', () => {
    const account = makeAccount({ currency: 'BDT' });
    const transactions = [makeTransaction({ id: 'usd', currency: 'USD', amountMinor: 999999 })];
    expect(accountBalance(account, transactions)).toBe(0);
  });

  it('lets a credit card balance go negative and labels it as debt', () => {
    const card = makeAccount({ id: 'acc_card', type: 'credit_card', name: 'Visa' });
    const transactions = [makeTransaction({ id: 'e', type: 'expense', amountMinor: 75000, accountId: 'acc_card' })];
    const balance = accountBalance(card, transactions);
    expect(balance).toBe(-75000);
    expect(accountBalanceLabelMinor(card, balance)).toMatchObject({ liability: true, isDebt: true });
  });

  it('excludes pending transactions from balances', () => {
    const account = makeAccount();
    const transactions = [makeTransaction({ id: 'p', amountMinor: 10000, status: 'pending' })];
    expect(accountBalance(account, transactions)).toBe(0);
    expect(accountBalance(account, transactions, { includePending: true })).toBe(-10000);
  });

  it('aggregates net worth per currency', () => {
    const accounts = [makeAccount({ id: 'a', currency: 'BDT', openingBalanceMinor: 100000 }), makeAccount({ id: 'b', currency: 'USD', openingBalanceMinor: 5000 })];
    const totals = netWorthByCurrency(accounts, []);
    expect(totals.get('BDT')).toBe(100000);
    expect(totals.get('USD')).toBe(5000);
  });
});

describe('categoryBreakdown', () => {
  it('aggregates posted expenses and computes share', () => {
    const categories = [
      makeCategory({ id: 'cat_food', name: 'Food' }),
      makeCategory({ id: 'cat_transport', name: 'Transport' })
    ];
    const transactions = [
      makeTransaction({ id: '1', amountMinor: 7500, categoryId: 'cat_food' }),
      makeTransaction({ id: '2', amountMinor: 2500, categoryId: 'cat_transport' }),
      makeTransaction({ id: '3', amountMinor: 9999, categoryId: 'cat_food', status: 'pending' })
    ];
    const rows = categoryBreakdown(transactions, categories, { type: 'expense' });
    expect(rows[0]).toMatchObject({ categoryId: 'cat_food', totalMinor: 7500, share: 75 });
    expect(rows[1]).toMatchObject({ categoryId: 'cat_transport', totalMinor: 2500, share: 25 });
  });

  it('labels missing categories without losing history', () => {
    const rows = categoryBreakdown([makeTransaction({ categoryId: 'cat_gone' })], [], { type: 'expense' });
    expect(rows[0].name).toBe('Deleted category');
  });
});

describe('monthlyCashflow', () => {
  it('buckets by month with a running cumulative balance', () => {
    const transactions = [
      makeTransaction({ id: '1', type: 'income', amountMinor: 100000, date: '2026-01-10', categoryId: 'cat_salary' }),
      makeTransaction({ id: '2', type: 'expense', amountMinor: 40000, date: '2026-01-20' }),
      makeTransaction({ id: '3', type: 'expense', amountMinor: 30000, date: '2026-02-05' })
    ];
    const rows = monthlyCashflow(transactions, { from: '2026-01-01', to: '2026-02-28' });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ month: '2026-01', netMinor: 60000, cumulativeMinor: 60000 });
    expect(rows[1]).toMatchObject({ month: '2026-02', netMinor: -30000, cumulativeMinor: 30000 });
  });
});

describe('budgets', () => {
  const categories = [
    makeCategory({ id: 'cat_food', name: 'Food' }),
    makeCategory({ id: 'cat_groceries', name: 'Groceries', parentId: 'cat_food' }),
    makeCategory({ id: 'cat_transport', name: 'Transport' })
  ];
  const budget = {
    id: 'bud_food',
    name: 'Food budget',
    period: 'monthly',
    scope: 'category',
    categoryId: 'cat_food',
    limitMinor: 100000,
    currency: 'BDT',
    startDate: '2026-01-01',
    endDate: '2026-12-31',
    alertThresholds: [75, 90, 100],
    status: 'active',
    archived: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  };

  const transactions = [
    makeTransaction({ id: '1', amountMinor: 60000, categoryId: 'cat_food', date: '2026-10-02' }),
    makeTransaction({ id: '2', amountMinor: 30000, categoryId: 'cat_groceries', date: '2026-10-03' }),
    makeTransaction({ id: '3', amountMinor: 500000, categoryId: 'cat_transport', date: '2026-10-04' }),
    makeTransaction({ id: '4', amountMinor: 500000, categoryId: 'cat_food', date: '2026-10-05', status: 'pending' }),
    makeTransaction({ id: '5', type: 'income', amountMinor: 900000, categoryId: 'cat_salary', date: '2026-10-06' })
  ];

  it('counts subcategory spending but only posted expenses in the window', () => {
    const status = budgetStatus(budget, transactions, { today: TODAY, categories });
    expect(status.spentMinor).toBe(90000);
    expect(status.percent).toBe(90);
    expect(status.state).toBe('danger');
    expect(status.window).toEqual({ from: '2026-10-01', to: '2026-10-31', period: 'monthly' });
  });

  it('returns null when the budget is inactive or outside its date range', () => {
    expect(budgetStatus({ ...budget, status: 'paused' }, transactions, { today: TODAY, categories })).toBeNull();
    expect(budgetStatus({ ...budget, endDate: '2026-09-30' }, transactions, { today: TODAY, categories })).toBeNull();
  });

  it('raises one deduplicated alert per crossed threshold', () => {
    const alerts = budgetAlerts([budget], transactions, { today: TODAY, categories });
    expect(alerts).toHaveLength(1);
    expect(alerts[0].level).toBe(90);

    const dismissed = budgetAlerts([budget], transactions, {
      today: TODAY, categories, acknowledged: { bud_food: 90 }
    });
    expect(dismissed).toHaveLength(0);
  });
});

describe('goals', () => {
  it('computes progress, remaining amount and required monthly saving', () => {
    const goal = { targetMinor: 100000, savedMinor: 25000, targetDate: '2026-12-31', status: 'active' };
    const progress = goalProgress(goal, { today: TODAY });
    expect(progress.percent).toBe(25);
    expect(progress.remainingMinor).toBe(75000);
    expect(progress.daysLeft).toBe(77);
    expect(progress.monthsLeft).toBe(3);
    expect(progress.requiredMonthlyMinor).toBe(25000);
    expect(progress.onTrack).toBe(false);
  });

  it('caps the percentage at 100', () => {
    expect(goalProgress({ targetMinor: 1000, savedMinor: 5000 }).percent).toBe(100);
  });
});

describe('recurring rules', () => {
  it('advances monthly due dates without drifting past short months', () => {
    expect(advanceDueDate('2026-01-31', 'monthly', 1)).toBe('2026-02-28');
    expect(advanceDueDate('2026-01-15', 'weekly', 2)).toBe('2026-01-29');
    expect(advanceDueDate('2026-01-15', 'yearly', 1)).toBe('2027-01-15');
  });

  it('lists every occurrence up to a date', () => {
    const rule = { id: 'rule1', status: 'active', frequency: 'monthly', intervalCount: 1, nextDueDate: '2026-01-15' };
    expect(recurringDueDates(rule, { untilISO: '2026-04-15' })).toEqual([
      '2026-01-15', '2026-02-15', '2026-03-15', '2026-04-15'
    ]);
  });

  it('produces an idempotency key per rule and due date', () => {
    const rule = { id: 'rule1', status: 'active', frequency: 'monthly', intervalCount: 1, nextDueDate: '2026-10-01' };
    const existing = [makeTransaction({ id: 'x', occurrenceKey: 'rule1:2026-10-01' })];
    const queue = pendingOccurrences([rule], existing, { today: '2026-10-01' });
    expect(queue).toHaveLength(0);
  });

  it('computes a monthly equivalent for planning', () => {
    expect(recurringMonthlyEquivalent({ amountMinor: 120000, frequency: 'monthly', intervalCount: 1 })).toBe(120000);
    expect(recurringMonthlyEquivalent({ amountMinor: 120000, frequency: 'yearly', intervalCount: 1 })).toBe(10000);
    expect(recurringMonthlyEquivalent({ amountMinor: 1200, frequency: 'weekly', intervalCount: 1 })).toBe(5200);
  });
});

describe('duplicate detection', () => {
  it('fingerprints the identifying fields', () => {
    const tx = makeTransaction({ type: 'expense', date: '2026-10-01', amountMinor: 5000, description: 'Coffee', accountId: 'acc_cash', categoryId: 'cat_food' });
    expect(transactionFingerprint(tx)).toBe('expense|2026-10-01|5000|coffee|acc_cash|cat_food');
  });

  it('finds near-identical transactions within the day window', () => {
    const existing = [makeTransaction({ id: 'e1', date: '2026-10-01', amountMinor: 5000, description: 'Coffee' })];
    const candidate = makeTransaction({ id: 'new', date: '2026-10-01', amountMinor: 5000, description: 'coffee' });
    expect(findDuplicates(existing, candidate)).toHaveLength(1);
    const farAway = makeTransaction({ id: 'new', date: '2026-10-09', amountMinor: 5000, description: 'coffee' });
    expect(findDuplicates(existing, farAway)).toHaveLength(0);
  });
});

describe('isCountable', () => {
  it('accepts posted always and pending only on request', () => {
    expect(isCountable({ status: 'posted' })).toBe(true);
    expect(isCountable({ status: 'pending' })).toBe(false);
    expect(isCountable({ status: 'pending' }, { includePending: true })).toBe(true);
    expect(isCountable({ status: 'draft' }, { includePending: true })).toBe(false);
    expect(isCountable(null)).toBe(false);
  });
});
