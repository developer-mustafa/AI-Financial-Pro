/**
 * DOM helpers.
 *
 * This module is the ONLY place that creates markup. Everything user-supplied
 * goes through `textContent` (`text:` attribute) so the app is not exposed to
 * HTML injection. The `html:` attribute exists for trusted, locally-authored
 * strings and is never given user data.
 */

/** Creates an element: `el('div', {class:'card', text:'hi'}, [child])`. */
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  applyAttrs(node, attrs);
  appendChildren(node, children);
  return node;
}

function applyAttrs(node, attrs) {
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = String(value);
    else if (key === 'html') node.innerHTML = value; // trusted content only
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else if (key === 'value' && 'value' in node) node.value = value;
    else if (key === 'checked' || key === 'selected' || key === 'disabled' || key === 'hidden') node[key] = Boolean(value);
    else if (key === 'on' && typeof value === 'object') {
      for (const [event, handler] of Object.entries(value)) node.addEventListener(event, handler);
    } else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value === true) {
      node.setAttribute(key, '');
    } else {
      node.setAttribute(key, String(value));
    }
  }
}

function appendChildren(node, children) {
  const list = Array.isArray(children) ? children : [children];
  for (const child of list) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) appendChildren(node, child);
    else if (child instanceof Node) node.appendChild(child);
    else node.appendChild(document.createTextNode(String(child)));
  }
}

/** Document fragment from an array of nodes. */
export function frag(children = []) {
  const fragment = document.createDocumentFragment();
  appendChildren(fragment, children);
  return fragment;
}

export const qs = (selector, root = document) => root.querySelector(selector);
export const qsa = (selector, root = document) => Array.from(root.querySelectorAll(selector));

/** Removes every child (faster and safer than innerHTML = ''). */
export function clear(node) {
  if (!node) return node;
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

/** Replaces a node's content with the supplied children. */
export function render(target, children) {
  if (!target) return target;
  clear(target);
  appendChildren(target, children);
  return target;
}

export function setText(node, value) {
  if (node) node.textContent = value === null || value === undefined ? '' : String(value);
  return node;
}

export function toggle(node, force) {
  if (!node) return;
  const shouldHide = force === undefined ? node.hasAttribute('hidden') === false : !force;
  node.toggleAttribute('hidden', shouldHide);
}

/* --------------------------------------------------------------------------- *
 * Events
 * --------------------------------------------------------------------------- */

/**
 * Listener registry. Modules register listeners here and call
 * `listeners.dispose()` on unmount, guaranteeing no leaks or duplicates.
 */
export function createListenerRegistry() {
  const entries = [];
  const registry = {
    on(target, type, handler, options) {
      if (!target) return () => {};
      target.addEventListener(type, handler, options);
      entries.push(() => target.removeEventListener(type, handler, options));
      return () => registry.off(target, type, handler, options);
    },
    off(target, type, handler, options) {
      target?.removeEventListener(type, handler, options);
    },
    delegate(root, type, selector, handler, options) {
      const wrapped = (event) => {
        const match = event.target instanceof Element ? event.target.closest(selector) : null;
        if (match && root.contains(match)) handler(event, match);
      };
      return registry.on(root, type, wrapped, options);
    },
    dispose() {
      while (entries.length) {
        try {
          entries.pop()();
        } catch {
          /* already detached */
        }
      }
    },
    get size() {
      return entries.length;
    }
  };
  return registry;
}

/** Trailing-edge debounce with a `cancel()` and `flush()` handle. */
export function debounce(fn, wait = 250) {
  let timer = null;
  let lastArgs = null;
  const debounced = (...args) => {
    lastArgs = args;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      const argsCopy = lastArgs;
      lastArgs = null;
      fn(...argsCopy);
    }, wait);
  };
  debounced.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    lastArgs = null;
  };
  debounced.flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
      if (lastArgs) fn(...lastArgs);
      lastArgs = null;
    }
  };
  return debounced;
}

/** Coalesces bursts of calls into one per animation frame. */
export function rafBatch(fn) {
  let scheduled = false;
  return (...args) => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      fn(...args);
    });
  };
}

/* --------------------------------------------------------------------------- *
 * Focus management
 * --------------------------------------------------------------------------- */

const FOCUSABLE = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])', 'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])'
].join(',');

export function focusable(container) {
  return qsa(FOCUSABLE, container).filter((node) => node.offsetParent !== null || node === document.activeElement);
}

/** Traps Tab focus inside `container` while active (used by modals/drawers). */
export function createFocusTrap(container) {
  let previouslyFocused = null;
  const onKeydown = (event) => {
    if (event.key !== 'Tab') return;
    const items = focusable(container);
    if (items.length === 0) {
      event.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !container.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };
  return {
    activate() {
      previouslyFocused = document.activeElement;
      container.addEventListener('keydown', onKeydown);
      const items = focusable(container);
      (items.find((n) => n.dataset.autofocus !== undefined) || items[0])?.focus();
    },
    deactivate() {
      container.removeEventListener('keydown', onKeydown);
      if (previouslyFocused instanceof HTMLElement && document.contains(previouslyFocused)) {
        previouslyFocused.focus();
      }
      previouslyFocused = null;
    }
  };
}

/** Locks body scrolling (used while modals/drawers are open). */
export function createScrollLock() {
  let count = 0;
  let previousOverflow = '';
  let previousPadding = '';
  return {
    lock() {
      if (count === 0) {
        previousOverflow = document.body.style.overflow;
        previousPadding = document.body.style.paddingRight;
        const gap = window.innerWidth - document.documentElement.clientWidth;
        document.body.style.overflow = 'hidden';
        if (gap > 0) document.body.style.paddingRight = `${gap}px`;
      }
      count += 1;
    },
    unlock() {
      count = Math.max(0, count - 1);
      if (count === 0) {
        document.body.style.overflow = previousOverflow;
        document.body.style.paddingRight = previousPadding;
      }
    }
  };
}

/* --------------------------------------------------------------------------- *
 * Icons (lucide, vendored locally — no CDN)
 * --------------------------------------------------------------------------- */

const ICON_CACHE = new Map();
const SVG_NS = 'http://www.w3.org/2000/svg';

const toPascal = (name) =>
  String(name)
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');

/** Common aliases so older icon names keep working. */
const ICON_ALIASES = {
  'circle-plus': 'CirclePlus',
  'plus-circle': 'CirclePlus',
  'circle-ellipsis': 'CircleEllipsis',
  'more-horizontal': 'Ellipsis',
  'briefcase-business': 'BriefcaseBusiness',
  'bar-chart': 'ChartColumn',
  'pie-chart': 'ChartPie',
  'line-chart': 'ChartLine',
  'alert-triangle': 'TriangleAlert',
  'alert-circle': 'CircleAlert',
  'check-circle': 'CircleCheck',
  'x-circle': 'CircleX',
  'refresh-cw': 'RefreshCw',
  'rotate-ccw': 'RotateCcw',
  'shopping-cart': 'ShoppingCart'
};

function resolveIconNode(name) {
  const lib = globalThis.lucide;
  if (!lib) return null;
  if (ICON_CACHE.has(name)) return ICON_CACHE.get(name);
  const candidates = [ICON_ALIASES[name], toPascal(name), name].filter(Boolean);
  let found = null;
  for (const candidate of candidates) {
    const node = lib.icons?.[candidate] || lib[candidate];
    if (Array.isArray(node)) {
      found = node;
      break;
    }
  }
  ICON_CACHE.set(name, found);
  return found;
}

/**
 * Builds an inline SVG icon.
 * @param {string} name lucide kebab-case name
 * @param {string} className tailwind classes controlling the rendered size
 */
export function icon(name, className = 'h-4 w-4', attrs = {}) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  if (className) svg.setAttribute('class', className);
  for (const [key, value] of Object.entries(attrs)) svg.setAttribute(key, String(value));

  const node = resolveIconNode(name);
  if (!node) return iconPlaceholder(name, className);

  // Lucide v0.4+ defines an icon as one recursive tuple [tag, attrs, children],
  // so the child shapes live at node[2]. Older builds exposed a flat list of
  // [tag, attrs] children — both shapes are supported.
  try {
    const isNodeTuple = typeof node[0] === 'string';
    appendIconChildren(svg, isNodeTuple ? node[2] : node);
  } catch (error) {
    // A malformed icon must never take down the whole application.
    console.error('[icons] failed to render', name, error);
    return iconPlaceholder(name, className);
  }
  return svg;
}

/** Fallback node for icons missing from the bundled set. */
function iconPlaceholder(name, className) {
  const placeholder = document.createElement('i');
  placeholder.setAttribute('data-lucide', name);
  placeholder.className = className;
  return placeholder;
}

/** Appends lucide child nodes (`[tag, attrs, children]`) to `parent`. */
function appendIconChildren(parent, list) {
  for (const child of list || []) {
    if (!Array.isArray(child)) continue;
    const [tag, childAttrs = {}, grandchildren = []] = child;
    const element = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(childAttrs || {})) element.setAttribute(key, String(value));
    appendIconChildren(element, grandchildren);
    parent.appendChild(element);
  }
}

/** Renders any leftover `[data-lucide]` placeholders (safe to call often). */
export function refreshIcons(root = document) {
  const lib = globalThis.lucide;
  if (!lib?.createIcons) return;
  const pending = root.querySelectorAll?.('[data-lucide]');
  if (!pending || pending.length === 0) return;
  try {
    lib.createIcons({ attrs: { 'stroke-width': '1.8' } });
  } catch {
    /* ignore */
  }
}

/* --------------------------------------------------------------------------- *
 * Files / clipboard
 * --------------------------------------------------------------------------- */

/** Triggers a browser download and revokes the object URL afterwards. */
export function downloadFile(filename, contents, mime = 'application/octet-stream') {
  const blob = contents instanceof Blob ? contents : new Blob([contents], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const link = el('a', { href: url, download: filename, rel: 'noopener' });
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Give the browser a tick to start the download before revoking.
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return blob.size;
}

export async function copyToClipboard(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  try {
    const area = el('textarea', { value: text, style: { position: 'fixed', opacity: '0' } });
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

export function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('The file could not be read.'));
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.readAsText(file, 'utf-8');
  });
}

export function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(2)} MB`;
}

/** Parses `#/route/param` into `{path, segments, query}`. */
export function parseHash(hash = location.hash) {
  const raw = String(hash || '').replace(/^#/, '');
  const [pathPart, queryPart] = raw.split('?');
  const segments = pathPart.split('/').filter(Boolean);
  return {
    path: `/${segments.join('/')}`,
    segments,
    query: new URLSearchParams(queryPart || '')
  };
}
