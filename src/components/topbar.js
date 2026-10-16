/**
 * Top bar.
 *
 * Shows the current page title, a global search shortcut, the quick-add action,
 * the theme toggle, the notification bell (budget alerts + due recurring items)
 * and the account/menu. It is rebuilt on navigation and on data changes so the
 * badge counts stay accurate.
 */

import { el, icon, clear } from '../utils/dom.js';
import { dropdownMenu } from './ui.js';
import { findNavItem, ROUTE_TITLES, NAV_SECTIONS } from '../config/navigation.js';
import { Router } from '../core/router.js';
import { appConfig } from '../config/appConfig.js';
import { formatDate, todayISO } from '../utils/date.js';
import { t } from '../i18n/index.js';

export function createTopbar({ container, ctx, onQuickAdd, onOpenDrawer }) {
  const offs = [];

  function pageInfo() {
    const { segments, path } = Router.parse(location.hash);
    // Prefer the most specific navigation entry so nested routes (e.g.
    // /platform/tenants/:id) get their own title and section.
    const item = findNavItem(path);
    const id = item?.id || segments[0] || 'dashboard';
    const sectionEntry = item ? NAV_SECTIONS.find((s) => s.items.some((entry) => entry.id === item.id)) : null;
    const titleKey = `route.${id}`;
    const translatedTitle = t(titleKey);
    return {
      title: translatedTitle !== titleKey ? translatedTitle : (ROUTE_TITLES[id] || item?.label || appConfig.appName),
      section: sectionEntry?.label ? t(`nav.section.${sectionEntry.id}`) : '',
      id
    };
  }

  function switchWorkspace(id) {
    try {
      // Prefer the app-level orchestrator: it flushes the previous workspace's
      // pending writes and pulls the next one's dataset before repainting.
      if (typeof ctx.switchWorkspace === 'function') ctx.switchWorkspace(id);
      else ctx.tenants?.switchTenant?.(id);
    } catch (error) {
      ctx.toast?.error?.(t('topbar.workspace'), error?.message || t('error.pageMessage'));
    }
  }

  /**
   * Workspace switcher: only meaningful for accounts that belong to more than
   * one workspace (or that administer the current one). The selection is a
   * server-verified hint — see services/tenantService.js.
   */
  function workspaceMenu() {
    const service = ctx.tenants;
    const list = service?.list || [];
    if (!ctx.cloud?.auth?.signedIn || list.length === 0) return null;

    const current = service.current || null;
    const items = list.map((entry) => ({
      label: entry.isPersonal ? `${entry.name} · ${t('topbar.personalWorkspace')}` : entry.name,
      icon: entry.id === service.currentId ? 'check' : (entry.isPersonal ? 'user-round' : 'building-2'),
      onClick: () => switchWorkspace(entry.id)
    }));
    if (service.isTenantAdmin) {
      items.push({ divider: true });
      items.push({ label: t('nav.workspace'), icon: 'settings-2', onClick: () => ctx.router.navigate('/workspace') });
    }

    const title = current
      ? `${t('topbar.switchWorkspace')}: ${current.name}`
      : t('topbar.switchWorkspace');
    const wrapper = dropdownMenu({ title, iconName: 'building-2', buttonClass: 'btn btn-ghost btn-sm gap-1.5 max-w-[10rem]', items });
    const text = el('span', { class: 'hidden max-w-[7rem] truncate text-xs font-medium sm:inline', text: current?.name || t('topbar.workspace') });
    // Put the workspace name next to the icon so the current context is visible.
    wrapper.querySelector('button')?.appendChild(text);
    return wrapper;
  }

  function notificationsMenu() {
    const notifications = ctx.notifications;
    const items = [];
    const alerts = notifications?.budgetAlerts?.() || [];
    const due = notifications?.dueItems?.() || [];

    for (const item of alerts.slice(0, 4)) {
      items.push({
        label: t('topbar.budgetUsed', { name: item.budget.name, level: item.level }),
        icon: 'triangle-alert',
        onClick: () => ctx.router.navigate('/budgets')
      });
    }
    for (const item of due.slice(0, 4)) {
      items.push({
        label: t('topbar.due', { name: item.rule.name }),
        icon: 'repeat',
        onClick: () => ctx.router.navigate('/recurring')
      });
    }
    if (!items.length) {
      items.push({ label: t('topbar.allCaughtUp'), icon: 'circle-check', onClick: () => {} });
    } else {
      items.push({ divider: true });
      items.push({ label: t('topbar.markAllSeen'), icon: 'check-check', onClick: () => { notifications?.markSeen?.(); render(); } });
    }
    return items;
  }

  function buildSearchInput() {
    const input = el('input', {
      type: 'search',
      class: 'input !py-1.5 pl-9 text-sm',
      placeholder: t('topbar.searchPlaceholder'),
      'aria-label': t('topbar.searchTransactions'),
      autocomplete: 'off'
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        closeMobileSearch();
        return;
      }
      if (event.key !== 'Enter') return;
      const term = input.value.trim();
      ctx.router.navigate(term ? `/transactions?q=${encodeURIComponent(term)}` : '/transactions');
      closeMobileSearch();
    });
    return input;
  }

  let mobileSearchEl = null;
  let mobileInputEl = null;

  function openMobileSearch() {
    if (!mobileSearchEl) return;
    mobileSearchEl.classList.remove('hidden');
    mobileSearchEl.classList.add('flex');
    mobileInputEl?.focus();
  }

  function closeMobileSearch() {
    if (!mobileSearchEl) return;
    mobileSearchEl.classList.add('hidden');
    mobileSearchEl.classList.remove('flex');
  }

  function render() {
    clear(container);
    const info = pageInfo();
    const count = ctx.notifications?.badgeCount?.() || 0;
    const themeMode = ctx.theme?.resolved || 'light';
    const signedIn = Boolean(ctx.cloud?.auth?.signedIn);

    const search = buildSearchInput();
    const mobileSearch = buildSearchInput();

    container.append(
      el('div', { class: 'flex min-w-0 flex-1 items-center gap-2' }, [
        el('button', {
          type: 'button', class: 'btn btn-ghost btn-icon lg:hidden', 'aria-label': t('topbar.openNav'), onclick: onOpenDrawer
        }, [icon('menu', 'h-5 w-5')]),
        el('div', { class: 'min-w-0' }, [
          el('h1', { class: 'truncate text-base font-semibold tracking-tight text-slate-900 dark:text-slate-50', text: info.title }),
          info.section ? el('p', { class: 'truncate text-[11px] text-slate-400 dark:text-slate-500', text: info.section }) : null
        ])
      ]),
      el('div', { class: 'flex items-center gap-1.5' }, [
        workspaceMenu(),
        // Current date / reporting period. Hidden on the smallest screens to
        // keep the bar uncluttered; the reports and dashboard screens carry
        // their own period selectors.
        el('time', {
          class: 'hidden items-center gap-1.5 rounded-xl border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-500 lg:flex dark:border-slate-700 dark:text-slate-400',
          datetime: todayISO(),
          title: t('topbar.today')
        }, [
          icon('calendar-days', 'h-3.5 w-3.5'),
          el('span', {
            text: formatDate(todayISO(), {
              locale: ctx.store?.preferences?.locale || 'en-US',
              format: ctx.store?.preferences?.dateFormat || 'medium'
            })
          })
        ]),
        el('div', { class: 'relative hidden min-w-[10rem] max-w-xs flex-1 md:block' }, [
          el('span', { class: 'pointer-events-none absolute inset-y-0 left-0 flex w-9 items-center justify-center text-slate-400' }, [icon('search', 'h-4 w-4')]),
          search
        ]),
        el('button', {
          type: 'button',
          class: 'btn btn-ghost btn-icon md:hidden',
          'aria-label': t('topbar.searchTransactions'),
          title: t('topbar.search'),
          onclick: openMobileSearch
        }, [icon('search', 'h-5 w-5')]),
        el('button', {
          type: 'button',
          class: 'btn btn-primary btn-sm hidden lg:inline-flex',
          title: t('topbar.addTransactionShortcut'),
          onclick: onQuickAdd
        }, [icon('plus', 'h-4 w-4'), el('span', { text: t('common.add') })]),
        el('button', {
          type: 'button',
          class: 'btn btn-ghost btn-icon',
          'aria-label': themeMode === 'dark' ? t('topbar.switchLight') : t('topbar.switchDark'),
          title: t('topbar.toggleTheme'),
          onclick: () => { ctx.theme?.toggle?.(); }
        }, [icon(themeMode === 'dark' ? 'sun' : 'moon', 'h-5 w-5')]),
        el('div', { class: 'relative' }, [
          dropdownMenu({
            title: t('topbar.notifications'),
            iconName: 'bell',
            buttonClass: 'btn btn-ghost btn-icon relative',
            items: notificationsMenu()
          }),
          count > 0
            ? el('span', { class: 'pointer-events-none absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-expense-500 px-1 text-[10px] font-semibold text-white', text: count > 9 ? '9+' : String(count) })
            : null
        ]),
        el('div', { class: 'relative' }, [
          dropdownMenu({
            title: t('topbar.accountMenu'),
            iconName: 'user-round',
            items: [
              { label: signedIn ? `${t('topbar.signedIn')}${ctx.cloud?.auth?.user?.email ? `: ${ctx.cloud.auth.user.email}` : ''}` : t('topbar.cloudOff'), icon: 'cloud', onClick: () => ctx.router.navigate('/settings') },
              { divider: true },
              { label: t('topbar.settings'), icon: 'settings', onClick: () => ctx.router.navigate('/settings') },
              { label: themeMode === 'dark' ? t('topbar.lightTheme') : t('topbar.darkTheme'), icon: themeMode === 'dark' ? 'sun' : 'moon', onClick: () => ctx.theme?.toggle?.() },
              { label: t('topbar.accountsWallets'), icon: 'wallet', onClick: () => ctx.router.navigate('/accounts') },
              { label: t('topbar.reports'), icon: 'chart-column', onClick: () => ctx.router.navigate('/reports') }
            ]
          })
        ])
      ])
    );

    // Full-width search sheet for small screens, where the inline field hides.
    const overlay = el('div', {
      class: 'absolute inset-0 z-30 hidden items-center gap-2 border-b border-slate-200 bg-white px-3 dark:border-slate-800 dark:bg-slate-900 md:hidden'
    }, [
      el('div', { class: 'relative flex-1' }, [
        el('span', { class: 'pointer-events-none absolute inset-y-0 left-0 flex w-9 items-center justify-center text-slate-400' }, [icon('search', 'h-4 w-4')]),
        mobileSearch
      ]),
      el('button', { type: 'button', class: 'btn btn-secondary btn-sm shrink-0', text: t('common.cancel'), onclick: closeMobileSearch })
    ]);
    container.appendChild(overlay);
    mobileSearchEl = overlay;
    mobileInputEl = mobileSearch;
  }

  function bind() {
    offs.push(ctx.bus?.on('data:changed', () => render()) || (() => {}));
    offs.push(ctx.bus?.on('cloud:status', () => render()) || (() => {}));
  }

  render();
  bind();

  return {
    render,
    destroy() {
      offs.forEach((off) => typeof off === 'function' && off());
      clear(container);
    }
  };
}
