/**
 * Application-level configuration.
 *
 * The only value that is meant to be adjusted per deployment is `apiBaseUrl`,
 * which is read from the public `runtime-config.js` file at the project root
 * (loaded before the ES modules). That file must NEVER contain database
 * credentials — only the public URL of the Cloudflare Worker API.
 */

const runtime = (typeof globalThis !== 'undefined' && globalThis.SPENDWISE_RUNTIME) || {};

export const appConfig = Object.freeze({
  appName: 'SpendWise',
  appTagline: 'Personal Finance Tracker',
  version: '1.0.0',
  schemaVersion: 1,

  /** Public base URL of the Cloudflare Worker API. Empty string = local-only mode. */
  apiBaseUrl: typeof runtime.apiBaseUrl === 'string' ? runtime.apiBaseUrl.replace(/\/+$/, '') : '',

  /**
   * Public base URL of Managed Better Auth (Neon Auth), e.g.
   * "https://<endpoint>.neonauth.<region>.aws.neon.tech/<db>/auth".
   * Empty string = magic-link sign-in disabled. Never contains a secret: the
   * app only uses it to talk to the public auth API.
   */
  neonAuthUrl: typeof runtime.neonAuthUrl === 'string' ? runtime.neonAuthUrl.replace(/\/+$/, '') : '',

  /** When false the app never calls the network, even if apiBaseUrl is set. */
  cloudEnabled: runtime.cloudEnabled !== false,

  /** localStorage keys. */
  storage: {
    state: 'spendwise.state.v1',
    backupPrefix: 'spendwise.backup',
    session: 'spendwise.session.v1',
    tenant: 'spendwise.tenant.v1',
    theme: 'spendwise.theme',
    uiPrefs: 'spendwise.ui.v1'
  },

  /** Hard limits (defensive caps). */
  limits: {
    maxImportRows: 20000,
    maxImportBytes: 10 * 1024 * 1024,
    maxBackupBytes: 25 * 1024 * 1024,
    maxBackups: 5,
    pageSize: 25,
    pageSizeOptions: [10, 25, 50, 100],
    maxTags: 20,
    maxTagLength: 40,
    maxString: {
      name: 120,
      description: 200,
      notes: 2000,
      payee: 120,
      url: 500
    }
  },

  /** Defaults used by the date-range picker. */
  ranges: [
    { id: 'today', label: 'Today' },
    { id: 'thisWeek', label: 'This Week' },
    { id: 'thisMonth', label: 'This Month' },
    { id: 'lastMonth', label: 'Last Month' },
    { id: 'last3Months', label: 'Last 3 Months' },
    { id: 'thisYear', label: 'This Year' },
    { id: 'lastYear', label: 'Last Year' },
    { id: 'allTime', label: 'All Time' },
    { id: 'custom', label: 'Custom Range' }
  ],

  /** Chart palette — kept in sync with tailwind.config.js. */
  chartColors: {
    income: '#10b981',
    expense: '#f43f5e',
    net: '#6366f1',
    savings: '#14b8a6',
    warning: '#f59e0b',
    grid: { light: 'rgba(148,163,184,.25)', dark: 'rgba(148,163,184,.18)' },
    tick: { light: '#64748b', dark: '#94a3b8' }
  }
});

export const isCloudConfigured = () => Boolean(appConfig.apiBaseUrl) && appConfig.cloudEnabled;

/** Magic-link sign-in needs Neon Auth configured in addition to cloud sync. */
export const isNeonAuthConfigured = () => isCloudConfigured() && Boolean(appConfig.neonAuthUrl);
