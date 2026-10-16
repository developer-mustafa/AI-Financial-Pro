/**
 * AI Assistant screen.
 *
 * Read-only AI features over the current workspace:
 *   * an advisor chat (natural-language questions, answered from a small
 *     aggregated summary the Worker computes — never raw records), and
 *   * a "Spending insights" panel (deterministic highlights + a short narrative).
 *
 * Privacy/consent model (prompt2.txt §5/§6): nothing is sent to the AI provider
 * until the user ticks the consent box; the transcript is kept in memory only
 * (never persisted), and the UI never receives the API key or raw financial rows.
 * Every figure shown as "basis" is produced server-side.
 */

import { el, icon, clear } from '../../utils/dom.js';
import { badge, emptyState, errorState, loader, sectionCard } from '../../components/ui.js';
import { t, getLanguage } from '../../i18n/index.js';

const MAX_QUESTION = 500;

const QUICK_KEYS = ['ai.quick1', 'ai.quick2', 'ai.quick3'];

function highlightText(highlight) {
  const data = highlight && highlight.data ? highlight.data : {};
  switch (highlight && highlight.code) {
    case 'noData':
      return t('ai.hl.noData');
    case 'topCategory':
      return t('ai.hl.topCategory', { name: data.name || '', share: data.sharePct ?? 0 });
    case 'saving':
      return t('ai.hl.saving', { rate: data.ratePct ?? 0 });
    case 'overspending':
      return t('ai.hl.overspending', { rate: Math.abs(data.ratePct ?? 0) });
    case 'spendUp':
      return t('ai.hl.spendUp', { pct: data.pct ?? 0 });
    case 'spendDown':
      return t('ai.hl.spendDown', { pct: data.pct ?? 0 });
    case 'budgetsTracked':
      return t('ai.hl.budgetsTracked', { count: data.count ?? 0 });
    default:
      return String((highlight && highlight.code) || '');
  }
}

/** Map an ApiError onto a localized, non-leaky message. */
function friendlyError(error) {
  const code = error && error.code;
  if (code === 'ai_not_configured') return t('ai.errNotConfigured');
  if (code === 'ai_rate_limited') return t('ai.errRateLimited');
  if (code === 'ai_quota_exceeded') return t('ai.errBusy');
  if (code === 'ai_timeout') return t('ai.errTimeout');
  return (error && error.message) || t('ai.errGeneric');
}

export function mount(container, ctx) {
  const { cloud, services } = ctx;
  const service = services?.ai;

  const root = el('div', { class: 'space-y-4' });
  container.appendChild(root);

  /* --------------------------------------------------------------- guards */

  if (!cloud?.auth?.signedIn || !service?.configured) {
    root.appendChild(errorState({ title: t('ai.signInTitle'), message: t('ai.signInMessage') }));
    return { destroy() { clear(container); } };
  }

  const state = {
    consent: false,
    busy: false,
    transcript: [], // { role: 'user'|'assistant', text, basis? , error? }
    highlights: null,
    narrative: '',
    insightsBusy: false,
    insightsError: null
  };

  const headerHolder = el('div');
  const consentHolder = el('div');
  const askHolder = el('div');
  const transcriptHolder = el('div', { class: 'space-y-2', dataset: { aiTranscript: '' } });
  const insightsHolder = el('div');
  root.append(headerHolder, consentHolder, askHolder, transcriptHolder, insightsHolder);

  /* --------------------------------------------------------------- header */

  headerHolder.appendChild(el('div', { class: 'flex flex-wrap items-start justify-between gap-3' }, [
    el('div', { class: 'min-w-0' }, [
      el('h2', { class: 'text-lg font-semibold tracking-tight text-slate-900 dark:text-slate-50', text: t('ai.title') }),
      el('p', { class: 'mt-0.5 text-xs text-slate-500 dark:text-slate-400', text: t('ai.subtitle') })
    ]),
    badge(t('ai.badgeExperimental'), 'warning', { iconName: 'sparkles' })
  ]));

  /* -------------------------------------------------------------- consent */

  const consentBox = el('input', {
    type: 'checkbox',
    class: 'mt-0.5 h-4 w-4 shrink-0 rounded border-slate-300 text-brand-600 focus:ring-brand-500',
    'aria-label': t('ai.consentLabel'),
    dataset: { aiConsent: '' }
  });
  consentBox.addEventListener('change', () => {
    state.consent = consentBox.checked;
    updateAskState();
  });

  consentHolder.appendChild(el('div', { class: 'card-pad flex items-start gap-3' }, [
    consentBox,
    el('label', { class: 'min-w-0 cursor-pointer select-none', onclick: () => { consentBox.checked = !consentBox.checked; consentBox.dispatchEvent(new Event('change')); } }, [
      el('span', { class: 'block text-sm font-medium text-slate-800 dark:text-slate-100', text: t('ai.consentLabel') }),
      el('span', { class: 'mt-0.5 block text-xs leading-snug text-slate-500 dark:text-slate-400', text: t('ai.consentHint') })
    ])
  ]));

  /* ------------------------------------------------------------------ ask */

  const input = el('textarea', {
    class: 'textarea w-full',
    rows: 2,
    placeholder: t('ai.placeholder'),
    'aria-label': t('ai.placeholder'),
    dataset: { aiInput: '' }
  });
  input.maxLength = MAX_QUESTION;

  const askButton = el('button', { type: 'button', class: 'btn btn-primary', dataset: { aiAsk: '' } }, [
    icon('sparkles', 'h-4 w-4'),
    el('span', { text: t('ai.ask') })
  ]);
  const insightsButton = el('button', { type: 'button', class: 'btn btn-secondary', dataset: { aiInsights: '' } }, [
    icon('chart-column', 'h-4 w-4'),
    el('span', { text: t('ai.quickInsights') })
  ]);

  const quickRow = el('div', { class: 'flex flex-wrap gap-1.5' },
    QUICK_KEYS.map((key) => {
      const chip = el('button', { type: 'button', class: 'chip' }, [el('span', { text: t(key) })]);
      chip.addEventListener('click', () => { input.value = t(key); ask(t(key)); });
      return chip;
    }));

  askButton.addEventListener('click', () => ask(input.value));
  insightsButton.addEventListener('click', () => loadInsights());
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      ask(input.value);
    }
  });

  askHolder.appendChild(sectionCard({
    title: t('ai.askTitle'),
    description: t('ai.askHint'),
    body: el('div', { class: 'space-y-2' }, [
      input,
      quickRow,
      el('div', { class: 'flex flex-wrap items-center gap-2' }, [askButton, insightsButton])
    ])
  }));

  function updateAskState() {
    const disabled = !state.consent || state.busy;
    askButton.disabled = disabled;
    insightsButton.disabled = !state.consent || state.insightsBusy;
    askButton.classList.toggle('opacity-50', disabled);
    insightsButton.classList.toggle('opacity-50', !state.consent || state.insightsBusy);
  }

  /* ------------------------------------------------------------ transcript */

  function renderTranscript() {
    clear(transcriptHolder);
    if (state.transcript.length === 0) return;
    for (const entry of state.transcript) {
      transcriptHolder.appendChild(renderMessage(entry));
    }
  }

  function renderMessage(entry) {
    const isUser = entry.role === 'user';
    const bubble = el('div', { class: `card-pad ${isUser ? 'bg-slate-50 dark:bg-slate-800/60' : ''}` }, [
      badge(isUser ? t('ai.you') : t('ai.assistant'), isUser ? 'neutral' : 'brand', { iconName: isUser ? 'user' : 'sparkles' }),
      el('p', {
        class: `mt-2 whitespace-pre-wrap text-sm leading-relaxed ${entry.error ? 'text-rose-600 dark:text-rose-400' : 'text-slate-700 dark:text-slate-200'}`,
        text: entry.text
      })
    ]);
    if (entry.basis) {
      bubble.appendChild(el('p', {
        class: 'mt-2 text-[11px] text-slate-400 dark:text-slate-500',
        text: t('ai.basis', { count: entry.basis.transactionCount ?? 0, months: entry.basis.monthsCovered ?? 0 })
      }));
    }
    return bubble;
  }

  /* ---------------------------------------------------------------- actions */

  async function ask(rawQuestion) {
    const question = String(rawQuestion || '').trim();
    if (!state.consent || state.busy) return;
    if (!question) return;

    state.transcript.push({ role: 'user', text: question });
    input.value = '';
    renderTranscript();

    state.busy = true;
    updateAskState();
    const pending = el('div', { class: 'card-pad text-sm text-slate-500 dark:text-slate-400', text: t('ai.thinking') });
    transcriptHolder.appendChild(pending);

    try {
      const data = await service.advisor(question, { language: getLanguage(), consent: true });
      state.transcript.push({ role: 'assistant', text: data.answer, basis: data.basis });
    } catch (error) {
      state.transcript.push({ role: 'assistant', text: friendlyError(error), error: true });
    } finally {
      state.busy = false;
      updateAskState();
      renderTranscript();
    }
  }

  async function loadInsights() {
    if (!state.consent || state.insightsBusy) return;
    state.insightsBusy = true;
    state.insightsError = null;
    updateAskState();
    renderInsights();
    try {
      const data = await service.insights({ language: getLanguage(), consent: true });
      state.highlights = Array.isArray(data.highlights) ? data.highlights : [];
      state.narrative = data.narrative || '';
    } catch (error) {
      state.insightsError = friendlyError(error);
      state.highlights = null;
      state.narrative = '';
    } finally {
      state.insightsBusy = false;
      updateAskState();
      renderInsights();
    }
  }

  function renderInsights() {
    clear(insightsHolder);

    if (state.insightsBusy) {
      insightsHolder.appendChild(loader(t('ai.thinking')));
      return;
    }
    if (state.insightsError) {
      insightsHolder.appendChild(errorState({ title: t('ai.insightsTitle'), message: state.insightsError, onRetry: () => loadInsights() }));
      return;
    }
    if (!state.highlights) return;

    const body = el('div', { class: 'space-y-2' });
    if (state.highlights.length === 0) {
      body.appendChild(emptyState({ iconName: 'chart-column', title: t('ai.hl.noData'), compact: true }));
    } else {
      for (const highlight of state.highlights) {
        body.appendChild(el('div', { class: 'flex items-start gap-2 text-sm text-slate-700 dark:text-slate-200' }, [
          icon('sparkles', 'mt-0.5 h-4 w-4 shrink-0 text-brand-600 dark:text-brand-300'),
          el('span', { text: highlightText(highlight) })
        ]));
      }
    }
    if (state.narrative) {
      body.appendChild(el('p', { class: 'mt-2 whitespace-pre-wrap border-t border-slate-200 pt-2 text-sm leading-relaxed text-slate-600 dark:border-slate-700 dark:text-slate-300', text: state.narrative }));
    }

    insightsHolder.appendChild(sectionCard({ title: t('ai.insightsTitle'), body }));
  }

  /* ------------------------------------------------------------- initial */

  renderTranscript();
  updateAskState();

  return {
    destroy() {
      clear(container);
    }
  };
}
