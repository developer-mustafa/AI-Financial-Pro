/**
 * CSV / JSON export & import, plus the CSV-injection and RFC-4180 rules.
 */

import { describe, it, expect } from 'vitest';
import { escapeCsvCell, toCsv, safeJsonParse, sanitizeLine, sanitizeFilename, sanitizeColor } from '../src/utils/sanitize.js';
import {
  parseCsv,
  mapHeaders,
  parseFlexibleDate,
  buildTransactionImport,
  applyTransactionImport,
  parseBackupJson,
  sniffFileKind
} from '../src/services/importService.js';
import { transactionRows, TRANSACTION_HEADERS } from '../src/services/exportService.js';
import { makeAccount, makeCategory, makeStore, makeTransaction } from './helpers.js';

describe('CSV escaping (RFC 4180 + formula injection)', () => {
  it('neutralises spreadsheet formulas', () => {
    expect(escapeCsvCell('=1+1')).toBe("'=1+1");
    expect(escapeCsvCell('+1')).toBe("'+1");
    expect(escapeCsvCell('-1')).toBe("'-1");
    expect(escapeCsvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(escapeCsvCell('  =cmd')).toBe("'  =cmd");
  });

  it('quotes fields containing separators or quotes', () => {
    expect(escapeCsvCell('hello, world')).toBe('"hello, world"');
    expect(escapeCsvCell('say "hi"')).toBe('"say ""hi"""');
    expect(escapeCsvCell('line\nbreak')).toBe('"line\nbreak"');
    expect(escapeCsvCell(null)).toBe('');
    expect(escapeCsvCell(42)).toBe('42');
  });

  it('joins rows with CRLF', () => {
    expect(toCsv([['a', 'b'], ['c', 'd']])).toBe('a,b\r\nc,d');
  });
});

describe('parseCsv', () => {
  it('parses quoted fields, escaped quotes and mixed line endings', () => {
    const text = 'a,b\r\n"x, y","say ""hi"""\r\n1,2\n';
    expect(parseCsv(text)).toEqual([
      ['a', 'b'],
      ['x, y', 'say "hi"'],
      ['1', '2']
    ]);
  });

  it('strips a UTF-8 BOM and skips blank lines', () => {
    expect(parseCsv('\uFEFFa,b\n\n1,2\n')).toEqual([['a', 'b'], ['1', '2']]);
  });
});

describe('mapHeaders', () => {
  it('matches aliases to fields', () => {
    const mapping = mapHeaders(['Transaction Date', 'Amount', 'Category', 'Account']);
    expect(mapping.date).toBe(0);
    expect(mapping.amount).toBe(1);
    expect(mapping.category).toBe(2);
    expect(mapping.account).toBe(3);
  });
});

describe('parseFlexibleDate', () => {
  it('accepts ISO and common local formats', () => {
    expect(parseFlexibleDate('2026-10-15')).toBe('2026-10-15');
    expect(parseFlexibleDate('15/10/2026')).toBe('2026-10-15');
    expect(parseFlexibleDate('15.10.2026')).toBe('2026-10-15');
    expect(parseFlexibleDate('15-10-2026')).toBe('2026-10-15');
    expect(parseFlexibleDate('15/10/26')).toBe('2026-10-15');
    expect(parseFlexibleDate('2026-10-15T09:30:00Z')).toBe('2026-10-15');
  });

  it('honours the day/month order', () => {
    expect(parseFlexibleDate('10/15/2026', { dateOrder: 'MDY' })).toBe('2026-10-15');
    expect(parseFlexibleDate('10/15/2026', { dateOrder: 'DMY' })).toBeNull();
  });

  it('returns null for junk', () => {
    expect(parseFlexibleDate('not-a-date')).toBeNull();
    expect(parseFlexibleDate('')).toBeNull();
  });
});

describe('buildTransactionImport', () => {
  const accounts = [makeAccount({ id: 'acc_cash', name: 'Cash' })];
  const categories = [
    makeCategory({ id: 'cat_food', name: 'Food', type: 'expense' }),
    makeCategory({ id: 'cat_salary', name: 'Salary', type: 'income' })
  ];
  const csv = [
    'date,type,amount,category,account,description',
    '2026-10-01,expense,120.00,Food,Cash,Lunch',
    '2026-10-02,income,5000,Salary,Cash,Payday',
    'bad-date,expense,50,Food,Cash,Nope'
  ].join('\n');

  it('splits rows into valid and invalid without touching state', () => {
    const plan = buildTransactionImport(csv, { accounts, categories });
    expect(plan.ok).toBe(true);
    expect(plan.summary).toMatchObject({ total: 3, valid: 2, invalid: 1 });
    expect(plan.entries[0].candidate).toMatchObject({ type: 'expense', amountMinor: 12000, categoryId: 'cat_food', accountId: 'acc_cash' });
    expect(plan.entries[2].errors).toHaveProperty('date');
  });

  it('fails fast when required columns are missing', () => {
    const noDate = buildTransactionImport('amount,description\n100,x\n', { accounts, categories });
    expect(noDate.ok).toBe(false);
    expect(noDate.fatal).toMatch(/date column/);

    const noAmount = buildTransactionImport('date,description\n2026-10-01,x\n', { accounts, categories });
    expect(noAmount.ok).toBe(false);
    expect(noAmount.fatal).toMatch(/amount column/);
  });

  it('plans new categories and accounts when allowed', () => {
    const plan = buildTransactionImport(
      'date,type,amount,category,account,description\n2026-10-01,expense,10,Snacks,Wallet,Tea\n',
      { accounts, categories, createMissingCategories: true, createMissingAccounts: true }
    );
    expect(plan.summary.newCategories).toBe(1);
    expect(plan.summary.newAccounts).toBe(1);
    expect(plan.valid).toHaveLength(1);
  });

  it('flags duplicates instead of importing them silently', () => {
    const existing = [makeTransaction({ id: 'e1', type: 'expense', amountMinor: 12000, description: 'Lunch', accountId: 'acc_cash', categoryId: 'cat_food', date: '2026-10-01' })];
    const plan = buildTransactionImport(csv, { accounts, categories, existingTransactions: existing });
    expect(plan.duplicates.length).toBeGreaterThanOrEqual(1);
    expect(plan.valid.find((entry) => entry.candidate.description === 'Lunch')).toBeUndefined();
  });
});

describe('applyTransactionImport', () => {
  it('commits only approved rows, once', () => {
    const store = makeStore({
      accounts: [makeAccount({ id: 'acc_cash', name: 'Cash' })],
      categories: [makeCategory({ id: 'cat_food', name: 'Food', type: 'expense' })]
    });
    const plan = buildTransactionImport('date,type,amount,category,account,description\n2026-10-01,expense,120.00,Food,Cash,Lunch\n', {
      accounts: store.list('accounts'),
      categories: store.list('categories')
    });

    const first = applyTransactionImport(plan, { store });
    expect(first.added).toBe(1);
    expect(store.list('transactions')).toHaveLength(1);

    // Re-applying the exact same plan must not duplicate the record.
    const second = applyTransactionImport(plan, { store });
    expect(second.added).toBe(0);
    expect(store.list('transactions')).toHaveLength(1);
  });
});

describe('parseBackupJson', () => {
  it('accepts a well-formed backup and reports counts', () => {
    const backup = JSON.stringify({
      app: 'SpendWise',
      format: 'spendwise-backup',
      schemaVersion: 1,
      data: { transactions: [makeTransaction({ id: 't1' })], categories: [makeCategory()], accounts: [makeAccount()] }
    });
    const result = parseBackupJson(backup);
    expect(result.ok).toBe(true);
    expect(result.meta.counts.transactions).toBe(1);
  });

  it('rejects files that are not backups', () => {
    expect(parseBackupJson('{"hello":1}').ok).toBe(false);
    expect(parseBackupJson('not json').ok).toBe(false);
  });

  it('warns about orphan references without failing', () => {
    const backup = JSON.stringify({
      data: { transactions: [makeTransaction({ id: 't1', accountId: 'missing', categoryId: 'gone' })], categories: [], accounts: [] }
    });
    const result = parseBackupJson(backup);
    expect(result.ok).toBe(true);
    expect(result.warnings.join(' ')).toMatch(/reference an account or category/);
  });
});

describe('sniffFileKind', () => {
  it('detects JSON by name or content', () => {
    expect(sniffFileKind('', 'data.json')).toBe('json');
    expect(sniffFileKind('{"a":1}', 'data')).toBe('json');
    expect(sniffFileKind('a,b\n1,2', 'data.csv')).toBe('csv');
  });
});

describe('exportService.transactionRows', () => {
  it('resolves names and keeps the integer minor amount authoritative', () => {
    const ctx = { categories: [makeCategory({ id: 'cat_food', name: 'Food' })], accounts: [makeAccount({ id: 'acc_cash', name: 'Cash' })] };
    const rows = transactionRows([makeTransaction({ id: 't1', amountMinor: 125050, categoryId: 'cat_food', accountId: 'acc_cash' })], ctx);
    expect(rows[0]).toEqual(TRANSACTION_HEADERS);
    const row = Object.fromEntries(TRANSACTION_HEADERS.map((header, index) => [header, rows[1][index]]));
    expect(row.category).toBe('Food');
    expect(row.account).toBe('Cash');
    expect(row.amount).toBe('1250.50');
    expect(row.amountMinor).toBe(125050);
  });
});

describe('sanitize helpers', () => {
  it('collapses newlines and trims', () => {
    expect(sanitizeLine('  hello\nworld  ')).toBe('hello world');
  });

  it('produces a filesystem-safe filename', () => {
    expect(sanitizeFilename('my export: 2026/10')).toBe('my-export-2026-10');
    expect(sanitizeFilename('')).toBe('spendwise-export');
  });

  it('validates hex colours', () => {
    expect(sanitizeColor('#ABC')).toBe('#aabbcc');
    expect(sanitizeColor('red', '#123456')).toBe('#123456');
  });

  it('never throws while parsing JSON', () => {
    expect(safeJsonParse('{').ok).toBe(false);
    expect(safeJsonParse('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
  });
});
