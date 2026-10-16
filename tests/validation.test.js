/**
 * Validation layer. Every validator returns `{ok, value, errors, warnings}`
 * and normalises the record even on failure.
 */

import { describe, it, expect } from 'vitest';
import {
  validateTransaction,
  validateAccount,
  validateCategory,
  validateBudget,
  validateGoal,
  validateContribution,
  validatePreferences,
  coerceAmount,
  coerceSignedAmount,
  normalizeTags,
  parseTagInput,
  parseBooleanish,
  categoryDepth
} from '../src/utils/validation.js';
import { makeAccount, makeCategory, makeTransaction } from './helpers.js';

const accounts = [
  makeAccount({ id: 'acc_cash', name: 'Cash', currency: 'BDT' }),
  makeAccount({ id: 'acc_savings', name: 'Savings', type: 'savings', currency: 'BDT' }),
  makeAccount({ id: 'acc_usd', name: 'USD wallet', currency: 'USD' })
];
const categories = [
  makeCategory({ id: 'cat_food', name: 'Food', type: 'expense' }),
  makeCategory({ id: 'cat_salary', name: 'Salary', type: 'income' })
];

describe('coerceAmount', () => {
  it('accepts positive integers and loose decimal strings', () => {
    expect(coerceAmount(5000)).toEqual({ ok: true, minor: 5000 });
    expect(coerceAmount('1,250.50', 'BDT')).toMatchObject({ ok: true, minor: 125050 });
  });

  it('rejects zero, negatives and junk', () => {
    expect(coerceAmount(0).ok).toBe(false);
    expect(coerceAmount(-5).ok).toBe(false);
    expect(coerceAmount('abc').ok).toBe(false);
    expect(coerceAmount('').ok).toBe(false);
  });
});

describe('coerceSignedAmount', () => {
  it('keeps the sign and defaults empty input to zero', () => {
    expect(coerceSignedAmount('-50', 'BDT')).toEqual({ ok: true, minor: -5000 });
    expect(coerceSignedAmount('', 'BDT')).toEqual({ ok: true, minor: 0 });
    expect(coerceSignedAmount(250000)).toEqual({ ok: true, minor: 250000 });
  });
});

describe('validateTransaction', () => {
  const base = { type: 'expense', amountMinor: 5000, accountId: 'acc_cash', categoryId: 'cat_food', date: '2026-10-15' };

  it('accepts a well-formed expense', () => {
    const result = validateTransaction(base, { accounts, categories });
    expect(result.ok).toBe(true);
    expect(result.value).toMatchObject({ type: 'expense', amountMinor: 5000, accountId: 'acc_cash', categoryId: 'cat_food' });
    expect(result.value.status).toBe('posted');
  });

  it('requires an account, a category and a valid date', () => {
    const result = validateTransaction({ ...base, accountId: 'nope', categoryId: null, date: '2026-13-40' }, { accounts, categories });
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveProperty('accountId');
    expect(result.errors).toHaveProperty('categoryId');
    expect(result.errors).toHaveProperty('date');
  });

  it('rejects a category of the wrong type', () => {
    const result = validateTransaction({ ...base, type: 'income', categoryId: 'cat_food' }, { accounts, categories });
    expect(result.ok).toBe(false);
    expect(result.errors.categoryId).toMatch(/income category/);
  });

  it('enforces the transfer rules', () => {
    const sameAccount = validateTransaction(
      { type: 'transfer', amountMinor: 1000, accountId: 'acc_cash', toAccountId: 'acc_cash', date: '2026-10-15' },
      { accounts, categories }
    );
    expect(sameAccount.ok).toBe(false);
    expect(sameAccount.errors.toAccountId).toMatch(/different/);

    const crossCurrency = validateTransaction(
      { type: 'transfer', amountMinor: 1000, accountId: 'acc_cash', toAccountId: 'acc_usd', date: '2026-10-15' },
      { accounts, categories }
    );
    expect(crossCurrency.ok).toBe(false);
    expect(crossCurrency.errors.toAccountId).toMatch(/different currencies/);

    const good = validateTransaction(
      { type: 'transfer', amountMinor: 1000, accountId: 'acc_cash', toAccountId: 'acc_savings', date: '2026-10-15' },
      { accounts, categories }
    );
    expect(good.ok).toBe(true);
    expect(good.value.categoryId).toBeNull();
  });

  it('warns about a likely duplicate without failing', () => {
    const existing = [makeTransaction({ id: 'e1', type: 'expense', amountMinor: 5000, description: 'Coffee', accountId: 'acc_cash', categoryId: 'cat_food', date: '2026-10-15' })];
    const result = validateTransaction({ ...base, description: 'coffee' }, { accounts, categories, existing });
    expect(result.ok).toBe(true);
    expect(result.warnings.join(' ')).toMatch(/similar transaction/);
  });

  it('ignores a supplied category on a transfer with a warning', () => {
    const result = validateTransaction(
      { type: 'transfer', amountMinor: 1000, accountId: 'acc_cash', toAccountId: 'acc_savings', categoryId: 'cat_food', date: '2026-10-15' },
      { accounts, categories }
    );
    expect(result.ok).toBe(true);
    expect(result.warnings.join(' ')).toMatch(/Transfers do not use a category/);
  });
});

describe('validateAccount', () => {
  it('accepts a new account', () => {
    const result = validateAccount({ name: 'Wallet', type: 'cash', currency: 'BDT', openingBalanceMinor: 10000 }, { accounts: [] });
    expect(result.ok).toBe(true);
    expect(result.value).toMatchObject({ name: 'Wallet', currency: 'BDT', openingBalanceMinor: 10000 });
  });

  it('rejects duplicate names and invalid currencies', () => {
    const dup = validateAccount({ name: 'cash', type: 'cash', currency: 'BDT' }, { accounts });
    expect(dup.ok).toBe(false);
    expect(dup.errors.name).toMatch(/already exists/);

    const badCurrency = validateAccount({ name: 'Euro', type: 'cash', currency: 'ZZ' }, { accounts: [] });
    expect(badCurrency.ok).toBe(false);
    expect(badCurrency.errors.currency).toMatch(/3-letter/);
  });
});

describe('validateCategory', () => {
  it('rejects self-parenting, cycles and excessive depth', () => {
    const catA = makeCategory({ id: 'cat_a', name: 'A' });
    const catB = makeCategory({ id: 'cat_b', name: 'B', parentId: 'cat_a' });

    const self = validateCategory({ id: 'cat_a', name: 'A', type: 'expense', parentId: 'cat_a' }, { categories: [catA, catB], excludeId: 'cat_a' });
    expect(self.ok).toBe(false);
    expect(self.errors.parentId).toMatch(/own parent/);

    const cycle = validateCategory({ id: 'cat_a', name: 'A', type: 'expense', parentId: 'cat_b' }, { categories: [catA, catB], excludeId: 'cat_a' });
    expect(cycle.ok).toBe(false);
    expect(cycle.errors.parentId).toMatch(/circular/);

    const c1 = makeCategory({ id: 'c1', parentId: null });
    const c2 = makeCategory({ id: 'c2', parentId: 'c1' });
    const c3 = makeCategory({ id: 'c3', parentId: 'c2' });
    const c4 = makeCategory({ id: 'c4', parentId: 'c3' });
    const tooDeep = validateCategory({ name: 'Deep', type: 'expense', parentId: 'c4' }, { categories: [c1, c2, c3, c4] });
    expect(tooDeep.ok).toBe(false);
    expect(tooDeep.errors.parentId).toMatch(/at most 3 levels/);
    expect(categoryDepth(c4, [c1, c2, c3, c4])).toBe(3);
  });

  it('rejects a mismatched parent type', () => {
    const result = validateCategory({ name: 'Salary', type: 'income', parentId: 'cat_food' }, { categories });
    expect(result.ok).toBe(false);
    expect(result.errors.parentId).toMatch(/same type/);
  });
});

describe('validateBudget', () => {
  it('accepts an overall budget and normalises thresholds', () => {
    const result = validateBudget(
      { name: 'Monthly', period: 'monthly', scope: 'overall', limitMinor: 500000, startDate: '2026-01-01', endDate: '2026-12-31', alertThresholds: [100, 75, 90, 90] },
      { categories }
    );
    expect(result.ok).toBe(true);
    expect(result.value.alertThresholds).toEqual([75, 90, 100]);
  });

  it('requires an expense category for category budgets', () => {
    const result = validateBudget(
      { name: 'Food', period: 'monthly', scope: 'category', categoryId: 'cat_salary', limitMinor: 100000, startDate: '2026-01-01', endDate: '2026-12-31' },
      { categories }
    );
    expect(result.ok).toBe(false);
    expect(result.errors.categoryId).toMatch(/expense categories/);
  });

  it('rejects a start date after the end date', () => {
    const result = validateBudget(
      { name: 'Bad', limitMinor: 1000, startDate: '2026-12-31', endDate: '2026-01-01' },
      { categories }
    );
    expect(result.ok).toBe(false);
    expect(result.errors.startDate).toMatch(/on or before/);
  });
});

describe('validateGoal / validateContribution', () => {
  it('requires a target and rejects a negative saved amount', () => {
    const result = validateGoal({ name: 'Trip', targetMinor: 0, savedMinor: -5 }, { accounts, preferences: { currency: 'BDT' } });
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveProperty('target');
    expect(result.errors).toHaveProperty('saved');
  });

  it('cannot withdraw more than is saved', () => {
    const goal = { id: 'g1', currency: 'BDT', savedMinor: 1000, accountId: 'acc_savings' };
    const result = validateContribution({ direction: 'withdrawal', amountMinor: 5000 }, { goal, accounts });
    expect(result.ok).toBe(false);
    expect(result.errors.amount).toMatch(/at most/);
  });

  it('requires a linked goal account before accepting a transfer-funded contribution', () => {
    const goal = { id: 'g1', currency: 'BDT', savedMinor: 0, accountId: null };
    const result = validateContribution({ direction: 'contribution', amountMinor: 5000, sourceAccountId: 'acc_cash' }, { goal, accounts });
    expect(result.ok).toBe(false);
    expect(result.errors.sourceAccountId).toMatch(/Link a savings account/);
  });
});

describe('validatePreferences', () => {
  it('drops invalid values and reports them', () => {
    const result = validatePreferences({ theme: 'blue', weekStart: 9, alertThresholds: [] });
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveProperty('theme');
    expect(result.errors).toHaveProperty('weekStart');
    expect(result.errors).toHaveProperty('alertThresholds');
  });

  it('merges valid patches over the defaults', () => {
    const result = validatePreferences({ currency: 'usd', density: 'compact', weekStart: 1 });
    expect(result.ok).toBe(true);
    expect(result.value.currency).toBe('USD');
    expect(result.value.density).toBe('compact');
    expect(result.value.weekStart).toBe(1);
  });
});

describe('tag helpers', () => {
  it('normalises, dedupes and caps tags', () => {
    expect(normalizeTags(['#food', 'Food', 'food', 'travel'])).toEqual(['food', 'travel']);
    expect(parseTagInput('a, b , a')).toEqual(['a', 'b']);
  });

  it('parses boolean-ish cells', () => {
    expect(parseBooleanish('yes')).toBe(true);
    expect(parseBooleanish('0')).toBe(false);
    expect(parseBooleanish('maybe', true)).toBe(true);
  });
});
