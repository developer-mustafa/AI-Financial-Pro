/**
 * Thin Fetch wrapper for the SpendWise Cloudflare Worker API.
 *
 *  - The API base URL comes from the public `runtime-config.js` file.
 *  - No credentials of any kind live here: the Worker holds the database
 *    connection string in a Cloudflare secret. The only thing this file stores
 *    is the user's own session token.
 *  - No database URL, SQL, or secret is ever sent to the browser.
 */

export class ApiError extends Error {
  constructor(message, { status = 0, code = 'error', details = null, cause = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.cause = cause;
  }

  get isNetwork() {
    return this.code === 'network_error';
  }

  get isUnauthorized() {
    return this.status === 401;
  }

  get isRateLimited() {
    return this.status === 429;
  }
}

const DEFAULT_TIMEOUT = 15000;

/**
 * @param {{baseUrl?: string, getToken?: () => (string|null|Promise<string|null>), getTenantId?: () => (string|null), onUnauthorized?: Function, fetchImpl?: Function}} options
 */
export function createApiClient({
  baseUrl = '',
  getToken = () => null,
  getTenantId = () => null,
  onUnauthorized = null,
  fetchImpl = globalThis.fetch?.bind(globalThis)
} = {}) {
  const root = String(baseUrl || '').replace(/\/+$/, '');
  const configured = Boolean(root) && typeof fetchImpl === 'function';

  async function request(path, { method = 'GET', body = undefined, signal = null, timeout = DEFAULT_TIMEOUT, raw = false } = {}) {
    if (!configured) {
      throw new ApiError('Cloud sync is not configured for this deployment.', { code: 'not_configured' });
    }

    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeout) : null;
    const abortExternally = () => controller?.abort();
    if (signal && controller) signal.addEventListener('abort', abortExternally, { once: true });

    const headers = { Accept: 'application/json' };
    // `getToken` may be async: a Neon Auth JWT is minted/refreshed on demand.
    const token = await getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    // Tenant selector. This is NEVER an authorization claim: the Worker verifies
    // membership for this exact user before trusting it, and 403s otherwise.
    const tenantId = getTenantId();
    if (tenantId) headers['X-Tenant-Id'] = String(tenantId);
    if (body !== undefined && !(body instanceof FormData)) headers['Content-Type'] = 'application/json';

    let response;
    try {
      response = await fetchImpl(`${root}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
        signal: controller?.signal,
        credentials: 'omit',
        mode: 'cors',
        cache: 'no-store'
      });
    } catch (error) {
      const aborted = error?.name === 'AbortError';
      throw new ApiError(aborted ? 'The request timed out.' : 'Could not reach the SpendWise API.', {
        code: aborted ? 'timeout' : 'network_error',
        cause: error
      });
    } finally {
      if (timer) clearTimeout(timer);
      if (signal && controller) signal.removeEventListener('abort', abortExternally);
    }

    if (response.status === 204) return null;

    let payload = null;
    const text = await response.text().catch(() => '');
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        if (raw) return text;
        if (!response.ok) {
          throw new ApiError(`The server returned an unreadable response (${response.status}).`, { status: response.status, code: 'bad_response' });
        }
        return text;
      }
    }

    if (!response.ok) {
      const message = payload?.error?.message || payload?.message || `Request failed (${response.status}).`;
      const code = payload?.error?.code || `http_${response.status}`;
      if (response.status === 401) onUnauthorized?.();
      throw new ApiError(message, { status: response.status, code, details: payload?.error?.details ?? null });
    }

    return raw ? text : payload;
  }

  return {
    get configured() {
      return configured;
    },
    baseUrl: root,
    request,
    get: (path, options) => request(path, { ...options, method: 'GET' }),
    post: (path, body, options) => request(path, { ...options, method: 'POST', body }),
    put: (path, body, options) => request(path, { ...options, method: 'PUT', body }),
    patch: (path, body, options) => request(path, { ...options, method: 'PATCH', body }),
    delete: (path, options) => request(path, { ...options, method: 'DELETE' }),

    /** Connectivity probe used by Settings and the sync indicator. */
    health: () => request('/api/health', { timeout: 8000 }),

    /** Validates credentials and returns the signed-in user. */
    async verifyToken() {
      try {
        const data = await request('/api/auth/me');
        return data?.user || null;
      } catch (error) {
        if (error instanceof ApiError && error.isUnauthorized) return null;
        throw error;
      }
    },

    /** Full session payload: `{ user, memberships, defaultTenantId }`. */
    me: () => request('/api/auth/me'),
  };
}
