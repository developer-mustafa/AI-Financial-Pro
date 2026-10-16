/**
 * Category management screen: create, rename, recolour, re-icon, nest,
 * archive, restore, inspect usage, and jump to the transactions of a category.
 */

import { el, icon, clear, debounce } from '../../utils/dom.js';
import {
  badge, dataTable, emptyState, iconTile, money, sectionCard, tabs, textField,
  selectField, iconField, colorField, searchInput, dropdownMenu
} from '../../components/ui.js';
import { openModal } from '../../components/modal.js';
import { confirmDialog } from '../../components/confirmDialog.js';
import { ICON_CHOICES, PALETTE } from '../../config/defaults.js';
import { RESOURCES } from '../../core/state.js';
import { Router } from '../../core/router.js';
import { sanitizeColor } from '../../utils/sanitize.js';

export function mount(container, ctx) {
  const { store, toast, services, router } = ctx;
  const service = services.categories;
  const locale = store.preferences.locale;

  const ui = { q: '', type: 'expense', showArchived: false };
  const root = el('div', { class: 'space-y-4' });
  container.appendChild(root);

  const listHolder = el('div');

  const refresh = () => {
    const stats = service.stats();
    const term = ui.q.trim().toLowerCase();
    const rows = service
      .ordered(ui.type)
      .filter((category) => (ui.showArchived ? true : !category.archived))
      .filter((category) => (term ? category.name.toLowerCase().includes(term) : true));

    renderList(rows, stats);
  };

  const refreshDebounced = debounce(refresh, 200);

  function renderList(rows, stats) {
    clear(listHolder);
    listHolder.appendChild(sectionCard({
      title: `${ui.type === 'income' ? 'Income' : 'Expense'} categories`,
      description: 'Archived categories stay attached to their historical transactions and keep their original colour.',
      actions: [
        el('button', { type: 'button', class: 'btn btn-primary btn-sm', onclick: () => openForm(null) }, [
          icon('plus', 'h-3.5 w-3.5'),
          el('span', { text: 'Add category' })
        ])
      ],
      body: [
        el('div', { class: 'flex flex-wrap items-center gap-3' }, [
          searchInput({ value: ui.q, placeholder: 'Search categories…', onInput: (value) => { ui.q = value; refreshDebounced(); }, class: 'sm:max-w-xs' }),
          el('label', { class: 'flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400' }, [
            el('input', {
              type: 'checkbox',
              class: 'h-4 w-4 rounded border-slate-300 text-brand-600 dark:border-slate-600 dark:bg-slate-800',
              checked: ui.showArchived,
              onchange: (event) => {
                ui.showArchived = event.target.checked;
                refresh();
              }
            }),
            el('span', { text: 'Show archived' })
          ])
        ]),
        el('div', { class: 'mt-3' }, [
          rows.length === 0
            ? emptyState({
                iconName: 'tags',
                title: ui.q ? 'No categories match that search' : 'No categories yet',
                message: ui.q ? 'Try a different search term.' : 'Create a category to organise your transactions.',
                actionLabel: ui.q ? null : 'Add category',
                onAction: () => openForm(null)
              })
            : dataTable({
                caption: 'Category list',
                columns: [
                  {
                    key: 'name',
                    label: 'Name',
                    class: 'min-w-[14rem]',
                    render: (category) => el('div', { class: 'flex items-center gap-2', style: { paddingLeft: `${category.depth * 18}px` } }, [
                      category.depth > 0 ? icon('corner-down-right', 'h-3.5 w-3.5 shrink-0 text-slate-300 dark:text-slate-600') : null,
                      iconTile(category.icon, category.color, 'sm'),
                      el('div', { class: 'min-w-0' }, [
                        el('p', { class: 'truncate text-sm font-medium text-slate-800 dark:text-slate-100', text: category.name }),
                        category.isDefault ? el('span', { class: 'text-[10px] uppercase tracking-wide text-slate-400', text: 'Default' }) : null
                      ])
                    ])
                  },
                  { key: 'status', label: 'Status', render: (category) => (category.archived ? badge('Archived', 'neutral') : badge('Active', 'income')) },
                  {
                    key: 'count',
                    label: 'Transactions',
                    align: 'right',
                    render: (category) => el('span', { class: 'num text-slate-600 dark:text-slate-300', text: String(stats.get(category.id)?.count || 0) })
                  },
                  {
                    key: 'total',
                    label: 'Total recorded',
                    align: 'right',
                    render: (category) => {
                      const entry = stats.get(category.id);
                      if (!entry) return el('span', { class: 'muted', text: '—' });
                      const value = ui.type === 'income' ? entry.incomeMinor : entry.expenseMinor;
                      return el('span', { class: 'num font-medium text-slate-700 dark:text-slate-200', text: money(value, { currency: store.preferences.currency, locale }) });
                    }
                  },
                  {
                    key: 'actions',
                    label: '',
                    align: 'right',
                    class: 'w-12',
                    render: (category) => dropdownMenu({
                      title: 'Category actions',
                      items: [
                        { label: 'Edit', icon: 'pencil', onClick: () => openForm(category) },
                        { label: 'Add subcategory', icon: 'corner-down-right', onClick: () => openForm(null, { parentId: category.id }) },
                        { label: 'View transactions', icon: 'list', onClick: () => router.navigate(`/transactions?category=${encodeURIComponent(category.id)}`) },
                        category.archived
                          ? { label: 'Restore', icon: 'rotate-ccw', onClick: () => restore(category) }
                          : { label: 'Archive', icon: 'archive', onClick: () => archive(category) },
                        { divider: true },
                        {
                          label: 'Delete permanently',
                          icon: 'trash-2',
                          variant: 'danger',
                          onClick: () => remove(category)
                        }
                      ]
                    })
                  }
                ],
                rows,
                rowKey: (category) => category.id
              })
        ])
      ],
      footer: [
        el('p', { class: 'text-[11px] text-slate-400 dark:text-slate-500', text: 'Renaming or recolouring a category updates it everywhere, including historical reports. Deleting is only possible when no transaction references the category.' })
      ]
    }));
  }

  /* --------------------------------------------------------------------- *
   * Form
   * --------------------------------------------------------------------- */

  function openForm(category = null, defaults = {}) {
    const isEdit = Boolean(category);
    const state = {
      name: category?.name || '',
      type: category?.type || ui.type,
      parentId: category?.parentId || defaults.parentId || '',
      icon: category?.icon || (ui.type === 'income' ? 'trending-up' : 'tag'),
      color: category?.color || '#64748b'
    };

    const nameField = textField({
      label: 'Name',
      name: 'name',
      value: state.name,
      required: true,
      maxlength: 120,
      placeholder: 'e.g. Groceries',
      onInput: (value) => {
        state.name = value;
      }
    });
    const typeField = selectField({
      label: 'Type',
      name: 'type',
      value: state.type,
      options: [
        { value: 'expense', label: 'Expense' },
        { value: 'income', label: 'Income' }
      ],
      required: true,
      hint: isEdit ? 'Changing the type is only allowed when the category has no transactions.' : undefined,
      onChange: (value) => {
        state.type = value;
        renderParent();
        parentField.input.value = '';
        state.parentId = '';
      }
    });
    const parentHolder = el('div');
    let parentField = selectField({
      label: 'Parent category',
      name: 'parentId',
      value: state.parentId,
      options: [{ value: '', label: 'None (top level)' }, ...service.parentOptions(state.type, category?.id || null)],
      hint: 'Subcategories roll up into their parent for reporting and budgets.',
      onChange: (value) => {
        state.parentId = value;
      }
    });
    function renderParent() {
      clear(parentHolder);
      parentField = selectField({
        label: 'Parent category',
        name: 'parentId',
        value: '',
        options: [{ value: '', label: 'None (top level)' }, ...service.parentOptions(state.type, category?.id || null)],
        hint: 'Subcategories roll up into their parent for reporting and budgets.',
        onChange: (value) => {
          state.parentId = value;
        }
      });
      parentHolder.appendChild(parentField.field);
    }
    renderParent();

    const iconPicker = iconField({ value: state.icon, choices: ICON_CHOICES, onChange: (value) => { state.icon = value; } });
    const colorPicker = colorField({ value: state.color, palette: PALETTE, onChange: (value) => { state.color = sanitizeColor(value, state.color); } });

    const errorBox = el('div', { class: 'hidden rounded-xl border border-expense-200 bg-expense-50 p-3 text-xs text-expense-700 dark:border-expense-500/30 dark:bg-expense-500/10 dark:text-expense-300' });

    const form = el('form', { class: 'space-y-4', novalidate: true, onsubmit: (event) => event.preventDefault() }, [
      errorBox,
      nameField.field,
      el('div', { class: 'grid gap-4 sm:grid-cols-2' }, [typeField.field, parentHolder]),
      iconPicker,
      colorPicker
    ]);

    const submit = () => {
      const input = { ...state, parentId: state.parentId || null };
      const result = isEdit ? service.update(category.id, input) : service.add(input);
      if (!result.ok) {
        errorBox.textContent = Object.values(result.errors)[0];
        errorBox.classList.remove('hidden');
        nameField.setError(result.errors.name || '');
        return;
      }
      toast?.success(isEdit ? 'Category updated' : 'Category created', result.record.name);
      ui.type = result.record.type;
      modal.close('saved');
      refresh();
    };

    const modal = openModal({
      title: isEdit ? 'Edit category' : 'New category',
      description: isEdit ? 'Changes appear immediately in every list, chart and report.' : undefined,
      size: 'md',
      content: form,
      footer: el('div', { class: 'flex items-center justify-end gap-2' }, [
        el('button', { type: 'button', class: 'btn btn-secondary', text: 'Cancel', onclick: () => modal.close('cancel') }),
        el('button', { type: 'button', class: 'btn btn-primary', text: isEdit ? 'Save changes' : 'Create category', onclick: submit })
      ])
    });

    nameField.input.focus();
    return modal;
  }

  /* --------------------------------------------------------------------- *
   * Actions
   * --------------------------------------------------------------------- */

  async function archive(category) {
    const usage = service.usageCount(category.id);
    const ok = await confirmDialog({
      title: `Archive “${category.name}”?`,
      message: usage > 0
        ? `${usage} existing transaction${usage === 1 ? '' : 's'} keep this category, and history stays readable. It will no longer be selectable for new transactions.`
        : 'It will no longer be selectable for new transactions. You can restore it at any time.',
      confirmLabel: 'Archive',
      variant: 'primary',
      tone: 'warning'
    });
    if (!ok) return;
    const result = service.archive(category.id);
    if (result.ok) {
      toast?.success('Category archived', category.name);
      refresh();
    } else {
      toast?.error('Could not archive', Object.values(result.errors)[0]);
    }
  }

  function restore(category) {
    const result = service.restore(category.id);
    if (result.ok) {
      toast?.success('Category restored', category.name);
      refresh();
    } else {
      toast?.error('Could not restore', Object.values(result.errors)[0]);
    }
  }

  async function remove(category) {
    const usage = service.usageCount(category.id);
    if (usage > 0) {
      toast?.warning('Category in use', `Archive “${category.name}” instead — deleting would orphan ${usage} transaction(s).`);
      return;
    }
    const ok = await confirmDialog({
      title: `Delete “${category.name}”?`,
      message: 'This category is not referenced by any transaction, so it can be removed permanently.',
      confirmLabel: 'Delete',
      variant: 'danger',
      tone: 'danger'
    });
    if (!ok) return;
    const result = service.remove(category.id);
    if (result.ok) {
      toast?.success('Category deleted', category.name);
      refresh();
    } else {
      toast?.error('Could not delete', Object.values(result.errors)[0]);
    }
  }

  /* --------------------------------------------------------------------- *
   * Shell
   * --------------------------------------------------------------------- */

  const tabsNode = tabs({
    items: [
      { id: 'expense', label: 'Expense categories' },
      { id: 'income', label: 'Income categories' }
    ],
    activeId: ui.type,
    onChange: (id) => {
      ui.type = id;
      clear(root);
      root.append(renderShell());
      refresh();
    },
    ariaLabel: 'Category type'
  });

  function renderShell() {
    return el('div', { class: 'space-y-4' }, [
      el('div', { class: 'flex flex-wrap items-center justify-between gap-3' }, [
        el('div', {}, [
          el('h2', { class: 'section-title', text: 'Categories' }),
          el('p', { class: 'text-xs text-slate-500 dark:text-slate-400', text: 'Organise income and expenses. Categories drive budgets, reports and charts.' })
        ]),
        tabsNode
      ]),
      listHolder
    ]);
  }

  root.appendChild(renderShell());
  refresh();

  return {
    refresh,
    destroy() {
      refreshDebounced.cancel();
      clear(container);
    }
  };
}
