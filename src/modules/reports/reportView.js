/**
 * Reports & analytics screen.
 *
 * A tabbed analytics surface: overview, spending, income, accounts and
 * planning. Every chart is paired with an accessible data table, and every
 * figure comes from the pure calculation layer so the documented rules hold.
 */

import { el, icon, clear } from '../../utils/dom.js';
import {
  badge, chartCard, chartDataTable, dataTable, emptyState, money, percent,
  progressBar, sectionCard, signedMoney, statCard, tabs
} from '../../components/ui.js';
import {
  mountChart, destroyCharts, incomeExpenseBarConfig, doughnutConfig,
  lineConfig, horizontalBarConfig
} from '../../components/charts.js';
import { appConfig } from '../../config/appConfig.js';
import { createReportService } from './reportService.js';
import { formatDate, formatMonth } from '../../utils/date.js';
import { normalizeCurrency } from '../../utils/currency.js';
import { downloadCsv } from '../../services/exportService.js';
import { t, rangeLabel } from '../../i18n/index.js';

const RANGE_OPTIONS = appConfig.ranges.filter((range) => range.id !== 'custom');
const TABS = [
  { id: 'overview', label: 'rpt.tab.overview' },
  { id: 'spending', label: 'rpt.tab.spending' },
  { id: 'income', label: 'rpt.tab.income' },
  { id: 'accounts', label: 'rpt.tab.accounts' },
  { id: 'planning', label: 'rpt.tab.planning' }
];

export function mount(container, ctx) {
  const { store, toast, router } = ctx;
  const report = createReportService({ store });
  const locale = store.preferences.locale;

  const ui = {
    tab: 'overview',
    preset: store.preferences.defaultRange || 'thisMonth',
    currency: normalizeCurrency(store.preferences.currency)
  };
  if (!RANGE_OPTIONS.some((range) => range.id === ui.preset)) ui.preset = 'thisMonth';

  const activeCharts = new Set();
  const root = el('div', { class: 'space-y-4' });
  const toolbarHolder = el('div');
  const bodyHolder = el('div');
  root.append(toolbarHolder, bodyHolder);
  container.appendChild(root);

  const fmt = (minor, currency) =>
    money(minor, { currency: currency || ui.currency, locale, accounting: store.preferences.numberFormat === 'accounting' });
  const compactFmt = (minor) => money(minor, { currency: ui.currency, locale, compact: true });
  const range = () => report.resolveRange(ui.preset);

  const refresh = () => {
    destroyCharts(...activeCharts);
    activeCharts.clear();
    renderToolbar();
    clear(bodyHolder);
    ({ overview: renderOverview, spending: renderSpending, income: renderIncome, accounts: renderAccounts, planning: renderPlanning }[ui.tab] || renderOverview)();
  };

  /* ---------------------------------------------------------------- Toolbar */

  function renderToolbar() {
    clear(toolbarHolder);
    const currencies = report.currencies();
    toolbarHolder.appendChild(el('div', { class: 'flex flex-wrap items-center justify-between gap-3' }, [
      tabs({ items: TABS.map((tab) => ({ ...tab, label: t(tab.label) })), activeId: ui.tab, onChange: (id) => { ui.tab = id; refresh(); } }),
      el('div', { class: 'flex flex-wrap items-center gap-2' }, [
        currencies.length > 1
          ? el('select', {
              class: 'select !w-auto !py-1.5 !text-xs', 'aria-label': t('rpt.currency'),
              onchange: (event) => { ui.currency = event.target.value; refresh(); }
            }, currencies.map((code) => el('option', { value: code, selected: code === ui.currency, text: code })))
          : null,
        el('select', {
          class: 'select !w-auto !py-1.5 !text-xs', 'aria-label': t('rpt.period'),
          onchange: (event) => { ui.preset = event.target.value; refresh(); }
        }, RANGE_OPTIONS.map((option) => el('option', { value: option.id, selected: option.id === ui.preset, text: rangeLabel(option.id) }))),
        el('button', { type: 'button', class: 'btn btn-secondary btn-sm', onclick: exportReport }, [
          icon('download', 'h-3.5 w-3.5'), el('span', { text: t('rpt.export') })
        ])
      ])
    ]));
  }

  function summaryStats() {
    const s = report.summary(range(), ui.currency);
    const holder = el('div', { class: 'grid gap-3 sm:grid-cols-2 xl:grid-cols-4' });
    holder.append(
      statCard({ label: t('rpt.stat.income'), value: fmt(s.incomeMinor), iconName: 'trending-up', tone: 'income', sub: t('rpt.stat.txCount', { count: s.incomeCount }) }),
      statCard({ label: t('rpt.stat.expenses'), value: fmt(s.expenseMinor), iconName: 'trending-down', tone: 'expense', sub: t('rpt.stat.txCount', { count: s.expenseCount }) }),
      statCard({ label: t('rpt.stat.netSaved'), value: fmt(s.netMinor), iconName: 'piggy-bank', tone: s.netMinor < 0 ? 'expense' : 'savings', sub: s.savingsRate === null ? t('rpt.stat.noIncomeYet') : t('rpt.stat.savingsRate', { percent: percent(s.savingsRate, { locale }) }) }),
      statCard({ label: t('rpt.stat.transactions'), value: String(s.count), iconName: 'receipt', tone: 'neutral', sub: s.pendingCount ? t('rpt.stat.pendingExcluded', { count: s.pendingCount }) : t('rpt.stat.allPosted') })
    );
    return holder;
  }

  /* -------------------------------------------------------------- Overview */

  function renderOverview() {
    bodyHolder.appendChild(el('div', { class: 'space-y-4' }, [
      summaryStats(),
      el('div', { class: 'grid gap-4 xl:grid-cols-2' }, [
        cashflowCard(t('rpt.overview.cashflowTitle'), t('rpt.overview.cashflowDesc')),
        savingsCard()
      ]),
      monthlyTableCard()
    ]));
  }

  function cashflowCard(title, description) {
    const rows = report.monthly(range(), ui.currency);
    const hasData = rows.some((row) => row.incomeMinor || row.expenseMinor);
    if (!hasData) return sectionCard({ title, description, body: [emptyState({ iconName: 'chart-column', title: t('rpt.noActivityTitle'), message: t('rpt.noActivityMessage'), compact: true })] });
    const canvas = el('canvas');
    activeCharts.add(canvas);
    const card = chartCard({
      title, description, canvas, height: 300,
      footer: [chartDataTable({
        caption: title,
        columns: [
          { key: 'label', label: t('rpt.col.month'), render: (row) => formatMonth(row.month, { locale, format: 'short' }) },
          { key: 'incomeMinor', label: t('rpt.col.income'), align: 'right', render: (row) => fmt(row.incomeMinor) },
          { key: 'expenseMinor', label: t('rpt.col.expenses'), align: 'right', render: (row) => fmt(row.expenseMinor) }
        ],
        rows
      })]
    });
    mountChart(canvas, incomeExpenseBarConfig({
      labels: rows.map((row) => formatMonth(row.month, { locale, format: 'short' })),
      income: rows.map((row) => row.incomeMinor),
      expense: rows.map((row) => row.expenseMinor),
      currency: ui.currency,
      formatValue: compactFmt
    })).catch(() => chartFailed(card, canvas));
    return card;
  }

  function savingsCard() {
    const rows = report.monthly(range(), ui.currency);
    const hasData = rows.some((row) => row.incomeMinor || row.expenseMinor);
    if (!hasData) return sectionCard({ title: t('rpt.overview.savingsTitle'), description: t('rpt.overview.savingsDesc'), body: [emptyState({ iconName: 'chart-line', title: t('rpt.noActivityTitle'), message: t('rpt.noActivityMessage'), compact: true })] });
    const canvas = el('canvas');
    activeCharts.add(canvas);
    const card = chartCard({
      title: t('rpt.overview.savingsTitle'), description: t('rpt.overview.savingsDesc'), canvas, height: 300,
      footer: [chartDataTable({
        caption: t('rpt.overview.savingsTitle'),
        columns: [
          { key: 'label', label: t('rpt.col.month'), render: (row) => formatMonth(row.month, { locale, format: 'short' }) },
          { key: 'cumulativeMinor', label: t('rpt.col.cumulative'), align: 'right', render: (row) => fmt(row.cumulativeMinor) }
        ],
        rows
      })]
    });
    mountChart(canvas, lineConfig({
      labels: rows.map((row) => formatMonth(row.month, { locale, format: 'short' })),
      series: [{ label: t('rpt.series.cumulativeNet'), data: rows.map((row) => row.cumulativeMinor), color: appConfig.chartColors.net }],
      currency: ui.currency,
      formatValue: compactFmt
    })).catch(() => chartFailed(card, canvas));
    return card;
  }

  function monthlyTableCard() {
    const rows = report.monthly(range(), ui.currency);
    return sectionCard({
      title: t('rpt.overview.monthlyTitle'),
      description: t('rpt.overview.monthlyDesc'),
      body: [rows.length ? dataTable({
        caption: t('rpt.overview.monthlyTitle'),
        columns: [
          { key: 'label', label: t('rpt.col.month'), render: (row) => el('span', { text: formatMonth(row.month, { locale: 'en-US', format: 'long' }) }) },
          { key: 'incomeMinor', label: t('rpt.col.income'), align: 'right', render: (row) => signedMoney(row.incomeMinor, ui.currency, { locale }) },
          { key: 'expenseMinor', label: t('rpt.col.expenses'), align: 'right', render: (row) => signedMoney(-row.expenseMinor, ui.currency, { locale }) },
          { key: 'netMinor', label: t('rpt.col.net'), align: 'right', render: (row) => signedMoney(row.netMinor, ui.currency, { locale }) }
        ],
        rows
      }) : emptyState({ iconName: 'calendar', title: t('rpt.overview.noMonthsTitle'), message: t('rpt.overview.noMonthsMessage'), compact: true })]
    });
  }

  /* -------------------------------------------------------------- Spending */

  function renderSpending() {
    const breakdown = report.expenseBreakdown(range(), ui.currency, { limit: 10 });
    const trend = report.trend(range(), ui.currency, { limit: 6 });
    const largest = report.largest(range(), ui.currency, { type: 'expense', limit: 10 });
    const hasTrend = trend.months.length > 1 && trend.series.size > 0;

    bodyHolder.appendChild(el('div', { class: 'space-y-4' }, [
      el('div', { class: 'grid gap-4 xl:grid-cols-2' }, [
        categoryDoughnut(t('rpt.spending.byCategory'), breakdown),
        topCategoriesBar(t('rpt.spending.topCategories'), breakdown)
      ]),
      hasTrend
        ? categoryTrendCard(trend)
        : sectionCard({ title: t('rpt.spending.trendsTitle'), description: t('rpt.spending.trendsDesc'), body: [emptyState({ iconName: 'chart-line', title: t('rpt.spending.notEnoughHistoryTitle'), message: t('rpt.spending.notEnoughHistoryMessage'), compact: true })] }),
      sectionCard({
        title: t('rpt.spending.largestTitle'),
        description: t('rpt.spending.largestDesc'),
        body: [largest.length ? dataTable({
          caption: t('rpt.spending.largestTitle'),
          columns: [
            { key: 'date', label: t('rpt.col.date'), render: (tx) => el('span', { class: 'num text-xs', text: formatDate(tx.date, { locale }) }) },
            { key: 'description', label: t('rpt.col.description'), render: (tx) => el('span', { class: 'text-sm', text: tx.description || tx.payee || '—' }) },
            { key: 'category', label: t('rpt.col.category'), class: 'hidden sm:table-cell', render: (tx) => store.categoryName(tx.categoryId) },
            { key: 'amount', label: t('rpt.col.amount'), align: 'right', render: (tx) => signedMoney(-tx.amountMinor, tx.currency, { locale }) }
          ],
          rows: largest
        }) : emptyState({ iconName: 'receipt', title: t('rpt.spending.noExpensesTitle'), message: t('rpt.spending.noExpensesMessage'), compact: true })]
      })
    ]));
  }

  function renderIncome() {
    const breakdown = report.incomeBreakdown(range(), ui.currency, { limit: 10 });
    const s = report.summary(range(), ui.currency);
    bodyHolder.appendChild(el('div', { class: 'space-y-4' }, [
      summaryStats(),
      el('div', { class: 'grid gap-4 xl:grid-cols-2' }, [
        categoryDoughnut(t('rpt.income.byCategory'), breakdown),
        topCategoriesBar(t('rpt.income.topSources'), breakdown)
      ]),
      sectionCard({
        title: t('rpt.income.detailTitle'),
        description: t('rpt.income.detailDesc', { amount: fmt(s.incomeMinor), count: s.incomeCount }),
        body: [breakdown.length ? dataTable({
          caption: t('rpt.income.byCategory'),
          columns: [
            { key: 'name', label: t('rpt.col.category') },
            { key: 'count', label: t('rpt.col.count'), align: 'right' },
            { key: 'share', label: t('rpt.col.share'), align: 'right', render: (row) => percent(row.share, { locale }) },
            { key: 'totalMinor', label: t('rpt.col.amount'), align: 'right', render: (row) => signedMoney(row.totalMinor, ui.currency, { locale }) }
          ],
          rows: breakdown
        }) : emptyState({ iconName: 'trending-up', title: t('rpt.income.noIncomeTitle'), message: t('rpt.income.noIncomeMessage'), compact: true })]
      })
    ]));
  }

  function categoryDoughnut(title, rows) {
    if (!rows.length) return sectionCard({ title, body: [emptyState({ iconName: 'chart-pie', title: t('rpt.noDataTitle'), message: t('rpt.noActivityMessage'), compact: true })] });
    const canvas = el('canvas');
    activeCharts.add(canvas);
    const card = chartCard({
      title, canvas, height: 300,
      footer: [chartDataTable({
        caption: title,
        columns: [
          { key: 'name', label: t('rpt.col.category') },
          { key: 'totalMinor', label: t('rpt.col.amount'), align: 'right', render: (row) => fmt(row.totalMinor) },
          { key: 'share', label: t('rpt.col.share'), align: 'right', render: (row) => percent(row.share, { locale }) }
        ],
        rows
      })]
    });
    mountChart(canvas, doughnutConfig({
      labels: rows.map((row) => row.name),
      values: rows.map((row) => row.totalMinor),
      colors: rows.map((row) => row.color),
      currency: ui.currency,
      formatValue: compactFmt
    })).catch(() => chartFailed(card, canvas));
    return card;
  }

  function topCategoriesBar(title, rows) {
    if (!rows.length) return sectionCard({ title, body: [emptyState({ iconName: 'chart-column', title: t('rpt.noDataTitle'), message: t('rpt.noActivityMessage'), compact: true })] });
    const canvas = el('canvas');
    activeCharts.add(canvas);
    const top = rows.slice(0, 8);
    const card = chartCard({
      title, canvas, height: 300,
      footer: [chartDataTable({
        caption: title,
        columns: [
          { key: 'name', label: t('rpt.col.category') },
          { key: 'totalMinor', label: t('rpt.col.amount'), align: 'right', render: (row) => fmt(row.totalMinor) }
        ],
        rows: top
      })]
    });
    mountChart(canvas, horizontalBarConfig({
      labels: top.map((row) => row.name),
      values: top.map((row) => row.totalMinor),
      colors: top.map((row) => row.color),
      currency: ui.currency,
      formatValue: compactFmt
    })).catch(() => chartFailed(card, canvas));
    return card;
  }

  function categoryTrendCard(trend) {
    const colors = ['#6366f1', '#f43f5e', '#10b981', '#f59e0b', '#0ea5e9', '#8b5cf6', '#14b8a6', '#ec4899'];
    const series = [...trend.series.entries()].map(([categoryId, data], index) => ({
      label: store.categoryName(categoryId),
      data,
      color: colors[index % colors.length],
      fill: false
    }));
    const canvas = el('canvas');
    activeCharts.add(canvas);
    const card = chartCard({
      title: t('rpt.spending.trendsTitle'),
      description: t('rpt.spending.trendsDesc'),
      canvas,
      height: 320,
      footer: [chartDataTable({
        caption: t('rpt.spending.trendsTitle'),
        columns: [
          { key: 'month', label: t('rpt.col.month'), render: (row) => formatMonth(row.month, { locale, format: 'short' }) },
          ...series.map((entry, index) => ({ key: `s${index}`, label: entry.label, align: 'right', render: (row) => fmt(row.values[index]) }))
        ],
        rows: trend.months.map((month, index) => ({ month, values: series.map((entry) => entry.data[index]) }))
      })]
    });
    mountChart(canvas, lineConfig({
      labels: trend.months.map((month) => formatMonth(month, { locale, format: 'short' })),
      series,
      currency: ui.currency,
      formatValue: compactFmt
    })).catch(() => chartFailed(card, canvas));
    return card;
  }

  /* -------------------------------------------------------------- Accounts */

  function renderAccounts() {
    const rows = report.accounts();
    const total = rows.reduce((sum, row) => (normalizeCurrency(row.account.currency) === ui.currency ? sum + row.balanceMinor : sum), 0);
    bodyHolder.appendChild(el('div', { class: 'space-y-4' }, [
      el('div', { class: 'grid gap-3 sm:grid-cols-2 xl:grid-cols-4' }, [
        statCard({ label: t('rpt.accounts.netWorth', { currency: ui.currency }), value: fmt(total), iconName: 'wallet', tone: total < 0 ? 'expense' : 'brand', sub: t('rpt.accounts.acrossAll') }),
        statCard({ label: t('rpt.accounts.title'), value: String(rows.length), iconName: 'landmark', tone: 'neutral', sub: t('rpt.accounts.archived', { count: rows.filter((r) => r.account.archived).length }) })
      ]),
      sectionCard({
        title: t('rpt.accounts.balancesTitle'),
        description: t('rpt.accounts.balancesDesc'),
        body: [rows.length ? dataTable({
          caption: t('rpt.accounts.balancesTitle'),
          columns: [
            { key: 'name', label: t('rpt.col.account'), render: (row) => el('div', { class: 'min-w-0' }, [
              el('p', { class: 'truncate text-sm font-medium text-slate-800 dark:text-slate-100', text: row.account.name }),
              el('p', { class: 'text-[11px] text-slate-400 dark:text-slate-500', text: `${row.account.type} · ${row.account.currency}` })
            ]) },
            { key: 'movements', label: t('rpt.col.movements'), align: 'right', class: 'hidden sm:table-cell', render: (row) => el('span', { class: 'num text-xs', text: String(row.movementCount) }) },
            { key: 'balance', label: t('rpt.col.balance'), align: 'right', render: (row) => signedMoney(row.balanceMinor, row.account.currency, { locale, accounting: store.preferences.numberFormat === 'accounting' }) }
          ],
          rows
        }) : emptyState({ iconName: 'wallet', title: t('rpt.accounts.noAccountsTitle'), message: t('rpt.accounts.noAccountsMessage'), compact: true })]
      })
    ]));
  }

  /* -------------------------------------------------------------- Planning */

  function renderPlanning() {
    const budgets = report.budgets();
    const goals = report.goals();
    bodyHolder.appendChild(el('div', { class: 'space-y-4' }, [
      sectionCard({
        title: t('rpt.planning.budgetTitle'),
        description: t('rpt.planning.budgetDesc'),
        body: [budgets.length ? dataTable({
          caption: t('rpt.planning.budgetTitle'),
          columns: [
            { key: 'name', label: t('rpt.col.budget'), render: ({ budget }) => el('span', { class: 'text-sm font-medium text-slate-800 dark:text-slate-100', text: budget.name }) },
            { key: 'used', label: t('rpt.col.used'), class: 'min-w-[11rem]', render: ({ budget, status }) => el('div', { class: 'space-y-1' }, [
              progressBar({ percent: Math.min(100, status.percent), tone: status.overMinor > 0 ? 'expense' : status.percent >= 90 ? 'warning' : 'savings', size: 'sm' }),
              el('p', { class: 'num text-[11px] text-slate-500 dark:text-slate-400', text: t('rpt.planning.of', { spent: fmt(status.spentMinor, budget.currency), limit: fmt(budget.limitMinor, budget.currency) }) })
            ]) },
            { key: 'remaining', label: t('rpt.col.remaining'), align: 'right', render: ({ budget, status }) => status.overMinor > 0
              ? badge(t('rpt.planning.over', { amount: fmt(status.overMinor, budget.currency) }), 'expense')
              : el('span', { class: 'num text-sm', text: fmt(status.remainingMinor, budget.currency) }) }
          ],
          rows: budgets
        }) : emptyState({ iconName: 'target', title: t('rpt.planning.noBudgetsTitle'), message: t('rpt.planning.noBudgetsMessage'), actionLabel: t('rpt.planning.goToBudgets'), onAction: () => router.navigate('/budgets'), compact: true })]
      }),
      sectionCard({
        title: t('rpt.planning.goalTitle'),
        description: t('rpt.planning.goalDesc'),
        body: [goals.length ? dataTable({
          caption: t('rpt.planning.goalTitle'),
          columns: [
            { key: 'name', label: t('rpt.col.goal'), render: ({ goal }) => el('span', { class: 'text-sm font-medium text-slate-800 dark:text-slate-100', text: goal.name }) },
            { key: 'progress', label: t('rpt.col.progress'), class: 'min-w-[11rem]', render: ({ goal, progress }) => el('div', { class: 'space-y-1' }, [
              progressBar({ percent: progress.percent, tone: progress.onTrack ? 'savings' : 'brand', size: 'sm' }),
              el('p', { class: 'num text-[11px] text-slate-500 dark:text-slate-400', text: `${t('rpt.planning.of', { spent: fmt(goal.savedMinor, goal.currency), limit: fmt(goal.targetMinor, goal.currency) })} · ${progress.percent.toFixed(0)}%` })
            ]) },
            { key: 'remaining', label: t('rpt.col.remaining'), align: 'right', render: ({ goal, progress }) => el('span', { class: 'num text-sm', text: fmt(progress.remainingMinor, goal.currency) }) }
          ],
          rows: goals
        }) : emptyState({ iconName: 'piggy-bank', title: t('rpt.planning.noGoalsTitle'), message: t('rpt.planning.noGoalsMessage'), actionLabel: t('rpt.planning.goToGoals'), onAction: () => router.navigate('/goals'), compact: true })]
      })
    ]));
  }

  /* --------------------------------------------------------------- Export */

  function exportReport() {
    const { monthly, expense } = report.summaryRows(range(), ui.currency);
    const rows = [
      [t('rpt.export.reportLabel'), `${ui.tab} · ${ui.preset} · ${ui.currency}`],
      [],
      [t('rpt.col.month'), t('rpt.col.income'), t('rpt.col.expenses'), t('rpt.col.net')],
      ...monthly.map((row) => [row.month, row.incomeMinor, row.expenseMinor, row.netMinor]),
      [],
      [t('rpt.col.category'), t('rpt.col.amount'), t('rpt.export.shareHeader')],
      ...expense.map((row) => [row.name, row.totalMinor, row.share.toFixed(2)])
    ];
    if (!rows.length || monthly.length === 0) {
      toast?.warning(t('rpt.export.nothingTitle'), t('rpt.export.noDataMessage'));
      return;
    }
    downloadCsv(`spendwise-report-${ui.preset}`, rows);
    toast?.success(t('rpt.export.readyTitle'), t('rpt.export.readyMessage'));
  }

  function chartFailed(card, canvas) {
    if (canvas.parentElement) {
      clear(canvas.parentElement);
      canvas.parentElement.appendChild(emptyState({ iconName: 'triangle-alert', title: t('rpt.chartUnavailableTitle'), message: t('rpt.chartUnavailableMessage'), compact: true }));
    }
  }

  refresh();

  return {
    refresh,
    destroy() {
      destroyCharts(...activeCharts);
      activeCharts.clear();
      clear(container);
    }
  };
}
