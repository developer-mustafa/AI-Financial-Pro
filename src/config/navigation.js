/**
 * Navigation model. Single source of truth for the sidebar, the top bar
 * breadcrumb, the mobile drawer and the router's page titles.
 */

export const NAV_SECTIONS = [
  {
    id: 'overview',
    label: null,
    items: [{ id: 'dashboard', label: 'Dashboard', path: '/dashboard', icon: 'layout-dashboard' }]
  },
  {
    id: 'money',
    label: 'Money',
    items: [
      { id: 'transactions', label: 'Transactions', path: '/transactions', icon: 'arrow-left-right' },
      { id: 'income', label: 'Income', path: '/income', icon: 'trending-up' },
      { id: 'expenses', label: 'Expenses', path: '/expenses', icon: 'trending-down' }
    ]
  },
  {
    id: 'planning',
    label: 'Planning',
    items: [
      { id: 'categories', label: 'Categories', path: '/categories', icon: 'tags' },
      { id: 'budgets', label: 'Budgets', path: '/budgets', icon: 'target' },
      { id: 'recurring', label: 'Recurring', path: '/recurring', icon: 'repeat' },
      { id: 'goals', label: 'Financial Goals', path: '/goals', icon: 'piggy-bank' }
    ]
  },
  {
    id: 'insight',
    label: 'Insights',
    items: [
      { id: 'reports', label: 'Reports & Analytics', path: '/reports', icon: 'chart-column' },
      { id: 'accounts', label: 'Accounts & Wallets', path: '/accounts', icon: 'wallet' }
    ]
  },
  {
    id: 'system',
    label: 'System',
    items: [
      // Visible only to workspace administrators (see sidebar.js).
      { id: 'workspace', label: 'Workspace', path: '/workspace', icon: 'building-2', tenantAdminOnly: true },
      { id: 'settings', label: 'Settings', path: '/settings', icon: 'settings' },
      // Visible only to accounts with the platform administrator role.
      { id: 'admin', label: 'User Management', path: '/admin', icon: 'shield-check', adminOnly: true }
    ]
  },
  {
    id: 'platform',
    label: 'Platform',
    items: [
      { id: 'platform', label: 'Platform Overview', path: '/platform', icon: 'gauge', adminOnly: true },
      { id: 'platformTenants', label: 'Tenants', path: '/platform/tenants', icon: 'building', adminOnly: true },
      { id: 'platformAudit', label: 'Audit Log', path: '/platform/audit', icon: 'scroll-text', adminOnly: true }
    ]
  }
];

export const NAV_ITEMS = NAV_SECTIONS.flatMap((section) => section.items);

/** Route segments that render a sub-view of a module. */
export const ROUTE_TITLES = {
  dashboard: 'Dashboard',
  transactions: 'Transactions',
  income: 'Income',
  expenses: 'Expenses',
  categories: 'Categories',
  budgets: 'Budgets',
  recurring: 'Recurring Transactions',
  goals: 'Financial Goals',
  reports: 'Reports & Analytics',
  accounts: 'Accounts & Wallets',
  settings: 'Settings',
  workspace: 'Workspace',
  admin: 'User Management',
  platform: 'Platform Overview',
  platformTenants: 'Tenants',
  platformAudit: 'Audit Log'
};

/**
 * The nav entry that best matches `path`. The LONGEST matching path wins, so
 * `/platform/tenants/:id` resolves to the "Tenants" entry rather than the
 * shorter `/platform` overview entry.
 */
export function findNavItem(path) {
  const clean = `/${String(path || '').split('/').filter(Boolean).join('/')}`;
  let best = null;
  for (const item of NAV_ITEMS) {
    const matches = clean === item.path || clean.startsWith(`${item.path}/`);
    if (matches && (!best || item.path.length > best.path.length)) best = item;
  }
  return best;
}

export function findNavItemById(id) {
  return NAV_ITEMS.find((item) => item.id === id) || null;
}

/** Breadcrumb trail for the top bar. */
export function breadcrumbFor(path, { entityName = null } = {}) {
  const item = findNavItem(path);
  const trail = [{ label: 'SpendWise', path: '/dashboard' }];
  if (!item) return trail;
  trail.push({ label: item.label, path: item.path });
  const segments = String(path || '').split('/').filter(Boolean);
  if (segments.length > 1) {
    trail.push({ label: entityName || (segments[1] === 'new' ? 'New' : decodeURIComponent(segments[1])), path: null });
  }
  return trail;
}
