/**
 * Savings-goal domain service.
 *
 * A goal is a target amount plus a running total of what has been set aside.
 * The saved total only ever changes through recorded *contributions* and
 * *withdrawals*, which keeps an auditable ledger next to the goal.
 *
 * When a funding account is supplied, a contribution (or withdrawal) ALSO
 * creates a real transfer between the funding account and the goal's linked
 * savings account, inside a single atomic `store.apply`. This is deliberate:
 * moving money into a savings pot is not income or expense, so it must never
 * distort reports — it is only ever a transfer.
 *
 * Amounts are integers in minor units and a goal is always single-currency;
 * currencies are never mixed.
 */

import { store as defaultStore, RESOURCES } from '../../core/state.js';
import { ids } from '../../utils/ids.js';
import { todayISO, nowISO } from '../../utils/date.js';
import { validateGoal, validateContribution } from '../../utils/validation.js';
import { goalProgress } from '../../utils/calculations.js';

export function createGoalService({ store = defaultStore, transactions } = {}) {
  const all = () => store.list(RESOURCES.GOALS);

  function validate(input, { excludeId = null } = {}) {
    return validateGoal(input, {
      accounts: store.list(RESOURCES.ACCOUNTS),
      preferences: store.preferences,
      excludeId
    });
  }

  const service = {
    all,
    get: (id) => store.byId(RESOURCES.GOALS, id),
    active: () => all().filter((goal) => !goal.archived && goal.status === 'active'),
    validate,

    add(input) {
      const result = validate(input);
      if (!result.ok) return { ok: false, errors: result.errors };
      const record = { ...result.value, id: result.value.id || ids.goal(), createdAt: nowISO(), updatedAt: nowISO() };
      store.apply('goal:add', (draft) => {
        draft.goals = [...draft.goals, record];
        return [{ resource: RESOURCES.GOALS, op: 'upsert', record }];
      });
      return { ok: true, record };
    },

    update(id, input) {
      const existing = store.byId(RESOURCES.GOALS, id);
      if (!existing) return { ok: false, errors: { id: 'That goal no longer exists.' } };
      const result = validate({ ...existing, ...input, id }, { excludeId: id });
      if (!result.ok) return { ok: false, errors: result.errors };
      const record = { ...result.value, id, createdAt: existing.createdAt, updatedAt: nowISO() };
      store.apply('goal:update', (draft) => {
        draft.goals = draft.goals.map((goal) => (goal.id === id ? record : goal));
        return [{ resource: RESOURCES.GOALS, op: 'upsert', record }];
      });
      return { ok: true, record };
    },

    /** Marks a goal complete without changing the amount saved. */
    complete(id) {
      const existing = store.byId(RESOURCES.GOALS, id);
      if (!existing) return { ok: false, errors: { id: 'That goal no longer exists.' } };
      return service.update(id, { ...existing, status: 'completed', archived: false });
    },

    reopen(id) {
      const existing = store.byId(RESOURCES.GOALS, id);
      if (!existing) return { ok: false, errors: { id: 'That goal no longer exists.' } };
      return service.update(id, { ...existing, status: 'active', archived: false });
    },

    archive(id) {
      const existing = store.byId(RESOURCES.GOALS, id);
      if (!existing) return { ok: false, errors: { id: 'That goal no longer exists.' } };
      if (existing.archived) return { ok: true, record: existing };
      return service.update(id, { ...existing, archived: true });
    },

    restore(id) {
      const existing = store.byId(RESOURCES.GOALS, id);
      if (!existing) return { ok: false, errors: { id: 'That goal no longer exists.' } };
      return service.update(id, { ...existing, archived: false });
    },

    /** Goals are standalone records; a hard delete never touches transactions. */
    remove(id) {
      const existing = store.byId(RESOURCES.GOALS, id);
      if (!existing) return { ok: false, errors: { id: 'That goal no longer exists.' } };
      store.apply('goal:delete', (draft) => {
        draft.goals = draft.goals.filter((goal) => goal.id !== id);
        return [{ resource: RESOURCES.GOALS, op: 'delete', id }];
      });
      return { ok: true, record: existing };
    },

    progress: (goal) => goalProgress(goal, { today: todayISO() }),

    /** Rows for the list screen: live progress attached, unfinished first. */
    rows({ includeArchived = true } = {}) {
      const list = includeArchived ? all() : all().filter((goal) => !goal.archived);
      return list
        .map((goal) => ({ goal, progress: goalProgress(goal, { today: todayISO() }) }))
        .sort((a, b) => {
          const archivedA = a.goal.archived ? 1 : 0;
          const archivedB = b.goal.archived ? 1 : 0;
          if (archivedA !== archivedB) return archivedA - archivedB;
          const doneA = a.progress.onTrack ? 1 : 0;
          const doneB = b.progress.onTrack ? 1 : 0;
          if (doneA !== doneB) return doneA - doneB;
          return b.progress.percent - a.progress.percent || a.goal.name.localeCompare(b.goal.name);
        });
    },

    /** Aggregate counts and money for one currency (never mixed). */
    summary({ currency = store.preferences.currency } = {}) {
      const code = String(currency || 'BDT').toUpperCase();
      const scoped = all().filter((goal) => String(goal.currency || 'BDT').toUpperCase() === code && !goal.archived);
      let targetMinor = 0;
      let savedMinor = 0;
      let completed = 0;
      for (const goal of scoped) {
        targetMinor += Number(goal.targetMinor) || 0;
        savedMinor += Number(goal.savedMinor) || 0;
        if (goalProgress(goal, { today: todayISO() }).onTrack) completed += 1;
      }
      return {
        currency: code,
        count: scoped.length,
        completed,
        activeCount: scoped.length - completed,
        targetMinor,
        savedMinor,
        remainingMinor: Math.max(0, targetMinor - savedMinor),
        archivedCount: all().filter((goal) => goal.archived).length
      };
    },

    /** Every distinct currency currently in use by a goal. */
    currencies() {
      return [...new Set(all().map((goal) => String(goal.currency || 'BDT').toUpperCase()))];
    },

    /**
     * Records a contribution or withdrawal.
     * @param {{goal: object|string}} target
     * @param {{direction?:string, amountMinor:number, date?:string, note?:string, sourceAccountId?:string|null}} input
     * @returns {{ok:boolean, record?:object, contribution?:object, transfer?:object, errors?:object}}
     */
    contribute({ goal, ...input } = {}) {
      const goalRecord = typeof goal === 'string' ? store.byId(RESOURCES.GOALS, goal) : goal;
      const current = goalRecord ? store.byId(RESOURCES.GOALS, goalRecord.id) : null;
      if (!current) return { ok: false, errors: { goal: 'That goal no longer exists.' } };

      const accounts = store.list(RESOURCES.ACCOUNTS);
      const validated = validateContribution(input, { goal: current, accounts });
      if (!validated.ok) return { ok: false, errors: validated.errors };
      const value = validated.value;
      const direction = value.direction;
      const amountMinor = Number(value.amountMinor) || 0;
      if (amountMinor <= 0) return { ok: false, errors: { amount: 'Enter an amount greater than zero.' } };

      // Build the paired transfer first so the whole operation is all-or-nothing.
      let transfer = null;
      if (value.sourceAccountId) {
        if (direction === 'withdrawal' && !current.accountId) {
          return { ok: false, errors: { sourceAccountId: 'Link a savings account to this goal before withdrawing to a real account.' } };
        }
        if (!transactions) return { ok: false, errors: { service: 'The transaction service is unavailable.' } };

        const fromAccountId = direction === 'contribution' ? value.sourceAccountId : current.accountId;
        const toAccountId = direction === 'contribution' ? current.accountId : value.sourceAccountId;
        const candidate = {
          type: 'transfer',
          amountMinor,
          currency: current.currency,
          accountId: fromAccountId,
          toAccountId,
          date: value.date,
          description:
            direction === 'contribution'
              ? `Contribution to ${current.name}`
              : `Withdrawal from ${current.name}`,
          paymentMethod: store.preferences.defaultPaymentMethod || 'cash',
          status: 'posted',
          tags: [],
          notes: value.note || ''
        };
        const checked = transactions.validate(candidate);
        if (!checked.ok) return { ok: false, errors: checked.errors };
        transfer = { ...checked.value, id: ids.transaction(), createdAt: nowISO(), updatedAt: nowISO() };
      }

      const contribution = {
        id: ids.contribution(),
        amountMinor,
        direction,
        date: value.date,
        note: value.note,
        transactionId: transfer?.id || null
      };

      const previousSaved = Math.max(0, Number(current.savedMinor) || 0);
      const savedMinor = Math.max(0, previousSaved + (direction === 'contribution' ? amountMinor : -amountMinor));
      const updatedGoal = {
        ...current,
        savedMinor,
        contributions: [...(current.contributions || []), contribution],
        updatedAt: nowISO()
      };

      store.apply('goal:contribute', (draft) => {
        draft.goals = draft.goals.map((goal_) => (goal_.id === current.id ? updatedGoal : goal_));
        const changes = [{ resource: RESOURCES.GOALS, op: 'upsert', record: updatedGoal }];
        if (transfer) {
          draft.transactions = [...draft.transactions, transfer];
          changes.push({ resource: RESOURCES.TRANSACTIONS, op: 'upsert', record: transfer });
        }
        return changes;
      });

      return { ok: true, record: updatedGoal, contribution, transfer };
    },

    /**
     * Reverses a logged contribution/withdrawal and removes any paired transfer.
     * Keeps `savedMinor` consistent with the remaining ledger.
     */
    removeContribution(goalId, contributionId) {
      const current = store.byId(RESOURCES.GOALS, goalId);
      if (!current) return { ok: false, errors: { goal: 'That goal no longer exists.' } };
      const entry = (current.contributions || []).find((c) => c.id === contributionId);
      if (!entry) return { ok: false, errors: { contribution: 'That entry no longer exists.' } };

      const delta = entry.direction === 'contribution' ? -entry.amountMinor : entry.amountMinor;
      const savedMinor = Math.max(0, (Number(current.savedMinor) || 0) + delta);
      const updatedGoal = {
        ...current,
        savedMinor,
        contributions: (current.contributions || []).filter((c) => c.id !== contributionId),
        updatedAt: nowISO()
      };
      const linkedTransfer = entry.transactionId ? store.byId(RESOURCES.TRANSACTIONS, entry.transactionId) : null;

      store.apply('goal:contribution-remove', (draft) => {
        draft.goals = draft.goals.map((goal_) => (goal_.id === current.id ? updatedGoal : goal_));
        const changes = [{ resource: RESOURCES.GOALS, op: 'upsert', record: updatedGoal }];
        if (linkedTransfer) {
          draft.transactions = draft.transactions.filter((tx) => tx.id !== linkedTransfer.id);
          changes.push({ resource: RESOURCES.TRANSACTIONS, op: 'delete', id: linkedTransfer.id });
        }
        return changes;
      });

      return { ok: true, record: updatedGoal, reversed: entry, removedTransfer: linkedTransfer };
    },

    /** Ledger for one goal, newest first. */
    contributions(goalId) {
      const goal = store.byId(RESOURCES.GOALS, goalId);
      if (!goal) return [];
      return [...(goal.contributions || [])].sort(
        (a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : String(b.id).localeCompare(String(a.id)))
      );
    },

    /** Accounts that can be *linked* as a goal's savings account. */
    accountOptions() {
      const options = store.list(RESOURCES.ACCOUNTS).map((account) => ({
        value: account.id,
        label: `${account.name} · ${account.currency}${account.archived ? ' (archived)' : ''}`
      }));
      return options;
    },

    /**
     * Accounts able to fund a given goal: active, same currency, and not the
     * goal's own linked account.
     */
    fundingOptions(goal) {
      const code = String(goal?.currency || store.preferences.currency).toUpperCase();
      return store
        .list(RESOURCES.ACCOUNTS)
        .filter((account) => !account.archived)
        .filter((account) => String(account.currency || 'BDT').toUpperCase() === code)
        .filter((account) => account.id !== goal?.accountId)
        .map((account) => ({ value: account.id, label: `${account.name} · ${account.currency}` }));
    }
  };

  return service;
}
