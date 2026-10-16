/**
 * Language switching, end to end.
 *
 * Boots the real composition root, changes the Language select on the Settings
 * screen, and asserts the whole shell (sidebar, top bar, current screen) and the
 * persisted preference move together.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (predicate, { timeout = 2000, step = 25 } = {}) => {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (predicate()) return true;
    await wait(step);
  }
  return Boolean(predicate());
};

describe('language switching', () => {
  let app;

  beforeAll(async () => {
    const html = fs.readFileSync(path.resolve(process.cwd(), 'index.html'), 'utf8');
    const body = html.match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1] || '';
    document.body.innerHTML = body;

    window.scrollTo = () => {};
    if (!window.matchMedia) {
      window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
    }
    if (!globalThis.requestAnimationFrame) {
      globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
      globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
    }

    const lucideBundle = fs.readFileSync(path.resolve(process.cwd(), 'assets/vendor/lucide.js'), 'utf8');
    new Function(lucideBundle).call(globalThis);

    const { startApp } = await import('../src/app.js');
    app = await startApp({ mountPoint: document });

    app.router.navigate('/settings');
    await waitFor(() => document.querySelector('[data-main] select[name="language"]'));
  }, 30000);

  afterAll(() => {
    app?.destroy?.();
  });

  const languageSelect = () => document.querySelector('[data-main] select[name="language"]');

  const chooseLanguage = async (value) => {
    const select = languageSelect();
    expect(select, 'the Language select should be on the Settings screen').toBeTruthy();
    select.value = value;
    select.dispatchEvent(new window.Event('change', { bubbles: true }));
    await waitFor(() => document.documentElement.getAttribute('lang') === value);
    await wait(50);
  };

  it('offers English and Bangla in Settings → Appearance', () => {
    const select = languageSelect();
    expect(select).toBeTruthy();
    // Appearance is the first card, so the control sits near the top of the page.
    expect(document.querySelector('[data-main]').textContent).toMatch(/Appearance/);
    expect([...select.options].map((o) => o.value)).toEqual(['en', 'bn']);
  });

  it('switches the interface to Bangla and persists it', async () => {
    await chooseLanguage('bn');

    expect(app.store.preferences.language).toBe('bn');
    expect(document.documentElement.getAttribute('lang')).toBe('bn');
    // Shell: sidebar navigation and the page title both repaint.
    expect(document.querySelector('[data-sidebar-nav]').textContent).toMatch(/ড্যাশবোর্ড/);
    expect(document.querySelector('[data-topbar] h1')?.textContent).toBe('সেটিংস');
    // The screen itself remounted, and the selector keeps the new value.
    expect(languageSelect()?.value).toBe('bn');
    expect(document.querySelector('[data-main]').textContent).toMatch(/চেহারা/);
  });

  it('switches back to English', async () => {
    await chooseLanguage('en');

    expect(app.store.preferences.language).toBe('en');
    expect(document.documentElement.getAttribute('lang')).toBe('en');
    expect(document.querySelector('[data-topbar] h1')?.textContent).toBe('Settings');
    expect(document.querySelector('[data-main]').textContent).toMatch(/Appearance/);
  });
});
