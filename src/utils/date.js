/**
 * Date utilities.
 *
 * Contract: every date-only value in the application is a local-calendar
 * `YYYY-MM-DD` string. Timestamps are full ISO-8601 UTC strings. Date-only
 * strings are NEVER parsed with `new Date(str)` (which is UTC and causes
 * one-day shifts); they are split and rebuilt as local dates.
 *
 * All ranges are inclusive of both the start and the end date.
 */

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86400000;

export const pad2 = (n) => String(n).padStart(2, '0');

/** Local calendar date -> `YYYY-MM-DD`. */
export function toISODate(dateObj) {
  if (!(dateObj instanceof Date) || Number.isNaN(dateObj.getTime())) return null;
  return `${dateObj.getFullYear()}-${pad2(dateObj.getMonth() + 1)}-${pad2(dateObj.getDate())}`;
}

export function todayISO() {
  return toISODate(new Date());
}

/** Full timestamp, used for audit fields. */
export function nowISO() {
  return new Date().toISOString();
}

/** True when `value` is a real calendar date in `YYYY-MM-DD` form. */
export function isValidISODate(value) {
  if (typeof value !== 'string') return false;
  const match = DATE_RE.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > 31) return false;
  if (year < 1000 || year > 9999) return false;
  const probe = new Date(year, month - 1, day);
  return probe.getFullYear() === year && probe.getMonth() === month - 1 && probe.getDate() === day;
}

/** `YYYY-MM-DD` -> local Date at midnight, or null when invalid. */
export function parseISODate(value) {
  if (!isValidISODate(value)) return null;
  const [y, m, d] = value.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** Chronological comparison for ISO date strings (-1, 0, 1). */
export function compareISO(a, b) {
  if (a === b) return 0;
  return String(a) < String(b) ? -1 : 1;
}

export function addDays(iso, days) {
  const date = parseISODate(iso);
  if (!date) return null;
  date.setDate(date.getDate() + Number(days || 0));
  return toISODate(date);
}

/** Month arithmetic that clamps to the last valid day (Jan 31 + 1 month = Feb 28/29). */
export function addMonths(iso, months) {
  const date = parseISODate(iso);
  if (!date) return null;
  const day = date.getDate();
  date.setDate(1);
  date.setMonth(date.getMonth() + Number(months || 0));
  const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  date.setDate(Math.min(day, lastDay));
  return toISODate(date);
}

export function addYears(iso, years) {
  return addMonths(iso, Number(years || 0) * 12);
}

/** `weekStart`: 0 = Sunday (default), 1 = Monday, 6 = Saturday. */
export function startOfWeek(iso, weekStart = 0) {
  const date = parseISODate(iso);
  if (!date) return null;
  const offset = (date.getDay() - weekStart + 7) % 7;
  date.setDate(date.getDate() - offset);
  return toISODate(date);
}

export function endOfWeek(iso, weekStart = 0) {
  const start = startOfWeek(iso, weekStart);
  return start ? addDays(start, 6) : null;
}

export function startOfMonth(iso) {
  const date = parseISODate(iso);
  if (!date) return null;
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-01`;
}

export function endOfMonth(iso) {
  const date = parseISODate(iso);
  if (!date) return null;
  const last = new Date(date.getFullYear(), date.getMonth() + 1, 0);
  return toISODate(last);
}

export function startOfYear(iso) {
  const date = parseISODate(iso);
  return date ? `${date.getFullYear()}-01-01` : null;
}

export function endOfYear(iso) {
  const date = parseISODate(iso);
  return date ? `${date.getFullYear()}-12-31` : null;
}

/** `YYYY-MM` bucket key. */
export function monthKey(iso) {
  return typeof iso === 'string' ? iso.slice(0, 7) : '';
}

export function yearKey(iso) {
  return typeof iso === 'string' ? iso.slice(0, 4) : '';
}

/**
 * Inclusive list of `YYYY-MM` keys between two ISO dates (oldest first).
 * Guards against runaway loops when the range is nonsense.
 */
export function monthKeysBetween(fromISO, toISO, maxMonths = 600) {
  const start = startOfMonth(fromISO);
  const end = startOfMonth(toISO);
  if (!start || !end || compareISO(start, end) > 0) return [];
  const keys = [];
  let cursor = start;
  while (compareISO(cursor, end) <= 0 && keys.length < maxMonths) {
    keys.push(monthKey(cursor));
    cursor = addMonths(cursor, 1);
  }
  return keys;
}

/** Whole days between two ISO dates (b - a). */
export function daysBetween(a, b) {
  const da = parseISODate(a);
  const db = parseISODate(b);
  if (!da || !db) return 0;
  return Math.round((db.getTime() - da.getTime()) / DAY_MS);
}

/** Days remaining until `iso` (negative when in the past). */
export function daysUntil(iso) {
  return daysBetween(todayISO(), iso);
}

/** Inclusive-range containment check. */
export function isWithin(iso, from, to) {
  if (!iso) return false;
  if (from && compareISO(iso, from) < 0) return false;
  if (to && compareISO(iso, to) > 0) return false;
  return true;
}

export function formatDate(iso, { locale = 'en-US', format = 'medium' } = {}) {
  const date = parseISODate(iso);
  if (!date) return '—';
  const presets = {
    short: { day: '2-digit', month: '2-digit', year: 'numeric' },
    medium: { day: '2-digit', month: 'short', year: 'numeric' },
    long: { day: 'numeric', month: 'long', year: 'numeric' }
  };
  try {
    return new Intl.DateTimeFormat(locale, presets[format] || presets.medium).format(date);
  } catch {
    return iso;
  }
}

export function formatMonth(key, { locale = 'en-US', format = 'short' } = {}) {
  if (!/^\d{4}-\d{2}$/.test(String(key))) return String(key || '—');
  const [y, m] = key.split('-').map(Number);
  const date = new Date(y, m - 1, 1);
  try {
    return new Intl.DateTimeFormat(locale, { month: format === 'long' ? 'long' : 'short', year: 'numeric' }).format(date);
  } catch {
    return key;
  }
}

export function formatTimestamp(ts, { locale = 'en-US', withTime = true } = {}) {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return '—';
  try {
    return new Intl.DateTimeFormat(locale, {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {})
    }).format(date);
  } catch {
    return String(ts);
  }
}

/** "2 hours ago" style label for activity feeds. */
export function relativeTime(ts, locale = 'en-US') {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return '—';
  const diffMs = date.getTime() - Date.now();
  const units = [
    ['year', 31536000000],
    ['month', 2592000000],
    ['day', 86400000],
    ['hour', 3600000],
    ['minute', 60000]
  ];
  try {
    const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
    for (const [unit, ms] of units) {
      if (Math.abs(diffMs) >= ms) return rtf.format(Math.round(diffMs / ms), unit);
    }
    return rtf.format(0, 'minute');
  } catch {
    return formatTimestamp(ts, { locale });
  }
}

/**
 * Resolves a range preset to concrete inclusive ISO dates.
 * @param {string} preset one of appConfig.ranges ids
 */
export function resolveRange(preset, { weekStart = 0, today = todayISO(), customFrom = null, customTo = null } = {}) {
  switch (preset) {
    case 'today':
      return { id: preset, from: today, to: today };
    case 'thisWeek':
      return { id: preset, from: startOfWeek(today, weekStart), to: endOfWeek(today, weekStart) };
    case 'thisMonth':
      return { id: preset, from: startOfMonth(today), to: endOfMonth(today) };
    case 'lastMonth': {
      const prev = addMonths(startOfMonth(today), -1);
      return { id: preset, from: startOfMonth(prev), to: endOfMonth(prev) };
    }
    case 'last3Months': {
      const from = startOfMonth(addMonths(startOfMonth(today), -2));
      return { id: preset, from, to: endOfMonth(today) };
    }
    case 'thisYear':
      return { id: preset, from: startOfYear(today), to: endOfYear(today) };
    case 'lastYear': {
      const y = String(Number(yearKey(today)) - 1);
      return { id: preset, from: `${y}-01-01`, to: `${y}-12-31` };
    }
    case 'allTime':
      return { id: preset, from: '1970-01-01', to: endOfYear(today) };
    case 'custom': {
      const from = isValidISODate(customFrom) ? customFrom : startOfMonth(today);
      const to = isValidISODate(customTo) ? customTo : today;
      return { id: preset, from: compareISO(from, to) <= 0 ? from : to, to: compareISO(from, to) <= 0 ? to : from };
    }
    default:
      return { id: 'thisMonth', from: startOfMonth(today), to: endOfMonth(today) };
  }
}

/** Human label for a resolved range. */
export function rangeLabel(range, { locale = 'en-US', format = 'medium' } = {}) {
  if (!range) return '—';
  if (range.from === range.to) return formatDate(range.from, { locale, format });
  return `${formatDate(range.from, { locale, format })} → ${formatDate(range.to, { locale, format })}`;
}

/** Inclusive bucket label for a range, e.g. "Oct 2026". */
export function rangeBucketLabel(range, options) {
  if (range?.from?.slice(0, 7) === range?.to?.slice(0, 7)) return formatMonth(monthKey(range.from), options);
  return rangeLabel(range, options);
}
