/**
 * Hash-based router.
 *
 * Hash routing is used deliberately: the app must work when opened directly
 * from the filesystem (`file://`) or from any static host without server-side
 * rewrite rules.
 */

export class Router {
  /**
   * @param {{fallback?: string, onBeforeNavigate?: Function, onNavigate: Function}} options
   */
  constructor({ fallback = '/dashboard', onNavigate, onBeforeNavigate } = {}) {
    this.routes = [];
    this.fallback = fallback;
    this.onNavigate = onNavigate;
    this.onBeforeNavigate = onBeforeNavigate;
    this.currentRoute = null;
    this.started = false;
    this._onHashChange = () => this.resolve();
  }

  /** `path` may contain `:param` segments, e.g. `/transactions/:id`. */
  register(path, handler, meta = {}) {
    const segments = path.split('/').filter(Boolean);
    this.routes.push({
      path,
      segments,
      handler,
      meta,
      params: segments.filter((s) => s.startsWith(':')).map((s) => s.slice(1))
    });
    return this;
  }

  /** @returns {{route:object, params:object}|null} */
  match(segments) {
    for (const route of this.routes) {
      if (route.segments.length !== segments.length) continue;
      const params = {};
      let matched = true;
      for (let i = 0; i < route.segments.length; i += 1) {
        const expected = route.segments[i];
        const actual = segments[i];
        if (expected.startsWith(':')) params[expected.slice(1)] = decodeURIComponent(actual);
        else if (expected !== actual) {
          matched = false;
          break;
        }
      }
      if (matched) return { route, params };
    }
    return null;
  }

  static parse(href = location.hash) {
    const raw = String(href || '').replace(/^#/, '');
    const [pathPart, queryPart] = raw.split('?');
    const segments = pathPart.split('/').filter(Boolean);
    return { path: `/${segments.join('/')}`, segments, query: new URLSearchParams(queryPart || '') };
  }

  static href(path, query = null) {
    const clean = `/${String(path || '').split('/').filter(Boolean).join('/')}`;
    if (!query) return `#${clean}`;
    const search = query instanceof URLSearchParams ? query.toString() : new URLSearchParams(query).toString();
    return `#${clean}${search ? `?${search}` : ''}`;
  }

  start() {
    if (this.started) return;
    this.started = true;
    window.addEventListener('hashchange', this._onHashChange);
    this.resolve();
  }

  stop() {
    window.removeEventListener('hashchange', this._onHashChange);
    this.started = false;
  }

  /** Re-runs the handler for the current location (used after data changes). */
  reload() {
    this.resolve({ silent: true });
  }

  resolve({ silent = false } = {}) {
    const { path, segments, query } = Router.parse();
    const matched = this.match(segments);

    if (!matched) {
      if (path !== this.fallback && !silent) {
        this.navigate(this.fallback, { replace: true });
        return;
      }
      this.notify({ path: this.fallback, segments: this.fallback.split('/').filter(Boolean), query, params: {}, meta: {}, unknown: true });
      return;
    }

    this.notify({ ...matched, meta: matched.route?.meta || {}, path, segments, query, params: matched.params, unknown: false });
  }

  notify(context) {
    this.currentRoute = context;
    this.onBeforeNavigate?.(context);
    this.onNavigate?.(context);
  }

  navigate(path, { replace = false } = {}) {
    const target = path.startsWith('#') ? path : Router.href(path);
    if (replace) {
      const url = `${location.pathname}${location.search}${target}`;
      history.replaceState(null, '', url);
      this.resolve();
    } else if (location.hash === target) {
      this.resolve();
    } else {
      location.hash = target;
    }
  }

  /** Updates the query string of the current route without a full remount. */
  updateQuery(patch, { replace = true } = {}) {
    const { query } = Router.parse();
    for (const [key, value] of Object.entries(patch)) {
      if (value === null || value === undefined || value === '') query.delete(key);
      else query.set(key, String(value));
    }
    const { path } = Router.parse();
    const target = Router.href(path, query);
    if (replace) {
      history.replaceState(null, '', `${location.pathname}${location.search}${target}`);
    } else {
      location.hash = target;
      return;
    }
  }

  get isAtRoot() {
    return (location.hash || '').replace(/^#/, '') === '' || Router.parse().segments.length === 0;
  }
}
