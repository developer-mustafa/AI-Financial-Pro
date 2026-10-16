/**
 * Minimal publish/subscribe bus.
 *
 * Used only where a genuine many-to-many relationship exists (data changed,
 * theme changed, cloud status changed). Modules must unsubscribe on unmount.
 */

export const EVENTS = Object.freeze({
  DATA_CHANGED: 'data:changed',
  THEME_CHANGED: 'theme:changed',
  ROUTE_CHANGED: 'route:changed',
  CLOUD_STATUS: 'cloud:status',
  SYNC_DONE: 'sync:done',
  BUDGET_ALERT: 'budget:alert',
  RECURRING_DUE: 'recurring:due',
  TENANT_CHANGED: 'tenant:changed',
  OPEN_TRANSACTION_FORM: 'ui:open-transaction-form'
});

export function createEventBus() {
  const listeners = new Map();

  return {
    /** @returns {() => void} unsubscribe */
    on(event, handler) {
      if (typeof handler !== 'function') return () => {};
      const set = listeners.get(event) || new Set();
      set.add(handler);
      listeners.set(event, set);
      return () => set.delete(handler);
    },
    once(event, handler) {
      const off = this.on(event, (payload) => {
        off();
        handler(payload);
      });
      return off;
    },
    off(event, handler) {
      if (handler) listeners.get(event)?.delete(handler);
      else listeners.delete(event);
    },
    emit(event, payload) {
      const set = listeners.get(event);
      if (!set || set.size === 0) return;
      for (const handler of [...set]) {
        try {
          handler(payload);
        } catch (error) {
          console.error(`[eventBus] listener for "${event}" failed`, error);
        }
      }
    },
    clear() {
      listeners.clear();
    },
    count(event) {
      return event ? listeners.get(event)?.size || 0 : [...listeners.values()].reduce((sum, set) => sum + set.size, 0);
    }
  };
}

/** Shared application bus. */
export const bus = createEventBus();
