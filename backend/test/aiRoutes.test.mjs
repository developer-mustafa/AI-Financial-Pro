// test/aiRoutes.test.mjs
// Request-validation, tenant-scoping, prompt-safety and quota tests for the AI
// routes. The Gemini HTTP call is faked by overriding globalThis.fetch, so the
// suite never touches the network.

import test from 'node:test';
import assert from 'node:assert/strict';

import { HttpError } from '../src/http.js';
import {
  advisor,
  insights,
  validateAiRequest,
  renderContext,
  buildAdvisorPrompt,
  buildInsightsPrompt,
  resetAiRateStore,
} from '../src/routes/ai.js';
import { buildFinancialContext } from '../src/aiInsights.js';

const ENV = {
  AUTH_SECRET: 'test-secret-that-is-definitely-long-enough-1234567890',
  GEMINI_API_KEY: 'test-key-123',
  GEMINI_MODEL: 'gemini-2.5-flash',
};

function isHttpErrorWith(status, code) {
  return (e) => {
    assert.ok(e instanceof HttpError, `expected HttpError, got ${e && e.constructor && e.constructor.name}`);
    assert.equal(e.status, status);
    if (code) assert.equal(e.code, code);
    return true;
  };
}

function makeDb() {
  const calls = [];
  return {
    calls,
    async query(text, params = []) {
      calls.push({ text, params });
      if (/FROM transactions/.test(text)) {
        return [
          { amount_minor: 100000, currency: 'BDT', type: 'income', category_id: 'c-salary', date: '2026-10-01', status: 'posted' },
          { amount_minor: 60000, currency: 'BDT', type: 'expense', category_id: 'c-food', date: '2026-10-02', status: 'posted' },
        ];
      }
      if (/FROM categories/.test(text)) return [{ id: 'c-food', name: 'Food', type: 'expense' }];
      if (/FROM budgets/.test(text)) return [{ id: 'b1' }];
      return [];
    },
  };
}

function fakeGemini(text = 'Spend less on food and you will save more.') {
  const captured = {};
  const fn = async (url, options) => {
    captured.url = url;
    captured.headers = options.headers;
    captured.body = options.body;
    return {
      status: 200,
      ok: true,
      async json() {
        return {
          candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 34, totalTokenCount: 46 },
        };
      },
    };
  };
  fn.captured = captured;
  return fn;
}

function makeCtx({ body, env = ENV, db = makeDb(), userId = 'u1', tenantId = 't1', path = '/api/ai/advisor' }) {
  return {
    env,
    db,
    userId,
    tenantId,
    request: new Request(`https://api.example${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  };
}

async function withFakeFetch(impl, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

// ---------------------------------------------------------------------------
// validateAiRequest
// ---------------------------------------------------------------------------

test('validateAiRequest: explicit consent is mandatory', () => {
  assert.throws(() => validateAiRequest({}), isHttpErrorWith(400, 'consent_required'));
  assert.throws(() => validateAiRequest({ consent: false }), isHttpErrorWith(400, 'consent_required'));
  assert.throws(() => validateAiRequest({ consent: 'yes' }), isHttpErrorWith(400, 'consent_required'));
  assert.doesNotThrow(() => validateAiRequest({ consent: true }));
});

test('validateAiRequest: the advisor requires a bounded question', () => {
  assert.throws(() => validateAiRequest({ consent: true }, { requireQuestion: true }), isHttpErrorWith(400, 'validation_error'));
  assert.throws(() => validateAiRequest({ consent: true, question: '   ' }, { requireQuestion: true }), isHttpErrorWith(400));
  assert.throws(
    () => validateAiRequest({ consent: true, question: 'x'.repeat(501) }, { requireQuestion: true }),
    isHttpErrorWith(400, 'validation_error'),
  );
  const ok = validateAiRequest({ consent: true, question: '  How am I doing?  ' }, { requireQuestion: true });
  assert.equal(ok.question, 'How am I doing?');
});

test('validateAiRequest: language is whitelisted and periodMonths is clamped', () => {
  assert.equal(validateAiRequest({ consent: true }).language, 'en');
  assert.equal(validateAiRequest({ consent: true, language: 'bn' }).language, 'bn');
  assert.equal(validateAiRequest({ consent: true, language: 'fr' }).language, 'en');
  assert.equal(validateAiRequest({ consent: true, periodMonths: 999 }).periodMonths, 6);
  assert.equal(validateAiRequest({ consent: true, periodMonths: 0 }).periodMonths, 1);
  assert.equal(validateAiRequest({ consent: true, periodMonths: 3 }).periodMonths, 3);
  assert.equal(validateAiRequest({ consent: true, periodMonths: 'x' }).periodMonths, 6);
});

// ---------------------------------------------------------------------------
// prompts
// ---------------------------------------------------------------------------

test('renderContext/buildAdvisorPrompt: include computed figures and no PII', () => {
  const context = buildFinancialContext({
    transactions: [
      { amount_minor: 100000, currency: 'BDT', type: 'income', category_id: 'c-salary', date: '2026-10-01', status: 'posted' },
      { amount_minor: 60000, currency: 'BDT', type: 'expense', category_id: 'c-food', date: '2026-10-02', status: 'posted' },
    ],
    categories: [{ id: 'c-food', name: 'Food', type: 'expense' }],
  });
  const rendered = renderContext(context, 'en');
  assert.match(rendered, /income 1000\.00/);
  assert.match(rendered, /expenses 600\.00/);
  assert.match(rendered, /Food 600\.00 \(100%\)/);
  assert.ok(!rendered.includes('@'), 'aggregate must not contain an email address');

  const prompt = buildAdvisorPrompt(context, 'How can I save?', 'bn');
  assert.match(prompt, /How can I save\?/);
  assert.match(prompt, /Bangla/);
  assert.ok(!prompt.includes('@'));

  assert.match(buildInsightsPrompt(context, 'en'), /suggestion/i);
});

// ---------------------------------------------------------------------------
// handler behaviour
// ---------------------------------------------------------------------------

test('advisor: fails closed when Gemini is not configured', async () => {
  resetAiRateStore();
  await assert.rejects(
    () => advisor(makeCtx({ body: { question: 'hi', consent: true }, env: { AUTH_SECRET: 'x'.repeat(40) } })),
    isHttpErrorWith(500, 'ai_not_configured'),
  );
});

test('advisor: consent is required before any provider call', async () => {
  resetAiRateStore();
  let called = false;
  await withFakeFetch(async (...args) => {
    called = true;
    return fakeGemini()(...args);
  }, async () => {
    await assert.rejects(
      () => advisor(makeCtx({ body: { question: 'hi' } })),
      isHttpErrorWith(400, 'consent_required'),
    );
  });
  assert.equal(called, false, 'the provider must not be contacted without consent');
});

test('advisor: success returns an answer + basis, scoped to the caller tenant', async () => {
  resetAiRateStore();
  const db = makeDb();
  const fetchImpl = fakeGemini('Cook at home twice a week to cut food spend.');

  const data = await withFakeFetch(fetchImpl, async () => {
    const res = await advisor(makeCtx({ body: { question: 'How can I save on food?', consent: true }, db }));
    assert.equal(res.status, 200);
    return res.json();
  });

  assert.equal(data.answer, 'Cook at home twice a week to cut food spend.');
  assert.equal(data.basis.currency, 'BDT');
  assert.equal(data.basis.transactionCount, 2);
  assert.equal(data.model, 'gemini-2.5-flash');
  assert.ok(data.generatedAt);

  // Every DB query must be tenant-scoped with the verified tenant id.
  assert.ok(db.calls.length >= 3);
  for (const call of db.calls) {
    assert.ok(call.text.includes('tenant_id = $1'), `query not tenant-scoped: ${call.text}`);
    assert.equal(call.params[0], 't1');
  }

  // The prompt sent upstream carries only the aggregate — never an email.
  assert.ok(!fetchImpl.captured.body.includes('@'));
  assert.ok(fetchImpl.captured.headers['x-goog-api-key'] === 'test-key-123');
});

test('insights: returns deterministic highlights plus a narrative', async () => {
  resetAiRateStore();
  const data = await withFakeFetch(fakeGemini('Food is your biggest category.'), async () => {
    const res = await insights(makeCtx({ body: { consent: true, language: 'en' }, path: '/api/ai/insights' }));
    return res.json();
  });

  assert.ok(Array.isArray(data.highlights));
  assert.ok(data.highlights.some((h) => h.code === 'topCategory'));
  assert.equal(data.narrative, 'Food is your biggest category.');
  assert.ok(data.basis);
});

test('advisor: per-user quota returns 429 after the limit is reached', async () => {
  resetAiRateStore();
  const env = ENV;
  await withFakeFetch(fakeGemini(), async () => {
    for (let i = 0; i < 20; i += 1) {
      const res = await advisor(makeCtx({ body: { question: `q${i}`, consent: true }, env }));
      assert.equal(res.status, 200, `request ${i + 1} should succeed`);
    }
    await assert.rejects(
      () => advisor(makeCtx({ body: { question: 'one too many', consent: true }, env })),
      isHttpErrorWith(429, 'ai_rate_limited'),
    );
  });
});
