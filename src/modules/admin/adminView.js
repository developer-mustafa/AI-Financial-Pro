/**
 * User Management screen (super-admin).
 *
 * Lists every account in this deployment and lets an administrator create
 * users, promote/demote them, suspend/reactivate them and delete them. It is
 * reachable only by accounts whose role is 'admin' — the sidebar hides the
 * entry and the Worker refuses the API (403) for everyone else. This screen
 * never shows or edits another user's finance data.
 */

import { el, icon, clear, debounce } from '../../utils/dom.js';
import {
  badge, dataTable, dropdownMenu, emptyState, errorState, loader,
  pagination, searchInput, sectionCard, statCard, textField, selectField
} from '../../components/ui.js';
import { openModal } from '../../components/modal.js';
import { confirmDialog } from '../../components/confirmDialog.js';
import { Router } from '../../core/router.js';
import { formatDate } from '../../utils/date.js';

const PAGE_SIZES = [10, 25, 50, 100];

export function mount(container, ctx) {
  const { cloud, toast, store, services } = ctx;
  const auth = cloud?.auth;
  const service = services?.admin;
  const locale = store?.preferences?.locale || 'en-US';

  const root = el('div', { class: 'space-y-4' });
  container.appendChild(root);

  /* --------------------------------------------------------------------- *
   * Access guards
   * --------------------------------------------------------------------- */

  const gate = accessGate({ cloud, auth, service });
  if (gate) {
    root.appendChild(gate);
    return { destroy() { clear(container); } };
  }

  const ui = { q: '', limit: 25, offset: 0, total: 0, items: [], loading: true, error: null };
  let disposed = false;

  const summaryHolder = el('div', { class: 'grid gap-3 sm:grid-cols-3' });
  const bodyHolder = el('div');
  root.append(summaryHolder, bodyHolder);

  const load = async () => {
    ui.loading = true;
    ui.error = null;
    render();
    try {
      const data = await service.list({ limit: ui.limit, offset: ui.offset, q: ui.q });
      if (disposed) return;
      ui.items = Array.isArray(data?.items) ? data.items : [];
      ui.total = Number(data?.total || 0);
    } catch (error) {
      if (disposed) return;
      ui.error = error?.message || 'Could not load users.';
      ui.items = [];
      ui.total = 0;
    } finally {
      if (!disposed) {
        ui.loading = false;
        render();
      }
    }
  };
  const loadDebounced = debounce(load, 250);

  function render() {
    renderSummary();
    clear(bodyHolder);
    bodyHolder.appendChild(renderCard());
  }

  function renderSummary() {
    clear(summaryHolder);
    if (ui.loading && ui.items.length === 0) return;
    const admins = ui.items.filter((u) => u.role === 'admin').length;
    const suspended = ui.items.filter((u) => u.status === 'suspended').length;
    summaryHolder.append(
      statCard({ label: 'Total users', value: String(ui.total), iconName: 'users', tone: 'brand', sub: ui.q ? 'Matching search' : 'All accounts' }),
      statCard({ label: 'Administrators', value: String(admins), iconName: 'shield-check', tone: 'savings', sub: 'On this page' }),
      statCard({ label: 'Suspended', value: String(suspended), iconName: 'ban', tone: suspended ? 'expense' : 'neutral', sub: 'On this page' })
    );
  }

  function renderCard() {
    const actions = [
      el('button', {
        type: 'button',
        class: 'btn btn-secondary btn-sm',
        onclick: () => load(),
        title: 'Refresh'
      }, [icon('refresh-cw', 'h-3.5 w-3.5'), el('span', { text: 'Refresh' })]),
      el('button', {
        type: 'button',
        class: 'btn btn-primary btn-sm',
        onclick: () => openCreateDialog()
      }, [icon('user-plus', 'h-3.5 w-3.5'), el('span', { text: 'New user' })])
    ];

    const search = searchInput({
      value: ui.q,
      placeholder: 'Search by email or name…',
      label: 'Search users',
      onInput: (value) => {
        ui.q = value;
        ui.offset = 0;
        loadDebounced();
      }
    });

    let content;
    if (ui.loading && ui.items.length === 0) {
      content = loader('Loading users…');
    } else if (ui.error) {
      content = errorState({ title: 'Could not load users', message: ui.error, onRetry: () => load() });
    } else if (ui.items.length === 0) {
      content = emptyState({
        iconName: 'users',
        title: ui.q ? 'No matching users' : 'No users yet',
        message: ui.q ? 'Try a different email or name.' : 'Accounts created here can sign in with their email and password.',
        actionLabel: ui.q ? null : 'New user',
        onAction: ui.q ? null : () => openCreateDialog()
      });
    } else {
      content = userTable();
    }

    return sectionCard({
      title: 'Users',
      description: ui.q ? `Filtered by “${ui.q}”` : 'Every account in this deployment.',
      actions,
      body: [
        el('div', { class: 'mb-3' }, [search]),
        content,
        ui.total > ui.limit
          ? pagination({
              page: Math.floor(ui.offset / ui.limit) + 1,
              pageSize: ui.limit,
              total: ui.total,
              sizes: PAGE_SIZES,
              itemLabel: 'users',
              onPage: (page) => { ui.offset = (page - 1) * ui.limit; load(); },
              onPageSize: (size) => { ui.limit = size; ui.offset = 0; load(); }
            })
          : null
      ]
    });
  }

  function userTable() {
    return dataTable({
      caption: 'Users',
      rowKey: (row) => row.id,
      rows: ui.items,
      empty: emptyState({ title: 'No users' }),
      columns: [
        {
          key: 'email',
          label: 'Account',
          render: (row) => el('div', { class: 'min-w-0' }, [
            el('span', { class: 'block truncate font-medium text-slate-800 dark:text-slate-100', text: row.email }),
            row.name ? el('span', { class: 'block truncate text-[11px] text-slate-400 dark:text-slate-500', text: row.name }) : null
          ])
        },
        {
          key: 'role',
          label: 'Role',
          render: (row) => (row.role === 'admin' ? badge('Admin', 'brand') : badge('User', 'neutral'))
        },
        {
          key: 'status',
          label: 'Status',
          render: (row) => (row.status === 'suspended' ? badge('Suspended', 'expense') : badge('Active', 'income'))
        },
        {
          key: 'provider',
          label: 'Sign-in',
          class: 'hidden md:table-cell',
          render: (row) => (row.provider === 'neon' ? 'Email link' : 'Password')
        },
        {
          key: 'createdAt',
          label: 'Created',
          class: 'hidden lg:table-cell',
          render: (row) => (row.createdAt ? formatDate(row.createdAt, { locale }) : '—')
        },
        {
          key: 'actions',
          label: '',
          align: 'right',
          render: (row) => actionsCell(row)
        }
      ]
    });
  }

  function actionsCell(row) {
    const isSelf = row.id === auth?.user?.id;
    if (isSelf) {
      return el('span', { class: 'text-[11px] font-medium text-slate-400 dark:text-slate-500', title: 'You cannot change your own role, status or delete yourself', text: 'You' });
    }

    const items = [];
    if (row.role === 'admin') {
      items.push({
        label: 'Demote to user',
        icon: 'arrow-down',
        onClick: () => mutate(() => service.update(row.id, { role: 'user' }), 'Role updated')
      });
    } else {
      items.push({
        label: 'Promote to admin',
        icon: 'shield-check',
        onClick: () => mutate(() => service.update(row.id, { role: 'admin' }), 'Role updated')
      });
    }

    if (row.status === 'suspended') {
      items.push({
        label: 'Reactivate',
        icon: 'circle-check',
        onClick: () => mutate(() => service.update(row.id, { status: 'active' }), 'User reactivated')
      });
    } else {
      items.push({
        label: 'Suspend',
        icon: 'ban',
        onClick: () => mutate(() => service.update(row.id, { status: 'suspended' }), 'User suspended')
      });
    }

    items.push({ divider: true });
    items.push({
      label: 'Delete user',
      icon: 'trash-2',
      variant: 'danger',
      onClick: () => removeUser(row)
    });

    return dropdownMenu({ label: `Actions for ${row.email}`, title: 'Actions', align: 'right', items });
  }

  async function mutate(fn, successMessage) {
    try {
      await fn();
      toast?.success(successMessage);
      await load();
    } catch (error) {
      toast?.error('Action failed', error?.message || 'Please try again.');
    }
  }

  async function removeUser(row) {
    const ok = await confirmDialog({
      title: `Delete ${row.email}?`,
      message: 'This permanently deletes the account and every transaction, account, budget, goal and rule that belongs to it.',
      detail: 'This cannot be undone.',
      confirmLabel: 'Delete user',
      variant: 'danger',
      tone: 'danger',
      requireText: 'DELETE'
    });
    if (!ok) return;
    await mutate(() => service.remove(row.id), 'User deleted');
  }

  /* --------------------------------------------------------------------- *
   * Create-user dialog
   * --------------------------------------------------------------------- */

  function openCreateDialog() {
    const form = { email: '', name: '', password: '', role: 'user' };

    const errorBox = el('div', { class: 'hidden rounded-xl border border-expense-200 bg-expense-50 p-3 text-xs text-expense-700 dark:border-expense-500/30 dark:bg-expense-500/10 dark:text-expense-300' });

    const emailField = textField({ label: 'Email', name: 'email', type: 'email', required: true, onInput: (v) => { form.email = v; } });
    const nameField = textField({ label: 'Name', name: 'name', hint: 'Optional display name.', onInput: (v) => { form.name = v; } });
    const passwordField = textField({ label: 'Temporary password', name: 'password', type: 'password', required: true, hint: 'At least 8 characters. Share it securely; the user can change it later.', onInput: (v) => { form.password = v; } });
    const roleField = selectField({
      label: 'Role',
      name: 'role',
      value: 'user',
      options: [{ value: 'user', label: 'User' }, { value: 'admin', label: 'Administrator' }],
      hint: 'Administrators can manage every account.',
      onChange: (v) => { form.role = v; }
    });

    const submitBtn = el('button', { type: 'button', class: 'btn btn-primary', text: 'Create user' });
    const cancelBtn = el('button', { type: 'button', class: 'btn btn-secondary', text: 'Cancel', onclick: () => dialog.close('cancel') });

    const formEl = el('form', {
      class: 'space-y-4',
      novalidate: true,
      onsubmit: async (event) => {
        event.preventDefault();
        errorBox.classList.add('hidden');
        submitBtn.disabled = true;
        try {
          const created = await service.create({
            email: form.email,
            password: form.password,
            name: form.name,
            role: form.role
          });
          toast?.success('User created', `${created?.user?.email || form.email} can now sign in.`);
          dialog.close('created');
          await load();
        } catch (error) {
          errorBox.textContent = error?.message || 'Could not create the user.';
          errorBox.classList.remove('hidden');
          submitBtn.disabled = false;
        }
      }
    }, [
      errorBox,
      emailField.field,
      nameField.field,
      el('div', { class: 'grid gap-4 sm:grid-cols-2' }, [passwordField.field, roleField.field])
    ]);

    const dialog = openModal({
      title: 'Create user',
      description: 'Creates an account that can sign in with email and password.',
      size: 'md',
      content: formEl,
      footer: el('div', { class: 'flex items-center justify-end gap-2' }, [cancelBtn, submitBtn])
    });
    // The footer button sits outside the form, so route the click to a submit.
    submitBtn.addEventListener('click', () => {
      if (formEl.requestSubmit) formEl.requestSubmit();
      else formEl.dispatchEvent(new Event('submit'));
    });
  }

  load();

  return {
    refresh: load,
    destroy() {
      disposed = true;
      loadDebounced.cancel();
      clear(container);
    }
  };
}

/**
 * Render the appropriate gate when the screen cannot be used. Returns null when
 * the signed-in account is an administrator and the API is configured.
 */
function accessGate({ cloud, auth, service }) {
  if (!cloud?.configured || !service?.configured) {
    return sectionCard({
      title: 'User Management',
      description: 'Administrator tools are unavailable.',
      body: [emptyState({
        iconName: 'cloud-off',
        title: 'Cloud sync is off',
        message: 'This build runs in local-only mode. Set apiBaseUrl in runtime-config.js to your Worker URL to enable accounts and administration.',
        secondaryLabel: 'Open Settings',
        onSecondary: () => { window.location.hash = Router.href('/settings'); }
      })]
    });
  }

  if (!auth?.signedIn) {
    return sectionCard({
      title: 'User Management',
      description: 'Sign in to continue.',
      body: [emptyState({
        iconName: 'log-in',
        title: 'Sign in required',
        message: 'Sign in with an administrator account to manage users.',
        actionLabel: 'Go to Settings',
        onAction: () => { window.location.hash = Router.href('/settings'); }
      })]
    });
  }

  if (!auth?.isAdmin) {
    return sectionCard({
      title: 'User Management',
      description: 'Restricted area.',
      body: [emptyState({
        iconName: 'shield-alert',
        title: 'Administrator access required',
        message: 'Your account does not have the administrator role. Ask an administrator to promote you.',
        actionLabel: 'Back to Dashboard',
        onAction: () => { window.location.hash = Router.href('/dashboard'); }
      })]
    });
  }

  return null;
}
