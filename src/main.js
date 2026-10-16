/**
 * Browser entry point.
 *
 * Loads last (after runtime-config.js and the vendored lucide bundle) and hands
 * control to the composition root in `app.js`. Any failure during start-up is
 * surfaced as a readable message instead of a blank screen.
 */

import { startApp } from './app.js';

/** Replaces the shell with a plain, dependency-free error panel. */
function showFatal(error) {
  const message = error?.message && error.message !== 'undefined' ? error.message : 'An unexpected error occurred.';
  console.error('[SpendWise] failed to start', error);

  const main = document.querySelector('[data-main]');
  const host = main || document.body;
  while (host.firstChild) host.removeChild(host.firstChild);

  const panel = document.createElement('div');
  panel.className = 'mx-auto mt-10 max-w-lg rounded-2xl border border-expense-200 bg-white p-6 text-center dark:border-expense-500/30 dark:bg-slate-900';

  const heading = document.createElement('h1');
  heading.className = 'text-lg font-semibold text-slate-900 dark:text-slate-50';
  heading.textContent = 'SpendWise could not start';

  const detail = document.createElement('p');
  detail.className = 'mt-2 text-sm text-slate-600 dark:text-slate-300';
  detail.textContent = message;

  const hint = document.createElement('p');
  hint.className = 'mt-3 text-xs text-slate-400 dark:text-slate-500';
  hint.textContent = 'If you opened this file directly, serve the folder over HTTP instead (npm run dev).';

  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'btn btn-primary mt-4';
  retry.textContent = 'Reload';
  retry.addEventListener('click', () => window.location.reload());

  panel.append(heading, detail, hint, retry);
  host.appendChild(panel);
}

async function boot() {
  try {
    await startApp({ mountPoint: document });
  } catch (error) {
    showFatal(error);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
