/**
 * Sidebar (desktop rail + mobile drawer) and the mobile bottom primary action.
 *
 * The sidebar supports collapsed/expanded states on desktop (persisted as a UI
 * preference) and becomes an off-canvas drawer on small screens.
 */

import { el, icon, clear, createFocusTrap, createListenerRegistry } from '../utils/dom.js';
import { NAV_SECTIONS, findNavItem } from '../config/navigation.js';
import { Router } from '../core/router.js';
import { t } from '../i18n/index.js';

export function createSidebar({ container, drawer, backdrop, mobileNav, uiPrefs, onNavigate, onQuickAdd, getAlerts, isAdmin, isTenantAdmin }) {
  const registry = createListenerRegistry();
  const trap = drawer ? createFocusTrap(drawer) : null;
  let collapsed = Boolean(uiPrefs.get('sidebarCollapsed', false));

  const navRoot = container.querySelector('[data-sidebar-nav]');
  const collapseButton = container.querySelector('[data-sidebar-collapse]');
  const brandLabel = container.querySelector('[data-brand-label]');
  const quickAddButtons = container.querySelectorAll('[data-quick-add]');
  const drawerNavRoot = drawer?.querySelector('[data-drawer-nav]');

  function renderNav(target, { compact = false } = {}) {
    if (!target) return;
    clear(target);
    for (const section of NAV_SECTIONS) {
      if (section.label) {
        target.appendChild(el('p', {
          class: 'nav-section-label mb-1 mt-4 px-3 text-[10px] font-semibold uppercase tracking-widest text-slate-400 dark:text-slate-500',
          text: t(`nav.section.${section.id}`)
        }));
      }
      for (const item of section.items) {
        // Administrator-only entries stay hidden from everyone else. Platform
        // entries need the platform role; workspace entries need the tenant role.
        if (item.adminOnly && !isAdmin?.()) continue;
        if (item.tenantAdminOnly && !isTenantAdmin?.()) continue;
        const label = t(`nav.${item.id}`);
        const badge = item.id === 'budgets' ? getAlerts?.() || 0 : 0;
        target.appendChild(el('a', {
          href: Router.href(item.path),
          class: 'nav-item',
          dataset: { navId: item.id },
          // Tooltips and an explicit name keep the icon-only rail usable.
          title: compact ? label : null,
          'aria-label': compact ? label : null,
          onclick: () => {
            closeDrawer();
            onNavigate?.(item);
          }
        }, [
          icon(item.icon, 'h-[18px] w-[18px]'),
          el('span', { class: 'nav-label flex-1 truncate', text: label }),
          badge > 0 ? el('span', { class: 'nav-badge badge bg-expense-100 text-expense-700 dark:bg-expense-500/20 dark:text-expense-300', text: String(badge) }) : null
        ]));
      }
    }
  }

  function paint() {
    renderNav(navRoot, { compact: collapsed });
    renderNav(drawerNavRoot, { compact: false });
    if (brandLabel) brandLabel.classList.toggle('sr-only', collapsed);
    if (collapseButton) {
      collapseButton.setAttribute('aria-pressed', String(collapsed));
      const label = t(collapsed ? 'sidebar.expand' : 'sidebar.collapse');
      collapseButton.setAttribute('aria-label', label);
      collapseButton.title = label;
      clear(collapseButton);
      collapseButton.appendChild(icon(collapsed ? 'chevrons-right' : 'chevrons-left', 'h-4 w-4'));
    }
    container.dataset.collapsed = collapsed ? 'true' : 'false';
    container.classList.toggle('lg:w-[4.75rem]', collapsed);
    container.classList.toggle('lg:w-[16.5rem]', !collapsed);
    highlightActive();
  }

  function highlightActive() {
    const { path, segments } = Router.parse(location.hash);
    // Prefer the most specific nav entry (so /platform/tenants/… highlights
    // "Tenants", not the shorter "/platform" overview).
    const activeId = findNavItem(path)?.id || segments[0] || 'dashboard';
    for (const root of [container, drawer, mobileNav]) {
      for (const node of root?.querySelectorAll('[data-nav-id]') || []) {
        if (node.dataset.navId === activeId) node.setAttribute('aria-current', 'page');
        else node.removeAttribute('aria-current');
      }
    }
  }

  function openDrawer() {
    if (!drawer) return;
    drawer.classList.remove('-translate-x-full');
    backdrop?.classList.remove('hidden');
    trap?.activate();
    document.body.style.overflow = 'hidden';
    drawer.setAttribute('aria-hidden', 'false');
  }

  function closeDrawer() {
    if (!drawer) return;
    drawer.classList.add('-translate-x-full');
    backdrop?.classList.add('hidden');
    trap?.deactivate();
    document.body.style.overflow = '';
    drawer.setAttribute('aria-hidden', 'true');
  }

  function toggle() {
    collapsed = !collapsed;
    uiPrefs.set('sidebarCollapsed', collapsed);
    paint();
  }

  // Wiring -----------------------------------------------------------------
  if (collapseButton) registry.on(collapseButton, 'click', toggle);
  if (drawer) {
    for (const button of drawer.querySelectorAll('[data-drawer-close]')) registry.on(button, 'click', closeDrawer);
    closeDrawer();
  }
  registry.on(backdrop, 'click', closeDrawer);
  registry.on(document, 'keydown', (event) => {
    if (event.key === 'Escape' && drawer && !drawer.classList.contains('-translate-x-full')) closeDrawer();
  });
  for (const button of quickAddButtons) registry.on(button, 'click', () => onQuickAdd?.());
  for (const button of drawer?.querySelectorAll('[data-drawer-quick-add]') || []) {
    registry.on(button, 'click', () => {
      closeDrawer();
      onQuickAdd?.();
    });
  }
  for (const link of container.querySelectorAll('[data-block-new]')) {
    registry.on(link, 'click', (event) => {
      event.preventDefault();
      onQuickAdd?.();
    });
  }

  // Keyboard shortcuts: "n" adds a transaction, "[" toggles the sidebar.
  registry.on(document, 'keydown', (event) => {
    const target = event.target;
    const typing = target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
    if (typing || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === 'n') {
      event.preventDefault();
      onQuickAdd?.();
    } else if (event.key === '[') {
      event.preventDefault();
      toggle();
    }
  });

  paint();

  // The pre-JS bootstrap hint has served its purpose; the rail now carries the
  // authoritative `data-collapsed` state.
  delete document.documentElement.dataset.sidebarCollapsed;

  return {
    paint,
    highlightActive,
    openDrawer,
    closeDrawer,
    toggle,
    get collapsed() {
      return collapsed;
    },
    refreshBadges: paint,
    destroy: () => registry.dispose()
  };
}
