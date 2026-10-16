/**
 * Account / wallet domain service.
 *
 * LEDGER CONVENTION (single rule for every account type):
 *   balance = openingBalance + Σ inflows − Σ outflows
 *   • income     → inflow to `accountId`
 *   • expense    → outflow from `accountId`
 *   • transfer   → outflow from `accountId`, inflow to `toAccountId`
 *
 * CREDIT CARDS: a charge is an outflow, so a credit card with no opening
 * balance shows a NEGATIVE balance while money is owed (a liability). Paying
 * the card is a transfer INTO the card, which moves the balance back toward
 * zero. The UI labels a negative credit-card balance as "Owed" and never
 * presents debt as positive cash.
 *
 * CURRENCY: an account holds exactly one currency. Transactions in a different
 * currency are ignored when computing the balance, and transfers between
 * accounts of different currencies are rejected.
 */

import { store as defaultStore, RESOURCES } from '../../core/state.js';
import { ids } from '../../utils/ids.js';
import { nowISO, todayISO } from '../../utils/date.js';
import { validateAccount } from '../../utils/validation.js';
import { accountBalance, accountBalances, netWorthByCurrency, accountMovements } from '../../utils/calculations.js';
import { normalizeCurrency } from '../../utils/currency.js';
import { DEFAULT_EXPENSE_CATEGORY_NAMES } from '../../config/defaults.js';

export function createAccountService({ store = defaultStore } = {}) {
  const all = () => store.list(RESOURCES.ACCOUNTS);

  function validate(input, { excludeId = null } = {}) {
    return validateAccount(input, { accounts: all(), excludeId });
  }

  const service = {
    all,
    active: () => all().filter((account) => !account.archived),
    get: (id) => store.byId(RESOURCES.ACCOUNTS, id),
    byName: (name) => all().find((account) => account.name.trim().toLowerCase() === String(name || '').trim().toLowerCase()),

    add(input) {
      const result = validate(input);
      if (!result.ok) return { ok: false, errors: result.errors };
      const record = { ...result.value, id: result.value.id || ids.account(), createdAt: nowISO(), updatedAt: nowISO() };
      store.apply('account:add', (draft) => {
        draft.accounts = [...draft.accounts, record];
        const changes = [{ resource: RESOURCES.ACCOUNTS, op: 'upsert', record }];
        if (!draft.preferences.defaultAccountId) {
          draft.preferences = { ...draft.preferences, defaultAccountId: record.id };
          changes.push({ resource: RESOURCES.PREFERENCES, op: 'upsert', record: draft.preferences });
        }
        return changes;
      });
      return { ok: true, record };
    },

    update(id, input) {
      const existing = store.byId(RESOURCES.ACCOUNTS, id);
      if (!existing) return { ok: false, errors: { id: 'That account no longer exists.' } };
      const result = validate({ ...existing, ...input, id }, { excludeId: id });
      if (!result.ok) return { ok: false, errors: result.errors };

      // A currency change would silently corrupt the meaning of every existing
      // amount, so it is blocked once the account has transactions.
      if (normalizeCurrency(result.value.currency) !== normalizeCurrency(existing.currency) && service.usageCount(id) > 0) {
        return {
          ok: false,
          errors: { currency: 'This account already has transactions. Its currency cannot be changed — create a new account instead.' }
        };
      }

      const record = { ...result.value, id, createdAt: existing.createdAt, updatedAt: nowISO() };
      store.apply('account:update', (draft) => {
        draft.accounts = draft.accounts.map((account) => (account.id === id ? record : account));
        return [{ resource: RESOURCES.ACCOUNTS, op: 'upsert', record }];
      });
      return { ok: true, record };
    },

    archive(id) {
      const existing = store.byId(RESOURCES.ACCOUNTS, id);
      if (!existing) return { ok: false, errors: { id: 'That account no longer exists.' } };
      return service.update(id, { ...existing, archived: true });
    },

    restore(id) {
      const existing = store.byId(RESOURCES.ACCOUNTS, id);
      if (!existing) return { ok: false, errors: { id: 'That account no longer exists.' } };
      const clash = all().find((account) => account.id !== id && !account.archived && account.name.trim().toLowerCase() === existing.name.trim().toLowerCase());
      if (clash) return { ok: false, errors: { name: `An active account named “${clash.name}” already exists. Rename it first.` } };
      return service.update(id, { ...existing, archived: false });
    },

    /** Hard delete — refused when the account has any history. */
    remove(id) {
      const existing = store.byId(RESOURCES.ACCOUNTS, id);
      if (!existing) return { ok: false, errors: { id: 'That account no longer exists.' } };
      const usage = service.usageCount(id);
      if (usage > 0) {
        return { ok: false, errors: { id: `This account is used by ${usage} transaction${usage === 1 ? '' : 's'}. Archive it instead so history stays intact.` } };
      }
      const linkedRecurring = store.list(RESOURCES.RECURRING).filter((rule) => rule.accountId === id || rule.toAccountId === id).length;
      if (linkedRecurring > 0) {
        return { ok: false, errors: { id: `${linkedRecurring} recurring rule(s) still point at this account. Reassign or delete them first.` } };
      }
      store.apply('account:delete', (draft) => {
        draft.accounts = draft.accounts.filter((account) => account.id !== id);
        const changes = [{ resource: RESOURCES.ACCOUNTS, op: 'delete', id }];
        if (draft.preferences.defaultAccountId === id) {
          draft.preferences = { ...draft.preferences, defaultAccountId: draft.accounts[0]?.id || null };
          changes.push({ resource: RESOURCES.PREFERENCES, op: 'upsert', record: draft.preferences });
        }
        return changes;
      });
      return { ok: true, record: existing };
    },

    usageCount(id) {
      return store.list(RESOURCES.TRANSACTIONS).filter((tx) => tx.accountId === id || tx.toAccountId === id).length;
    },

    /** Reasons a user should see before archiving an account. */
    archiveWarnings(id) {
      const transactions = service.usageCount(id);
      const recurringRules = store.list(RESOURCES.RECURRING).filter((rule) => (rule.accountId === id || rule.toAccountId === id) && rule.status === 'active').length;
      const goals = store.list(RESOURCES.GOALS).filter((goal) => goal.accountId === id && goal.status === 'active').length;
      return { transactions, recurringRules, goals };
    },

    balance: (id, options) => {
      const account = store.byId(RESOURCES.ACCOUNTS, id);
      return account ? accountBalance(account, store.list(RESOURCES.TRANSACTIONS), options) : 0;
    },

    balances: (options) => accountBalances(all(), store.list(RESOURCES.TRANSACTIONS), options),

    /** Map currency → total across non-archived accounts. */
    netWorth: (options) => netWorthByCurrency(all(), store.list(RESOURCES.TRANSACTIONS), options),

    movements: (id, options = {}) => {
      const account = store.byId(RESOURCES.ACCOUNTS, id);
      return account ? accountMovements(account, store.list(RESOURCES.TRANSACTIONS), options) : [];
    },

    /**
     * Creates a transfer by delegating to the transaction service so that the
     * same validation and single-write guarantee applies.
     */
    transfer({ fromAccountId, toAccountId, amount, date, description, notes }, transactionService) {
      return transactionService.add({
        type: 'transfer',
        accountId: fromAccountId,
        toAccountId,
        amount,
        date: date || todayISO(),
        description: description || 'Account transfer',
        notes
      });
    },

    /** Accounts that can receive a transfer from `id` (same currency, different account). */
    transferTargets(id) {
      const source = store.byId(RESOURCES.ACCOUNTS, id);
      if (!source) return [];
      return all().filter(
        (account) => account.id !== id && !account.archived && normalizeCurrency(account.currency) === normalizeCurrency(source.currency)
      );
    },

    /** Opening-balance sanity note for the account editor. */
    openingDefaults() {
      return {
        openingBalanceDate: todayISO(),
        suggestions: [
          { name: 'Cash', type: 'cash', icon: 'banknote', color: '#22c55e' },
          { name: 'Bank Account', type: 'bank', icon: 'landmark', color: '#6366f1' },
          { name: 'bKash', type: 'mobile_wallet', icon: 'smartphone', color: '#e11d48' },
          { name: 'Credit Card', type: 'credit_card', icon: 'credit-card', color: '#f59e0b' },
          { name: 'Savings', type: 'savings', icon: 'piggy-bank', color: '#14b8a6' }
        ]
      };
    },

    /** Aggregate figures used by the accounts overview cards. */
    overview({ from = null, to = null } = {}) {
      const transactions = store.list(RESOURCES.TRANSACTIONS);
      const balances = accountBalances(all(), transactions);
      const byCurrency = netWorthByCurrency(all(), transactions);
      const rows = all().map((account) => ({
        account,
        balanceMinor: balances.get(account.id) ?? 0,
        movementCount: accountMovements(account, transactions, { from, to }).length,
        isLiability: account.type === 'credit_card'
      }));
      return { rows, byCurrency, balances };
    },

    /** Names reserved to avoid confusing two accounts with one label. */
    reservedNames: DEFAULT_EXPENSE_CATEGORY_NAMES
  };

  return service;
}
