/**
 * AI feature tests.
 *
 * Covers the client service façade (payload shape + consent), the navigation
 * wiring, and the AI view's consent gate and chat flow. The service is faked, so
 * no network is touched.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createAiService } from '../src/services/aiService.js';
import { NAV_ITEMS, ROUTE_TITLES, findNavItem } from '../src/config/navigation.js';
import { t, setLanguage } from '../src/i18n/index.js';
import { mount as mountAi } from '../src/modules/ai/aiView.js';

/** Records calls and returns a canned response. */
function fakeClient() {
  const calls = [];
  return {
    calls,
    configured: true,
    async post(path, body) {
      calls.push({ path, body });
      if (path.endsWith('/insights')) {
        return {
          highlights: [{ code: 'topCategory', tone: 'brand', data: { name: 'Food', sharePct: 40 } }],
          narrative: 'Watch food spend.',
          basis: { transactionCount: 5, monthsCovered: 2 }
        };
      }
      return { answer: 'Save more by cooking at home.', basis: { transactionCount: 5, monthsCovered: 2 }, model: 'gemini-2.5-flash' };
    }
  };
}

const wait = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (predicate, { timeout = 1000, step = 10 } = {}) => {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (predicate()) return true;
    await wait(step);
  }
  return Boolean(predicate());
};

describe('createAiService', () => {
  it('reports not-configured without a usable client', () => {
    expect(createAiService({}).configured).toBe(false);
    expect(createAiService({ client: { configured: false } }).configured).toBe(false);
    expect(createAiService({ client: { configured: true } }).configured).toBe(true);
  });

  it('posts advisor questions with explicit consent and language', async () => {
    const client = fakeClient();
    const service = createAiService({ client });

    const result = await service.advisor('How can I save?', { language: 'bn', consent: true });
    expect(result.answer).toMatch(/cook/i);
    expect(client.calls[0]).toEqual({
      path: '/api/ai/advisor',
      body: { question: 'How can I save?', language: 'bn', consent: true }
    });
  });

  it('omits periodMonths unless provided, and posts insights', async () => {
    const client = fakeClient();
    const service = createAiService({ client });

    await service.advisor('q', { consent: true });
    expect(client.calls[0].body).not.toHaveProperty('periodMonths');

    await service.advisor('q', { consent: true, periodMonths: 3 });
    expect(client.calls[1].body.periodMonths).toBe(3);

    const insights = await service.insights({ consent: true });
    expect(client.calls[2].path).toBe('/api/ai/insights');
    expect(client.calls[2].body).toEqual({ language: 'en', consent: true });
    expect(insights.highlights).toHaveLength(1);
  });
});

describe('AI navigation wiring', () => {
  afterEach(() => setLanguage('en'));

  it('exposes an AI destination in the insights section', () => {
    const item = NAV_ITEMS.find((entry) => entry.id === 'ai');
    expect(item).toBeTruthy();
    expect(item.path).toBe('/ai');
    expect(findNavItem('/ai')).toBe(item);
  });

  it('has a route title and localized labels in both languages', () => {
    expect(ROUTE_TITLES.ai).toBe('AI Assistant');
    expect(t('nav.ai')).toBe('AI Assistant');
    expect(t('ai.title')).toBe('AI Assistant');

    setLanguage('bn');
    expect(t('nav.ai')).toBe('এআই সহকারী');
    expect(t('ai.title')).toBe('এআই সহকারী');
  });
});

describe('AI view', () => {
  let container;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  const signedInCtx = (service) => ({ cloud: { auth: { signedIn: true } }, services: { ai: service } });
  const transcript = () => container.querySelector('[data-ai-transcript]');

  it('requires a signed-in cloud session', () => {
    mountAi(container, { cloud: { auth: { signedIn: false } }, services: { ai: createAiService({}) } });
    expect(container.textContent).toContain(t('ai.signInTitle'));
  });

  it('gates the ask action behind explicit consent', async () => {
    const client = fakeClient();
    mountAi(container, signedInCtx(createAiService({ client })));

    const consent = container.querySelector('[data-ai-consent]');
    const ask = container.querySelector('[data-ai-ask]');
    expect(consent).toBeTruthy();
    expect(ask.disabled).toBe(true);

    // Without consent, asking must not contact the service.
    container.querySelector('[data-ai-input]').value = 'How can I save?';
    ask.click();
    await wait();
    expect(client.calls).toHaveLength(0);
    expect(transcript().childNodes.length).toBe(0);

    consent.checked = true;
    consent.dispatchEvent(new Event('change'));
    expect(ask.disabled).toBe(false);
  });

  it('renders the answer and basis after asking', async () => {
    const client = fakeClient();
    mountAi(container, signedInCtx(createAiService({ client })));

    const consent = container.querySelector('[data-ai-consent]');
    consent.checked = true;
    consent.dispatchEvent(new Event('change'));

    container.querySelector('[data-ai-input]').value = 'How can I save?';
    container.querySelector('[data-ai-ask]').click();

    await waitFor(() => transcript().textContent.includes('Save more'));
    const text = transcript().textContent;
    expect(text).toContain('How can I save?');
    expect(text).toContain('Save more by cooking at home.');
    expect(text).toContain('Based on 5'); // basis caption
    expect(client.calls[0].path).toBe('/api/ai/advisor');
    expect(client.calls[0].body.consent).toBe(true);
  });
});
