/**
 * Settings screen.
 *
 * Grouped into appearance, defaults, alerts, data & privacy, cloud sync and
 * about. Destructive operations (restore, erase) always confirm first, and a
 * restore takes a local snapshot of the current dataset before replacing it.
 *
 * The cloud section talks only to the Worker API through the injected services;
 * no database credential ever exists in this code or the browser.
 */

import { el, icon, clear } from '../../utils/dom.js';
import {
  badge, checkboxField, keyValueGrid, money, number, percent,
  progressBar, sectionCard, selectField, tabs, textField
} from '../../components/ui.js';
import { openModal } from '../../components/modal.js';
import { confirmDialog } from '../../components/confirmDialog.js';
import { CURRENCIES, LOCALES } from '../../config/defaults.js';
import { RESOURCES, createEmptyState } from '../../core/state.js';
import { appConfig, isCloudConfigured } from '../../config/appConfig.js';
import { t, LANGUAGES } from '../../i18n/index.js';
import { accountBalances, FINANCIAL_RULES } from '../../utils/calculations.js';
import { formatTimestamp } from '../../utils/date.js';
import { exportAllJson, exportTransactions, countState } from '../../services/exportService.js';
import { downloadBackup, restoreState, summarizeBackup } from '../../services/backupService.js';
import { buildTransactionImport, applyTransactionImport, parseBackupJson } from '../../services/importService.js';
import { listSnapshots } from '../../services/storageService.js';

export function mount(container, ctx) {
  const { store, toast, services, uiPrefs, theme, router } = ctx;
  const cloud = ctx.cloud || {};
  const locale = () => store.preferences.locale;

  /**
   * Cloud sign-in form state. Deliberately kept outside `cloudCard()` so a
   * re-render (tab switch, or the "check your email" step) never discards what
   * the user has typed.
   */
  const authForm = { mode: 'login', email: '', password: '', name: '', busy: false, linkSentTo: null };

  const root = el('div', { class: 'space-y-4' });
  container.appendChild(root);

  const fmt = (minor, currency) =>
    money(minor, { currency: currency || store.preferences.currency, locale: locale(), accounting: store.preferences.numberFormat === 'accounting' });

  const savePrefs = (patch, reason = 'preferences:update') =>
    store.apply(reason, (draft) => {
      draft.preferences = { ...draft.preferences, ...patch };
      return [{ resource: RESOURCES.PREFERENCES, op: 'upsert', record: draft.preferences }];
    });

  function refresh() {
    clear(root);
    root.append(
      appearanceCard(),
      defaultsCard(),
      alertsCard(),
      dataCard(),
      cloudCard(),
      aboutCard()
    );
  }

  /* ----------------------------------------------------------- Appearance */

  function appearanceCard() {
    const mode = theme?.mode || 'system';
    const themeTabs = tabs({
      items: [
        { id: 'light', label: t('settings.theme.light') },
        { id: 'dark', label: t('settings.theme.dark') },
        { id: 'system', label: t('settings.theme.system') }
      ],
      activeId: mode,
      ariaLabel: t('settings.theme'),
      onChange: (value) => {
        theme?.set(value);
        savePrefs({ theme: value }, 'preferences:theme');
        toast?.success(t('settings.theme.updated'), value === 'system' ? t('settings.theme.systemFollow') : t(`settings.theme.${value}`));
        refresh();
      }
    });

    const languageField = selectField({
      label: t('settings.language'), name: 'language', value: store.preferences.language || 'en',
      options: LANGUAGES.map((language) => ({ value: language.value, label: t(language.labelKey) })),
      hint: t('settings.language.hint'),
      onChange: (value) => { savePrefs({ language: value }); toast?.success(t('settings.language.updated')); }
    });

    const densityField = selectField({
      label: t('settings.density'), name: 'density', value: store.preferences.density,
      options: [{ value: 'comfortable', label: t('settings.density.comfortable') }, { value: 'compact', label: t('settings.density.compact') }],
      hint: t('settings.density.hint'),
      onChange: (value) => { savePrefs({ density: value }); applyDensity(value); toast?.success(t('settings.density.updated')); }
    });

    const sidebarToggle = checkboxField({
      label: t('settings.collapseSidebar'), name: 'sidebarCollapsed', checked: Boolean(uiPrefs.get('sidebarCollapsed', false)),
      hint: t('settings.collapseSidebar.hint'),
      onChange: (value) => { uiPrefs.set('sidebarCollapsed', value); ctx.sidebar?.paint?.(); }
    });

    return sectionCard({
      title: t('settings.appearance.title'),
      description: t('settings.appearance.description'),
      body: [
        el('div', { class: 'space-y-4' }, [
          el('div', { class: 'space-y-1.5' }, [
            el('span', { class: 'label', text: t('settings.theme') }),
            themeTabs
          ]),
          el('div', { class: 'grid gap-4 sm:grid-cols-2 xl:grid-cols-3' }, [
            languageField.field,
            densityField.field,
            el('div', {}, [sidebarToggle.field])
          ])
        ])
      ]
    });
  }

  function applyDensity(value) {
    document.documentElement.dataset.density = value === 'compact' ? 'compact' : 'comfortable';
  }

  /* -------------------------------------------------------------- Defaults */

  function defaultsCard() {
    const p = store.preferences;
    const accounts = store.list(RESOURCES.ACCOUNTS).map((account) => ({ value: account.id, label: `${account.name} · ${account.currency}` }));
    const debitCategories = store.orderedCategories().filter((c) => c.type === 'expense')
      .map((c) => ({ value: c.id, label: `${'— '.repeat(c.depth)}${c.name}` }));

    const currencyField = selectField({
      label: t('settings.defaultCurrency'), name: 'currency', value: p.currency,
      options: CURRENCIES.map((c) => ({ value: c.code, label: c.label })),
      onChange: (value) => { savePrefs({ currency: value }); toast?.success(t('settings.currency.updated')); }
    });
    const localeField = selectField({
      label: t('settings.locale'), name: 'locale', value: p.locale,
      options: LOCALES, onChange: (value) => { savePrefs({ locale: value }); toast?.success(t('settings.locale.updated')); }
    });
    const dateFormatField = selectField({
      label: t('settings.dateFormat'), name: 'dateFormat', value: p.dateFormat,
      options: [{ value: 'short', label: t('settings.dateFormat.short') }, { value: 'medium', label: t('settings.dateFormat.medium') }, { value: 'long', label: t('settings.dateFormat.long') }],
      onChange: (value) => savePrefs({ dateFormat: value })
    });
    const numberFormatField = selectField({
      label: t('settings.numberFormat'), name: 'numberFormat', value: p.numberFormat,
      options: [{ value: 'standard', label: t('settings.numberFormat.standard') }, { value: 'accounting', label: t('settings.numberFormat.accounting') }],
      onChange: (value) => savePrefs({ numberFormat: value })
    });
    const weekStartField = selectField({
      label: t('settings.weekStartsOn'), name: 'weekStart', value: String(p.weekStart ?? 0),
      options: [{ value: '0', label: t('settings.week.sunday') }, { value: '1', label: t('settings.week.monday') }, { value: '6', label: t('settings.week.saturday') }],
      onChange: (value) => savePrefs({ weekStart: Number(value) })
    });
    const rangeField = selectField({
      label: t('settings.defaultRange'), name: 'defaultRange', value: p.defaultRange,
      options: appConfig.ranges.filter((r) => r.id !== 'custom').map((r) => ({ value: r.id, label: t(`range.${r.id}`) })),
      onChange: (value) => savePrefs({ defaultRange: value })
    });
    const accountField = selectField({
      label: t('settings.defaultAccount'), name: 'defaultAccountId', value: p.defaultAccountId || '',
      options: [{ value: '', label: t('settings.firstAvailable') }, ...accounts],
      onChange: (value) => savePrefs({ defaultAccountId: value || null })
    });
    const paymentField = selectField({
      label: t('settings.defaultPaymentMethod'), name: 'defaultPaymentMethod', value: p.defaultPaymentMethod,
      options: [
        { value: 'cash', label: t('settings.payment.cash') }, { value: 'card', label: t('settings.payment.card') }, { value: 'bank', label: t('settings.payment.bank') },
        { value: 'mobile', label: t('settings.payment.mobile') }, { value: 'other', label: t('settings.payment.other') }
      ],
      onChange: (value) => savePrefs({ defaultPaymentMethod: value })
    });
    const categoryField = selectField({
      label: t('settings.defaultExpenseCategory'), name: 'defaultCategoryId', value: p.defaultCategoryId || '',
      options: [{ value: '', label: t('settings.none') }, ...debitCategories],
      onChange: (value) => savePrefs({ defaultCategoryId: value || null })
    });

    return sectionCard({
      title: t('settings.defaults.title'),
      description: t('settings.defaults.description'),
      body: [el('div', { class: 'grid gap-4 sm:grid-cols-2 xl:grid-cols-3' }, [
        currencyField.field, localeField.field, dateFormatField.field,
        numberFormatField.field, weekStartField.field, rangeField.field,
        accountField.field, paymentField.field, categoryField.field
      ])]
    });
  }

  /* ---------------------------------------------------------------- Alerts */

  function alertsCard() {
    const alertsToggle = checkboxField({
      label: t('settings.showBudgetAlerts'), name: 'budgetAlertsEnabled', checked: Boolean(store.preferences.budgetAlertsEnabled),
      hint: t('settings.showBudgetAlerts.hint'),
      onChange: (value) => { savePrefs({ budgetAlertsEnabled: value }); toast?.success(value ? t('settings.budgetAlerts.on') : t('settings.budgetAlerts.off')); }
    });
    const thresholdsField = textField({
      label: t('settings.alertThresholds'), name: 'alertThresholds', value: (store.preferences.alertThresholds || [75, 90, 100]).join(', '),
      placeholder: '75, 90, 100', hint: t('settings.alertThresholds.hint'),
      onInput: (value) => {
        const parsed = value.split(',').map((v) => Number(v.trim())).filter((v) => Number.isFinite(v) && v > 0 && v <= 500);
        savePrefs({ alertThresholds: parsed.length ? parsed : [75, 90, 100] });
      }
    });
    const recurrenceToggle = checkboxField({
      label: t('settings.promptRecurring'), name: 'recurrenceAutoPrompt', checked: Boolean(store.preferences.recurrenceAutoPrompt),
      hint: t('settings.promptRecurring.hint'),
      onChange: (value) => savePrefs({ recurrenceAutoPrompt: value })
    });
    return sectionCard({
      title: t('settings.alerts.title'),
      description: t('settings.alerts.description'),
      body: [el('div', { class: 'space-y-4' }, [
        alertsToggle.field,
        recurrenceToggle.field,
        thresholdsField.field
      ])]
    });
  }

  /* ----------------------------------------------------------- Data & privacy */

  function dataCard() {
    const state = store.get();
    const counts = countState(state);
    const usage = store.persistence?.usage?.() || null;
    const snapshots = listSnapshots();
    const corruptKeys = store.persistence?.corruptKeys?.() || [];

    const fileInput = el('input', {
      type: 'file', accept: '.csv,.json,text/csv,application/json', class: 'hidden',
      onchange: (event) => {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (file) void handleImportFile(file);
      }
    });
    const backupInput = el('input', {
      type: 'file', accept: '.json,application/json', class: 'hidden',
      onchange: (event) => {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (file) void handleRestoreFile(file);
      }
    });

    const body = [
      keyValueGrid([
        { label: t('settings.data.transactions'), value: String(counts.transactions) },
        { label: t('settings.data.accounts'), value: String(counts.accounts) },
        { label: t('settings.data.categories'), value: String(counts.categories) },
        { label: t('settings.data.budgets'), value: String(counts.budgets) },
        { label: t('settings.data.recurringRules'), value: String(counts.recurringRules) },
        { label: t('settings.data.goals'), value: String(counts.goals) }
      ], { columns: 3 }),
      usage
        ? el('div', { class: 'mt-4 space-y-1.5' }, [
            el('div', { class: 'flex items-center justify-between text-xs text-slate-500 dark:text-slate-400' }, [
              el('span', { text: t('settings.data.localStorageUsed') }),
              el('span', { class: 'num', text: `${number(usage.bytes, { locale: locale() })} bytes · ${percent(usage.percent, { locale: locale(), decimals: 0 })}` })
            ]),
            progressBar({ percent: usage.percent, tone: usage.percent > 85 ? 'expense' : usage.percent > 60 ? 'warning' : 'savings', size: 'sm' })
          ])
        : null,
      el('div', { class: 'mt-4 flex flex-wrap gap-2' }, [
        el('button', { type: 'button', class: 'btn btn-secondary btn-sm', onclick: exportTransactionsCsv }, [icon('file-text', 'h-3.5 w-3.5'), el('span', { text: t('settings.data.exportTransactionsCsv') })]),
        el('button', { type: 'button', class: 'btn btn-secondary btn-sm', onclick: exportFullJson }, [icon('braces', 'h-3.5 w-3.5'), el('span', { text: t('settings.data.exportEverythingJson') })]),
        el('button', { type: 'button', class: 'btn btn-secondary btn-sm', onclick: () => { downloadBackup(store.get(), { note: t('settings.data.manualBackup') }); toast?.success(t('settings.data.backupDownloaded')); } }, [icon('save', 'h-3.5 w-3.5'), el('span', { text: t('settings.data.downloadBackup') })]),
        el('button', { type: 'button', class: 'btn btn-secondary btn-sm', onclick: () => fileInput.click() }, [icon('upload', 'h-3.5 w-3.5'), el('span', { text: t('settings.data.importTransactions') })]),
        el('button', { type: 'button', class: 'btn btn-secondary btn-sm', onclick: () => backupInput.click() }, [icon('rotate-ccw', 'h-3.5 w-3.5'), el('span', { text: t('settings.data.restoreFromBackup') })]),
        el('button', { type: 'button', class: 'btn btn-danger-ghost btn-sm', onclick: eraseAll }, [icon('trash-2', 'h-3.5 w-3.5'), el('span', { text: t('settings.data.eraseAllData') })])
      ]),
      fileInput,
      backupInput
    ];

    if (snapshots.length) {
      body.push(el('div', { class: 'mt-4 border-t border-slate-100 pt-4 dark:border-slate-800' }, [
        el('p', { class: 'mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500', text: t('settings.data.snapshots') }),
        el('ul', { class: 'space-y-2' }, snapshots.map((snap) => el('li', { class: 'flex items-center justify-between gap-2 text-sm' }, [
          el('span', { class: 'text-slate-600 dark:text-slate-300', text: snap.createdAt ? formatTimestamp(snap.createdAt, { locale: locale() }) : snap.key }),
          el('button', { type: 'button', class: 'btn btn-secondary btn-sm', onclick: () => restoreSnapshot(snap) }, [icon('rotate-ccw', 'h-3 w-3'), el('span', { text: t('settings.data.restore') })])
        ])))
      ]));
    }

    if (corruptKeys.length) {
      body.push(el('div', { class: 'mt-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300' }, [
        el('p', { text: t('settings.data.corruptCount', { count: corruptKeys.length }) }),
        el('p', { class: 'mt-1 opacity-80', text: t('settings.data.corruptHint') })
      ]));
    }

    body.push(el('p', { class: 'mt-4 text-[11px] text-slate-400 dark:text-slate-500', text: t('settings.data.refundPolicy', { text: FINANCIAL_RULES.refunds }) }));

    return sectionCard({
      title: t('settings.data.title'),
      description: t('settings.data.description'),
      body
    });
  }

  function exportTransactionsCsv() {
    const rows = store.list(RESOURCES.TRANSACTIONS);
    if (!rows.length) return toast?.warning(t('settings.data.nothingToExport'), t('settings.data.nothingToExportMessage'));
    exportTransactions(rows, { categories: store.list(RESOURCES.CATEGORIES), accounts: store.list(RESOURCES.ACCOUNTS) });
    toast?.success(t('settings.data.exportReady'), t('settings.data.transactionsWritten', { count: rows.length }));
  }

  function exportFullJson() {
    const balances = accountBalances(store.list(RESOURCES.ACCOUNTS), store.list(RESOURCES.TRANSACTIONS));
    const budgets = services.budgets?.rows?.() || [];
    const goals = services.goals?.rows?.() || [];
    const recurring = (services.recurring?.all?.() || []).map((rule) => ({ rule, monthlyEquivalentMinor: services.recurring.monthlyEquivalent(rule) }));
    exportAllJson(store.get(), { balances, budgets, goals, recurring });
    toast?.success(t('settings.data.exportReady'), t('settings.data.fullExportGenerated'));
  }

  /* -------------------------------------------------------------- Import */

  async function handleImportFile(file) {
    const text = await file.text();
    const kind = file.name.toLowerCase().endsWith('.json') || text.trimStart().startsWith('{') || text.trimStart().startsWith('[') ? 'json' : 'csv';
    const plan = buildTransactionImport(text, {
      mode: kind,
      categories: store.list(RESOURCES.CATEGORIES),
      accounts: store.list(RESOURCES.ACCOUNTS),
      existingTransactions: store.list(RESOURCES.TRANSACTIONS),
      currency: store.preferences.currency,
      fallbackAccountId: store.preferences.defaultAccountId
    });
    if (!plan.ok) {
      toast?.error(t('settings.data.importFailed'), plan.fatal || t('settings.data.fileUnreadable'));
      return;
    }
    openImportPreview(file.name, plan);
  }

  function openImportPreview(filename, plan) {
    const { summary } = plan;
    const holder = el('div', { class: 'space-y-3' });
    holder.appendChild(keyValueGrid([
      { label: t('settings.import.rows'), value: String(summary.total) },
      { label: t('settings.import.ready'), value: String(summary.valid) },
      { label: t('settings.import.duplicates'), value: String(summary.duplicates) },
      { label: t('settings.import.withErrors'), value: String(summary.invalid) },
      { label: t('settings.import.newCategories'), value: String(summary.newCategories) },
      { label: t('settings.import.newAccounts'), value: String(summary.newAccounts) }
    ], { columns: 3 }));

    const includeDuplicates = checkboxField({
      label: t('settings.import.includeDuplicates'), name: 'includeDuplicates', checked: false,
      hint: t('settings.import.includeDuplicatesHint')
    });

    const previewRows = plan.entries.slice(0, 200).map((entry) => ({
      row: entry.rowNumber,
      date: entry.candidate?.date || '',
      description: entry.candidate?.description || entry.raw?.description || '',
      amount: entry.candidate?.amountMinor ?? '',
      status: entry.valid ? (entry.duplicate ? 'duplicate' : 'ready') : 'error',
      message: Object.values(entry.errors)[0] || ''
    }));

    holder.appendChild(el('div', { class: 'max-h-72 overflow-auto rounded-xl border border-slate-200 dark:border-slate-700' }, [
      el('table', { class: 'data' }, [
        el('thead', {}, el('tr', {}, [t('settings.import.colRow'), t('settings.import.colDate'), t('settings.import.colDescription'), t('settings.import.colStatus')].map((label) => el('th', { scope: 'col', text: label })))),
        el('tbody', {}, previewRows.map((row) => el('tr', {}, [
          el('td', { class: 'num text-xs', text: String(row.row) }),
          el('td', { class: 'num text-xs', text: row.date }),
          el('td', { class: 'text-xs', text: String(row.description).slice(0, 60) }),
          el('td', {}, [row.status === 'ready' ? badge(t('settings.import.readyBadge'), 'income') : row.status === 'duplicate' ? badge(t('settings.import.duplicateBadge'), 'warning') : badge(row.message || t('settings.import.errorBadge'), 'expense')])
        ])))
      ])
    ]));
    if (plan.entries.length > 200) {
      holder.appendChild(el('p', { class: 'text-[11px] text-slate-400', text: t('settings.import.showingFirst', { total: plan.entries.length }) }));
    }

    const modal = openModal({
      title: t('settings.import.title', { filename }),
      description: t('settings.import.description'),
      size: 'lg',
      content: holder,
      footer: el('div', { class: 'flex items-center justify-end gap-2' }, [
        el('button', { type: 'button', class: 'btn btn-secondary', text: t('settings.import.cancel'), onclick: () => modal.close('cancel') }),
        el('button', {
          type: 'button', class: 'btn btn-primary', text: t('settings.import.commit', { count: summary.valid }),
          onclick: () => {
            const result = applyTransactionImport(plan, { store, includeDuplicates: includeDuplicates.input.checked });
            toast?.success(t('settings.data.importComplete'), t('settings.data.importAdded', {
              added: result.added,
              skipped: result.skipped ? t('settings.data.importSkipped', { count: result.skipped }) : ''
            }));
            modal.close('imported');
            refresh();
          }
        })
      ])
    });
  }

  /* ------------------------------------------------------------- Restore */

  async function handleRestoreFile(file) {
    const text = await file.text();
    const parsed = parseBackupJson(text);
    if (!parsed.ok) {
      toast?.error(t('settings.data.restoreFailed'), parsed.error);
      return;
    }
    const summary = summarizeBackup({ counts: countState(parsed.state), appVersion: parsed.meta?.appVersion, exportedAt: parsed.meta?.exportedAt, schemaVersion: parsed.state.schemaVersion }, { locale: locale() });
    const ok = await confirmDialog({
      title: t('settings.data.replaceWithBackup'),
      message: t('settings.data.replaceWithBackupMessage', { summary: summary.label }),
      confirmLabel: t('settings.data.restoreBackup'),
      variant: 'danger',
      tone: 'danger'
    });
    if (!ok) return;
    const result = restoreState(store, parsed.state);
    toast?.success(t('settings.data.backupRestored'), t('settings.data.backupRestoredMessage', { count: result.after.transactions }));
    parsed.warnings?.forEach((warning) => toast?.warning(t('settings.data.restoreNote'), warning));
    refresh();
  }

  async function restoreSnapshot(snap) {
    const raw = store.persistence?.readRaw?.(snap.key);
    if (!raw) return toast?.error(t('settings.data.snapshotUnavailable'), t('settings.data.snapshotUnavailableMessage'));
    let state;
    try { state = JSON.parse(raw); } catch { return toast?.error(t('settings.data.corruptSnapshot'), t('settings.data.corruptSnapshotMessage')); }
    const ok = await confirmDialog({
      title: t('settings.data.restoreSnapshot'),
      message: t('settings.data.restoreSnapshotMessage'),
      confirmLabel: t('settings.data.restore'),
      variant: 'danger',
      tone: 'danger'
    });
    if (!ok) return;
    restoreState(store, state);
    toast?.success(t('settings.data.snapshotRestored'));
    refresh();
  }

  async function eraseAll() {
    const ok = await confirmDialog({
      title: t('settings.data.eraseTitle'),
      message: t('settings.data.eraseMessage'),
      confirmLabel: t('settings.data.eraseEverything'),
      variant: 'danger',
      tone: 'danger',
      requireText: 'ERASE'
    });
    if (!ok) return;
    await store.persistence?.clear?.();
    store.replaceState(createEmptyState(), 'erase-all');
    store.restoreDefaults();
    toast?.success(t('settings.data.erased'), t('settings.data.erasedMessage'));
    refresh();
  }

  /* --------------------------------------------------------------- Cloud */

  function cloudCard() {
    const configured = isCloudConfigured() || Boolean(cloud.configured);
    if (!configured) {
      return sectionCard({
        title: t('settings.cloud.title'),
        description: t('settings.cloud.optional'),
        body: [el('div', { class: 'space-y-2 text-sm text-slate-500 dark:text-slate-400' }, [
          el('p', { text: t('settings.cloud.localOnly') }),
          el('p', { class: 'text-xs', text: t('settings.cloud.credentialsNote') })
        ])]
      });
    }

    const auth = cloud.auth;
    const sync = cloud.sync;
    const signedIn = Boolean(auth?.signedIn);

    if (signedIn) {
      const user = auth.user || {};
      return sectionCard({
        title: t('settings.cloud.title'),
        description: t('settings.cloud.signedInAs', { who: user.email || user.name || t('settings.cloud.account') }),
        body: [el('div', { class: 'space-y-4' }, [
          keyValueGrid([
            { label: t('settings.cloud.account'), value: user.name || '—' },
            { label: t('settings.cloud.email'), value: user.email || '—' },
            { label: t('settings.cloud.method'), value: auth.provider === 'neon' ? t('settings.cloud.magicMethod') : t('settings.cloud.passwordMethod') },
            { label: t('settings.cloud.api'), value: appConfig.apiBaseUrl || '—' },
            { label: t('settings.cloud.mode'), value: sync?.mode || 'local' }
          ]),
          el('div', { class: 'flex flex-wrap gap-2' }, [
            el('button', { type: 'button', class: 'btn btn-primary btn-sm', onclick: pushCloud }, [icon('cloud-upload', 'h-3.5 w-3.5'), el('span', { text: t('settings.cloud.upload') })]),
            el('button', { type: 'button', class: 'btn btn-secondary btn-sm', onclick: pullCloud }, [icon('cloud-download', 'h-3.5 w-3.5'), el('span', { text: t('settings.cloud.download') })]),
            el('button', { type: 'button', class: 'btn btn-danger-ghost btn-sm', onclick: signOut }, [icon('log-out', 'h-3.5 w-3.5'), el('span', { text: t('settings.cloud.signOut') })])
          ])
        ])]
      });
    }

    const state = authForm;
    let submit = null;

    /** Shown after a magic link is requested. */
    const linkSentCard = () =>
      sectionCard({
        title: t('settings.cloud.title'),
        description: t('settings.cloud.linkSent', { email: state.linkSentTo }),
        body: [
          el('div', { class: 'space-y-4 text-sm text-slate-600 dark:text-slate-300' }, [
            el('p', {
              text: t('settings.cloud.checkInbox')
            }),
            el('div', { class: 'flex flex-wrap gap-2' }, [
              el('button', { type: 'button', class: 'btn btn-secondary btn-sm', onclick: () => void submit?.() }, [
                icon('mail', 'h-3.5 w-3.5'),
                el('span', { text: t('settings.cloud.resendLink') })
              ]),
              el('button', {
                type: 'button', class: 'btn btn-ghost btn-sm',
                onclick: () => { state.linkSentTo = null; refresh(); },
                text: t('settings.cloud.useDifferentEmail')
              })
            ])
          ])
        ]
      });

    if (state.linkSentTo) return linkSentCard();

    const modes = [
      { id: 'login', label: t('settings.cloud.signIn') },
      { id: 'register', label: t('settings.cloud.createAccount') }
    ];
    // Magic-link (passwordless) sign-in is offered only when Neon Auth is wired up.
    const magicLinkAvailable = Boolean(cloud.neonConfigured || auth.neonEnabled);
    if (magicLinkAvailable) modes.push({ id: 'magic', label: t('settings.cloud.emailLink') });

    const errorBox = el('div', { class: 'hidden rounded-xl border border-expense-200 bg-expense-50 p-3 text-xs text-expense-700 dark:border-expense-500/30 dark:bg-expense-500/10 dark:text-expense-300' });
    const nameField = textField({ label: t('settings.cloud.name'), name: 'name', value: state.name, hint: t('settings.cloud.nameHint'), onInput: (v) => { state.name = v; } });
    const emailField = textField({ label: t('settings.cloud.emailField'), name: 'email', type: 'email', value: state.email, required: true, onInput: (v) => { state.email = v; } });
    const passwordField = textField({ label: t('settings.cloud.passwordField'), name: 'password', type: 'password', value: state.password, required: true, hint: t('settings.cloud.passwordHint'), onInput: (v) => { state.password = v; } });

    const fieldByKey = { name: nameField, email: emailField, password: passwordField };
    const clearFieldErrors = () => Object.values(fieldByKey).forEach((f) => f.clearError());
    /** Highlight the fields named in `error.details`; true when any were shown. */
    const showFieldErrors = (details) => {
      if (!details || typeof details !== 'object') return false;
      let shown = false;
      for (const [key, errorField] of Object.entries(fieldByKey)) {
        if (details[key]) { errorField.setError(details[key]); shown = true; }
        else errorField.clearError();
      }
      return shown;
    };
    const modeTabs = tabs({
      items: modes,
      activeId: state.mode,
      ariaLabel: t('settings.cloud.method'),
      onChange: (value) => { state.mode = value; refresh(); }
    });
    nameField.field.classList.toggle('hidden', state.mode !== 'register');
    passwordField.field.classList.toggle('hidden', state.mode === 'magic');

    const submitButton = el('button', {
      type: 'submit',
      class: 'btn btn-primary',
      text: state.mode === 'register' ? t('settings.cloud.submitRegister') : state.mode === 'magic' ? t('settings.cloud.submitMagic') : t('settings.cloud.submitSignIn')
    });

    submit = async () => {
      errorBox.classList.add('hidden');
      clearFieldErrors();
      if (!auth || state.busy) return;
      state.busy = true;
      submitButton.disabled = true;
      try {
        if (state.mode === 'magic') {
          const email = await auth.sendMagicLink({ email: state.email });
          state.linkSentTo = email;
          toast?.success(t('settings.cloud.linkSentToastTitle'), t('settings.cloud.linkSentToastMessage', { email }));
          refresh();
          return;
        }
        if (state.mode === 'register') await auth.register({ email: state.email, password: state.password, name: state.name });
        else await auth.login({ email: state.email, password: state.password });
        toast?.success(state.mode === 'register' ? t('settings.cloud.accountCreated') : t('settings.cloud.signedInToast'));
        refresh();
      } catch (error) {
        // Client-side validation carries per-field messages in `details`; show
        // them on the fields themselves instead of a bare summary sentence.
        const highlighted = showFieldErrors(error?.details);
        errorBox.textContent = highlighted
          ? t('settings.cloud.correctFields')
          : error?.message || t('settings.cloud.authFailed');
        errorBox.classList.remove('hidden');
        const firstBad = Object.keys(fieldByKey).map((k) => fieldByKey[k]).find((f) => f.input?.getAttribute('aria-invalid') === 'true');
        firstBad?.focus?.();
      } finally {
        state.busy = false;
        submitButton.disabled = false;
      }
    };

    return sectionCard({
      title: t('settings.cloud.title'),
      description: magicLinkAvailable
        ? t('settings.cloud.description')
        : t('settings.cloud.descriptionPassword'),
      body: [el('form', { class: 'space-y-4', novalidate: true, onsubmit: (e) => { e.preventDefault(); void submit(); } }, [
        errorBox,
        modeTabs,
        nameField.field,
        el('div', { class: 'grid gap-4 sm:grid-cols-2' }, [emailField.field, passwordField.field]),
        state.mode === 'magic'
          ? el('p', { class: 'text-xs text-slate-500 dark:text-slate-400', text: t('settings.cloud.magicNote') })
          : null,
        el('div', { class: 'flex justify-end' }, [submitButton])
      ].filter(Boolean))]
    });
  }

  async function pushCloud() {
    const sync = ctx.cloud?.sync;
    if (!sync) return;
    try {
      await sync.push(store.get());
      toast?.success(t('settings.cloud.uploaded'), t('settings.cloud.uploadedMessage'));
    } catch (error) {
      toast?.error(t('settings.cloud.uploadFailed'), error?.message || t('settings.cloud.tryAgain'));
    }
  }

  async function pullCloud() {
    const sync = ctx.cloud?.sync;
    if (!sync) return;
    const ok = await confirmDialog({
      title: t('settings.cloud.downloadTitle'),
      message: t('settings.cloud.downloadMessage'),
      confirmLabel: t('settings.cloud.download'),
      variant: 'danger',
      tone: 'warning'
    });
    if (!ok) return;
    try {
      const remote = await sync.pull();
      if (!remote) {
        toast?.warning(t('settings.cloud.nothingToDownload'), t('settings.cloud.emptyCloud'));
        return;
      }
      restoreState(store, remote);
      toast?.success(t('settings.cloud.downloaded'), t('settings.cloud.downloadedMessage'));
      refresh();
    } catch (error) {
      toast?.error(t('settings.cloud.downloadFailed'), error?.message || t('settings.cloud.tryAgain'));
    }
  }

  async function signOut() {
    await ctx.cloud?.auth?.logout?.();
    toast?.success(t('settings.cloud.signedOut'));
    refresh();
  }

  /* --------------------------------------------------------------- About */

  function aboutCard() {
    return sectionCard({
      title: t('settings.about.title'),
      description: `${appConfig.appName} ${appConfig.version} · schema v${appConfig.schemaVersion}`,
      body: [
        el('div', { class: 'space-y-4' }, [
          el('p', { class: 'text-sm text-slate-600 dark:text-slate-300', text: t('settings.about.body') }),
          keyValueGrid(Object.values(FINANCIAL_RULES).map((rule, index) => ({ label: t('settings.about.rule', { n: index + 1 }), value: rule })), { columns: 1 })
        ])
      ]
    });
  }

  applyDensity(store.preferences.density);
  refresh();

  return {
    refresh,
    destroy() {
      clear(container);
    }
  };
}
