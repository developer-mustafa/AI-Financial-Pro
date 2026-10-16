/**
 * Workspace screen (tenant administration).
 *
 * Lets a TENANT_ADMIN rename their workspace and manage its members. Visible
 * only to workspace administrators; the Worker independently refuses the API for
 * everyone else, so this screen is convenience, not enforcement. It never shows
 * another workspace's data — the current workspace comes from the resolved
 * tenant context (`X-Tenant-Id`).
 */

import { el, icon, clear } from '../../utils/dom.js';
import { badge, dataTable, emptyState, errorState, loader, sectionCard, selectField, textField } from '../../components/ui.js';
import { openModal } from '../../components/modal.js';
import { confirmDialog } from '../../components/confirmDialog.js';
import { t } from '../../i18n/index.js';

function toIso(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function formatDate(value, locale) {
  const iso = toIso(value);
  if (!iso) return '—';
  try {
    return new Intl.DateTimeFormat(locale || 'en-US', { dateStyle: 'medium' }).format(new Date(iso));
  } catch {
    return iso.slice(0, 10);
  }
}

export function mount(container, ctx) {
  const { cloud, toast, services, store } = ctx;
  const auth = cloud?.auth;
  const tenants = cloud?.tenants;
  const service = services?.workspace;
  const locale = store?.preferences?.locale || 'en-US';

  const root = el('div', { class: 'space-y-4' });
  container.appendChild(root);

  /* --------------------------------------------------------------- guards */

  if (!cloud?.auth?.signedIn || !service?.configured) {
    root.appendChild(errorState({
      title: t('ws.accessTitle'),
      message: t('ws.signInRequired')
    }));
    return { destroy() { clear(container); } };
  }

  if (!tenants?.isTenantAdmin) {
    root.appendChild(errorState({
      title: t('ws.accessTitle'),
      message: t('ws.accessMessage')
    }));
    return { destroy() { clear(container); } };
  }

  const state = { loading: true, error: null, tenant: null, members: [], audit: [] };
  let disposed = false;

  const headerHolder = el('div');
  const profileHolder = el('div');
  const membersHolder = el('div');
  const auditHolder = el('div');
  root.append(headerHolder, profileHolder, membersHolder, auditHolder);

  function render() {
    if (disposed) return;
    clear(headerHolder);
    clear(profileHolder);
    clear(membersHolder);
    clear(auditHolder);

    if (state.loading) {
      root.replaceChildren(loader(t('common.loading')));
      return;
    }
    root.replaceChildren(headerHolder, profileHolder, membersHolder, auditHolder);

    if (state.error) {
      root.replaceChildren(errorState({ title: t('error.pageTitle'), message: state.error, onRetry: () => load() }));
      return;
    }

    const tenant = state.tenant || {};
    const isPersonal = Boolean(tenant.isPersonal);

    headerHolder.appendChild(el('div', { class: 'flex flex-wrap items-start justify-between gap-3' }, [
      el('div', { class: 'min-w-0' }, [
        el('h2', { class: 'truncate text-lg font-semibold tracking-tight text-slate-900 dark:text-slate-50', text: tenant.name || t('ws.title') }),
        el('p', { class: 'mt-0.5 text-xs text-slate-500 dark:text-slate-400', text: t('ws.subtitle') })
      ]),
      el('div', { class: 'flex items-center gap-1.5' }, [
        badge(isPersonal ? t('ws.personalBadge') : t('ws.organizationBadge'), isPersonal ? 'neutral' : 'brand'),
        badge(
          tenant.status === 'suspended' ? t('ws.suspendedBadge') : tenant.status === 'archived' ? t('ws.archivedBadge') : t('ws.activeBadge'),
          tenant.status === 'active' ? 'income' : 'warning'
        )
      ])
    ]));

    if (isPersonal) {
      profileHolder.appendChild(el('div', { class: 'card p-4 text-sm text-slate-500 dark:text-slate-400', text: t('ws.personalNote') }));
    } else {
      const name = textField({ label: t('ws.nameLabel'), name: 'ws-name', value: tenant.name || '', maxlength: 120 });
      const slug = textField({ label: t('ws.slugLabel'), name: 'ws-slug', value: tenant.slug || '', hint: t('ws.slugHint'), maxlength: 61 });
      const save = el('button', { type: 'button', class: 'btn btn-primary' }, [icon('save', 'h-4 w-4'), el('span', { text: t('common.save') })]);
      save.addEventListener('click', async () => {
        name.clearError();
        slug.clearError();
        const payload = {};
        if (name.input.value.trim() !== (tenant.name || '')) payload.name = name.input.value.trim();
        if ((slug.input.value.trim() || '') !== (tenant.slug || '')) payload.slug = slug.input.value.trim();
        if (Object.keys(payload).length === 0) return;
        save.disabled = true;
        try {
          const result = await service.update(payload);
          state.tenant = { ...state.tenant, ...(result?.tenant || {}) };
          toast.success(t('ws.title'), t('ws.saved'));
          await tenants.load().catch(() => {});
          render();
        } catch (error) {
          if (error?.details?.name) name.setError(error.details.name);
          if (error?.details?.slug) slug.setError(error.details.slug);
          toast.fromError?.(error, t('error.pageMessage'));
          save.disabled = false;
        }
      });
      profileHolder.appendChild(sectionCard({
        title: t('ws.profileTitle'),
        description: t('ws.profileDesc'),
        body: el('div', { class: 'space-y-3' }, [name.field, slug.field]),
        footer: el('div', { class: 'flex justify-end' }, [save])
      }));
    }

    /* ------------------------------------------------------------- members */
    const rows = state.members.map((member) => ({ ...member }));
    const addButton = el('button', { type: 'button', class: 'btn btn-primary btn-sm' }, [icon('user-plus', 'h-4 w-4'), el('span', { text: t('ws.addMember') })]);
    addButton.disabled = isPersonal;
    addButton.addEventListener('click', () => openAddMember());

    membersHolder.appendChild(sectionCard({
      title: t('ws.membersTitle'),
      description: isPersonal ? t('ws.personalNote') : t('ws.membersDesc'),
      actions: isPersonal ? null : addButton,
      body: dataTable({
        columns: [
          { key: 'email', label: t('ws.emailColumn'), render: (row) => row.email || '—' },
          { key: 'name', label: t('ws.nameColumn'), render: (row) => row.name || '—' },
          {
            key: 'role',
            label: t('common.role'),
            render: (row) => badge(
              row.role === 'TENANT_ADMIN' ? t('ws.roleAdmin') : t('ws.roleMember'),
              row.role === 'TENANT_ADMIN' ? 'brand' : 'neutral'
            )
          },
          {
            key: 'status',
            label: t('common.status'),
            render: (row) => badge(row.status === 'active' ? t('ws.activeBadge') : t('ws.suspendedBadge'), row.status === 'active' ? 'income' : 'warning')
          },
          { key: 'createdAt', label: t('ws.joinedColumn'), render: (row) => formatDate(row.createdAt, locale) },
          {
            key: 'actions',
            label: t('common.actions'),
            align: 'right',
            render: (row) => isPersonal ? el('span', { class: 'text-xs text-slate-400', text: '—' }) : memberActions(row)
          }
        ],
        rows,
        rowKey: (row) => row.userId || row.email,
        empty: emptyState({ title: t('ws.noMembers'), compact: true })
      })
    }));

    /* --------------------------------------------------------------- audit */
    const auditRows = state.audit.map((entry) => ({ ...entry }));
    auditHolder.appendChild(sectionCard({
      title: t('ws.auditTitle'),
      description: t('ws.auditDesc'),
      body: dataTable({
        columns: [
          { key: 'createdAt', label: t('platform.auditWhen'), render: (row) => formatDate(row.createdAt, locale) },
          { key: 'actorEmail', label: t('platform.auditActor'), render: (row) => row.actorEmail || t('platform.common.unknown') },
          { key: 'action', label: t('platform.auditAction') },
          { key: 'targetId', label: t('platform.auditDetail'), render: (row) => row.targetId || '—' }
        ],
        rows: auditRows,
        rowKey: (row) => row.id,
        empty: emptyState({ title: t('ws.noAudit'), compact: true })
      })
    }));
  }

  function memberActions(row) {
    const wrap = el('div', { class: 'flex items-center justify-end gap-1' });
    const isSelf = row.userId && tenants?.currentId && row.userId === auth?.user?.id;

    const toggle = el('button', { type: 'button', class: 'btn btn-ghost btn-sm', title: row.role === 'TENANT_ADMIN' ? t('ws.makeMember') : t('ws.makeAdmin') }, [
      icon(row.role === 'TENANT_ADMIN' ? 'shield-minus' : 'shield-check', 'h-3.5 w-3.5')
    ]);
    toggle.disabled = Boolean(isSelf && row.role === 'TENANT_ADMIN');
    toggle.addEventListener('click', () => changeRole(row, row.role === 'TENANT_ADMIN' ? 'TENANT_MEMBER' : 'TENANT_ADMIN'));

    const remove = el('button', { type: 'button', class: 'btn btn-ghost btn-sm text-expense-600 dark:text-expense-400', title: t('ws.removeMember') }, [
      icon('user-minus', 'h-3.5 w-3.5')
    ]);
    remove.disabled = Boolean(isSelf);
    remove.addEventListener('click', () => removeMember(row));

    wrap.append(toggle, remove);
    return wrap;
  }

  async function changeRole(row, role) {
    try {
      await service.updateMember(row.userId, { role });
      toast.success(t('ws.membersTitle'), t('ws.roleChanged'));
      await load({ quiet: true });
    } catch (error) {
      toast.fromError?.(error, t('error.pageMessage'));
    }
  }

  async function removeMember(row) {
    const ok = await confirmDialog({
      title: t('ws.removeMemberTitle'),
      message: t('ws.removeMemberMessage'),
      confirmLabel: t('ws.removeMember')
    });
    if (!ok) return;
    try {
      await service.removeMember(row.userId);
      toast.success(t('ws.membersTitle'), t('ws.removed'));
      await load({ quiet: true });
    } catch (error) {
      toast.fromError?.(error, t('error.pageMessage'));
    }
  }

  function openAddMember() {
    const email = textField({ label: t('ws.memberEmailLabel'), name: 'member-email', type: 'email', hint: t('ws.memberEmailHint'), required: true });
    const role = selectField({
      label: t('common.role'),
      name: 'member-role',
      value: 'TENANT_MEMBER',
      options: [
        { value: 'TENANT_MEMBER', label: t('ws.roleMember') },
        { value: 'TENANT_ADMIN', label: t('ws.roleAdmin') }
      ]
    });

    const form = el('div', { class: 'space-y-3' }, [email.field, role.field]);
    const submit = el('button', { type: 'button', class: 'btn btn-primary' }, [el('span', { text: t('common.add') })]);

    const modal = openModal({
      title: t('ws.addMemberTitle'),
      size: 'sm',
      content: form,
      footer: el('div', { class: 'flex justify-end gap-2' }, [
        el('button', { type: 'button', class: 'btn btn-secondary', text: t('common.cancel'), onclick: () => modal.close('cancel') }),
        submit
      ])
    });

    submit.addEventListener('click', async () => {
      email.clearError();
      const value = email.input.value.trim();
      if (!value) {
        email.setError(t('common.required'));
        return;
      }
      submit.disabled = true;
      try {
        await service.addMember({ email: value, role: role.input.value });
        modal.close('added');
        toast.success(t('ws.membersTitle'), t('ws.added'));
        await load({ quiet: true });
      } catch (error) {
        if (error?.code === 'user_not_found') email.setError(t('ws.memberEmailHint'));
        else if (error?.code === 'already_member') email.setError(t('ws.memberExists'));
        else toast.fromError?.(error, t('error.pageMessage'));
        submit.disabled = false;
      }
    });
  }

  async function load({ quiet = false } = {}) {
    if (!quiet) {
      state.loading = true;
      render();
    }
    try {
      const [profile, members, audit] = await Promise.all([
        service.current(),
        service.members(),
        service.audit({ limit: 25 })
      ]);
      state.tenant = profile?.tenant || tenants?.current || null;
      state.members = members?.items || [];
      state.audit = audit?.items || [];
      state.error = null;
    } catch (error) {
      state.error = error?.message || t('error.pageMessage');
    } finally {
      state.loading = false;
      render();
    }
  }

  load();

  const off = tenants?.subscribe?.(() => { load(); }) || (() => {});

  return {
    destroy() {
      disposed = true;
      off();
      clear(container);
    }
  };
}
