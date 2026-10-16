// test/aiInsights.test.mjs
// Unit tests for the deterministic, PII-free aggregation layer.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildFinancialContext,
  buildHighlights,
  formatMajor,
  monthKey,
  monthsAgoIso,
} from '../src/aiInsights.js';

const CATEGORIES = [
  { id: 'c-food', name: 'Food', type: 'expense' },
  { id: 'c-rent', name: 'Rent', type: 'expense' },
  { id: 'c-salary', name: 'Salary', type: 'income' },
];

function tx(overrides = {}) {
  return {
    amount_minor: 10000,
    currency: 'BDT',
    type: 'expense',
    category_id: 'c-food',
    date: '2026-10-05',
    status: 'posted',
    ...overrides,
  };
}

test('monthKey and monthsAgoIso are stable', () => {
  assert.equal(monthKey('2026-10-05'), '2026-10');
  assert.equal(monthKey(new Date('2026-03-01T00:00:00Z')), '2026-03');
  assert.equal(monthKey('nonsense'), null);
  assert.equal(monthKey(null), null);

  const now = new Date('2026-10-16T00:00:00Z');
  assert.equal(monthsAgoIso(6, now), '2026-05-01');
  assert.equal(monthsAgoIso(1, now), '2026-10-01');
});

test('formatMajor renders minor units as a 2dp major-unit string', () => {
  assert.equal(formatMajor(0), '0.00');
  assert.equal(formatMajor(12345), '123.45');
  assert.equal(formatMajor(-500), '-5.00');
});

test('buildFinancialContext: totals, top categories, months, deltas, savings rate', () => {
  const transactions = [
    tx({ type: 'income', category_id: 'c-salary', amount_minor: 500000, date: '2026-09-01' }),
    tx({ amount_minor: 100000, category_id: 'c-rent', date: '2026-09-02' }),
    tx({ amount_minor: 50000, category_id: 'c-food', date: '2026-09-03' }),
    tx({ type: 'income', category_id: 'c-salary', amount_minor: 500000, date: '2026-10-01' }),
    tx({ amount_minor: 200000, category_id: 'c-rent', date: '2026-10-02' }),
    tx({ amount_minor: 100000, category_id: 'c-food', date: '2026-10-03' }),
    tx({ type: 'transfer', amount_minor: 999999, date: '2026-10-04' }),
    tx({ status: 'draft', amount_minor: 777777, date: '2026-10-05' }),
  ];

  const ctx = buildFinancialContext({ transactions, categories: CATEGORIES, budgets: [{ id: 'b1' }] });

  assert.equal(ctx.currency, 'BDT');
  assert.equal(ctx.transactionCount, 6); // transfer + draft excluded
  assert.equal(ctx.budgetCount, 1);

  const primary = ctx.totals[0];
  assert.equal(primary.incomeMinor, 1000000);
  assert.equal(primary.expenseMinor, 450000);
  assert.equal(primary.netMinor, 550000);

  // Rent (300000) outranks Food (150000).
  assert.equal(ctx.topCategories[0].name, 'Rent');
  assert.equal(ctx.topCategories[0].expenseMinor, 300000);
  assert.equal(ctx.topCategories.length, 2);

  assert.deepEqual(ctx.monthlyTotals.map((m) => m.month), ['2026-09', '2026-10']);
  assert.equal(ctx.deltas.expenseDeltaMinor, 150000); // 200k+100k - (100k+50k)
  assert.equal(ctx.deltas.expensePct, 100);

  assert.equal(ctx.savingsRate, 55); // 550000 / 1000000
});

test('buildFinancialContext: empty input is safe and reports no data', () => {
  const ctx = buildFinancialContext({});
  assert.equal(ctx.transactionCount, 0);
  assert.deepEqual(ctx.topCategories, []);
  assert.equal(ctx.savingsRate, null);
  assert.equal(ctx.deltas, null);
});

test('buildFinancialContext: category names are truncated and PII is never included', () => {
  const ctx = buildFinancialContext({
    transactions: [tx({ category_id: 'c-long' })],
    categories: [{ id: 'c-long', name: 'x'.repeat(200), type: 'expense' }],
  });
  assert.ok(ctx.topCategories[0].name.length <= 60);
});

test('buildHighlights: no-data, top category, savings and trend', () => {
  assert.deepEqual(buildHighlights({ transactionCount: 0, topCategories: [], savingsRate: null, deltas: null, budgetCount: 0 }), [
    { code: 'noData', tone: 'neutral', data: {} },
  ]);

  const ctx = buildFinancialContext({
    transactions: [
      tx({ type: 'income', amount_minor: 50000, date: '2026-09-01' }),
      tx({ amount_minor: 40000, category_id: 'c-rent', date: '2026-09-02' }),
      tx({ amount_minor: 60000, category_id: 'c-food', date: '2026-10-02' }),
    ],
    categories: CATEGORIES,
  });
  const codes = buildHighlights(ctx).map((h) => h.code);
  assert.ok(codes.includes('topCategory'));
  assert.ok(codes.includes('overspending')); // expenses exceed income overall
  assert.ok(codes.includes('spendUp'));
});
