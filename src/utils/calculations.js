/**
 * Pure financial calculation layer.
 *
 * Everything in this file is a side-effect-free function over plain data so it
 * can be unit-tested without a DOM, a store, or a browser.
 *
 * DOCUMENTED BUSINESS RULES
 * -------------------------
 * 1. POSTED vs PENDING: reports and account balances include `posted`
 *    transactions only. `pending`/`draft` rows are shown in lists but excluded
 *    from every total unless `includePending: true` is passed explicitly.
 * 2. TRANSFERS are never income or expenses. They move value between two
 *    accounts and are excluded from income/expense/savings/budget maths.
 * 3. REFUND POLICY: a refund is recorded as an *income* transaction (default
 *    category "Refunds"). Refunds therefore increase income and never reduce
 *    the expense total or budget utilisation. This rule is applied everywhere
 *    and is stated verbatim in the UI (Settings → Data & privacy).
 * 4. CURRENCY: totals are computed for a single currency at a time. Amounts in
 *    different currencies are never added together and no exchange-rate
 *    conversion is performed.
 * 5. CREDIT CARDS: the ledger treats every account the same way — an expense
 *    is an outflow and increases what you owe, so a credit card balance is
 *    naturally negative while debt is outstanding. `accountBalance()` returns
 *    that signed value; the UI labels it "Owed".
 */

import { compareISO, isWithin, monthKey, monthKeysBetween, todayISO, addMonths, daysBetween, startOfMonth, endOfMonth, startOfWeek, endOfWeek, startOfYear, endOfYear, isValidISODate, parseISODate, addDays } from './date.js';
import { normalizeCurrency } from './currency.js';

export const FINANCIAL_RULES = Object.freeze({
  postedOnly: 'Draft and pending transactions are excluded from all reports and balances.',
  transfersExcluded: 'Transfers between accounts never count as income or expenses.',
  refunds: 'Refunds are recorded as income and never reduce expense totals or budget utilisation.',
  currency: 'Amounts in different currencies are never combined; no exchange-rate conversion is applied.',
  creditCard: 'A credit card balance is negative while money is owed; it is displayed as "Owed".'
});

export const ALL_STATUSES = ['posted', 'pending', 'draft'];

export const isPosted = (tx) => tx?.status === 'posted';
export const isIncome = (tx) => tx?.type === 'income';
export const isExpense = (tx) => tx?.type === 'expense';
export const isTransfer = (tx) => tx?.type === 'transfer';

/** Default eligibility filter used by every report. */
export function isCountable(tx, { includePending = false } = {}) {
  if (!tx) return false;
  if (includePending) return tx.status === 'posted' || tx.status === 'pending';
  return tx.status === 'posted';
}

export function matchesCurrency(tx, currency) {
  if (!currency) return true;
  return normalizeCurrency(tx?.currency) === normalizeCurrency(currency);
}

/**
 * The set of transactions that participate in reporting for the given filters.
 */
export function eligibleTransactions(transactions, { from = null, to = null, currency = null, includePending = false, type = null } = {}) {
  return (transactions || []).filter((tx) => {
    if (!isCountable(tx, { includePending })) return false;
    if (type && tx.type !== type) return false;
    if (currency && !matchesCurrency(tx, currency)) return false;
    if (from || to) {
      if (!isValidISODate(tx.date)) return false;
      if (!isWithin(tx.date, from, to)) return false;
    }
    return true;
  });
}

/* --------------------------------------------------------------------------- *
 * Account balances
 * --------------------------------------------------------------------------- */

/**
 * Signed balance of one account in minor units.
 * openingBalance + inflows − outflows.
 */
export function accountBalance(account, transactions, { includePending = false } = {}) {
  if (!account) return 0;
  const currency = normalizeCurrency(account.currency);
  let balance = Number(account.openingBalanceMinor) || 0;

  for (const tx of transactions || []) {
    if (!isCountable(tx, { includePending })) continue;
    // Guard: a transaction in another currency can never touch this account.
    if (normalizeCurrency(tx.currency) !== currency) continue;
    const amount = Number(tx.amountMinor) || 0;

    if (tx.type === 'transfer') {
      if (tx.accountId === account.id) balance -= amount;
      else if (tx.toAccountId === account.id) balance += amount;
    } else if (tx.accountId === account.id) {
      if (tx.type === 'income') balance += amount;
      else if (tx.type === 'expense') balance -= amount;
    }
  }
  return balance;
}

/** Map of accountId -> signed balance (minor units). */
export function accountBalances(accounts, transactions, options = {}) {
  const map = new Map();
  for (const account of accounts || []) map.set(account.id, accountBalance(account, transactions, options));
  return map;
}

/** Total of all non-archived asset accounts, grouped by currency. */
export function netWorthByCurrency(accounts, transactions, { includeArchived = false, includePending = false } = {}) {
  const totals = new Map();
  for (const account of accounts || []) {
    if (!includeArchived && account.archived) continue;
    const code = normalizeCurrency(account.currency);
    const current = totals.get(code) || 0;
    totals.set(code, current + accountBalance(account, transactions, { includePending }));
  }
  return totals;
}

/** Credit-card style label: "Owed" when negative. */
export function accountBalanceLabelMinor(account, balanceMinor) {
  const liability = account?.type === 'credit_card';
  return { minor: balanceMinor, liability, isDebt: liability ? balanceMinor < 0 : balanceMinor < 0 };
}

/* --------------------------------------------------------------------------- *
 * Period summaries
 * --------------------------------------------------------------------------- */

/**
 * Income / expense / net for a period.
 * `savingsRate` is `null` (not 0, not Infinity) when income is zero.
 */
export function periodSummary(transactions, { from = null, to = null, currency = null, includePending = false } = {}) {
  const eligible = eligibleTransactions(transactions, { from, to, currency, includePending });
  let incomeMinor = 0;
  let expenseMinor = 0;
  let incomeCount = 0;
  let expenseCount = 0;
  let pendingCount = 0;

  for (const tx of eligible) {
    if (tx.status !== 'posted') pendingCount += 1;
    if (tx.type === 'income') {
      incomeMinor += Number(tx.amountMinor) || 0;
      incomeCount += 1;
    } else if (tx.type === 'expense') {
      expenseMinor += Number(tx.amountMinor) || 0;
      expenseCount += 1;
    }
  }

  const netMinor = incomeMinor - expenseMinor;
  const savingsRate = incomeMinor > 0 ? (netMinor / incomeMinor) * 100 : null;
  const expenseRatio = incomeMinor > 0 ? (expenseMinor / incomeMinor) * 100 : null;

  return { incomeMinor, expenseMinor, netMinor, savingsRate, expenseRatio, incomeCount, expenseCount, pendingCount, count: eligible.length };
}

/** Total of every transfer that left or entered an account in a period. */
export function transferTotals(transactions, { from = null, to = null, currency = null, includePending = false } = {}) {
  const eligible = eligibleTransactions(transactions, { from, to, currency, includePending, type: 'transfer' });
  const out = new Map();
  for (const tx of eligible) {
    out.set(tx.accountId, (out.get(tx.accountId) || 0) + (Number(tx.amountMinor) || 0));
  }
  return out;
}

/* --------------------------------------------------------------------------- *
 * Category breakdowns
 * --------------------------------------------------------------------------- */

/**
 * @returns {Array<{categoryId:string,name:string,color:string,icon:string,totalMinor:number,count:number,share:number}>}
 * Sorted by total descending. Unknown/archived categories are labelled from the
 * category map when available so historical reporting stays intact.
 */
export function categoryBreakdown(transactions, categories, { type = 'expense', from = null, to = null, currency = null, includePending = false, limit = null } = {}) {
  const categoryMap = new Map((categories || []).map((c) => [c.id, c]));
  const eligible = eligibleTransactions(transactions, { from, to, currency, includePending, type });
  const totals = new Map();
  let grand = 0;

  for (const tx of eligible) {
    const key = tx.categoryId || '__uncategorised__';
    const amount = Number(tx.amountMinor) || 0;
    const entry = totals.get(key) || { categoryId: key, totalMinor: 0, count: 0 };
    entry.totalMinor += amount;
    entry.count += 1;
    totals.set(key, entry);
    grand += amount;
  }

  const rows = [...totals.values()].map((entry) => {
    const category = categoryMap.get(entry.categoryId);
    return {
      ...entry,
      name: category ? category.name : entry.categoryId === '__uncategorised__' ? 'Uncategorised' : 'Deleted category',
      color: category?.color || '#94a3b8',
      icon: category?.icon || 'circle-ellipsis',
      archived: Boolean(category?.archived),
      share: grand > 0 ? (entry.totalMinor / grand) * 100 : 0
    };
  });

  rows.sort((a, b) => b.totalMinor - a.totalMinor || a.name.localeCompare(b.name));
  return limit ? rows.slice(0, limit) : rows;
}

/* --------------------------------------------------------------------------- *
 * Time series
 * --------------------------------------------------------------------------- */

/**
 * Month-by-month cash flow including a running (cumulative) savings balance.
 * @returns {Array<{month:string,label:string,incomeMinor:number,expenseMinor:number,netMinor:number,cumulativeMinor:number,count:number}>}
 */
export function monthlyCashflow(transactions, { from, to, currency = null, includePending = false, openingBalanceMinor = 0 } = {}) {
  const months = monthKeysBetween(from, to);
  const bucket = new Map(months.map((m) => [m, { month: m, incomeMinor: 0, expenseMinor: 0, netMinor: 0, cumulativeMinor: 0, count: 0 }]));
  const eligible = eligibleTransactions(transactions, { from, to, currency, includePending });

  for (const tx of eligible) {
    const key = monthKey(tx.date);
    const row = bucket.get(key);
    if (!row) continue;
    row.count += 1;
    if (tx.type === 'income') row.incomeMinor += Number(tx.amountMinor) || 0;
    else if (tx.type === 'expense') row.expenseMinor += Number(tx.amountMinor) || 0;
  }

  let running = Number(openingBalanceMinor) || 0;
  return months.map((m) => {
    const row = bucket.get(m);
    row.netMinor = row.incomeMinor - row.expenseMinor;
    running += row.netMinor;
    row.cumulativeMinor = running;
    return row;
  });
}

/**
 * Income vs expense for the last `count` months ending at `to`.
 */
export function recentMonthlyComparison(transactions, { to = todayISO(), count = 6, currency = null, includePending = false } = {}) {
  const from = startOfMonth(addMonths(to, -(count - 1)));
  return monthlyCashflow(transactions, { from, to, currency, includePending });
}

/**
 * Snapshot of every account balance that changed during the period, newest
 * first. Used by the account report.
 */
export function accountMovements(account, transactions, { from = null, to = null, includePending = false } = {}) {
  const currency = normalizeCurrency(account?.currency);
  return (transactions || [])
    .filter((tx) => {
      if (!isCountable(tx, { includePending })) return false;
      if (normalizeCurrency(tx.currency) !== currency) return false;
      if (tx.accountId !== account.id && tx.toAccountId !== account.id) return false;
      return !from && !to ? true : isWithin(tx.date, from, to);
    })
    .sort((a, b) => compareISO(b.date, a.date) || String(b.createdAt).localeCompare(String(a.createdAt)));
}

/* --------------------------------------------------------------------------- *
 * Budgets
 * --------------------------------------------------------------------------- */

/**
 * The concrete date window a budget applies to right now.
 * A "monthly" budget is not a single fixed window: it repeats every month
 * between `startDate` and `endDate`. If today falls outside that span the
 * budget is inactive and `null` is returned.
 */
export function budgetWindow(budget, today = todayISO(), weekStart = 0) {
  if (!budget || !isValidISODate(budget.startDate) || !isValidISODate(budget.endDate)) return null;
  if (compareISO(today, budget.startDate) < 0 || compareISO(today, budget.endDate) > 0) return null;

  const spans = {
    weekly: () => [startOfWeek(today, weekStart), endOfWeek(today, weekStart)],
    monthly: () => [startOfMonth(today), endOfMonth(today)],
    yearly: () => [startOfYear(today), endOfYear(today)]
  };
  const [rawFrom, rawTo] = (spans[budget.period] || spans.monthly)();

  const from = compareISO(rawFrom, budget.startDate) > 0 ? rawFrom : budget.startDate;
  const to = compareISO(rawTo, budget.endDate) < 0 ? rawTo : budget.endDate;
  if (compareISO(from, to) > 0) return null;
  return { from, to, period: budget.period };
}

/**
 * Budget utilisation. Only POSTED EXPENSE transactions inside the budget
 * window, matching the budget's currency and (for category budgets) its
 * category, are counted. Transfers and income never count.
 *
 * @returns {null|{spentMinor:number,remainingMinor:number,percent:number,overMinor:number,state:string,window:object,count:number}}
 */
export function budgetStatus(budget, transactions, { today = todayISO(), weekStart = 0, includePending = false, categories = [] } = {}) {
  const window = budgetWindow(budget, today, weekStart);
  if (!window || budget.archived || budget.status !== 'active') return null;

  const limit = Number(budget.limitMinor) || 0;
  const currency = normalizeCurrency(budget.currency);

  // Category budgets include subcategories of the selected category.
  let categoryIds = null;
  if (budget.scope === 'category') {
    if (!budget.categoryId) return null;
    const children = new Map();
    for (const category of categories || []) {
      const list = children.get(category.parentId) || [];
      list.push(category.id);
      children.set(category.parentId, list);
    }
    categoryIds = new Set([budget.categoryId]);
    const queue = [budget.categoryId];
    while (queue.length) {
      const next = queue.shift();
      for (const childId of children.get(next) || []) {
        if (!categoryIds.has(childId)) {
          categoryIds.add(childId);
          queue.push(childId);
        }
      }
    }
  }

  const eligible = eligibleTransactions(transactions, {
    from: window.from,
    to: window.to,
    currency,
    includePending,
    type: 'expense'
  }).filter((tx) => (categoryIds ? categoryIds.has(tx.categoryId) : true));

  const spentMinor = eligible.reduce((sum, tx) => sum + (Number(tx.amountMinor) || 0), 0);
  const remainingMinor = limit - spentMinor;
  const percent = limit > 0 ? (spentMinor / limit) * 100 : 0;
  const overMinor = Math.max(0, spentMinor - limit);

  return {
    spentMinor,
    remainingMinor,
    percent,
    overMinor,
    count: eligible.length,
    window,
    state: percent >= 100 ? 'exceeded' : percent >= 90 ? 'danger' : percent >= 75 ? 'warning' : 'ok'
  };
}

/** All budgets that are active today, with utilisation, sorted worst-first. */
export function budgetOverview(budgets, transactions, options = {}) {
  const rows = [];
  for (const budget of budgets || []) {
    const status = budgetStatus(budget, transactions, options);
    if (status) rows.push({ budget, status });
  }
  rows.sort((a, b) => b.status.percent - a.status.percent);
  return rows;
}

/**
 * Threshold alerts (75 / 90 / 100 by default) across all active budgets.
 * Deduplicated per budget + threshold so the user is not spammed.
 */
export function budgetAlerts(budgets, transactions, { thresholds = [75, 90, 100], today = todayISO(), weekStart = 0, categories = [], acknowledged = {} } = {}) {
  const alerts = [];
  for (const { budget, status } of budgetOverview(budgets, transactions, { today, weekStart, categories })) {
    const level = [...thresholds].sort((a, b) => a - b).findLast((t) => status.percent >= t);
    if (level === undefined) continue;
    if (acknowledged?.[budget.id] === level) continue;
    alerts.push({ budget, status, level, key: `${budget.id}:${level}` });
  }
  return alerts.sort((a, b) => b.status.percent - a.status.percent);
}

/* --------------------------------------------------------------------------- *
 * Goals
 * --------------------------------------------------------------------------- */

/**
 * @returns {{percent:number,remainingMinor:number,daysLeft:number,monthsLeft:number,requiredMonthlyMinor:number,progressLabel:string}}
 */
export function goalProgress(goal, { today = todayISO() } = {}) {
  const target = Number(goal?.targetMinor) || 0;
  const saved = Math.max(0, Number(goal?.savedMinor) || 0);
  const percent = target > 0 ? Math.min(100, Math.max(0, (saved / target) * 100)) : 0;
  const remainingMinor = Math.max(0, target - saved);
  const daysLeft = goal?.targetDate && isValidISODate(goal.targetDate) ? daysBetween(today, goal.targetDate) : null;
  const monthsLeft = daysLeft === null ? null : Math.max(1, Math.ceil(daysLeft / 30.44));
  const requiredMonthlyMinor = monthsLeft && remainingMinor > 0 ? Math.ceil(remainingMinor / monthsLeft) : remainingMinor > 0 ? remainingMinor : 0;
  return {
    percent,
    remainingMinor,
    daysLeft,
    monthsLeft,
    requiredMonthlyMinor,
    onTrack: goal?.status === 'completed' || remainingMinor === 0
  };
}

/* --------------------------------------------------------------------------- *
 * Recurring rules
 * --------------------------------------------------------------------------- */

const ADVANCERS = {
  daily: (iso, step) => addDays(iso, step),
  weekly: (iso, step) => addDays(iso, step * 7),
  monthly: (iso, step) => addMonths(iso, step),
  yearly: (iso, step) => addMonths(iso, step * 12)
};

/** Advances a due date by `interval` periods for the rule's frequency. */
export function advanceDueDate(iso, frequency, interval = 1) {
  const advance = ADVANCERS[frequency] || ADVANCERS.monthly;
  return advance(iso, Math.max(1, Number(interval) || 1));
}

/**
 * Every occurrence of a rule from `nextDueDate` up to and including `untilISO`,
 * capped at `maxOccurrences` to protect against runaway loops.
 */
export function recurringDueDates(rule, { untilISO = todayISO(), maxOccurrences = 60 } = {}) {
  const due = [];
  if (!rule || rule.status !== 'active') return due;
  let cursor = isValidISODate(rule.nextDueDate) ? rule.nextDueDate : rule.startDate;
  if (!isValidISODate(cursor)) return due;
  let guard = 0;
  while (compareISO(cursor, untilISO) <= 0 && due.length < maxOccurrences && guard < 1000) {
    if (rule.endDate && compareISO(cursor, rule.endDate) > 0) break;
    due.push(cursor);
    cursor = advanceDueDate(cursor, rule.frequency, rule.intervalCount);
    guard += 1;
  }
  return due;
}

/**
 * Review queue for the "due transactions" flow: occurrences that are due but
 * have not yet been posted. `occurrenceKey` makes generation idempotent.
 */
export function pendingOccurrences(rules, transactions, { today = todayISO() } = {}) {
  const existing = new Set((transactions || []).filter((tx) => tx.occurrenceKey).map((tx) => tx.occurrenceKey));
  const queue = [];
  for (const rule of rules || []) {
    if (rule.status !== 'active') continue;
    for (const dueDate of recurringDueDates(rule, { untilISO: today })) {
      const key = `${rule.id}:${dueDate}`;
      if (existing.has(key)) continue;
      queue.push({ rule, dueDate, key });
    }
  }
  queue.sort((a, b) => compareISO(a.dueDate, b.dueDate));
  return queue;
}

/** Monthly-equivalent cost of a recurring rule (for planning views). */
export function recurringMonthlyEquivalent(rule) {
  const amount = Number(rule?.amountMinor) || 0;
  const interval = Math.max(1, Number(rule?.intervalCount) || 1);
  switch (rule?.frequency) {
    case 'daily': return Math.round((amount * 365) / 12 / interval);
    case 'weekly': return Math.round((amount * 52) / 12 / interval);
    case 'yearly': return Math.round(amount / 12 / interval);
    case 'monthly':
    default: return Math.round(amount / interval);
  }
}

/* --------------------------------------------------------------------------- *
 * Misc helpers
 * --------------------------------------------------------------------------- */

export function safeRatio(numerator, denominator, fallback = null) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return fallback;
  return numerator / denominator;
}

/** Transaction count per month for the transaction-history report. */
export function transactionCountByMonth(transactions, { from, to } = {}) {
  const counts = new Map();
  for (const tx of eligibleTransactions(transactions, { from, to })) {
    const key = monthKey(tx.date);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

/** Spending by category grouped by month — powers the trend widget. */
export function categoryTrend(transactions, categories, { from, to, currency = null, categoryIds = [], limit = 6 } = {}) {
  const months = monthKeysBetween(from, to);
  const top = categoryBreakdown(transactions, categories, { type: 'expense', from, to, currency, limit }).map((r) => r.categoryId);
  const wanted = categoryIds.length ? categoryIds : top;
  const series = new Map(wanted.map((id) => [id, months.map(() => 0)]));
  const index = new Map(months.map((m, i) => [m, i]));
  for (const tx of eligibleTransactions(transactions, { from, to, currency, type: 'expense' })) {
    const cursor = index.get(monthKey(tx.date));
    if (cursor === undefined) continue;
    const row = series.get(tx.categoryId);
    if (!row) continue;
    row[cursor] += Number(tx.amountMinor) || 0;
  }
  return { months, series };
}

/** Domain dupe-guard used by the transaction form and the import preview. */
export function transactionFingerprint(tx) {
  return [tx.type, tx.date, tx.amountMinor, (tx.description || '').toLowerCase(), tx.accountId, tx.categoryId || ''].join('|');
}

/** Finds likely duplicates of `candidate` among existing transactions. */
export function findDuplicates(transactions, candidate, { windowDays = 1 } = {}) {
  const fingerprint = transactionFingerprint(candidate);
  return (transactions || []).filter((tx) => {
    if (tx.id === candidate.id) return false;
    if (transactionFingerprint(tx) !== fingerprint) return false;
    const gap = Math.abs(daysBetween(tx.date, candidate.date));
    return gap <= windowDays;
  });
}

/** Clamp helper used by progress bars. */
export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
