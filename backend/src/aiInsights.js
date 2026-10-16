// src/aiInsights.js
// Deterministic, PII-free financial aggregation for the AI features.
//
// prompt2.txt §4B / §6: arithmetic is NEVER delegated to the model. Totals,
// shares, month-over-month deltas and top categories are computed here, in
// JavaScript, from the authorized tenant's own rows. The model only ever
// receives this small aggregate — never raw transactions, user names or emails.
//
// This module is PURE (no DB driver, no network) so it unit-tests directly.

const MAX_TOP_CATEGORIES = 5;
const MAX_MONTHS = 6;

/** 'YYYY-MM' for a Date or a date-ish string, or null when unparseable. */
export function monthKey(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 7);
  const s = String(value);
  return /^\d{4}-\d{2}/.test(s) ? s.slice(0, 7) : null;
}

/** First day ('YYYY-MM-DD') of the month `months - 1` months before `now`. */
export function monthsAgoIso(months, now = new Date()) {
  const span = Number.isInteger(months) && months > 0 ? months : MAX_MONTHS;
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (span - 1), 1));
  return d.toISOString().slice(0, 10);
}

function toMinor(value) {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

/** Minor units -> major-unit string with 2 decimals (presentation only). */
export function formatMajor(minor) {
  const n = toMinor(minor) / 100;
  return n.toFixed(2);
}

/**
 * Build a compact, PII-free summary of a tenant's finances.
 *
 * @param {{
 *   transactions?: Array<object>, // tenant-scoped rows (snake_case columns)
 *   categories?: Array<object>,
 *   budgets?: Array<object>,
 *   months?: number
 * }} [input]
 */
export function buildFinancialContext({ transactions = [], categories = [], budgets = [], months = MAX_MONTHS } = {}) {
  const categoryName = new Map();
  for (const c of categories) {
    if (c && c.id !== undefined && c.id !== null) categoryName.set(c.id, String(c.name || '').slice(0, 60));
  }

  const byCurrency = new Map();
  const expenseByCategory = new Map();
  const monthly = new Map();
  let counted = 0;

  for (const t of transactions) {
    if (!t) continue;
    if (String(t.status || 'posted') === 'draft') continue;

    const type = t.type === 'income' ? 'income' : t.type === 'transfer' ? 'transfer' : 'expense';
    if (type === 'transfer') continue; // moves money; neither income nor expense

    const amount = toMinor(t.amount_minor);
    const currency = String(t.currency || 'BDT');
    const m = monthKey(t.date);
    counted += 1;

    const cur = byCurrency.get(currency) || { currency, incomeMinor: 0, expenseMinor: 0 };
    if (type === 'income') cur.incomeMinor += amount;
    else cur.expenseMinor += amount;
    byCurrency.set(currency, cur);

    if (m) {
      const mo = monthly.get(m) || { month: m, incomeMinor: 0, expenseMinor: 0 };
      if (type === 'income') mo.incomeMinor += amount;
      else mo.expenseMinor += amount;
      monthly.set(m, mo);
    }

    if (type === 'expense') {
      const key = t.category_id === null || t.category_id === undefined ? '__uncategorized__' : String(t.category_id);
      expenseByCategory.set(key, (expenseByCategory.get(key) || 0) + amount);
    }
  }

  const totals = [...byCurrency.values()]
    .map((c) => ({
      currency: c.currency,
      incomeMinor: c.incomeMinor,
      expenseMinor: c.expenseMinor,
      netMinor: c.incomeMinor - c.expenseMinor,
    }))
    .sort((a, b) => b.expenseMinor - a.expenseMinor);

  const primary = totals[0] || { currency: 'BDT', incomeMinor: 0, expenseMinor: 0, netMinor: 0 };
  const expenseTotal = primary.expenseMinor;

  const topCategories = [...expenseByCategory.entries()]
    .map(([id, expenseMinor]) => ({
      categoryId: id === '__uncategorized__' ? null : id,
      name: id === '__uncategorized__' ? 'Uncategorized' : categoryName.get(id) || '',
      expenseMinor,
      share: expenseTotal > 0 ? Math.round((expenseMinor / expenseTotal) * 1000) / 1000 : 0,
    }))
    .sort((a, b) => b.expenseMinor - a.expenseMinor)
    .slice(0, MAX_TOP_CATEGORIES);

  const monthlyTotals = [...monthly.values()].sort((a, b) => (a.month < b.month ? -1 : 1)).slice(-MAX_MONTHS);
  const current = monthlyTotals[monthlyTotals.length - 1] || null;
  const previous = monthlyTotals[monthlyTotals.length - 2] || null;

  const deltas = current && previous
    ? {
        expenseDeltaMinor: current.expenseMinor - previous.expenseMinor,
        incomeDeltaMinor: current.incomeMinor - previous.incomeMinor,
        expensePct: previous.expenseMinor > 0
          ? Math.round(((current.expenseMinor - previous.expenseMinor) / previous.expenseMinor) * 1000) / 10
          : null,
      }
    : null;

  const savingsRate = primary.incomeMinor > 0
    ? Math.round((primary.netMinor / primary.incomeMinor) * 1000) / 10
    : null;

  return {
    currency: primary.currency,
    totals,
    topCategories,
    monthlyTotals,
    deltas,
    transactionCount: counted,
    savingsRate,
    budgetCount: Array.isArray(budgets) ? budgets.length : 0,
    monthsCovered: monthlyTotals.length,
    requestedMonths: months,
  };
}

/**
 * Deterministic highlights for the Insights feature (no model required). Each
 * item is `{ code, tone, data }`; the UI supplies localized copy from `code`.
 */
export function buildHighlights(context) {
  const highlights = [];
  if (!context || context.transactionCount === 0) {
    highlights.push({ code: 'noData', tone: 'neutral', data: {} });
    return highlights;
  }

  const top = context.topCategories[0];
  if (top && top.expenseMinor > 0) {
    highlights.push({
      code: 'topCategory',
      tone: 'brand',
      data: { name: top.name || 'Uncategorized', sharePct: Math.round(top.share * 100), amount: formatMajor(top.expenseMinor) },
    });
  }

  if (context.savingsRate !== null) {
    highlights.push({
      code: context.savingsRate >= 0 ? 'saving' : 'overspending',
      tone: context.savingsRate >= 0 ? 'income' : 'expense',
      data: { ratePct: context.savingsRate },
    });
  }

  if (context.deltas && context.deltas.expensePct !== null) {
    const up = context.deltas.expensePct > 0;
    highlights.push({
      code: up ? 'spendUp' : 'spendDown',
      tone: up ? 'expense' : 'income',
      data: { pct: Math.abs(context.deltas.expensePct) },
    });
  }

  if (context.budgetCount > 0) {
    highlights.push({ code: 'budgetsTracked', tone: 'neutral', data: { count: context.budgetCount } });
  }

  return highlights;
}
