/**
 * Confirmation dialogs for destructive actions.
 *
 * Two levels:
 *  - plain confirm (delete one transaction, archive a category),
 *  - typed confirmation for bulk/irreversible operations (clear all data,
 *    replace the dataset from a backup, overwrite cloud data).
 */

import { el, icon } from '../utils/dom.js';
import { openModal } from './modal.js';
import { t } from '../i18n/index.js';

/**
 * @param {{
 *   title: string, message: string, detail?: string, confirmLabel?: string,
 *   cancelLabel?: string, variant?: 'danger'|'primary', requireText?: string,
 *   tone?: 'danger'|'warning'|'info'
 * }} options
 * @returns {Promise<boolean>}
 */
export function confirmDialog({
  title = t('common.areYouSure'),
  message = '',
  detail = '',
  confirmLabel = t('common.confirm'),
  cancelLabel = t('common.cancel'),
  variant = 'danger',
  tone = 'danger',
  requireText = null
} = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const toneStyles = {
      danger: { icon: 'triangle-alert', color: 'text-expense-600 bg-expense-100 dark:bg-expense-500/15 dark:text-expense-400' },
      warning: { icon: 'circle-alert', color: 'text-amber-600 bg-amber-100 dark:bg-amber-500/15 dark:text-amber-400' },
      info: { icon: 'info', color: 'text-brand-600 bg-brand-100 dark:bg-brand-500/15 dark:text-brand-300' }
    };
    const appearance = toneStyles[tone] || toneStyles.danger;

    const confirmBtn = el('button', {
      type: 'button',
      class: `btn btn-${variant}`,
      text: confirmLabel,
      disabled: Boolean(requireText)
    });

    const input = requireText
      ? el('input', {
          type: 'text',
          class: 'input mt-3',
          placeholder: requireText,
          autocomplete: 'off',
          'aria-label': t('common.typeToConfirm', { text: requireText })
        })
      : null;

    if (input) {
      input.addEventListener('input', () => {
        confirmBtn.disabled = input.value.trim().toUpperCase() !== String(requireText).toUpperCase();
      });
    }

    const dialog = openModal({
      title,
      size: 'sm',
      dismissible: true,
      onClose: (reason) => finish(false),
      content: [
        el('div', { class: 'flex gap-3' }, [
          el('div', { class: `flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${appearance.color}` }, [
            icon(appearance.icon, 'h-5 w-5')
          ]),
          el('div', { class: 'min-w-0 flex-1 space-y-2' }, [
            message ? el('p', { class: 'text-sm text-slate-700 dark:text-slate-200', text: message }) : null,
            detail ? el('p', { class: 'text-xs text-slate-500 dark:text-slate-400', text: detail }) : null,
            input
          ])
        ])
      ],
      footer: el('div', { class: 'flex items-center justify-end gap-2' }, [
        el('button', {
          type: 'button',
          class: 'btn btn-secondary',
          text: cancelLabel,
          onclick: () => {
            finish(false);
            dialog.close('cancel');
          }
        }),
        confirmBtn
      ])
    });

    confirmBtn.addEventListener('click', () => {
      finish(true);
      dialog.close('confirm');
    });

    if (input) input.focus();
  });
}

/** Convenience wrapper for single-record deletion. */
export function confirmDelete(what, { detail = '' } = {}) {
  return confirmDialog({
    title: t('common.deleteWhat', { what }),
    message: t('common.cannotUndo'),
    detail,
    confirmLabel: t('common.delete'),
    variant: 'danger',
    tone: 'danger'
  });
}
