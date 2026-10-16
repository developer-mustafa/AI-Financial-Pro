/**
 * Minimal client for Managed Better Auth (Neon Auth).
 *
 * The app is a plain ES-module frontend with no bundler, so instead of pulling
 * in the npm SDK we speak the same REST endpoints the SDK uses. Only the four
 * calls SpendWise needs are implemented:
 *
 *   POST {base}/sign-in/magic-link   send a passwordless sign-in link
 *   GET  {base}/get-session          read the current session (cookie based)
 *   GET  {base}/token                mint a short-lived JWT for the Worker API
 *   POST {base}/sign-out             end the session
 *
 * Sessions live in an HTTP-only cookie on the auth service, so every request
 * uses `credentials: 'include'` and must be allowed by the project's trusted
 * origins. No credential of any kind is stored here.
 */

import { ApiError } from './apiClient.js';

const DEFAULT_TIMEOUT = 15000;
const MAGIC_LINK_TIMEOUT = 20000;

/**
 * @param {{baseUrl?: string, fetchImpl?: Function}} [options]
 */
export function createNeonAuthClient({ baseUrl = '', fetchImpl = globalThis.fetch?.bind(globalThis) } = {}) {
  const root = String(baseUrl || '').trim().replace(/\/+$/, '');
  const configured = /^https?:\/\//i.test(root) && typeof fetchImpl === 'function';

  async function request(path, { method = 'GET', body = undefined, timeout = DEFAULT_TIMEOUT } = {}) {
    if (!configured) {
      throw new ApiError('Magic-link sign-in is not configured for this deployment.', { code: 'not_configured' });
    }

    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeout) : null;

    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    let response;
    try {
      response = await fetchImpl(`${root}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller?.signal,
        credentials: 'include',
        mode: 'cors',
        cache: 'no-store'
      });
    } catch (error) {
      const aborted = error?.name === 'AbortError';
      throw new ApiError(aborted ? 'The sign-in service timed out.' : 'Could not reach the sign-in service.', {
        code: aborted ? 'timeout' : 'network_error',
        cause: error
      });
    } finally {
      if (timer) clearTimeout(timer);
    }

    const text = await response.text().catch(() => '');
    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = null;
      }
    }

    if (!response.ok) {
      const message = payload?.message || payload?.error?.message || `Sign-in failed (${response.status}).`;
      throw new ApiError(message, {
        status: response.status,
        code: payload?.code || payload?.error?.code || `http_${response.status}`
      });
    }

    return { payload, headers: response.headers };
  }

  return {
    get configured() {
      return configured;
    },
    baseUrl: root,

    /**
     * Ask Neon Auth to email a time-limited sign-in link.
     * @param {{email:string, callbackUrl?:string, newUserCallbackUrl?:string, errorCallbackUrl?:string}} options
     */
    async sendMagicLink({ email, callbackUrl, newUserCallbackUrl, errorCallbackUrl }) {
      const body = { email };
      if (callbackUrl) body.callbackURL = callbackUrl;
      if (newUserCallbackUrl) body.newUserCallbackURL = newUserCallbackUrl;
      if (errorCallbackUrl) body.errorCallbackURL = errorCallbackUrl;
      await request('/sign-in/magic-link', { method: 'POST', body, timeout: MAGIC_LINK_TIMEOUT });
      return { email };
    },

    /**
     * Read the current session from the auth cookie.
     * @returns {Promise<{session:object, user:object, jwt:string|null}|null>}
     */
    async getSession() {
      const { payload, headers } = await request('/get-session');
      const data = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
      const session = data?.session;
      const user = data?.user;
      if (!session || !user) return null;
      const jwt = headers?.get?.('set-auth-jwt') || null;
      return { session, user, jwt };
    },

    /**
     * Mint (or reuse) a short-lived access token for the Worker API.
     * @returns {Promise<string|null>}
     */
    async getToken() {
      try {
        const { payload } = await request('/token');
        const token = payload?.token || payload?.data?.token || null;
        return typeof token === 'string' && token ? token : null;
      } catch (error) {
        if (error instanceof ApiError && error.isUnauthorized) return null;
        throw error;
      }
    },

    /** End the session on the auth service. */
    async signOut() {
      try {
        await request('/sign-out', { method: 'POST', body: {} });
      } catch (error) {
        if (!(error instanceof ApiError) || (!error.isNetwork && error.status !== 401)) throw error;
      }
    }
  };
}
