/**
 * Workspace (tenant) service.
 *
 * Owns which workspace the app is currently acting in and the list of
 * workspaces the signed-in account may use. The selection is sent to the Worker
 * as an `X-Tenant-Id` header, but it is NOT an authorization claim: the Worker
 * independently verifies an active membership for the exact authenticated user
 * before honouring it (see backend/src/tenant.js). A forged or stale id is a
 * plain 403 — the client can never widen its own access.
 *
 * The service degrades gracefully: when cloud sync is off, or an older backend
 * without the tenant endpoints is deployed, the list is simply empty and the
 * rest of the app behaves exactly as before (personal, single-workspace).
 */

import { appConfig } from '../config/appConfig.js';
import { bus, EVENTS } from '../core/eventBus.js';
import { ApiError } from './apiClient.js';

export function createTenantService({ client, storage = globalThis.localStorage } = {}) {
  let tenants = [];
  let currentId = readPersisted();
  let loaded = false;
  let lastError = null;
  const listeners = new Set();

  function readPersisted() {
    try {
      const raw = storage.getItem(appConfig.storage.tenant);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return parsed?.tenantId ? String(parsed.tenantId) : null;
    } catch {
      return null;
    }
  }

  function persist() {
    try {
      if (currentId) storage.setItem(appConfig.storage.tenant, JSON.stringify({ tenantId: currentId }));
      else storage.removeItem(appConfig.storage.tenant);
    } catch {
      /* selection is not critical: it just does not survive a reload */
    }
  }

  function currentTenant() {
    return tenants.find((t) => t.id === currentId) || null;
  }

  function notify(reason) {
    const payload = { tenants: tenants.slice(), current: currentTenant(), currentId, reason };
    for (const listener of [...listeners]) {
      try {
        listener(payload);
      } catch (error) {
        console.error('[tenants] listener failed', error);
      }
    }
  }

  /** Keep the persisted selection valid; default to the personal workspace. */
  function reconcile() {
    if (tenants.length === 0) {
      if (currentId) {
        currentId = null;
        persist();
      }
      return;
    }
    if (!currentId || !tenants.some((t) => t.id === currentId)) {
      currentId = (tenants.find((t) => t.isPersonal) || tenants[0]).id;
      persist();
    }
  }

  const service = {
    get enabled() {
      return client?.configured !== false;
    },
    get loaded() {
      return loaded;
    },
    get list() {
      return tenants.slice();
    },
    get current() {
      return currentTenant();
    },
    get currentId() {
      return currentId;
    },
    /** The caller's role inside the current workspace (null when signed out). */
    get role() {
      return currentTenant()?.role || null;
    },
    get isTenantAdmin() {
      return service.role === 'TENANT_ADMIN';
    },
    get lastError() {
      return lastError;
    },

    /** Value injected as `X-Tenant-Id` (null => the Worker's personal default). */
    getTenantId() {
      return currentId;
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /**
     * Fetch (or refresh) the workspaces this account belongs to.
     * @returns {Promise<object[]>}
     */
    async load() {
      if (!service.enabled) {
        tenants = [];
        loaded = true;
        reconcile();
        notify('load');
        return service.list;
      }
      try {
        const data = await client.get('/api/tenants');
        tenants = Array.isArray(data?.tenants) ? data.tenants : [];
        lastError = null;
      } catch (error) {
        tenants = [];
        if (error instanceof ApiError && (error.isUnauthorized || error.code === 'not_configured' || error.status === 404)) {
          // Signed out, cloud off, or an older backend: behave as before.
          lastError = null;
        } else {
          lastError = error?.message || 'Could not load workspaces';
        }
      }
      loaded = true;
      reconcile();
      notify('load');
      return service.list;
    },

    /**
     * Switch the active workspace. Only a workspace the user is actually a
     * member of can be selected (the server re-checks on every request anyway).
     * @param {string} id
     */
    switchTenant(id) {
      const target = tenants.find((t) => t.id === id);
      if (!target) throw new Error('You are not a member of that workspace.');
      if (target.id === currentId) return currentId;
      currentId = target.id;
      persist();
      notify('switch');
      bus.emit(EVENTS.TENANT_CHANGED, { tenantId: currentId, tenant: target });
      return currentId;
    },

    /** Clear everything (used on sign-out). */
    reset() {
      const had = Boolean(currentId) || tenants.length > 0;
      tenants = [];
      loaded = false;
      lastError = null;
      if (currentId) {
        currentId = null;
        persist();
      }
      if (had) notify('reset');
    }
  };

  return service;
}
