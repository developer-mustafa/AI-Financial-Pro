/**
 * i18n layer. The English dictionary is the source of truth; every other
 * language must at least expose the same keys (missing keys fall back to
 * English, but shipping a partial dictionary silently is how translations rot).
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  t,
  setLanguage,
  getLanguage,
  normalizeLanguage,
  rangeLabel,
  onLanguageChange,
  LANGUAGES,
  translationKeys,
  missingKeys
} from '../src/i18n/index.js';

afterEach(() => setLanguage('en'));

describe('dictionaries', () => {
  it('offers English and Bengali', () => {
    expect(LANGUAGES.map((l) => l.value)).toEqual(['en', 'bn']);
  });

  it('has no Bengali keys missing from the English source', () => {
    expect(missingKeys('bn')).toEqual([]);
  });

  it('exposes a non-trivial number of keys', () => {
    expect(translationKeys().length).toBeGreaterThan(150);
  });
});

describe('t', () => {
  it('defaults to English', () => {
    expect(getLanguage()).toBe('en');
    expect(t('settings.language')).toBe('Language');
  });

  it('falls back to the key when unknown', () => {
    expect(t('does.not.exist')).toBe('does.not.exist');
  });

  it('interpolates {placeholders}', () => {
    expect(t('topbar.due', { name: 'Rent' })).toBe('Due: Rent');
  });

  it('leaves unknown placeholders untouched', () => {
    expect(t('topbar.due', {})).toBe('Due: {name}');
  });
});

describe('setLanguage', () => {
  it('switches the active dictionary and <html lang>', () => {
    setLanguage('bn');
    expect(getLanguage()).toBe('bn');
    expect(t('settings.language')).toBe('ভাষা');
    expect(document.documentElement.getAttribute('lang')).toBe('bn');
    expect(document.documentElement.dataset.lang).toBe('bn');
  });

  it('normalises region-tagged and unknown codes', () => {
    expect(normalizeLanguage('bn-BD')).toBe('bn');
    expect(normalizeLanguage('en-GB')).toBe('en');
    expect(normalizeLanguage('fr')).toBe('en');
    expect(normalizeLanguage(undefined)).toBe('en');
  });

  it('notifies subscribers once per change', () => {
    let calls = 0;
    const off = onLanguageChange(() => { calls += 1; });
    setLanguage('bn');
    setLanguage('bn'); // no-op
    setLanguage('en');
    off();
    setLanguage('bn');
    expect(calls).toBe(2);
  });
});

describe('rangeLabel', () => {
  it('translates known range ids', () => {
    expect(rangeLabel('thisMonth')).toBe('This Month');
    setLanguage('bn');
    expect(rangeLabel('thisMonth')).toBe('এই মাস');
  });
});
