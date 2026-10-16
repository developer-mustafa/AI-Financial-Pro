/**
 * Theme manager (light / dark / system).
 *
 * Single source of truth for the theme class on <html>. `index.html` contains a
 * tiny inline bootstrap that applies the saved value before first paint so
 * there is no white flash; this module takes over afterwards.
 */

import { appConfig } from '../config/appConfig.js';

const STORAGE_KEY = appConfig.storage.theme;

export function readStoredTheme() {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (value === 'light' || value === 'dark' || value === 'system') return value;
  } catch {
    /* ignore */
  }
  return 'system';
}

export function systemPrefersDark() {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    return false;
  }
}

export function resolveTheme(mode = readStoredTheme()) {
  return mode === 'system' ? (systemPrefersDark() ? 'dark' : 'light') : mode;
}

/** Applies the resolved theme to <html>. Also used by the inline bootstrap. */
export function applyThemeClass(resolved) {
  const root = document.documentElement;
  root.classList.toggle('dark', resolved === 'dark');
  root.dataset.theme = resolved;
  root.style.colorScheme = resolved;
}

export function createThemeManager({ onChange } = {}) {
  let mode = readStoredTheme();
  let mediaQuery = null;

  const handleSystemChange = () => {
    if (mode !== 'system') return;
    const resolved = resolveTheme('system');
    applyThemeClass(resolved);
    onChange?.({ mode, resolved, source: 'system' });
  };

  if (typeof window.matchMedia === 'function') {
    mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    if (typeof mediaQuery.addEventListener === 'function') mediaQuery.addEventListener('change', handleSystemChange);
    else mediaQuery.addListener?.(handleSystemChange);
  }

  return {
    get mode() {
      return mode;
    },
    get resolved() {
      return resolveTheme(mode);
    },
    init() {
      mode = readStoredTheme();
      applyThemeClass(resolveTheme(mode));
      onChange?.({ mode, resolved: resolveTheme(mode), source: 'init' });
    },
    set(next, { persist = true } = {}) {
      mode = next === 'light' || next === 'dark' ? next : 'system';
      if (persist) {
        try {
          localStorage.setItem(STORAGE_KEY, mode);
        } catch {
          /* private mode: theme simply will not persist */
        }
      }
      applyThemeClass(resolveTheme(mode));
      onChange?.({ mode, resolved: resolveTheme(mode), source: 'user' });
      return mode;
    },
    toggle() {
      // Toggling from "system" switches to the opposite of what is displayed.
      const next = resolveTheme(mode) === 'dark' ? 'light' : 'dark';
      return this.set(next);
    },
    destroy() {
      if (!mediaQuery) return;
      if (typeof mediaQuery.removeEventListener === 'function') mediaQuery.removeEventListener('change', handleSystemChange);
      else mediaQuery.removeListener?.(handleSystemChange);
    }
  };
}
