/**
 * Chart.js integration (lazy-loaded).
 *
 * Chart.js is injected on demand the first time a chart is needed, so pages
 * without charts (Transactions, Settings…) cost nothing. Every chart is
 * registered against its canvas, so re-rendering a view destroys the previous
 * instance instead of leaking it.
 *
 * Charts are always paired with a text/table alternative by the views
 * (see `chartDataTable` in components/ui.js) for accessibility.
 */

import { appConfig } from '../config/appConfig.js';

let loadingPromise = null;

/** Injects the vendored Chart.js UMD build once. */
export function ensureChartLib() {
  if (globalThis.Chart) return Promise.resolve(globalThis.Chart);
  if (loadingPromise) return loadingPromise;
  loadingPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = new URL('../../assets/vendor/chart.umd.js', import.meta.url).href;
    script.async = true;
    script.onload = () => (globalThis.Chart ? resolve(globalThis.Chart) : reject(new Error('Chart.js did not initialise.')));
    script.onerror = () => {
      loadingPromise = null;
      reject(new Error('Chart.js could not be loaded. Check that assets/vendor/chart.umd.js exists (run `npm run vendor`).'));
    };
    document.head.appendChild(script);
  });
  return loadingPromise;
}

export function isDarkMode() {
  return document.documentElement.classList.contains('dark');
}

function palette() {
  const dark = isDarkMode();
  return {
    dark,
    grid: dark ? appConfig.chartColors.grid.dark : appConfig.chartColors.grid.light,
    tick: dark ? appConfig.chartColors.tick.dark : appConfig.chartColors.tick.light,
    income: appConfig.chartColors.income,
    expense: appConfig.chartColors.expense,
    net: appConfig.chartColors.net,
    savings: appConfig.chartColors.savings,
    warning: appConfig.chartColors.warning
  };
}

const prefersReducedMotion = () =>
  typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)').matches : false;

/** Shared defaults so every chart looks consistent in both themes. */
function applyDefaults(Chart) {
  const colors = palette();
  Chart.defaults.font.family = getComputedStyle(document.body).fontFamily || 'sans-serif';
  Chart.defaults.font.size = 11;
  Chart.defaults.color = colors.tick;
  Chart.defaults.animation = prefersReducedMotion()
    ? false
    : { duration: 260, easing: 'easeOutQuart' };
  Chart.defaults.responsive = true;
  Chart.defaults.maintainAspectRatio = false;
  Chart.defaults.plugins.legend.labels.usePointStyle = true;
  Chart.defaults.plugins.legend.labels.boxWidth = 8;
  Chart.defaults.plugins.legend.labels.padding = 14;
  Chart.defaults.plugins.tooltip.padding = 10;
  Chart.defaults.plugins.tooltip.cornerRadius = 8;
  Chart.defaults.plugins.tooltip.titleFont = { weight: '600' };
}

/**
 * Creates (or replaces) a chart on a canvas.
 * @param {HTMLCanvasElement} canvas
 * @param {(Chart:any, theme:object) => object} configFactory
 * @returns {Promise<any>} the chart instance
 */
export async function mountChart(canvas, configFactory) {
  const Chart = await ensureChartLib();
  applyDefaults(Chart);
  const existing = Chart.getChart(canvas);
  if (existing) existing.destroy();
  const config = configFactory(Chart, palette());
  const chart = new Chart(canvas, config);
  chart.$spendwise = true;
  return chart;
}

/** Destroys every chart attached to the given canvases (called on unmount). */
export function destroyCharts(...canvases) {
  const Chart = globalThis.Chart;
  if (!Chart) return;
  for (const canvas of canvases.flat()) {
    if (!canvas) continue;
    const chart = Chart.getChart(canvas);
    if (chart) chart.destroy();
  }
}

/** Convenience: registers a teardown for a set of canvases. */
export function teardownCharts(disposables, ...canvases) {
  disposables?.add(() => destroyCharts(...canvases));
}

/* --------------------------------------------------------------------------- *
 * Config builders
 * --------------------------------------------------------------------------- */

const baseScales = (theme, { stacked = false, currency = null, tickMoney = null } = {}) => ({
  x: {
    stacked,
    grid: { display: false },
    border: { display: false },
    ticks: { color: theme.tick, maxRotation: 0, autoSkipPadding: 12 }
  },
  y: {
    stacked,
    beginAtZero: true,
    grid: { color: theme.grid, drawBorder: false },
    border: { display: false },
    ticks: {
      color: theme.tick,
      maxTicksLimit: 6,
      callback: (value) => (tickMoney ? tickMoney(value) : value)
    }
  }
});

/** Income vs expense grouped/stacked bar chart. */
export function incomeExpenseBarConfig({ labels, income, expense, currency, formatValue, stacked = false }) {
  return (Chart, theme) => ({
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'Income',
          data: income,
          backgroundColor: theme.income,
          borderRadius: 6,
          maxBarThickness: 34
        },
        {
          label: 'Expense',
          data: expense,
          backgroundColor: theme.expense,
          borderRadius: 6,
          maxBarThickness: 34
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: baseScales(theme, { stacked, tickMoney: formatValue }),
      plugins: {
        legend: { position: 'top', align: 'end' },
        tooltip: {
          callbacks: {
            label: (ctx) => `${ctx.dataset.label}: ${formatValue ? formatValue(ctx.parsed.y, currency) : ctx.parsed.y}`
          }
        }
      }
    }
  });
}

/** Doughnut chart for category breakdowns. */
export function doughnutConfig({ labels, values, colors, currency, formatValue, totalLabel = 'Total' }) {
  return (Chart, theme) => ({
    type: 'doughnut',
    data: {
      labels,
      datasets: [
        {
          data: values,
          backgroundColor: colors,
          borderColor: theme.dark ? '#0f172a' : '#ffffff',
          borderWidth: 2,
          hoverOffset: 4
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '62%',
      plugins: {
        legend: { position: 'bottom', labels: { padding: 12 } },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const total = ctx.dataset.data.reduce((sum, value) => sum + value, 0);
              const share = total > 0 ? (ctx.parsed / total) * 100 : 0;
              return `${ctx.label}: ${formatValue ? formatValue(ctx.parsed, currency) : ctx.parsed} (${share.toFixed(1)}%)`;
            }
          }
        }
      }
    }
  });
}

/** Line chart (cash flow, savings trend). */
export function lineConfig({ labels, series, currency, formatValue, fill = true }) {
  return (Chart, theme) => ({
    type: 'line',
    data: {
      labels,
      datasets: series.map((entry) => ({
        label: entry.label,
        data: entry.data,
        borderColor: entry.color,
        backgroundColor: entry.color,
        borderWidth: 2,
        tension: 0.32,
        pointRadius: 2.5,
        pointHoverRadius: 4,
        fill: entry.fill ?? fill,
        ...(entry.dashed ? { borderDash: [5, 4] } : {})
      }))
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: baseScales(theme, { tickMoney: formatValue }),
      plugins: {
        legend: { position: 'top', align: 'end' },
        tooltip: {
          callbacks: {
            label: (ctx) => `${ctx.dataset.label}: ${formatValue ? formatValue(ctx.parsed.y, currency) : ctx.parsed.y}`
          }
        }
      }
    }
  });
}

/** Horizontal bar chart used for "top categories" and budget utilisation. */
export function horizontalBarConfig({ labels, values, color, currency, formatValue, colors = null }) {
  return (Chart, theme) => ({
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          data: values,
          backgroundColor: colors || color || theme.net,
          borderRadius: 6,
          maxBarThickness: 22
        }
      ]
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: {
          beginAtZero: true,
          grid: { color: theme.grid, drawBorder: false },
          border: { display: false },
          ticks: { color: theme.tick, maxTicksLimit: 5, callback: (value) => (formatValue ? formatValue(value, currency) : value) }
        },
        y: {
          grid: { display: false },
          border: { display: false },
          ticks: { color: theme.tick, autoSkip: false }
        }
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => (formatValue ? formatValue(ctx.parsed.x, currency) : ctx.parsed.x)
          }
        }
      }
    }
  });
}

/**
 * Highlights a chart canvas that has no data with a friendly overlay instead of
 * an empty grid.
 */
export function chartEmptyOverlay(message = 'No data for this period.') {
  return { message };
}
