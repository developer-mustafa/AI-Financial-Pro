/**
 * CSV import + JSON backup restoration.
 *
 * The import is deliberately two-phase:
 *   1. `buildTransactionImport()` parses, validates and *previews* everything
 *      without touching application state.
 *   2. `applyTransactionImport()` commits only the rows the user approved.
 * Cancelling at any point leaves the dataset untouched.
 */

import { appConfig } from '../config/appConfig.js';
import { nowISO, isValidISODate } from '../utils/date.js';
import { normalizeCurrency, parseAmountToMinor } from '../utils/currency.js';
import { sanitizeLine, sanitizeText, safeJsonParse } from '../utils/sanitize.js';
import { ids } from '../utils/ids.js';
import { migrate } from './storageService.js';
import { validateTransaction, parseTagsCell, parseBooleanish } from '../utils/validation.js';
import { transactionFingerprint } from '../utils/calculations.js';

/* --------------------------------------------------------------------------- *
 * CSV parsing (RFC 4180)
 * --------------------------------------------------------------------------- */

/**
 * Robust CSV parser: handles quoted fields, escaped quotes ("") and CRLF/LF.
 * @returns {string[][]}
 */
export function parseCsv(text) {
  const input = String(text ?? '').replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',' || ch === ';' || ch === '\t') {
      row.push(field);
      field = '';
      // Semicolon/tab delimited files are treated the same way.
    } else if (ch === '\n') {
      row.push(field);
      field = '';
      if (row.some((cell) => cell.trim() !== '')) rows.push(row);
      row = [];
    } else if (ch === '\r') {
      // handled by the \n branch
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    if (row.some((cell) => cell.trim() !== '')) rows.push(row);
  }
  return rows;
}

/** Normalises a header cell for alias matching. */
const normalizeHeader = (value) =>
  String(value ?? '')
    .toLowerCase()
    .replace(/^\uFEFF/, '')
    .replace(/[^a-z0-9]+/g, '')
    .trim();

export const TRANSACTION_FIELD_ALIASES = {
  date: ['date', 'transactiondate', 'txndate', 'valuedate', 'posteddate', 'datetime', 'when'],
  type: ['type', 'transactiontype', 'kind', 'direction'],
  amount: ['amount', 'value', 'total', 'sum', 'amountvalue'],
  amountMinor: ['amountminor', 'minoramount'],
  credit: ['credit', 'deposit', 'moneyin', 'inflow', 'cr'],
  debit: ['debit', 'withdrawal', 'moneyout', 'outflow', 'dr'],
  category: ['category', 'categoryname', 'type2', 'expensecategory'],
  categoryId: ['categoryid'],
  account: ['account', 'accountname', 'wallet', 'fromaccount', 'sourceaccount'],
  accountId: ['accountid'],
  toAccount: ['toaccount', 'destinationaccount', 'to', 'destination', 'transferto', 'toaccountname'],
  toAccountId: ['toaccountid'],
  description: ['description', 'title', 'memo', 'particulars', 'narration', 'details', 'name'],
  payee: ['payee', 'payer', 'vendor', 'merchant', 'counterparty', 'party'],
  paymentMethod: ['paymentmethod', 'method', 'paymenttype', 'instrument'],
  tags: ['tags', 'tag', 'labels', 'label'],
  notes: ['notes', 'note', 'comment', 'comments', 'remarks'],
  currency: ['currency', 'currencycode', 'ccy'],
  status: ['status', 'state'],
  id: ['id', 'transactionid', 'uuid', 'ref', 'reference']
};

/** Builds header -> field mapping; every field is optional except date/amount. */
export function mapHeaders(headers) {
  const lookup = new Map();
  headers.forEach((header, index) => lookup.set(normalizeHeader(header), index));

  const mapping = {};
  for (const [field, aliases] of Object.entries(TRANSACTION_FIELD_ALIASES)) {
    for (const alias of aliases) {
      const index = lookup.get(alias);
      if (index !== undefined) {
        if (mapping[field] === undefined) mapping[field] = index;
        break;
      }
    }
  }
  return mapping;
}

/**
 * Flexible date parsing. Accepts `YYYY-MM-DD`, `DD/MM/YYYY`, `MM/DD/YYYY`,
 * `DD-MM-YYYY`, `DD.MM.YYYY` and full ISO timestamps. Ambiguous values use
 * `dateOrder` ('DMY' default — the common convention in the app's default
 * locale, and configurable from the import dialog).
 */
export function parseFlexibleDate(raw, { dateOrder = 'DMY' } = {}) {
  const value = String(raw ?? '').trim();
  if (!value) return null;
  if (isValidISODate(value.slice(0, 10)) && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);

  const match = /^(\d{1,4})[./-](\d{1,2})[./-](\d{1,4})$/.exec(value);
  if (!match) return null;
  let [, a, b, c] = match;
  const n1 = Number(a);
  const n2 = Number(b);
  const n3 = Number(c);

  let year;
  let month;
  let day;
  if (a.length === 4) {
    year = n1; month = n2; day = n3;
  } else if (c.length === 4) {
    year = n3;
    const order = dateOrder === 'auto' ? (n1 > 12 ? 'DMY' : n2 > 12 ? 'MDY' : 'DMY') : dateOrder;
    if (order === 'MDY') { month = n1; day = n2; } else { day = n1; month = n2; }
  } else {
    // Two-digit year: 20xx for 0–68, 19xx above.
    year = n3 <= 68 ? 2000 + n3 : 1900 + n3;
    const order = dateOrder === 'auto' ? (n1 > 12 ? 'DMY' : n2 > 12 ? 'MDY' : 'DMY') : dateOrder;
    if (order === 'MDY') { month = n1; day = n2; } else { day = n1; month = n2; }
  }
  const iso = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return isValidISODate(iso) ? iso : null;
}

/* --------------------------------------------------------------------------- *
 * Import planning
 * --------------------------------------------------------------------------- */

/**
 * @param {string} text raw CSV
 * @param {object} options { mode: 'csv'|'json', dateOrder, currency, createMissingCategories, createMissingAccounts, fallbackAccountId, includeDuplicates }
 * @returns {object} plan
 */
export function buildTransactionImport(text, options = {}) {
  const mode = options.mode || 'csv';
  if (mode === 'json') return buildJsonImport(text, options);

  const bytes = text.length;
  if (bytes > appConfig.limits.maxImportBytes) {
    return { ok: false, fatal: `The file is larger than the ${Math.round(appConfig.limits.maxImportBytes / 1024 / 1024)} MB import limit.` };
  }

  const rows = parseCsv(text);
  if (rows.length === 0) return { ok: false, fatal: 'The file is empty.' };
  if (rows.length > appConfig.limits.maxImportRows + 1) {
    return { ok: false, fatal: `The file has more than ${appConfig.limits.maxImportRows} rows.` };
  }

  const [headerRow, ...dataRows] = rows;
  const mapping = mapHeaders(headerRow);
  if (mapping.date === undefined) return { ok: false, fatal: 'No date column was found. Expected a column named "date".' };
  if (mapping.amount === undefined && mapping.credit === undefined && mapping.debit === undefined && mapping.amountMinor === undefined) {
    return { ok: false, fatal: 'No amount column was found. Expected a column named "amount".' };
  }
  return planRows(headerRow, dataRows, mapping, options);
}

function buildJsonImport(text, options = {}) {
  const parsed = safeJsonParse(text, { maxBytes: appConfig.limits.maxBackupBytes });
  if (!parsed.ok) return { ok: false, fatal: parsed.error };
  const payload = parsed.value;
  const list = Array.isArray(payload) ? payload : Array.isArray(payload?.transactions) ? payload.transactions : null;
  if (!list) return { ok: false, fatal: 'No "transactions" array was found in the JSON file.' };
  if (list.length > appConfig.limits.maxImportRows) return { ok: false, fatal: `The file has more than ${appConfig.limits.maxImportRows} transactions.` };

  const headers = ['date', 'type', 'amount', 'amountMinor', 'currency', 'category', 'account', 'toAccount', 'description', 'payee', 'paymentMethod', 'status', 'tags', 'notes'];
  const dataRows = list.map((tx) => [
    tx?.date ?? '',
    tx?.type ?? '',
    tx?.amountMinor !== undefined ? String(tx.amountMinor) : '',
    tx?.amountMinor !== undefined ? String(tx.amountMinor) : '',
    tx?.currency ?? '',
    tx?.categoryId ?? tx?.category ?? '',
    tx?.accountId ?? tx?.account ?? '',
    tx?.toAccountId ?? '',
    tx?.description ?? '',
    tx?.payee ?? '',
    tx?.paymentMethod ?? '',
    tx?.status ?? '',
    Array.isArray(tx?.tags) ? tx.tags.join(';') : '',
    tx?.notes ?? ''
  ]);
  return planRows(headers, dataRows, mapHeaders(headers), options);
}

function planRows(headers, dataRows, mapping, options) {
  const {
    categories = [],
    accounts = [],
    existingTransactions = [],
    currency = 'BDT',
    dateOrder = 'DMY',
    createMissingCategories = false,
    createMissingAccounts = false,
    fallbackAccountId = null,
    includeDuplicates = false
  } = options;

  const cell = (row, field) => (mapping[field] === undefined ? '' : String(row[mapping[field]] ?? '').trim());

  const categoryByName = new Map();
  for (const category of categories) {
    categoryByName.set(`${category.type}::${category.name.trim().toLowerCase()}`, category);
  }
  const accountByName = new Map(accounts.map((account) => [account.name.trim().toLowerCase(), account]));
  const accountById = new Map(accounts.map((account) => [account.id, account]));
  const categoryById = new Map(categories.map((category) => [category.id, category]));

  const plannedCategories = new Map(); // key -> pending category
  const plannedAccounts = new Map(); // name -> pending account
  const baseCurrency = normalizeCurrency(currency);

  const entries = [];
  dataRows.forEach((row, index) => {
    const rowNumber = index + 2; // account for the header row and 1-based numbering
    const errors = {};
    const raw = {};
    headers.forEach((header, columnIndex) => {
      raw[header || `column_${columnIndex + 1}`] = row[columnIndex] ?? '';
    });

    /* ---- amount ---------------------------------------------------------- */
    let amountMinor = NaN;
    let sign = 0;
    const explicitMinor = cell(row, 'amountMinor');
    const amountCell = cell(row, 'amount');
    const creditCell = cell(row, 'credit');
    const debitCell = cell(row, 'debit');

    if (explicitMinor && /^-?\d+$/.test(explicitMinor)) {
      amountMinor = Math.abs(Number(explicitMinor));
      sign = Number(explicitMinor) < 0 ? -1 : 1;
    } else if (amountCell) {
      const parsed = parseAmountToMinor(amountCell, baseCurrency);
      if (Number.isFinite(parsed)) {
        amountMinor = Math.abs(parsed);
        sign = parsed < 0 ? -1 : 1;
      }
    } else if (creditCell || debitCell) {
      const credit = creditCell ? parseAmountToMinor(creditCell, baseCurrency) : NaN;
      const debit = debitCell ? parseAmountToMinor(debitCell, baseCurrency) : NaN;
      if (Number.isFinite(credit) && credit !== 0) {
        amountMinor = Math.abs(credit);
        sign = 1;
      } else if (Number.isFinite(debit) && debit !== 0) {
        amountMinor = Math.abs(debit);
        sign = -1;
      }
    }
    if (!Number.isFinite(amountMinor) || amountMinor <= 0) errors.amount = 'Amount is missing or not a valid positive number.';

    /* ---- type ------------------------------------------------------------ */
    const typeCell = cell(row, 'type').toLowerCase();
    let type;
    if (['income', 'credit', 'in', 'deposit', 'revenue'].includes(typeCell)) type = 'income';
    else if (['expense', 'debit', 'out', 'spend', 'spent', 'payment'].includes(typeCell)) type = 'expense';
    else if (['transfer', 'move', 'internal'].includes(typeCell)) type = 'transfer';
    else if (typeCell === '') type = sign < 0 ? 'expense' : 'income';
    else {
      type = 'expense';
      errors.type = `Unrecognised type "${typeCell}".`;
    }

    /* ---- date ------------------------------------------------------------ */
    const date = parseFlexibleDate(cell(row, 'date'), { dateOrder });
    if (!date) errors.date = 'Date is missing or has an unsupported format.';

    /* ---- currency -------------------------------------------------------- */
    const currencyCell = cell(row, 'currency');
    const rowCurrency = currencyCell ? normalizeCurrency(currencyCell, '') : baseCurrency;
    if (currencyCell && !rowCurrency) errors.currency = `Unsupported currency "${currencyCell}".`;

    /* ---- account -------------------------------------------------------- */
    const accountIdCell = cell(row, 'accountId');
    const accountNameCell = cell(row, 'account');
    let accountId = null;
    if (accountIdCell && accountById.has(accountIdCell)) {
      accountId = accountIdCell;
    } else if (accountNameCell) {
      const match = accountByName.get(accountNameCell.toLowerCase());
      if (match) accountId = match.id;
    } else if (rowCurrency && currency) {
      const sameCurrency = accounts.filter((account) => !account.archived && normalizeCurrency(account.currency) === rowCurrency);
      if (sameCurrency.length === 1) accountId = sameCurrency[0].id;
    }
    if (!accountId && fallbackAccountId && accountById.has(fallbackAccountId)) accountId = fallbackAccountId;
    if (!accountId && createMissingAccounts && accountNameCell) {
      const key = accountNameCell.toLowerCase();
      let pending = plannedAccounts.get(key);
      if (!pending) {
        pending = {
          id: ids.account(),
          name: sanitizeLine(accountNameCell, 120),
          type: 'other',
          currency: rowCurrency || baseCurrency,
          openingBalanceMinor: 0,
          openingBalanceDate: date || nowISO().slice(0, 10),
          color: '#64748b',
          icon: 'wallet',
          archived: false,
          createdAt: nowISO(),
          updatedAt: nowISO()
        };
        plannedAccounts.set(key, pending);
      }
      accountId = pending.id;
      accountById.set(pending.id, pending);
      accountByName.set(pending.name.toLowerCase(), pending);
    }
    if (!accountId) errors.accountId = accountNameCell ? `No account named "${accountNameCell}".` : 'No account could be determined for this row.';

    /* ---- category -------------------------------------------------------- */
    let categoryId = null;
    if (type !== 'transfer') {
      const categoryIdCell = cell(row, 'categoryId');
      const categoryNameCell = cell(row, 'category');
      if (categoryIdCell && categoryById.has(categoryIdCell)) categoryId = categoryIdCell;
      else if (categoryNameCell) {
        const exact = categoryByName.get(`${type}::${categoryNameCell.toLowerCase()}`);
        if (exact) categoryId = exact.id;
      }
      if (!categoryId && categoryNameCell && createMissingCategories) {
        const key = `${type}::${categoryNameCell.toLowerCase()}`;
        let pending = plannedCategories.get(key);
        if (!pending) {
          pending = {
            id: ids.category(),
            name: sanitizeLine(categoryNameCell, 120),
            type,
            parentId: null,
            icon: type === 'income' ? 'trending-up' : 'tag',
            color: type === 'income' ? '#10b981' : '#64748b',
            archived: false,
            isDefault: false,
            createdAt: nowISO(),
            updatedAt: nowISO()
          };
          plannedCategories.set(key, pending);
        }
        categoryId = pending.id;
        categoryById.set(pending.id, pending);
        categoryByName.set(pending.name.toLowerCase(), pending);
      }
      if (!categoryId) errors.categoryId = categoryNameCell ? `No ${type} category named "${categoryNameCell}".` : 'Category is missing.';
    }

    /* ---- transfer destination -------------------------------------------- */
    let toAccountId = null;
    if (type === 'transfer') {
      const toIdCell = cell(row, 'toAccountId');
      const toNameCell = cell(row, 'toAccount');
      if (toIdCell && accountById.has(toIdCell)) toAccountId = toIdCell;
      else if (toNameCell) {
        const match = accountByName.get(toNameCell.toLowerCase());
        if (match) toAccountId = match.id;
      }
      if (!toAccountId) errors.toAccountId = 'Transfers need a destination account.';
      else if (toAccountId === accountId) errors.toAccountId = 'Source and destination accounts are identical.';
    }

    /* ---- misc fields ----------------------------------------------------- */
    const tags = parseTagsCell(cell(row, 'tags'));
    const statusCell = cell(row, 'status').toLowerCase();
    const status = ['posted', 'pending', 'draft'].includes(statusCell) ? statusCell : 'posted';
    const referenceId = cell(row, 'id');

    const candidate = {
      id: referenceId && /^[A-Za-z0-9_-]{4,80}$/.test(referenceId) ? referenceId : ids.transaction(),
      type,
      amountMinor: Number.isFinite(amountMinor) ? amountMinor : null,
      currency: rowCurrency || baseCurrency,
      categoryId,
      accountId,
      toAccountId,
      date,
      description: sanitizeLine(cell(row, 'description'), 200) || (categoryNameFor(categoryId, categoryById) || 'Imported transaction'),
      payee: sanitizeLine(cell(row, 'payee'), 120),
      paymentMethod: ['cash', 'card', 'bank_transfer', 'mobile_wallet', 'cheque', 'other'].includes(cell(row, 'paymentMethod').toLowerCase())
        ? cell(row, 'paymentMethod').toLowerCase()
        : 'other',
      tags,
      notes: sanitizeText(cell(row, 'notes'), 2000),
      status,
      createdAt: nowISO(),
      updatedAt: nowISO()
    };

    // Re-run the same validator the manual form uses with the *extended*
    // category/account lists, so imported rows obey identical business rules.
    const validated = validateTransaction(candidate, {
      accounts: [...accounts, ...plannedAccounts.values()],
      categories: [...categories, ...plannedCategories.values()],
      existing: []
    });
    if (!validated.ok) {
      Object.assign(errors, validated.errors);
    }

    const duplicates = findImportDuplicates(existingTransactions, candidate);

    entries.push({
      rowNumber,
      raw,
      candidate: validated.value || candidate,
      errors,
      valid: Object.keys(errors).length === 0,
      duplicate: duplicates.length > 0,
      duplicateOf: duplicates[0] || null
    });
  });

  const valid = entries.filter((entry) => entry.valid && (includeDuplicates || !entry.duplicate));
  const duplicates = entries.filter((entry) => entry.valid && entry.duplicate);
  const invalid = entries.filter((entry) => !entry.valid);

  return {
    ok: true,
    fatal: null,
    format: 'csv',
    headers,
    mapping,
    entries,
    valid,
    invalid,
    duplicates,
    plannedCategories: [...plannedCategories.values()],
    plannedAccounts: [...plannedAccounts.values()],
    summary: {
      total: entries.length,
      valid: valid.length,
      duplicates: duplicates.length,
      invalid: invalid.length,
      newCategories: plannedCategories.size,
      newAccounts: plannedAccounts.size
    }
  };
}

function categoryNameFor(id, map) {
  return id ? map.get(id)?.name || '' : '';
}

function findImportDuplicates(existingTransactions, candidate) {
  const fingerprint = transactionFingerprint(candidate);
  return (existingTransactions || []).filter((tx) => transactionFingerprint(tx) === fingerprint).slice(0, 3);
}

/**
 * Commits an import plan to the store.
 * @returns {{added:number, categories:number, accounts:number, skipped:number}}
 */
export function applyTransactionImport(plan, { store, includeDuplicates = false, createOnlyValid = true } = {}) {
  if (!plan?.ok) return { added: 0, categories: 0, accounts: 0, skipped: 0 };

  const rows = plan.entries.filter((entry) => entry.valid && (includeDuplicates || !entry.duplicate));
  const rowsToCommit = createOnlyValid ? rows : plan.valid;

  let added = 0;
  store.apply('import-transactions', (draft) => {
    const changes = [];
    const existingIds = new Set(draft.transactions.map((tx) => tx.id));

    // Idempotency: never import the same record twice.
    const incomingKeys = new Set(
      draft.transactions.map((tx) => transactionFingerprint(tx))
    );

    const newCategories = plan.plannedCategories.filter((category) => !draft.categories.some((c) => c.id === category.id));
    if (newCategories.length) {
      draft.categories = [...draft.categories, ...newCategories];
      for (const category of newCategories) changes.push({ resource: 'categories', op: 'upsert', record: category });
    }

    const newAccounts = plan.plannedAccounts.filter((account) => !draft.accounts.some((a) => a.id === account.id));
    if (newAccounts.length) {
      draft.accounts = [...draft.accounts, ...newAccounts];
      for (const account of newAccounts) changes.push({ resource: 'accounts', op: 'upsert', record: account });
    }

    const additions = [];
    for (const entry of rowsToCommit) {
      const record = { ...entry.candidate };
      if (existingIds.has(record.id)) record.id = ids.transaction();
      const key = transactionFingerprint(record);
      if (incomingKeys.has(key) && !includeDuplicates) continue;
      incomingKeys.add(key);
      existingIds.add(record.id);
      additions.push(record);
    }

    if (additions.length) {
      draft.transactions = [...draft.transactions, ...additions];
      for (const record of additions) changes.push({ resource: 'transactions', op: 'upsert', record });
    }
    added = additions.length;
    return changes;
  });

  return {
    added,
    categories: plan.plannedCategories.length,
    accounts: plan.plannedAccounts.length,
    skipped: plan.entries.length - added
  };
}

/* --------------------------------------------------------------------------- *
 * JSON backup restoration
 * --------------------------------------------------------------------------- */

/**
 * Parses and validates a SpendWise JSON backup.
 * @returns {{ok:boolean, error?:string, state?:object, meta?:object, warnings:string[]}}
 */
export function parseBackupJson(text) {
  const warnings = [];
  const parsed = safeJsonParse(text, { maxBytes: appConfig.limits.maxBackupBytes });
  if (!parsed.ok) return { ok: false, error: parsed.error, warnings };

  const payload = parsed.value;
  if (!payload || typeof payload !== 'object') return { ok: false, error: 'The backup file does not contain an object.', warnings };

  const data = payload.data && typeof payload.data === 'object' ? payload.data : payload;
  const hasEntities = Array.isArray(data.transactions) || Array.isArray(data.categories) || Array.isArray(data.accounts);
  if (!hasEntities) {
    return { ok: false, error: 'This file does not look like a SpendWise backup (no data arrays found).', warnings };
  }

  if (payload.format && payload.format !== 'spendwise-backup') {
    warnings.push(`Unexpected backup format "${payload.format}". It was read as a SpendWise backup.`);
  }

  try {
    const { state, applied } = migrate(data);
    if (applied.length) warnings.push(`Schema migrated: ${applied.join(', ')}.`);
    if (payload.schemaVersion && Number(payload.schemaVersion) !== state.schemaVersion) {
      warnings.push(`Backup schema version ${payload.schemaVersion} was upgraded to ${state.schemaVersion}.`);
    }
    // Referential integrity check (reported, not fatal).
    const accountIds = new Set(state.accounts.map((a) => a.id));
    const categoryIds = new Set(state.categories.map((c) => c.id));
    const orphanTransactions = state.transactions.filter(
      (tx) => !accountIds.has(tx.accountId) || (tx.categoryId && !categoryIds.has(tx.categoryId))
    ).length;
    if (orphanTransactions > 0) {
      warnings.push(`${orphanTransactions} transaction(s) reference an account or category that is not present in this backup. They are kept and shown with the label "Deleted account/category".`);
    }
    return {
      ok: true,
      state,
      warnings,
      meta: {
        exportedAt: payload.exportedAt || null,
        app: payload.app || null,
        schemaVersion: payload.schemaVersion ?? data.schemaVersion ?? 0,
        counts: {
          transactions: state.transactions.length,
          categories: state.categories.length,
          accounts: state.accounts.length,
          budgets: state.budgets.length,
          recurringRules: state.recurringRules.length,
          goals: state.goals.length
        }
      }
    };
  } catch (error) {
    return { ok: false, error: error?.message || 'The backup could not be read.', warnings };
  }
}

/** Detects the file kind so the import dialog can route it correctly. */
export function sniffFileKind(text, filename = '') {
  const name = String(filename).toLowerCase();
  if (name.endsWith('.json')) return 'json';
  if (name.endsWith('.csv') || name.endsWith('.txt')) return 'csv';
  const head = String(text).trimStart().slice(0, 1);
  if (head === '{' || head === '[') return 'json';
  return 'csv';
}

export { parseBooleanish };
