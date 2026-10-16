/**
 * Transaction form (create / edit), shared by every screen that needs it:
 * Transactions, Income, Expenses, Dashboard quick-add, Accounts (transfer) and
 * Financial Goals (goal fund transfer).
 *
 * The form never mutates state itself — it hands a plain object to
 * `transactionService`, which validates and applies the change.
 */

import { el, icon, clear } from '../../utils/dom.js';
import { openModal } from '../../components/modal.js';
import { confirmDialog } from '../../components/confirmDialog.js';
import { amountField, dateField, selectField, textField, textareaField, typeBadge, money, labels } from '../../components/ui.js';
import { PAYMENT_METHODS, TRANSACTION_STATUSES, TRANSACTION_TYPES } from '../../config/defaults.js';
import { formatMoney, fromMinor, parseAmountToMinor, normalizeCurrency } from '../../utils/currency.js';
import { todayISO } from '../../utils/date.js';
import { RESOURCES } from '../../core/state.js';
import { sanitizeLine } from '../../utils/sanitize.js';
import { t } from '../../i18n/index.js';

/**
 * @param {{
 *   service: object, store: object, toast: object,
 *   transaction?: object|null, defaults?: object, lockType?: string|null,
 *   title?: string, onSaved?: (record:object, meta:object)=>void, onCancel?: Function
 * }} options
 */
export function openTransactionForm({
  service,
  store,
  toast,
  transaction = null,
  defaults = {},
  lockType = null,
  title = null,
  onSaved = null,
  onCancel = null
}) {
  const isEdit = Boolean(transaction);
  const preferences = store.preferences;
  const locale = preferences.locale;

  const activeAccounts = () => {
    const accounts = store.list(RESOURCES.ACCOUNTS);
    const usable = accounts.filter((account) => !account.archived);
    return usable.length ? usable : accounts;
  };

  const accounts = activeAccounts();
  const fallbackAccountId =
    transaction?.accountId ||
    defaults.accountId ||
    preferences.defaultAccountId ||
    accounts[0]?.id ||
    '';

  const accountById = (id) => store.byId(RESOURCES.ACCOUNTS, id);

  const state = {
    type: lockType || transaction?.type || defaults.type || 'expense',
    amount: transaction ? fromMinor(transaction.amountMinor, transaction.currency).toFixed(2) : defaults.amount || '',
    date: transaction?.date || defaults.date || todayISO(),
    accountId: fallbackAccountId,
    toAccountId: transaction?.toAccountId || defaults.toAccountId || '',
    categoryId: transaction?.categoryId || defaults.categoryId || '',
    description: transaction?.description || defaults.description || '',
    payee: transaction?.payee || defaults.payee || '',
    paymentMethod: transaction?.paymentMethod || preferences.defaultPaymentMethod || 'cash',
    tags: (transaction?.tags || []).join(', '),
    notes: transaction?.notes || '',
    status: transaction?.status || 'posted',
    receiptRef: transaction?.receiptRef || ''
  };

  const currentCurrency = () => normalizeCurrency(accountById(state.accountId)?.currency || preferences.currency);

  const body = el('div', { class: 'space-y-4' });
  const errorBanner = el('div', { class: 'hidden rounded-xl border border-expense-200 bg-expense-50 p-3 text-xs text-expense-700 dark:border-expense-500/30 dark:bg-expense-500/10 dark:text-expense-300', role: 'alert' });

  let fields = {};
  let modal = null;
  let submitting = false;

  function setError(field, message) {
    fields[field]?.setError(message);
  }

  function clearErrors() {
    for (const entry of Object.values(fields)) entry?.clearError?.();
    errorBanner.classList.add('hidden');
    errorBanner.textContent = '';
  }

  function categoryOptions() {
    const type = state.type === 'income' ? 'income' : 'expense';
    const ordered = store.orderedCategories(type);
    const includeArchived = Boolean(transaction?.categoryId);
    return ordered
      .filter((category) => includeArchived || !category.archived)
      .map((category) => ({
        value: category.id,
        label: `${'— '.repeat(category.depth)}${category.name}${category.archived ? ` ${t('tx.archived')}` : ''}`
      }));
  }

  function accountOptions() {
    return accounts.map((account) => ({
      value: account.id,
      label: `${account.name} · ${account.currency}${account.archived ? ` ${t('tx.archived')}` : ''}`
    }));
  }

  function renderTypeSwitch() {
    if (lockType) return null;
    return el('div', { class: 'grid grid-cols-3 gap-1 rounded-xl bg-slate-100 p-1 dark:bg-slate-800', role: 'tablist', 'aria-label': t('txForm.typeAria') },
      TRANSACTION_TYPES.map((type) =>
        el('button', {
          type: 'button',
          role: 'tab',
          'aria-selected': String(state.type === type.value),
          class: `flex items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium transition-colors ${
            state.type === type.value
              ? type.value === 'income'
                ? 'bg-white text-income-700 shadow-sm dark:bg-slate-900 dark:text-income-400'
                : type.value === 'expense'
                  ? 'bg-white text-expense-700 shadow-sm dark:bg-slate-900 dark:text-expense-400'
                  : 'bg-white text-brand-700 shadow-sm dark:bg-slate-900 dark:text-brand-300'
              : 'text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200'
          }`,
          onclick: () => {
            state.type = type.value;
            if (type.value === 'transfer') state.categoryId = '';
            else state.toAccountId = '';
            if (type.value !== 'transfer' && state.categoryId) {
              const category = store.byId(RESOURCES.CATEGORIES, state.categoryId);
              if (category && category.type !== type.value) state.categoryId = '';
            }
            renderFields();
          }
        }, [icon(type.icon, 'h-3.5 w-3.5'), el('span', { text: labels.transactionType(type.value) })])
      )
    );
  }

  function renderFields() {
    clearErrors();
    clear(body);
    fields = {};
    const currency = currentCurrency();

    body.appendChild(errorBanner);
    const typeSwitch = renderTypeSwitch();
    if (typeSwitch) body.appendChild(typeSwitch);

    const amount = amountField({
      label: t('txForm.amount'),
      value: state.amount,
      currency,
      required: true,
      hint: t(state.type === 'transfer' ? 'txForm.amountHintTransfer' : 'txForm.amountHint', { currency }),
      onInput: (value) => {
        state.amount = value;
      }
    });
    fields.amount = amount;

    const date = dateField({
      label: t('tx.col.date'),
      value: state.date,
      required: true,
      onChange: (value) => {
        state.date = value;
      }
    });
    fields.date = date;

    const account = selectField({
      label: t(state.type === 'transfer' ? 'txForm.fromAccount' : 'txForm.account'),
      name: 'accountId',
      value: state.accountId,
      options: [...accountOptions(), { value: '', label: t('txForm.noAccounts'), disabled: true }],
      required: true,
      onChange: (value) => {
        state.accountId = value;
        const account_ = accountById(value);
        if (account_ && normalizeCurrency(account_.currency) !== currency) {
          // Currency follows the account; amounts are not converted.
          state.amount = '';
        }
        if (state.toAccountId === value) state.toAccountId = '';
        const category = store.byId(RESOURCES.CATEGORIES, state.categoryId);
        if (category && state.type !== 'transfer' && category.type !== state.type) state.categoryId = '';
        renderFields();
      }
    });
    fields.accountId = account;

    let toAccount = null;
    if (state.type === 'transfer') {
      const destinations = accounts.filter((account_) => account_.id !== state.accountId && normalizeCurrency(account_.currency) === currency);
      if (state.toAccountId && !destinations.some((account_) => account_.id === state.toAccountId)) state.toAccountId = '';
      toAccount = selectField({
        label: t('txForm.toAccount'),
        name: 'toAccountId',
        value: state.toAccountId,
        options: [
          { value: '', label: destinations.length ? t('txForm.chooseDestination') : t('txForm.noMatchingAccounts'), disabled: true },
          ...destinations.map((account_) => ({ value: account_.id, label: account_.name }))
        ],
        required: true,
        onChange: (value) => {
          state.toAccountId = value;
        }
      });
      fields.toAccountId = toAccount;
    }

    let category = null;
    if (state.type !== 'transfer') {
      category = selectField({
        label: t('txForm.category'),
        name: 'categoryId',
        value: state.categoryId,
        options: [{ value: '', label: t('txForm.chooseCategory'), disabled: true }, ...categoryOptions()],
        required: true,
        onChange: (value) => {
          state.categoryId = value;
          const selected = store.byId(RESOURCES.CATEGORIES, value);
          if (selected && !state.description) {
            state.description = selected.name;
            fields.description.input.value = selected.name;
          }
        }
      });
      fields.categoryId = category;
    }

    const description = textField({
      label: t('txForm.description'),
      name: 'description',
      value: state.description,
      placeholder: t(state.type === 'transfer' ? 'txForm.descriptionPlaceholderTransfer' : 'txForm.descriptionPlaceholder'),
      maxlength: 200,
      hint: t('txForm.descriptionHint'),
      onInput: (value) => {
        state.description = value;
      }
    });
    fields.description = description;

    const payee = textField({
      label: t(state.type === 'income' ? 'txForm.payer' : 'txForm.payee'),
      name: 'payee',
      value: state.payee,
      placeholder: t('txForm.optional'),
      maxlength: 120,
      onInput: (value) => {
        state.payee = value;
      }
    });
    fields.payee = payee;

    const payment = selectField({
      label: t('txForm.paymentMethod'),
      name: 'paymentMethod',
      value: state.paymentMethod,
      options: PAYMENT_METHODS.map((method) => ({ value: method.value, label: labels.paymentMethod(method.value) })),
      onChange: (value) => {
        state.paymentMethod = value;
      }
    });
    fields.paymentMethod = payment;

    const status = selectField({
      label: t('txForm.status'),
      name: 'status',
      value: state.status,
      options: TRANSACTION_STATUSES.map((entry) => ({ value: entry.value, label: t(`status.${entry.value}`) })),
      hint: t('txForm.statusHint'),
      onChange: (value) => {
        state.status = value;
      }
    });
    fields.status = status;

    body.appendChild(el('div', { class: 'grid gap-4 sm:grid-cols-2' }, [amount.field, date.field]));
    body.appendChild(el('div', { class: 'grid gap-4 sm:grid-cols-2' }, [account.field, toAccount ? toAccount.field : category?.field || null]));
    body.appendChild(description.field);
    body.appendChild(el('div', { class: 'grid gap-4 sm:grid-cols-2' }, [payee.field, payment.field]));

    const tags = textField({
      label: t('txForm.tags'),
      name: 'tags',
      value: state.tags,
      placeholder: t('txForm.tagsPlaceholder'),
      hint: t('txForm.tagsHint'),
      onInput: (value) => {
        state.tags = value;
      }
    });
    fields.tags = tags;

    const advanced = el('details', { class: 'rounded-xl border border-slate-200 dark:border-slate-700' }, [
      el('summary', { class: 'cursor-pointer px-3 py-2 text-xs font-medium text-slate-600 dark:text-slate-300', text: t('txForm.advanced') }),
      el('div', { class: 'space-y-3 border-t border-slate-200 p-3 dark:border-slate-700' }, [
        textareaField({
          label: t('txForm.notes'),
          name: 'notes',
          value: state.notes,
          placeholder: t('txForm.notesPlaceholder'),
          maxlength: 2000,
          onInput: (value) => {
            state.notes = value;
          }
        }).field,
        textField({
          label: t('txForm.receiptRef'),
          name: 'receiptRef',
          value: state.receiptRef,
          placeholder: t('txForm.receiptPlaceholder'),
          maxlength: 500,
          onInput: (value) => {
            state.receiptRef = value;
          }
        }).field,
        status.field
      ])
    ]);

    body.appendChild(el('div', { class: 'grid gap-4 sm:grid-cols-2' }, [tags.field, el('div', { class: 'flex items-end' }, [
      el('div', { class: 'w-full rounded-xl bg-slate-50 p-3 text-[11px] leading-relaxed text-slate-500 dark:bg-slate-800/60 dark:text-slate-400' }, [
        el('p', { class: 'font-medium text-slate-600 dark:text-slate-300', text: t('txForm.howRecorded') }),
        el('p', { text: t(state.type === 'income' ? 'txForm.howIncome' : state.type === 'expense' ? 'txForm.howExpense' : 'txForm.howTransfer') })
      ])
    ])]));
    body.appendChild(advanced);

    if (isEdit && transaction) {
      body.appendChild(el('p', { class: 'text-[11px] text-slate-400 dark:text-slate-500', text: t('txForm.createdUpdated', { created: transaction.createdAt, updated: transaction.updatedAt }) }));
    }
  }

  function collect() {
    return {
      type: state.type,
      amount: state.amount,
      currency: currentCurrency(),
      date: state.date,
      accountId: state.accountId,
      toAccountId: state.type === 'transfer' ? state.toAccountId : null,
      categoryId: state.type === 'transfer' ? null : state.categoryId,
      description: sanitizeLine(state.description, 200),
      payee: sanitizeLine(state.payee, 120),
      paymentMethod: state.paymentMethod,
      tags: state.tags,
      notes: state.notes,
      status: state.status,
      receiptRef: state.receiptRef
    };
  }

  function applyErrors(errors) {
    let first = null;
    for (const [field, message] of Object.entries(errors)) {
      const entry = fields[field];
      if (entry) {
        entry.setError(message);
        if (!first) first = entry;
      } else {
        errorBanner.textContent = message;
        errorBanner.classList.remove('hidden');
      }
    }
    if (first?.input?.focus) first.input.focus();
    else if (typeof first?.focus === 'function') first.focus();
  }

  async function submit({ another = false } = {}) {
    if (submitting) return; // prevents accidental duplicate submissions
    const input = collect();
    submitting = true;
    try {
      const result = isEdit ? service.update(transaction.id, input) : service.add(input);
      if (!result.ok) {
        applyErrors(result.errors || { id: t('txForm.saveFailed') });
        toast?.error(t('txForm.notSaved.title'), t('txForm.notSaved.message'));
        return;
      }
      if (Array.isArray(result.warnings) && result.warnings.length) {
        const proceed = await confirmDialog({
          title: t('txForm.duplicate.title'),
          message: result.warnings[0],
          detail: t('txForm.duplicate.detail'),
          confirmLabel: t('txForm.duplicate.confirm'),
          variant: 'primary',
          tone: 'warning'
        });
        if (!proceed) {
          // Roll the change back: nothing was committed for a new record, but an
          // edit already applied, so undo it by restoring the previous values.
          if (isEdit && transaction) service.update(transaction.id, transaction);
          else if (result.record) service.remove(result.record.id);
          return;
        }
      }

      onSaved?.(result.record, { another });
      toast?.success(
        t(isEdit ? 'txForm.updated' : 'txForm.added'),
        `${labels.transactionType(result.record.type)} · ${money(result.record.amountMinor, { currency: result.record.currency, locale })}`
      );

      if (another && !isEdit) {
        state.amount = '';
        state.description = '';
        state.payee = '';
        state.tags = '';
        state.notes = '';
        state.receiptRef = '';
        renderFields();
        fields.amount?.input?.focus();
      } else {
        modal?.close('saved');
      }
    } finally {
      submitting = false;
    }
  }

  const footer = el('div', { class: 'flex flex-wrap items-center justify-between gap-2' }, [
    el('div', { class: 'flex items-center gap-2' }, [
      !isEdit
        ? el('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: t('txForm.saveAnother'), onclick: () => submit({ another: true }) })
        : null
    ]),
    el('div', { class: 'flex items-center gap-2' }, [
      el('button', {
        type: 'button',
        class: 'btn btn-secondary',
        text: t('common.cancel'),
        onclick: () => {
          onCancel?.();
          modal?.close('cancel');
        }
      }),
      el('button', {
        type: 'button',
        class: 'btn btn-primary',
        text: t(isEdit ? 'txForm.saveChanges' : 'txForm.add'),
        onclick: () => void submit({ another: false })
      })
    ])
  ]);

  const form = el('form', {
    class: 'space-y-4',
    novalidate: true,
    onsubmit: (event) => {
      event.preventDefault();
      void submit({ another: false });
    }
  }, [body]);

  renderFields();

  modal = openModal({
    title: title || (isEdit ? t('txForm.editTitle') : t('txForm.addTitle')),
    description: isEdit ? t('txForm.editDesc') : undefined,
    size: 'lg',
    content: form,
    footer,
    onClose: (reason) => {
      if (reason !== 'saved') onCancel?.();
    }
  });

  fields.amount?.input?.focus();
  fields.amount?.input?.select?.();

  return {
    modal,
    submit: () => submit({ another: false }),
    get state() {
      return { ...state };
    },
    destroy: () => modal?.close('destroy')
  };
}

/** Convenience: a transfer form used by Accounts and Financial Goals. */
export function openTransferForm({ service, store, toast, defaults = {}, title = t('txForm.transferTitle'), onSaved = null }) {
  return openTransactionForm({
    service,
    store,
    toast,
    defaults: { ...defaults, type: 'transfer' },
    lockType: 'transfer',
    title,
    onSaved
  });
}

/** Currency-aware amount preview helper used in confirmations. */
export function previewAmount(amountMinor, currency, locale = 'en-US') {
  return formatMoney(amountMinor, { currency, locale });
}

export { parseAmountToMinor };
