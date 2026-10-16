/**
 * Platform administration screens.
 *
 * One module serves four routes, chosen from `ctx.route.segments`:
 *
 *   /platform                 → overview (totals + recent activity)
 *   /platform/tenants         → searchable, filterable, paginated workspace list
 *   /platform/tenants/:id     → workspace detail (usage + members + actions)
 *   /platform/audit           → platform-wide audit log
 *
 * Access is gated on the PLATFORM_ADMIN role client-side for usability only;
 * the Worker independently enforces `users.role === 'admin'` on every call.
 * Platform admins never implicitly see a workspace's financial rows — the
 * finance APIs still require a tenant membership.
 *
 * Destructive actions are soft: a workspace is ARCHIVED, never hard-deleted.
 */

import { el, icon, clear } from '../../utils/dom.js';
import {
  badge, dataTable, emptyState, errorState, loader, pagination,
  searchInput, sectionCard, selectField, statCard, textField
} from '../../components/ui.js';
import { openModal } from '../../components/modal.js';
import { confirmDialog } from '../../components/confirmDialog.js';
import { t } from '../../i18n/index.js';

const PAGE_SIZE = 25;

function toIso(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function formatDateTime(value, locale) {
  const iso = toIso(value);
  if (!iso) return '—';
  try {
    return new Intl.DateTimeFormat(locale || 'en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
  } catch {
    return iso.slice(0, 16).replace('T', ' ');
  }
}

function statusBadgeFor(status) {
  if (status === 'suspended') return badge(t('ws.suspendedBadge'), 'warning');
  if (status === 'archived') return badge(t('ws.archivedBadge'), 'neutral');
  return badge(t('ws.activeBadge'), 'income');
}

function typeBadgeFor(type) {
  return type === 'personal'
    ? badge(t('ws.personalBadge'), 'neutral')
    : badge(t('ws.organizationBadge'), 'brand');
}

function outcomeBadgeFor(outcome) {
  if (outcome === 'failure') return badge(t('platform.outcome.failure'), 'expense');
  if (outcome === 'denied') return badge(t('platform.outcome.denied'), 'warning');
  return badge(t('platform.outcome.success'), 'income');
}

export function mount(container, ctx) {
  const { cloud, services } = ctx;
  const service = services?.platform;
  const root = el('div', { class: 'space-y-4' });
  container.appendChild(root);

  if (!cloud?.auth?.signedIn || !service?.configured) {
    root.appendChild(errorState({ title: t('platform.accessTitle'), message: t('ws.signInRequired') }));
    return { destroy() { clear(container); } };
  }
  if (!cloud?.auth?.isAdmin) {
    root.appendChild(errorState({ title: t('platform.accessTitle'), message: t('platform.accessMessage') }));
    return { destroy() { clear(container); } };
  }

  const segments = ctx.route?.segments || ['platform'];
  const section = segments[1] || '';
  const tenantId = section === 'tenants' ? (segments[2] || null) : null;

  let view;
  if (section === 'tenants' && tenantId) view = mountTenantDetail(ctx, root, service, tenantId);
  else if (section === 'tenants') view = mountTenantList(ctx, root, service);
  else if (section === 'audit') view = mountAudit(ctx, root, service);
  else view = mountOverview(ctx, root, service);

  return {
    destroy() {
      view?.destroy?.();
      clear(container);
    }
  };
}

/* -------------------------------------------------------------------------- *
 * Overview
 * -------------------------------------------------------------------------- */

function mountOverview(ctx, root, service) {
  const holder = el('div', { class: 'space-y-4' });
  root.replaceChildren(holder);
  let disposed = false;

  holder.appendChild(el('div', { class: 'flex flex-wrap items-center justify-between gap-3' }, [
    el('div', {}, [
      el('h2', { class: 'text-lg font-semibold tracking-tight text-slate-900 dark:text-slate-50', text: t('platform.overviewTitle') }),
      el('p', { class: 'mt-0.5 text-xs text-slate-500 dark:text-slate-400', text: t('platform.overviewDesc') })
    ]),
    el('button', { type: 'button', class: 'btn btn-secondary btn-sm', onclick: () => ctx.router.navigate('/platform/tenants') }, [
      icon('building', 'h-4 w-4'), el('span', { text: t('platform.manageTenants') })
    ])
  ]));

  const statsHolder = el('div', { class: 'grid gap-3 sm:grid-cols-2 xl:grid-cols-4' });
  const recentHolder = el('div');
  holder.append(statsHolder, recentHolder);
  statsHolder.appendChild(loader(t('common.loading')));

  (async () => {
    try {
      const [data, audit] = await Promise.all([
        service.overview(),
        service.audit({ limit: 8 }).catch(() => ({ items: [] }))
      ]);
      if (disposed) return;
      const tenants = data?.tenants || {};
      const users = data?.users || {};
      const usage = data?.usage || {};
      clear(statsHolder);
      statsHolder.append(
        statCard({
          label: t('platform.stat.tenants'),
          value: String(tenants.total ?? 0),
          sub: `${tenants.active ?? 0} ${t('platform.stat.active')} · ${tenants.suspended ?? 0} ${t('platform.stat.suspended')} · ${tenants.archived ?? 0} ${t('platform.stat.archived')}`,
          iconName: 'building'
        }),
        statCard({
          label: t('platform.stat.organizations'),
          value: String(tenants.organizations ?? 0),
          sub: `${tenants.personal ?? 0} ${t('platform.personal')}`,
          iconName: 'briefcase',
          tone: 'brand'
        }),
        statCard({
          label: t('platform.stat.users'),
          value: String(users.total ?? 0),
          sub: `${users.admins ?? 0} ${t('platform.stat.admins')}`,
          iconName: 'users',
          tone: 'savings'
        }),
        statCard({
          label: t('platform.stat.transactions'),
          value: String(usage.transactions ?? 0),
          sub: `${usage.accounts ?? 0} ${t('platform.stat.accounts')}`,
          iconName: 'arrow-left-right',
          tone: 'neutral'
        })
      );
      recentHolder.replaceChildren(auditTable(audit?.items || [], ctx));
    } catch (error) {
      if (disposed) return;
      clear(statsHolder);
      statsHolder.appendChild(errorState({ title: t('error.pageTitle'), message: error?.message || t('error.pageMessage'), onRetry: () => mountOverview(ctx, root, service) }));
    }
  })();

  return {
    destroy() {
      disposed = true;
    }
  };
}

/* -------------------------------------------------------------------------- *
 * Tenants list
 * -------------------------------------------------------------------------- */

function mountTenantList(ctx, root, service) {
  const holder = el('div', { class: 'space-y-4' });
  root.replaceChildren(holder);
  const ui = { q: '', status: '', type: '', limit: PAGE_SIZE, offset: 0, total: 0, items: [], loading: true, error: null };
  let disposed = false;

  holder.appendChild(el('div', { class: 'flex flex-wrap items-start justify-between gap-3' }, [
    el('div', {}, [
      el('h2', { class: 'text-lg font-semibold tracking-tight text-slate-900 dark:text-slate-50', text: t('platform.tenantsTitle') }),
      el('p', { class: 'mt-0.5 text-xs text-slate-500 dark:text-slate-400', text: t('platform.tenantsDesc') })
    ]),
    el('button', { type: 'button', class: 'btn btn-primary btn-sm', onclick: () => openCreateTenant() }, [
      icon('plus', 'h-4 w-4'), el('span', { text: t('platform.createTenant') })
    ])
  ]));

  const controls = el('div', { class: 'flex flex-wrap items-center gap-2' });
  const bodyHolder = el('div', { class: 'space-y-3' });
  holder.append(controls, bodyHolder);

  const search = searchInput({
    placeholder: t('platform.tenantsTitle'),
    onInput: (value) => { ui.q = value; ui.offset = 0; load(); }
  });
  const statusSelect = selectField({
    label: '', name: 'status', value: '',
    options: [
      { value: '', label: t('platform.all') },
      { value: 'active', label: t('ws.activeBadge') },
      { value: 'suspended', label: t('ws.suspendedBadge') },
      { value: 'archived', label: t('ws.archivedBadge') }
    ],
    onChange: (value) => { ui.status = value; ui.offset = 0; load(); }
  });
  const typeSelect = selectField({
    label: '', name: 'type', value: '',
    options: [
      { value: '', label: t('platform.all') },
      { value: 'organization', label: t('ws.organizationBadge') },
      { value: 'personal', label: t('ws.personalBadge') }
    ],
    onChange: (value) => { ui.type = value; ui.offset = 0; load(); }
  });
  controls.append(
    el('div', { class: 'min-w-[14rem] flex-1' }, [search]),
    el('div', { class: 'w-40' }, [statusSelect.field]),
    el('div', { class: 'w-44' }, [typeSelect.field])
  );

  function render() {
    if (disposed) return;
    clear(bodyHolder);
    if (ui.loading) {
      bodyHolder.appendChild(loader(t('common.loading')));
      return;
    }
    if (ui.error) {
      bodyHolder.appendChild(errorState({ title: t('error.pageTitle'), message: ui.error, onRetry: () => load() }));
      return;
    }
    bodyHolder.appendChild(dataTable({
      columns: [
        { key: 'name', label: t('platform.nameColumn'), render: (row) => el('div', { class: 'flex items-center gap-2' }, [
          el('span', { class: 'font-medium text-slate-800 dark:text-slate-100', text: row.name || '—' }),
          row.isPersonal ? badge(t('ws.personalBadge'), 'neutral') : null
        ]) },
        { key: 'type', label: t('platform.typeColumn'), render: (row) => typeBadgeFor(row.type) },
        { key: 'status', label: t('platform.statusColumn'), render: (row) => statusBadgeFor(row.status) },
        { key: 'memberCount', label: t('platform.membersColumn'), align: 'right', render: (row) => String(row.memberCount ?? 0) },
        { key: 'transactionCount', label: t('platform.transactionsColumn'), align: 'right', render: (row) => String(row.transactionCount ?? 0) },
        { key: 'createdAt', label: t('platform.createdColumn'), render: (row) => formatDateTime(row.createdAt, ctx.store?.preferences?.locale).split(',')[0] }
      ],
      rows: ui.items,
      rowKey: (row) => row.id,
      onRowClick: (row) => ctx.router.navigate(`/platform/tenants/${encodeURIComponent(row.id)}`),
      empty: emptyState({ title: t('platform.noTenants') })
    }));
    if (ui.total > ui.limit) {
      bodyHolder.appendChild(pagination({
        page: Math.floor(ui.offset / ui.limit) + 1,
        pageSize: ui.limit,
        total: ui.total,
        onPage: (page) => { ui.offset = (page - 1) * ui.limit; load(); }
      }));
    }
  }

  async function load() {
    ui.loading = true;
    render();
    try {
      const data = await service.tenants({ q: ui.q, status: ui.status, type: ui.type, limit: ui.limit, offset: ui.offset });
      ui.items = data?.items || [];
      ui.total = data?.total || 0;
      ui.error = null;
    } catch (error) {
      ui.error = error?.message || t('error.pageMessage');
    } finally {
      ui.loading = false;
      render();
    }
  }

  function openCreateTenant() {
    const name = textField({ label: t('platform.tenantNameLabel'), name: 'tenant-name', required: true, maxlength: 120 });
    const slug = textField({ label: t('platform.tenantSlugLabel'), name: 'tenant-slug', hint: t('ws.slugHint'), maxlength: 61 });
    const owner = textField({ label: t('platform.ownerEmailLabel'), name: 'owner-email', type: 'email', hint: t('platform.ownerEmailHint') });
    const submit = el('button', { type: 'button', class: 'btn btn-primary' }, [el('span', { text: t('common.create') })]);
    const modal = openModal({
      title: t('platform.createTenantTitle'),
      size: 'sm',
      content: el('div', { class: 'space-y-3' }, [name.field, slug.field, owner.field]),
      footer: el('div', { class: 'flex justify-end gap-2' }, [
        el('button', { type: 'button', class: 'btn btn-secondary', text: t('common.cancel'), onclick: () => modal.close('cancel') }),
        submit
      ])
    });
    submit.addEventListener('click', async () => {
      name.clearError();
      if (!name.input.value.trim()) { name.setError(t('common.required')); return; }
      submit.disabled = true;
      try {
        await service.createTenant({
          name: name.input.value.trim(),
          slug: slug.input.value.trim() || undefined,
          ownerEmail: owner.input.value.trim() || undefined
        });
        modal.close('created');
        ctx.toast?.success?.(t('platform.tenantsTitle'), t('platform.tenantCreated'));
        load();
      } catch (error) {
        if (error?.code === 'user_not_found') owner.setError(t('platform.ownerEmailHint'));
        else ctx.toast?.fromError?.(error, t('error.pageMessage'));
        submit.disabled = false;
      }
    });
  }

  load();
  return { destroy() { disposed = true; } };
}

/* -------------------------------------------------------------------------- *
 * Tenant detail
 * -------------------------------------------------------------------------- */

function mountTenantDetail(ctx, root, service, tenantId) {
  const holder = el('div', { class: 'space-y-4' });
  root.replaceChildren(holder);
  const state = { loading: true, error: null, tenant: null, members: [] };
  let disposed = false;

  holder.appendChild(el('div', {}, [
    el('button', { type: 'button', class: 'btn btn-ghost btn-sm -ml-2', onclick: () => ctx.router.navigate('/platform/tenants') }, [
      icon('arrow-left', 'h-4 w-4'), el('span', { text: t('platform.back') })
    ])
  ]));

  const headHolder = el('div');
  const statsHolder = el('div', { class: 'grid gap-3 sm:grid-cols-3' });
  const membersHolder = el('div');
  holder.append(headHolder, statsHolder, membersHolder);

  function render() {
    if (disposed) return;
    clear(headHolder);
    clear(statsHolder);
    clear(membersHolder);

    if (state.loading) {
      headHolder.appendChild(loader(t('common.loading')));
      return;
    }
    if (state.error) {
      headHolder.appendChild(errorState({ title: t('platform.tenantNotFound'), message: state.error, onRetry: () => load() }));
      return;
    }

    const tenant = state.tenant || {};
    const isPersonal = Boolean(tenant.isPersonal);

    const statusAction = tenant.status === 'active'
      ? { label: t('platform.suspend'), icon: 'pause', run: () => changeStatus('suspended', t('platform.suspendTitle'), t('platform.suspendMessage')) }
      : { label: t('platform.activate'), icon: 'play', run: () => changeStatus('active') };
    const statusBtn = el('button', { type: 'button', class: 'btn btn-secondary btn-sm' }, [icon(statusAction.icon, 'h-4 w-4'), el('span', { text: statusAction.label })]);
    statusBtn.addEventListener('click', statusAction.run);

    const archiveBtn = el('button', { type: 'button', class: 'btn btn-secondary btn-sm text-expense-600 dark:text-expense-400' }, [icon('archive', 'h-4 w-4'), el('span', { text: t('platform.archiveTenant') })]);
    archiveBtn.addEventListener('click', archive);

    headHolder.appendChild(el('div', { class: 'flex flex-wrap items-start justify-between gap-3' }, [
      el('div', { class: 'min-w-0' }, [
        el('h2', { class: 'truncate text-lg font-semibold tracking-tight text-slate-900 dark:text-slate-50', text: tenant.name || t('platform.detailTitle') }),
        el('p', { class: 'mt-0.5 text-xs text-slate-500 dark:text-slate-400', text: t('platform.detailDesc') }),
        el('div', { class: 'mt-2 flex items-center gap-1.5' }, [typeBadgeFor(tenant.type), statusBadgeFor(tenant.status)])
      ]),
      el('div', { class: 'flex items-center gap-2' }, [statusBtn, tenant.status === 'archived' ? null : archiveBtn])
    ]));

    statsHolder.append(
      statCard({ label: t('platform.membersColumn'), value: String(tenant.memberCount ?? state.members.length ?? 0), iconName: 'users', tone: 'brand' }),
      statCard({ label: t('platform.transactionsColumn'), value: String(tenant.transactionCount ?? 0), iconName: 'arrow-left-right', tone: 'savings' }),
      statCard({ label: t('platform.stat.accounts'), value: String(tenant.accountCount ?? 0), iconName: 'wallet', tone: 'neutral' })
    );

    const addButton = el('button', { type: 'button', class: 'btn btn-primary btn-sm' }, [icon('user-plus', 'h-4 w-4'), el('span', { text: t('platform.addMember') })]);
    addButton.addEventListener('click', () => openAddMember());
    membersHolder.appendChild(sectionCard({
      title: t('platform.membersTitle'),
      actions: addButton,
      body: dataTable({
        columns: [
          { key: 'email', label: t('ws.emailColumn'), render: (row) => row.email || '—' },
          { key: 'name', label: t('ws.nameColumn'), render: (row) => row.name || '—' },
          { key: 'role', label: t('common.role'), render: (row) => badge(row.role === 'TENANT_ADMIN' ? t('ws.roleAdmin') : t('ws.roleMember'), row.role === 'TENANT_ADMIN' ? 'brand' : 'neutral') },
          { key: 'status', label: t('common.status'), render: (row) => badge(row.status === 'active' ? t('ws.activeBadge') : t('ws.suspendedBadge'), row.status === 'active' ? 'income' : 'warning') },
          {
            key: 'actions', label: t('common.actions'), align: 'right',
            render: (row) => {
              const remove = el('button', { type: 'button', class: 'btn btn-ghost btn-sm text-expense-600 dark:text-expense-400', title: t('ws.removeMember') }, [icon('user-minus', 'h-3.5 w-3.5')]);
              remove.addEventListener('click', () => removeMember(row));
              return remove;
            }
          }
        ],
        rows: state.members,
        rowKey: (row) => row.userId || row.email,
        empty: emptyState({ title: t('ws.noMembers'), compact: true })
      })
    }));

    if (isPersonal) {
      // Personal workspaces are single-member by design.
      membersHolder.querySelectorAll('button').forEach((button) => { button.disabled = true; });
    }
  }

  async function changeStatus(status, title, message) {
    if (title) {
      const ok = await confirmDialog({ title, message, confirmLabel: t('common.confirm'), variant: 'primary', tone: 'warning' });
      if (!ok) return;
    }
    try {
      await service.updateTenant(tenantId, { status });
      ctx.toast?.success?.(t('platform.detailTitle'), t('platform.tenantUpdated'));
      await load();
    } catch (error) {
      ctx.toast?.fromError?.(error, t('error.pageMessage'));
    }
  }

  async function archive() {
    const ok = await confirmDialog({ title: t('platform.archiveTitle'), message: t('platform.archiveMessage'), confirmLabel: t('platform.archiveTenant') });
    if (!ok) return;
    try {
      await service.archiveTenant(tenantId);
      ctx.toast?.success?.(t('platform.detailTitle'), t('platform.tenantArchived'));
      await load();
    } catch (error) {
      ctx.toast?.fromError?.(error, t('error.pageMessage'));
    }
  }

  async function removeMember(row) {
    const ok = await confirmDialog({ title: t('ws.removeMemberTitle'), message: t('ws.removeMemberMessage'), confirmLabel: t('ws.removeMember') });
    if (!ok) return;
    try {
      await service.removeMember(tenantId, row.userId);
      ctx.toast?.success?.(t('platform.membersTitle'), t('ws.removed'));
      await load();
    } catch (error) {
      ctx.toast?.fromError?.(error, t('error.pageMessage'));
    }
  }

  function openAddMember() {
    const email = textField({ label: t('ws.memberEmailLabel'), name: 'member-email', type: 'email', hint: t('ws.memberEmailHint'), required: true });
    const role = selectField({
      label: t('common.role'), name: 'member-role', value: 'TENANT_MEMBER',
      options: [{ value: 'TENANT_MEMBER', label: t('ws.roleMember') }, { value: 'TENANT_ADMIN', label: t('ws.roleAdmin') }]
    });
    const submit = el('button', { type: 'button', class: 'btn btn-primary' }, [el('span', { text: t('common.add') })]);
    const modal = openModal({
      title: t('ws.addMemberTitle'),
      size: 'sm',
      content: el('div', { class: 'space-y-3' }, [email.field, role.field]),
      footer: el('div', { class: 'flex justify-end gap-2' }, [
        el('button', { type: 'button', class: 'btn btn-secondary', text: t('common.cancel'), onclick: () => modal.close('cancel') }),
        submit
      ])
    });
    submit.addEventListener('click', async () => {
      email.clearError();
      if (!email.input.value.trim()) { email.setError(t('common.required')); return; }
      submit.disabled = true;
      try {
        await service.addMember(tenantId, { email: email.input.value.trim(), role: role.input.value });
        modal.close('added');
        ctx.toast?.success?.(t('platform.membersTitle'), t('ws.added'));
        await load();
      } catch (error) {
        if (error?.code === 'user_not_found') email.setError(t('ws.memberEmailHint'));
        else if (error?.code === 'already_member') email.setError(t('ws.memberExists'));
        else ctx.toast?.fromError?.(error, t('error.pageMessage'));
        submit.disabled = false;
      }
    });
  }

  async function load() {
    state.loading = true;
    render();
    try {
      const data = await service.tenant(tenantId);
      state.tenant = data?.tenant || null;
      state.members = data?.members || [];
      state.error = null;
    } catch (error) {
      state.error = error?.message || t('error.pageMessage');
    } finally {
      state.loading = false;
      render();
    }
  }

  load();
  return { destroy() { disposed = true; } };
}

/* -------------------------------------------------------------------------- *
 * Audit log
 * -------------------------------------------------------------------------- */

function auditTable(items, ctx) {
  return sectionCard({
    title: t('platform.auditTitle'),
    description: t('platform.auditDesc'),
    body: dataTable({
      columns: [
        { key: 'createdAt', label: t('platform.auditWhen'), render: (row) => formatDateTime(row.createdAt, ctx.store?.preferences?.locale) },
        { key: 'actorEmail', label: t('platform.auditActor'), render: (row) => row.actorEmail || t('platform.common.unknown') },
        { key: 'action', label: t('platform.auditAction') },
        { key: 'targetType', label: t('platform.auditTarget'), render: (row) => row.targetType ? `${row.targetType}${row.targetId ? `: ${String(row.targetId).slice(0, 12)}` : ''}` : '—' },
        { key: 'outcome', label: t('platform.auditOutcome'), render: (row) => outcomeBadgeFor(row.outcome) }
      ],
      rows: items,
      rowKey: (row) => row.id,
      empty: emptyState({ title: t('ws.noAudit'), compact: true })
    })
  });
}

function mountAudit(ctx, root, service) {
  const holder = el('div', { class: 'space-y-4' });
  root.replaceChildren(holder);
  const ui = { action: '', limit: PAGE_SIZE, offset: 0, total: 0, items: [], loading: true, error: null };
  let disposed = false;

  holder.appendChild(el('div', {}, [
    el('h2', { class: 'text-lg font-semibold tracking-tight text-slate-900 dark:text-slate-50', text: t('platform.auditTitle') }),
    el('p', { class: 'mt-0.5 text-xs text-slate-500 dark:text-slate-400', text: t('platform.auditDesc') })
  ]));

  const controls = el('div', { class: 'flex flex-wrap items-center gap-2' }, [
    el('div', { class: 'min-w-[14rem] flex-1' }, [searchInput({
      placeholder: t('platform.auditAction'),
      onInput: (value) => { ui.action = value; ui.offset = 0; load(); }
    })])
  ]);
  const bodyHolder = el('div', { class: 'space-y-3' });
  holder.append(controls, bodyHolder);

  function render() {
    if (disposed) return;
    clear(bodyHolder);
    if (ui.loading) { bodyHolder.appendChild(loader(t('common.loading'))); return; }
    if (ui.error) { bodyHolder.appendChild(errorState({ title: t('error.pageTitle'), message: ui.error, onRetry: () => load() })); return; }
    bodyHolder.appendChild(auditTable(ui.items, ctx));
    if (ui.total > ui.limit) {
      bodyHolder.appendChild(pagination({
        page: Math.floor(ui.offset / ui.limit) + 1,
        pageSize: ui.limit,
        total: ui.total,
        onPage: (page) => { ui.offset = (page - 1) * ui.limit; load(); }
      }));
    }
  }

  async function load() {
    ui.loading = true;
    render();
    try {
      const data = await service.audit({ action: ui.action, limit: ui.limit, offset: ui.offset });
      ui.items = data?.items || [];
      ui.total = data?.total || 0;
      ui.error = null;
    } catch (error) {
      ui.error = error?.message || t('error.pageMessage');
    } finally {
      ui.loading = false;
      render();
    }
  }

  load();
  return { destroy() { disposed = true; } };
}
