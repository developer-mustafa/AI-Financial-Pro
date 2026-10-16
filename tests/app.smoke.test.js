/**
 * End-to-end smoke test.
 *
 * Boots the real composition root against the actual index.html shell (parsed
 * into jsdom) and walks every route. This catches wiring regressions that unit
 * tests cannot see: missing `[data-*]` hooks, bad method names, throws during
 * mount, and import-time failures.
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { todayISO, addMonths } from '../src/utils/date.js';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls until `predicate()` is true (or the timeout elapses). */
const waitFor = async (predicate, { timeout = 2000, step = 25 } = {}) => {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (predicate()) return true;
    await wait(step);
  }
  return Boolean(predicate());
};

describe('application smoke test', () => {
  let app;
  const loggedErrors = [];

  beforeAll(async () => {
    const html = fs.readFileSync(path.resolve(process.cwd(), 'index.html'), 'utf8');
    const body = html.match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1] || '';
    document.body.innerHTML = body;

    // jsdom shims for browser APIs the app touches.
    window.scrollTo = () => {};
    if (!window.matchMedia) {
      window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
    }
    if (!globalThis.requestAnimationFrame) {
      globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
      globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
    }

    vi.spyOn(console, 'error').mockImplementation((...args) => {
      loggedErrors.push(args.map((a) => (a && a.message) || String(a)).join(' '));
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    // The browser loads the vendored Lucide bundle before the app; mirror that so
    // the inline-SVG icon path is actually exercised instead of the placeholder.
    const lucideBundle = fs.readFileSync(path.resolve(process.cwd(), 'assets/vendor/lucide.js'), 'utf8');
    new Function(lucideBundle).call(globalThis);

    const { startApp } = await import('../src/app.js');
    app = await startApp({ mountPoint: document });
  }, 30000);

  it('renders the layout chrome from the shell markup', () => {
    expect(document.querySelectorAll('[data-sidebar-nav] [data-nav-id]').length).toBeGreaterThanOrEqual(5);
    expect(document.querySelectorAll('[data-drawer-nav] [data-nav-id]').length).toBeGreaterThanOrEqual(5);
    expect(document.querySelector('[data-topbar] h1')?.textContent?.length).toBeGreaterThan(0);
    expect(document.querySelectorAll('[data-mobile-nav] a').length).toBeGreaterThanOrEqual(4);
    expect(document.querySelector('[data-main]').childNodes.length).toBeGreaterThan(0);
  });

  it('renders icons as real SVG from the vendored Lucide bundle', () => {
    const svg = document.querySelector('[data-sidebar-nav] [data-nav-id] svg');
    expect(svg, 'a navigation icon should render as <svg>').toBeTruthy();
    expect(svg.children.length, 'the icon svg should contain its child shapes').toBeGreaterThan(0);
  });

  it('marks the active navigation item', () => {
    expect(document.querySelector('[data-sidebar-nav] [aria-current="page"]')).toBeTruthy();
  });

  it('highlights the active destination in the mobile bottom nav', async () => {
    app.router.navigate('/transactions');
    await waitFor(() => document.querySelector('[data-mobile-nav] [aria-current="page"]')?.dataset.navId === 'transactions');
    const active = document.querySelector('[data-mobile-nav] [aria-current="page"]');
    expect(active?.dataset.navId).toBe('transactions');
  });

  it('exposes quick-add from the mobile nav and the drawer', () => {
    expect(document.querySelector('[data-mobile-nav] .mobile-nav-add')).toBeTruthy();
    expect(document.querySelector('[data-drawer] [data-drawer-quick-add]')).toBeTruthy();
  });

  it('collapses and restores the desktop rail without losing actions', () => {
    const rail = document.querySelector('[data-sidebar]');
    const button = rail.querySelector('[data-sidebar-collapse]');
    const start = rail.dataset.collapsed;
    button.click();
    expect(rail.dataset.collapsed).not.toBe(start);
    expect(rail.dataset.collapsed).toBe('true');
    // The brand label and quick-add stay in the DOM; CSS hides just the text.
    expect(rail.querySelector('[data-brand-label]')).toBeTruthy();
    expect(rail.querySelector('[data-quick-add] .sidebar-copy')).toBeTruthy();
    button.click();
    expect(rail.dataset.collapsed).toBe(start);
  });

  it('provides a mobile search affordance in the top bar', () => {
    const topbar = document.querySelector('[data-topbar]');
    expect(topbar.querySelectorAll('input[type="search"]').length).toBeGreaterThanOrEqual(2);
    expect(topbar.querySelector('[aria-label="Search transactions"][class*="md:hidden"]')).toBeTruthy();
  });

  it('mounts every route without a module error', async () => {
    const routes = [
      ['/transactions', 'transactions'],
      ['/income', 'income'],
      ['/expenses', 'expenses'],
      ['/categories', 'categories'],
      ['/budgets', 'budgets'],
      ['/recurring', 'recurring'],
      ['/goals', 'goals'],
      ['/reports', 'reports'],
      ['/accounts', 'accounts'],
      ['/ai', 'ai'],
      ['/settings', 'settings'],
      ['/admin', 'admin'],
      ['/workspace', 'workspace'],
      ['/platform', 'platform'],
      ['/platform/tenants', 'platform'],
      ['/platform/tenants/00000000-0000-0000-0000-000000000000', 'platform'],
      ['/platform/audit', 'platform'],
      ['/dashboard', 'dashboard']
    ];
    for (const [route, moduleId] of routes) {
      app.router.navigate(route);
      await wait(80);
      // The route's meta must survive into the navigation context, otherwise
      // every screen silently falls back to the dashboard module.
      expect(app.router.currentRoute?.meta?.module, `route ${route} resolved to the wrong module`).toBe(moduleId);
      expect(document.querySelector('[data-main]').childNodes.length, `route ${route} rendered nothing`).toBeGreaterThan(0);
    }
    const moduleErrors = loggedErrors.filter((entry) => entry.includes('module "'));
    expect(moduleErrors).toEqual([]);
  }, 30000);

  it('opens the quick-add dialog without throwing', async () => {
    const quickAdd = document.querySelector('[data-sidebar] [data-quick-add]');
    expect(quickAdd).toBeTruthy();
    quickAdd.click();
    await wait(50);
    expect(document.body.textContent).toMatch(/transaction/i);
  });

  it('renders the income insights tiles from real data', async () => {
    const account = app.store.list('accounts')[0];
    const category = app.store.list('categories').find((entry) => entry.type === 'income' && !entry.archived);
    expect(account, 'a seeded account is required').toBeTruthy();
    expect(category, 'a seeded income category is required').toBeTruthy();

    const today = todayISO();
    for (const [monthsAgo, amount] of [[1, 400000], [0, 650000]]) {
      const date = monthsAgo ? addMonths(today, -1) : today;
      const result = app.services.transactions.add({
        type: 'income',
        amountMinor: amount,
        currency: 'BDT',
        categoryId: category.id,
        accountId: account.id,
        toAccountId: null,
        date,
        description: 'Smoke income',
        payee: '',
        paymentMethod: 'cash',
        status: 'posted',
        tags: [],
        notes: ''
      });
      expect(result.ok, `income add failed: ${JSON.stringify(result.errors)}`).toBe(true);
    }

    app.router.navigate('/income');
    await waitFor(() => /By month/i.test(document.querySelector('[data-main]').textContent));
    const main = document.querySelector('[data-main]').textContent;
    expect(main).toMatch(/By month/i);
    expect(main).toMatch(/Top sources/i);
    expect(main).toMatch(/Recurring income/i);
  }, 30000);

  it('tears down cleanly', () => {
    expect(() => app.destroy()).not.toThrow();
  });
});
