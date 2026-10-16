/**
 * Platform-admin API façade.
 *
 * Thin wrapper over `/api/platform/*`. Every route is gated server-side by the
 * PLATFORM_ADMIN role (`users.role === 'admin'`); a non-admin caller receives a
 * 403 no matter what the UI shows. This service never decides authorization.
 *
 * Note: tenant deletion is a SOFT archive — no irreversible delete is exposed.
 */

export function createPlatformService({ client } = {}) {
  const base = '/api/platform';

  const queryString = (params = {}) => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === '') continue;
      search.set(key, String(value));
    }
    const text = search.toString();
    return text ? `?${text}` : '';
  };

  const tenantPath = (id) => `${base}/tenants/${encodeURIComponent(id)}`;
  const memberPath = (id, userId) => `${tenantPath(id)}/members/${encodeURIComponent(userId)}`;

  return {
    get configured() {
      return client?.configured !== false;
    },

    overview: () => client.get(`${base}/overview`),

    tenants: (params) => client.get(`${base}/tenants${queryString(params)}`),
    createTenant: (payload) => client.post(`${base}/tenants`, payload),
    tenant: (id) => client.get(tenantPath(id)),
    updateTenant: (id, patch) => client.patch(tenantPath(id), patch),
    archiveTenant: (id) => client.delete(tenantPath(id)),
    addMember: (id, payload) => client.post(`${tenantPath(id)}/members`, payload),
    updateMember: (id, userId, patch) => client.patch(memberPath(id, userId), patch),
    removeMember: (id, userId) => client.delete(memberPath(id, userId)),

    users: (params) => client.get(`${base}/users${queryString(params)}`),
    createUser: (payload) => client.post(`${base}/users`, payload),
    userMemberships: (id) => client.get(`${base}/users/${encodeURIComponent(id)}/memberships`),

    audit: (params) => client.get(`${base}/audit${queryString(params)}`)
  };
}
