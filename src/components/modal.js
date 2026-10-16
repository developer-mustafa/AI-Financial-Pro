/**
 * Accessible modal dialogs.
 *
 * - Rendered into `#modal-root` so they always sit above the app shell.
 * - Dialog stack: only the top-most dialog reacts to Escape.
 * - Focus is trapped while open and restored to the trigger on close.
 * - Background scrolling is locked; reduced-motion users get no animation.
 */

import { el, icon, createFocusTrap, createScrollLock, clear, qs } from '../utils/dom.js';

const scrollLock = createScrollLock();
const stack = [];
let escapeBound = false;

const SIZES = {
  sm: 'sm:max-w-md',
  md: 'sm:max-w-xl',
  lg: 'sm:max-w-3xl',
  xl: 'sm:max-w-5xl',
  full: 'sm:max-w-[min(96rem,96vw)]'
};

function root() {
  let node = qs('#modal-root');
  if (!node) {
    node = el('div', { id: 'modal-root' });
    document.body.appendChild(node);
  }
  return node;
}

function bindEscape() {
  if (escapeBound) return;
  escapeBound = true;
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    const top = stack[stack.length - 1];
    if (!top || !top.dismissible) return;
    event.stopPropagation();
    top.close('escape');
  });
}

/**
 * @param {{
 *   title?: string, description?: string, content?: Node|Node[]|string,
 *   footer?: Node|Node[]|null, size?: 'sm'|'md'|'lg'|'xl'|'full',
 *   dismissible?: boolean, onClose?: Function, initialFocus?: HTMLElement|null
 * }} options
 */
export function openModal(options = {}) {
  const {
    title = '',
    description = '',
    content = null,
    footer = null,
    size = 'md',
    dismissible = true,
    onClose = null
  } = options;

  const id = `modal-${Math.random().toString(36).slice(2, 9)}`;
  const titleId = `${id}-title`;
  const descriptionId = `${id}-desc`;

  const body = el('div', { class: 'min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6', id: `${id}-body` });
  const header = el('div', { class: 'flex items-start gap-3 border-b border-slate-200 px-4 py-3.5 sm:px-6 dark:border-slate-800' });
  const footerWrap = el('div', { class: 'border-t border-slate-200 px-4 py-3 sm:px-6 dark:border-slate-800' });
  footerWrap.toggleAttribute('hidden', !footer);

  const closeButton = el('button', {
    type: 'button',
    class: 'btn btn-ghost btn-icon-sm shrink-0 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200',
    'aria-label': 'Close dialog',
    onclick: () => api.close('button')
  }, [icon('x', 'h-4 w-4')]);
  if (!dismissible) closeButton.toggleAttribute('hidden', true);

  header.append(
    el('div', { class: 'min-w-0 flex-1' }, [
      el('h2', { class: 'text-base font-semibold tracking-tight text-slate-900 dark:text-slate-100', id: titleId, text: title }),
      description ? el('p', { class: 'mt-0.5 text-xs text-slate-500 dark:text-slate-400', id: descriptionId, text: description }) : null
    ]),
    closeButton
  );

  const panel = el(
    'div',
    {
      class: `relative z-10 flex max-h-[92vh] w-full flex-col overflow-hidden rounded-t-2xl border border-slate-200 bg-white shadow-pop animate-scale-in sm:rounded-2xl dark:border-slate-800 dark:bg-slate-900 ${SIZES[size] || SIZES.md}`,
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': titleId,
      'aria-describedby': description ? descriptionId : null
    },
    [header, body, footerWrap]
  );

  const backdrop = el('div', {
    class: 'absolute inset-0 bg-slate-900/50 backdrop-blur-[2px] animate-fade-in',
    'data-backdrop': 'true'
  });
  if (dismissible) backdrop.addEventListener('click', () => api.close('backdrop'));

  const overlay = el(
    'div',
    { class: 'fixed inset-0 z-[60] flex items-end justify-center p-0 sm:items-center sm:p-4' },
    [backdrop, panel]
  );

  setContent(body, content);
  setContent(footerWrap, footer);

  const trap = createFocusTrap(panel);
  let closed = false;

  const api = {
    id,
    node: overlay,
    panel,
    body,
    footer: footerWrap,
    close(reason = 'api') {
      if (closed) return;
      closed = true;
      const index = stack.indexOf(api);
      if (index >= 0) stack.splice(index, 1);
      trap.deactivate();
      scrollLock.unlock();
      overlay.remove();
      onClose?.(reason);
    },
    setTitle(next) {
      const node = qs(`#${titleId}`);
      if (node) node.textContent = next;
    },
    setDescription(next) {
      const node = qs(`#${descriptionId}`);
      if (node) node.textContent = next;
    },
    setBody(next) {
      setContent(body, next);
    },
    setFooter(next) {
      footerWrap.toggleAttribute('hidden', !next);
      setContent(footerWrap, next);
    },
    get isOpen() {
      return !closed;
    }
  };

  root().appendChild(overlay);
  stack.push(api);
  bindEscape();
  scrollLock.lock();
  trap.activate();
  if (options.initialFocus instanceof HTMLElement) options.initialFocus.focus();

  return api;
}

function setContent(target, content) {
  clear(target);
  if (content === null || content === undefined) return;
  if (content instanceof Node) target.appendChild(content);
  else if (Array.isArray(content)) content.forEach((node) => node && target.appendChild(node));
  else target.appendChild(document.createTextNode(String(content)));
}

export function closeTopModal(reason = 'api') {
  stack[stack.length - 1]?.close(reason);
}

export function closeAllModals(reason = 'api') {
  while (stack.length) stack[stack.length - 1].close(reason);
}

export const hasOpenModal = () => stack.length > 0;
export const openModalCount = () => stack.length;

/** Standard footer builder: cancel on the left, primary action on the right. */
export function modalFooter({ cancelLabel = 'Cancel', onCancel, confirmLabel = 'Save', onConfirm, confirmType = 'submit', confirmVariant = 'primary', extra = null, confirmDisabled = false, busy = false } = {}) {
  const cancelBtn = el('button', {
    type: 'button',
    class: 'btn btn-secondary',
    text: cancelLabel,
    onclick: onCancel
  });
  const confirmBtn = el('button', {
    type: confirmType,
    class: `btn btn-${confirmVariant}`,
    text: confirmLabel,
    disabled: confirmDisabled,
    'data-busy': busy ? 'true' : null
  });
  if (onConfirm) confirmBtn.addEventListener('click', onConfirm);
  return el('div', { class: 'flex flex-wrap items-center justify-end gap-2' }, [
    extra,
    el('div', { class: 'flex-1' }),
    cancelBtn,
    confirmBtn
  ]);
}
