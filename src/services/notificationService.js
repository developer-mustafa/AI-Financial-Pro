/**
 * Alert + due-item notification logic.
 *
 * This module owns the *data* behind the notification bell: budget threshold
 * breaches, recurring occurrences awaiting review and unacknowledged alerts.
 * Presentation is handled by components/toast.js and the notification panel.
 *
 * Acknowledgements are UI state only and are stored in the UI-preference
 * store, never in the financial dataset.
 */

import { budgetAlerts, pendingOccurrences, budgetOverview } from '../utils/calculations.js';
import { todayISO } from '../utils/date.js';

export function createNotificationService({ store, uiPrefs }) {
  const ACK_KEY = 'alertAcks';
  const SEEN_KEY = 'alertsSeenAt';

  const readAcks = () => uiPrefs.get(ACK_KEY, {}) || {};
  const writeAcks = (value) => uiPrefs.set(ACK_KEY, value);

  function currentAlerts() {
    const state = store.get();
    if (!state.preferences.budgetAlertsEnabled) return [];
    return budgetAlerts(state.budgets, state.transactions, {
      thresholds: state.preferences.alertThresholds || [75, 90, 100],
      today: todayISO(),
      weekStart: state.preferences.weekStart ?? 0,
      categories: state.categories,
      acknowledged: readAcks()
    });
  }

  function dueItems() {
    return pendingOccurrences(store.get().recurringRules, store.get().transactions, { today: todayISO() });
  }

  return {
    /** Budget threshold breaches that the user has not dismissed yet. */
    budgetAlerts: currentAlerts,
    /** Every active budget with its utilisation, worst first. */
    budgetOverview: () => {
      const state = store.get();
      return budgetOverview(state.budgets, state.transactions, {
        today: todayISO(),
        weekStart: state.preferences.weekStart ?? 0,
        categories: state.categories
      });
    },
    dueItems,
    dueCount: () => dueItems().length,
    alertCount: () => currentAlerts().length,

    /** Acknowledges one threshold level for one budget. */
    acknowledge(budgetId, level) {
      const acks = readAcks();
      acks[budgetId] = level;
      writeAcks(acks);
    },

    /** Clears acknowledgement for a budget (e.g. after editing its limit). */
    resetAcknowledgement(budgetId) {
      const acks = readAcks();
      delete acks[budgetId];
      writeAcks(acks);
    },

    /** Badge count shown on the bell: unacknowledged alerts + due items. */
    badgeCount() {
      return currentAlerts().length + dueItems().length;
    },

    seenAt: () => uiPrefs.get(SEEN_KEY, null),
    markSeen() {
      uiPrefs.set(SEEN_KEY, new Date().toISOString());
    }
  };
}
