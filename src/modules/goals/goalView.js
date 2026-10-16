/**
 * Savings-goals screen.
 *
 * Shows every goal with live progress and supports full CRUD plus a ledger of
 * contributions and withdrawals. Money only ever moves through the ledger, so
 * the running total can always be reconciled.
 *
 * When a funding account is chosen, recording a contribution (or withdrawal)
 * also creates a matching transfer between that account and the goal's linked
 * savings account. That keeps the accounts' balances honest without ever
 * inventing income or expense — moving money into savings is a transfer.
 */

import { el, icon, clear, debounce } from '../../utils/dom.js';
import {
  amountField, badge, colorField, dataTable, dateField, dropdownMenu, emptyState,
  iconField, iconTile, keyValueGrid, money, percent, progressBar, searchInput,
  sectionCard, selectField, statCard, textField
} from '../../components/ui.js';
import { openModal } from '../../components/modal.js';
import { confirmDialog } from '../../components/confirmDialog.js';
import { CURRENCIES, GOAL_STATUSES, ICON_CHOICES, PALETTE } from '../../config/defaults.js';
import { RESOURCES } from '../../core/state.js';
import { formatDate, todayISO } from '../../utils/date.js';
import { fromMinor } from '../../utils/currency.js';
import { exportGoals } from '../../services/exportService.js';

export function mount(container, ctx) {
  const { store, toast, services } = ctx;
  const service = services.goals;
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

  function activeCurrency() {
    const preferred = String(store.preferences.currency || 'BDT').toUpperCase();
    const inUse = service.currencies();
    return inUse.includes(preferred) ? preferred : inUse[0] || preferred;
  }

  function renderSummary() {
    clear(summaryHolder);
    const code = activeCurrency();
    const summary = service.summary({ currency: code });
    const extraCurrencies = service.currencies().filter((currency) => currency !== code);
    const note = extraCurrencies.length ? ` · also in ${extraCurrencies.join(', ')}` : '';

    summaryHolder.appendChild(statCard({
      label: 'Active goals',
      value: String(summary.activeCount),
      iconName: 'target',
      tone: 'brand',
      sub: `${summary.completed} completed · ${summary.archivedCount} archived`
    }));
    summaryHolder.appendChild(statCard({
      label: 'Saved',
      value: fmt(summary.savedMinor, code),
      iconName: 'piggy-bank',
      tone: 'savings',
      sub: `${summary.targetMinor > 0 ? percent((summary.savedMinor / summary.targetMinor) * 100, { locale }) : '0%'} of targets${note}`
    }));
    summaryHolder.appendChild(statCard({
      label: 'Still to save',
      value: fmt(summary.remainingMinor, code),
      iconName: 'trending-up',
      tone: summary.remainingMinor > 0 ? 'warning' : 'income',
      sub: summary.remainingMinor > 0 ? `Across ${summary.activeCount} unfinished goal${summary.activeCount === 1 ? '' : 's'}` : 'Every goal reached'
    }));
    summaryHolder.appendChild(statCard({
      label: 'Target total',
      value: fmt(summary.targetMinor, code),
      iconName: 'flag',
      tone: 'neutral',
      sub: `${summary.count} goal${summary.count === 1 ? '' : 's'} in ${code}`
    }));
  }

  /* --------------------------------------------------------------------- *
   * List
   * --------------------------------------------------------------------- */

  function visibleRows() {
    const term = ui.q.trim().toLowerCase();
    return service.rows().filter(({ goal }) => {
      if (ui.phase === 'active') return !goal.archived && goal.status === 'active';
      if (ui.phase === 'completed') return !goal.archived && goal.status === 'completed';
      if (ui.phase === 'archived') return goal.archived;
      return true;
    }).filter(({ goal }) => (term ? goal.name.toLowerCase().includes(term) : true));
  }

  function renderList() {
    clear(listHolder);
    const rows = visibleRows();

    listHolder.appendChild(sectionCard({
      title: 'Savings goals',
      description: 'Record contributions and withdrawals to track progress. Link an account to also move real money as a transfer.',
      actions: [
        el('button', { type: 'button', class: 'btn btn-secondary btn-sm', title: 'Export goals to CSV', onclick: exportRows }, [
          icon('download', 'h-3.5 w-3.5'), el('span', { text: 'Export CSV' })
        ]),
        el('button', { type: 'button', class: 'btn btn-primary btn-sm', onclick: () => openForm(null) }, [
          icon('plus', 'h-3.5 w-3.5'), el('span', { text: 'Add goal' })
        ])
      ],
      body: [
        el('div', { class: 'flex flex-wrap items-center gap-3' }, [
          searchInput({ value: ui.q, placeholder: 'Search goals…', onInput: (value) => { ui.q = value; refreshDebounced(); }, class: 'sm:max-w-xs' }),
          el('select', {
            class: 'select !w-auto !py-1 !text-xs',
            'aria-label': 'Filter goals',
            onchange: (event) => { ui.phase = event.target.value; refresh(); }
          }, [
            { value: 'active', label: 'Active' },
            { value: 'completed', label: 'Completed' },
            { value: 'archived', label: 'Archived' },
            { value: 'all', label: 'All' }
          ].map((option) => el('option', { value: option.value, selected: ui.phase === option.value, text: option.label })))
        ]),
        el('div', { class: 'mt-3' }, [
          rows.length === 0
            ? emptyState({
                iconName: 'target',
                title: ui.q ? 'No goals match that search' : ui.phase === 'archived' ? 'No archived goals' : 'No goals yet',
                message: ui.q ? 'Try a different search term.' : 'Set a savings target — an emergency fund, a trip, a new laptop — and watch it grow.',
                actionLabel: ui.q ? null : 'Create your first goal',
                onAction: () => openForm(null)
              })
            : dataTable({
                caption: 'Savings goals',
                columns: [
                  {
                    key: 'name',
                    label: 'Goal',
                    class: 'min-w-[15rem]',
                    render: ({ goal, progress }) => el('div', { class: 'flex items-center gap-3' }, [
                      iconTile(goal.icon || 'target', goal.color || '#14b8a6', 'md'),
                      el('div', { class: 'min-w-0' }, [
                        el('div', { class: 'flex flex-wrap items-center gap-2' }, [
                          el('p', { class: 'truncate text-sm font-medium text-slate-800 dark:text-slate-100', text: goal.name }),
                          goal.archived
                            ? badge('Archived', 'neutral')
                            : progress.onTrack
                              ? badge('Reached', 'savings')
                              : goal.status === 'completed'
                                ? badge('Completed', 'income')
                                : null
                        ]),
                        el('p', { class: 'text-[11px] text-slate-400 dark:text-slate-500', text: `${accountLabel(goal)} · ${(goal.contributions || []).length} entr${(goal.contributions || []).length === 1 ? 'y' : 'ies'}` })
                      ])
                    ])
                  },
                  {
                    key: 'progress',
                    label: 'Progress',
                    class: 'min-w-[12rem]',
                    render: ({ goal, progress }) => el('div', { class: 'space-y-1' }, [
                      progressBar({ percent: progress.percent, tone: progress.onTrack ? 'savings' : 'brand', size: 'sm' }),
                      el('p', { class: 'num text-[11px] text-slate-500 dark:text-slate-400', text: `${fmt(goal.savedMinor, goal.currency)} of ${fmt(goal.targetMinor, goal.currency)} · ${progress.percent.toFixed(0)}%` })
                    ])
                  },
                  {
                    key: 'target',
                    label: 'Target date',
                    class: 'hidden md:table-cell',
                    render: ({ goal, progress }) => targetCell(goal, progress)
                  },
                  {
                    key: 'remaining',
                    label: 'Remaining',
                    align: 'right',
                    render: ({ goal, progress }) => progress.onTrack
                      ? el('span', { class: 'num font-medium text-savings-600 dark:text-savings-400', text: fmt(0, goal.currency) })
                      : el('span', { class: 'num font-medium text-slate-700 dark:text-slate-200', text: fmt(progress.remainingMinor, goal.currency) })
                  },
                  {
                    key: 'actions',
                    label: '',
                    align: 'right',
                    class: 'w-24',
                    render: ({ goal, progress }) => el('div', { class: 'flex items-center justify-end gap-1' }, [
                      goal.archived
                        ? null
                        : el('button', {
                            type: 'button',
                            class: 'btn btn-secondary btn-sm',
                            title: 'Record a contribution',
                            onclick: () => openContribution(goal, 'contribution')
                          }, [icon('plus', 'h-3.5 w-3.5'), el('span', { class: 'hidden sm:inline', text: 'Add' })]),
                      dropdownMenu({
                        title: 'Goal actions',
                        items: [
                          goal.archived ? null : { label: 'Contribute', icon: 'plus', onClick: () => openContribution(goal, 'contribution') },
                          goal.archived ? null : { label: 'Withdraw', icon: 'minus', onClick: () => openContribution(goal, 'withdrawal') },
                          { label: 'View contributions', icon: 'list', onClick: () => openLedger(goal) },
                          { label: 'Edit', icon: 'pencil', onClick: () => openForm(goal) },
                          goal.status === 'completed'
                            ? { label: 'Reopen', icon: 'rotate-ccw', onClick: () => run(() => service.reopen(goal.id), 'Goal reopened', goal.name) }
                            : { label: 'Mark complete', icon: 'check', onClick: () => run(() => service.complete(goal.id), 'Goal completed', goal.name) },
                          goal.archived
                            ? { label: 'Restore', icon: 'rotate-ccw', onClick: () => run(() => service.restore(goal.id), 'Goal restored', goal.name) }
                            : { label: 'Archive', icon: 'archive', onClick: () => archive(goal) },
                          { divider: true },
                          { label: 'Delete permanently', icon: 'trash-2', variant: 'danger', onClick: () => remove(goal) }
                        ].filter(Boolean)
                      })
                    ])
                  }
                ],
                rows
              })
        ])
      ],
      footer: [
        el('p', { class: 'text-[11px] text-slate-400 dark:text-slate-500', text: 'Contributions with a funding account create a matching transfer, so your account balances stay truthful.' })
      ]
    }));
  }

  function targetCell(goal, progress) {
    if (!goal.targetDate) return el('span', { class: 'text-xs text-slate-400 dark:text-slate-500', text: 'No date set' });
    const days = progress.daysLeft;
    const statusText = progress.onTrack
      ? 'Reached'
      : days < 0
        ? `${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} overdue`
        : days === 0
          ? 'Due today'
          : `${days} day${days === 1 ? '' : 's'} left`;
    return el('div', { class: 'text-xs text-slate-500 dark:text-slate-400' }, [
      el('span', { class: 'font-medium text-slate-600 dark:text-slate-300', text: formatDate(goal.targetDate, { locale }) }),
      el('span', { class: 'block', text: statusText }),
      !progress.onTrack && days >= 0
        ? el('span', { class: 'block text-[11px] text-brand-600 dark:text-brand-300', text: `Save ${fmt(progress.requiredMonthlyMinor, goal.currency)}/mo` })
        : null
    ]);
  }

  /* --------------------------------------------------------------------- *
   * Create / edit form
   * --------------------------------------------------------------------- */

  function openForm(goal = null) {
    const isEdit = Boolean(goal);
    const state = {
      name: goal?.name || '',
      target: goal ? formattedMajor(goal.targetMinor, goal.currency) : '',
      saved: '',
      currency: goal?.currency || store.preferences.currency,
      targetDate: goal?.targetDate || '',
      accountId: goal?.accountId || '',
      icon: goal?.icon || 'target',
      color: goal?.color || '#14b8a6',
      status: goal?.status || 'active'
    };

    const errorBox = el('div', { class: 'hidden rounded-xl border border-expense-200 bg-expense-50 p-3 text-xs text-expense-700 dark:border-expense-500/30 dark:bg-expense-500/10 dark:text-expense-300', role: 'alert' });

    const fields = {};
    const nameField = textField({
      label: 'Goal name', name: 'name', value: state.name, required: true, maxlength: 120,
      placeholder: 'e.g. Emergency fund', onInput: (value) => { state.name = value; }
    });
    const amountHolder = el('div');
    const amountField_ = () => {
      const built = amountField({
        label: 'Target amount', name: 'targetMinor', value: state.target, currency: state.currency, required: true,
        hint: 'How much you want to have saved in total.',
        onInput: (value) => { state.target = value; }
      });
      fields.target = built;
      return built;
    };
    const currencyField = selectField({
      label: 'Currency', name: 'currency', value: state.currency,
      options: CURRENCIES.map((currency) => ({ value: currency.code, label: currency.label })),
      onChange: (value) => { state.currency = value; renderAmount(); renderSaved(); }
    });
    function renderAmount() {
      clear(amountHolder);
      amountHolder.appendChild(amountField_().field);
    }
    renderAmount();
    const savedHolder = el('div');
    const savedField = () => {
      const built = amountField({
        label: 'Already saved', name: 'savedMinor', value: state.saved, currency: state.currency, required: false,
        hint: 'Optional starting balance. Later changes go through contributions.',
        onInput: (value) => { state.saved = value; }
      });
      fields.saved = built;
      return built;
    };
    function renderSaved() {
      clear(savedHolder);
      savedHolder.appendChild(savedField().field);
    }
    renderSaved();
    const dateField_ = dateField({
      label: 'Target date', name: 'targetDate', value: state.targetDate, required: false,
      hint: 'Optional — used to work out a monthly saving target.',
      onChange: (value) => { state.targetDate = value; }
    });
    const accountField = selectField({
      label: 'Savings account', name: 'accountId', value: state.accountId,
      options: [{ value: '', label: 'No linked account (track only)' }, ...service.accountOptions()],
      hint: 'Link an account to move real money into it when you contribute.',
      onChange: (value) => { state.accountId = value; }
    });
    const statusField = selectField({
      label: 'Status', name: 'status', value: state.status,
      options: GOAL_STATUSES.filter((entry) => entry.value !== 'archived'),
      onChange: (value) => { state.status = value; }
    });
    fields.name = nameField;
    fields.currency = currencyField;
    fields.targetDate = dateField_;
    fields.accountId = accountField;

    const colorField_ = colorField({
      label: 'Accent colour', name: 'color', value: state.color, palette: PALETTE,
      onChange: (value) => { state.color = value; }
    });
    const iconField_ = iconField({
      label: 'Icon', name: 'icon', value: state.icon, choices: ICON_CHOICES,
      onChange: (value) => { state.icon = value; }
    });

    const form = el('form', { class: 'space-y-4', novalidate: true, onsubmit: (event) => event.preventDefault() }, [
      errorBox,
      nameField.field,
      el('div', { class: 'grid gap-4 sm:grid-cols-2' }, [amountHolder, currencyField.field]),
      el('div', { class: 'grid gap-4 sm:grid-cols-2' }, [savedHolder, dateField_.field]),
      el('div', { class: 'grid gap-4 sm:grid-cols-2' }, [accountField.field, statusField.field]),
      el('div', { class: 'grid gap-4 sm:grid-cols-2' }, [colorField_.field, iconField_.field])
    ]);

    const submit = () => {
      for (const field of Object.values(fields)) field?.clearError?.();
      errorBox.classList.add('hidden');
      const input = {
        name: state.name,
        targetMinor: state.target,
        currency: state.currency,
        targetDate: state.targetDate || null,
        accountId: state.accountId || null,
        icon: state.icon,
        color: state.color,
        status: state.status
      };
      if (!isEdit) input.savedMinor = state.saved || 0;
      const result = isEdit ? service.update(goal.id, input) : service.add(input);
      if (!result.ok) {
        errorBox.textContent = Object.values(result.errors)[0];
        errorBox.classList.remove('hidden');
        for (const [key, message] of Object.entries(result.errors)) fields[key]?.setError?.(message);
        return;
      }
      toast?.success(isEdit ? 'Goal updated' : 'Goal created', result.record.name);
      modal.close('saved');
      refresh();
    };

    const modal = openModal({
      title: isEdit ? 'Edit goal' : 'New savings goal',
      description: isEdit ? 'Editing the target or date updates progress immediately.' : 'Give your goal a name and a target amount.',
      size: 'md',
      content: form,
      footer: el('div', { class: 'flex items-center justify-end gap-2' }, [
        el('button', { type: 'button', class: 'btn btn-secondary', text: 'Cancel', onclick: () => modal.close('cancel') }),
        el('button', { type: 'button', class: 'btn btn-primary', text: isEdit ? 'Save changes' : 'Create goal', onclick: submit })
      ])
    });

    nameField.input.focus();
    return modal;
  }

  /* --------------------------------------------------------------------- *
   * Contribution / withdrawal
   * --------------------------------------------------------------------- */

  function openContribution(goal, direction = 'contribution') {
    const current = service.get(goal.id) || goal;
    const state = {
      direction,
      amount: '',
      date: todayISO(),
      sourceAccountId: '',
      note: ''
    };
    const errorBox = el('div', { class: 'hidden rounded-xl border border-expense-200 bg-expense-50 p-3 text-xs text-expense-700 dark:border-expense-500/30 dark:bg-expense-500/10 dark:text-expense-300', role: 'alert' });
    const fields = {};

    const directionField = selectField({
      label: 'Type', name: 'direction', value: state.direction,
      options: [{ value: 'contribution', label: 'Contribution (add to goal)' }, { value: 'withdrawal', label: 'Withdrawal (take out)' }],
      onChange: (value) => { state.direction = value; updateHint(); }
    });
    const amountField_ = amountField({
      label: 'Amount', name: 'amountMinor', value: state.amount, currency: current.currency, required: true,
      onInput: (value) => { state.amount = value; updateHint(); }
    });
    fields.amount = amountField_;
    const dateField_ = dateField({ label: 'Date', name: 'date', value: state.date, onChange: (value) => { state.date = value; } });
    const fundingOptions = service.fundingOptions(current);
    const canTransfer = Boolean(current.accountId) && fundingOptions.length > 0;
    const sourceField = selectField({
      label: 'Move money from / to', name: 'sourceAccountId', value: state.sourceAccountId,
      options: [
        { value: '', label: canTransfer ? 'Track only (no transfer)' : 'Track only' },
        ...(canTransfer ? fundingOptions : [])
      ],
      hint: canTransfer
        ? 'Choose an account to also create a matching transfer, or leave blank to only track the goal.'
        : 'Link a savings account to this goal to move real money.',
      onChange: (value) => { state.sourceAccountId = value; updateHint(); }
    });
    fields.sourceAccountId = sourceField;
    const noteField = textField({
      label: 'Note', name: 'note', value: state.note, maxlength: 200,
      placeholder: 'Optional note', onInput: (value) => { state.note = value; }
    });

    const infoLine = el('p', { class: 'num text-xs text-slate-500 dark:text-slate-400' });
    function updateHint() {
      const amount = Number(String(state.amount).replace(/[^\d.]/g, '')) || 0;
      const amountMinor = Math.round(amount * 100) || 0;
      const delta = state.direction === 'contribution' ? amountMinor : -amountMinor;
      const next = Math.max(0, (Number(current.savedMinor) || 0) + delta);
      infoLine.textContent = `Currently ${fmt(current.savedMinor, current.currency)} saved. After this: ${fmt(next, current.currency)}.`;
    }
    updateHint();

    const form = el('form', { class: 'space-y-4', novalidate: true, onsubmit: (event) => event.preventDefault() }, [
      errorBox,
      el('div', { class: 'grid gap-4 sm:grid-cols-2' }, [directionField.field, amountField_.field]),
      el('div', { class: 'grid gap-4 sm:grid-cols-2' }, [dateField_.field, sourceField.field]),
      noteField.field,
      infoLine
    ]);

    const submit = () => {
      for (const field of Object.values(fields)) field?.clearError?.();
      errorBox.classList.add('hidden');
      const result = service.contribute({
        goal: current,
        direction: state.direction,
        amountMinor: state.amount,
        date: state.date,
        sourceAccountId: state.sourceAccountId || null,
        note: state.note
      });
      if (!result.ok) {
        errorBox.textContent = Object.values(result.errors)[0];
        errorBox.classList.remove('hidden');
        for (const [key, message] of Object.entries(result.errors)) fields[key]?.setError?.(message);
        return;
      }
      const verb = state.direction === 'contribution' ? 'Contribution recorded' : 'Withdrawal recorded';
      toast?.success(verb, result.transfer ? 'A matching transfer was created.' : current.name);
      modal.close('saved');
      refresh();
    };

    const modal = openModal({
      title: `${state.direction === 'contribution' ? 'Contribute to' : 'Withdraw from'} “${current.name}”`,
      description: `Target ${fmt(current.targetMinor, current.currency)} · saved ${fmt(current.savedMinor, current.currency)}`,
      size: 'md',
      content: form,
      footer: el('div', { class: 'flex items-center justify-end gap-2' }, [
        el('button', { type: 'button', class: 'btn btn-secondary', text: 'Cancel', onclick: () => modal.close('cancel') }),
        el('button', { type: 'button', class: 'btn btn-primary', text: 'Save entry', onclick: submit })
      ])
    });

    amountField_.input.focus();
    return modal;
  }

  /* --------------------------------------------------------------------- *
   * Contributions ledger
   * --------------------------------------------------------------------- */

  function openLedger(goal) {
    const holder = el('div', { class: 'space-y-3' });
    const render = () => {
      clear(holder);
      const current = service.get(goal.id);
      if (!current) {
        holder.appendChild(emptyState({ iconName: 'target', title: 'Goal not found', message: 'It may have been deleted.', compact: true }));
        return;
      }
      const entries = service.contributions(current.id);
      const contributed = entries.filter((entry) => entry.direction === 'contribution').reduce((sum, entry) => sum + entry.amountMinor, 0);
      const withdrawn = entries.filter((entry) => entry.direction === 'withdrawal').reduce((sum, entry) => sum + entry.amountMinor, 0);

      holder.appendChild(keyValueGrid([
        { label: 'Saved', value: fmt(current.savedMinor, current.currency) },
        { label: 'Target', value: fmt(current.targetMinor, current.currency) },
        { label: 'Total contributed', value: fmt(contributed, current.currency) },
        { label: 'Total withdrawn', value: fmt(withdrawn, current.currency) }
      ], { columns: 2 }));

      if (entries.length === 0) {
        holder.appendChild(emptyState({
          iconName: 'list',
          title: 'No entries yet',
          message: 'Record a contribution to start tracking this goal.',
          actionLabel: 'Add contribution',
          onAction: () => { modal.close('add'); openContribution(current, 'contribution'); }
        }));
        return;
      }

      holder.appendChild(dataTable({
        caption: `Contributions to ${current.name}`,
        columns: [
          { key: 'date', label: 'Date', render: (entry) => el('span', { class: 'num text-xs', text: formatDate(entry.date, { locale }) }) },
          {
            key: 'direction',
            label: 'Type',
            render: (entry) => (entry.direction === 'contribution' ? badge('Contribution', 'savings') : badge('Withdrawal', 'warning'))
          },
          {
            key: 'amount',
            label: 'Amount',
            align: 'right',
            render: (entry) => el('span', {
              class: `num font-medium ${entry.direction === 'contribution' ? 'text-income-600 dark:text-income-400' : 'text-expense-600 dark:text-expense-400'}`,
              text: `${entry.direction === 'contribution' ? '+' : '−'}${fmt(entry.amountMinor, current.currency)}`
            })
          },
          { key: 'transfer', label: 'Transfer', class: 'hidden sm:table-cell', render: (entry) => entry.transactionId ? badge('Linked', 'brand') : el('span', { class: 'text-[11px] text-slate-400', text: 'Track only' }) },
          { key: 'note', label: 'Note', class: 'hidden md:table-cell', render: (entry) => el('span', { class: 'text-xs text-slate-500 dark:text-slate-400', text: entry.note || '—' }) },
          {
            key: 'actions',
            label: '',
            align: 'right',
            class: 'w-12',
            render: (entry) => dropdownMenu({
              title: 'Entry actions',
              items: [{ label: 'Remove entry', icon: 'trash-2', variant: 'danger', onClick: () => removeEntry(current, entry) }]
            })
          }
        ],
        rows: entries
      }));
    };

    async function removeEntry(current, entry) {
      const ok = await confirmDialog({
        title: 'Remove this entry?',
        message: entry.transactionId
          ? 'The linked transfer will also be deleted so your account balances stay correct.'
          : 'The saved total will be adjusted to match the remaining entries.',
        confirmLabel: 'Remove',
        variant: 'danger',
        tone: 'danger'
      });
      if (!ok) return;
      const result = service.removeContribution(current.id, entry.id);
      if (!result.ok) {
        toast?.error('Could not remove entry', Object.values(result.errors)[0]);
        return;
      }
      toast?.success('Entry removed', result.removedTransfer ? 'The linked transfer was deleted too.' : current.name);
      render();
      refresh();
    }

    const modal = openModal({
      title: `Contributions · ${goal.name}`,
      description: 'Every contribution and withdrawal recorded against this goal.',
      size: 'lg',
      content: holder,
      footer: el('div', { class: 'flex flex-wrap items-center justify-between gap-2' }, [
        el('button', {
          type: 'button',
          class: 'btn btn-secondary btn-sm',
          onclick: () => { modal.close('add'); openContribution(goal, 'contribution'); }
        }, [icon('plus', 'h-3.5 w-3.5'), el('span', { text: 'Add contribution' })]),
        el('button', { type: 'button', class: 'btn btn-secondary btn-sm', text: 'Close', onclick: () => modal.close('close') })
      ])
    });

    render();
    return modal;
  }

  /* --------------------------------------------------------------------- *
   * Actions
   * --------------------------------------------------------------------- */

  async function archive(goal) {
    const ok = await confirmDialog({
      title: `Archive “${goal.name}”?`,
      message: 'It will be hidden from the active list but kept with its full contribution history.',
      confirmLabel: 'Archive',
      variant: 'primary',
      tone: 'warning'
    });
    if (!ok) return;
    run(() => service.archive(goal.id), 'Goal archived', goal.name);
  }

  async function remove(goal) {
    const ok = await confirmDialog({
      title: `Delete “${goal.name}”?`,
      message: 'The goal and its contribution history are removed permanently. Linked transfers are kept as ordinary transfers.',
      confirmLabel: 'Delete',
      variant: 'danger',
      tone: 'danger'
    });
    if (!ok) return;
    run(() => service.remove(goal.id), 'Goal deleted', goal.name);
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
      toast?.warning('Nothing to export', 'There are no goals yet.');
      return;
    }
    const csv = exportGoals(rows, { accounts: store.list(RESOURCES.ACCOUNTS) });
    toast?.success('Export ready', `${rows.length} goal${rows.length === 1 ? '' : 's'} written to CSV.`);
    return csv;
  }

  /* --------------------------------------------------------------------- *
   * Helpers
   * --------------------------------------------------------------------- */

  function accountLabel(goal) {
    if (!goal.accountId) return 'Track only';
    return store.byId(RESOURCES.ACCOUNTS, goal.accountId)?.name || 'Deleted account';
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
