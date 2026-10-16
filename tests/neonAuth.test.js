/**
 * Magic-link (Managed Better Auth) sign-in.
 *
 * Covers the two new pieces:
 *   - `neonAuthService` — the REST client for Neon Auth,
 *   - `authService`     — dual-provider session handling (password + neon),
 * plus the API client's ability to await an asynchronously refreshed token.
 *
 * Everything runs against a scripted `fetch`; no network and no real auth
 * service are involved.
 */

import { describe, it, expect, vi } from 'vitest';

import { createNeonAuthClient } from '../src/services/neonAuthService.js';
import { createAuthService, readJwtExpiry, normalizeEmailInput } from '../src/services/authService.js';
import { createApiClient, ApiError } from '../src/services/apiClient.js';
import { mount as mountSettings } from '../src/modules/settings/settingsView.js';
import { memoryStorage, makeStore } from './helpers.js';

const AUTH_BASE = 'https://ep-test.neonauth.example.neon.tech/db/auth';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function base64Url(value) {
  const json = JSON.stringify(value);
  const b64 = typeof btoa === 'function' ? btoa(json) : Buffer.from(json, 'utf8').toString('base64');
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A JWT-shaped string; only its `exp` claim is ever read on this side. */
function fakeJwt({ exp = Math.floor(Date.now() / 1000) + 900, sub = 'user-1' } = {}) {
  return `${base64Url({ alg: 'EdDSA', typ: 'JWT' })}.${base64Url({ sub, exp })}.signature`;
}

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  const map = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => (map.has(String(name).toLowerCase()) ? map.get(String(name).toLowerCase()) : null) },
    async text() {
      return body === undefined ? '' : JSON.stringify(body);
    },
    async json() {
      return body === undefined ? null : JSON.parse(JSON.stringify(body));
    }
  };
}

/** Record every call and reply from a path table. */
function scriptedFetch(routes) {
  const calls = [];
  const impl = async (url, options = {}) => {
    const path = new URL(url).pathname.replace(/^\/db\/auth/, '');
    calls.push({ url, path, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null, options });
    const route = routes[path];
    if (!route) throw new Error(`unexpected request: ${path}`);
    return typeof route === 'function' ? route({ url, options, path, call: calls.length }) : route;
  };
  impl.calls = calls;
  return impl;
}

const neonUser = { id: '11111111-2222-4333-8444-555555555555', email: 'person@example.com', name: 'Test Person' };

function makeNeonClient(routes) {
  const fetchImpl = scriptedFetch(routes);
  return { client: createNeonAuthClient({ baseUrl: AUTH_BASE, fetchImpl }), fetchImpl };
}

function makeService(neon, { storage = memoryStorage(), client } = {}) {
  const apiClient = client || createApiClient({ baseUrl: 'https://api.example', getToken: () => null, fetchImpl: async () => jsonResponse({}) });
  const auth = createAuthService({ client: apiClient, neon, storage });
  return { auth, storage };
}

// ---------------------------------------------------------------------------
// neonAuthService
// ---------------------------------------------------------------------------

describe('neonAuthService', () => {
  it('is inert without a base URL', async () => {
    const client = createNeonAuthClient({ baseUrl: '' });
    expect(client.configured).toBe(false);
    await expect(client.getSession()).rejects.toMatchObject({ code: 'not_configured' });
  });

  it('sends a magic link with the callback and cookies enabled', async () => {
    const { client, fetchImpl } = makeNeonClient({ '/sign-in/magic-link': jsonResponse({ status: true }) });
    await client.sendMagicLink({ email: 'person@example.com', callbackUrl: 'https://app.example/', errorCallbackUrl: 'https://app.example/' });

    const call = fetchImpl.calls[0];
    expect(call.path).toBe('/sign-in/magic-link');
    expect(call.method).toBe('POST');
    expect(call.body).toEqual({
      email: 'person@example.com',
      callbackURL: 'https://app.example/',
      errorCallbackURL: 'https://app.example/'
    });
    expect(call.options.credentials).toBe('include');
  });

  it('reads the session and the set-auth-jwt header', async () => {
    const jwt = fakeJwt();
    const { client } = makeNeonClient({
      '/get-session': jsonResponse({ session: { id: 's1' }, user: neonUser }, { headers: { 'set-auth-jwt': jwt } })
    });
    const result = await client.getSession();
    expect(result.user).toEqual(neonUser);
    expect(result.jwt).toBe(jwt);
  });

  it('treats an empty session as signed out', async () => {
    const { client } = makeNeonClient({ '/get-session': jsonResponse(null) });
    expect(await client.getSession()).toBeNull();

    const { client: nested } = makeNeonClient({ '/get-session': jsonResponse({ session: null, user: null }) });
    expect(await nested.getSession()).toBeNull();
  });

  it('mints a token and returns null when the session is gone', async () => {
    const { client } = makeNeonClient({ '/token': jsonResponse({ token: 'jwt-value' }) });
    expect(await client.getToken()).toBe('jwt-value');

    const { client: unauthorized } = makeNeonClient({ '/token': jsonResponse({ message: 'Unauthorized' }, { status: 401 }) });
    expect(await unauthorized.getToken()).toBeNull();
  });

  it('surfaces service errors as ApiError with the server message', async () => {
    const { client } = makeNeonClient({ '/sign-in/magic-link': jsonResponse({ message: 'Too many requests' }, { status: 429 }) });
    await expect(client.sendMagicLink({ email: 'a@b.co' })).rejects.toThrowError('Too many requests');
    await expect(client.sendMagicLink({ email: 'a@b.co' })).rejects.toMatchObject({ status: 429 });
  });
});

// ---------------------------------------------------------------------------
// authService — magic link
// ---------------------------------------------------------------------------

describe('authService magic-link flow', () => {
  it('validates the email before calling the service', async () => {
    const { client, fetchImpl } = makeNeonClient({});
    const { auth } = makeService(client);
    await expect(auth.sendMagicLink({ email: 'not-an-email' })).rejects.toMatchObject({ code: 'validation_error' });
    expect(fetchImpl.calls).toHaveLength(0);
  });

  it('emails a link and adopts the resulting session', async () => {
    const { client, fetchImpl } = makeNeonClient({
      '/sign-in/magic-link': jsonResponse({ status: true }),
      '/get-session': jsonResponse({ session: { id: 's1' }, user: neonUser }, { headers: { 'set-auth-jwt': fakeJwt() } })
    });
    const { auth, storage } = makeService(client);

    expect(auth.neonEnabled).toBe(true);
    expect(auth.signedIn).toBe(false);

    await auth.sendMagicLink({ email: ' Person@Example.com ' });
    expect(fetchImpl.calls[0].body.email).toBe('person@example.com');
    expect(fetchImpl.calls[0].body.callbackURL).toContain('http://localhost');

    const { adopted } = await auth.adoptNeonSession();
    expect(adopted).toBe(true);
    expect(auth.signedIn).toBe(true);
    expect(auth.provider).toBe('neon');
    expect(auth.user).toEqual(neonUser);
    expect(JSON.parse(storage.getItem('spendwise.session.v1')).provider).toBe('neon');
  });

  it('reports no session without signing anyone out when the auth service is empty', async () => {
    const { client } = makeNeonClient({ '/get-session': jsonResponse(null) });
    const { auth } = makeService(client);
    const result = await auth.adoptNeonSession();
    expect(result).toEqual({ adopted: false, error: null });
    expect(auth.signedIn).toBe(false);
  });

  it('is a no-op when Neon Auth is not configured', async () => {
    const { auth } = makeService({ configured: false });
    expect(auth.neonEnabled).toBe(false);
    expect(await auth.adoptNeonSession()).toEqual({ adopted: false, error: null });
    await expect(auth.sendMagicLink({ email: 'a@b.co' })).rejects.toMatchObject({ code: 'not_configured' });
  });

  it('keeps an existing password session when adoption is skipped', async () => {
    const { client, fetchImpl } = makeNeonClient({
      '/api/auth/login': jsonResponse({ token: 'app-token', user: { id: 'u1', email: 'a@b.co' } }),
      '/get-session': jsonResponse({ session: { id: 's1' }, user: neonUser })
    });
    const apiClient = createApiClient({ baseUrl: 'https://api.example', fetchImpl: (url, options) => scriptedFetch({ '/api/auth/login': jsonResponse({ token: 'app-token', user: { id: 'u1', email: 'a@b.co' } }) })(url, options) });
    const { auth } = makeService(client, { client: apiClient });

    await auth.login({ email: 'a@b.co', password: 'password123' });
    expect(auth.provider).toBe('password');

    const result = await auth.adoptNeonSession();
    expect(result.adopted).toBe(false);
    expect(auth.provider).toBe('password');
    expect(fetchImpl.calls.some((c) => c.path === '/get-session')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// authService — token lifecycle
// ---------------------------------------------------------------------------

describe('authService token handling', () => {
  it('returns the password token unchanged', async () => {
    const login = jsonResponse({ token: 'app-token', user: { id: 'u1', email: 'a@b.co' } });
    const apiClient = createApiClient({ baseUrl: 'https://api.example', fetchImpl: async () => login });
    const { auth } = makeService({ configured: false }, { client: apiClient });

    await auth.login({ email: 'a@b.co', password: 'password123' });
    expect(await auth.getToken()).toBe('app-token');
  });

  it('mints a Neon JWT once and reuses it while it is valid', async () => {
    const jwt = fakeJwt();
    const { client, fetchImpl } = makeNeonClient({
      '/get-session': jsonResponse({ session: { id: 's1' }, user: neonUser }),
      '/token': jsonResponse({ token: jwt })
    });
    const { auth } = makeService(client);
    await auth.adoptNeonSession();

    expect(await auth.getToken()).toBe(jwt);
    expect(await auth.getToken()).toBe(jwt);
    expect(fetchImpl.calls.filter((c) => c.path === '/token')).toHaveLength(1);
  });

  it('re-mints an almost-expired token', async () => {
    const stale = fakeJwt({ exp: Math.floor(Date.now() / 1000) + 10 }); // inside the 60s skew
    const fresh = fakeJwt();
    let minted = 0;
    const { client, fetchImpl } = makeNeonClient({
      '/get-session': jsonResponse({ session: { id: 's1' }, user: neonUser }),
      '/token': () => jsonResponse({ token: minted++ === 0 ? stale : fresh })
    });
    const { auth } = makeService(client);
    await auth.adoptNeonSession();

    expect(await auth.getToken()).toBe(stale);
    expect(await auth.getToken()).toBe(fresh);
    expect(fetchImpl.calls.filter((c) => c.path === '/token')).toHaveLength(2);
  });

  it('clears the session when the token can no longer be minted', async () => {
    const { client } = makeNeonClient({
      '/get-session': jsonResponse({ session: { id: 's1' }, user: neonUser }),
      '/token': jsonResponse({ message: 'Unauthorized' }, { status: 401 })
    });
    const { auth } = makeService(client);
    await auth.adoptNeonSession();

    expect(await auth.getToken()).toBeNull();
    expect(auth.signedIn).toBe(false);
  });

  it('drops the cached JWT on a 401 from our own API but keeps the session', async () => {
    const first = fakeJwt();
    const second = fakeJwt();
    let minted = 0;
    const { client, fetchImpl } = makeNeonClient({
      '/get-session': jsonResponse({ session: { id: 's1' }, user: neonUser }),
      '/token': () => jsonResponse({ token: minted++ === 0 ? first : second })
    });
    const { auth } = makeService(client);
    await auth.adoptNeonSession();

    expect(await auth.getToken()).toBe(first);
    auth.handleUnauthorized();
    expect(auth.signedIn).toBe(true);
    expect(await auth.getToken()).toBe(second);
    expect(fetchImpl.calls.filter((c) => c.path === '/token')).toHaveLength(2);
  });

  it('signs out through the auth service', async () => {
    const { client, fetchImpl } = makeNeonClient({
      '/get-session': jsonResponse({ session: { id: 's1' }, user: neonUser }),
      '/sign-out': jsonResponse({ success: true })
    });
    const { auth, storage } = makeService(client);
    await auth.adoptNeonSession();

    await auth.logout();
    expect(fetchImpl.calls.some((c) => c.path === '/sign-out')).toBe(true);
    expect(auth.signedIn).toBe(false);
    expect(storage.getItem('spendwise.session.v1')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// authService — misc
// ---------------------------------------------------------------------------

describe('authService helpers', () => {
  it('reads jwt expiry tolerant of junk', () => {
    const exp = Math.floor(Date.now() / 1000) + 900;
    expect(readJwtExpiry(fakeJwt({ exp }))).toBe(exp);
    expect(readJwtExpiry('nonsense')).toBe(0);
    expect(readJwtExpiry('')).toBe(0);
    expect(readJwtExpiry(null)).toBe(0);
  });

  it('normalises email input', () => {
    expect(normalizeEmailInput(' Person@Example.com ')).toMatchObject({ ok: true, email: 'person@example.com' });
    expect(normalizeEmailInput('nope').ok).toBe(false);
    expect(normalizeEmailInput(`${'a'.repeat(250)}@b.co`).ok).toBe(false);
  });

  it('explains magic-link errors returned in the query string', () => {
    const { auth } = makeService({ configured: false });
    expect(auth.readMagicLinkError('?error=INVALID_TOKEN')).toMatch(/expired or was already used/);
    expect(auth.readMagicLinkError('?error=ANYTHING')).toMatch(/could not be verified/);
    expect(auth.readMagicLinkError('')).toBeNull();
    expect(auth.readMagicLinkError('?token=abc')).toBeNull();
  });

  it('notifies subscribers of the provider', async () => {
    const { client } = makeNeonClient({ '/get-session': jsonResponse({ session: { id: 's1' }, user: neonUser }) });
    const { auth } = makeService(client);
    const seen = [];
    const off = auth.subscribe((event) => seen.push(event));

    await auth.adoptNeonSession();
    off();
    await auth.logout();

    expect(seen[0]).toMatchObject({ signedIn: true, provider: 'neon' });
    expect(seen).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// apiClient integration
// ---------------------------------------------------------------------------
describe('apiClient with an async token source', () => {
  it('awaits getToken and sends the bearer header', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true }));
    const client = createApiClient({ baseUrl: 'https://api.example', getToken: async () => 'jwt-from-neon', fetchImpl });

    await client.get('/api/state');
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe('Bearer jwt-from-neon');
  });

  it('omits the header when there is no token', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true }));
    const client = createApiClient({ baseUrl: 'https://api.example', getToken: async () => null, fetchImpl });

    await client.get('/api/state');
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBeUndefined();
  });

  it('surfaces a rejected token source as a network-style failure', async () => {
    const client = createApiClient({
      baseUrl: 'https://api.example',
      getToken: async () => {
        throw new ApiError('auth service down', { code: 'network_error' });
      },
      fetchImpl: async () => jsonResponse({ ok: true })
    });
    await expect(client.get('/api/state')).rejects.toThrowError('auth service down');
  });
});

// ---------------------------------------------------------------------------
// Settings → Cloud sync panel
// ---------------------------------------------------------------------------

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('settings cloud panel', () => {
  function mount({ neonConfigured = true, auth } = {}) {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const toasts = [];
    const toast = {
      success: (...args) => toasts.push(['success', ...args]),
      error: (...args) => toasts.push(['error', ...args]),
      warning: (...args) => toasts.push(['warning', ...args]),
      info: () => {}
    };
    const view = mountSettings(container, {
      store: makeStore(),
      toast,
      services: {},
      uiPrefs: { get: () => false, set: () => {} },
      theme: { set: () => {}, mode: 'system' },
      router: { navigate: () => {} },
      cloud: { auth, sync: null, api: null, configured: true, neonConfigured }
    });
    return { container, toasts, view, destroy: () => { view.destroy(); container.remove(); } };
  }

  function makeAuthedService() {
    const { client, fetchImpl } = makeNeonClient({ '/sign-in/magic-link': jsonResponse({ status: true }) });
    const { auth } = makeService(client);
    return { auth, fetchImpl };
  }

  const findButton = (root, text) =>
    [...root.querySelectorAll('button')].find((b) => b.textContent.trim() === text);

  it('offers the Email link tab only when Neon Auth is configured', () => {
    const off = mount({ neonConfigured: false, auth: makeService({ configured: false }).auth });
    expect(findButton(off.container, 'Email link')).toBeUndefined();
    expect(findButton(off.container, 'Sign in')).toBeTruthy();
    off.destroy();

    const on = mount({ neonConfigured: true, auth: makeAuthedService().auth });
    expect(findButton(on.container, 'Email link')).toBeTruthy();
    on.destroy();
  });

  it('sends a link and shows the check-your-inbox step, then allows a different email', async () => {
    const { auth, fetchImpl } = makeAuthedService();
    const { container, toasts, destroy } = mount({ auth });

    findButton(container, 'Email link').click();

    const email = container.querySelector('input[type="email"]');
    expect(email).toBeTruthy();
    email.value = 'person@example.com';
    email.dispatchEvent(new Event('input', { bubbles: true }));

    const form = container.querySelector('form');
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flush();

    expect(fetchImpl.calls).toHaveLength(1);
    expect(fetchImpl.calls[0].body.email).toBe('person@example.com');
    expect(container.textContent).toMatch(/Sign-in link sent to person@example\.com/);
    expect(toasts.some(([kind]) => kind === 'success')).toBe(true);

    findButton(container, 'Use a different email').click();
    expect(container.querySelector('input[type="email"]')).toBeTruthy();
    destroy();
  });

  it('surfaces a service failure in the form without losing the entry', async () => {
    const { client } = makeNeonClient({ '/sign-in/magic-link': jsonResponse({ message: 'Too many requests' }, { status: 429 }) });
    const { auth } = makeService(client);
    const { container, destroy } = mount({ auth });

    findButton(container, 'Email link').click();
    const email = container.querySelector('input[type="email"]');
    email.value = 'person@example.com';
    email.dispatchEvent(new Event('input', { bubbles: true }));
    container.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flush();

    expect(container.textContent).toMatch(/Too many requests/);
    expect(container.querySelector('input[type="email"]').value).toBe('person@example.com');
    destroy();
  });

  it('shows the sign-in method for an adopted magic-link session', async () => {
    const { client } = makeNeonClient({
      '/get-session': jsonResponse({ session: { id: 's1' }, user: neonUser })
    });
    const { auth } = makeService(client);
    await auth.adoptNeonSession();

    const { container, destroy } = mount({ auth });
    expect(container.textContent).toMatch(/Email magic link/);
    expect(container.textContent).toMatch(/person@example\.com/);
    destroy();
  });
});
