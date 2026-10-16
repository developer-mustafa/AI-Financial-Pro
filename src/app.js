/**
 * Application composition root.
 *
 * Wires the store, services, router, layout chrome (sidebar, top bar, mobile
 * navigation) and the module host together. Every dependency a screen needs is
 * passed through a single `ctx` object, so modules never reach for globals.
 *
 * The whole app is local-first: a localStorage adapter is attached before the
 * store initialises. Cloud sync is opt-in and always goes through the Worker.
 */

import { store } from './core/state.js';
import { Router } from './core/router.js';
import { createModuleHost } from './core/lifecycle.js';
import { bus, EVENTS } from './core/eventBus.js';
import { appConfig, isCloudConfigured, isNeonAuthConfigured } from './config/appConfig.js';
import { NAV_ITEMS, findNavItemById } from './config/navigation.js';
import { setLanguage, getLanguage, t } from './i18n/index.js';
import { createToastHost } from './components/toast.js';
import { createSidebar } from './components/sidebar.js';
import { createThemeManager } from './components/themeManager.js';
import { createTopbar } from './components/topbar.js';
import { errorState } from './components/ui.js';
import { el, icon, clear } from './utils/dom.js';
import { Router as RouteUtil } from './core/router.js';

import { createUiPreferences, createLocalStorageAdapter } from './services/storageService.js';
import { createApiClient } from './services/apiClient.js';
import { createAuthService } from './services/authService.js';
import { createNeonAuthClient } from './services/neonAuthService.js';
import { createSyncService } from './services/syncService.js';
import { createTenantService } from './services/tenantService.js';
import { createAdminService } from './modules/admin/adminService.js';
import { createNotificationService } from './services/notificationService.js';

import { createTransactionService } from './modules/transactions/transactionService.js';
import { mount as transactionsMount, createTransactionListView } from './modules/transactions/transactionView.js';
import { openTransactionForm } from './modules/transactions/transactionForm.js';
import { createCategoryService } from './modules/categories/categoryService.js';
import { mount as categoriesMount } from './modules/categories/categoryView.js';
import { createAccountService } from './modules/accounts/accountService.js';
import { mount as accountsMount } from './modules/accounts/accountView.js';
import { createBudgetService } from './modules/budgets/budgetService.js';
import { mount as budgetsMount } from './modules/budgets/budgetView.js';
import { createRecurringService } from './modules/recurring/recurringService.js';
import { mount as recurringMount } from './modules/recurring/recurringView.js';
import { createGoalService } from './modules/goals/goalService.js';
import { mount as goalsMount } from './modules/goals/goalView.js';
import { mount as dashboardMount } from './modules/dashboard/dashboardView.js';
import { mount as reportsMount } from './modules/reports/reportView.js';
import { mount as settingsMount } from './modules/settings/settingsView.js';
import { mount as adminMount } from './modules/admin/adminView.js';
import { mount as workspaceMount } from './modules/workspace/workspaceView.js';
import { createWorkspaceService } from './modules/workspace/workspaceService.js';
import { mount as platformMount } from './modules/platform/platformView.js';
import { createPlatformService } from './modules/platform/platformService.js';

/** Registers every route with the router. `meta.module` drives the module host. */
function buildRoutes(router) {
  const incomeView = createTransactionListView({ mode: 'income' });
  const expenseView = createTransactionListView({ mode: 'expense' });
  const routes = [
    ['/dashboard', { module: 'dashboard', mount: dashboardMount }],
    ['/transactions', { module: 'transactions', mount: transactionsMount }],
    ['/transactions/:id', { module: 'transactions', mount: transactionsMount }],
    ['/income', { module: 'income', mount: incomeView.mount }],
    ['/expenses', { module: 'expenses', mount: expenseView.mount }],
    ['/categories', { module: 'categories', mount: categoriesMount }],
    ['/budgets', { module: 'budgets', mount: budgetsMount }],
    ['/recurring', { module: 'recurring', mount: recurringMount }],
    ['/goals', { module: 'goals', mount: goalsMount }],
    ['/reports', { module: 'reports', mount: reportsMount }],
    ['/accounts', { module: 'accounts', mount: accountsMount }],
    ['/settings', { module: 'settings', mount: settingsMount }],
    ['/admin', { module: 'admin', mount: adminMount }],
    ['/workspace', { module: 'workspace', mount: workspaceMount }],
    ['/platform', { module: 'platform', mount: platformMount }],
    ['/platform/tenants', { module: 'platform', mount: platformMount }],
    ['/platform/tenants/:id', { module: 'platform', mount: platformMount }],
    ['/platform/audit', { module: 'platform', mount: platformMount }]
  ];
  for (const [path, meta] of routes) router.register(path, null, meta);
  return routes;
}

export async function startApp({ mountPoint = document } = {}) {
  const uiPrefs = createUiPreferences();
  const theme = createThemeManager({ onChange: ({ resolved }) => bus.emit(EVENTS.THEME_CHANGED, { resolved }) });
  theme.init();

  const toast = createToastHost();

  // Persistence must be attached before the store initialises.
  store.persistence = createLocalStorageAdapter();
  store.onError = (error) => {
    if (error?.code === 'quota_exceeded') toast.error('Storage full', 'Export a backup and remove old records, or enable cloud sync.');
    else if (error?.code === 'storage_corrupt') toast.warning('Data recovered', 'Stored data was unreadable; starting fresh. The old copy was kept aside.');
  };
  await store.init();

  document.documentElement.dataset.density = store.preferences.density || 'comfortable';
  // Apply the persisted interface language before anything renders.
  setLanguage(store.preferences.language || 'en');

  /* ------------------------------------------------------------- services */

  let authService = null;
  let tenantService = null;
  const client = createApiClient({
    baseUrl: appConfig.apiBaseUrl,
    getToken: () => authService?.getToken?.() ?? null,
    // The tenant selector is a membership-verified hint, never a claim.
    getTenantId: () => tenantService?.getTenantId?.() ?? null,
    onUnauthorized: () => authService?.handleUnauthorized?.()
  });
  // Passwordless (magic link) sign-in goes straight to Managed Better Auth.
  const neonAuth = isNeonAuthConfigured()
    ? createNeonAuthClient({ baseUrl: appConfig.neonAuthUrl })
    : { configured: false };
  authService = createAuthService({ client, neon: neonAuth });
  tenantService = createTenantService({ client });
  const sync = createSyncService({ client, store });
  const notifications = createNotificationService({ store, uiPrefs });

  const transactions = createTransactionService({ store });
  const services = {
    transactions,
    categories: createCategoryService({ store }),
    accounts: createAccountService({ store }),
    budgets: createBudgetService({ store }),
    recurring: createRecurringService({ store, transactions }),
    goals: createGoalService({ store, transactions }),
    admin: createAdminService({ client }),
    workspace: createWorkspaceService({ client }),
    platform: createPlatformService({ client })
  };

  /* ----------------------------------------------------------- layout dom */

  const sidebarEl = mountPoint.querySelector('[data-sidebar]');
  const drawerEl = mountPoint.querySelector('[data-drawer]');
  const backdropEl = mountPoint.querySelector('[data-drawer-backdrop]');
  const topbarEl = mountPoint.querySelector('[data-topbar]');
  const mainEl = mountPoint.querySelector('[data-main]');
  const mobileNavEl = mountPoint.querySelector('[data-mobile-nav]');

  let sidebar = null;
  let topbar = null;

  const router = new Router({ fallback: '/dashboard', onNavigate: handleRoute });
  buildRoutes(router);

  const moduleHost = createModuleHost({
    container: mainEl,
    onError: (error, moduleId) => {
      console.error(`[app] module "${moduleId}" failed`, error);
      toast.fromError(error, 'This page could not be shown.');
      clear(mainEl);
      mainEl.appendChild(errorState({
        title: t('error.pageTitle'),
        message: error?.message || t('error.pageMessage'),
        onRetry: () => router.reload()
      }));
    }
  });

  /**
   * Switch the active workspace safely.
   *
   * Order matters: pending writes are flushed while the tenant header still
   * points at the OLD workspace, then the selection changes, then the new
   * workspace's cloud dataset is pulled. Without this ordering a debounced save
   * could write one workspace's records into another.
   */
  async function switchWorkspace(id) {
    if (!tenantService || !id || id === tenantService.currentId) return;
    try {
      await store.flush({ immediate: true });
    } catch {
      /* an offline flush failure must not block the switch */
    }
    tenantService.switchTenant(id);
    if (store.persistence?.kind === 'cloud') {
      try {
        const data = await sync.pull();
        store.hydrate(data, 'tenant-switch');
      } catch (error) {
        toast.fromError(error, 'Could not load this workspace.');
      }
    }
    sidebar?.paint?.();
    topbar?.render?.();
    router.reload?.();
  }

  const ctx = {
    store,
    router,
    toast,
    services,
    bus,
    uiPrefs,
    theme,
    notifications,
    tenants: tenantService,
    switchWorkspace,
    cloud: {
      auth: authService,
      sync,
      api: client,
      tenants: tenantService,
      configured: isCloudConfigured(),
      neonConfigured: isNeonAuthConfigured()
    }
  };

  const openQuickAdd = () =>
    openTransactionForm({
      service: services.transactions,
      store,
      toast,
      onSaved: () => setTimeout(() => router.reload(), 0)
    });

  /**
   * Translate the labels that live in the static shell markup (index.html):
   * the brand tagline, the quick-add buttons and the drawer footer. Called once
   * on boot and again whenever the language changes.
   */
  function applyShellText() {
    const root = mountPoint?.querySelector ? mountPoint : document;
    root.querySelectorAll('[data-brand-tagline]').forEach((node) => { node.textContent = t('app.taglineShort'); });
    const localNote = root.querySelector('[data-local-note]');
    if (localNote) localNote.textContent = t('app.localFirstNote');

    const quickAdd = root.querySelector('[data-quick-add]');
    if (quickAdd) {
      quickAdd.title = t('topbar.addTransactionShortcut');
      const copy = quickAdd.querySelector('.sidebar-copy');
      if (copy) copy.textContent = t('topbar.addTransaction');
    }
    const drawerQuickAdd = root.querySelector('[data-drawer-quick-add]');
    if (drawerQuickAdd) {
      drawerQuickAdd.title = t('topbar.addTransaction');
      const label = drawerQuickAdd.querySelector('span');
      if (label) label.textContent = t('topbar.addTransaction');
    }
    const drawerClose = root.querySelector('[data-drawer-close]');
    if (drawerClose) drawerClose.setAttribute('aria-label', t('topbar.closeNav'));

    document.title = `${appConfig.appName} · ${t('app.tagline')}`;
  }

  /* ------------------------------------------------------------- routing */

  async function handleRoute(context) {
    const meta = context?.meta || {};
    const mountFn = meta.mount || dashboardMount;
    window.scrollTo({ top: 0, behavior: 'auto' });
    await moduleHost.mount(
      meta.module || 'dashboard',
      (container, disposables, routeContext) => mountFn(container, { ...ctx, route: routeContext, disposables }),
      context
    );
    sidebar?.highlightActive?.();
    topbar?.render?.();
    document.title = `${document.querySelector('[data-topbar] h1')?.textContent || appConfig.appName} · ${appConfig.appName}`;
  }

  /* --------------------------------------------------------- chrome wiring */

  applyShellText();
  renderMobileNav(mobileNavEl, router, openQuickAdd);

  sidebar = createSidebar({
    container: sidebarEl,
    drawer: drawerEl,
    backdrop: backdropEl,
    mobileNav: mobileNavEl,
    uiPrefs,
    onNavigate: (item) => router.navigate(item.path),
    onQuickAdd: openQuickAdd,
    getAlerts: () => notifications.alertCount(),
    isAdmin: () => Boolean(authService?.isAdmin),
    isTenantAdmin: () => Boolean(tenantService?.isTenantAdmin)
  });
  ctx.sidebar = sidebar;

  topbar = createTopbar({
    container: topbarEl,
    ctx,
    onQuickAdd: openQuickAdd,
    onOpenDrawer: () => sidebar.openDrawer()
  });

  // Flush pending writes before the tab closes.
  window.addEventListener('beforeunload', () => { store.flush({ immediate: true }); });

  // Refresh notification badges whenever data changes or focus returns.
  bus.on(EVENTS.DATA_CHANGED, () => sidebar?.refreshBadges?.());
  // A language change re-paints the whole shell and remounts the current screen.
  bus.on(EVENTS.DATA_CHANGED, () => {
    const lang = store.preferences?.language || 'en';
    if (lang === getLanguage()) return;
    setLanguage(lang);
    applyShellText();
    sidebar?.paint?.();
    topbar?.render?.();
    renderMobileNav(mobileNavEl, router, openQuickAdd);
    router.reload?.();
  });
  // Sign-in state decides whether the admin entry is shown.
  bus.on(EVENTS.CLOUD_STATUS, () => { sidebar?.paint?.(); topbar?.render?.(); });
  // The workspace list mirrors the signed-in account: load on sign-in, clear on
  // sign-out. Failures are non-fatal — cloud may simply be off, or the backend
  // older than the tenant endpoints.
  authService.subscribe(({ signedIn }) => {
    if (!signedIn) tenantService.reset();
    else tenantService.load().catch(() => {});
  });
  if (authService.signedIn) tenantService.load().catch(() => {});
  // Repaint the chrome whenever the active workspace (or the list) changes.
  tenantService.subscribe(() => { sidebar?.paint?.(); topbar?.render?.(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      store.flush();
      topbar?.render?.();
    }
  });

  // Verify a stored cloud session in the background (best-effort).
  if (isCloudConfigured() && authService.signedIn) {
    authService.refresh().catch(() => {});
  }

  // Finish a passwordless sign-in: Neon Auth redirects back here after the
  // emailed link is clicked, with the session cookie already set.
  if (authService.neonEnabled) {
    const linkError = authService.readMagicLinkError();
    if (linkError) toast.error('Sign-in link failed', linkError);
    if (linkError) stripAuthParamsFromUrl();
    authService
      .adoptNeonSession()
      .then(({ adopted }) => {
        if (!adopted) return;
        toast.success('Signed in', 'You are signed in by magic link.');
        if (linkError) stripAuthParamsFromUrl();
        topbar?.render?.();
        if (router.currentRoute?.path === '/settings') router.reload();
      })
      .catch(() => {});
  }

  router.start();

  return { store, router, services, ctx, toast, destroy: () => { router.stop(); topbar?.destroy?.(); sidebar?.destroy?.(); toast.destroy(); } };
}

/**
 * Remove sign-in leftovers (`?error=`, `?token=`) from the address bar so a
 * refresh cannot replay them. The hash route is preserved.
 */
function stripAuthParamsFromUrl() {
  try {
    const url = new URL(window.location.href);
    url.searchParams.delete('error');
    url.searchParams.delete('token');
    const search = url.searchParams.toString();
    history.replaceState(null, '', `${url.pathname}${search ? `?${search}` : ''}${url.hash}`);
  } catch {
    /* not fatal: the parameters are harmless on their own */
  }
}

/** Mobile bottom navigation — a raised quick-add between the destinations. */
function renderMobileNav(container, router, onQuickAdd) {
  if (!container) return;
  clear(container);

  const makeItem = (item) => el('a', {
    href: RouteUtil.href(item.path),
    class: 'mobile-nav-item',
    dataset: { navId: item.id },
    onclick: () => router.navigate(item.path)
  }, [
    icon(item.icon, 'h-5 w-5'),
    el('span', { class: 'mobile-nav-label', text: t(`nav.${item.id}`).split(' ')[0] })
  ]);

  const ids = ['dashboard', 'transactions', 'budgets', 'goals'];
  const entries = ids.map(findNavItemById).filter(Boolean);
  const split = Math.floor(entries.length / 2);

  for (const item of entries.slice(0, split)) container.appendChild(makeItem(item));
  container.appendChild(el('div', { class: 'mobile-nav-add-slot' }, [
    el('button', {
      type: 'button',
      class: 'mobile-nav-add',
      'aria-label': t('topbar.addTransaction'),
      title: t('topbar.addTransactionShortcut'),
      onclick: () => onQuickAdd?.()
    }, [icon('plus', 'h-5 w-5')])
  ]));
  for (const item of entries.slice(split)) container.appendChild(makeItem(item));
}

export const __navItems = NAV_ITEMS;
