/**
 * Toast notifications.
 *
 * Replaces `alert()`. Non-blocking, accessible (`role="status"` /
 * `role="alert"`), auto-dismissing with a pause-on-hover/focus behaviour, and
 * capped so a burst of operations cannot flood the screen.
 */

import { el, icon } from '../utils/dom.js';

const VARIANTS = {
  success: { icon: 'circle-check', wrap: 'border-income-200 bg-white text-slate-800 dark:border-income-500/30 dark:bg-slate-900 dark:text-slate-100', accent: 'text-income-600 dark:text-income-400', live: 'polite' },
  error: { icon: 'circle-alert', wrap: 'border-expense-200 bg-white text-slate-800 dark:border-expense-500/30 dark:bg-slate-900 dark:text-slate-100', accent: 'text-expense-600 dark:text-expense-400', live: 'assertive' },
  warning: { icon: 'triangle-alert', wrap: 'border-amber-200 bg-white text-slate-800 dark:border-amber-500/30 dark:bg-slate-900 dark:text-slate-100', accent: 'text-amber-600 dark:text-amber-400', live: 'polite' },
  info: { icon: 'info', wrap: 'border-brand-200 bg-white text-slate-800 dark:border-brand-500/30 dark:bg-slate-900 dark:text-slate-100', accent: 'text-brand-600 dark:text-brand-300', live: 'polite' }
};

const MAX_VISIBLE = 4;

export function createToastHost({ container = document.body } = {}) {
  const region = el('div', {
    class: 'pointer-events-none fixed right-3 top-3 z-[70] flex w-[min(92vw,22rem)] flex-col items-stretch gap-2 sm:right-4 sm:top-4',
    role: 'region',
    'aria-label': 'Notifications'
  });
  container.appendChild(region);
  const active = new Set();

  function dismiss(node) {
    if (!node || !active.has(node)) return;
    active.delete(node);
    node.style.opacity = '0';
    node.style.transform = 'translateX(8px)';
    setTimeout(() => node.remove(), 160);
  }

  function show({ title, message = '', variant = 'info', duration = 4500, action = null, dismissible = true } = {}) {
    const spec = VARIANTS[variant] || VARIANTS.info;
    while (active.size >= MAX_VISIBLE) dismiss(active.values().next().value);

    const closeBtn = dismissible
      ? el('button', {
          type: 'button',
          class: 'btn btn-ghost btn-icon-sm shrink-0 text-slate-400',
          'aria-label': 'Dismiss notification',
          onclick: () => dismiss(node)
        }, [icon('x', 'h-3.5 w-3.5')])
      : null;

    const actionBtn = action
      ? el('button', {
          type: 'button',
          class: 'btn btn-secondary btn-sm mt-2',
          onclick: () => {
            dismiss(node);
            action.onClick?.();
          },
          text: action.label || 'View'
        })
      : null;

    const node = el('div', {
      class: `pointer-events-auto flex w-full items-start gap-3 rounded-xl border p-3 shadow-pop transition-all duration-150 animate-slide-in-right ${spec.wrap}`,
      role: variant === 'error' ? 'alert' : 'status',
      'aria-live': spec.live
    }, [
      icon(spec.icon, `mt-0.5 h-4 w-4 shrink-0 ${spec.accent}`),
      el('div', { class: 'min-w-0 flex-1' }, [
        title ? el('p', { class: 'text-sm font-semibold leading-tight', text: title }) : null,
        message ? el('p', { class: 'mt-0.5 text-xs leading-snug text-slate-600 dark:text-slate-300', text: message }) : null,
        actionBtn
      ]),
      closeBtn
    ]);

    let timer = null;
    const arm = () => {
      if (duration > 0) timer = setTimeout(() => dismiss(node), duration);
    };
    const disarm = () => timer && clearTimeout(timer);
    node.addEventListener('mouseenter', disarm);
    node.addEventListener('focusin', disarm);
    node.addEventListener('mouseleave', arm);
    node.addEventListener('focusout', arm);

    region.appendChild(node);
    active.add(node);
    arm();
    return { dismiss: () => dismiss(node), node };
  }

  const api = {
    show,
    success: (title, message, extra) => show({ title, message, variant: 'success', ...extra }),
    error: (title, message, extra) => show({ title, message, variant: 'error', duration: 8000, ...extra }),
    warning: (title, message, extra) => show({ title, message, variant: 'warning', duration: 6500, ...extra }),
    info: (title, message, extra) => show({ title, message, variant: 'info', ...extra }),
    /** Renders an error thrown by a service without leaking internals. */
    fromError(error, fallback = 'Something went wrong.') {
      const message = error?.message && error.message !== 'undefined' ? error.message : fallback;
      return api.error(fallback, message);
    },
    dismissAll() {
      for (const node of [...active]) dismiss(node);
    },
    get count() {
      return active.size;
    },
    destroy() {
      api.dismissAll();
      region.remove();
    }
  };
  return api;
}
