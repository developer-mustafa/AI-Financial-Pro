/**
 * Module lifecycle management.
 *
 * Every screen is a module that mounts into the main content container and
 * returns a dispose handle. The host guarantees that the previous module is
 * fully torn down (timer, listener, subscription, chart) before the next one
 * mounts, which is what keeps the SPA free of duplicated event handlers.
 */

export function createDisposables() {
  const callbacks = new Set();
  return {
    add(fn) {
      if (typeof fn === 'function') callbacks.add(fn);
      return fn;
    },
    use(disposable) {
      if (typeof disposable === 'function') callbacks.add(disposable);
      return disposable;
    },
    dispose() {
      for (const callback of [...callbacks].reverse()) {
        try {
          callback();
        } catch (error) {
          console.error('[lifecycle] dispose failed', error);
        }
      }
      callbacks.clear();
    },
    get size() {
      return callbacks.size;
    }
  };
}

/**
 * @param {{container: HTMLElement, onError?: (error:Error, moduleId:string)=>void, onMount?: Function, onUnmount?: Function}} options
 */
export function createModuleHost({ container, onError, onMount, onUnmount } = {}) {
  let active = null;

  async function unmount() {
    if (!active) return;
    const current = active;
    active = null;
    try {
      await current.result?.destroy?.();
    } catch (error) {
      console.error(`[lifecycle] "${current.moduleId}" failed to destroy cleanly`, error);
    }
    current.disposables.dispose();
    onUnmount?.(current.moduleId);
  }

  return {
    /**
     * @param {string} moduleId
     * @param {(container: HTMLElement, disposables: object, context: object) => any} factory
     */
    async mount(moduleId, factory, context = {}) {
      await unmount();
      const disposables = createDisposables();
      onMount?.(moduleId);
      try {
        const result = await factory(container, disposables, context);
        active = { moduleId, disposables, result };
      } catch (error) {
        active = { moduleId, disposables, result: null };
        onError?.(error, moduleId);
      }
      return active?.result ?? null;
    },
    unmount,
    get activeId() {
      return active?.moduleId ?? null;
    },
    get mounted() {
      return Boolean(active);
    }
  };
}

/** Runs `fn` when the document becomes visible again (used by cloud sync). */
export function onDocumentVisible(fn, disposables) {
  const handler = () => {
    if (document.visibilityState === 'visible') fn();
  };
  document.addEventListener('visibilitychange', handler);
  disposables?.add(() => document.removeEventListener('visibilitychange', handler));
  return handler;
}

/** Runs `fn` before the tab unloads (used to flush pending writes). */
export function onBeforeUnload(fn, disposables) {
  const handler = (event) => {
    const shouldBlock = fn(event);
    if (shouldBlock) {
      event.preventDefault();
      event.returnValue = '';
      return '';
    }
    return undefined;
  };
  window.addEventListener('beforeunload', handler);
  disposables?.add(() => window.removeEventListener('beforeunload', handler));
  return handler;
}
