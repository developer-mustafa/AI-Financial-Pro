/**
 * Tiny i18n layer for SpendWise.
 *
 * Deliberately dependency-free and synchronous, matching the rest of the app:
 *
 *   import { t, setLanguage, getLanguage, rangeLabel } from '../../i18n/index.js';
 *
 *  - `t(key, params)` looks the key up in the active dictionary, then falls back
 *    to English, then to the key itself. Placeholders use `{name}`.
 *  - The active language defaults to English and is driven by the
 *    `preferences.language` value (set in app.js and updated from Settings).
 *  - Missing translations are therefore always safe: they render in English.
 */

import en from './en.js';
import bn from './bn.js';

const DICTS = { en, bn };

/** Languages offered in Settings → Appearance. */
export const LANGUAGES = [
  { value: 'en', labelKey: 'language.en' },
  { value: 'bn', labelKey: 'language.bn' }
];

const listeners = new Set();
let current = 'en';

/** The active language code ('en' | 'bn'). */
export function getLanguage() {
  return current;
}

/** Normalise an arbitrary value to a supported language code. */
export function normalizeLanguage(value) {
  const code = String(value || '').toLowerCase();
  if (DICTS[code]) return code;
  // Accept region-tagged codes such as `bn-BD` / `en-GB`.
  const base = code.split('-')[0];
  return DICTS[base] ? base : 'en';
}

/**
 * Switch the active language. No-op when unchanged. Keeps `<html lang>` in sync
 * and notifies subscribers.
 */
export function setLanguage(language) {
  const next = normalizeLanguage(language);
  if (next === current) return current;
  current = next;
  if (typeof document !== 'undefined' && document.documentElement) {
    document.documentElement.setAttribute('lang', current === 'bn' ? 'bn' : 'en');
    document.documentElement.setAttribute('data-lang', current);
  }
  for (const listener of [...listeners]) {
    try {
      listener(current);
    } catch (error) {
      console.error('[i18n] listener failed', error);
    }
  }
  return current;
}

/** Subscribe to language changes. @returns {() => void} unsubscribe */
export function onLanguageChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Translate a key.
 * @param {string} key
 * @param {Record<string, unknown>} [params]
 */
export function t(key, params) {
  const dict = DICTS[current] || en;
  let value = dict[key];
  if (value == null) value = en[key];
  if (value == null) return key;
  if (params) {
    value = value.replace(/\{(\w+)\}/g, (match, name) =>
      Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match
    );
  }
  return value;
}

/** Human label for a dashboard/report date-range preset id. */
export function rangeLabel(id) {
  return t(`range.${id}`);
}

/** Exposed for tests: every known key. */
export function translationKeys() {
  return Object.keys(en);
}

/** Exposed for tests: keys missing from a dictionary. */
export function missingKeys(lang = 'en') {
  const dict = DICTS[lang] || {};
  return Object.keys(en).filter((key) => dict[key] == null);
}
