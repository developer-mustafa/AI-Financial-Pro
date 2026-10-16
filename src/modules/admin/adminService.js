/**
 * Super-admin user-management API façade.
 *
 * Thin wrapper over `/api/admin/users`. The Worker enforces the administrator
 * role on every one of these routes, so a non-admin caller simply receives a
 * 403 — nothing here decides authorisation. The service only ever manages
 * *accounts*; it never touches another user's finance data.
 */

export function createAdminService({ client } = {}) {
  const base = '/api/admin/users';

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
    /** @returns {Promise<{items:object[], total:number, limit:number, offset:number}>} */
    list: (params) => client.get(`${base}${queryString(params)}`),
    get: (id) => client.get(`${base}/${encodeURIComponent(id)}`),
    create: (payload) => client.post(base, payload),
    update: (id, patch) => client.patch(`${base}/${encodeURIComponent(id)}`, patch),
    remove: (id) => client.delete(`${base}/${encodeURIComponent(id)}`)
  };
}
