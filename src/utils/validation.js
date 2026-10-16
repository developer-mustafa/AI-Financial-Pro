/**
 * Validation layer.
 *
 * Every validator is a pure function: `validate(input, context) -> {ok, value, errors, warnings}`.
 * `value` is always a fully normalised record (sanitised strings, integer minor
 * units, resolved ids) so callers never re-implement coercion. When validation
 * fails the caller keeps the user's raw input in the form (no data loss).
 */

import { appConfig } from '../config/appConfig.js';
import { ACCOUNT_TYPES, PAYMENT_METHODS, BUDGET_PERIODS, RECURRING_FREQUENCIES, TRANSACTION_STATUSES, GOAL_STATUSES, DEFAULT_PREFERENCES } from '../config/defaults.js';
import { normalizeCurrency, isValidCurrency, parseAmountToMinor } from './currency.js';
import { isValidISODate, todayISO, nowISO, compareISO } from './date.js';
import { sanitizeLine, sanitizeText, sanitizeColor, sanitizeIconName } from './sanitize.js';
import { findDuplicates } from './calculations.js';

export const AMOUNT_MIN_MINOR = 1;
export const AMOUNT_MAX_MINOR = 1e15;

const TYPE_VALUES = ['income', 'expense', 'transfer'];
const QUERY = appConfig.limits;

export const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
export const isNonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0;

const values = (list) => list.map((entry) => entry.value);

/** OK/error result builders keep the shape uniform. */
const okResult = (value, warnings = []) => ({ ok: true, value, errors: {}, warnings });
const failResult = (errors, value = null, warnings = []) => ({ ok: false, value, errors, warnings });

/**
 * Coerces user input into positive integer minor units.
 * Accepts `amountMinor` (must already be a safe integer) or a human `amount`.
 */
export function coerceAmount(input, currency = 'BDT') {
  if (input === null || input === undefined) return { ok: false, error: 'Enter an amount.' };
  const raw = typeof input === 'string' ? input.trim() : input;
  if (raw === '') return { ok: false, error: 'Enter an amount.' };

  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return { ok: false, error: 'Enter a valid number.' };
    if (!Number.isSafeInteger(raw)) return { ok: false, error: 'Amounts must not have more than 2 decimal places.' };
    if (raw <= 0) return { ok: false, error: 'Amount must be greater than zero.' };
    if (raw > AMOUNT_MAX_MINOR) return { ok: false, error: 'That amount is unrealistically large.' };
    return { ok: true, minor: raw };
  }

  const minor = parseAmountToMinor(raw, currency);
  if (!Number.isFinite(minor)) return { ok: false, error: 'Enter a valid number.' };
  if (minor <= 0) return { ok: false, error: 'Amount must be greater than zero.' };
  if (minor > AMOUNT_MAX_MINOR) return { ok: false, error: 'That amount is unrealistically large.' };
  return { ok: true, minor };
}

/** Accepts a signed minor-unit value (used for opening balances). */
export function coerceSignedAmount(input, currency = 'BDT') {
  if (input === '' || input === null || input === undefined) return { ok: true, minor: 0 };
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) return { ok: false, error: 'Enter a valid number.' };
    if (!Number.isSafeInteger(input)) return { ok: false, error: 'Amounts must not have more than 2 decimal places.' };
    if (Math.abs(input) > AMOUNT_MAX_MINOR) return { ok: false, error: 'That amount is unrealistically large.' };
    return { ok: true, minor: input };
  }
  const str = String(input).trim();
  const negative = /^[-−]/.test(str);
  const parsed = parseAmountToMinor(str.replace(/^[-−+]/, ''), currency);
  if (!Number.isFinite(parsed)) return { ok: false, error: 'Enter a valid number.' };
  if (parsed > AMOUNT_MAX_MINOR) return { ok: false, error: 'That amount is unrealistically large.' };
  return { ok: true, minor: negative ? -parsed : parsed };
}

export function normalizeTags(input, existing = []) {
  const list = Array.isArray(input) ? input : Array.isArray(existing) ? existing : [];
  const seen = new Set();
  const tags = [];
  for (const raw of list) {
    const tag = sanitizeLine(raw, QUERY.maxTagLength).replace(/^#/, '');
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
    if (tags.length >= QUERY.maxTags) break;
  }
  return tags;
}

export function parseTagInput(raw) {
  if (Array.isArray(raw)) return normalizeTags(raw);
  return normalizeTags(String(raw || '').split(','));
}

/* --------------------------------------------------------------------------- *
 * Transactions
 * --------------------------------------------------------------------------- */

export function validateTransaction(input, ctx = {}) {
  const {
    accounts = [],
    categories = [],
    existing = [],
    preferences = DEFAULT_PREFERENCES,
    excludeId = null
  } = ctx;

  const errors = {};
  const warnings = [];
  const source = isPlainObject(input) ? input : {};
  const accountMap = new Map(accounts.map((a) => [a.id, a]));
  const categoryMap = new Map(categories.map((c) => [c.id, c]));

  const type = TYPE_VALUES.includes(source.type) ? source.type : 'expense';
  const account = accountMap.get(source.accountId);
  if (!account) errors.accountId = 'Choose a valid account.';
  else if (account.archived && source.accountId !== ctx.currentAccountId) errors.accountId = 'That account is archived. Choose an active account.';

  const currency = normalizeCurrency(source.currency || account?.currency || preferences.currency);

  const amount = coerceAmount(source.amountMinor ?? source.amount, currency);
  if (!amount.ok) errors.amount = amount.error;

  const date = isValidISODate(source.date) ? source.date : null;
  if (!date) errors.date = 'Choose a valid date (YYYY-MM-DD).';

  let categoryId = null;
  let toAccountId = null;

  if (type === 'transfer') {
    const destination = accountMap.get(source.toAccountId);
    if (!destination) errors.toAccountId = 'Choose a destination account.';
    else if (destination.id === source.accountId) errors.toAccountId = 'Source and destination accounts must be different.';
    else if (account && normalizeCurrency(destination.currency) !== normalizeCurrency(account.currency)) {
      errors.toAccountId = 'Transfers between accounts in different currencies are not supported.';
    } else toAccountId = destination.id;

    if (source.categoryId) warnings.push('Transfers do not use a category; the category was ignored.');
  } else {
    const category = source.categoryId ? categoryMap.get(source.categoryId) : null;
    if (!source.categoryId) {
      errors.categoryId = 'Choose a category.';
    } else if (!category) {
      errors.categoryId = 'That category no longer exists.';
    } else if (category.type !== type) {
      errors.categoryId = `Choose a ${type} category.`;
    } else if (category.archived && source.categoryId !== ctx.currentCategoryId) {
      errors.categoryId = 'That category is archived. Choose an active category.';
    } else {
      categoryId = category.id;
    }
  }

  const paymentMethod = values(PAYMENT_METHODS).includes(source.paymentMethod) ? source.paymentMethod : 'cash';
  const status = values(TRANSACTION_STATUSES).includes(source.status) ? source.status : 'posted';
  const tags = normalizeTags(source.tags);
  const description = sanitizeLine(source.description, QUERY.maxString.description);
  const payee = sanitizeLine(source.payee, QUERY.maxString.payee);
  const notes = sanitizeText(source.notes, QUERY.maxString.notes);

  const value = {
    id: typeof source.id === 'string' && source.id ? source.id : null,
    type,
    amountMinor: amount.ok ? amount.minor : null,
    currency,
    categoryId,
    accountId: account ? account.id : null,
    toAccountId,
    date,
    description,
    payee,
    paymentMethod,
    tags,
    notes,
    status,
    recurringRuleId: typeof source.recurringRuleId === 'string' && source.recurringRuleId ? source.recurringRuleId : null,
    occurrenceKey: typeof source.occurrenceKey === 'string' && source.occurrenceKey ? source.occurrenceKey.slice(0, 200) : null,
    receiptRef: isNonEmptyString(source.receiptRef) ? sanitizeLine(source.receiptRef, QUERY.maxString.url) : null,
    createdAt: sanitizeLine(source.createdAt, 40) || nowISO(),
    updatedAt: nowISO()
  };

  // Duplicate guard: a strong warning, not a hard failure — the user may
  // legitimately record two identical purchases on the same day.
  if (Object.keys(errors).length === 0) {
    const duplicates = findDuplicates(
      existing.filter((tx) => tx.id !== excludeId),
      value,
      { windowDays: 1 }
    );
    if (duplicates.length > 0) {
      warnings.push(`A very similar transaction already exists (${duplicates.length}). Add it anyway only if this is a different entry.`);
    }
  }

  return Object.keys(errors).length ? failResult(errors, value, warnings) : okResult(value, warnings);
}

/* --------------------------------------------------------------------------- *
 * Accounts
 * --------------------------------------------------------------------------- */

export function validateAccount(input, ctx = {}) {
  const { accounts = [], excludeId = null } = ctx;
  const source = isPlainObject(input) ? input : {};
  const errors = {};

  const name = sanitizeLine(source.name, QUERY.maxString.name);
  if (!name) errors.name = 'Enter an account name.';
  const duplicate = accounts.find(
    (a) => a.id !== excludeId && !a.archived && a.name.trim().toLowerCase() === name.toLowerCase()
  );
  if (duplicate && !duplicate.archived) errors.name = 'An account with this name already exists.';

  const type = values(ACCOUNT_TYPES).includes(source.type) ? source.type : 'cash';
  const currency = isValidCurrency(source.currency) ? normalizeCurrency(source.currency) : null;
  if (!currency) errors.currency = 'Choose a valid 3-letter currency code.';

  const opening = coerceSignedAmount(source.openingBalanceMinor ?? source.openingBalance ?? 0, currency || 'BDT');
  if (!opening.ok) errors.openingBalance = opening.error;

  const openingBalanceDate = isValidISODate(source.openingBalanceDate) ? source.openingBalanceDate : todayISO();

  const value = {
    id: typeof source.id === 'string' && source.id ? source.id : null,
    name,
    type,
    currency: currency || 'BDT',
    openingBalanceMinor: opening.ok ? opening.minor : 0,
    openingBalanceDate,
    color: sanitizeColor(source.color, '#6366f1'),
    icon: sanitizeIconName(source.icon, 'wallet'),
    archived: Boolean(source.archived),
    createdAt: sanitizeLine(source.createdAt, 40) || nowISO(),
    updatedAt: nowISO()
  };

  return Object.keys(errors).length ? failResult(errors, value) : okResult(value);
}

/* --------------------------------------------------------------------------- *
 * Categories
 * --------------------------------------------------------------------------- */

const MAX_CATEGORY_DEPTH = 3;

export function categoryDepth(category, categories) {
  let depth = 0;
  let cursor = category;
  const seen = new Set();
  while (cursor?.parentId && depth < 10) {
    if (seen.has(cursor.parentId)) return 99; // cycle detected
    seen.add(cursor.parentId);
    cursor = categories.find((c) => c.id === cursor.parentId);
    if (!cursor) break;
    depth += 1;
  }
  return depth;
}

export function isDescendant(candidateParentId, categoryId, categories) {
  let cursor = categories.find((c) => c.id === candidateParentId);
  const seen = new Set();
  while (cursor && !seen.has(cursor.id)) {
    if (cursor.id === categoryId) return true;
    seen.add(cursor.id);
    cursor = categories.find((c) => c.id === cursor.parentId);
  }
  return false;
}

export function validateCategory(input, ctx = {}) {
  const { categories = [], excludeId = null } = ctx;
  const source = isPlainObject(input) ? input : {};
  const errors = {};

  const name = sanitizeLine(source.name, QUERY.maxString.name);
  if (!name) errors.name = 'Enter a category name.';

  const type = source.type === 'income' ? 'income' : 'expense';

  let parentId = null;
  if (source.parentId) {
    const parent = categories.find((c) => c.id === source.parentId);
    if (!parent) errors.parentId = 'That parent category no longer exists.';
    else if (parent.type !== type) errors.parentId = 'A subcategory must have the same type as its parent.';
    else if (parent.id === excludeId) errors.parentId = 'A category cannot be its own parent.';
    else if (excludeId && isDescendant(parent.id, excludeId, categories)) errors.parentId = 'That would create a circular category hierarchy.';
    else if (categoryDepth(parent, categories) >= MAX_CATEGORY_DEPTH) errors.parentId = `Categories can be nested at most ${MAX_CATEGORY_DEPTH} levels deep.`;
    else parentId = parent.id;
  }

  const duplicate = categories.find(
    (c) =>
      c.id !== excludeId &&
      !c.archived &&
      c.type === type &&
      (c.parentId || null) === parentId &&
      c.name.trim().toLowerCase() === name.toLowerCase()
  );
  if (duplicate) errors.name = 'A category with this name already exists at this level.';
  else {
    // Restoring/renaming must not clash with an archived twin either.
    const archivedTwin = categories.find(
      (c) => c.id !== excludeId && c.archived && c.type === type && c.name.trim().toLowerCase() === name.toLowerCase()
    );
    if (archivedTwin) ctx.onArchivedTwin?.(archivedTwin);
  }

  const value = {
    id: typeof source.id === 'string' && source.id ? source.id : null,
    name,
    type,
    parentId,
    icon: sanitizeIconName(source.icon, type === 'income' ? 'trending-up' : 'tag'),
    color: sanitizeColor(source.color, type === 'income' ? '#10b981' : '#64748b'),
    archived: Boolean(source.archived),
    isDefault: Boolean(source.isDefault),
    createdAt: sanitizeLine(source.createdAt, 40) || nowISO(),
    updatedAt: nowISO()
  };

  return Object.keys(errors).length ? failResult(errors, value) : okResult(value);
}

/* --------------------------------------------------------------------------- *
 * Budgets
 * --------------------------------------------------------------------------- */

export function validateBudget(input, ctx = {}) {
  const { categories = [], preferences = DEFAULT_PREFERENCES, excludeId = null } = ctx;
  const source = isPlainObject(input) ? input : {};
  const errors = {};

  const name = sanitizeLine(source.name, QUERY.maxString.name);
  if (!name) errors.name = 'Enter a budget name.';

  const period = values(BUDGET_PERIODS).includes(source.period) ? source.period : 'monthly';

  const limit = coerceAmount(source.limitMinor ?? source.limit, source.currency || preferences.currency);
  if (!limit.ok) errors.limit = limit.error;

  const currency = isValidCurrency(source.currency) ? normalizeCurrency(source.currency) : normalizeCurrency(preferences.currency);

  const scope = source.scope === 'category' ? 'category' : 'overall';
  let categoryId = null;
  if (scope === 'category') {
    const category = categories.find((c) => c.id === source.categoryId);
    if (!category) errors.categoryId = 'Choose a category for this budget.';
    else if (category.type !== 'expense') errors.categoryId = 'Budgets can only track expense categories.';
    else categoryId = category.id;
  }

  const startDate = isValidISODate(source.startDate) ? source.startDate : todayISO();
  const endDate = isValidISODate(source.endDate) ? source.endDate : `${new Date().getFullYear()}-12-31`;
  if (compareISO(startDate, endDate) > 0) errors.startDate = 'The start date must be on or before the end date.';

  const rawThresholds = Array.isArray(source.alertThresholds) ? source.alertThresholds : preferences.alertThresholds;
  const alertThresholds = [...new Set(
    rawThresholds
      .map((n) => Math.round(Number(n)))
      .filter((n) => Number.isFinite(n) && n >= 1 && n <= 500)
  )].sort((a, b) => a - b);
  if (alertThresholds.length === 0) errors.alertThresholds = 'Add at least one alert threshold (1–500).';

  const value = {
    id: typeof source.id === 'string' && source.id ? source.id : null,
    name,
    period,
    limitMinor: limit.ok ? limit.minor : null,
    currency,
    scope,
    categoryId,
    startDate,
    endDate,
    alertThresholds: alertThresholds.length ? alertThresholds : [75, 90, 100],
    status: source.status === 'paused' ? 'paused' : 'active',
    archived: Boolean(source.archived),
    notes: sanitizeText(source.notes, QUERY.maxString.notes),
    createdAt: sanitizeLine(source.createdAt, 40) || nowISO(),
    updatedAt: nowISO()
  };

  if (!errors.name && excludeId === null) {
    const duplicate = (ctx.budgets || []).find(
      (b) => !b.archived && b.name.trim().toLowerCase() === name.toLowerCase() && b.period === period
    );
    if (duplicate) errors.name = 'An active budget with this name and period already exists.';
  }

  return Object.keys(errors).length ? failResult(errors, value) : okResult(value);
}

/* --------------------------------------------------------------------------- *
 * Recurring rules
 * --------------------------------------------------------------------------- */

export function validateRecurring(input, ctx = {}) {
  const { accounts = [], categories = [], preferences = DEFAULT_PREFERENCES } = ctx;
  const source = isPlainObject(input) ? input : {};
  const errorsMap = {};
  const name = sanitizeLine(source.name, QUERY.maxString.name);
  if (!name) errorsMap.name = 'Enter a name for this recurring rule.';

  const type = TYPE_VALUES.includes(source.type) ? source.type : 'expense';

  const account = accounts.find((a) => a.id === source.accountId);
  if (!account) errorsMap.accountId = 'Choose a valid account.';
  else if (account.archived && source.accountId !== ctx.currentAccountId) errorsMap.accountId = 'That account is archived.';

  const currency = normalizeCurrency(source.currency || account?.currency || preferences.currency);
  const amount = coerceAmount(source.amountMinor ?? source.amount, currency);
  if (!amount.ok) errorsMap.amount = amount.error;

  let categoryId = null;
  let toAccountId = null;
  if (type === 'transfer') {
    const destination = accounts.find((a) => a.id === source.toAccountId);
    if (!destination) errorsMap.toAccountId = 'Choose a destination account.';
    else if (destination.id === source.accountId) errorsMap.toAccountId = 'Source and destination must differ.';
    else if (account && normalizeCurrency(destination.currency) !== normalizeCurrency(account.currency)) {
      errorsMap.toAccountId = 'Cross-currency transfers are not supported.';
    } else toAccountId = destination.id;
  } else {
    const category = categories.find((c) => c.id === source.categoryId);
    if (!category) errorsMap.categoryId = 'Choose a category.';
    else if (category.type !== type) errorsMap.categoryId = `Choose a ${type} category.`;
    else if (category.archived) errorsMap.categoryId = 'That category is archived.';
    else categoryId = category.id;
  }

  const frequency = values(RECURRING_FREQUENCIES).includes(source.frequency) ? source.frequency : 'monthly';
  const intervalCount = Math.min(365, Math.max(1, Math.round(Number(source.intervalCount) || 1)));
  if (!Number.isFinite(Number(source.intervalCount ?? 1)) || Number(source.intervalCount ?? 1) < 1) {
    errorsMap.intervalCount = 'The interval must be at least 1.';
  }

  const startDate = isValidISODate(source.startDate) ? source.startDate : todayISO();
  if (!isValidISODate(source.startDate)) errorsMap.startDate = 'Choose a valid start date.';

  const nextDueDate = isValidISODate(source.nextDueDate) ? source.nextDueDate : startDate;
  if (isValidISODate(source.nextDueDate) && compareISO(nextDueDate, startDate) < 0) {
    errorsMap.nextDueDate = 'The next due date cannot be before the start date.';
  }

  let endDate = null;
  if (source.endDate) {
    if (!isValidISODate(source.endDate)) errorsMap.endDate = 'Choose a valid end date or leave it empty.';
    else if (compareISO(source.endDate, startDate) < 0) errorsMap.endDate = 'The end date cannot be before the start date.';
    else endDate = source.endDate;
  }

  const value = {
    id: typeof source.id === 'string' && source.id ? source.id : null,
    name,
    type,
    amountMinor: amount.ok ? amount.minor : null,
    currency,
    categoryId,
    accountId: account ? account.id : null,
    toAccountId,
    frequency,
    intervalCount,
    startDate,
    nextDueDate,
    endDate,
    notes: sanitizeText(source.notes, QUERY.maxString.notes),
    status: source.status === 'paused' ? 'paused' : 'active',
    paymentMethod: values(PAYMENT_METHODS).includes(source.paymentMethod) ? source.paymentMethod : 'cash',
    lastGeneratedDate: isValidISODate(source.lastGeneratedDate) ? source.lastGeneratedDate : null,
    createdAt: sanitizeLine(source.createdAt, 40) || nowISO(),
    updatedAt: nowISO()
  };

  if (!errorsMap.nextDueDate && !errorsMap.startDate && !source.nextDueDate) {
    value.nextDueDate = startDate;
  }

  const errorObject = { ...errorsMap };
  if (Object.keys(errorObject).length === 0 && !Number.isFinite(amount.minor)) {
    errorObject.amount = 'Enter a valid amount.';
  }
  return Object.keys(errorObject).length ? failResult(errorObject, value) : okResult(value);
}

/* --------------------------------------------------------------------------- *
 * Goals + contributions
 * --------------------------------------------------------------------------- */

export function validateGoal(input, ctx = {}) {
  const { accounts = [], preferences = DEFAULT_PREFERENCES } = ctx;
  const source = isPlainObject(input) ? input : {};
  const errors = {};

  const name = sanitizeLine(source.name, QUERY.maxString.name);
  if (!name) errors.name = 'Enter a goal name.';

  const currency = isValidCurrency(source.currency) ? normalizeCurrency(source.currency) : normalizeCurrency(preferences.currency);
  const target = coerceAmount(source.targetMinor ?? source.target, currency);
  if (!target.ok) errors.target = target.error;

  const saved = coerceSignedAmount(source.savedMinor ?? 0, currency);
  if (!saved.ok) errors.saved = saved.error;
  else if (saved.minor < 0) errors.saved = 'Saved amount cannot be negative.';

  let targetDate = null;
  if (source.targetDate) {
    if (!isValidISODate(source.targetDate)) errors.targetDate = 'Choose a valid target date or leave it empty.';
    else targetDate = source.targetDate;
  }

  let accountId = null;
  if (source.accountId) {
    const account = accounts.find((a) => a.id === source.accountId);
    if (!account) errors.accountId = 'That account no longer exists.';
    else accountId = account.id;
  }

  const status = values(GOAL_STATUSES).includes(source.status) ? source.status : 'active';

  const contributions = Array.isArray(source.contributions)
    ? source.contributions
        .filter((c) => isPlainObject(c))
        .slice(-500)
        .map((c) => ({
          id: sanitizeLine(c.id, 60) || null,
          amountMinor: Math.max(0, Math.round(Number(c.amountMinor) || 0)),
          direction: c.direction === 'withdrawal' ? 'withdrawal' : 'contribution',
          date: isValidISODate(c.date) ? c.date : todayISO(),
          note: sanitizeText(c.note, 200),
          transactionId: typeof c.transactionId === 'string' ? c.transactionId : null
        }))
    : [];

  const value = {
    id: typeof source.id === 'string' && source.id ? source.id : null,
    name,
    targetMinor: target.ok ? target.minor : null,
    savedMinor: saved.ok ? Math.max(0, saved.minor) : 0,
    currency,
    targetDate,
    accountId,
    icon: sanitizeIconName(source.icon, 'target'),
    color: sanitizeColor(source.color, '#14b8a6'),
    status,
    contributions,
    archived: Boolean(source.archived) || status === 'archived',
    createdAt: sanitizeLine(source.createdAt, 40) || nowISO(),
    updatedAt: nowISO()
  };

  return Object.keys(errors).length ? failResult(errors, value) : okResult(value);
}

/**
 * Records a contribution/withdrawal against a goal.
 * When `sourceAccountId` is supplied the caller must ALSO create a real
 * transfer so that no artificial income/expense is invented.
 */
export function validateContribution(input, ctx = {}) {
  const { goal, accounts = [] } = ctx;
  const source = isPlainObject(input) ? input : {};
  const errors = {};

  if (!goal) return failResult({ goal: 'That goal no longer exists.' });

  const direction = source.direction === 'withdrawal' ? 'withdrawal' : 'contribution';
  const currency = normalizeCurrency(goal.currency);
  const amount = coerceAmount(source.amountMinor ?? source.amount, currency);
  if (!amount.ok) errors.amount = amount.error;

  const saved = Number(goal.savedMinor) || 0;
  if (amount.ok && direction === 'withdrawal' && amount.minor > saved) {
    errors.amount = `You can withdraw at most ${saved} minor units from this goal.`;
  }

  let sourceAccountId = null;
  if (source.sourceAccountId) {
    const account = accounts.find((a) => a.id === source.sourceAccountId);
    if (!account) errors.sourceAccountId = 'Choose a valid funding account.';
    else if (normalizeCurrency(account.currency) !== currency) errors.sourceAccountId = 'That account uses a different currency.';
    else if (goal.accountId && account.id === goal.accountId) errors.sourceAccountId = 'The funding account must differ from the goal account.';
    else sourceAccountId = account.id;
  }
  if (sourceAccountId && !goal.accountId && direction === 'contribution') {
    errors.sourceAccountId = 'Link a savings account to this goal before recording real transfers.';
  }

  const date = isValidISODate(source.date) ? source.date : todayISO();

  const value = {
    id: typeof source.id === 'string' && source.id ? source.id : null,
    direction,
    amountMinor: amount.ok ? amount.minor : null,
    date,
    note: sanitizeText(source.note, 200),
    sourceAccountId,
    createTransfer: Boolean(sourceAccountId)
  };

  return Object.keys(errors).length ? failResult(errors, value) : okResult(value);
}

/* --------------------------------------------------------------------------- *
 * Preferences
 * --------------------------------------------------------------------------- */

const PREF_SPEC = {
  theme: { type: 'enum', values: ['light', 'dark', 'system'] },
  density: { type: 'enum', values: ['comfortable', 'compact'] },
  sidebarCollapsed: { type: 'boolean' },
  currency: { type: 'currency' },
  locale: { type: 'string', max: 20 },
  dateFormat: { type: 'enum', values: ['short', 'medium', 'long'] },
  numberFormat: { type: 'enum', values: ['standard', 'accounting'] },
  weekStart: { type: 'int', min: 0, max: 6 },
  defaultRange: {
    type: 'enum',
    values: ['today', 'thisWeek', 'thisMonth', 'lastMonth', 'last3Months', 'thisYear', 'lastYear', 'allTime', 'custom']
  },
  defaultAccountId: { type: 'id' },
  defaultCategoryId: { type: 'id' },
  defaultPaymentMethod: { type: 'enum', values: values(PAYMENT_METHODS) },
  budgetAlertsEnabled: { type: 'boolean' },
  alertThresholds: { type: 'intArray', min: 1, max: 500 },
  recurrenceAutoPrompt: { type: 'boolean' }
};

/** Merges + validates a partial preferences patch. Unknown keys are dropped. */
export function validatePreferences(patch, base = DEFAULT_PREFERENCES) {
  const errors = {};
  const value = { ...DEFAULT_PREFERENCES, ...base };
  if (!isPlainObject(patch)) return failResult({ preferences: 'Expected an object.' }, value);

  for (const [key, spec] of Object.entries(PREF_SPEC)) {
    if (!(key in patch)) continue;
    const raw = patch[key];
    switch (spec.type) {
      case 'enum':
        if (spec.values.includes(raw)) value[key] = raw;
        else errors[key] = `Choose one of: ${spec.values.join(', ')}.`;
        break;
      case 'boolean':
        value[key] = Boolean(raw);
        break;
      case 'currency':
        if (isValidCurrency(raw)) value[key] = normalizeCurrency(raw);
        else errors[key] = 'Choose a supported currency.';
        break;
      case 'int':
        if (Number.isInteger(raw) && raw >= spec.min && raw <= spec.max) value[key] = raw;
        else errors[key] = `Enter a whole number between ${spec.min} and ${spec.max}.`;
        break;
      case 'string':
        value[key] = sanitizeLine(raw, spec.max);
        break;
      case 'id':
        value[key] = isNonEmptyString(raw) ? String(raw).slice(0, 80) : null;
        break;
      case 'intArray': {
        const list = Array.isArray(raw) ? raw : [];
        const cleaned = [...new Set(list.map(Number).filter((n) => Number.isFinite(n) && n >= spec.min && n <= spec.max))].sort((a, b) => a - b);
        if (cleaned.length === 0) errors[key] = 'Add at least one threshold.';
        else value[key] = cleaned;
        break;
      }
      default:
        break;
    }
  }
  return Object.keys(errors).length ? failResult(errors, value) : okResult(value);
}

/* --------------------------------------------------------------------------- *
 * Import helpers
 * --------------------------------------------------------------------------- */

export function parseBooleanish(raw, fallback = false) {
  if (typeof raw === 'boolean') return raw;
  const str = String(raw ?? '').trim().toLowerCase();
  if (['true', '1', 'yes', 'y', 'on'].includes(str)) return true;
  if (['false', '0', 'no', 'n', 'off'].includes(str)) return false;
  return fallback;
}

export function parseTagsCell(raw) {
  return normalizeTags(String(raw ?? '').split(/[;,|]/));
}

