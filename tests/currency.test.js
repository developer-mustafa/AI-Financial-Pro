/**
 * Money representation tests: minor units, loose parsing and formatting.
 */

import { describe, it, expect } from 'vitest';
import {
  toMinor,
  fromMinor,
  parseAmountToMinor,
  formatMoney,
  minorDecimals,
  currencySymbol,
  isValidCurrency,
  normalizeCurrency,
  sumByCurrency,
  formatPercent
} from '../src/utils/currency.js';

describe('minor units', () => {
  it('uses the correct number of decimals per currency', () => {
    expect(minorDecimals('BDT')).toBe(2);
    expect(minorDecimals('USD')).toBe(2);
    expect(minorDecimals('JPY')).toBe(0);
    expect(minorDecimals('KWD')).toBe(3);
  });

  it('converts major <-> minor without floating-point drift', () => {
    expect(toMinor(12.34, 'BDT')).toBe(1234);
    expect(toMinor(0.1, 'BDT')).toBe(10);
    expect(toMinor(12.3, 'BDT')).toBe(1230);
    expect(toMinor(1234, 'JPY')).toBe(1234);
    expect(fromMinor(125050, 'BDT')).toBe(1250.5);
    expect(fromMinor(1234, 'JPY')).toBe(1234);
  });

  it('returns NaN for unparseable major values', () => {
    expect(Number.isNaN(toMinor('abc'))).toBe(true);
  });
});

describe('parseAmountToMinor', () => {
  it('parses grouping separators and currency symbols', () => {
    expect(parseAmountToMinor('1,250.50', 'BDT')).toBe(125050);
    expect(parseAmountToMinor('BDT 90', 'BDT')).toBe(9000);
    expect(parseAmountToMinor('90', 'BDT')).toBe(9000);
    expect(parseAmountToMinor('  1,000,000 ', 'BDT')).toBe(100000000);
  });

  it('parses Bengali and Arabic-Indic digits', () => {
    expect(parseAmountToMinor('১২০', 'BDT')).toBe(12000);
    expect(parseAmountToMinor('٤٥', 'BDT')).toBe(4500);
  });

  it('handles decimal commas and negatives', () => {
    expect(parseAmountToMinor('1.250,50', 'BDT')).toBe(125050);
    expect(parseAmountToMinor('-50', 'BDT')).toBe(-5000);
  });

  it('rejects text and empty input', () => {
    expect(Number.isNaN(parseAmountToMinor('', 'BDT'))).toBe(true);
    expect(Number.isNaN(parseAmountToMinor('hello', 'BDT'))).toBe(true);
  });
});

describe('formatMoney', () => {
  it('formats with the currency symbol', () => {
    const text = formatMoney(125050, { currency: 'BDT' });
    expect(text).toContain('1,250.50');
  });

  it('adds an explicit plus sign when asked', () => {
    expect(formatMoney(5000, { currency: 'USD', showSign: true })).toMatch(/^\+/);
  });

  it('uses accounting parentheses for negatives', () => {
    const text = formatMoney(-5000, { currency: 'USD', accounting: true });
    expect(text.startsWith('(')).toBe(true);
    expect(text.endsWith(')')).toBe(true);
  });

  it('tolerates currency changes without throwing', () => {
    expect(() => formatMoney(1000, { currency: 'JPY' })).not.toThrow();
    expect(() => formatMoney(1000, { currency: 'KWD' })).not.toThrow();
  });
});

describe('currency helpers', () => {
  it('validates ISO codes', () => {
    expect(isValidCurrency('BDT')).toBe(true);
    expect(isValidCurrency('usd')).toBe(true);
    expect(isValidCurrency('ZZ')).toBe(false);
    expect(isValidCurrency('Z1Z')).toBe(false);
    expect(isValidCurrency('')).toBe(false);
  });

  it('normalises with a fallback', () => {
    expect(normalizeCurrency('usd')).toBe('USD');
    expect(normalizeCurrency('', 'EUR')).toBe('EUR');
    expect(normalizeCurrency('nonsense', 'BDT')).toBe('BDT');
  });

  it('resolves a symbol', () => {
    expect(currencySymbol('USD', 'en-US')).toBe('$');
  });

  it('sums per currency and never mixes', () => {
    const totals = sumByCurrency([
      { amountMinor: 100, currency: 'BDT' },
      { amountMinor: 200, currency: 'BDT' },
      { amountMinor: 50, currency: 'USD' }
    ]);
    expect(totals.get('BDT')).toBe(300);
    expect(totals.get('USD')).toBe(50);
  });

  it('formats percentages, using an em dash for null', () => {
    expect(formatPercent(42.7)).toBe('42.7%');
    expect(formatPercent(null)).toBe('—');
  });
});
