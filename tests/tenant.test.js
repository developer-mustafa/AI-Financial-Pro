/**
 * Multi-tenant frontend layer.
 *
 * Covers the client half of the workspace model:
 *   - the `X-Tenant-Id` request header (a selector, never a claim),
 *   - `tenantService` reconciliation/persistence/switching,
 *   - `store.hydrate`, which swaps a workspace's dataset in without echoing it
 *     back over the cloud copy.
 */

import { describe, it, expect, vi } from 'vitest';
import { createApiClient, ApiError } from '../src/services/apiClient.js';
import { createTenantService } from '../src/services/tenantService.js';
import { Store, createEmptyState } from '../src/core/state.js';
import { bus, EVENTS } from '../src/core/eventBus.js';
import { appConfig } from '../src/config/appConfig.js';
import { memoryStorage } from './helpers.js';

function jsonResponse(body, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    async text() {
      return JSON.stringify(body);
    },
    async json() {
      return JSON.parse(JSON.stringify(body));
    }
  };
}

const PERSONAL = { id: 't-personal', name: 'Nadia Personal', isPersonal: true, type: 'personal', role: 'TENANT_ADMIN', status: 'active' };
const ORG = { id: 't-org', name: 'Acme Ltd', isPersonal: false, type: 'organization', role: 'TENANT_MEMBER', status: 'active' };

/** A client stub whose only real behaviour is `/api/tenants`. */
function fakeClient({ tenants = [PERSONAL, ORG], error = null, configured = true } = {}) {
  return {
    configured,
    get: vi.fn(async (path) => {
      if (error) throw error;
      if (path === '/api/tenants') return { tenants };
      return {};
    })
  };
}

describe('apiClient — tenant header', () => {
  it('sends X-Tenant-Id when a workspace is selected', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true }));
    const client = createApiClient({
      baseUrl: 'https://api.example',
      getToken: () => null,
      getTenantId: () => 't-org',
      fetchImpl
    });
    await client.get('/api/state');
    expect(fetchImpl.mock.calls[0][1].headers['X-Tenant-Id']).toBe('t-org');
  });

  it('omits the header when no workspace is selected', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true }));
    const client = createApiClient({
      baseUrl: 'https://api.example',
      getToken: () => null,
      getTenantId: () => null,
      fetchImpl
    });
    await client.get('/api/state');
    expect(fetchImpl.mock.calls[0][1].headers['X-Tenant-Id']).toBeUndefined();
  });
});

describe('tenantService', () => {
  it('loads memberships and defaults to the personal workspace', async () => {
    const storage = memoryStorage();
    const service = createTenantService({ client: fakeClient(), storage });

    await service.load();

    expect(service.list.map((t) => t.id)).toEqual(['t-personal', 't-org']);
    expect(service.currentId).toBe('t-personal');
    expect(service.role).toBe('TENANT_ADMIN');
    expect(service.isTenantAdmin).toBe(true);
    expect(JSON.parse(storage.getItem(appConfig.storage.tenant)).tenantId).toBe('t-personal');
  });

  it('restores a persisted selection that is still a membership', async () => {
    const storage = memoryStorage({ [appConfig.storage.tenant]: JSON.stringify({ tenantId: 't-org' }) });
    const service = createTenantService({ client: fakeClient(), storage });

    await service.load();

    expect(service.currentId).toBe('t-org');
    expect(service.isTenantAdmin).toBe(false);
  });

  it('falls back to the personal workspace when the persisted id is stale', async () => {
    const storage = memoryStorage({ [appConfig.storage.tenant]: JSON.stringify({ tenantId: 'deleted-workspace' }) });
    const service = createTenantService({ client: fakeClient(), storage });

    await service.load();

    expect(service.currentId).toBe('t-personal');
  });

  it('switches workspace, persists the choice and emits TENANT_CHANGED', async () => {
    const storage = memoryStorage();
    const service = createTenantService({ client: fakeClient(), storage });
    await service.load();

    const seen = [];
    const off = bus.on(EVENTS.TENANT_CHANGED, (payload) => seen.push(payload));
    service.switchTenant('t-org');
    off();

    expect(service.currentId).toBe('t-org');
    expect(service.getTenantId()).toBe('t-org');
    expect(JSON.parse(storage.getItem(appConfig.storage.tenant)).tenantId).toBe('t-org');
    expect(seen).toHaveLength(1);
    expect(seen[0].tenantId).toBe('t-org');
    expect(seen[0].tenant.name).toBe('Acme Ltd');
  });

  it('refuses to switch to a workspace the account is not a member of', async () => {
    const service = createTenantService({ client: fakeClient(), storage: memoryStorage() });
    await service.load();

    expect(() => service.switchTenant('not-a-member')).toThrowError(/not a member/i);
    expect(service.currentId).toBe('t-personal');
  });

  it('degrades to an empty list when cloud sync is not configured', async () => {
    const service = createTenantService({ client: fakeClient({ configured: false }), storage: memoryStorage() });

    await service.load();

    expect(service.list).toEqual([]);
    expect(service.getTenantId()).toBeNull();
    expect(service.lastError).toBeNull();
  });

  it('treats a missing tenants endpoint (older backend) as an empty list', async () => {
    const notFound = new ApiError('Not found', { status: 404, code: 'http_error' });
    const service = createTenantService({ client: fakeClient({ error: notFound }), storage: memoryStorage() });

    await service.load();

    expect(service.list).toEqual([]);
    expect(service.lastError).toBeNull();
  });

  it('surfaces an unexpected failure without throwing', async () => {
    const service = createTenantService({
      client: fakeClient({ error: new Error('gateway down') }),
      storage: memoryStorage()
    });

    await expect(service.load()).resolves.toEqual([]);
    expect(service.list).toEqual([]);
    expect(service.lastError).toBe('gateway down');
  });

  it('reset clears the list, the selection and the persisted value', async () => {
    const storage = memoryStorage();
    const service = createTenantService({ client: fakeClient(), storage });
    await service.load();

    service.reset();

    expect(service.list).toEqual([]);
    expect(service.currentId).toBeNull();
    expect(service.loaded).toBe(false);
    expect(storage.getItem(appConfig.storage.tenant)).toBeNull();
  });
});

describe('store.hydrate', () => {
  it('replaces the in-memory state without writing it back', () => {
    const saves = [];
    const persistence = {
      load: async () => null,
      save: async (state, changes) => saves.push({ state, changes })
    };
    const store = new Store({ persistence });
    store.ready = true;

    store.hydrate({ ...createEmptyState(), transactions: [{ id: 'tx-1' }] }, 'tenant-switch');

    expect(store.get().transactions).toEqual([{ id: 'tx-1' }]);
    expect(saves).toEqual([]);
  });

  it('drops pending (unflushed) changes and the debounce timer', () => {
    const store = new Store({ persistence: { load: async () => null, save: async () => {} } });
    store.ready = true;
    store.queuePersist([{ resource: 'transactions', op: 'upsert', record: { id: 'tx-old' } }]);
    expect(store.pendingChanges).toHaveLength(1);

    store.hydrate(createEmptyState(), 'tenant-switch');

    expect(store.pendingChanges).toEqual([]);
    expect(store.persistTimer).toBeNull();
    expect(store.get().transactions).toEqual([]);
  });
});
