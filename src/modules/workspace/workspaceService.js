/**
 * Tenant-admin API façade for the *current* workspace.
 *
 * Thin wrapper over `/api/tenants/current/*`. The caller's tenant role
 * (TENANT_ADMIN / TENANT_MEMBER) is decided entirely by the Worker from the
 * membership row; this service only calls the endpoints. Every call carries the
 * `X-Tenant-Id` header through the shared API client.
 */

export function createWorkspaceService({ client } = {}) {
  const base = '/api/tenants/current';

  const queryString = (params = {}) => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === '') continue;
      search.set(key, String(value));
    }
    const text = search.toString();
    return text ? `?${text}` : '';
  };

  return {
    get configured() {
      return client?.configured !== false;
    },
    current: () => client.get(base),
    update: (patch) => client.patch(base, patch),
    members: () => client.get(`${base}/members`),
    addMember: (payload) => client.post(`${base}/members`, payload),
    updateMember: (userId, patch) => client.patch(`${base}/members/${encodeURIComponent(userId)}`, patch),
    removeMember: (userId) => client.delete(`${base}/members/${encodeURIComponent(userId)}`),
    audit: (params) => client.get(`${base}/audit${queryString(params)}`)
  };
}
