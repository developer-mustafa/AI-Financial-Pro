/**
 * Dashboard — the landing screen.
 *
 * Combines a period snapshot, a cash-flow chart, a category breakdown, budget
 * alerts, goal progress and recent activity. Every figure comes from the pure
 * calculation layer, so the rules (posted-only, transfers excluded, refunds are
 * income, no cross-currency maths) hold here exactly as they do in reports.
 */

import { el, icon, clear } from '../../utils/dom.js';
import {
  badge, chartCard, chartDataTable, dataTable, emptyState, iconTile, money, percent,
  progressBar, sectionCard, signedMoney, statCard, typeBadge
} from '../../components/ui.js';
import { mountChart, destroyCharts, incomeExpenseBarConfig, doughnutConfig } from '../../components/charts.js';
import { openTransactionForm, openTransferForm } from '../transactions/transactionForm.js';
import { createDashboardService } from './dashboard.js';
import { appConfig } from '../../config/appConfig.js';
import { formatDate, formatMonth } from '../../utils/date.js';
import { normalizeCurrency } from '../../utils/currency.js';
import { t } from '../../i18n/index.js';

const RANGE_OPTIONS = appConfig.ranges.filter((range) => range.id !== 'custom');

export function mount(container, ctx) {
  const { store, toast, services, router } = ctx;
  const dashboard = createDashboardService({ store });
  const locale = store.preferences.locale;

  const ui = { preset: store.preferences.defaultRange || 'thisMonth', currency: normalizeCurrency(store.preferences.currency) };
  if (!['today', 'thisWeek', 'thisMonth', 'lastMonth', 'last3Months', 'thisYear', 'lastYear', 'allTime'].includes(ui.preset)) {
    ui.preset = 'thisMonth';
  }

  const activeCharts = new Set();

  const root = el('div', { class: 'space-y-4' });
  const headerHolder = el('div');
  const statsHolder = el('div', { class: 'grid gap-3 sm:grid-cols-2 xl:grid-cols-4' });
  const chartsHolder = el('div', { class: 'grid gap-4 xl:grid-cols-2' });
  const panelsHolder = el('div', { class: 'grid gap-4 xl:grid-cols-2' });
  const bottomHolder = el('div', { class: 'grid gap-4 xl:grid-cols-2' });
  root.append(headerHolder, statsHolder, chartsHolder, panelsHolder, bottomHolder);
  container.appendChild(root);

  const fmt = (minor, currency) =>
    money(minor, { currency: currency || ui.currency, locale, accounting: store.preferences.numberFormat === 'accounting' });
  const compactFmt = (minor) => money(minor, { currency: ui.currency, locale, compact: true });

  const refresh = () => {
    renderHeader();
    renderStats();
    renderCharts();
    renderPanels();
    renderBottom();
  };

  /* --------------------------------------------------------------------- *
   * Header
   * --------------------------------------------------------------------- */

  function renderHeader() {
    clear(headerHolder);
    const hour = new Date().getHours();
    const greeting = hour < 12 ? t('dashboard.goodMorning') : hour < 18 ? t('dashboard.goodAfternoon') : t('dashboard.goodEvening');
    const currencies = dashboard.currencies();

    const currencySelect = currencies.length > 1
      ? el('select', {
          class: 'select !w-auto !py-1.5 !text-xs',
          'aria-label': t('dashboard.currency'),
          onchange: (event) => { ui.currency = event.target.value; refresh(); }
        }, currencies.map((code) => el('option', { value: code, selected: code === ui.currency, text: code })))
      : null;

    headerHolder.appendChild(el('div', { class: 'flex flex-wrap items-end justify-between gap-3' }, [
      el('div', { class: 'min-w-0' }, [
        el('h1', { class: 'text-lg font-semibold tracking-tight text-slate-900 sm:text-xl dark:text-slate-50', text: `${greeting} 👋` }),
        el('p', { class: 'mt-0.5 text-sm text-slate-500 dark:text-slate-400', text: t('dashboard.glance') })
      ]),
      el('div', { class: 'flex flex-wrap items-center gap-2' }, [
        currencySelect,
        el('select', {
          class: 'select !w-auto !py-1.5 !text-xs',
          'aria-label': t('dashboard.period'),
          onchange: (event) => { ui.preset = event.target.value; refresh(); }
        }, RANGE_OPTIONS.map((range) => el('option', { value: range.id, selected: range.id === ui.preset, text: t(`range.${range.id}`) }))),
        el('button', {
          type: 'button',
          class: 'btn btn-secondary btn-sm',
          onclick: () => openTransferForm({ service: services.transactions, store, toast, onSaved: refresh })
        }, [icon('arrow-left-right', 'h-3.5 w-3.5'), el('span', { class: 'hidden sm:inline', text: t('dashboard.transfer') })]),
        el('button', {
          type: 'button',
          class: 'btn btn-primary btn-sm',
          onclick: () => openTransactionForm({ service: services.transactions, store, toast, defaults: {}, onSaved: refresh })
        }, [icon('plus', 'h-3.5 w-3.5'), el('span', { text: t('dashboard.add') })])
      ])
    ]));
  }

  /* --------------------------------------------------------------------- *
   * Stats
   * --------------------------------------------------------------------- */

  function renderStats() {
    clear(statsHolder);
    const range = dashboard.resolveRange(ui.preset);
    const summary = dashboard.summary(range, ui.currency);
    const netWorth = dashboard.netWorth();
    const worth = netWorth.get(ui.currency) || 0;
    const savingsRate = summary.savingsRate;

    statsHolder.appendChild(statCard({
      label: t('dashboard.netWorth', { currency: ui.currency }),
      value: fmt(worth),
      iconName: 'wallet',
      tone: worth < 0 ? 'expense' : 'brand',
      sub: worth < 0 ? t('dashboard.moreOwed') : t('dashboard.acrossAccounts')
    }));
    statsHolder.appendChild(statCard({
      label: t('dashboard.income'),
      value: fmt(summary.incomeMinor),
      iconName: 'trending-up',
      tone: 'income',
      sub: t('dashboard.txInPeriod', { count: summary.incomeCount })
    }));
    statsHolder.appendChild(statCard({
      label: t('dashboard.expenses'),
      value: fmt(summary.expenseMinor),
      iconName: 'trending-down',
      tone: 'expense',
      sub: t('dashboard.txInPeriod', { count: summary.expenseCount })
    }));
    statsHolder.appendChild(statCard({
      label: t('dashboard.netSaved'),
      value: fmt(summary.netMinor),
      iconName: summary.netMinor < 0 ? 'trending-down' : 'piggy-bank',
      tone: summary.netMinor < 0 ? 'expense' : 'savings',
      valueClass: summary.netMinor < 0 ? 'text-expense-600 dark:text-expense-400' : 'text-income-600 dark:text-income-400',
      sub: savingsRate === null ? t('dashboard.noIncomeYet') : t('dashboard.savingsRate', { percent: percent(savingsRate, { locale }) })
    }));
  }

  /* --------------------------------------------------------------------- *
   * Charts
   * --------------------------------------------------------------------- */

  function renderCharts() {
    destroyCharts(...activeCharts);
    activeCharts.clear();
    clear(chartsHolder);

    const range = dashboard.resolveRange(ui.preset);
    const cashflow = dashboard.cashflow({ months: 6, currency: ui.currency });
    const expenses = dashboard.breakdown(range, ui.currency, { type: 'expense', limit: 8 });
    const hasCashflow = cashflow.some((row) => row.incomeMinor || row.expenseMinor);

    if (hasCashflow) {
      const canvas = el('canvas');
      chartsHolder.appendChild(chartCard({
        title: t('dashboard.cashFlow'),
        description: t('dashboard.cashFlowDesc'),
        canvas,
        height: 300,
        footer: [chartDataTable({
          caption: t('dashboard.monthlyCashFlow'),
          columns: [
            { key: 'label', label: t('dashboard.month'), render: (row) => formatMonth(row.month, { locale, format: 'short' }) },
            { key: 'incomeMinor', label: t('dashboard.income'), align: 'right', render: (row) => fmt(row.incomeMinor) },
            { key: 'expenseMinor', label: t('dashboard.expenses'), align: 'right', render: (row) => fmt(row.expenseMinor) },
            { key: 'netMinor', label: t('dashboard.net'), align: 'right', render: (row) => fmt(row.netMinor) }
          ],
          rows: cashflow
        })]
      }));
      activeCharts.add(canvas);
      mountChart(canvas, incomeExpenseBarConfig({
        labels: cashflow.map((row) => formatMonth(row.month, { locale, format: 'short' })),
        income: cashflow.map((row) => row.incomeMinor),
        expense: cashflow.map((row) => row.expenseMinor),
        currency: ui.currency,
        formatValue: compactFmt
      })).catch(() => showChartFallback(chartsHolder, t('dashboard.cashFlowUnavailable')));
    } else {
      chartsHolder.appendChild(sectionCard({
        title: t('dashboard.cashFlow'),
        description: t('dashboard.cashFlowDesc'),
        body: [emptyState({ iconName: 'chart-column', title: t('dashboard.noCashFlow'), message: t('dashboard.noCashFlowMessage'), compact: true })]
      }));
    }

    if (expenses.length) {
      const canvas = el('canvas');
      chartsHolder.appendChild(chartCard({
        title: t('dashboard.whereMoneyGoes'),
        description: t('dashboard.whereMoneyGoesDesc'),
        canvas,
        height: 300,
        footer: [chartDataTable({
          caption: t('dashboard.expensesByCategory'),
          columns: [
            { key: 'name', label: t('dashboard.category') },
            { key: 'totalMinor', label: t('dashboard.amount'), align: 'right', render: (row) => fmt(row.totalMinor) },
            { key: 'share', label: t('dashboard.share'), align: 'right', render: (row) => percent(row.share, { locale }) }
          ],
          rows: expenses
        })]
      }));
      activeCharts.add(canvas);
      mountChart(canvas, doughnutConfig({
        labels: expenses.map((row) => row.name),
        values: expenses.map((row) => row.totalMinor),
        colors: expenses.map((row) => row.color),
        currency: ui.currency,
        formatValue: compactFmt
      })).catch(() => showChartFallback(chartsHolder, t('dashboard.breakdownUnavailable')));
    } else {
      chartsHolder.appendChild(sectionCard({
        title: t('dashboard.whereMoneyGoes'),
        description: t('dashboard.whereMoneyGoesDesc'),
        body: [emptyState({ iconName: 'chart-pie', title: t('dashboard.noExpenses'), message: t('dashboard.noExpensesMessage'), compact: true })]
      }));
    }
  }

  function showChartFallback(holder, message) {
    clear(holder);
    holder.appendChild(sectionCard({ title: t('dashboard.chartUnavailable'), body: [emptyState({ iconName: 'triangle-alert', title: t('dashboard.chartUnavailable'), message, compact: true })] }));
  }

  /* --------------------------------------------------------------------- *
   * Panels: budget alerts + goals
   * --------------------------------------------------------------------- */

  function renderPanels() {
    clear(panelsHolder);

    const alerts = dashboard.budgetAlerts();
    const budgets = dashboard.activeBudgets();
    panelsHolder.appendChild(sectionCard({
      title: t('dashboard.budgetWatch'),
      description: t('dashboard.budgetWatchDesc'),
      actions: [el('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => router.navigate('/budgets') }, [el('span', { text: t('dashboard.allBudgets') }), icon('chevron-right', 'h-3.5 w-3.5')])],
      body: [
        alerts.length
          ? el('ul', { class: 'space-y-3' }, alerts.slice(0, 5).map(({ budget, status, level }) => el('li', {}, [
              el('div', { class: 'flex items-center justify-between gap-2' }, [
                el('p', { class: 'truncate text-sm font-medium text-slate-800 dark:text-slate-100', text: budget.name }),
                badge(level >= 100 ? t('dashboard.overLimit') : t('dashboard.percentUsed', { level }), level >= 100 ? 'expense' : level >= 90 ? 'warning' : 'neutral')
              ]),
              progressBar({ percent: Math.min(100, status.percent), tone: status.overMinor > 0 ? 'expense' : 'warning', size: 'sm', showLabel: false }),
              el('p', { class: 'num mt-1 text-[11px] text-slate-500 dark:text-slate-400', text: t('dashboard.spentOf', { spent: fmt(status.spentMinor, budget.currency), limit: fmt(budget.limitMinor, budget.currency) }) })
            ])))
          : budgets.length
            ? emptyState({ iconName: 'shield-check', title: t('dashboard.allBudgetsOnTrack'), message: t('dashboard.allBudgetsOnTrackMessage'), compact: true })
            : emptyState({ iconName: 'target', title: t('dashboard.noBudgets'), message: t('dashboard.noBudgetsMessage'), actionLabel: t('dashboard.createBudget'), onAction: () => router.navigate('/budgets'), compact: true })
      ]
    }));

    const goals = dashboard.goalHighlights(4, ui.currency);
    panelsHolder.appendChild(sectionCard({
      title: t('dashboard.goals'),
      description: t('dashboard.goalsDesc'),
      actions: [el('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => router.navigate('/goals') }, [el('span', { text: t('dashboard.allGoals') }), icon('chevron-right', 'h-3.5 w-3.5')])],
      body: [
        goals.length
          ? el('ul', { class: 'space-y-3' }, goals.map(({ goal, progress }) => el('li', {}, [
              el('div', { class: 'flex items-center gap-3' }, [
                iconTile(goal.icon || 'target', goal.color || '#14b8a6', 'sm'),
                el('div', { class: 'min-w-0 flex-1' }, [
                  el('div', { class: 'flex items-center justify-between gap-2' }, [
                    el('p', { class: 'truncate text-sm font-medium text-slate-800 dark:text-slate-100', text: goal.name }),
                    el('span', { class: 'num text-xs text-slate-500 dark:text-slate-400', text: `${progress.percent.toFixed(0)}%` })
                  ]),
                  progressBar({ percent: progress.percent, tone: progress.onTrack ? 'savings' : 'brand', size: 'sm' })
                ])
              ]),
              el('p', { class: 'num mt-1 text-[11px] text-slate-500 dark:text-slate-400', text: t('dashboard.spentOf', { spent: fmt(goal.savedMinor, goal.currency), limit: fmt(goal.targetMinor, goal.currency) }) })
            ])))
          : emptyState({ iconName: 'piggy-bank', title: t('dashboard.noGoals'), message: t('dashboard.noGoalsMessage'), actionLabel: t('dashboard.createGoal'), onAction: () => router.navigate('/goals'), compact: true })
      ]
    }));
  }

  /* --------------------------------------------------------------------- *
   * Bottom: recent transactions + recurring
   * --------------------------------------------------------------------- */

  function renderBottom() {
    clear(bottomHolder);

    const recent = dashboard.recent(6, ui.currency);
    bottomHolder.appendChild(sectionCard({
      title: t('dashboard.recentTransactions'),
      description: t('dashboard.latestActivityIn', { currency: ui.currency }),
      actions: [el('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => router.navigate('/transactions') }, [el('span', { text: t('dashboard.viewAll') }), icon('chevron-right', 'h-3.5 w-3.5')])],
      body: [
        recent.length
          ? dataTable({
              caption: t('dashboard.recentTransactions'),
              onRowClick: (tx) => router.navigate(`/transactions/${tx.id}`),
              columns: [
                { key: 'date', label: t('dashboard.date'), class: 'whitespace-nowrap', render: (tx) => el('span', { class: 'num text-xs text-slate-500 dark:text-slate-400', text: formatDate(tx.date, { locale }) }) },
                {
                  key: 'description',
                  label: t('dashboard.description'),
                  render: (tx) => el('div', { class: 'min-w-0' }, [
                    el('p', { class: 'truncate text-sm text-slate-800 dark:text-slate-100', text: tx.description || tx.payee || '—' }),
                    el('p', { class: 'text-[11px] text-slate-400 dark:text-slate-500', text: store.categoryName(tx.categoryId) })
                  ])
                },
                { key: 'type', label: t('dashboard.type'), class: 'hidden sm:table-cell', render: (tx) => typeBadge(tx.type) },
                {
                  key: 'amount',
                  label: t('dashboard.amount'),
                  align: 'right',
                  render: (tx) => signedMoney(
                    tx.type === 'expense' ? -tx.amountMinor : tx.type === 'income' ? tx.amountMinor : 0,
                    tx.currency,
                    { locale, accounting: store.preferences.numberFormat === 'accounting' }
                  )
                }
              ],
              rows: recent
            })
          : emptyState({ iconName: 'receipt', title: t('dashboard.noTransactions'), message: t('dashboard.noTransactionsMessage'), actionLabel: t('dashboard.addTransaction'), onAction: () => openTransactionForm({ service: services.transactions, store, toast, onSaved: refresh }), compact: true })
      ]
    }));

    const due = services.recurring ? services.recurring.due() : [];
    const upcoming = services.recurring ? services.recurring.upcoming({ days: 14 }) : [];
    bottomHolder.appendChild(sectionCard({
      title: t('dashboard.recurring'),
      description: due.length ? t('dashboard.dueWaiting', { count: due.length }) : t('dashboard.nothingDue'),
      actions: [el('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => router.navigate('/recurring') }, [el('span', { text: t('dashboard.manage') }), icon('chevron-right', 'h-3.5 w-3.5')])],
      body: [
        due.length
          ? el('div', { class: 'space-y-3' }, [
              badge(t('dashboard.dueBadge', { count: due.length }), 'warning'),
              el('ul', { class: 'space-y-2' }, due.slice(0, 4).map((item) => el('li', { class: 'flex items-center justify-between gap-2 text-sm' }, [
                el('span', { class: 'truncate text-slate-700 dark:text-slate-200', text: item.rule.name }),
                el('span', { class: 'num text-xs text-slate-500 dark:text-slate-400', text: formatDate(item.dueDate, { locale }) })
              ]))),
              el('button', { type: 'button', class: 'btn btn-primary btn-sm', onclick: () => router.navigate('/recurring') }, [icon('check', 'h-3.5 w-3.5'), el('span', { text: t('dashboard.reviewPost') })])
            ])
          : upcoming.length
            ? el('ul', { class: 'space-y-2' }, upcoming.slice(0, 4).map((item) => el('li', { class: 'flex items-center justify-between gap-2 text-sm' }, [
                el('span', { class: 'truncate text-slate-700 dark:text-slate-200', text: item.rule.name }),
                el('span', { class: 'num text-xs text-slate-500 dark:text-slate-400', text: formatDate(item.dueDate, { locale }) })
              ])))
            : emptyState({ iconName: 'repeat', title: t('dashboard.noUpcoming'), message: t('dashboard.noUpcomingMessage'), actionLabel: t('dashboard.addRule'), onAction: () => router.navigate('/recurring'), compact: true })
      ]
    }));
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
