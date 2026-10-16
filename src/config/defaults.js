/**
 * Default seed data + enumerations.
 *
 * These are only written to storage on a genuine first run (or when the user
 * explicitly asks to restore defaults). They are never re-seeded on every
 * render, and never overwrite existing user data.
 */

export const ACCOUNT_TYPES = [
  { value: 'cash', label: 'Cash', icon: 'banknote' },
  { value: 'bank', label: 'Bank Account', icon: 'landmark' },
  { value: 'mobile_wallet', label: 'Mobile Wallet', icon: 'smartphone' },
  { value: 'credit_card', label: 'Credit Card', icon: 'credit-card' },
  { value: 'savings', label: 'Savings Account', icon: 'piggy-bank' },
  { value: 'other', label: 'Other', icon: 'circle-ellipsis' }
];

export const PAYMENT_METHODS = [
  { value: 'cash', label: 'Cash' },
  { value: 'card', label: 'Card' },
  { value: 'bank_transfer', label: 'Bank Transfer' },
  { value: 'mobile_wallet', label: 'Mobile Wallet' },
  { value: 'cheque', label: 'Cheque' },
  { value: 'other', label: 'Other' }
];

export const TRANSACTION_TYPES = [
  { value: 'income', label: 'Income', icon: 'trending-up' },
  { value: 'expense', label: 'Expense', icon: 'trending-down' },
  { value: 'transfer', label: 'Transfer', icon: 'arrow-left-right' }
];

export const TRANSACTION_STATUSES = [
  { value: 'posted', label: 'Posted' },
  { value: 'pending', label: 'Pending' },
  { value: 'draft', label: 'Draft' }
];

export const BUDGET_PERIODS = [
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'yearly', label: 'Yearly' }
];

export const RECURRING_FREQUENCIES = [
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'yearly', label: 'Yearly' }
];

export const GOAL_STATUSES = [
  { value: 'active', label: 'Active' },
  { value: 'completed', label: 'Completed' },
  { value: 'archived', label: 'Archived' }
];

export const CURRENCIES = [
  { code: 'BDT', label: 'BDT — Bangladeshi Taka' },
  { code: 'USD', label: 'USD — US Dollar' },
  { code: 'EUR', label: 'EUR — Euro' },
  { code: 'GBP', label: 'GBP — Pound Sterling' },
  { code: 'INR', label: 'INR — Indian Rupee' },
  { code: 'JPY', label: 'JPY — Japanese Yen' },
  { code: 'AED', label: 'AED — UAE Dirham' },
  { code: 'SAR', label: 'SAR — Saudi Riyal' },
  { code: 'CAD', label: 'CAD — Canadian Dollar' },
  { code: 'AUD', label: 'AUD — Australian Dollar' }
];

export const LOCALES = [
  { value: 'en-US', label: 'English (United States)' },
  { value: 'en-GB', label: 'English (United Kingdom)' },
  { value: 'bn-BD', label: 'বাংলা (Bangladesh)' },
  { value: 'hi-IN', label: 'हिन्दी (भारत)' },
  { value: 'de-DE', label: 'Deutsch (Deutschland)' },
  { value: 'fr-FR', label: 'Français (France)' }
];

/** Category colour palette used for defaults and for the colour picker. */
export const PALETTE = [
  '#6366f1', '#8b5cf6', '#a855f7', '#d946ef', '#ec4899', '#f43f5e',
  '#ef4444', '#f97316', '#f59e0b', '#eab308', '#84cc16', '#22c55e',
  '#10b981', '#14b8a6', '#06b6d4', '#0ea5e9', '#3b82f6', '#64748b'
];

const cat = (name, icon, color) => ({ name, icon, color });

export const DEFAULT_INCOME_CATEGORY_NAMES = [
  'Salary', 'Freelancing', 'Business Income', 'Teaching', 'Investment Income',
  'Rental Income', 'Gifts', 'Refunds', 'Other Income'
];

export const DEFAULT_EXPENSE_CATEGORY_NAMES = [
  'Food & Groceries', 'Transportation', 'Housing & Rent', 'Utilities', 'Healthcare',
  'Education', 'Shopping', 'Entertainment', 'Family', 'Travel', 'Personal Care',
  'Subscriptions', 'Business Expenses', 'Taxes & Fees', 'Other Expenses'
];

const INCOME_SEEDS = [
  cat('Salary', 'banknote', '#10b981'),
  cat('Freelancing', 'laptop', '#14b8a6'),
  cat('Business Income', 'briefcase', '#0ea5e9'),
  cat('Teaching', 'graduation-cap', '#6366f1'),
  cat('Investment Income', 'trending-up', '#8b5cf6'),
  cat('Rental Income', 'home', '#06b6d4'),
  cat('Gifts', 'gift', '#d946ef'),
  cat('Refunds', 'rotate-ccw', '#f59e0b'),
  cat('Other Income', 'circle-plus', '#64748b')
];

const EXPENSE_SEEDS = [
  cat('Food & Groceries', 'utensils', '#f97316'),
  cat('Transportation', 'car', '#3b82f6'),
  cat('Housing & Rent', 'house', '#8b5cf6'),
  cat('Utilities', 'zap', '#eab308'),
  cat('Healthcare', 'heart-pulse', '#ef4444'),
  cat('Education', 'book-open', '#6366f1'),
  cat('Shopping', 'shopping-bag', '#ec4899'),
  cat('Entertainment', 'film', '#a855f7'),
  cat('Family', 'users', '#14b8a6'),
  cat('Travel', 'plane', '#0ea5e9'),
  cat('Personal Care', 'sparkles', '#d946ef'),
  cat('Subscriptions', 'refresh-cw', '#f43f5e'),
  cat('Business Expenses', 'briefcase-business', '#64748b'),
  cat('Taxes & Fees', 'receipt', '#84cc16'),
  cat('Other Expenses', 'circle-ellipsis', '#94a3b8')
];

export const DEFAULT_PREFERENCES = Object.freeze({
  theme: 'system',            // light | dark | system
  density: 'comfortable',     // comfortable | compact
  sidebarCollapsed: false,
  language: 'en',             // en | bn — interface language
  currency: 'BDT',
  locale: 'en-US',
  dateFormat: 'medium',       // short | medium | long
  numberFormat: 'standard',   // standard | accounting
  weekStart: 0,               // 0 = Sunday, 1 = Monday, 6 = Saturday
  defaultRange: 'thisMonth',
  defaultAccountId: null,
  defaultCategoryId: null,
  defaultPaymentMethod: 'cash',
  budgetAlertsEnabled: true,
  alertThresholds: [75, 90, 100],
  recurrenceAutoPrompt: true
});

/**
 * Builds the seed entities for a brand-new dataset.
 * @param {() => string} uid id factory
 * @param {string} now ISO timestamp
 */
export function buildSeedData(uid, now, currency = 'BDT') {
  const categories = [];
  for (const seed of INCOME_SEEDS) {
    categories.push({
      id: uid(),
      name: seed.name,
      type: 'income',
      parentId: null,
      icon: seed.icon,
      color: seed.color,
      archived: false,
      isDefault: true,
      createdAt: now,
      updatedAt: now
    });
  }
  for (const seed of EXPENSE_SEEDS) {
    categories.push({
      id: uid(),
      name: seed.name,
      type: 'expense',
      parentId: null,
      icon: seed.icon,
      color: seed.color,
      archived: false,
      isDefault: true,
      createdAt: now,
      updatedAt: now
    });
  }

  const cashId = uid();
  const accounts = [
    {
      id: cashId,
      name: 'Cash',
      type: 'cash',
      currency,
      openingBalanceMinor: 0,
      openingBalanceDate: now.slice(0, 10),
      color: '#22c55e',
      icon: 'banknote',
      archived: false,
      createdAt: now,
      updatedAt: now
    }
  ];

  return { categories, accounts, cashAccountId: cashId };
}

/** Suggested category/account emoji-free icon names offered in pickers. */
export const ICON_CHOICES = [
  'wallet', 'banknote', 'landmark', 'credit-card', 'piggy-bank', 'smartphone', 'coins',
  'utensils', 'car', 'bus', 'house', 'zap', 'droplets', 'flame', 'wifi', 'phone',
  'heart-pulse', 'stethoscope', 'book-open', 'graduation-cap', 'shopping-bag', 'shirt',
  'film', 'music', 'gamepad-2', 'plane', 'train', 'users', 'baby', 'paw-print',
  'sparkles', 'scissors', 'refresh-cw', 'repeat', 'briefcase', 'receipt', 'file-text',
  'trending-up', 'trending-down', 'chart-pie', 'target', 'gift', 'trophy', 'shield',
  'calendar', 'clock', 'tag', 'tags', 'circle-plus', 'circle-ellipsis', 'star', 'zap'
];
