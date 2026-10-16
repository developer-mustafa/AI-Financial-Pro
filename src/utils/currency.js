/**
 * Currency + number formatting.
 *
 * MONEY REPRESENTATION
 * --------------------
 * Every monetary value is stored as an INTEGER number of minor units in the
 * record's own currency (e.g. 123456 BDT-fen? -> 123456 means 1,234.56 BDT,
 * since BDT has 2 minor decimals). Integer minor units avoid all binary
 * floating-point error in authoritative calculations; conversion to a decimal
 * number only happens for display.
 *
 * MULTI-CURRENCY POLICY
 * ---------------------
 * Amounts are NEVER summed across different currencies. Aggregations take a
 * `currency` filter and only include matching records; other currencies are
 * reported separately. No exchange-rate conversion is performed anywhere.
 */

import { appConfig } from '../config/appConfig.js';

const DECIMALS_CACHE = new Map();

/** Number of minor-unit decimals for an ISO-4217 code (JPY = 0, KWD = 3, ...). */
export function minorDecimals(currency = 'BDT') {
  const code = String(currency || 'BDT').toUpperCase();
  if (DECIMALS_CACHE.has(code)) return DECIMALS_CACHE.get(code);
  let decimals = 2;
  try {
    const opts = new Intl.NumberFormat('en-US', { style: 'currency', currency: code }).resolvedOptions();
    decimals = Number.isFinite(opts.maximumFractionDigits) ? opts.maximumFractionDigits : 2;
  } catch {
    decimals = 2;
  }
  DECIMALS_CACHE.set(code, decimals);
  return decimals;
}

export function currencySymbol(currency = 'BDT', locale = 'en-US') {
  try {
    const parts = new Intl.NumberFormat(locale, { style: 'currency', currency }).formatToParts(0);
    return parts.find((p) => p.type === 'currency')?.value || currency;
  } catch {
    return currency;
  }
}

export function isValidCurrency(currency) {
  const code = String(currency || '').toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) return false;
  try {
    new Intl.NumberFormat('en-US', { style: 'currency', currency: code }).format(0);
    return true;
  } catch {
    return false;
  }
}

export function normalizeCurrency(currency, fallback = 'BDT') {
  const code = String(currency || '').trim().toUpperCase();
  return isValidCurrency(code) ? code : fallback;
}

/**
 * Decimal major units -> integer minor units.
 * Rounds half-away-from-zero so 1.005 -> 101 (not 100).
 */
export function toMinor(major, currency = 'BDT') {
  const value = Number(major);
  if (!Number.isFinite(value)) return NaN;
  const factor = 10 ** minorDecimals(currency);
  const scaled = value * factor;
  return Math.sign(scaled) * Math.round(Math.abs(scaled));
}

/** Integer minor units -> decimal major units (for display / CSV only). */
export function fromMinor(minor, currency = 'BDT') {
  const value = Number(minor);
  if (!Number.isFinite(value)) return 0;
  return value / 10 ** minorDecimals(currency);
}

/**
 * Parses loose user input ("1,250.50", "BDT 90", "১২০") into integer minor units.
 * Returns NaN when the input cannot be interpreted as a positive-or-zero amount.
 */
export function parseAmountToMinor(input, currency = 'BDT') {
  if (typeof input === 'number') return toMinor(input, currency);
  if (input === null || input === undefined) return NaN;
  let str = String(input).trim();
  if (!str) return NaN;
  // Bengali / Arabic-Indic digits -> ASCII
  str = str
    .replace(/[\u09E6-\u09EF]/g, (d) => String(d.charCodeAt(0) - 0x09e6))
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660));
  // Remove currency symbols and grouping separators, keep digits, sign, dot.
  str = str.replace(/[^\d.,\-+]/g, '');
  // If both separators exist, the LAST one is the decimal separator.
  const lastComma = str.lastIndexOf(',');
  const lastDot = str.lastIndexOf('.');
  if (lastComma > -1 && lastDot > -1) {
    if (lastComma > lastDot) {
      str = str.replace(/\./g, '').replace(',', '.');
    } else {
      str = str.replace(/,/g, '');
    }
  } else if (lastComma > -1) {
    const parts = str.split(',');
    // "1,250" -> thousands; "1,25" -> decimal comma
    const looksLikeThousands = parts.length > 1 && parts.slice(1).every((p) => p.length === 3);
    str = looksLikeThousands ? parts.join('') : str.replace(',', '.');
  }
  if (!/^[-+]?\d*(\.\d*)?$/.test(str) || !/\d/.test(str)) return NaN;
  const value = Number(str);
  if (!Number.isFinite(value)) return NaN;
  return toMinor(value, currency);
}

/**
 * Formats integer minor units as a display string.
 * @param {number} minor
 * @param {{currency?:string, locale?:string, showSign?:boolean, compact?:boolean, accounting?:boolean, decimals?:number}} [opts]
 */
export function formatMoney(minor, opts = {}) {
  const {
    currency = 'BDT',
    locale = 'en-US',
    showSign = false,
    compact = false,
    accounting = false,
    decimals
  } = opts;
  const code = normalizeCurrency(currency);
  const value = fromMinor(Number(minor) || 0, code);
  const digits = typeof decimals === 'number' ? decimals : minorDecimals(code);
  if (compact && Math.abs(value) >= 10000) {
    try {
      const compactFmt = new Intl.NumberFormat(locale, {
        notation: 'compact',
        compactDisplay: 'short',
        maximumFractionDigits: 1,
        style: 'currency',
        currency: code,
        currencyDisplay: 'narrowSymbol'
      });
      return compactFmt.format(value);
    } catch {
      /* fall through to the standard formatter */
    }
  }
  const options = {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  };
  if (accounting) {
    // Accounting style: parentheses for negatives, no currency position juggling.
    const fmt = buildNumberFormat(locale, options);
    const abs = fmt.format(Math.abs(value));
    const sign = value < 0 ? '−' : showSign && value > 0 ? '+' : '';
    const symbol = currencySymbol(code, locale);
    const body = `${symbol}${abs}`;
    return value < 0 ? `(${body})` : `${sign}${body}`;
  }
  let formatted;
  try {
    formatted = new Intl.NumberFormat(locale, { ...options, style: 'currency', currency: code }).format(value);
  } catch {
    formatted = `${value.toFixed(digits)} ${code}`;
  }
  if (showSign && value > 0) return `+${formatted}`;
  return formatted;
}

function buildNumberFormat(locale, options) {
  try {
    return new Intl.NumberFormat(locale, options);
  } catch {
    return new Intl.NumberFormat('en-US', options);
  }
}

/** Plain number formatting (no currency symbol) for counts, percentages, etc. */
export function formatNumber(value, { locale = 'en-US', decimals = 0, compact = false } = {}) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '—';
  try {
    return new Intl.NumberFormat(locale, {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
      ...(compact ? { notation: 'compact', compactDisplay: 'short' } : {})
    }).format(num);
  } catch {
    return String(num);
  }
}

/** e.g. 42.7 → "42.7%" ; null/undefined → "—" (used when income is zero). */
export function formatPercent(value, { locale = 'en-US', decimals = 1 } = {}) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
  try {
    return new Intl.NumberFormat(locale, {
      style: 'percent',
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals
    }).format(Number(value) / 100);
  } catch {
    return `${Number(value).toFixed(decimals)}%`;
  }
}

/**
 * Aggregates minor-unit amounts per currency. Used to enforce the
 * "never add incompatible currencies" rule in UI code.
 */
export function sumByCurrency(items, pick = (item) => item) {
  const map = new Map();
  for (const item of items) {
    const { amountMinor, currency } = pick(item) || {};
    const code = normalizeCurrency(currency);
    map.set(code, (map.get(code) || 0) + (Number(amountMinor) || 0));
  }
  return map;
}
