/**
 * Domain-service tests. These exercise the real `store.apply` mutation path so
 * that persistence-shaped change lists and cross-entity effects are covered.
 */

import { describe, it, expect } from 'vitest';
import { createTransactionService, filterTransactions, sortTransactions, paginate } from '../src/modules/transactions/transactionService.js';
import { createRecurringService } from '../src/modules/recurring/recurringService.js';
import { createGoalService } from '../src/modules/goals/goalService.js';
import { accountBalance } from '../src/utils/calculations.js';
import { makeStore, makeAccount, makeCategory, makeTransaction } from './helpers.js';

function baseState() {
  return {
    accounts: [
      makeAccount({ id: 'acc_cash', name: 'Cash', type: 'cash' }),
      makeAccount({ id: 'acc_savings', name: 'Savings', type: 'savings' })
    ],
    categories: [
      makeCategory({ id: 'cat_food', name: 'Food', type: 'expense' }),
      makeCategory({ id: 'cat_rent', name: 'Rent', type: 'expense' }),
      makeCategory({ id: 'cat_salary', name: 'Salary', type: 'income' })
    ]
  };
}

describe('transactionService', () => {
  it('adds, updates, duplicates and removes a transaction', () => {
    const store = makeStore(baseState());
    const service = createTransactionService({ store });

    const added = service.add({
      type: 'expense', amountMinor: 5000, accountId: 'acc_cash', categoryId: 'cat_food', date: '2026-10-15', description: 'Lunch'
    });
    expect(added.ok).toBe(true);
    expect(store.list('transactions')).toHaveLength(1);

    const updated = service.update(added.record.id, { amountMinor: 7500 });
    expect(updated.ok).toBe(true);
    expect(updated.record.amountMinor).toBe(7500);

    const copy = service.duplicate(added.record.id, { date: '2026-10-16' });
    expect(copy.ok).toBe(true);
    expect(copy.record.id).not.toBe(added.record.id);
    expect(store.list('transactions')).toHaveLength(2);

    const removed = service.remove(added.record.id);
    expect(removed.ok).toBe(true);
    expect(store.list('transactions')).toHaveLength(1);
  });

  it('rejects an invalid transaction without mutating state', () => {
    const store = makeStore(baseState());
    const service = createTransactionService({ store });
    const result = service.add({ type: 'expense', amountMinor: 5000, accountId: 'acc_cash', categoryId: null, date: '2026-10-15' });
    expect(result.ok).toBe(false);
    expect(store.list('transactions')).toHaveLength(0);
  });

  it('bulk deletes and bulk updates in a single mutation', () => {
    const store = makeStore({
      ...baseState(),
      transactions: [
        makeTransaction({ id: 'a', type: 'expense', amountMinor: 1000, date: '2026-10-01' }),
        makeTransaction({ id: 'b', type: 'expense', amountMinor: 2000, date: '2026-10-02' })
      ]
    });
    const service = createTransactionService({ store });

    service.bulkUpdate(['a', 'b'], { status: 'pending' });
    expect(store.list('transactions').every((tx) => tx.status === 'pending')).toBe(true);

    const result = service.removeMany(['a']);
    expect(result.removed).toBe(1);
    expect(store.list('transactions').map((tx) => tx.id)).toEqual(['b']);
  });

  it('queries with filters, sorting and paging', () => {
    const store = makeStore({
      ...baseState(),
      transactions: [
        makeTransaction({ id: 'a', amountMinor: 1000, date: '2026-10-01', description: 'Coffee' }),
        makeTransaction({ id: 'b', amountMinor: 9000, date: '2026-10-05', description: 'Groceries' }),
        makeTransaction({ id: 'c', type: 'income', amountMinor: 500000, categoryId: 'cat_salary', date: '2026-10-06', description: 'Salary' })
      ]
    });
    const service = createTransactionService({ store });

    const expenses = service.query({ type: 'expense', sort: 'amount-desc' });
    expect(expenses.rows.map((tx) => tx.id)).toEqual(['b', 'a']);
    expect(expenses.totals.expenseMinor).toBe(10000);

    const search = service.query({ q: 'grocer' });
    expect(search.rows.map((tx) => tx.id)).toEqual(['b']);

    const paged = service.query({ pageSize: 2, page: 2 });
    expect(paged.page).toBe(2);
    expect(paged.rows).toHaveLength(1);
  });
});

describe('pure list helpers', () => {
  it('filters by tags, amount range and status', () => {
    const rows = [
      makeTransaction({ id: 'a', amountMinor: 1000, tags: ['food'], status: 'posted' }),
      makeTransaction({ id: 'b', amountMinor: 9000, tags: ['travel'], status: 'pending' }),
      makeTransaction({ id: 'c', amountMinor: 5000, tags: ['food', 'travel'], status: 'posted' })
    ];
    expect(filterTransactions(rows, { tags: ['food'], status: 'posted' }).map((t) => t.id)).toEqual(['a', 'c']);
    expect(filterTransactions(rows, { min: '20', max: '60' }).map((t) => t.id)).toEqual(['c']);
  });

  it('sorts and paginates deterministically', () => {
    const rows = [makeTransaction({ id: 'a', date: '2026-10-01' }), makeTransaction({ id: 'b', date: '2026-10-03' })];
    expect(sortTransactions(rows, 'date-asc').map((t) => t.id)).toEqual(['a', 'b']);
    const page = paginate([1, 2, 3, 4, 5], 2, 2);
    expect(page).toMatchObject({ slice: [3, 4], pages: 3, page: 2, from: 3, to: 4 });
  });
});

describe('recurringService', () => {
  function setup() {
    const store = makeStore(baseState());
    const transactions = createTransactionService({ store });
    const service = createRecurringService({ store, transactions });
    return { store, service };
  }

  const ruleInput = {
    name: 'Rent',
    type: 'expense',
    amountMinor: 2000000,
    currency: 'BDT',
    accountId: 'acc_cash',
    categoryId: 'cat_rent',
    frequency: 'monthly',
    intervalCount: 1,
    startDate: '2026-10-01',
    nextDueDate: '2026-10-01'
  };

  it('creates a rule and lists what is due', () => {
    const { service } = setup();
    const added = service.add(ruleInput);
    expect(added.ok).toBe(true);
    const due = service.due({ today: '2026-10-15' });
    expect(due).toHaveLength(1);
    expect(due[0].dueDate).toBe('2026-10-01');
  });

  it('posts an occurrence exactly once and advances the rule', () => {
    const { store, service } = setup();
    const added = service.add(ruleInput);

    const posted = service.post({ rule: added.record, dueDate: '2026-10-01' });
    expect(posted.ok).toBe(true);
    expect(posted.record.occurrenceKey).toBe(`${added.record.id}:2026-10-01`);
    expect(store.list('transactions')).toHaveLength(1);
    expect(service.get(added.record.id).nextDueDate).toBe('2026-11-01');

    const again = service.post({ rule: added.record, dueDate: '2026-10-01' });
    expect(again.ok).toBe(false);
    expect(again.duplicate).toBe(true);
    expect(store.list('transactions')).toHaveLength(1);
  });

  it('posts every due occurrence and skips an occurrence without posting', () => {
    const { store, service } = setup();
    service.add({ ...ruleInput, startDate: '2026-09-01', nextDueDate: '2026-09-01' });
    const results = service.postAll({ today: '2026-10-15' });
    expect(results.posted).toBe(2); // Sep + Oct
    expect(store.list('transactions')).toHaveLength(2);

    service.add({ ...ruleInput, name: 'Gym', startDate: '2026-10-05', nextDueDate: '2026-10-05' });
    const skipTarget = service.due({ today: '2026-10-15' }).find((item) => item.rule.name === 'Gym');
    const skipped = service.skip(skipTarget);
    expect(skipped.ok).toBe(true);
    expect(service.get(skipped.record.id).nextDueDate).toBe('2026-11-05');
    expect(service.due({ today: '2026-10-15' })).toHaveLength(0);
  });

  it('reports a monthly equivalent and upcoming occurrences', () => {
    const { service } = setup();
    const added = service.add({ ...ruleInput, frequency: 'yearly', amountMinor: 1200000 });
    expect(service.monthlyEquivalent(added.record)).toBe(100000);
    const upcoming = service.upcoming({ days: 400, today: '2026-10-15' });
    expect(upcoming.length).toBeGreaterThanOrEqual(1);
  });
});

describe('goalService', () => {
  function setup() {
    const store = makeStore(baseState());
    const transactions = createTransactionService({ store });
    const service = createGoalService({ store, transactions });
    return { store, service };
  }

  const goalInput = { name: 'Trip', targetMinor: 100000, savedMinor: 0, currency: 'BDT', accountId: 'acc_savings' };

  it('records a contribution and a paired transfer atomically', () => {
    const { store, service } = setup();
    const goal = service.add(goalInput).record;

    const result = service.contribute({ goal: goal.id, amountMinor: 25000, sourceAccountId: 'acc_cash', direction: 'contribution', date: '2026-10-15' });
    expect(result.ok).toBe(true);
    expect(service.get(goal.id).savedMinor).toBe(25000);

    const transfers = store.list('transactions');
    expect(transfers).toHaveLength(1);
    expect(transfers[0]).toMatchObject({ type: 'transfer', amountMinor: 25000, accountId: 'acc_cash', toAccountId: 'acc_savings', categoryId: null });

    // The transfer moves money without inventing income or expense.
    expect(accountBalance(store.byId('accounts', 'acc_cash'), transfers)).toBe(-25000);
    expect(accountBalance(store.byId('accounts', 'acc_savings'), transfers)).toBe(25000);
  });

  it('records a ledger-only contribution when no funding account is set', () => {
    const { store, service } = setup();
    const goal = service.add(goalInput).record;
    const result = service.contribute({ goal: goal.id, amountMinor: 10000, direction: 'contribution', date: '2026-10-15' });
    expect(result.ok).toBe(true);
    expect(result.transfer).toBeNull();
    expect(store.list('transactions')).toHaveLength(0);
    expect(service.get(goal.id).savedMinor).toBe(10000);
  });

  it('cannot withdraw more than is saved', () => {
    const { service } = setup();
    const goal = service.add({ ...goalInput, savedMinor: 5000 }).record;
    const result = service.contribute({ goal: goal.id, amountMinor: 9000, direction: 'withdrawal', date: '2026-10-15' });
    expect(result.ok).toBe(false);
    expect(result.errors.amount).toMatch(/at most/);
  });

  it('reverses a contribution and removes its paired transfer', () => {
    const { store, service } = setup();
    const goal = service.add(goalInput).record;
    const contributed = service.contribute({ goal: goal.id, amountMinor: 25000, sourceAccountId: 'acc_cash', direction: 'contribution', date: '2026-10-15' });

    const reversed = service.removeContribution(goal.id, contributed.contribution.id);
    expect(reversed.ok).toBe(true);
    expect(service.get(goal.id).savedMinor).toBe(0);
    expect(store.list('transactions')).toHaveLength(0);
  });
});
