/**
 * Date utilities. Date-only values are local `YYYY-MM-DD` strings and all
 * ranges are inclusive of both ends.
 */

import { describe, it, expect } from 'vitest';
import {
  isValidISODate,
  addMonths,
  addDays,
  startOfWeek,
  endOfWeek,
  startOfMonth,
  endOfMonth,
  monthKeysBetween,
  daysBetween,
  isWithin,
  compareISO,
  resolveRange,
  parseISODate,
  toISODate
} from '../src/utils/date.js';

describe('isValidISODate', () => {
  it('accepts real calendar dates only', () => {
    expect(isValidISODate('2026-10-15')).toBe(true);
    expect(isValidISODate('2024-02-29')).toBe(true); // leap year
    expect(isValidISODate('2026-02-29')).toBe(false); // not a leap year
    expect(isValidISODate('2026-13-01')).toBe(false);
    expect(isValidISODate('2026-10-32')).toBe(false);
    expect(isValidISODate('15/10/2026')).toBe(false);
    expect(isValidISODate('')).toBe(false);
  });
});

describe('arithmetic', () => {
  it('clamps monthly addition to the last valid day', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2024-01-31', 1)).toBe('2024-02-29');
    expect(addMonths('2026-01-15', -1)).toBe('2025-12-15');
  });

  it('adds days across month boundaries', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
  });

  it('computes week and month boundaries', () => {
    expect(startOfWeek('2026-10-15', 0)).toBe('2026-10-11');
    expect(endOfWeek('2026-10-15', 0)).toBe('2026-10-17');
    expect(startOfWeek('2026-10-15', 1)).toBe('2026-10-12');
    expect(startOfMonth('2026-10-15')).toBe('2026-10-01');
    expect(endOfMonth('2026-10-15')).toBe('2026-10-31');
    expect(endOfMonth('2026-02-10')).toBe('2026-02-28');
  });

  it('counts whole days between dates', () => {
    expect(daysBetween('2026-10-01', '2026-10-15')).toBe(14);
    expect(daysBetween('2026-10-15', '2026-10-01')).toBe(-14);
  });
});

describe('comparison and containment', () => {
  it('compares ISO strings chronologically', () => {
    expect(compareISO('2026-01-01', '2026-01-02')).toBe(-1);
    expect(compareISO('2026-01-02', '2026-01-01')).toBe(1);
    expect(compareISO('2026-01-01', '2026-01-01')).toBe(0);
  });

  it('treats ranges as inclusive', () => {
    expect(isWithin('2026-10-01', '2026-10-01', '2026-10-31')).toBe(true);
    expect(isWithin('2026-10-31', '2026-10-01', '2026-10-31')).toBe(true);
    expect(isWithin('2026-09-30', '2026-10-01', '2026-10-31')).toBe(false);
    expect(isWithin('2026-10-15', null, null)).toBe(true);
  });
});

describe('monthKeysBetween', () => {
  it('lists inclusive month buckets', () => {
    expect(monthKeysBetween('2026-01-15', '2026-03-02')).toEqual(['2026-01', '2026-02', '2026-03']);
  });

  it('returns an empty list for a reversed range', () => {
    expect(monthKeysBetween('2026-03-01', '2026-01-01')).toEqual([]);
  });
});

describe('resolveRange', () => {
  const today = '2026-10-15';

  it('resolves the built-in presets to inclusive windows', () => {
    expect(resolveRange('today', { today })).toMatchObject({ from: '2026-10-15', to: '2026-10-15' });
    expect(resolveRange('thisMonth', { today })).toMatchObject({ from: '2026-10-01', to: '2026-10-31' });
    expect(resolveRange('lastMonth', { today })).toMatchObject({ from: '2026-09-01', to: '2026-09-30' });
    expect(resolveRange('last3Months', { today })).toMatchObject({ from: '2026-08-01', to: '2026-10-31' });
    expect(resolveRange('thisYear', { today })).toMatchObject({ from: '2026-01-01', to: '2026-12-31' });
    expect(resolveRange('lastYear', { today })).toMatchObject({ from: '2025-01-01', to: '2025-12-31' });
  });

  it('keeps a custom range in chronological order', () => {
    const range = resolveRange('custom', { today, customFrom: '2026-10-31', customTo: '2026-10-01' });
    expect(range.from).toBe('2026-10-01');
    expect(range.to).toBe('2026-10-31');
  });

  it('falls back to the current month for an unknown preset', () => {
    expect(resolveRange('nonsense', { today })).toMatchObject({ id: 'thisMonth', from: '2026-10-01' });
  });
});

describe('parseISODate / toISODate', () => {
  it('round-trips a local date without a UTC shift', () => {
    const parsed = parseISODate('2026-10-15');
    expect(toISODate(parsed)).toBe('2026-10-15');
    expect(parsed.getFullYear()).toBe(2026);
    expect(parsed.getMonth()).toBe(9);
    expect(parsed.getDate()).toBe(15);
  });

  it('returns null for invalid input', () => {
    expect(parseISODate('nope')).toBeNull();
  });
});
