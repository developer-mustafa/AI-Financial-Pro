/**
 * Budgets screen.
 *
 * Shows every budget with live utilisation, supports weekly / monthly / yearly
 * budgets, overall or category scope, configurable alert thresholds, and full
 * CRUD (create, edit, pause, resume, archive, restore, delete).
 *
 * Utilisation follows the documented rule: only posted expenses inside the
 * budget window and currency count. Transfers, income and refunds never do.
 */

import { el, icon, clear, debounce } from '../../utils/dom.js';
import {
  amountField, badge, dataTable, dateField, dropdownMenu, emptyState, money, percent,
  progressBar, searchInput, sectionCard, selectField, statCard, textField, textareaField
} from '../../components/ui.js';
import { openModal } from '../../components/modal.js';
import { confirmDialog } from '../../components/confirmDialog.js';
import { BUDGET_PERIODS, CURRENCIES } from '../../config/defaults.js';
import { RESOURCES } from '../../core/state.js';
import { rangeLabel, todayISO } from '../../utils/date.js';
import { fromMinor } from '../../utils/currency.js';
import { exportBudgets } from '../../services/exportService.js';

const PROGRESS_TONE = { ok: 'savings', warning: 'warning', danger: 'warning', exceeded: 'expense' };

export function mount(container, ctx) {
  const { store, toast, services, router } = ctx;
  const service = services.budgets;
  const locale = store.preferences.locale;

  const ui = { q: '', phase: 'active' };

  const root = el('div', { class: 'space-y-4' });
  const summaryHolder = el('div', { class: 'grid gap-3 sm:grid-cols-2 xl:grid-cols-4' });
  const listHolder = el('div');
  root.append(summaryHolder, listHolder);
  container.appendChild(root);

  const fmt = (minor, currency) =>
    money(minor, { currency: currency || store.preferences.currency, locale, accounting: store.preferences.numberFormat === 'accounting' });

  const refreshDebounced = debounce(() => refresh(), 180);

  const refresh = () => {
    renderSummary();
    renderList();
  };

  /* --------------------------------------------------------------------- *
   * Summary
   * --------------------------------------------------------------------- */

  function renderSummary() {
    clear(summaryHolder);
    const everything = service.all();
    const rows = service.overview();
    let budgeted = 0;
    let spent = 0;
    let over = 0;
    for (const { budget, status } of rows) {
      budgeted += Number(budget.limitMinor) || 0;
      spent += status.spentMinor;
      if (status.overMinor > 0) over += status.overMinor;
    }
    const currency = rows[0]?.budget.currency || store.preferences.currency;
    const remaining = budgeted - spent;

    summaryHolder.appendChild(statCard({
      label: 'Active budgets',
      value: String(rows.length),
      iconName: 'target',
      tone: 'brand',
      sub: everything.length ? `${everything.length} total · ${everything.length - rows.length} inactive` : 'None created yet'
    }));
    summaryHolder.appendChild(statCard({
      label: 'Budgeted',
      value: fmt(budgeted, currency),
      iconName: 'wallet',
      tone: 'savings',
      sub: `Across ${rows.length} active budget${rows.length === 1 ? '' : 's'}`
    }));
    summaryHolder.appendChild(statCard({
      label: 'Spent',
      value: fmt(spent, currency),
      iconName: 'trending-down',
      tone: 'expense',
      sub: budgeted > 0 ? `${percent(budgeted > 0 ? (spent / budgeted) * 100 : 0, { locale })} of all budgeted limits` : 'No limits set'
    }));
    summaryHolder.appendChild(statCard({
      label: over > 0 ? 'Over budget' : 'Remaining',
      value: fmt(over > 0 ? over : remaining, currency),
      iconName: over > 0 ? 'triangle-alert' : 'piggy-bank',
      tone: over > 0 ? 'expense' : 'income',
      sub: over > 0 ? 'Across budgets that exceeded their limit' : 'Left to spend this period'
    }));
  }

  /* --------------------------------------------------------------------- *
   * List
   * --------------------------------------------------------------------- */

  function renderList() {
    clear(listHolder);
    const term = ui.q.trim().toLowerCase();
    const rows = service
      .rows()
      .filter(({ budget }) => {
        if (ui.phase === 'active') return !budget.archived && budget.status === 'active';
        if (ui.phase === 'paused') return !budget.archived && budget.status === 'paused';
        if (ui.phase === 'archived') return budget.archived;
        return true;
      })
      .filter(({ budget }) => (term ? budget.name.toLowerCase().includes(term) : true));

    listHolder.appendChild(sectionCard({
      title: 'Budgets',
      description: 'Utilisation uses posted expenses only. Transfers and income never count towards a budget.',
      actions: [
        el('button', {
          type: 'button',
          class: 'btn btn-secondary btn-sm',
          title: 'Export budgets to CSV',
          onclick: exportRows
        }, [icon('download', 'h-3.5 w-3.5'), el('span', { text: 'Export CSV' })]),
        el('button', { type: 'button', class: 'btn btn-primary btn-sm', onclick: () => openForm(null) }, [
          icon('plus', 'h-3.5 w-3.5'),
          el('span', { text: 'Add budget' })
        ])
      ],
      body: [
        el('div', { class: 'flex flex-wrap items-center gap-3' }, [
          searchInput({ value: ui.q, placeholder: 'Search budgets…', onInput: (value) => { ui.q = value; refreshDebounced(); }, class: 'sm:max-w-xs' }),
          el('select', {
            class: 'select !w-auto !py-1 !text-xs',
            'aria-label': 'Filter budgets',
            onchange: (event) => { ui.phase = event.target.value; refresh(); }
          }, [
            { value: 'active', label: 'Active' },
            { value: 'paused', label: 'Paused' },
            { value: 'archived', label: 'Archived' },
            { value: 'all', label: 'All' }
          ].map((option) => el('option', { value: option.value, selected: ui.phase === option.value, text: option.label })))
        ]),
        el('div', { class: 'mt-3' }, [
          rows.length === 0
            ? emptyState({
                iconName: 'target',
                title: ui.q ? 'No budgets match that search' : ui.phase === 'archived' ? 'No archived budgets' : 'No budgets yet',
                message: ui.q ? 'Try a different search term.' : 'Set a spending limit for a category or your overall spending and track it here.',
                actionLabel: ui.q ? null : 'Create your first budget',
                onAction: () => openForm(null)
              })
            : dataTable({
                caption: 'Budgets',
                columns: [
                  {
                    key: 'name',
                    label: 'Budget',
                    class: 'min-w-[15rem]',
                    render: ({ budget }) => el('div', { class: 'min-w-0' }, [
                      el('div', { class: 'flex flex-wrap items-center gap-2' }, [
                        el('p', { class: 'truncate text-sm font-medium text-slate-800 dark:text-slate-100', text: budget.name }),
                        budget.archived ? badge('Archived', 'neutral') : budget.status === 'paused' ? badge('Paused', 'warning') : null
                      ]),
                      el('p', { class: 'text-[11px] text-slate-400 dark:text-slate-500', text: budgetScopeLabel(budget) })
                    ])
                  },
                  {
                    key: 'period',
                    label: 'Period',
                    class: 'hidden md:table-cell',
                    render: ({ budget, status }) => el('div', { class: 'text-xs text-slate-500 dark:text-slate-400' }, [
                      el('span', { class: 'font-medium text-slate-600 dark:text-slate-300', text: periodLabel(budget.period) }),
                      el('span', { class: 'block', text: status ? rangeLabel(status.window, { locale }) : 'Not active right now' })
                    ])
                  },
                  {
                    key: 'usage',
                    label: 'Used',
                    class: 'min-w-[12rem]',
                    render: ({ budget, status }) => {
                      if (!status) return el('span', { class: 'text-xs text-slate-400 dark:text-slate-500', text: '—' });
                      return el('div', { class: 'space-y-1' }, [
                        progressBar({ percent: Math.min(100, status.percent), tone: PROGRESS_TONE[status.state] || 'savings', size: 'sm' }),
                        el('p', { class: 'num text-[11px] text-slate-500 dark:text-slate-400', text: `${fmt(status.spentMinor, budget.currency)} of ${fmt(budget.limitMinor, budget.currency)} · ${status.percent.toFixed(0)}%` })
                      ]);
                    }
                  },
                  {
                    key: 'remaining',
                    label: 'Remaining',
                    align: 'right',
                    render: ({ budget, status }) => {
                      if (!status) return el('span', { class: 'text-xs text-slate-400', text: '—' });
                      if (status.overMinor > 0) {
                        return el('div', { class: 'text-right' }, [
                          badge(`Over by ${fmt(status.overMinor, budget.currency)}`, 'expense')
                        ]);
                      }
                      return el('span', { class: 'num font-medium text-income-600 dark:text-income-400', text: fmt(status.remainingMinor, budget.currency) });
                    }
                  },
                  {
                    key: 'actions',
                    label: '',
                    align: 'right',
                    class: 'w-12',
                    render: ({ budget }) => dropdownMenu({
                      title: 'Budget actions',
                      items: [
                        { label: 'Edit', icon: 'pencil', onClick: () => openForm(budget) },
                        budget.categoryId
                          ? { label: 'View expenses', icon: 'list', onClick: () => router.navigate(`/expenses?category=${encodeURIComponent(budget.categoryId)}`) }
                          : null,
                        budget.archived
                          ? { label: 'Restore', icon: 'rotate-ccw', onClick: () => run(() => service.restore(budget.id), 'Budget restored', budget.name) }
                          : budget.status === 'paused'
                            ? { label: 'Resume', icon: 'play', onClick: () => run(() => service.resume(budget.id), 'Budget resumed', budget.name) }
                            : { label: 'Pause', icon: 'pause', onClick: () => run(() => service.pause(budget.id), 'Budget paused', budget.name) },
                        budget.archived
                          ? null
                          : { label: 'Archive', icon: 'archive', onClick: () => archive(budget) },
                        { divider: true },
                        { label: 'Delete permanently', icon: 'trash-2', variant: 'danger', onClick: () => remove(budget) }
                      ].filter(Boolean)
                    })
                  }
                ],
                rows
              })
        ])
      ],
      footer: [
        el('p', { class: 'text-[11px] text-slate-400 dark:text-slate-500', text: 'A category budget automatically includes its subcategories. Monthly budgets repeat for each month inside the start and end dates.' })
      ]
    }));
  }

  /* --------------------------------------------------------------------- *
   * Form
   * --------------------------------------------------------------------- */

  function openForm(budget = null) {
    const isEdit = Boolean(budget);
    const state = {
      name: budget?.name || '',
      period: budget?.period || 'monthly',
      scope: budget?.scope || 'overall',
      categoryId: budget?.categoryId || '',
      limit: budget ? formattedMajor(budget.limitMinor, budget.currency) : '',
      currency: budget?.currency || store.preferences.currency,
      startDate: budget?.startDate || todayISO(),
      endDate: budget?.endDate || `${new Date().getFullYear()}-12-31`,
      alertThresholds: (budget?.alertThresholds || store.preferences.alertThresholds || [75, 90, 100]).join(', '),
      status: budget?.status || 'active',
      notes: budget?.notes || ''
    };

    const errorBox = el('div', { class: 'hidden rounded-xl border border-expense-200 bg-expense-50 p-3 text-xs text-expense-700 dark:border-expense-500/30 dark:bg-expense-500/10 dark:text-expense-300', role: 'alert' });

    const nameField = textField({
      label: 'Name', name: 'name', value: state.name, required: true, maxlength: 120,
      placeholder: 'e.g. Monthly groceries', onInput: (value) => { state.name = value; }
    });
    const periodField = selectField({
      label: 'Period', name: 'period', value: state.period, options: BUDGET_PERIODS,
      hint: 'The limit resets each period while the budget is active.',
      onChange: (value) => { state.period = value; }
    });
    const scopeField = selectField({
      label: 'Scope', name: 'scope', value: state.scope,
      options: [{ value: 'overall', label: 'Overall spending' }, { value: 'category', label: 'A single category' }],
      onChange: (value) => { state.scope = value; renderCategory(); }
    });
    const categoryHolder = el('div');
    function renderCategory() {
      clear(categoryHolder);
      if (state.scope !== 'category') return;
      const options = service.categoryOptions();
      if (state.categoryId && !options.some((option) => option.value === state.categoryId)) state.categoryId = '';
      const categoryField = selectField({
        label: 'Category', name: 'categoryId', value: state.categoryId, required: true,
        options: [{ value: '', label: 'Choose category…', disabled: true }, ...options],
        hint: 'Subcategories of this category are included automatically.',
        onChange: (value) => { state.categoryId = value; }
      });
      categoryHolder.appendChild(categoryField.field);
      fields.categoryId = categoryField;
    }
    const amountField_ = amountField({
      label: 'Limit', name: 'limit', value: state.limit, currency: state.currency, required: true,
      hint: 'The maximum you intend to spend in each period.',
      onInput: (value) => { state.limit = value; }
    });
    const currencyField = selectField({
      label: 'Currency', name: 'currency', value: state.currency,
      options: CURRENCIES.map((currency) => ({ value: currency.code, label: currency.label })),
      onChange: (value) => { state.currency = value; }
    });
    const startField = dateField({ label: 'Start date', name: 'startDate', value: state.startDate, onChange: (value) => { state.startDate = value; } });
    const endField = dateField({ label: 'End date', name: 'endDate', value: state.endDate, onChange: (value) => { state.endDate = value; } });
    const thresholdsField = textField({
      label: 'Alert thresholds (%)', name: 'alertThresholds', value: state.alertThresholds,
      placeholder: '75, 90, 100', hint: 'Comma-separated percentages between 1 and 500.',
      onInput: (value) => { state.alertThresholds = value; }
    });
    const statusField = selectField({
      label: 'Status', name: 'status', value: state.status,
      options: [{ value: 'active', label: 'Active' }, { value: 'paused', label: 'Paused' }],
      onChange: (value) => { state.status = value; }
    });
    const notesField = textareaField({
      label: 'Notes', name: 'notes', value: state.notes, placeholder: 'Optional context', maxlength: 2000,
      onInput: (value) => { state.notes = value; }
    });

    const fields = { name: nameField, period: periodField, scope: scopeField, limit: amountField_, currency: currencyField, startDate: startField, endDate: endField, alertThresholds: thresholdsField, status: statusField };
    renderCategory();

    const form = el('form', { class: 'space-y-4', novalidate: true, onsubmit: (event) => event.preventDefault() }, [
      errorBox,
      nameField.field,
      el('div', { class: 'grid gap-4 sm:grid-cols-2' }, [periodField.field, scopeField.field]),
      categoryHolder,
      el('div', { class: 'grid gap-4 sm:grid-cols-2' }, [amountField_.field, currencyField.field]),
      el('div', { class: 'grid gap-4 sm:grid-cols-2' }, [startField.field, endField.field]),
      el('div', { class: 'grid gap-4 sm:grid-cols-2' }, [thresholdsField.field, statusField.field]),
      notesField.field
    ]);

    const submit = () => {
      for (const field of Object.values(fields)) field?.clearError?.();
      errorBox.classList.add('hidden');
      const input = {
        ...state,
        categoryId: state.scope === 'category' ? state.categoryId : null,
        alertThresholds: state.alertThresholds.split(',').map((value) => Number(value.trim())).filter((value) => value > 0)
      };
      const result = isEdit ? service.update(budget.id, input) : service.add(input);
      if (!result.ok) {
        errorBox.textContent = Object.values(result.errors)[0];
        errorBox.classList.remove('hidden');
        for (const [key, message] of Object.entries(result.errors)) fields[key]?.setError?.(message);
        return;
      }
      toast?.success(isEdit ? 'Budget updated' : 'Budget created', result.record.name);
      modal.close('saved');
      refresh();
    };

    const modal = openModal({
      title: isEdit ? 'Edit budget' : 'New budget',
      description: isEdit ? 'Changing the limit or dates updates utilisation immediately.' : undefined,
      size: 'md',
      content: form,
      footer: el('div', { class: 'flex items-center justify-end gap-2' }, [
        el('button', { type: 'button', class: 'btn btn-secondary', text: 'Cancel', onclick: () => modal.close('cancel') }),
        el('button', { type: 'button', class: 'btn btn-primary', text: isEdit ? 'Save changes' : 'Create budget', onclick: submit })
      ])
    });

    nameField.input.focus();
    return modal;
  }

  /* --------------------------------------------------------------------- *
   * Actions
   * --------------------------------------------------------------------- */

  async function archive(budget) {
    const ok = await confirmDialog({
      title: `Archive “${budget.name}”?`,
      message: 'It will stop counting towards alerts and totals, but its configuration is kept so you can restore it later.',
      confirmLabel: 'Archive',
      variant: 'primary',
      tone: 'warning'
    });
    if (!ok) return;
    run(() => service.archive(budget.id), 'Budget archived', budget.name);
  }

  async function remove(budget) {
    const ok = await confirmDialog({
      title: `Delete “${budget.name}”?`,
      message: 'The budget is removed permanently. Your transactions are not affected.',
      confirmLabel: 'Delete',
      variant: 'danger',
      tone: 'danger'
    });
    if (!ok) return;
    run(() => service.remove(budget.id), 'Budget deleted', budget.name);
  }

  function run(action, successTitle, detail) {
    const result = action();
    if (result.ok) {
      toast?.success(successTitle, detail);
      refresh();
    } else {
      toast?.error('Action failed', Object.values(result.errors)[0]);
    }
  }

  function exportRows() {
    const rows = service.rows();
    if (rows.length === 0) {
      toast?.warning('Nothing to export', 'There are no budgets yet.');
      return;
    }
    const csv = exportBudgets(rows, { categories: store.list(RESOURCES.CATEGORIES) });
    toast?.success('Export ready', `${rows.length} budget${rows.length === 1 ? '' : 's'} written to CSV.`);
    return csv;
  }

  /* --------------------------------------------------------------------- *
   * Helpers
   * --------------------------------------------------------------------- */

  function budgetScopeLabel(budget) {
    if (budget.scope !== 'category' || !budget.categoryId) return 'Overall spending';
    const category = store.byId(RESOURCES.CATEGORIES, budget.categoryId);
    return `Category · ${category ? category.name : 'Deleted category'}`;
  }

  function periodLabel(period) {
    return BUDGET_PERIODS.find((entry) => entry.value === period)?.label || period;
  }

  function formattedMajor(minor, currency) {
    return fromMinor(minor, currency).toFixed(currency === 'JPY' ? 0 : 2);
  }

  refresh();

  return {
    refresh,
    destroy() {
      refreshDebounced.cancel();
      clear(container);
    }
  };
}
