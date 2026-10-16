/**
 * Authentication façade for SpendWise.
 *
 * Two providers can back the same cloud account:
 *
 *   1. `password` — the Worker's own email + password accounts. The session is
 *      a signed token issued by the Worker and stored in localStorage.
 *   2. `neon`     — Managed Better Auth (Neon Auth), signed in with an email
 *      magic link. The session lives in an HTTP-only cookie on the Neon Auth
 *      service; this module keeps only the public profile and mints a short
 *      lived JWT on demand for Worker API calls.
 *
 * Both funnel into the same `getToken()` so the rest of the app does not care
 * which provider is in use. Tenant isolation is still enforced server-side by
 * `user_id`; nothing here claims client-side encryption or device security.
 */

import { appConfig } from '../config/appConfig.js';
import { ApiError } from './apiClient.js';
import { bus, EVENTS } from '../core/eventBus.js';

const MIN_PASSWORD = 8;
/** Refresh a Neon Auth JWT when it is within this many seconds of expiry. */
const JWT_REFRESH_SKEW_SECONDS = 60;

/** Validate just an email address (shared by every flow). */
export function normalizeEmailInput(email) {
  const errors = {};
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(normalizedEmail)) errors.email = 'Enter a valid email address.';
  if (normalizedEmail.length > 254) errors.email = 'That email address is too long.';
  return { ok: Object.keys(errors).length === 0, errors, email: normalizedEmail };
}

export function validateCredentials({ email, password, name = '', mode = 'login' }) {
  const errors = {};
  const { email: normalizedEmail } = normalizeEmailInput(email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(normalizedEmail)) errors.email = 'Enter a valid email address.';
  if (normalizedEmail.length > 254) errors.email = 'That email address is too long.';
  const pwd = String(password || '');
  if (pwd.length < MIN_PASSWORD) errors.password = `Passwords must be at least ${MIN_PASSWORD} characters.`;
  if (pwd.length > 200) errors.password = 'Passwords must be at most 200 characters.';
  if (pwd.trim().length === 0) errors.password = 'The password cannot be blank.';
  if (mode === 'register' && pwd && !/[A-Za-z]/.test(pwd)) errors.password = 'Include at least one letter in your password.';
  return { ok: Object.keys(errors).length === 0, errors, email: normalizedEmail, password: pwd, name: String(name || '').trim().slice(0, 120) };
}

/**
 * Read `exp` (epoch seconds) from a JWT without verifying it. Only used to
 * decide when to refresh; the Worker is what actually verifies the signature.
 * @returns {number} seconds, or 0 when unreadable
 */
export function readJwtExpiry(token) {
  try {
    const segment = String(token).split('.')[1];
    if (!segment) return 0;
    const padded = segment.length % 4 === 0 ? segment : segment + '='.repeat(4 - (segment.length % 4));
    const json = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
    const payload = JSON.parse(json);
    return typeof payload?.exp === 'number' && Number.isFinite(payload.exp) ? payload.exp : 0;
  } catch {
    return 0;
  }
}

export function createAuthService({ client, neon = null, storage = globalThis.localStorage } = {}) {
  let session = readSession();
  let neonToken = null; // cached Neon Auth JWT (never persisted: it is short-lived)
  let neonTokenExpiry = 0;
  const listeners = new Set();

  function readSession() {
    try {
      const raw = storage.getItem(appConfig.storage.session);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      const provider = parsed?.provider === 'neon' ? 'neon' : 'password';
      if (provider === 'password' && !parsed?.token) return null;
      if (provider === 'neon' && !parsed?.user) return null;
      return { provider, token: String(parsed.token || ''), user: parsed.user || null, savedAt: parsed.savedAt || null };
    } catch {
      return null;
    }
  }

  function persist() {
    try {
      if (session) storage.setItem(appConfig.storage.session, JSON.stringify(session));
      else storage.removeItem(appConfig.storage.session);
    } catch {
      /* a locked-down browser simply means the session does not survive reload */
    }
  }

  function notify(reason) {
    for (const listener of [...listeners]) {
      try {
        listener({ user: session?.user || null, signedIn: Boolean(session), provider: session?.provider || null, reason });
      } catch (error) {
        console.error('[auth] listener failed', error);
      }
    }
    bus.emit(EVENTS.CLOUD_STATUS, { auth: Boolean(session), reason });
  }

  function setSession(next, reason) {
    session = next;
    persist();
    notify(reason);
  }

  function clearSession(reason) {
    neonToken = null;
    neonTokenExpiry = 0;
    setSession(null, reason);
  }

  /** Where Neon Auth should send the user back after the link is clicked. */
  function magicLinkCallbackUrl() {
    if (typeof window === 'undefined' || !window.location) return undefined;
    return `${window.location.origin}${window.location.pathname}`;
  }

  /** Adopt a Neon Auth session (post-magic-link, or an existing cookie). */
  function applyNeonSession(result, reason) {
    if (result?.jwt) {
      neonToken = result.jwt;
      neonTokenExpiry = readJwtExpiry(result.jwt);
    }
    setSession(
      { provider: 'neon', token: '', user: result.user || null, savedAt: new Date().toISOString() },
      reason
    );
  }

  /** Return a valid Neon Auth JWT for Worker API calls, refreshing when stale. */
  async function ensureNeonToken() {
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (neonToken && neonTokenExpiry - JWT_REFRESH_SKEW_SECONDS > nowSeconds) return neonToken;

    const token = await neon.getToken();
    if (!token) {
      // The cookie session is gone: the account really is signed out.
      clearSession('expired');
      return null;
    }
    neonToken = token;
    neonTokenExpiry = readJwtExpiry(token);
    return token;
  }

  return {
    get enabled() {
      return client?.configured !== false;
    },
    get neonEnabled() {
      return Boolean(neon?.configured);
    },
    get user() {
      return session?.user || null;
    },
    get provider() {
      return session?.provider || null;
    },
    get signedIn() {
      if (!session) return false;
      return session.provider === 'neon' ? Boolean(session.user) : Boolean(session.token);
    },
    /** True when the signed-in account holds the administrator role. */
    get isAdmin() {
      return session?.user?.role === 'admin';
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /**
     * Token for the Worker API. Returns a promise, and the API client awaits it,
     * so a short-lived Neon Auth JWT can be refreshed transparently.
     * @returns {Promise<string|null>}
     */
    async getToken() {
      if (!session) return null;
      if (session.provider === 'neon') {
        try {
          return await ensureNeonToken();
        } catch (error) {
          if (error instanceof ApiError && error.isUnauthorized) {
            clearSession('expired');
            return null;
          }
          throw error;
        }
      }
      return session.token;
    },

    /* ------------------------------------------------------- password flow */

    async register({ email, password, name }) {
      const check = validateCredentials({ email, password, name, mode: 'register' });
      if (!check.ok) throw new ApiError('Please correct the highlighted fields.', { status: 400, code: 'validation_error', details: check.errors });
      const data = await client.post('/api/auth/register', { email: check.email, password: check.password, name: check.name });
      if (!data?.token) throw new ApiError('The server did not return a session. Please try again.', { code: 'bad_response' });
      setSession({ provider: 'password', token: data.token, user: data.user || null, savedAt: new Date().toISOString() }, 'register');
      return session.user;
    },

    async login({ email, password }) {
      const check = validateCredentials({ email, password, mode: 'login' });
      if (!check.ok) throw new ApiError('Please correct the highlighted fields.', { status: 400, code: 'validation_error', details: check.errors });
      const data = await client.post('/api/auth/login', { email: check.email, password: check.password });
      if (!data?.token) throw new ApiError('The server did not return a session. Please try again.', { code: 'bad_response' });
      setSession({ provider: 'password', token: data.token, user: data.user || null, savedAt: new Date().toISOString() }, 'login');
      return session.user;
    },

    /* ----------------------------------------------------- magic-link flow */

    /**
     * Email a passwordless sign-in link through Neon Auth.
     * The user lands back on this app, where `adoptNeonSession()` finishes the
     * sign-in (the auth service sets the session cookie during verification).
     * @returns {Promise<string>} the normalized email address
     */
    async sendMagicLink({ email } = {}) {
      if (!neon?.configured) {
        throw new ApiError('Magic-link sign-in is not configured for this deployment.', { code: 'not_configured' });
      }
      const check = normalizeEmailInput(email);
      if (!check.ok) {
        throw new ApiError('Enter a valid email address.', { status: 400, code: 'validation_error', details: check.errors });
      }
      const callbackUrl = magicLinkCallbackUrl();
      await neon.sendMagicLink({ email: check.email, callbackUrl, newUserCallbackUrl: callbackUrl, errorCallbackUrl: callbackUrl });
      return check.email;
    },

    /**
     * Pick up a Neon Auth session that already exists (e.g. right after the
     * user clicked the emailed link). Safe to call on every start.
     * @returns {Promise<{adopted:boolean, error:string|null}>}
     */
    async adoptNeonSession({ force = false } = {}) {
      if (!neon?.configured) return { adopted: false, error: null };
      if (this.signedIn && session?.provider !== 'neon' && !force) return { adopted: false, error: null };
      try {
        const result = await neon.getSession();
        if (!result) {
          if (session?.provider === 'neon') clearSession('expired');
          return { adopted: false, error: null };
        }
        const changed = !session || session.provider !== 'neon' || session.user?.id !== result.user?.id;
        applyNeonSession(result, 'neon-session');
        return { adopted: changed, error: null };
      } catch (error) {
        // Offline or the auth service is down: keep any existing session.
        return { adopted: false, error: error instanceof ApiError && error.isNetwork ? null : error?.message || 'Sign-in could not be completed.' };
      }
    },

    /** Read a `?error=` code that the magic-link verification may have appended. */
    readMagicLinkError(search = typeof window !== 'undefined' ? window.location.search : '') {
      try {
        const code = new URLSearchParams(String(search || '')).get('error');
        if (!code) return null;
        if (code === 'INVALID_TOKEN') return 'That sign-in link has expired or was already used. Request a new one.';
        return 'That sign-in link could not be verified. Request a new one.';
      } catch {
        return null;
      }
    },

    /** Server-side token revocation is a no-op for stateless tokens, so this is best-effort. */
    async logout() {
      if (session?.provider === 'neon') {
        try {
          await neon.signOut();
        } catch {
          /* signing out locally must always succeed */
        }
        clearSession('logout');
        return;
      }
      try {
        if (session?.token) await client.post('/api/auth/logout', {});
      } catch {
        /* signing out locally must always succeed */
      }
      clearSession('logout');
    },

    /** Verifies the stored session and refreshes the cached profile. */
    async refresh() {
      if (!session) return null;
      if (session.provider === 'neon') {
        try {
          const result = await neon.getSession();
          if (!result) {
            clearSession('expired');
            return null;
          }
          applyNeonSession(result, 'refresh');
          return session.user;
        } catch (error) {
          if (error instanceof ApiError && error.isNetwork) return session.user; // offline: keep the cached profile
          throw error;
        }
      }

      if (!session.token) return null;
      try {
        const user = await client.verifyToken();
        if (!user) {
          clearSession('expired');
          return null;
        }
        session = { ...session, user };
        persist();
        notify('refresh');
        return user;
      } catch (error) {
        if (error instanceof ApiError && error.isNetwork) return session.user; // offline: keep the cached profile
        throw error;
      }
    },

    /** Used by the API client when any request returns 401. */
    handleUnauthorized() {
      if (!session) return;
      if (session.provider === 'neon') {
        // The access token may simply have expired; `getToken()` re-mints it on
        // the next request and clears the session if the cookie is gone too.
        neonToken = null;
        neonTokenExpiry = 0;
        notify('unauthorized');
        return;
      }
      clearSession('unauthorized');
    }
  };
}
