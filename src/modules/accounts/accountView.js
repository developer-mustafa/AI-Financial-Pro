/**
 * Accounts & Wallets screen.
 *
 * Shows the net position per currency, the full account list with live
 * balances, and lets the user create/edit/archive/delete accounts, transfer
 * money between them and inspect an account's movements (a running statement).
 *
 * Ledger rule shown to the user everywhere: a credit card balance is negative
 * while money is owed and is labelled "Owed", never presented as positive cash.
 */

import { el, icon, clear, debounce } from '../../utils/dom.js';
import {
  badge, colorField, dataTable, dateField, dropdownMenu, emptyState, iconField,
  iconTile, labels, selectField, searchInput, sectionCard, statCard, textField
} from '../../components/ui.js';
import { openModal } from '../../components/modal.js';
import { confirmDialog } from '../../components/confirmDialog.js';
import { ACCOUNT_TYPES, CURRENCIES, ICON_CHOICES, PALETTE } from '../../config/defaults.js';
import { RESOURCES } from '../../core/state.js';
import { formatMoney, fromMinor } from '../../utils/currency.js';
import { formatDate, resolveRange, todayISO } from '../../utils/date.js';
import { appConfig } from '../../config/appConfig.js';
import { sanitizeColor } from '../../utils/sanitize.js';
import { openTransferForm } from '../transactions/transactionForm.js';
import { exportAccounts } from '../../services/exportService.js';

export function mount(container, ctx) {
  const { store, toast, services } = ctx;
  const service = services.accounts;
  const txService = services.transactions;
  const locale = store.preferences.locale;

  const ui = { q: '', showArchived: false, includePending: false };

  const root = el('div', { class: 'space-y-4' });
  const summaryHolder = el('div', { class: 'grid gap-3 sm:grid-cols-2 xl:grid-cols-4' });
  const listHolder = el('div');
  root.append(summaryHolder, listHolder);
  container.appendChild(root);

  const fmt = (minor, currency) =>
    formatMoney(minor, {
      currency: currency || store.preferences.currency,
      locale,
      accounting: store.preferences.numberFormat === 'accounting'
    });

  const refresh = () => {
    renderSummary();
    renderList();
  };
  const refreshDebounced = debounce(refresh, 200);

  /* --------------------------------------------------------------------- *
   * Summary
   * --------------------------------------------------------------------- */

  function renderSummary() {
    clear(summaryHolder);
    const options = { includePending: ui.includePending };
    const netWorth = service.netWorth(options);
    const accounts = service.all().filter((account) => !account.archived);

    if (netWorth.size === 0 && accounts.length === 0) {
      summaryHolder.appendChild(statCard({ label: 'Total balance', value: fmt(0), iconName: 'wallet', tone: 'brand', sub: 'No accounts yet' }));
      return;
    }

    for (const [code, total] of netWorth) {
      const count = accounts.filter((account) => (account.currency || 'BDT').toUpperCase() === code).length;
      summaryHolder.appendChild(statCard({
        label: `Total balance · ${code}`,
        value: fmt(total, code),
        iconName: 'wallet',
        tone: total < 0 ? 'expense' : 'brand',
        sub: `${count} active account${count === 1 ? '' : 's'}`,
        hint: 'Opening balances + posted income − posted expenses'
      }));
    }

    const liabilities = accounts
      .map((account) => ({ account, balance: service.balance(account.id, options) }))
      .filter((row) => row.account.type === 'credit_card' && row.balance < 0);
    const owedByCurrency = new Map();
    for (const { account, balance } of liabilities) {
      const code = (account.currency || 'BDT').toUpperCase();
      owedByCurrency.set(code, (owedByCurrency.get(code) || 0) + balance);
    }
    if (owedByCurrency.size) {
      const [code, owed] = [...owedByCurrency.entries()][0];
      summaryHolder.appendChild(statCard({
        label: `Owed on credit cards · ${code}`,
        value: fmt(Math.abs(owed), code),
        iconName: 'credit-card',
        tone: 'expense',
        sub: `${liabilities.length} card${liabilities.length === 1 ? '' : 's'} with a balance`
      }));
    }

    const archivedCount = service.all().filter((account) => account.archived).length;
    summaryHolder.appendChild(statCard({
      label: 'Accounts',
      value: String(service.all().length),
      iconName: 'landmark',
      tone: 'neutral',
      sub: archivedCount ? `${archivedCount} archived` : 'All active'
    }));
  }

  /* --------------------------------------------------------------------- *
   * List
   * --------------------------------------------------------------------- */

  function renderList() {
    clear(listHolder);
    const options = { includePending: ui.includePending };
    const balances = service.balances(options);
    const term = ui.q.trim().toLowerCase();
    const rows = service
      .all()
      .filter((account) => (ui.showArchived ? true : !account.archived))
      .filter((account) => (term ? account.name.toLowerCase().includes(term) : true))
      .sort((a, b) => a.name.localeCompare(b.name));

    listHolder.appendChild(sectionCard({
      title: 'Your accounts',
      description: 'Balances always derive from the ledger — opening balance plus every posted movement.',
      actions: [
        el('button', {
          type: 'button',
          class: 'btn btn-secondary btn-sm',
          title: 'Export accounts to CSV',
          onclick: () => exportRows()
        }, [icon('download', 'h-3.5 w-3.5'), el('span', { text: 'Export CSV' })]),
        el('button', { type: 'button', class: 'btn btn-primary btn-sm', onclick: () => openForm(null) }, [
          icon('plus', 'h-3.5 w-3.5'),
          el('span', { text: 'Add account' })
        ])
      ],
      body: [
        el('div', { class: 'flex flex-wrap items-center gap-3' }, [
          searchInput({ value: ui.q, placeholder: 'Search accounts…', onInput: (value) => { ui.q = value; refreshDebounced(); }, class: 'sm:max-w-xs' }),
          toggle('Show archived', ui.showArchived, (checked) => { ui.showArchived = checked; refresh(); }),
          toggle('Include pending', ui.includePending, (checked) => { ui.includePending = checked; refresh(); }, 'Pending and draft transactions are normally excluded from balances.')
        ]),
        el('div', { class: 'mt-3' }, [
          rows.length === 0
            ? emptyState({
                iconName: 'wallet',
                title: ui.q ? 'No accounts match that search' : 'No accounts yet',
                message: ui.q ? 'Try a different search term.' : 'Add a cash, bank, mobile-wallet or credit-card account to start tracking balances.',
                actionLabel: ui.q ? null : 'Add your first account',
                onAction: () => openForm(null)
              })
            : dataTable({
                caption: 'Accounts and wallets',
                columns: [
                  {
                    key: 'name',
                    label: 'Account',
                    class: 'min-w-[14rem]',
                    render: (account) => el('div', { class: 'flex items-center gap-3' }, [
                      iconTile(account.icon, account.color, 'sm'),
                      el('div', { class: 'min-w-0' }, [
                        el('p', { class: 'truncate text-sm font-medium text-slate-800 dark:text-slate-100', text: account.name }),
                        el('p', { class: 'text-[11px] text-slate-400 dark:text-slate-500', text: labels.accountType(account.type) })
                      ])
                    ])
                  },
                  {
                    key: 'opening',
                    label: 'Opening balance',
                    align: 'right',
                    class: 'hidden sm:table-cell',
                    render: (account) => el('span', { class: 'num text-slate-500 dark:text-slate-400', text: fmt(account.openingBalanceMinor, account.currency) })
                  },
                  { key: 'currency', label: 'Currency', class: 'hidden lg:table-cell', render: (account) => badge(account.currency, 'neutral') },
                  {
                    key: 'balance',
                    label: 'Balance',
                    align: 'right',
                    render: (account) => {
                      const balance = balances.get(account.id) ?? 0;
                      const owed = account.type === 'credit_card' && balance < 0;
                      return el('div', { class: 'flex items-center justify-end gap-2' }, [
                        owed ? badge('Owed', 'expense') : null,
                        el('span', {
                          class: `num font-semibold ${balance < 0 ? 'text-expense-600 dark:text-expense-400' : 'text-slate-800 dark:text-slate-100'}`,
                          text: fmt(balance, account.currency)
                        })
                      ]);
                    }
                  },
                  { key: 'status', label: 'Status', class: 'hidden md:table-cell', render: (account) => (account.archived ? badge('Archived', 'neutral') : badge('Active', 'income')) },
                  {
                    key: 'actions',
                    label: '',
                    align: 'right',
                    class: 'w-12',
                    render: (account) => dropdownMenu({
                      title: 'Account actions',
                      items: [
                        { label: 'View movements', icon: 'list', onClick: () => openHistory(account) },
                        { label: 'Edit', icon: 'pencil', onClick: () => openForm(account) },
                        { label: 'Transfer money', icon: 'arrow-left-right', onClick: () => transfer(account) },
                        { divider: true },
                        account.archived
                          ? { label: 'Restore', icon: 'rotate-ccw', onClick: () => restore(account) }
                          : { label: 'Archive', icon: 'archive', onClick: () => archive(account) },
                        { label: 'Delete permanently', icon: 'trash-2', variant: 'danger', onClick: () => remove(account) }
                      ]
                    })
                  }
                ],
                rows,
                rowKey: (account) => account.id,
                onRowClick: (account) => openHistory(account)
              })
        ])
      ],
      footer: [
        el('p', { class: 'text-[11px] text-slate-400 dark:text-slate-500', text: 'Transfers move money between two of your own accounts and never count as income or expenses.' })
      ]
    }));
  }

  function toggle(label, checked, onChange, hint = '') {
    return el('label', { class: 'flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400', title: hint || null }, [
      el('input', {
        type: 'checkbox',
        class: 'h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500 dark:border-slate-600 dark:bg-slate-800',
        checked,
        onchange: (event) => onChange(event.target.checked)
      }),
      el('span', { text: label })
    ]);
  }

  /* --------------------------------------------------------------------- *
   * Form
   * --------------------------------------------------------------------- */

  function openForm(account = null) {
    const isEdit = Boolean(account);
    const state = {
      name: account?.name || '',
      type: account?.type || 'cash',
      currency: account?.currency || store.preferences.currency,
      openingBalance: account ? fromMinor(account.openingBalanceMinor, account.currency).toFixed(2) : '0.00',
      openingBalanceDate: account?.openingBalanceDate || todayISO(),
      color: account?.color || '#22c55e',
      icon: account?.icon || 'banknote'
    };

    const errorBox = el('div', { class: 'hidden rounded-xl border border-expense-200 bg-expense-50 p-3 text-xs text-expense-700 dark:border-expense-500/30 dark:bg-expense-500/10 dark:text-expense-300', role: 'alert' });

    const nameField = textField({
      label: 'Name', name: 'name', value: state.name, required: true, maxlength: 120,
      placeholder: 'e.g. Cash, bKash, City Bank', onInput: (value) => { state.name = value; }
    });
    const typeField = selectField({
      label: 'Type', name: 'type', value: state.type, options: ACCOUNT_TYPES,
      onChange: (value) => { state.type = value; }
    });
    const currencyField = selectField({
      label: 'Currency', name: 'currency', value: state.currency,
      options: CURRENCIES.map((currency) => ({ value: currency.code, label: currency.label })),
      onChange: (value) => { state.currency = value; }
    });
    const openingField = textField({
      label: 'Opening balance', name: 'openingBalance', value: state.openingBalance, placeholder: '0.00',
      inputmode: 'decimal', class: 'num', hint: 'Use a minus sign for money owed (e.g. a credit-card starting balance).',
      onInput: (value) => { state.openingBalance = value; }
    });
    const openingDateField = dateField({
      label: 'Opening balance date', name: 'openingBalanceDate', value: state.openingBalanceDate,
      onChange: (value) => { state.openingBalanceDate = value; }
    });
    const colorPicker = colorField({
      label: 'Colour', value: state.color, palette: PALETTE,
      onChange: (value) => { state.color = sanitizeColor(value, state.color); }
    });
    const iconPicker = iconField({
      label: 'Icon', value: state.icon, choices: ICON_CHOICES,
      onChange: (value) => { state.icon = value; }
    });

    const form = el('form', { class: 'space-y-4', novalidate: true, onsubmit: (event) => event.preventDefault() }, [
      errorBox,
      nameField.field,
      el('div', { class: 'grid gap-4 sm:grid-cols-2' }, [typeField.field, currencyField.field]),
      el('div', { class: 'grid gap-4 sm:grid-cols-2' }, [openingField.field, openingDateField.field]),
      colorPicker.field,
      iconPicker.field
    ]);

    const fields = [nameField, typeField, currencyField, openingField, openingDateField];

    const submit = () => {
      for (const field of fields) field.clearError?.();
      errorBox.classList.add('hidden');
      const result = isEdit ? service.update(account.id, { ...state }) : service.add({ ...state });
      if (!result.ok) {
        errorBox.textContent = Object.values(result.errors)[0];
        errorBox.classList.remove('hidden');
        if (result.errors.name) nameField.setError(result.errors.name);
        if (result.errors.currency) currencyField.setError(result.errors.currency);
        if (result.errors.openingBalance) openingField.setError(result.errors.openingBalance);
        return;
      }
      toast?.success(isEdit ? 'Account updated' : 'Account created', result.record.name);
      modal.close('saved');
      refresh();
    };

    const modal = openModal({
      title: isEdit ? 'Edit account' : 'New account',
      description: isEdit ? 'Renaming or recolouring updates the account everywhere.' : undefined,
      size: 'md',
      content: form,
      footer: el('div', { class: 'flex items-center justify-end gap-2' }, [
        el('button', { type: 'button', class: 'btn btn-secondary', text: 'Cancel', onclick: () => modal.close('cancel') }),
        el('button', { type: 'button', class: 'btn btn-primary', text: isEdit ? 'Save changes' : 'Create account', onclick: submit })
      ])
    });

    nameField.input.focus();
    return modal;
  }

  /* --------------------------------------------------------------------- *
   * Movements / statement
   * --------------------------------------------------------------------- */

  function openHistory(account) {
    const state = { preset: 'allTime' };
    const body = el('div', { class: 'space-y-4' });
    const options = { includePending: ui.includePending };

    const render = () => {
      clear(body);
      const balance = service.balance(account.id, options);
      const movements = service.movements(account.id, {
        ...(state.preset === 'allTime' ? {} : resolveRange(state.preset, { weekStart: store.preferences.weekStart ?? 0 })),
        includePending: ui.includePending
      });

      body.appendChild(el('div', { class: 'flex flex-wrap items-center justify-between gap-3 rounded-xl bg-slate-50 p-3 dark:bg-slate-800/60' }, [
        el('div', { class: 'flex items-center gap-3' }, [
          iconTile(account.icon, account.color),
          el('div', {}, [
            el('p', { class: 'text-sm font-semibold text-slate-900 dark:text-slate-100', text: account.name }),
            el('p', { class: 'text-xs text-slate-500 dark:text-slate-400', text: `${labels.accountType(account.type)} · ${account.currency}` })
          ])
        ]),
        el('div', { class: 'text-right' }, [
          el('p', { class: 'text-[11px] uppercase tracking-wide text-slate-400', text: account.type === 'credit_card' && balance < 0 ? 'Owed' : 'Current balance' }),
          el('p', { class: `num text-lg font-semibold ${balance < 0 ? 'text-expense-600 dark:text-expense-400' : 'text-slate-900 dark:text-slate-50'}`, text: fmt(balance, account.currency) })
        ])
      ]));

      const presetSelect = el('select', { class: 'select !w-auto !py-1 !text-xs', 'aria-label': 'Statement period' },
        [{ value: 'allTime', label: 'All time' }, ...appConfig.ranges.filter((range) => range.id !== 'custom')].map((range) =>
          el('option', { value: range.value, selected: range.value === state.preset, text: range.label })
        ));
      presetSelect.addEventListener('change', (event) => { state.preset = event.target.value; render(); });
      body.appendChild(el('div', { class: 'flex items-center gap-2' }, [
        el('span', { class: 'text-xs text-slate-500 dark:text-slate-400', text: 'Period' }),
        presetSelect
      ]));

      if (movements.length === 0) {
        body.appendChild(emptyState({ compact: true, iconName: 'inbox', title: 'No movements in this period', message: 'Try a wider date range.' }));
        return;
      }

      let running = balance;
      const rows = movements.map((tx) => {
        const effect = effectOn(account, tx);
        const balanceAfter = running;
        running -= effect;
        return { tx, effect, balanceAfter };
      });

      body.appendChild(dataTable({
        caption: `Movements for ${account.name}`,
        columns: [
          { key: 'date', label: 'Date', render: (row) => el('span', { class: 'num whitespace-nowrap', text: formatDate(row.tx.date, { locale, format: store.preferences.dateFormat }) }) },
          { key: 'description', label: 'Description', render: (row) => el('span', { class: 'text-slate-700 dark:text-slate-200', text: row.tx.description || '—' }) },
          {
            key: 'type',
            label: 'Type',
            render: (row) => el('span', { class: 'inline-flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400' }, [
              icon(row.tx.type === 'transfer' ? 'arrow-left-right' : row.tx.type === 'income' ? 'arrow-down-left' : 'arrow-up-right', 'h-3.5 w-3.5'),
              el('span', { text: row.tx.type === 'transfer' ? (row.effect >= 0 ? 'Transfer in' : 'Transfer out') : labels.transactionType(row.tx.type) })
            ])
          },
          {
            key: 'amount',
            label: 'Change',
            align: 'right',
            render: (row) => el('span', {
              class: `num font-medium ${row.effect >= 0 ? 'text-income-600 dark:text-income-400' : 'text-expense-600 dark:text-expense-400'}`,
              text: `${row.effect >= 0 ? '+' : '−'}${fmt(Math.abs(row.effect), account.currency)}`
            })
          },
          { key: 'balance', label: 'Balance after', align: 'right', render: (row) => el('span', { class: 'num text-slate-600 dark:text-slate-300', text: fmt(row.balanceAfter, account.currency) }) }
        ],
        rows
      }));
    };

    render();

    const modal = openModal({
      title: 'Account movements',
      description: 'A running statement. Only posted transactions affect balances unless you include pending items.',
      size: 'lg',
      content: body,
      footer: el('div', { class: 'flex items-center justify-end gap-2' }, [
        el('button', { type: 'button', class: 'btn btn-secondary', text: 'Close', onclick: () => modal.close('close') }),
        el('button', { type: 'button', class: 'btn btn-primary', text: 'Transfer money', onclick: () => { modal.close('transfer'); transfer(account); } })
      ])
    });
    return modal;
  }

  /* --------------------------------------------------------------------- *
   * Actions
   * --------------------------------------------------------------------- */

  function transfer(account) {
    openTransferForm({
      service: txService,
      store,
      toast,
      defaults: { accountId: account.id },
      title: `Transfer from ${account.name}`,
      onSaved: () => refresh()
    });
  }

  async function archive(account) {
    const warnings = service.archiveWarnings(account.id);
    const parts = [];
    if (warnings.transactions) parts.push(`${warnings.transactions} transaction${warnings.transactions === 1 ? '' : 's'}`);
    if (warnings.recurringRules) parts.push(`${warnings.recurringRules} active recurring rule${warnings.recurringRules === 1 ? '' : 's'}`);
    if (warnings.goals) parts.push(`${warnings.goals} active goal${warnings.goals === 1 ? '' : 's'}`);
    const ok = await confirmDialog({
      title: `Archive “${account.name}”?`,
      message: parts.length
        ? `${parts.join(', ')} still reference this account. They stay readable, but it will no longer be selectable for new entries.`
        : 'It will no longer be selectable for new entries. You can restore it at any time.',
      confirmLabel: 'Archive',
      variant: 'primary',
      tone: 'warning'
    });
    if (!ok) return;
    const result = service.archive(account.id);
    if (result.ok) {
      toast?.success('Account archived', account.name);
      refresh();
    } else {
      toast?.error('Could not archive', Object.values(result.errors)[0]);
    }
  }

  function restore(account) {
    const result = service.restore(account.id);
    if (result.ok) {
      toast?.success('Account restored', account.name);
      refresh();
    } else {
      toast?.error('Could not restore', Object.values(result.errors)[0]);
    }
  }

  async function remove(account) {
    const usage = service.usageCount(account.id);
    if (usage > 0) {
      toast?.warning('Account in use', `Archive “${account.name}” instead — deleting would orphan ${usage} transaction(s).`);
      return;
    }
    const ok = await confirmDialog({
      title: `Delete “${account.name}”?`,
      message: 'This account has no transactions, so it can be removed permanently.',
      confirmLabel: 'Delete',
      variant: 'danger',
      tone: 'danger'
    });
    if (!ok) return;
    const result = service.remove(account.id);
    if (result.ok) {
      toast?.success('Account deleted', account.name);
      refresh();
    } else {
      toast?.error('Could not delete', Object.values(result.errors)[0]);
    }
  }

  function exportRows() {
    const accounts = service.all();
    if (!accounts.length) {
      toast?.warning('Nothing to export', 'There are no accounts yet.');
      return;
    }
    exportAccounts(accounts, service.balances({ includePending: ui.includePending }));
    toast?.success('Export ready', `${accounts.length} account${accounts.length === 1 ? '' : 's'} written to CSV.`);
  }

  /* --------------------------------------------------------------------- *
   * Helpers
   * --------------------------------------------------------------------- */

  function effectOn(account, tx) {
    if ((tx.currency || account.currency).toUpperCase() !== (account.currency || 'BDT').toUpperCase()) return 0;
    const amount = Number(tx.amountMinor) || 0;
    if (tx.type === 'transfer') {
      if (tx.accountId === account.id) return -amount;
      if (tx.toAccountId === account.id) return amount;
      return 0;
    }
    if (tx.accountId !== account.id) return 0;
    return tx.type === 'income' ? amount : -amount;
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
