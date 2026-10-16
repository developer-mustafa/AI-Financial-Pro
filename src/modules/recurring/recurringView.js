/**
 * Recurring transactions screen.
 *
 * Two jobs:
 *  1. REVIEW — occurrences that have become due are listed at the top. Posting
 *     one creates a real transaction stamped with a deterministic occurrence
 *     key; skipping one advances the rule without creating anything.
 *  2. MANAGE — full CRUD over the recurring *templates* (income, expense and
 *     transfer rules) with pause/resume and a schedule preview.
 *
 * A rule is never a transaction. Nothing is posted automatically — the user
 * always confirms, which is why the review queue is a first-class panel here.
 */

import { el, icon, clear, debounce } from '../../utils/dom.js';
import {
  amountField, badge, dataTable, dateField, dropdownMenu, emptyState, money,
  sectionCard, selectField, statCard, textField, textareaField, typeBadge
} from '../../components/ui.js';
import { openModal } from '../../components/modal.js';
import { confirmDialog } from '../../components/confirmDialog.js';
import { PAYMENT_METHODS, RECURRING_FREQUENCIES, TRANSACTION_TYPES } from '../../config/defaults.js';
import { RESOURCES } from '../../core/state.js';
import { formatDate, todayISO } from '../../utils/date.js';
import { normalizeCurrency } from '../../utils/currency.js';
import { exportRecurring } from '../../services/exportService.js';

export function mount(container, ctx) {
  const { store, toast, services } = ctx;
  const service = services.recurring;
  const locale = store.preferences.locale;

  const ui = { q: '', status: 'all' };

  const root = el('div', { class: 'space-y-4' });
  const dueHolder = el('div');
  const summaryHolder = el('div', { class: 'grid gap-3 sm:grid-cols-2 xl:grid-cols-4' });
  const listHolder = el('div');
  root.append(dueHolder, summaryHolder, listHolder);
  container.appendChild(root);

  const fmt = (minor, currency) =>
    money(minor, {
      currency: currency || store.preferences.currency,
      locale,
      accounting: store.preferences.numberFormat === 'accounting'
    });

  const refresh = () => {
    renderDue();
    renderSummary();
    renderList();
  };
  const refreshDebounced = debounce(refresh, 180);

  /* --------------------------------------------------------------------- *
   * Due review queue
   * --------------------------------------------------------------------- */

  function renderDue() {
    clear(dueHolder);
    const due = service.due();
    if (due.length === 0) return;

    const rows = due.map((item) => el('div', {
      class: 'flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50/60 p-3 dark:border-amber-500/30 dark:bg-amber-500/10'
    }, [
      el('div', { class: 'flex min-w-0 items-center gap-3' }, [
        el('span', { class: 'flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-amber-100 text-amber-600 dark:bg-amber-500/20 dark:text-amber-300' }, [
          icon('calendar-clock', 'h-4 w-4')
        ]),
        el('div', { class: 'min-w-0' }, [
          el('p', { class: 'truncate text-sm font-semibold text-slate-800 dark:text-slate-100', text: item.rule.name }),
          el('p', { class: 'text-xs text-slate-500 dark:text-slate-400', text: `${typeLabel(item.rule.type)} · due ${formatDate(item.dueDate, { locale, format: store.preferences.dateFormat })} · ${fmt(item.rule.amountMinor, item.rule.currency)}` })
        ])
      ]),
      el('div', { class: 'flex items-center gap-2' }, [
        el('button', { type: 'button', class: 'btn btn-primary btn-sm', onclick: () => postOne(item) }, [
          icon('check', 'h-3.5 w-3.5'), el('span', { text: 'Post' })
        ]),
        el('button', { type: 'button', class: 'btn btn-secondary btn-sm', onclick: () => skipOne(item) }, [
          icon('skip-forward', 'h-3.5 w-3.5'), el('span', { text: 'Skip' })
        ])
      ])
    ]));

    dueHolder.appendChild(sectionCard({
      title: `${due.length} occurrence${due.length === 1 ? '' : 's'} ready to post`,
      description: 'Nothing is posted automatically. Posting creates a real transaction; skipping advances the rule without one.',
      actions: [
        el('button', { type: 'button', class: 'btn btn-primary btn-sm', onclick: postAll }, [
          icon('check-check', 'h-3.5 w-3.5'), el('span', { text: 'Post all' })
        ])
      ],
      body: [el('div', { class: 'space-y-2' }, rows)]
    }));
  }

  function postOne(item) {
    const result = service.post(item);
    if (result.ok) {
      toast?.success('Occurrence posted', `${item.rule.name} · ${fmt(result.record.amountMinor, result.record.currency)}`);
      refresh();
    } else if (result.duplicate) {
      toast?.info('Already posted', 'This occurrence was posted earlier — it was skipped.');
      refresh();
    } else {
      toast?.error('Could not post', Object.values(result.errors || {})[0] || 'The occurrence could not be posted.');
    }
  }

  async function skipOne(item) {
    const ok = await confirmDialog({
      title: `Skip “${item.rule.name}” for ${formatDate(item.dueDate, { locale })}?`,
      message: 'No transaction is created and the rule simply moves on to its next date.',
      confirmLabel: 'Skip this occurrence',
      variant: 'primary',
      tone: 'warning'
    });
    if (!ok) return;
    const result = service.skip(item);
    if (result.ok) {
      toast?.success('Occurrence skipped', item.rule.name);
      refresh();
    } else {
      toast?.error('Could not skip', Object.values(result.errors || {})[0] || 'The occurrence could not be skipped.');
    }
  }

  function postAll() {
    const counts = service.postAll();
    if (counts.posted === 0 && counts.failed === 0) {
      toast?.info('Nothing to post', 'Every due occurrence was already posted.');
    } else {
      toast?.success(
        `${counts.posted} posted`,
        `${counts.failed} failed · ${counts.skipped} already posted`
      );
    }
    refresh();
  }

  /* --------------------------------------------------------------------- *
   * Summary
   * --------------------------------------------------------------------- */

  function renderSummary() {
    clear(summaryHolder);
    const all = service.all();
    const active = service.active();
    const paused = service.paused();
    const dueCount = service.dueCount();
    const totals = service.monthlyTotals();
    const [primaryCurrency, primaryTotal] = [...totals.entries()].sort((a, b) => b[1] - a[1])[0] || [store.preferences.currency, 0];

    summaryHolder.appendChild(statCard({
      label: 'Active rules',
      value: String(active.length),
      iconName: 'repeat',
      tone: 'brand',
      sub: all.length ? `${all.length} total · ${paused.length} paused` : 'None created yet'
    }));
    summaryHolder.appendChild(statCard({
      label: 'Due now',
      value: String(dueCount),
      iconName: 'calendar-clock',
      tone: dueCount > 0 ? 'warning' : 'neutral',
      sub: dueCount > 0 ? 'Review and post above' : 'Nothing waiting to post'
    }));
    summaryHolder.appendChild(statCard({
      label: 'Monthly equivalent',
      value: fmt(primaryTotal, primaryCurrency),
      iconName: 'calendar-days',
      tone: 'savings',
      sub: totals.size > 1 ? `Plus ${totals.size - 1} other currenc${totals.size - 1 === 1 ? 'y' : 'ies'}` : 'Across all active rules'
    }));
    summaryHolder.appendChild(statCard({
      label: 'Paused',
      value: String(paused.length),
      iconName: 'pause',
      tone: 'neutral',
      sub: paused.length ? 'Resume whenever you like' : 'Everything is active'
    }));
  }

  /* --------------------------------------------------------------------- *
   * Rule list
   * --------------------------------------------------------------------- */

  function renderList() {
    clear(listHolder);
    const term = ui.q.trim().toLowerCase();
    const rows = service
      .all()
      .filter((rule) => (ui.status === 'all' ? true : rule.status === ui.status))
      .filter((rule) => (term ? rule.name.toLowerCase().includes(term) : true))
      .sort((a, b) => String(a.nextDueDate).localeCompare(String(b.nextDueDate)) || a.name.localeCompare(b.name));

    listHolder.appendChild(sectionCard({
      title: 'Recurring rules',
      description: 'Templates for money that repeats. Posting a due occurrence creates the transaction for you.',
      actions: [
        el('button', {
          type: 'button',
          class: 'btn btn-secondary btn-sm',
          title: 'Export recurring rules to CSV',
          onclick: exportRows
        }, [icon('download', 'h-3.5 w-3.5'), el('span', { text: 'Export CSV' })]),
        el('button', { type: 'button', class: 'btn btn-primary btn-sm', onclick: () => openForm(null) }, [
          icon('plus', 'h-3.5 w-3.5'),
          el('span', { text: 'New rule' })
        ])
      ],
      body: [
        el('div', { class: 'flex flex-wrap items-center gap-3' }, [
          el('div', { class: 'relative min-w-[12rem] flex-1 sm:max-w-xs' }, [
            el('span', { class: 'pointer-events-none absolute inset-y-0 left-0 flex w-9 items-center justify-center text-slate-400' }, [icon('search', 'h-4 w-4')]),
            el('input', {
              type: 'search',
              class: 'input pl-9',
              placeholder: 'Search rules…',
              value: ui.q,
              'aria-label': 'Search recurring rules',
              autocomplete: 'off',
              oninput: (event) => { ui.q = event.target.value; refreshDebounced(); }
            })
          ]),
          el('select', {
            class: 'select !w-auto !py-1 !text-xs',
            'aria-label': 'Filter by status',
            onchange: (event) => { ui.status = event.target.value; refresh(); }
          }, [
            { value: 'all', label: 'All rules' },
            { value: 'active', label: 'Active' },
            { value: 'paused', label: 'Paused' }
          ].map((option) => el('option', { value: option.value, selected: ui.status === option.value, text: option.label })))
        ]),
        el('div', { class: 'mt-3' }, [
          rows.length === 0
            ? emptyState({
                iconName: 'repeat',
                title: ui.q ? 'No rules match that search' : 'No recurring rules yet',
                message: ui.q ? 'Try a different search term.' : 'Add rent, a subscription or a salary so you never forget to record it.',
                actionLabel: ui.q ? null : 'Create your first rule',
                onAction: () => openForm(null)
              })
            : dataTable({
                caption: 'Recurring rules',
                columns: [
                  {
                    key: 'name',
                    label: 'Rule',
                    class: 'min-w-[14rem]',
                    render: (rule) => el('div', { class: 'min-w-0' }, [
                      el('div', { class: 'flex flex-wrap items-center gap-2' }, [
                        el('p', { class: 'truncate text-sm font-medium text-slate-800 dark:text-slate-100', text: rule.name }),
                        rule.status === 'paused' ? badge('Paused', 'warning') : null
                      ]),
                      el('p', { class: 'text-[11px] text-slate-400 dark:text-slate-500', text: scopeLabel(rule) })
                    ])
                  },
                  { key: 'type', label: 'Type', class: 'hidden md:table-cell', render: (rule) => typeBadge(rule.type) },
                  {
                    key: 'amount',
                    label: 'Amount',
                    align: 'right',
                    render: (rule) => el('span', { class: 'num font-medium text-slate-700 dark:text-slate-200', text: fmt(rule.amountMinor, rule.currency) })
                  },
                  {
                    key: 'schedule',
                    label: 'Repeats',
                    class: 'hidden lg:table-cell',
                    render: (rule) => el('div', { class: 'text-xs text-slate-500 dark:text-slate-400' }, [
                      el('span', { class: 'block font-medium text-slate-600 dark:text-slate-300', text: frequencyLabel(rule) }),
                      el('span', { class: 'block', text: `≈ ${fmt(service.monthlyEquivalent(rule), rule.currency)}/mo` })
                    ])
                  },
                  {
                    key: 'next',
                    label: 'Next due',
                    render: (rule) => {
                      if (rule.status !== 'active') return el('span', { class: 'text-xs text-slate-400', text: 'Paused' });
                      const next = rule.nextDueDate;
                      const overdue = next && next < todayISO();
                      return el('span', {
                        class: `num text-xs ${overdue ? 'font-semibold text-expense-600 dark:text-expense-400' : 'text-slate-600 dark:text-slate-300'}`,
                        text: next ? formatDate(next, { locale, format: store.preferences.dateFormat }) : '—'
                      });
                    }
                  },
                  {
                    key: 'actions',
                    label: '',
                    align: 'right',
                    class: 'w-12',
                    render: (rule) => dropdownMenu({
                      title: 'Recurring rule actions',
                      items: [
                        { label: 'Post next occurrence', icon: 'check', onClick: () => postNext(rule) },
                        { label: 'View schedule', icon: 'calendar-days', onClick: () => openSchedule(rule) },
                        { label: 'Edit', icon: 'pencil', onClick: () => openForm(rule) },
                        rule.status === 'paused'
                          ? { label: 'Resume', icon: 'play', onClick: () => run(() => service.resume(rule.id), 'Rule resumed', rule.name) }
                          : { label: 'Pause', icon: 'pause', onClick: () => run(() => service.pause(rule.id), 'Rule paused', rule.name) },
                        { divider: true },
                        { label: 'Delete rule', icon: 'trash-2', variant: 'danger', onClick: () => remove(rule) }
                      ]
                    })
                  }
                ],
                rows
              })
        ])
      ],
      footer: [
        el('p', { class: 'text-[11px] text-slate-400 dark:text-slate-500', text: 'Deleting a rule never deletes the transactions it already generated — history stays intact.' })
      ]
    }));
  }

  /* --------------------------------------------------------------------- *
   * Schedule preview
   * --------------------------------------------------------------------- */

  function openSchedule(rule) {
    const body = el('div', { class: 'space-y-4' });
    const upcoming = service.schedule(rule.id, { untilISO: addMonthsISO(todayISO(), 12) });
    body.appendChild(el('dl', { class: 'grid gap-3 sm:grid-cols-2' }, [
      kv('Frequency', frequencyLabel(rule)),
      kv('Amount', fmt(rule.amountMinor, rule.currency)),
      kv('Starts', formatDate(rule.startDate, { locale })),
      kv('Ends', rule.endDate ? formatDate(rule.endDate, { locale }) : 'Never'),
      kv('Last posted', rule.lastGeneratedDate ? formatDate(rule.lastGeneratedDate, { locale }) : 'Never'),
      kv('Generated so far', `${service.generatedCount(rule.id)} transaction(s)`)
    ]));
    if (upcoming.length === 0) {
      body.appendChild(emptyState({ compact: true, iconName: 'calendar-off', title: 'No upcoming dates', message: 'The rule is paused, has ended, or has no future occurrences.' }));
    } else {
      body.appendChild(el('ol', { class: 'divide-y divide-slate-100 rounded-xl border border-slate-200 dark:divide-slate-800 dark:border-slate-700' },
        upcoming.slice(0, 24).map((date, index) => el('li', { class: 'flex items-center justify-between px-3 py-2 text-sm' }, [
          el('span', { class: 'text-slate-600 dark:text-slate-300', text: formatDate(date, { locale, format: store.preferences.dateFormat }) }),
          el('span', { class: 'text-[11px] text-slate-400', text: `#${index + 1}` })
        ]))));
    }
    const modal = openModal({
      title: `Schedule · ${rule.name}`,
      size: 'md',
      content: body,
      footer: el('div', { class: 'flex items-center justify-end' }, [
        el('button', { type: 'button', class: 'btn btn-secondary', text: 'Close', onclick: () => modal.close('close') })
      ])
    });
    return modal;
  }

  /* --------------------------------------------------------------------- *
   * Form
   * --------------------------------------------------------------------- */

  function openForm(rule = null) {
    const isEdit = Boolean(rule);
    const state = {
      name: rule?.name || '',
      type: rule?.type || 'expense',
      amount: rule ? fromMinorString(rule.amountMinor, rule.currency) : '',
      accountId: rule?.accountId || store.preferences.defaultAccountId || '',
      toAccountId: rule?.toAccountId || '',
      categoryId: rule?.categoryId || '',
      frequency: rule?.frequency || 'monthly',
      intervalCount: rule ? String(rule.intervalCount || 1) : '1',
      startDate: rule?.startDate || todayISO(),
      nextDueDate: rule?.nextDueDate || rule?.startDate || todayISO(),
      endDate: rule?.endDate || '',
      paymentMethod: rule?.paymentMethod || store.preferences.defaultPaymentMethod || 'cash',
      status: rule?.status || 'active',
      notes: rule?.notes || ''
    };

    const errorBox = el('div', { class: 'hidden rounded-xl border border-expense-200 bg-expense-50 p-3 text-xs text-expense-700 dark:border-expense-500/30 dark:bg-expense-500/10 dark:text-expense-300', role: 'alert' });
    const body = el('div', { class: 'space-y-4' });
    let fields = {};

    const accountById = (id) => store.byId(RESOURCES.ACCOUNTS, id);
    const currentCurrency = () => normalizeCurrency(accountById(state.accountId)?.currency || store.preferences.currency);

    function render() {
      clear(body);
      fields = {};
      const currency = currentCurrency();

      body.appendChild(errorBox);

      const typeField = selectField({
        label: 'Type', name: 'type', value: state.type,
        options: TRANSACTION_TYPES,
        hint: 'Transfers never count as income or expenses.',
        onChange: (value) => {
          state.type = value;
          if (value === 'transfer') state.categoryId = '';
          else state.toAccountId = '';
          render();
        }
      });
      const nameField = textField({
        label: 'Name', name: 'name', value: state.name, required: true, maxlength: 120,
        placeholder: 'e.g. Apartment rent, Netflix, Salary',
        onInput: (value) => { state.name = value; }
      });
      const amountInput = amountField({
        label: 'Amount', name: 'amount', value: state.amount, currency, required: true,
        hint: `Charged in ${currency} each occurrence.`,
        onInput: (value) => { state.amount = value; }
      });
      const frequencyField = selectField({
        label: 'Repeats', name: 'frequency', value: state.frequency,
        options: RECURRING_FREQUENCIES,
        onChange: (value) => { state.frequency = value; }
      });
      const intervalField = textField({
        label: 'Every', name: 'intervalCount', value: state.intervalCount, type: 'number',
        min: '1', max: '365', required: true,
        hint: 'Number of periods between occurrences (1 = every period).',
        onInput: (value) => { state.intervalCount = value; }
      });
      const accountField = selectField({
        label: state.type === 'transfer' ? 'From account' : 'Account',
        name: 'accountId', value: state.accountId, required: true,
        options: accountOptions(),
        onChange: (value) => {
          const previous = currentCurrency();
          state.accountId = value;
          if (currentCurrency() !== previous) state.amount = '';
          if (state.toAccountId === value) state.toAccountId = '';
          render();
        }
      });
      fields.name = nameField;
      fields.amount = amountInput;
      fields.frequency = frequencyField;
      fields.intervalCount = intervalField;
      fields.accountId = accountField;

      body.appendChild(nameField.field);
      body.appendChild(el('div', { class: 'grid gap-4 sm:grid-cols-2' }, [typeField.field, amountInput.field]));

      let toAccountField = null;
      if (state.type === 'transfer') {
        const destinations = store.list(RESOURCES.ACCOUNTS).filter(
          (account) => account.id !== state.accountId && !account.archived && normalizeCurrency(account.currency) === currentCurrency()
        );
        if (state.toAccountId && !destinations.some((account) => account.id === state.toAccountId)) state.toAccountId = '';
        toAccountField = selectField({
          label: 'To account', name: 'toAccountId', value: state.toAccountId, required: true,
          options: [
            { value: '', label: destinations.length ? 'Choose destination…' : 'No matching accounts (same currency required)', disabled: true },
            ...destinations.map((account) => ({ value: account.id, label: account.name }))
          ],
          onChange: (value) => { state.toAccountId = value; }
        });
        fields.toAccountId = toAccountField;
        body.appendChild(el('div', { class: 'grid gap-4 sm:grid-cols-2' }, [accountField.field, toAccountField.field]));
      } else {
        const categories = service.categoryOptions(state.type);
        if (state.categoryId && !categories.some((option) => option.value === state.categoryId)) state.categoryId = '';
        const categoryField = selectField({
          label: 'Category', name: 'categoryId', value: state.categoryId, required: true,
          options: [{ value: '', label: 'Choose category…', disabled: true }, ...categories],
          onChange: (value) => { state.categoryId = value; }
        });
        fields.categoryId = categoryField;
        body.appendChild(el('div', { class: 'grid gap-4 sm:grid-cols-2' }, [accountField.field, categoryField.field]));
      }

      body.appendChild(el('div', { class: 'grid gap-4 sm:grid-cols-3' }, [frequencyField.field, intervalField.field, summarizedSchedule()]));

      const startField = dateField({
        label: 'Start date', name: 'startDate', value: state.startDate, required: true,
        onChange: (value) => { state.startDate = value; }
      });
      const nextField = dateField({
        label: 'Next due date', name: 'nextDueDate', value: state.nextDueDate, required: true,
        hint: 'Occurrences on or before today appear in the review queue.',
        onChange: (value) => { state.nextDueDate = value; }
      });
      const endField = dateField({
        label: 'End date (optional)', name: 'endDate', value: state.endDate,
        required: false,
        onChange: (value) => { state.endDate = value; }
      });
      fields.startDate = startField;
      fields.nextDueDate = nextField;
      fields.endDate = endField;
      body.appendChild(el('div', { class: 'grid gap-4 sm:grid-cols-3' }, [startField.field, nextField.field, endField.field]));

      const paymentField = selectField({
        label: 'Payment method', name: 'paymentMethod', value: state.paymentMethod,
        options: PAYMENT_METHODS,
        onChange: (value) => { state.paymentMethod = value; }
      });
      const statusField = selectField({
        label: 'Status', name: 'status', value: state.status,
        options: [{ value: 'active', label: 'Active' }, { value: 'paused', label: 'Paused' }],
        onChange: (value) => { state.status = value; }
      });
      fields.paymentMethod = paymentField;
      fields.status = statusField;
      body.appendChild(el('div', { class: 'grid gap-4 sm:grid-cols-2' }, [paymentField.field, statusField.field]));

      const notesField = textareaField({
        label: 'Notes', name: 'notes', value: state.notes, maxlength: 2000,
        placeholder: 'Optional context carried onto each generated transaction.',
        onInput: (value) => { state.notes = value; }
      });
      body.appendChild(notesField.field);
    }

    function summarizedSchedule() {
      const every = Math.max(1, Number(state.intervalCount) || 1);
      const unit = RECURRING_FREQUENCIES.find((f) => f.value === state.frequency)?.label.toLowerCase() || state.frequency;
      return el('div', {}, [
        el('span', { class: 'label', text: 'Schedule' }),
        el('div', { class: 'rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-500 dark:bg-slate-800/60 dark:text-slate-400', text: every === 1 ? `Every ${unit}` : `Every ${every} ${unit}s` })
      ]);
    }

    function accountOptions() {
      return store.list(RESOURCES.ACCOUNTS).map((account) => ({
        value: account.id,
        label: `${account.name} · ${account.currency}${account.archived ? ' (archived)' : ''}`
      }));
    }

    function collect() {
      return {
        name: state.name,
        type: state.type,
        amount: state.amount,
        currency: currentCurrency(),
        accountId: state.accountId,
        toAccountId: state.type === 'transfer' ? state.toAccountId : null,
        categoryId: state.type === 'transfer' ? null : state.categoryId,
        frequency: state.frequency,
        intervalCount: Math.max(1, Number(state.intervalCount) || 1),
        startDate: state.startDate,
        nextDueDate: state.nextDueDate,
        endDate: state.endDate || null,
        paymentMethod: state.paymentMethod,
        status: state.status,
        notes: state.notes
      };
    }

    render();

    const form = el('form', { class: 'space-y-4', novalidate: true, onsubmit: (event) => event.preventDefault() }, [body]);

    const submit = () => {
      for (const field of Object.values(fields)) field?.clearError?.();
      errorBox.classList.add('hidden');
      const input = collect();
      const result = isEdit ? service.update(rule.id, input) : service.add(input);
      if (!result.ok) {
        errorBox.textContent = Object.values(result.errors)[0];
        errorBox.classList.remove('hidden');
        for (const [key, message] of Object.entries(result.errors)) fields[key]?.setError?.(message);
        return;
      }
      toast?.success(isEdit ? 'Recurring rule updated' : 'Recurring rule created', result.record.name);
      modal.close('saved');
      refresh();
    };

    const modal = openModal({
      title: isEdit ? 'Edit recurring rule' : 'New recurring rule',
      description: isEdit ? 'Changes apply from the next occurrence onward. Already-generated transactions are untouched.' : undefined,
      size: 'lg',
      content: form,
      footer: el('div', { class: 'flex items-center justify-end gap-2' }, [
        el('button', { type: 'button', class: 'btn btn-secondary', text: 'Cancel', onclick: () => modal.close('cancel') }),
        el('button', { type: 'button', class: 'btn btn-primary', text: isEdit ? 'Save changes' : 'Create rule', onclick: submit })
      ])
    });

    fields.name?.input?.focus();
    return modal;
  }

  /* --------------------------------------------------------------------- *
   * Actions
   * --------------------------------------------------------------------- */

  function postNext(rule) {
    const dueDate = rule.nextDueDate;
    if (!dueDate) {
      toast?.warning('Nothing to post', 'This rule has no upcoming date.');
      return;
    }
    postOne({ rule, dueDate, key: `${rule.id}:${dueDate}` });
  }

  async function remove(rule) {
    const generated = service.generatedCount(rule.id);
    const ok = await confirmDialog({
      title: `Delete “${rule.name}”?`,
      message: generated > 0
        ? `The rule is removed but the ${generated} transaction${generated === 1 ? '' : 's'} it generated are kept.`
        : 'This recurring rule is removed permanently.',
      confirmLabel: 'Delete rule',
      variant: 'danger',
      tone: 'danger'
    });
    if (!ok) return;
    run(() => service.remove(rule.id), 'Recurring rule deleted', rule.name);
  }

  function run(action, successTitle, detail) {
    const result = action();
    if (result.ok) {
      toast?.success(successTitle, detail);
      refresh();
    } else {
      toast?.error('Action failed', Object.values(result.errors || {})[0] || 'The action could not be completed.');
    }
  }

  function exportRows() {
    const rows = service.all().map((rule) => ({ rule, monthlyEquivalentMinor: service.monthlyEquivalent(rule) }));
    if (rows.length === 0) {
      toast?.warning('Nothing to export', 'There are no recurring rules yet.');
      return;
    }
    exportRecurring(rows, { categories: store.list(RESOURCES.CATEGORIES), accounts: store.list(RESOURCES.ACCOUNTS) });
    toast?.success('Export ready', `${rows.length} rule${rows.length === 1 ? '' : 's'} written to CSV.`);
  }

  /* --------------------------------------------------------------------- *
   * Helpers
   * --------------------------------------------------------------------- */

  function typeLabel(type) {
    return TRANSACTION_TYPES.find((entry) => entry.value === type)?.label || type;
  }

  function frequencyLabel(rule) {
    const every = Math.max(1, Number(rule.intervalCount) || 1);
    const unit = RECURRING_FREQUENCIES.find((entry) => entry.value === rule.frequency)?.label.toLowerCase() || rule.frequency;
    return every === 1 ? `Every ${unit}` : `Every ${every} ${unit}s`;
  }

  function scopeLabel(rule) {
    if (rule.type === 'transfer') {
      return `${store.accountName(rule.accountId)} → ${store.accountName(rule.toAccountId)}`;
    }
    const category = store.byId(RESOURCES.CATEGORIES, rule.categoryId);
    return `${store.accountName(rule.accountId)} · ${category ? category.name : 'Deleted category'}`;
  }

  function kv(label, value) {
    return el('div', {}, [
      el('dt', { class: 'text-[11px] uppercase tracking-wide text-slate-400 dark:text-slate-500', text: label }),
      el('dd', { class: 'text-sm text-slate-800 dark:text-slate-100', text: value })
    ]);
  }

  function fromMinorString(minor, currency) {
    const decimals = currency === 'JPY' ? 0 : 2;
    return (Number(minor) / 100).toFixed(decimals);
  }

  function addMonthsISO(iso, months) {
    const [y, m, d] = iso.split('-').map(Number);
    const date = new Date(y, m - 1, d);
    date.setMonth(date.getMonth() + months);
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
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
