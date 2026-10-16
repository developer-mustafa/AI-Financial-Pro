// src/validate.js
// Per-resource field whitelists, coercion and validation used by the CRUD
// endpoints and by PUT /api/state. Pure module: no DB imports, unit-testable.
//
// Design notes
// ------------
// * Field whitelisting: only names declared in the resource spec are accepted.
//   Unknown fields are silently dropped (never persisted, never echoed).
// * Money: authoritative storage is an integer number of MINOR units.
//   - `amountMinor` must be a safe integer in [1, 1e15]; floats are rejected.
//   - Legacy/simple clients may instead send `amount` in MAJOR units; it is
//     converted with Math.round(amount * 100) ONLY when `amountMinor` is
//     absent. `amountMinor` always wins when both are present.
// * Dates must match YYYY-MM-DD and be a real calendar date (2024-02-30 is
//   rejected, 2024-02-29 is accepted).
// * Enum values are validated against hard-coded allow-lists.

import { HttpError } from './http.js';

export const MAX_MINOR = 1_000_000_000_000_000; // 1e15, safely below 2^53
export const MAX_ROWS_PER_RESOURCE = 20000;

export const TRANSACTION_TYPES = ['income', 'expense', 'transfer'];
export const TRANSACTION_STATUS = ['posted', 'pending', 'draft'];
export const ENTRY_TYPES = ['income', 'expense'];
export const BUDGET_PERIODS = ['weekly', 'monthly', 'yearly'];
export const BUDGET_SCOPES = ['overall', 'category'];
export const FREQUENCIES = ['daily', 'weekly', 'monthly', 'yearly'];
export const RECURRING_STATUS = ['active', 'paused'];
export const GOAL_STATUS = ['active', 'completed', 'archived'];

function bad(message) {
  throw new HttpError(400, 'validation_error', message);
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function hasOwn(o, k) {
  return Object.prototype.hasOwnProperty.call(o, k);
}

// ---------------------------------------------------------------------------
// Primitive coercers
// ---------------------------------------------------------------------------

export function isRealDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function coerceDate(value, field, name) {
  if (value === null || value === undefined || value === '') {
    if (field.type === 'dateNullable') return null;
    bad(`${name} must be a YYYY-MM-DD date`);
  }
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    bad(`${name} must be a YYYY-MM-DD date`);
  }
  if (!isRealDate(value)) bad(`${name} is not a real calendar date`);
  return value;
}

function coerceId(value, field, name) {
  if (value === null || value === undefined) {
    if (field.type === 'idNullable') return null;
    bad(`${name} is required`);
  }
  if (typeof value !== 'string') bad(`${name} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length === 0) bad(`${name} must not be empty`);
  if (trimmed.length > 128) bad(`${name} must be at most 128 characters`);
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) bad(`${name} contains invalid control characters`);
  return trimmed;
}

function coerceMinor(value, name) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    bad(`${name} must be an integer number of minor units`);
  }
  if (value < 1 || value > MAX_MINOR) {
    bad(`${name} must be between 1 and ${MAX_MINOR}`);
  }
  return value;
}

/** Convert a MAJOR-unit amount to MINOR units. Only used as a fallback. */
function coerceMajor(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    bad(`${name} must be a finite number`);
  }
  if (value <= 0) bad(`${name} must be greater than zero`);
  const minor = Math.round(value * 100);
  if (!Number.isSafeInteger(minor) || minor < 1 || minor > MAX_MINOR) {
    bad(`${name} is out of range`);
  }
  return minor;
}

function coerceInt(value, field, name) {
  if (typeof value !== 'number' || !Number.isInteger(value)) bad(`${name} must be an integer`);
  const min = field.min ?? Number.MIN_SAFE_INTEGER;
  const max = field.max ?? Number.MAX_SAFE_INTEGER;
  if (value > MAX_MINOR || value < -MAX_MINOR || value < min || value > max) {
    bad(`${name} is out of range`);
  }
  return value;
}

function coerceString(value, field, name) {
  if (value === null || value === undefined) {
    if (field.nullable) return null;
    bad(`${name} must be a string`);
  }
  if (typeof value !== 'string') bad(`${name} must be a string`);
  if (field.trim) value = value.trim();
  if (field.max != null && value.length > field.max) {
    bad(`${name} must be at most ${field.max} characters`);
  }
  if (field.nonEmpty && value.trim().length === 0) bad(`${name} must not be empty`);
  return value;
}

function coerceEnum(value, field, name) {
  if (typeof value !== 'string' || !field.values.includes(value)) {
    bad(`${name} must be one of: ${field.values.join(', ')}`);
  }
  return value;
}

function coerceCurrency(value, name) {
  if (typeof value !== 'string' || !/^[A-Za-z]{3}$/.test(value)) {
    bad(`${name} must be a 3-letter currency code`);
  }
  return value.toUpperCase();
}

function coerceStringArray(value, field, name) {
  if (!Array.isArray(value)) bad(`${name} must be an array of strings`);
  const maxItems = field.maxItems ?? 50;
  if (value.length > maxItems) bad(`${name} must contain at most ${maxItems} items`);
  const out = [];
  for (const item of value) {
    if (typeof item !== 'string') bad(`${name} must contain only strings`);
    const t = item.trim();
    if (t.length === 0) bad(`${name} must not contain empty strings`);
    if (field.itemMax != null && t.length > field.itemMax) {
      bad(`${name} items must be at most ${field.itemMax} characters`);
    }
    out.push(t);
  }
  return out;
}

function coerceIntArray(value, field, name) {
  if (!Array.isArray(value)) bad(`${name} must be an array of integers`);
  const maxItems = field.maxItems ?? 50;
  if (value.length > maxItems) bad(`${name} must contain at most ${maxItems} items`);
  const out = [];
  for (const item of value) {
    if (typeof item !== 'number' || !Number.isInteger(item)) {
      bad(`${name} must contain only integers`);
    }
    if (field.min != null && item < field.min) bad(`${name} values must be >= ${field.min}`);
    if (field.max != null && item > field.max) bad(`${name} values must be <= ${field.max}`);
    out.push(item);
  }
  return out;
}

function coerceJsonArray(value, field, name) {
  if (!Array.isArray(value)) bad(`${name} must be an array`);
  const maxItems = field.maxItems ?? 5000;
  if (value.length > maxItems) bad(`${name} must contain at most ${maxItems} items`);
  for (const item of value) {
    if (!isPlainObject(item)) bad(`${name} items must be objects`);
  }
  try {
    JSON.stringify(value);
  } catch {
    bad(`${name} must be JSON-serializable`);
  }
  return value;
}

function coerceField(field, value, name) {
  switch (field.type) {
    case 'id':
    case 'idNullable':
      return coerceId(value, field, name);
    case 'string':
      return coerceString(value, field, name);
    case 'enum':
      return coerceEnum(value, field, name);
    case 'currency':
      return coerceCurrency(value, name);
    case 'money':
      return coerceMinor(value, name);
    case 'int64':
    case 'int':
      return coerceInt(value, field, name);
    case 'bool':
      if (typeof value !== 'boolean') bad(`${name} must be a boolean`);
      return value;
    case 'date':
    case 'dateNullable':
      return coerceDate(value, field, name);
    case 'stringArray':
      return coerceStringArray(value, field, name);
    case 'intArray':
      return coerceIntArray(value, field, name);
    case 'json':
      return coerceJsonArray(value, field, name);
    default:
      bad(`${name} has an unsupported type`);
      return null;
  }
}

// ---------------------------------------------------------------------------
// Resource specs
// ---------------------------------------------------------------------------

function kindFromType(type) {
  switch (type) {
    case 'money':
    case 'int64':
      return 'bigint';
    case 'int':
      return 'int';
    case 'bool':
      return 'boolean';
    case 'date':
    case 'dateNullable':
      return 'date';
    case 'stringArray':
      return 'textarray';
    case 'intArray':
      return 'intarray';
    case 'json':
      return 'jsonb';
    default:
      return 'text';
  }
}

function makeSpec(config) {
  const columns = [];
  const fieldByApi = new Map();
  for (const [api, field] of Object.entries(config.fields)) {
    if (field.virtual || !field.col) continue;
    const kind = field.kind || kindFromType(field.type);
    let fallback = null;
    if (kind === 'jsonb') fallback = Array.isArray(field.default) ? '[]' : '{}';
    columns.push({ col: field.col, kind, fallback });
    fieldByApi.set(api, { ...field, api });
  }
  return {
    table: config.table,
    fields: config.fields,
    columns,
    fieldByApi,
    sorts: config.sorts || [],
    defaultSort: config.defaultSort || 'created_at',
    defaultOrder: config.defaultOrder || 'desc',
    check: config.check || null,
  };
}

export const SPECS = {
  transactions: makeSpec({
    table: 'transactions',
    defaultSort: 'date',
    defaultOrder: 'desc',
    sorts: ['date', 'created_at', 'updated_at', 'amount_minor', 'type', 'status', 'payee', 'description'],
    fields: {
      id: { col: 'id', type: 'id', required: true },
      type: { col: 'type', type: 'enum', values: TRANSACTION_TYPES, required: true },
      amountMinor: { col: 'amount_minor', type: 'money', required: true, majorFallback: 'amount' },
      currency: { col: 'currency', type: 'currency', default: 'BDT' },
      categoryId: { col: 'category_id', type: 'idNullable', default: null },
      accountId: { col: 'account_id', type: 'id', required: true },
      toAccountId: { col: 'to_account_id', type: 'idNullable', default: null },
      date: { col: 'date', type: 'date', required: true },
      description: { col: 'description', type: 'string', max: 200, default: '' },
      payee: { col: 'payee', type: 'string', max: 120, default: '' },
      paymentMethod: { col: 'payment_method', type: 'string', max: 40, default: 'cash' },
      tags: { col: 'tags', type: 'stringArray', maxItems: 20, itemMax: 40, default: [] },
      notes: { col: 'notes', type: 'string', max: 2000, default: '' },
      status: { col: 'status', type: 'enum', values: TRANSACTION_STATUS, default: 'posted' },
      recurringRuleId: { col: 'recurring_rule_id', type: 'idNullable', default: null },
      occurrenceKey: { col: 'occurrence_key', type: 'string', max: 120, nullable: true, default: null },
      receiptRef: { col: 'receipt_ref', type: 'string', max: 200, nullable: true, default: null },
    },
    check(row) {
      if (row.type === 'transfer') {
        if (row.to_account_id == null) bad('A transfer requires toAccountId');
        if (row.to_account_id === row.account_id) {
          bad('A transfer requires distinct source and destination accounts');
        }
      }
    },
  }),

  categories: makeSpec({
    table: 'categories',
    defaultSort: 'created_at',
    sorts: ['created_at', 'updated_at', 'name', 'type'],
    fields: {
      id: { col: 'id', type: 'id', required: true },
      name: { col: 'name', type: 'string', max: 120, nonEmpty: true, required: true },
      type: { col: 'type', type: 'enum', values: ENTRY_TYPES, required: true },
      parentId: { col: 'parent_id', type: 'idNullable', default: null },
      icon: { col: 'icon', type: 'string', max: 40, default: 'tag' },
      color: { col: 'color', type: 'string', max: 16, default: '#64748b' },
      archived: { col: 'archived', type: 'bool', default: false },
      isDefault: { col: 'is_default', type: 'bool', default: false },
    },
  }),

  accounts: makeSpec({
    table: 'accounts',
    defaultSort: 'created_at',
    sorts: ['created_at', 'updated_at', 'name', 'type'],
    fields: {
      id: { col: 'id', type: 'id', required: true },
      name: { col: 'name', type: 'string', max: 120, nonEmpty: true, required: true },
      type: { col: 'type', type: 'string', max: 40, nonEmpty: true, required: true },
      currency: { col: 'currency', type: 'currency', default: 'BDT' },
      openingBalanceMinor: { col: 'opening_balance_minor', type: 'int64', min: -MAX_MINOR, max: MAX_MINOR, default: 0 },
      openingBalanceDate: { col: 'opening_balance_date', type: 'dateNullable', default: null },
      color: { col: 'color', type: 'string', max: 16, default: '#6366f1' },
      icon: { col: 'icon', type: 'string', max: 40, default: 'wallet' },
      archived: { col: 'archived', type: 'bool', default: false },
    },
  }),

  budgets: makeSpec({
    table: 'budgets',
    defaultSort: 'created_at',
    sorts: ['created_at', 'updated_at', 'name', 'start_date', 'end_date', 'limit_minor'],
    fields: {
      id: { col: 'id', type: 'id', required: true },
      name: { col: 'name', type: 'string', max: 120, nonEmpty: true, required: true },
      period: { col: 'period', type: 'enum', values: BUDGET_PERIODS, required: true },
      limitMinor: { col: 'limit_minor', type: 'money', required: true },
      currency: { col: 'currency', type: 'currency', default: 'BDT' },
      scope: { col: 'scope', type: 'enum', values: BUDGET_SCOPES, required: true },
      categoryId: { col: 'category_id', type: 'idNullable', default: null },
      startDate: { col: 'start_date', type: 'date', required: true },
      endDate: { col: 'end_date', type: 'date', required: true },
      alertThresholds: { col: 'alert_thresholds', type: 'intArray', maxItems: 10, min: 1, max: 1000, default: [75, 90, 100] },
      status: { col: 'status', type: 'string', max: 20, default: 'active' },
      archived: { col: 'archived', type: 'bool', default: false },
    },
    check(row) {
      if (row.end_date < row.start_date) bad('endDate must be on or after startDate');
    },
  }),

  'recurring-rules': makeSpec({
    table: 'recurring_rules',
    defaultSort: 'next_due_date',
    defaultOrder: 'asc',
    sorts: ['created_at', 'updated_at', 'next_due_date', 'start_date', 'name', 'amount_minor'],
    fields: {
      id: { col: 'id', type: 'id', required: true },
      name: { col: 'name', type: 'string', max: 120, nonEmpty: true, required: true },
      type: { col: 'type', type: 'enum', values: TRANSACTION_TYPES, required: true },
      amountMinor: { col: 'amount_minor', type: 'money', required: true, majorFallback: 'amount' },
      currency: { col: 'currency', type: 'currency', default: 'BDT' },
      categoryId: { col: 'category_id', type: 'idNullable', default: null },
      accountId: { col: 'account_id', type: 'id', required: true },
      toAccountId: { col: 'to_account_id', type: 'idNullable', default: null },
      frequency: { col: 'frequency', type: 'enum', values: FREQUENCIES, required: true },
      intervalCount: { col: 'interval_count', type: 'int', min: 1, max: 1000, default: 1 },
      startDate: { col: 'start_date', type: 'date', required: true },
      nextDueDate: { col: 'next_due_date', type: 'date', required: true },
      endDate: { col: 'end_date', type: 'dateNullable', default: null },
      notes: { col: 'notes', type: 'string', max: 2000, default: '' },
      status: { col: 'status', type: 'enum', values: RECURRING_STATUS, default: 'active' },
      lastGeneratedDate: { col: 'last_generated_date', type: 'dateNullable', default: null },
    },
    check(row) {
      if (row.type === 'transfer') {
        if (row.to_account_id == null) bad('A transfer requires toAccountId');
        if (row.to_account_id === row.account_id) {
          bad('A transfer requires distinct source and destination accounts');
        }
      }
      if (row.end_date && row.start_date && row.end_date < row.start_date) {
        bad('endDate must be on or after startDate');
      }
    },
  }),

  goals: makeSpec({
    table: 'goals',
    defaultSort: 'created_at',
    sorts: ['created_at', 'updated_at', 'name', 'target_date', 'target_minor'],
    fields: {
      id: { col: 'id', type: 'id', required: true },
      name: { col: 'name', type: 'string', max: 120, nonEmpty: true, required: true },
      targetMinor: { col: 'target_minor', type: 'money', required: true },
      savedMinor: { col: 'saved_minor', type: 'int64', min: 0, max: MAX_MINOR, default: 0 },
      currency: { col: 'currency', type: 'currency', default: 'BDT' },
      targetDate: { col: 'target_date', type: 'dateNullable', default: null },
      accountId: { col: 'account_id', type: 'idNullable', default: null },
      icon: { col: 'icon', type: 'string', max: 40, default: 'target' },
      color: { col: 'color', type: 'string', max: 16, default: '#14b8a6' },
      status: { col: 'status', type: 'enum', values: GOAL_STATUS, default: 'active' },
      contributions: { col: 'contributions', type: 'json', maxItems: 5000, default: [] },
      archived: { col: 'archived', type: 'bool', default: false },
    },
  }),
};

export const RESOURCE_KEYS = Object.keys(SPECS);

/** State key (camelCase 'recurringRules') -> API resource key ('recurring-rules'). */
export const STATE_KEY_TO_RESOURCE = {
  transactions: 'transactions',
  categories: 'categories',
  accounts: 'accounts',
  budgets: 'budgets',
  recurringRules: 'recurring-rules',
  goals: 'goals',
};

export const STATE_RESOURCE_KEYS = Object.keys(STATE_KEY_TO_RESOURCE);

export function isResource(name) {
  return Object.prototype.hasOwnProperty.call(SPECS, name);
}

export function getSpec(resource) {
  if (!isResource(resource)) throw new HttpError(404, 'not_found', 'Unknown resource');
  return SPECS[resource];
}

// ---------------------------------------------------------------------------
// Record validation
// ---------------------------------------------------------------------------

function cloneDefault(value) {
  if (Array.isArray(value)) return value.map((v) => (isPlainObject(v) ? { ...v } : v));
  if (isPlainObject(value)) return { ...value };
  return value;
}

/**
 * Validate/whitelist one record.
 * @param {string} resource API resource key
 * @param {unknown} input
 * @param {{mode?: 'full'|'patch'}} [opts]
 * @returns {Record<string, unknown>} snake_case DB row (columns only)
 */
export function validateRecord(resource, input, opts = {}) {
  const spec = getSpec(resource);
  const mode = opts.mode === 'patch' ? 'patch' : 'full';
  if (!isPlainObject(input)) bad('Request body must be a JSON object');

  const row = {};

  for (const [apiName, field] of Object.entries(spec.fields)) {
    if (field.virtual) continue;

    if (mode === 'patch') {
      if (apiName === 'id') continue; // primary key is immutable
    }

    const provided = hasOwn(input, apiName) && input[apiName] !== undefined;
    if (provided) {
      row[field.col] = coerceField(field, input[apiName], apiName);
      continue;
    }

    // Full mode: allow `amount` (major units) only as a fallback for amountMinor.
    if (mode === 'full' && field.majorFallback && hasOwn(input, field.majorFallback) && input[field.majorFallback] !== undefined) {
      row[field.col] = coerceMajor(input[field.majorFallback], apiName);
      continue;
    }

    if (mode === 'patch') continue;

    if (field.required) bad(`${apiName} is required`);
    if (field.default !== undefined) row[field.col] = cloneDefault(field.default);
    else row[field.col] = null;
  }

  if (mode === 'full' && typeof spec.check === 'function') spec.check(row);
  return row;
}

/**
 * Validate a list of records for one resource.
 */
export function validateRecords(resource, list) {
  if (!Array.isArray(list)) bad(`${resource} must be an array`);
  if (list.length > MAX_ROWS_PER_RESOURCE) bad(`${resource} has too many records`);
  const out = [];
  for (let i = 0; i < list.length; i += 1) {
    try {
      out.push(validateRecord(resource, list[i], { mode: 'full' }));
    } catch (e) {
      if (e instanceof HttpError) {
        throw new HttpError(400, 'validation_error', `${resource}[${i}]: ${e.message}`);
      }
      throw e;
    }
  }
  return out;
}

/**
 * Validate the whole /api/state payload. Returns normalized rows keyed by API
 * resource key plus `preferences` and `schemaVersion`.
 */
export function validateState(state) {
  if (!isPlainObject(state)) bad('state must be an object');
  const result = { rows: {}, counts: {} };
  for (const [stateKey, resource] of Object.entries(STATE_KEY_TO_RESOURCE)) {
    const list = state[stateKey] === undefined || state[stateKey] === null ? [] : state[stateKey];
    const rows = validateRecords(resource, list);
    result.rows[resource] = rows;
    result.counts[stateKey] = rows.length;
  }
  result.preferences = state.preferences === undefined || state.preferences === null
    ? {}
    : validatePreferences(state.preferences);

  let schemaVersion = 1;
  if (state.schemaVersion !== undefined && state.schemaVersion !== null) {
    if (!Number.isInteger(state.schemaVersion) || state.schemaVersion < 1 || state.schemaVersion > 1000) {
      bad('schemaVersion must be a positive integer');
    }
    schemaVersion = state.schemaVersion;
  }
  result.schemaVersion = schemaVersion;
  return result;
}

export function validatePreferences(data) {
  if (!isPlainObject(data)) bad('Preferences must be a JSON object');
  let serialized;
  try {
    serialized = JSON.stringify(data);
  } catch {
    bad('Preferences must be JSON-serializable');
  }
  if (serialized.length > 200000) bad('Preferences are too large');
  return data;
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

/**
 * Resolve and validate ?sort=&order= against a per-resource allow-list.
 * Identifiers returned here are used in SQL, so they MUST come from the spec.
 */
export function resolveSort(resource, sortParam, orderParam) {
  const spec = getSpec(resource);
  const allowed = new Set(spec.sorts);

  let col = spec.defaultSort;
  let dir = spec.defaultOrder === 'asc' ? 'ASC' : 'DESC';

  if (sortParam != null && sortParam !== '') {
    let mapped = null;
    const byApi = spec.fieldByApi.get(sortParam);
    if (byApi && allowed.has(byApi.col)) mapped = byApi.col;
    else if (allowed.has(sortParam)) mapped = sortParam;
    if (!mapped) throw new HttpError(400, 'invalid_sort', `Unsupported sort field: ${sortParam}`);
    col = mapped;
  }

  if (orderParam != null && orderParam !== '') {
    const o = String(orderParam).toLowerCase();
    if (o !== 'asc' && o !== 'desc') throw new HttpError(400, 'invalid_sort', 'order must be asc or desc');
    dir = o === 'asc' ? 'ASC' : 'DESC';
  }

  return { col, dir };
}

// ---------------------------------------------------------------------------
// Row <-> API mapping
// ---------------------------------------------------------------------------

function convertOut(field, value) {
  switch (field.type) {
    case 'money':
    case 'int64':
    case 'int': {
      if (value === null || value === undefined) return 0;
      const n = typeof value === 'number' ? value : Number(value);
      return Number.isFinite(n) ? n : 0;
    }
    case 'bool':
      return value === true || value === 't' || value === 'true' || value === 1;
    case 'date':
    case 'dateNullable': {
      if (value === null || value === undefined) return null;
      const s = value instanceof Date ? value.toISOString().slice(0, 10) : String(value);
      return s.length >= 10 ? s.slice(0, 10) : s;
    }
    case 'stringArray':
      return toArray(value).map((v) => String(v));
    case 'intArray':
      return toArray(value).map((v) => Number(v));
    case 'json':
      return jsonValue(value, []);
    default:
      return value === undefined ? null : value;
  }
}

function toArray(value) {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined) return [];
  if (typeof value === 'string') {
    const s = value.trim();
    if (s.startsWith('{') && s.endsWith('}')) {
      const inner = s.slice(1, -1);
      if (inner.trim() === '') return [];
      return inner.split(',').map((x) => x.replace(/^"|"$/g, ''));
    }
    return [value];
  }
  return [];
}

function jsonValue(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  }
  return value;
}

function toIso(v) {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString();
}

/** Map a DB row (snake_case) to the public API record (camelCase). */
export function rowToApi(resource, row) {
  const spec = getSpec(resource);
  const out = {};
  for (const [apiName, field] of Object.entries(spec.fields)) {
    if (field.virtual || !field.col) continue;
    out[apiName] = convertOut(field, row[field.col]);
  }
  out.createdAt = toIso(row.created_at);
  out.updatedAt = toIso(row.updated_at);
  return out;
}

// ---------------------------------------------------------------------------
// Bulk SQL builders
// ---------------------------------------------------------------------------

function selectExpr(kind, col, fallback) {
  const text = `val->>'${col}'`;
  switch (kind) {
    case 'uuid':
      return `(${text})::uuid`;
    case 'bigint':
      return `(${text})::bigint`;
    case 'int':
      return `(${text})::int`;
    case 'boolean':
      return `COALESCE((${text})::boolean, false)`;
    case 'date':
      return `(${text})::date`;
    case 'timestamptz':
      return `(${text})::timestamptz`;
    case 'jsonb': {
      const jsonDefault = fallback === '[]' ? '[]' : '{}';
      return `COALESCE(val->'${col}', '${jsonDefault}'::jsonb)`;
    }
    case 'textarray':
      return `ARRAY(SELECT jsonb_array_elements_text(COALESCE(val->'${col}', '[]'::jsonb)))`;
    case 'intarray':
      return `ARRAY(SELECT (jsonb_array_elements_text(COALESCE(val->'${col}', '[]'::jsonb)))::int)`;
    default:
      return text;
  }
}

/**
 * Build a parameterized, single-statement bulk INSERT for a resource using
 * jsonb_array_elements. All values travel inside the JSON parameter; column
 * names come only from the hard-coded spec. `user_id` (author) and, when a
 * tenant context is supplied, `tenant_id` are injected SERVER-SIDE and can
 * never be spoofed by the client (unknown fields are dropped by the spec).
 *
 * @param {string} resource
 * @param {object[]} rows
 * @param {string} userId   authenticated author
 * @param {string} [tenantId] resolved tenant; omitted by legacy unit tests
 * @returns {{ text: string, params: unknown[] }}
 */
export function buildInsert(resource, rows, userId, tenantId = null) {
  const spec = getSpec(resource);
  const cols = [{ col: 'user_id', kind: 'uuid' }];
  if (tenantId) cols.push({ col: 'tenant_id', kind: 'uuid' });
  cols.push(...spec.columns);
  const colList = cols.map((c) => c.col).join(', ');
  const selectList = cols.map((c) => selectExpr(c.kind, c.col, c.fallback)).join(', ');
  const text =
    `INSERT INTO ${spec.table} (${colList}) ` +
    `SELECT ${selectList} FROM jsonb_array_elements($1::jsonb) AS t(val) ` +
    `RETURNING *`;
  const payload = rows.map((r) => (tenantId ? { ...r, user_id: userId, tenant_id: tenantId } : { ...r, user_id: userId }));
  return { text, params: [JSON.stringify(payload)] };
}

/**
 * Build a single-row UPSERT that can only ever touch rows the caller is allowed
 * to write. The conflict target is the primary key `id`; the DO UPDATE guard is
 * scoped to the resolved tenant when one is supplied (so any active member of a
 * shared workspace may update a tenant-owned record), and falls back to the
 * author (`user_id`) for legacy callers.
 *
 * @param {string} resource
 * @param {object} row
 * @param {string} userId
 * @param {string} [tenantId]
 * @returns {{ text: string, params: unknown[] }}
 */
export function buildUpsert(resource, row, userId, tenantId = null) {
  const spec = getSpec(resource);
  const cols = [{ col: 'user_id', kind: 'uuid' }];
  if (tenantId) cols.push({ col: 'tenant_id', kind: 'uuid' });
  cols.push(...spec.columns);
  const colList = cols.map((c) => c.col).join(', ');
  const selectList = cols.map((c) => selectExpr(c.kind, c.col, c.fallback)).join(', ');
  const updatable = cols.filter((c) => c.col !== 'id' && c.col !== 'user_id' && c.col !== 'tenant_id' && c.col !== 'created_at');
  const sets = updatable.map((c) => `${c.col} = EXCLUDED.${c.col}`).join(', ');
  const guard = tenantId
    ? `${spec.table}.tenant_id = EXCLUDED.tenant_id`
    : `${spec.table}.user_id = EXCLUDED.user_id`;
  const text =
    `INSERT INTO ${spec.table} (${colList}) ` +
    `SELECT ${selectList} FROM jsonb_array_elements($1::jsonb) AS t(val) ` +
    `ON CONFLICT (id) DO UPDATE SET ${sets}, updated_at = now() ` +
    `WHERE ${guard} ` +
    `RETURNING *`;
  const payload = [tenantId ? { ...row, user_id: userId, tenant_id: tenantId } : { ...row, user_id: userId }];
  return { text, params: [JSON.stringify(payload)] };
}

/**
 * Build a parameterized UPDATE for PATCH. `row` is a validated snake_case row.
 * Only spec columns may appear as identifiers. Ownership is guarded by the
 * resolved tenant when supplied, otherwise by the author `user_id`.
 *
 * @returns {{ text: string, params: unknown[] } | null} null when row is empty
 */
export function buildUpdate(resource, row, id, userId, tenantId = null) {
  const spec = getSpec(resource);
  const byCol = new Map(spec.columns.map((c) => [c.col, c.kind]));
  const entries = Object.entries(row).filter(([col]) => byCol.has(col) && col !== 'id');
  if (entries.length === 0) return null;

  const params = [];
  const sets = entries.map(([col, value]) => {
    const kind = byCol.get(col);
    if (kind === 'textarray') {
      params.push(JSON.stringify(value == null ? [] : value));
      return `${col} = ARRAY(SELECT jsonb_array_elements_text($${params.length}::jsonb))`;
    }
    if (kind === 'intarray') {
      params.push(JSON.stringify(value == null ? [] : value));
      return `${col} = ARRAY(SELECT (jsonb_array_elements_text($${params.length}::jsonb))::int)`;
    }
    if (kind === 'jsonb') {
      params.push(JSON.stringify(value == null ? [] : value));
      return `${col} = $${params.length}::jsonb`;
    }
    params.push(value);
    return `${col} = $${params.length}`;
  });

  params.push(id);
  const idIdx = params.length;

  let ownership;
  if (tenantId) {
    params.push(tenantId);
    ownership = `tenant_id = $${params.length}`;
  } else {
    params.push(userId);
    ownership = `user_id = $${params.length}`;
  }

  const text =
    `UPDATE ${spec.table} SET ${sets.join(', ')}, updated_at = now() ` +
    `WHERE id = $${idIdx} AND ${ownership} RETURNING *`;
  return { text, params };
}
