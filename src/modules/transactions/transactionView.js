/**
 * Transactions / Income / Expenses list view.
 *
 * One implementation serves all three screens (`mode` only pre-locks the type
 * filter). Includes debounced search, multi-criteria filtering, sorting,
 * paging, bulk selection, bulk delete, CSV export of the current selection,
 * row actions and an accessible card layout on small screens.
 *
 * Rendering strategy: the filter panel is built ONCE and never re-rendered by
 * a results refresh, so typing in the search box does not lose focus. Only the
 * chips row, the result area, the totals and the pagination are updated.
 */

import { el, icon, clear, debounce } from '../../utils/dom.js';
import {
  dataTable, emptyState, filterChip, iconTile, labels, pagination, searchInput,
  statusBadge, typeBadge, badge, dropdownMenu
} from '../../components/ui.js';
import { openModal } from '../../components/modal.js';
import { confirmDialog, confirmDelete } from '../../components/confirmDialog.js';
import { SORT_OPTIONS, EMPTY_FILTERS } from './transactionService.js';
import { openTransactionForm } from './transactionForm.js';
import { RESOURCES } from '../../core/state.js';
import { PAYMENT_METHODS, TRANSACTION_STATUSES, TRANSACTION_TYPES } from '../../config/defaults.js';
import { appConfig } from '../../config/appConfig.js';
import { formatDate, formatMonth, monthKey, resolveRange } from '../../utils/date.js';
import { downloadCsv, transactionRows } from '../../services/exportService.js';
import { formatMoney, normalizeCurrency } from '../../utils/currency.js';
import { recurringMonthlyEquivalent } from '../../utils/calculations.js';
import { t, rangeLabel } from '../../i18n/index.js';

const MODE_INFO = {
  all: { title: 'tx.mode.all.title', description: 'tx.mode.all.desc' },
  income: { title: 'tx.mode.income.title', description: 'tx.mode.income.desc' },
  expense: { title: 'tx.mode.expense.title', description: 'tx.mode.expense.desc' }
};

export function createTransactionListView({ mode = 'all' } = {}) {
  return { mount: (container, ctx) => mountList(container, ctx, mode) };
}

export function mount(container, ctx) {
  return mountList(container, ctx, 'all');
}

function mountList(container, ctx, mode) {
  const { store, toast, services } = ctx;
  const service = services.transactions;
  const locale = store.preferences.locale;

  const filters = {
    ...EMPTY_FILTERS,
    type: mode === 'income' ? 'income' : mode === 'expense' ? 'expense' : '',
    rangePreset: 'any'
  };
  const selection = new Set();

  // Deep links (e.g. from Categories → "View transactions") seed the filters.
  const seed = ctx.route?.query;
  if (seed) {
    if (seed.get('category')) filters.categoryId = seed.get('category');
    if (seed.get('account')) filters.accountId = seed.get('account');
    if (seed.get('type') && mode === 'all') filters.type = seed.get('type');
    if (seed.get('q')) filters.q = seed.get('q');
    if (seed.get('from')) {
      filters.from = seed.get('from');
      filters.rangePreset = 'custom';
    }
    if (seed.get('to')) {
      filters.to = seed.get('to');
      filters.rangePreset = 'custom';
    }
    if (seed.get('tag')) filters.tags = seed.get('tag').split(',').filter(Boolean);
  }

  /* --------------------------------------------------------------------- *
   * Shell (built once)
   * --------------------------------------------------------------------- */

  const chipsHolder = el('div', { class: 'flex flex-wrap items-center gap-2' });
  const metaHolder = el('div', { class: 'flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500 dark:text-slate-400' });
  const resultsHolder = el('div');
  const totalsHolder = el('div');
  const paginationHolder = el('div');
  const filterHolder = el('div', { class: 'grid gap-3 md:grid-cols-2 lg:grid-cols-4' });
  const selectionBar = el('div');
  const insightsHolder = el('div');

  const card = el('section', { class: 'card' }, [
    el('div', { class: 'flex flex-wrap items-start justify-between gap-2 border-b border-slate-100 px-4 py-3 sm:px-5 dark:border-slate-800' }, [
      el('div', { class: 'min-w-0' }, [
        el('h2', { class: 'card-title', text: t(MODE_INFO[mode].title) }),
        el('p', { class: 'mt-0.5 text-xs text-slate-500 dark:text-slate-400', text: t(MODE_INFO[mode].description) })
      ]),
      el('div', { class: 'flex flex-wrap items-center gap-2' }, [
        el('button', {
          type: 'button',
          class: 'btn btn-secondary btn-sm',
          title: t('tx.exportCsvTitle'),
          onclick: () => exportRows(currentResult?.filtered || [], `spendwise-${mode}-filtered`)
        }, [icon('download', 'h-3.5 w-3.5'), el('span', { text: t('tx.exportCsv') })]),
        el('button', { type: 'button', class: 'btn btn-primary btn-sm', onclick: () => openForm(null) }, [
          icon('plus', 'h-3.5 w-3.5'),
          el('span', { text: t('tx.add') })
        ])
      ])
    ]),
    el('div', { class: 'space-y-3 px-4 py-4 sm:px-5' }, [
      filterHolder,
      chipsHolder,
      selectionBar,
      insightsHolder,
      metaHolder,
      resultsHolder,
      totalsHolder
    ]),
    paginationHolder
  ]);

  container.appendChild(card);

  /* --------------------------------------------------------------------- *
   * Filter panel (rendered only when its own option list changes)
   * --------------------------------------------------------------------- */

  function renderFilterPanel() {
    clear(filterHolder);
    const categories = store.orderedCategories(filters.type === 'income' ? 'income' : filters.type === 'expense' ? 'expense' : null);
    const accounts = store.list(RESOURCES.ACCOUNTS);

    filterHolder.appendChild(searchInput({
      value: filters.q,
      placeholder: t('tx.searchPlaceholder'),
      onInput: (value) => {
        filters.q = value;
        filters.page = 1;
        refreshDebounced();
      }
    }));

    if (mode === 'all') {
      filterHolder.appendChild(el('select', {
        class: 'select',
        'aria-label': t('tx.filterType'),
        onchange: (event) => {
          filters.type = event.target.value;
          filters.categoryId = '';
          filters.page = 1;
          renderFilterPanel();
          refresh();
        }
      }, [
        el('option', { value: '', selected: filters.type === '', text: t('tx.allTypes') }),
        ...TRANSACTION_TYPES.map((type) => el('option', { value: type.value, selected: filters.type === type.value, text: labels.transactionType(type.value) }))
      ]));
    } else {
      filterHolder.appendChild(el('div', { class: 'hidden md:block' }));
    }

    filterHolder.appendChild(el('select', {
      class: 'select',
      'aria-label': t('tx.filterCategory'),
      onchange: (event) => {
        filters.categoryId = event.target.value;
        filters.page = 1;
        refresh();
      }
    }, [
      el('option', { value: '', selected: filters.categoryId === '', text: t('tx.allCategories') }),
      ...categories.map((category) => el('option', {
        value: category.id,
        selected: filters.categoryId === category.id,
        text: `${'— '.repeat(category.depth)}${category.name}${category.archived ? ` ${t('tx.archived')}` : ''}`
      }))
    ]));

    filterHolder.appendChild(el('select', {
      class: 'select',
      'aria-label': t('tx.filterAccount'),
      onchange: (event) => {
        filters.accountId = event.target.value;
        filters.page = 1;
        refresh();
      }
    }, [
      el('option', { value: '', selected: filters.accountId === '', text: t('tx.allAccounts') }),
      ...accounts.map((account) => el('option', { value: account.id, selected: filters.accountId === account.id, text: `${account.name}${account.archived ? ` ${t('tx.archived')}` : ''}` }))
    ]));

    filterHolder.appendChild(el('select', {
      class: 'select',
      'aria-label': t('tx.dateRange'),
      onchange: (event) => {
        const preset = event.target.value;
        filters.rangePreset = preset;
        if (preset === 'custom') {
          renderFilterPanel();
          return;
        }
        if (preset === 'any') {
          filters.from = '';
          filters.to = '';
        } else {
          const range = resolveRange(preset, { weekStart: store.preferences.weekStart ?? 0 });
          filters.from = range.from;
          filters.to = range.to;
        }
        filters.page = 1;
        refresh();
      }
    }, [
      el('option', { value: 'any', selected: filters.rangePreset === 'any', text: t('tx.anyTime') }),
      ...appConfig.ranges.map((range) => el('option', { value: range.id, selected: filters.rangePreset === range.id, text: rangeLabel(range.id) }))
    ]));

    if (filters.rangePreset === 'custom') {
      filterHolder.appendChild(el('div', { class: 'grid grid-cols-2 gap-2 md:col-span-2' }, [
        el('div', {}, [
          el('span', { class: 'label', text: t('tx.from') }),
          el('input', {
            type: 'date',
            class: 'input',
            value: filters.from,
            'aria-label': t('tx.fromDate'),
            onchange: (event) => {
              filters.from = event.target.value;
              filters.page = 1;
              refresh();
            }
          })
        ]),
        el('div', {}, [
          el('span', { class: 'label', text: t('tx.to') }),
          el('input', {
            type: 'date',
            class: 'input',
            value: filters.to,
            'aria-label': t('tx.toDate'),
            onchange: (event) => {
              filters.to = event.target.value;
              filters.page = 1;
              refresh();
            }
          })
        ])
      ]));
    }

    filterHolder.appendChild(el('select', {
      class: 'select',
      'aria-label': t('tx.paymentMethodFilter'),
      onchange: (event) => {
        filters.paymentMethod = event.target.value;
        filters.page = 1;
        refresh();
      }
    }, [
      el('option', { value: '', selected: filters.paymentMethod === '', text: t('tx.anyPaymentMethod') }),
      ...PAYMENT_METHODS.map((method) => el('option', { value: method.value, selected: filters.paymentMethod === method.value, text: labels.paymentMethod(method.value) }))
    ]));

    filterHolder.appendChild(el('select', {
      class: 'select',
      'aria-label': t('tx.statusFilter'),
      onchange: (event) => {
        filters.status = event.target.value;
        filters.page = 1;
        refresh();
      }
    }, [
      el('option', { value: '', selected: filters.status === '', text: t('tx.postedPending') }),
      ...TRANSACTION_STATUSES.map((status) => el('option', { value: status.value, selected: filters.status === status.value, text: t(`status.${status.value}`) }))
    ]));

    filterHolder.appendChild(el('div', { class: 'grid grid-cols-2 gap-2' }, [
      el('div', {}, [
        el('span', { class: 'label', text: t('tx.minAmount') }),
        el('input', {
          type: 'number',
          min: '0',
          step: '0.01',
          class: 'input',
          value: filters.min,
          'aria-label': t('tx.minimumAmount'),
          oninput: (event) => {
            filters.min = event.target.value;
            filters.page = 1;
            refreshDebounced();
          }
        })
      ]),
      el('div', {}, [
        el('span', { class: 'label', text: t('tx.maxAmount') }),
        el('input', {
          type: 'number',
          min: '0',
          step: '0.01',
          class: 'input',
          value: filters.max,
          'aria-label': t('tx.maximumAmount'),
          oninput: (event) => {
            filters.max = event.target.value;
            filters.page = 1;
            refreshDebounced();
          }
        })
      ])
    ]));

    filterHolder.appendChild(el('div', {}, [
      el('span', { class: 'label', text: t('tx.tagsFilter') }),
      el('input', {
        type: 'text',
        class: 'input',
        value: (filters.tags || []).join(', '),
        placeholder: t('tx.tagsPlaceholder'),
        'aria-label': t('tx.filterTags'),
        oninput: (event) => {
          filters.tags = event.target.value.split(',').map((tag) => tag.trim()).filter(Boolean);
          filters.page = 1;
          refreshDebounced();
        }
      })
    ]));
  }

  /* --------------------------------------------------------------------- *
   * Filter chips
   * --------------------------------------------------------------------- */

  function renderChips() {
    clear(chipsHolder);
    chipsHolder.toggleAttribute('hidden', false);
    const chips = [];
    const category = store.byId(RESOURCES.CATEGORIES, filters.categoryId);
    const account = store.byId(RESOURCES.ACCOUNTS, filters.accountId);

    if (filters.q) chips.push({ label: t('tx.chip.search'), value: filters.q, clear: () => { filters.q = ''; } });
    if (mode === 'all' && filters.type) chips.push({ label: t('tx.chip.type'), value: labels.transactionType(filters.type), clear: () => { filters.type = ''; } });
    if (category) chips.push({ label: t('tx.chip.category'), value: category.name, clear: () => { filters.categoryId = ''; } });
    if (account) chips.push({ label: t('tx.chip.account'), value: account.name, clear: () => { filters.accountId = ''; } });
    if (filters.paymentMethod) chips.push({ label: t('tx.chip.method'), value: labels.paymentMethod(filters.paymentMethod), clear: () => { filters.paymentMethod = ''; } });
    if (filters.status) chips.push({ label: t('tx.chip.status'), value: t(`status.${filters.status}`), clear: () => { filters.status = ''; } });
    if (filters.from || filters.to) {
      chips.push({ label: t('tx.chip.dates'), value: `${filters.from || '…'} → ${filters.to || '…'}`, clear: () => { filters.from = ''; filters.to = ''; filters.rangePreset = 'any'; } });
    }
    if (filters.min !== '') chips.push({ label: t('tx.chip.min'), value: String(filters.min), clear: () => { filters.min = ''; } });
    if (filters.max !== '') chips.push({ label: t('tx.chip.max'), value: String(filters.max), clear: () => { filters.max = ''; } });
    for (const tag of filters.tags || []) {
      chips.push({ label: t('tx.chip.tag'), value: tag, clear: () => { filters.tags = filters.tags.filter((candidate) => candidate !== tag); } });
    }

    chipsHolder.toggleAttribute('hidden', chips.length === 0);
    for (const chip of chips) {
      chipsHolder.appendChild(filterChip({
        label: chip.label,
        value: chip.value,
        onRemove: () => {
          chip.clear();
          filters.page = 1;
          renderFilterPanel();
          refresh();
        }
      }));
    }
    if (chips.length) {
      chipsHolder.appendChild(el('button', {
        type: 'button',
        class: 'chip',
        onclick: () => {
          resetFilters();
          renderFilterPanel();
          refresh();
        }
      }, [icon('x', 'h-3 w-3'), el('span', { text: t('tx.clearAllFilters') })]));
    }
  }

  /* --------------------------------------------------------------------- *
   * Row pieces
   * --------------------------------------------------------------------- */

  const fmt = (minor, currency) => formatMoney(minor, { currency: currency || store.preferences.currency, locale });

  function amountCell(tx) {
    const sign = tx.type === 'income' ? '+' : tx.type === 'expense' ? '−' : '';
    const tone = tx.type === 'income'
      ? 'text-income-600 dark:text-income-400'
      : tx.type === 'expense'
        ? 'text-expense-600 dark:text-expense-400'
        : 'text-brand-600 dark:text-brand-300';
    return el('span', {
      class: `num font-semibold ${tone}`,
      title: tx.type === 'transfer' ? t('tx.transferTitle') : undefined,
      text: `${sign}${fmt(tx.amountMinor, tx.currency)}`
    });
  }

  function categoryCell(tx) {
    if (tx.type === 'transfer') {
      return el('span', { class: 'inline-flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400' }, [
        icon('arrow-left-right', 'h-3.5 w-3.5'),
        el('span', { class: 'truncate', text: `${store.accountName(tx.accountId)} → ${store.accountName(tx.toAccountId)}` })
      ]);
    }
    const category = store.byId(RESOURCES.CATEGORIES, tx.categoryId);
    return el('span', { class: 'inline-flex min-w-0 items-center gap-2' }, [
      iconTile(category?.icon || 'circle-ellipsis', category?.color || '#94a3b8', 'sm'),
      el('span', { class: 'truncate text-slate-700 dark:text-slate-200', text: category?.name || (tx.categoryId ? t('tx.deletedCategory') : t('tx.uncategorised')) })
    ]);
  }

  function descriptionCell(tx) {
    return el('div', { class: 'min-w-0' }, [
      el('p', { class: 'truncate font-medium text-slate-800 dark:text-slate-100', text: tx.description || store.categoryName(tx.categoryId) || t('tx.noDescription') }),
      el('div', { class: 'mt-0.5 flex flex-wrap items-center gap-1.5' }, [
        tx.payee ? el('span', { class: 'truncate text-[11px] text-slate-400 dark:text-slate-500', text: tx.payee }) : null,
        statusBadge(tx.status),
        ...(tx.tags || []).slice(0, 3).map((tag) => badge(`#${tag}`, 'neutral'))
      ])
    ]);
  }

  function rowActions(tx) {
    return dropdownMenu({
      title: t('tx.actions'),
      items: [
        { label: t('tx.viewDetails'), icon: 'eye', onClick: () => openDetails(tx) },
        { label: t('tx.edit'), icon: 'pencil', onClick: () => openForm(tx) },
        { label: t('tx.duplicate'), icon: 'copy', onClick: () => duplicate(tx) },
        { divider: true },
        { label: t('tx.delete'), icon: 'trash-2', variant: 'danger', onClick: () => remove(tx) }
      ]
    });
  }

  function selectionCheckbox(tx) {
    const input = el('input', {
      type: 'checkbox',
      class: 'h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500 dark:border-slate-600 dark:bg-slate-800',
      checked: selection.has(tx.id),
      'aria-label': t('tx.selectNamed', { name: tx.description || t('tx.aTransaction') })
    });
    input.addEventListener('change', () => {
      if (input.checked) selection.add(tx.id);
      else selection.delete(tx.id);
      refresh();
    });
    return input;
  }

  function renderResults(result) {
    clear(resultsHolder);

    if (result.total === 0) {
      resultsHolder.appendChild(emptyState({
        iconName: store.isEmpty() ? 'sparkles' : 'search-x',
        title: store.isEmpty() ? t('tx.empty.title') : t('tx.noMatch.title'),
        message: store.isEmpty()
          ? t('tx.empty.message')
          : t('tx.noMatch.message'),
        actionLabel: store.isEmpty() ? t('tx.empty.action') : t('tx.noMatch.action'),
        onAction: () => {
          if (store.isEmpty()) return openForm(null);
          resetFilters();
          renderFilterPanel();
          refresh();
        }
      }));
      return;
    }

    const headerCheckbox = el('input', {
      type: 'checkbox',
      class: 'h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500 dark:border-slate-600 dark:bg-slate-800',
      checked: result.rows.length > 0 && result.rows.every((tx) => selection.has(tx.id)),
      'aria-label': t('tx.selectAllPage')
    });
    headerCheckbox.addEventListener('change', () => {
      if (headerCheckbox.checked) result.rows.forEach((tx) => selection.add(tx.id));
      else result.rows.forEach((tx) => selection.delete(tx.id));
      refresh();
    });

    const columns = [
      { key: 'select', label: '', class: 'w-10', headerRender: () => headerCheckbox, render: (tx) => selectionCheckbox(tx) },
      { key: 'date', label: t('tx.col.date'), render: (tx) => el('span', { class: 'num whitespace-nowrap text-slate-600 dark:text-slate-300', text: formatDate(tx.date, { locale, format: store.preferences.dateFormat }) }) },
      { key: 'description', label: t('tx.col.description'), class: 'min-w-[13rem]', render: descriptionCell },
      { key: 'category', label: t('tx.col.category'), class: 'min-w-[9rem]', render: categoryCell },
      { key: 'account', label: t('tx.col.account'), render: (tx) => el('span', { class: 'whitespace-nowrap text-slate-600 dark:text-slate-300', text: store.accountName(tx.accountId) }) },
      { key: 'paymentMethod', label: t('tx.col.method'), class: 'hidden xl:table-cell', render: (tx) => el('span', { class: 'whitespace-nowrap text-slate-500 dark:text-slate-400', text: labels.paymentMethod(tx.paymentMethod) }) },
      { key: 'type', label: t('tx.col.type'), render: (tx) => typeBadge(tx.type) },
      { key: 'amount', label: t('tx.col.amount'), align: 'right', render: amountCell },
      { key: 'actions', label: '', align: 'right', class: 'w-12', render: rowActions }
    ];

    const table = dataTable({
      columns,
      rows: result.rows,
      rowKey: (tx) => tx.id,
      onRowClick: (tx) => openDetails(tx),
      caption: t('nav.transactions')
    });

    const cards = el('div', { class: 'divide-y divide-slate-100 md:hidden dark:divide-slate-800' }, result.rows.map((tx) =>
      el('article', { class: 'flex items-start gap-3 py-4' }, [
        selectionCheckbox(tx),
        el('div', { class: 'min-w-0 flex-1' }, [
          el('div', { class: 'flex items-start justify-between gap-3' }, [
            descriptionCell(tx),
            amountCell(tx)
          ]),
          el('div', { class: 'mt-2 flex flex-wrap items-center gap-2 text-[11px] text-slate-500 dark:text-slate-400' }, [
            el('span', { class: 'num', text: formatDate(tx.date, { locale, format: store.preferences.dateFormat }) }),
            el('span', { text: '·' }),
            categoryCell(tx),
            el('span', { text: '·' }),
            el('span', { text: store.accountName(tx.accountId) })
          ]),
          el('div', { class: 'mt-2 flex items-center justify-end gap-2' }, [
            el('button', { type: 'button', class: 'btn btn-secondary btn-sm', text: t('tx.details'), onclick: () => openDetails(tx) }),
            rowActions(tx)
          ])
        ])
      ])
    ));

    resultsHolder.appendChild(el('div', { class: 'hidden md:block' }, [table]));
    resultsHolder.appendChild(cards);
  }

  function renderMeta(result) {
    clear(metaHolder);
    metaHolder.appendChild(el('span', {
      class: 'num',
      text: t('tx.metaCounts', {
        income: result.totals.incomeCount,
        expense: result.totals.expenseCount,
        transfer: result.totals.transferCount
      })
    }));
    metaHolder.appendChild(el('div', { class: 'flex items-center gap-2' }, [
      result.totals.pendingCount > 0 ? badge(t('tx.notPosted', { count: result.totals.pendingCount }), 'warning') : null,
      el('label', { class: 'flex items-center gap-1.5' }, [
        icon('arrow-down-up', 'h-3.5 w-3.5'),
        el('span', { class: 'hidden sm:inline', text: t('tx.sort') }),
        el('select', {
          class: 'select !w-auto !py-1 !text-xs',
          'aria-label': t('tx.sortAria'),
          onchange: (event) => {
            filters.sort = event.target.value;
            filters.page = 1;
            refresh();
          }
        }, SORT_OPTIONS.map((option) => el('option', { value: option.value, selected: filters.sort === option.value, text: t(`sort.${option.value}`) })))
      ])
    ]));
  }

  function renderSelectionBar() {
    clear(selectionBar);
    const count = selection.size;
    selectionBar.toggleAttribute('hidden', count === 0);
    if (count === 0) return;
    selectionBar.appendChild(el('div', { class: 'flex flex-wrap items-center gap-2 rounded-xl bg-slate-50 p-2 dark:bg-slate-800/60' }, [
      el('span', { class: 'px-1 text-xs font-medium text-slate-600 dark:text-slate-300', text: t('tx.selected', { count }) }),
      el('button', { type: 'button', class: 'btn btn-secondary btn-sm', text: t('tx.exportSelected'), onclick: () => exportRows(currentResult.filtered.filter((tx) => selection.has(tx.id)), 'spendwise-transactions-selected') }),
      el('button', { type: 'button', class: 'btn btn-danger btn-sm', text: t('tx.deleteSelected'), onclick: bulkDelete }),
      el('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: t('tx.clear'), onclick: () => { selection.clear(); refresh(); } })
    ]));
  }

  /* --------------------------------------------------------------------- *
   * Insights (income / expense screens only)
   *
   * The dedicated Income and Expenses screens must support month-by-month
   * comparison, a view of where the money comes from / goes, and a pointer to
   * recurring income. These tiles derive from the *filtered* result set so
   * they always agree with the table below, and never mix currencies.
   * --------------------------------------------------------------------- */

  function insightTile({ title, iconName, body, hint = '', action = null }) {
    return el('div', { class: 'min-w-0 rounded-xl border border-slate-200 p-3 dark:border-slate-800' }, [
      el('div', { class: 'flex items-center justify-between gap-2' }, [
        el('p', { class: 'flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500' }, [
          icon(iconName, 'h-3.5 w-3.5'),
          el('span', { text: title })
        ]),
        action
      ]),
      el('div', { class: 'mt-2 space-y-1.5' }, body),
      hint ? el('p', { class: 'mt-2 text-[11px] leading-snug text-slate-400 dark:text-slate-500', text: hint }) : null
    ]);
  }

  function renderInsights(result) {
    clear(insightsHolder);
    if (mode === 'all' || !result || result.total === 0) return;

    const type = mode; // 'income' | 'expense'
    const currency = normalizeCurrency(store.preferences.currency);
    const allRows = (result.filtered || []).filter((tx) => tx.type === type && tx.status !== 'draft');
    const rows = allRows.filter((tx) => normalizeCurrency(tx.currency) === currency);
    const excluded = allRows.length - rows.length;

    // Month-by-month comparison ------------------------------------------
    const byMonth = new Map();
    for (const tx of rows) {
      const key = monthKey(tx.date);
      const entry = byMonth.get(key) || { total: 0, count: 0 };
      entry.total += Number(tx.amountMinor) || 0;
      entry.count += 1;
      byMonth.set(key, entry);
    }
    const months = [...byMonth.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).slice(-6);
    const peak = Math.max(1, ...months.map(([, value]) => value.total));
    const monthBody = months.length
      ? months.map(([key, value]) => el('div', { class: 'space-y-1' }, [
          el('div', { class: 'flex items-center justify-between gap-2 text-xs' }, [
            el('span', { class: 'text-slate-500 dark:text-slate-400', text: formatMonth(key, { locale, format: 'short' }) }),
            el('span', { class: 'num font-medium text-slate-700 dark:text-slate-200', text: fmt(value.total, currency) })
          ]),
          el('div', { class: 'h-1.5 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800' }, [
            el('span', { class: `block h-full rounded-full ${type === 'income' ? 'bg-income-500' : 'bg-expense-500'}`, style: { width: `${Math.round((value.total / peak) * 100)}%` } })
          ])
        ]))
      : [el('p', { class: 'text-xs text-slate-400 dark:text-slate-500', text: t('tx.insight.nothingToCompare') })];
    const monthHint = months.length > 1
      ? t(months.length === 2 ? 'tx.insight.monthHintOne' : 'tx.insight.monthHintMany', { count: months.length - 1 })
      : t('tx.insight.widen');

    // Money sources / sinks ----------------------------------------------
    const byCategory = new Map();
    for (const tx of rows) {
      const key = tx.categoryId || '__none__';
      byCategory.set(key, (byCategory.get(key) || 0) + (Number(tx.amountMinor) || 0));
    }
    const grandTotal = [...byCategory.values()].reduce((sum, value) => sum + value, 0) || 1;
    const top = [...byCategory.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    const sourceBody = top.length
      ? top.map(([categoryId, total]) => {
          const category = store.byId(RESOURCES.CATEGORIES, categoryId === '__none__' ? null : categoryId);
          return el('div', { class: 'flex items-center gap-2' }, [
            iconTile(category?.icon || 'circle-ellipsis', category?.color || '#94a3b8', 'sm'),
            el('span', { class: 'min-w-0 flex-1 truncate text-xs text-slate-600 dark:text-slate-300', text: category?.name || t('tx.uncategorised') }),
            el('span', { class: 'text-[11px] text-slate-400 dark:text-slate-500', text: `${Math.round((total / grandTotal) * 100)}%` }),
            el('span', { class: 'num text-xs font-medium text-slate-700 dark:text-slate-200', text: fmt(total, currency) })
          ]);
        })
      : [el('p', { class: 'text-xs text-slate-400 dark:text-slate-500', text: t('tx.insight.noCategories') })];

    // Third tile: recurring income, or budget pressure -------------------
    let thirdTile;
    if (type === 'income') {
      const rules = store.list(RESOURCES.RECURRING)
        .filter((rule) => rule.type === 'income' && rule.status === 'active' && normalizeCurrency(rule.currency) === currency);
      const monthly = rules.reduce((sum, rule) => sum + recurringMonthlyEquivalent(rule), 0);
      thirdTile = insightTile({
        title: t('tx.insight.recurringIncome'),
        iconName: 'repeat',
        action: el('button', {
          type: 'button', class: 'btn btn-ghost btn-sm', text: t('tx.insight.manage'),
          onclick: () => ctx.router.navigate('/recurring')
        }),
        body: [
          el('p', { class: 'num text-lg font-semibold text-slate-800 dark:text-slate-100', text: fmt(monthly, currency) }),
          el('p', { class: 'text-xs text-slate-500 dark:text-slate-400', text: t('tx.insight.monthlyEquivalent') }),
          rules.length
            ? el('p', { class: 'text-[11px] text-slate-400 dark:text-slate-500', text: t(rules.length === 1 ? 'tx.insight.activeRulesOne' : 'tx.insight.activeRulesMany', { count: rules.length }) })
            : el('p', { class: 'text-[11px] text-slate-400 dark:text-slate-500', text: t('tx.insight.noRecurring') })
        ],
        hint: t('tx.insight.recurringHint')
      });
    } else {
      const overview = ctx.notifications?.budgetOverview?.() || [];
      const over = overview.filter(({ status }) => status.overMinor > 0);
      const overTotal = over.reduce((sum, { status }) => sum + status.overMinor, 0);
      thirdTile = insightTile({
        title: t('tx.insight.budgetCheck'),
        iconName: 'target',
        action: el('button', {
          type: 'button', class: 'btn btn-ghost btn-sm', text: t('tx.insight.budgets'),
          onclick: () => ctx.router.navigate('/budgets')
        }),
        body: [
          el('p', { class: 'num text-lg font-semibold text-slate-800 dark:text-slate-100', text: String(over.length) }),
          el('p', { class: 'text-xs text-slate-500 dark:text-slate-400', text: t(over.length === 1 ? 'tx.insight.activeBudgetOverOne' : 'tx.insight.activeBudgetOverMany', { count: over.length }) }),
          over.length
            ? el('p', { class: 'num text-[11px] text-expense-600 dark:text-expense-400', text: t('tx.insight.overAcross', { amount: fmt(overTotal, currency) }) })
            : el('p', { class: 'text-[11px] text-slate-400 dark:text-slate-500', text: t('tx.insight.allWithin') })
        ],
        hint: t('tx.insight.budgetHint')
      });
    }

    insightsHolder.appendChild(el('div', { class: 'grid gap-3 sm:grid-cols-2 xl:grid-cols-3' }, [
      insightTile({ title: t('tx.insight.byMonth', { currency }), iconName: 'calendar-range', body: monthBody, hint: monthHint }),
      insightTile({ title: t(type === 'income' ? 'tx.insight.topSources' : 'tx.insight.topCategories'), iconName: 'pie-chart', body: sourceBody, hint: excluded ? t(excluded === 1 ? 'tx.insight.excludesOne' : 'tx.insight.excludesMany', { count: excluded }) : '' }),
      thirdTile
    ]));
  }

  function renderTotals(result) {
    clear(totalsHolder);
    if (result.total === 0) return;
    const currency = store.preferences.currency;
    totalsHolder.appendChild(el('div', { class: 'flex flex-col gap-1 border-t border-slate-100 pt-3 text-xs text-slate-500 sm:flex-row sm:items-center sm:justify-between dark:border-slate-800 dark:text-slate-400' }, [
      el('span', {
        class: 'num',
        text: t('tx.totals', {
          income: fmt(result.totals.incomeMinor, currency),
          expense: fmt(result.totals.expenseMinor, currency),
          net: fmt(result.totals.netMinor, currency)
        })
      }),
      el('span', { class: 'text-[11px]', text: t('tx.transfersExcluded') })
    ]));
  }

  function renderPagination(result) {
    clear(paginationHolder);
    if (result.total === 0) return;
    paginationHolder.appendChild(pagination({
      page: result.page,
      pageSize: result.pageSize,
      total: result.total,
      onPage: (page) => refresh({ page }),
      onPageSize: (size) => refresh({ pageSize: size }),
      sizes: appConfig.limits.pageSizeOptions,
      itemLabel: t('nav.transactions')
    }));
  }

  /* --------------------------------------------------------------------- *
   * Actions
   * --------------------------------------------------------------------- */

  function openForm(tx = null) {
    openTransactionForm({
      service,
      store,
      toast,
      transaction: tx,
      defaults: mode === 'income' ? { type: 'income' } : mode === 'expense' ? { type: 'expense' } : {},
      lockType: tx ? null : mode === 'income' ? 'income' : mode === 'expense' ? 'expense' : null,
      onSaved: () => refresh()
    });
  }

  function openDetails(tx) {
    openTransactionDetails({
      store,
      transaction: tx,
      locale,
      onEdit: () => openForm(tx),
      onDelete: () => remove(tx),
      onDuplicate: () => duplicate(tx)
    });
  }

  function duplicate(tx) {
    const result = service.duplicate(tx.id);
    if (result.ok) {
      toast?.success(t('tx.toast.duplicated.title'), t('tx.toast.duplicated.message'));
      refresh();
    }
  }

  async function remove(tx) {
    const ok = await confirmDelete(t('tx.deleteConfirmWhat'), {
      detail: `${labels.transactionType(tx.type)} · ${fmt(tx.amountMinor, tx.currency)} · ${formatDate(tx.date, { locale })}`
    });
    if (!ok) return;
    service.remove(tx.id);
    selection.delete(tx.id);
    toast?.success(t('tx.toast.deleted'));
    refresh();
  }

  async function bulkDelete() {
    const count = selection.size;
    if (count === 0) return;
    const ok = await confirmDialog({
      title: t(count === 1 ? 'tx.toast.bulkTitleOne' : 'tx.toast.bulkTitleMany', { count }),
      message: t('tx.toast.bulkMessage'),
      detail: t('tx.toast.bulkDetail'),
      confirmLabel: t('tx.toast.bulkConfirm', { count }),
      variant: 'danger',
      tone: 'danger'
    });
    if (!ok) return;
    const result = service.removeMany([...selection]);
    selection.clear();
    toast?.success(t(result.removed === 1 ? 'tx.toast.bulkDeletedOne' : 'tx.toast.bulkDeletedMany', { count: result.removed }));
    refresh();
  }

  function exportRows(rows, name) {
    if (!rows.length) {
      toast?.warning(t('tx.toast.nothingToExport'), t('tx.toast.noMatchExport'));
      return;
    }
    const csvRows = transactionRows(rows, { categories: store.list(RESOURCES.CATEGORIES), accounts: store.list(RESOURCES.ACCOUNTS) });
    downloadCsv(name, csvRows);
    toast?.success(t('tx.toast.exportReady'), t(csvRows.length - 1 === 1 ? 'tx.toast.exportWrittenOne' : 'tx.toast.exportWrittenMany', { count: csvRows.length - 1 }));
  }

  function resetFilters() {
    Object.assign(filters, EMPTY_FILTERS, {
      type: mode === 'income' ? 'income' : mode === 'expense' ? 'expense' : '',
      sort: filters.sort,
      pageSize: filters.pageSize,
      rangePreset: 'any'
    });
    selection.clear();
  }

  /* --------------------------------------------------------------------- *
   * Refresh
   * --------------------------------------------------------------------- */

  let currentResult = null;
  const refreshDebounced = debounce(() => refresh(), 220);

  function refresh({ page = null, pageSize = null } = {}) {
    if (page) filters.page = page;
    if (pageSize) {
      filters.pageSize = pageSize;
      filters.page = 1;
    }
    const result = service.query(filters);
    currentResult = result;
    const visibleIds = new Set(result.filtered.map((tx) => tx.id));
    for (const id of [...selection]) if (!visibleIds.has(id)) selection.delete(id);

    renderChips();
    renderSelectionBar();
    renderInsights(result);
    renderMeta(result);
    renderResults(result);
    renderTotals(result);
    renderPagination(result);
    return result;
  }

  renderFilterPanel();
  refresh();

  return {
    refresh,
    destroy() {
      refreshDebounced.cancel();
      selection.clear();
      clear(container);
    }
  };
}

/* ------------------------------------------------------------------------- *
 * Detail dialog
 * ------------------------------------------------------------------------- */

export function openTransactionDetails({ store, transaction, locale = 'en-US', onEdit = null, onDelete = null, onDuplicate = null }) {
  const tx = transaction;
  const category = store.byId(RESOURCES.CATEGORIES, tx.categoryId);
  const account = store.byId(RESOURCES.ACCOUNTS, tx.accountId);
  const toAccount = store.byId(RESOURCES.ACCOUNTS, tx.toAccountId);
  const fmt = (minor, currency) => formatMoney(minor, { currency, locale });

  const row = (label, value, { title = '' } = {}) =>
    el('div', { class: 'flex items-start justify-between gap-4 py-2' }, [
      el('dt', { class: 'text-xs text-slate-500 dark:text-slate-400', text: label }),
      el('dd', {
        class: 'max-w-[65%] break-words text-right text-sm text-slate-800 dark:text-slate-100',
        title: title || undefined,
        text: value === null || value === undefined || value === '' ? '—' : String(value)
      })
    ]);

  let modal = null;
  const close = () => modal?.close('details');

  const content = el('div', { class: 'space-y-4' }, [
    el('div', { class: 'flex items-center justify-between gap-3 rounded-xl bg-slate-50 p-3 dark:bg-slate-800/60' }, [
      el('div', { class: 'flex min-w-0 items-center gap-3' }, [
        iconTile(category?.icon || (tx.type === 'transfer' ? 'arrow-left-right' : 'circle-ellipsis'), category?.color || '#6366f1'),
        el('div', { class: 'min-w-0' }, [
          el('p', { class: 'truncate text-sm font-semibold text-slate-900 dark:text-slate-100', text: tx.description || t('tx.noDescription') }),
          el('p', { class: 'text-xs text-slate-500 dark:text-slate-400', text: category?.name || labels.transactionType(tx.type) })
        ])
      ]),
      el('div', { class: 'shrink-0 text-right' }, [
        el('p', { class: 'num text-lg font-semibold text-slate-900 dark:text-slate-50', text: fmt(tx.amountMinor, tx.currency) }),
        typeBadge(tx.type)
      ])
    ]),
    el('dl', { class: 'divide-y divide-slate-100 dark:divide-slate-800' }, [
      row(t('tx.col.date'), formatDate(tx.date, { locale, format: store.preferences.dateFormat })),
      row(t('tx.col.type'), labels.transactionType(tx.type)),
      row(t('tx.chip.status'), t(`status.${tx.status}`)),
      row(t('tx.col.category'), category ? category.name : tx.categoryId ? t('tx.deletedCategory') : t('tx.uncategorised')),
      row(tx.type === 'transfer' ? t('tx.details.fromAccount') : t('txForm.account'), account ? `${account.name} (${account.currency})` : t('tx.details.deletedAccount')),
      tx.type === 'transfer' ? row(t('tx.details.toAccount'), toAccount?.name || t('tx.details.deletedAccount')) : null,
      row(t('tx.details.paymentMethod'), labels.paymentMethod(tx.paymentMethod)),
      row(tx.type === 'income' ? t('tx.details.payer') : t('tx.details.payee'), tx.payee),
      row(t('tx.details.tags'), (tx.tags || []).join(', ')),
      row(t('tx.details.notes'), tx.notes),
      row(t('tx.details.receiptRef'), tx.receiptRef),
      tx.recurringRuleId ? row(t('tx.details.recurringRule'), tx.recurringRuleId) : null,
      tx.occurrenceKey ? row(t('tx.details.occurrenceKey'), tx.occurrenceKey, { title: t('tx.details.occurrenceTitle') }) : null,
      row(t('tx.details.created'), tx.createdAt),
      row(t('tx.details.lastUpdated'), tx.updatedAt)
    ]),
    tx.type === 'transfer'
      ? el('p', { class: 'rounded-xl bg-brand-50 p-3 text-[11px] text-brand-700 dark:bg-brand-500/10 dark:text-brand-300', text: t('tx.details.transferNote') })
      : null
  ]);

  modal = openModal({
    title: t('tx.details.title'),
    size: 'md',
    content,
    footer: el('div', { class: 'flex flex-wrap items-center justify-end gap-2' }, [
      el('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: t('tx.duplicate'), onclick: () => { close(); onDuplicate?.(); } }),
      el('button', { type: 'button', class: 'btn btn-danger btn-sm', text: t('tx.delete'), onclick: () => { close(); onDelete?.(); } }),
      el('div', { class: 'flex-1' }),
      el('button', { type: 'button', class: 'btn btn-secondary', text: t('tx.details.close'), onclick: close }),
      el('button', { type: 'button', class: 'btn btn-primary', text: t('tx.edit'), onclick: () => { close(); onEdit?.(); } })
    ])
  });

  return modal;
}
