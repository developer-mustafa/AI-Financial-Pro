/**
 * Reusable UI primitives.
 *
 * Every screen composes these builders instead of writing markup by hand.
 * All builders return DOM nodes and take plain options, so there is exactly one
 * implementation of each visual pattern (buttons, fields, cards, tables,
 * pagination, chips, progress bars, empty/loading/error states).
 */

import { el, icon, clear, frag } from '../utils/dom.js';
import { formatMoney, formatNumber, formatPercent } from '../utils/currency.js';
import { PAYMENT_METHODS, ACCOUNT_TYPES, TRANSACTION_TYPES } from '../config/defaults.js';
import { t } from '../i18n/index.js';

export { el, icon };

/* --------------------------------------------------------------------------- *
 * Typography / small pieces
 * --------------------------------------------------------------------------- */

export const TONES = {
  neutral: {
    text: 'text-slate-600 dark:text-slate-300',
    soft: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200',
    border: 'border-slate-200 dark:border-slate-700'
  },
  income: {
    text: 'text-income-600 dark:text-income-400',
    soft: 'bg-income-50 text-income-700 dark:bg-income-500/15 dark:text-income-400',
    border: 'border-income-200 dark:border-income-500/30'
  },
  expense: {
    text: 'text-expense-600 dark:text-expense-400',
    soft: 'bg-expense-50 text-expense-700 dark:bg-expense-500/15 dark:text-expense-400',
    border: 'border-expense-200 dark:border-expense-500/30'
  },
  brand: {
    text: 'text-brand-600 dark:text-brand-300',
    soft: 'bg-brand-50 text-brand-700 dark:bg-brand-500/15 dark:text-brand-300',
    border: 'border-brand-200 dark:border-brand-500/30'
  },
  savings: {
    text: 'text-savings-600 dark:text-savings-400',
    soft: 'bg-savings-50 text-savings-700 dark:bg-savings-500/15 dark:text-savings-400',
    border: 'border-savings-200 dark:border-savings-500/30'
  },
  warning: {
    text: 'text-amber-600 dark:text-amber-400',
    soft: 'bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300',
    border: 'border-amber-200 dark:border-amber-500/30'
  }
};

export const money = formatMoney;
export const number = formatNumber;
export const percent = formatPercent;

export function badge(label, tone = 'neutral', { iconName = null, title = '' } = {}) {
  const appearance = TONES[tone] || TONES.neutral;
  return el('span', { class: `badge ${appearance.soft}`, title: title || null, text: label });
}

export function typeBadge(type) {
  const map = {
    income: { tone: 'income', label: t('type.income'), icon: 'trending-up' },
    expense: { tone: 'expense', label: t('type.expense'), icon: 'trending-down' },
    transfer: { tone: 'brand', label: t('type.transfer'), icon: 'arrow-left-right' }
  };
  const spec = map[type] || map.expense;
  return el('span', { class: `badge ${TONES[spec.tone].soft} gap-1` }, [icon(spec.icon, 'h-3 w-3'), el('span', { text: spec.label })]);
}

export function statusBadge(status) {
  if (status === 'posted') return null;
  const map = {
    pending: { tone: 'warning', label: t('status.pending') },
    draft: { tone: 'neutral', label: t('status.draft') }
  };
  const spec = map[status] || map.draft;
  return badge(spec.label, spec.tone);
}

const labelOr = (key, fallback) => {
  const value = t(key);
  return value === key ? fallback : value;
};

export const labels = {
  accountType: (value) => labelOr(`accountType.${value}`, ACCOUNT_TYPES.find((type) => type.value === value)?.label || value),
  paymentMethod: (value) => labelOr(`paymentMethod.${value}`, PAYMENT_METHODS.find((method) => method.value === value)?.label || value),
  transactionType: (value) => labelOr(`type.${value}`, TRANSACTION_TYPES.find((type) => type.value === value)?.label || value)
};

/* --------------------------------------------------------------------------- *
 * Cards and states
 * --------------------------------------------------------------------------- */

export function sectionCard({ title = '', description = '', actions = null, body = null, footer = null, class: className = '', id = null } = {}) {
  const head = title || actions
    ? el('div', { class: 'flex flex-wrap items-start justify-between gap-2 border-b border-slate-100 px-4 py-3 sm:px-5 dark:border-slate-800' }, [
        el('div', { class: 'min-w-0' }, [
          title ? el('h3', { class: 'card-title', text: title }) : null,
          description ? el('p', { class: 'mt-0.5 text-xs text-slate-500 dark:text-slate-400', text: description }) : null
        ]),
        actions ? el('div', { class: 'flex flex-wrap items-center gap-2' }, actions) : null
      ])
    : null;

  return el('section', { class: `card ${className}`, id }, [
    head,
    body ? el('div', { class: 'px-4 py-4 sm:px-5' }, body) : null,
    footer ? el('div', { class: 'border-t border-slate-100 px-4 py-3 sm:px-5 dark:border-slate-800' }, footer) : null
  ]);
}

export function statCard({ label, value, sub = '', iconName = 'wallet', tone = 'brand', hint = '', valueClass = '', action = null }) {
  const appearance = TONES[tone] || TONES.brand;
  return el('div', { class: 'card card-pad flex flex-col gap-2' }, [
    el('div', { class: 'flex items-start justify-between gap-2' }, [
      el('div', { class: 'min-w-0' }, [
        el('p', { class: 'text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400', text: label }),
        el('p', { class: `num mt-1.5 truncate text-xl font-semibold tracking-tight sm:text-2xl ${valueClass || 'text-slate-900 dark:text-slate-50'}` , text: value })
      ]),
      el('span', { class: `flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${appearance.soft}` }, [icon(iconName, 'h-4 w-4')])
    ]),
    sub || hint || action
      ? el('div', { class: 'flex items-end justify-between gap-2' }, [
          el('div', { class: 'min-w-0 text-xs text-slate-500 dark:text-slate-400' }, [
            sub ? el('span', { text: sub }) : null,
            hint ? el('span', { class: 'block text-[11px] opacity-80', text: hint }) : null
          ]),
          action
        ])
      : null
  ]);
}

export function emptyState({ iconName = 'inbox', title = 'Nothing here yet', message = '', actionLabel = null, onAction = null, secondaryLabel = null, onSecondary = null, compact = false } = {}) {
  return el('div', { class: `flex flex-col items-center justify-center text-center ${compact ? 'gap-2 py-8' : 'gap-3 py-12'}` }, [
    el('span', { class: 'flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-100 text-slate-400 dark:bg-slate-800 dark:text-slate-500' }, [
      icon(iconName, 'h-6 w-6')
    ]),
    el('div', { class: 'max-w-md space-y-1' }, [
      el('p', { class: 'text-sm font-semibold text-slate-800 dark:text-slate-100', text: title }),
      message ? el('p', { class: 'text-xs text-slate-500 dark:text-slate-400', text: message }) : null
    ]),
    actionLabel || secondaryLabel
      ? el('div', { class: 'mt-1 flex flex-wrap items-center justify-center gap-2' }, [
          actionLabel ? el('button', { type: 'button', class: 'btn btn-primary btn-sm', onclick: onAction, text: actionLabel }) : null,
          secondaryLabel ? el('button', { type: 'button', class: 'btn btn-secondary btn-sm', onclick: onSecondary, text: secondaryLabel }) : null
        ])
      : null
  ]);
}

export function errorState({ title = 'Something went wrong', message = '', onRetry = null } = {}) {
  return el('div', { class: 'flex flex-col items-center gap-3 py-10 text-center' }, [
    el('span', { class: 'flex h-12 w-12 items-center justify-center rounded-2xl bg-expense-50 text-expense-600 dark:bg-expense-500/15 dark:text-expense-400' }, [
      icon('triangle-alert', 'h-6 w-6')
    ]),
    el('div', { class: 'space-y-1' }, [
      el('p', { class: 'text-sm font-semibold text-slate-800 dark:text-slate-100', text: title }),
      message ? el('p', { class: 'max-w-md text-xs text-slate-500 dark:text-slate-400', text: message }) : null
    ]),
    onRetry ? el('button', { type: 'button', class: 'btn btn-secondary btn-sm', onclick: onRetry, text: t('common.tryAgain') }) : null
  ]);
}

export function skeletonRows(rows = 4, columns = 4) {
  const body = el('tbody');
  for (let r = 0; r < rows; r += 1) {
    const tr = el('tr');
    for (let c = 0; c < columns; c += 1) {
      tr.appendChild(el('td', { class: 'px-3 py-3' }, [el('div', { class: 'skeleton h-4 w-full max-w-[10rem]' })]));
    }
    body.appendChild(tr);
  }
  return body;
}

export function loader(message = 'Loading…') {
  return el('div', { class: 'flex items-center justify-center gap-2 py-10 text-sm text-slate-500 dark:text-slate-400', role: 'status', 'aria-live': 'polite' }, [
    el('span', { class: 'inline-block h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-brand-500 dark:border-slate-600 dark:border-t-brand-400' }),
    el('span', { text: message })
  ]);
}

/* --------------------------------------------------------------------------- *
 * Progress
 * --------------------------------------------------------------------------- */

export function progressBar({ percent: value = 0, tone = 'brand', showLabel = false, label = '', size = 'md' } = {}) {
  const clamped = Math.max(0, Math.min(100, Number(value) || 0));
  const colors = {
    brand: 'bg-brand-500',
    income: 'bg-income-500',
    expense: 'bg-expense-500',
    savings: 'bg-savings-500',
    warning: 'bg-amber-500'
  };
  const height = size === 'sm' ? 'h-1.5' : 'h-2';
  return el('div', { class: 'w-full' }, [
    showLabel
      ? el('div', { class: 'mb-1 flex items-center justify-between text-[11px] text-slate-500 dark:text-slate-400' }, [
          el('span', { text: label }),
          el('span', { class: 'num', text: `${clamped.toFixed(0)}%` })
        ])
      : null,
    el('div', {
      class: `w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800 ${height}`,
      role: 'progressbar',
      'aria-valuenow': String(Math.round(clamped)),
      'aria-valuemin': '0',
      'aria-valuemax': '100',
      'aria-label': label || 'Progress'
    }, [
      el('span', { class: `block h-full rounded-full transition-[width] duration-300 ${colors[tone] || colors.brand}`, style: { width: `${clamped}%` } })
    ])
  ]);
}

/* --------------------------------------------------------------------------- *
 * Tables
 * --------------------------------------------------------------------------- */

/**
 * @param {{columns: Array<{key:string,label:string,align?:string,class?:string,render?:(row:any)=>Node|string}>, rows: any[], rowKey?: (row:any)=>string, onRowClick?: Function, empty?: Node, rowClass?: (row:any)=>string, caption?: string}} options
 */
export function dataTable({ columns, rows, rowKey = (row) => row.id, onRowClick = null, empty = null, rowClass = null, caption = '' }) {
  if (!rows || rows.length === 0) return empty || emptyState({ title: t('common.noRecords') });

  const head = el('thead', {}, [
    el('tr', {}, columns.map((column) =>
      el('th', {
        scope: 'col',
        class: `${column.align === 'right' ? 'text-right' : ''} ${column.class || ''}`
      }, column.headerRender ? [column.headerRender()] : [document.createTextNode(column.label)])
    ))
  ]);

  const body = el('tbody');
  for (const row of rows) {
    const tr = el('tr', { 'data-key': String(rowKey(row)), class: rowClass?.(row) || null });
    if (onRowClick) {
      tr.classList.add('cursor-pointer');
      tr.tabIndex = 0;
      tr.addEventListener('click', (event) => {
        if (event.target.closest('button, a, input, select, label')) return;
        onRowClick(row);
      });
      tr.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          onRowClick(row);
        }
      });
    }
    for (const column of columns) {
      const content = column.render ? column.render(row) : row[column.key];
      const td = el('td', { class: `${column.align === 'right' ? 'text-right' : ''} ${column.class || ''}` });
      if (content instanceof Node) td.appendChild(content);
      else if (Array.isArray(content)) content.forEach((node) => node && td.appendChild(node));
      else td.textContent = content === null || content === undefined ? '' : String(content);
      tr.appendChild(td);
    }
    body.appendChild(tr);
  }

  return el('div', { class: 'table-wrap' }, [
    el('table', { class: 'data' }, [caption ? el('caption', { class: 'sr-only', text: caption }) : null, head, body])
  ]);
}

/**
 * Pagination with page-size selector. Renders nothing when everything fits.
 */
export function pagination({ page, pageSize, total, onPage, onPageSize = null, sizes = [10, 25, 50, 100], itemLabel = 'items' }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.max(1, Math.min(page, pages));
  const from = total === 0 ? 0 : (current - 1) * pageSize + 1;
  const to = Math.min(total, current * pageSize);

  const navButton = (label, targetPage, { disabled = false, iconName = null, current: isCurrent = false } = {}) =>
    el('button', {
      type: 'button',
      class: `btn btn-sm ${isCurrent ? 'btn-primary' : 'btn-secondary'} ${iconName ? 'px-2' : ''}`,
      disabled,
      'aria-current': isCurrent ? 'page' : null,
      'aria-label': iconName ? label : null,
      onclick: () => !disabled && !isCurrent && onPage(targetPage)
    }, iconName ? [icon(iconName, 'h-3.5 w-3.5')] : [el('span', { text: label })]);

  const numbers = [];
  const window = 2;
  for (let p = 1; p <= pages; p += 1) {
    if (p === 1 || p === pages || Math.abs(p - current) <= window) numbers.push(p);
    else if (numbers[numbers.length - 1] !== '…') numbers.push('…');
  }

  return el('div', { class: 'flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 px-4 py-3 text-xs text-slate-500 sm:px-5 dark:border-slate-800 dark:text-slate-400' }, [
    el('div', { class: 'flex items-center gap-2' }, [
      el('span', { class: 'num', text: total === 0 ? `0 ${itemLabel}` : `${from}–${to} of ${total} ${itemLabel}` }),
      onPageSize
        ? el('label', { class: 'ml-2 flex items-center gap-1.5' }, [
            el('span', { class: 'hidden sm:inline', text: t('table.rows') }),
            el('select', {
              class: 'select !w-auto !px-2 !py-1 !text-xs',
              'aria-label': t('table.rowsPerPage'),
              onchange: (event) => onPageSize(Number(event.target.value))
            }, sizes.map((size) => el('option', { value: size, selected: size === pageSize, text: String(size) })))
          ])
        : null
    ]),
    pages > 1
      ? el('nav', { class: 'flex items-center gap-1', 'aria-label': t('table.pagination') }, [
          navButton(t('table.previousPage'), current - 1, { disabled: current === 1, iconName: 'chevron-left' }),
          ...numbers.map((entry) =>
            entry === '…'
              ? el('span', { class: 'px-1 text-slate-400', text: '…' })
              : navButton(String(entry), entry, { current: entry === current })
          ),
          navButton(t('table.nextPage'), current + 1, { disabled: current === pages, iconName: 'chevron-right' })
        ])
      : null
  ]);
}

/* --------------------------------------------------------------------------- *
 * Filter chips / toolbars
 * --------------------------------------------------------------------------- */

export function filterChip({ label, value = '', onRemove, onEdit = null }) {
  return el('span', { class: 'chip' }, [
    el('span', { class: 'text-slate-400 dark:text-slate-500', text: `${label}:` }),
    el('span', { class: 'font-semibold text-slate-700 dark:text-slate-200', text: value }),
    onEdit ? el('button', { type: 'button', class: 'text-slate-400 hover:text-brand-600', 'aria-label': `Edit ${label}`, onclick: onEdit }, [icon('pencil', 'h-3 w-3')]) : null,
    el('button', { type: 'button', class: 'text-slate-400 hover:text-expense-600', 'aria-label': `Remove ${label} filter`, onclick: onRemove }, [icon('x', 'h-3 w-3')])
  ]);
}

export function toolbar({ left = [], right = [] }) {
  return el('div', { class: 'flex flex-wrap items-center justify-between gap-2' }, [
    el('div', { class: 'flex flex-wrap items-center gap-2' }, left),
    el('div', { class: 'flex flex-wrap items-center gap-2' }, right)
  ]);
}

export function searchInput({ value = '', placeholder = 'Search…', onInput, label = 'Search', id = null, class: className = '' }) {
  const input = el('input', {
    type: 'search',
    id,
    class: `input pl-9 ${className}`,
    placeholder,
    value,
    'aria-label': label,
    autocomplete: 'off',
    spellcheck: 'false'
  });
  input.addEventListener('input', (event) => onInput(event.target.value));
  return el('div', { class: 'relative min-w-[12rem] flex-1' }, [
    el('span', { class: 'pointer-events-none absolute inset-y-0 left-0 flex w-9 items-center justify-center text-slate-400' }, [icon('search', 'h-4 w-4')]),
    input
  ]);
}

export function tabs({ items, activeId, onChange, ariaLabel = 'Tabs' }) {
  return el('div', { class: 'flex flex-wrap items-center gap-1 rounded-xl bg-slate-100 p-1 dark:bg-slate-800', role: 'tablist', 'aria-label': ariaLabel }, items.map((item) =>
    el('button', {
      type: 'button',
      role: 'tab',
      'aria-selected': String(item.id === activeId),
      class: `rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
        item.id === activeId
          ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-900 dark:text-slate-100'
          : 'text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200'
      }`,
      text: item.label,
      onclick: () => onChange(item.id)
    })
  ));
}

export function dropdownMenu({ label, iconName = 'ellipsis-vertical', items = [], align = 'right', buttonClass = 'btn btn-ghost btn-icon-sm', title = 'More actions' }) {
  const menu = el('div', {
    class: `absolute z-30 mt-1 hidden min-w-[11rem] overflow-hidden rounded-xl border border-slate-200 bg-white py-1 shadow-pop dark:border-slate-700 dark:bg-slate-900 ${align === 'right' ? 'right-0' : 'left-0'}`
  });
  const wrapper = el('div', { class: 'relative' });
  const button = el('button', { type: 'button', class: buttonClass, 'aria-haspopup': 'menu', 'aria-expanded': 'false', title, 'aria-label': title }, [
    icon(iconName, 'h-4 w-4')
  ]);

  const close = () => {
    menu.classList.add('hidden');
    button.setAttribute('aria-expanded', 'false');
    document.removeEventListener('click', onDocClick);
    document.removeEventListener('keydown', onKey);
  };
  const onDocClick = (event) => {
    if (!wrapper.contains(event.target)) close();
  };
  const onKey = (event) => {
    if (event.key === 'Escape') {
      close();
      button.focus();
    }
  };

  for (const item of items) {
    if (item.divider) {
      menu.appendChild(el('div', { class: 'my-1 border-t border-slate-100 dark:border-slate-800' }));
      continue;
    }
    menu.appendChild(el('button', {
      type: 'button',
      role: 'menuitem',
      class: `flex w-full items-center gap-2 px-3 py-2 text-left text-sm ${
        item.variant === 'danger'
          ? 'text-expense-600 hover:bg-expense-50 dark:text-expense-400 dark:hover:bg-expense-500/10'
          : 'text-slate-600 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-800'
      }`,
      onclick: () => {
        close();
        item.onClick?.();
      }
    }, [icon(item.icon || 'circle', 'h-3.5 w-3.5'), el('span', { text: item.label })]));
  }

  button.addEventListener('click', (event) => {
    event.stopPropagation();
    const isOpen = !menu.classList.contains('hidden');
    if (isOpen) {
      close();
    } else {
      menu.classList.remove('hidden');
      button.setAttribute('aria-expanded', 'true');
      document.addEventListener('click', onDocClick);
      document.addEventListener('keydown', onKey);
    }
  });

  wrapper.append(button, menu);
  return wrapper;
}

/* --------------------------------------------------------------------------- *
 * Form fields
 * --------------------------------------------------------------------------- */

/**
 * Generic field wrapper. Returns `{field, input, setError, clearError, focus}`.
 */
export function field({ label, name, hint = '', required = false, control, id = null, error = null, class: className = '' }) {
  const fieldId = id || `${name || 'field'}-${Math.random().toString(36).slice(2, 7)}`;
  const hintId = hint ? `${fieldId}-hint` : null;
  const errorId = `${fieldId}-error`;

  if (control) {
    control.id = fieldId;
    if (required) control.setAttribute('aria-required', 'true');
    if (hintId) control.setAttribute('aria-describedby', hintId);
  }

  const errorNode = el('p', { class: 'field-error', id: errorId, role: 'alert', hidden: !error, text: error || '' });

  const wrapper = el('div', { class: `min-w-0 ${className}` }, [
    label
      ? el('label', { class: 'label', for: fieldId }, [
          el('span', { text: label }),
          required ? el('span', { class: 'ml-0.5 text-expense-500', 'aria-hidden': 'true', text: '*' }) : null
        ])
      : null,
    control || null,
    hint ? el('p', { class: 'mt-1 text-[11px] text-slate-400 dark:text-slate-500', id: hintId, text: hint }) : null,
    errorNode
  ]);

  return {
    field: wrapper,
    input: control,
    id: fieldId,
    setError(message) {
      errorNode.textContent = message;
      errorNode.removeAttribute('hidden');
      control?.setAttribute('aria-invalid', 'true');
      control?.setAttribute('aria-describedby', errorId);
    },
    clearError() {
      errorNode.textContent = '';
      errorNode.setAttribute('hidden', '');
      control?.removeAttribute('aria-invalid');
    },
    focus() {
      control?.focus();
    }
  };
}

export function textField({ label, name, value = '', type = 'text', placeholder = '', hint = '', required = false, onInput, autofocus = false, maxlength = null, min = null, max = null, step = null, inputmode = null, id = null, error = null, class: className = '' }) {
  const input = el('input', {
    type,
    name,
    value: value ?? '',
    placeholder,
    class: `input ${className}`,
    autocomplete: type === 'password' ? 'current-password' : 'off',
    maxlength,
    min,
    max,
    step,
    inputmode,
    ...(autofocus ? { 'data-autofocus': 'true' } : {})
  });
  if (onInput) input.addEventListener('input', (event) => onInput(event.target.value, event));
  const built = field({ label, name, hint, required, control: input, id, error });
  if (type === 'number') {
    input.addEventListener('keydown', (event) => {
      if (['e', 'E'].includes(event.key)) event.preventDefault();
    });
  }
  return built;
}

export function amountField({ label = 'Amount', name = 'amount', value = '', currency = 'BDT', hint = '', required = true, onInput, error = null, id = null }) {
  const input = el('input', {
    type: 'text',
    name,
    value: value ?? '',
    class: 'input num pl-10',
    placeholder: '0.00',
    inputmode: 'decimal',
    autocomplete: 'off',
    'aria-label': `${label} in ${currency}`
  });
  if (onInput) input.addEventListener('input', (event) => onInput(event.target.value, event));

  const control = el('div', { class: 'relative' }, [
    el('span', { class: 'pointer-events-none absolute inset-y-0 left-0 flex w-9 items-center justify-center text-xs font-medium text-slate-400 dark:text-slate-500', text: currency }),
    input
  ]);
  const built = field({ label, name, hint: hint || `Entered in ${currency}.`, required, control, id, error });
  return { ...built, input, currency };
}

export function selectField({ label, name, value = '', options = [], hint = '', required = false, onChange, placeholder = null, id = null, disabled = false, class: className = '' }) {
  const select = el('select', { name, class: `select ${className}`, disabled, autocomplete: 'off' });
  if (placeholder) select.appendChild(el('option', { value: '', text: placeholder, disabled: true, selected: value === '' || value === null }));
  for (const option of options) {
    const optValue = option.value ?? option;
    select.appendChild(el('option', {
      value: String(optValue),
      selected: String(optValue) === String(value ?? ''),
      text: option.label ?? option.name ?? String(optValue),
      disabled: Boolean(option.disabled)
    }));
  }
  if (onChange) select.addEventListener('change', (event) => onChange(event.target.value, event));
  return field({ label, name, hint, required, control: select, id });
}

export function dateField({ label = 'Date', name = 'date', value = '', hint = '', required = true, onChange, id = null, max = null, min = null }) {
  const input = el('input', { type: 'date', name, value: value ?? '', class: 'input', max, min, autocomplete: 'off' });
  if (onChange) input.addEventListener('change', (event) => onChange(event.target.value, event));
  return { ...field({ label, name, hint, required, control: input, id }), input };
}

export function textareaField({ label, name, value = '', placeholder = '', hint = '', rows = 3, maxlength = null, onInput, id = null, class: className = '' }) {
  const textarea = el('textarea', { name, class: `textarea ${className}`, placeholder, rows, maxlength, value: value ?? '' });
  if (onInput) textarea.addEventListener('input', (event) => onInput(event.target.value, event));
  return field({ label, name, hint, control: textarea, id });
}

export function checkboxField({ label, name, checked = false, hint = '', onChange, id = null }) {
  const input = el('input', { type: 'checkbox', name, checked, class: 'h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500 dark:border-slate-600 dark:bg-slate-800' });
  if (onChange) input.addEventListener('change', (event) => onChange(event.target.checked, event));
  const fieldId = id || `${name}-${Math.random().toString(36).slice(2, 7)}`;
  input.id = fieldId;
  return {
    field: el('div', { class: 'flex items-start gap-2' }, [
      input,
      el('div', { class: 'min-w-0' }, [
        el('label', { class: 'text-sm text-slate-700 dark:text-slate-200', for: fieldId, text: label }),
        hint ? el('p', { class: 'text-[11px] text-slate-400 dark:text-slate-500', text: hint }) : null
      ])
    ]),
    input
  };
}

/** Colour picker with a palette + free-text hex input (validated by sanitizeColor). */
export function colorField({ label = 'Colour', name = 'color', value = '#6366f1', palette = [], onChange, id = null }) {
  const input = el('input', { type: 'text', name, value, class: 'input num w-28', maxlength: 7, 'aria-label': `${label} hex value` });
  const swatches = el('div', { class: 'flex flex-wrap gap-1.5' });
  const select = (color) => {
    input.value = color;
    onChange?.(color);
    refreshSelection();
  };
  const refreshSelection = () => {
    for (const button of swatches.children) {
      button.setAttribute('aria-pressed', String(button.dataset.color === input.value.toLowerCase()));
      button.classList.toggle('ring-2', button.dataset.color === input.value.toLowerCase());
      button.classList.toggle('ring-offset-1', button.dataset.color === input.value.toLowerCase());
    }
  };
  for (const color of palette) {
    swatches.appendChild(el('button', {
      type: 'button',
      class: 'h-6 w-6 rounded-full border border-black/10 dark:border-white/20',
      style: { backgroundColor: color },
      dataset: { color: color.toLowerCase() },
      'aria-label': `Use colour ${color}`,
      'aria-pressed': 'false',
      onclick: () => select(color)
    }));
  }
  input.addEventListener('input', () => onChange?.(input.value));
  refreshSelection();
  const control = el('div', { class: 'space-y-2' }, [swatches, input]);
  return { ...field({ label, name, control, id }), input };
}

/** Icon picker rendered as a scrollable grid of lucide icons with a search box. */
export function iconField({ label = t('common.icon'), name = 'icon', value = 'tag', choices = [], onChange, id = null }) {
  const grid = el('div', { class: 'grid max-h-40 grid-cols-6 gap-1.5 overflow-y-auto rounded-xl border border-slate-200 p-2 sm:grid-cols-8 dark:border-slate-700' });
  const search = el('input', { type: 'search', class: 'input mb-2', placeholder: t('iconPicker.filterPlaceholder'), 'aria-label': t('iconPicker.filterAria'), autocomplete: 'off' });
  let selected = value;

  const paint = (filter = '') => {
    clear(grid);
    for (const name_ of choices.filter((candidate) => candidate.includes(filter.toLowerCase()))) {
      const isSelected = name_ === selected;
      grid.appendChild(el('button', {
        type: 'button',
        class: `flex h-8 items-center justify-center rounded-lg border ${
          isSelected ? 'border-brand-500 bg-brand-50 text-brand-700 dark:bg-brand-500/15 dark:text-brand-200' : 'border-slate-200 text-slate-500 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-400 dark:hover:bg-slate-800'
        }`,
        title: name_,
        'aria-label': `Choose icon ${name_}`,
        'aria-pressed': String(isSelected),
        onclick: () => {
          selected = name_;
          onChange?.(name_);
          paint(search.value);
        }
      }, [icon(name_, 'h-4 w-4')]));
    }
  };
  search.addEventListener('input', (event) => paint(event.target.value));
  paint();
  const control = el('div', {}, [search, grid]);
  return field({ label, name, control, id });
}

/* --------------------------------------------------------------------------- *
 * Misc
 * --------------------------------------------------------------------------- */

export function iconTile(iconName, color = '#6366f1', size = 'md') {
  const dimension = size === 'sm' ? 'h-7 w-7' : size === 'lg' ? 'h-10 w-10' : 'h-8 w-8';
  return el('span', {
    class: `flex ${dimension} shrink-0 items-center justify-center rounded-xl`,
    style: { backgroundColor: `${color}1f`, color }
  }, [icon(iconName, size === 'lg' ? 'h-5 w-5' : 'h-4 w-4')]);
}

export function avatar(name = '?', { size = 'md' } = {}) {
  const initials = String(name || '?')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || '')
    .join('');
  const dimension = size === 'sm' ? 'h-7 w-7 text-[11px]' : 'h-9 w-9 text-xs';
  return el('span', {
    class: `flex ${dimension} items-center justify-center rounded-full bg-brand-100 font-semibold text-brand-700 dark:bg-brand-500/20 dark:text-brand-200`,
    'aria-hidden': 'true',
    text: initials || '?'
  });
}

export function keyValueGrid(pairs, { columns = 2 } = {}) {
  return el('dl', { class: `grid gap-3 ${columns === 3 ? 'sm:grid-cols-3' : columns === 1 ? '' : 'sm:grid-cols-2'}` },
    pairs.filter(Boolean).map(({ label, value, hint }) =>
      el('div', { class: 'min-w-0' }, [
        el('dt', { class: 'text-[11px] uppercase tracking-wide text-slate-400 dark:text-slate-500', text: label }),
        el('dd', { class: 'truncate text-sm text-slate-800 dark:text-slate-100', title: typeof value === 'string' ? value : null }, [
          value instanceof Node ? value : document.createTextNode(value === null || value === undefined || value === '' ? '—' : String(value))
        ]),
        hint ? el('p', { class: 'mt-0.5 text-[11px] text-slate-400 dark:text-slate-500', text: hint }) : null
      ])
    )
  );
}

/** Renders a signed money value with the correct tone. */
export function signedMoney(minor, currency, { locale = 'en-US', accounting = false, showSign = false } = {}) {
  const value = Number(minor) || 0;
  const tone = value > 0 ? 'text-income-600 dark:text-income-400' : value < 0 ? 'text-expense-600 dark:text-expense-400' : 'text-slate-500 dark:text-slate-400';
  return el('span', { class: `num font-medium ${tone}`, text: money(value, { currency, locale, accounting: true, showSign }) });
}

export function chartCard({ title, description = '', actions = null, canvas, footer = null, height = 280 }) {
  const holder = el('div', { class: 'relative w-full', style: { height: `${height}px` } }, [canvas]);
  return sectionCard({
    title,
    description,
    actions,
    body: [holder],
    footer
  });
}

/** Accessible table alternative for chart data (required for screen readers). */
export function chartDataTable({ caption, columns, rows }) {
  return el('details', { class: 'mt-3 text-xs' }, [
    el('summary', { class: 'cursor-pointer text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200', text: t('table.viewAsTable') }),
    el('div', { class: 'mt-2' }, [dataTable({ caption, columns, rows })] )
  ]);
}

export { frag };
