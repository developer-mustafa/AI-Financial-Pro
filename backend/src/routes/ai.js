// src/routes/ai.js
// AI routes: read-only financial advisor + spending insights.
//
// Security posture (prompt2.txt §3/§6):
//   * authentication + tenant isolation are enforced by the router (these
//     routes declare `tenant: true`), so `ctx.tenantId` is a verified workspace.
//   * every query below is scoped by `tenant_id` — never by a client-supplied id.
//   * explicit user consent is required before ANYTHING is sent to the provider.
//   * only a small, deterministic, PII-free aggregate is sent (see aiInsights.js).
//   * a per-user quota limits spend; model + timeout are server-configured.
//   * failures return predictable JSON; prompts/responses are never logged.

import { HttpError, json, parseJson, rateLimit } from '../http.js';
import { generateContent, isGeminiConfigured } from '../gemini.js';
import { buildFinancialContext, buildHighlights, formatMajor, monthsAgoIso } from '../aiInsights.js';

const AI_RATE_LIMIT = 20; // requests
const AI_RATE_WINDOW_MS = 60_000; // per user per minute
const MAX_QUESTION_CHARS = 500;
const MONTHS_WINDOW = 6;
const LANGUAGES = ['en', 'bn'];

// Per-isolate, best-effort quota (same caveats as the global limiter in
// index.js: Workers isolates are ephemeral and per-colo).
const aiStore = new Map();

/** Test seam. */
export function resetAiRateStore() {
  aiStore.clear();
}

function enforceQuota(userId) {
  const result = rateLimit(aiStore, `ai:${userId}`, { limit: AI_RATE_LIMIT, windowMs: AI_RATE_WINDOW_MS });
  if (!result.ok) {
    throw new HttpError(429, 'ai_rate_limited', 'Too many AI requests; please wait a moment and try again');
  }
  return result;
}

/**
 * Validate an AI request body. Enforces explicit consent and a bounded question.
 * Exported for unit tests.
 */
export function validateAiRequest(body, { requireQuestion = false } = {}) {
  const b = body && typeof body === 'object' ? body : {};
  if (b.consent !== true) {
    throw new HttpError(
      400,
      'consent_required',
      'Please confirm you consent to sending an aggregated financial summary to the AI provider',
    );
  }
  const language = LANGUAGES.includes(b.language) ? b.language : 'en';

  let question = '';
  if (requireQuestion) {
    question = typeof b.question === 'string' ? b.question.trim() : '';
    if (!question) throw new HttpError(400, 'validation_error', 'A question is required');
    if (question.length > MAX_QUESTION_CHARS) {
      throw new HttpError(400, 'validation_error', `The question must be at most ${MAX_QUESTION_CHARS} characters`);
    }
  }

  const periodMonths = Number.isInteger(b.periodMonths)
    ? Math.min(Math.max(b.periodMonths, 1), MONTHS_WINDOW)
    : MONTHS_WINDOW;

  return { language, question, periodMonths };
}

/** Load the tenant-scoped rows an AI feature may summarize. */
export async function loadFinancialContext(db, tenantId, periodMonths) {
  const since = monthsAgoIso(periodMonths);
  const [transactions, categories, budgets] = await Promise.all([
    db.query(
      `SELECT amount_minor, currency, type, category_id, date, status
         FROM transactions
        WHERE tenant_id = $1 AND date >= $2
        ORDER BY date DESC`,
      [tenantId, since],
    ),
    db.query('SELECT id, name, type FROM categories WHERE tenant_id = $1', [tenantId]),
    db.query('SELECT id FROM budgets WHERE tenant_id = $1', [tenantId]),
  ]);
  return buildFinancialContext({
    transactions: transactions || [],
    categories: categories || [],
    budgets: budgets || [],
    months: periodMonths,
  });
}

const SYSTEM_RULES =
  'You are SpendWise, a careful personal-finance assistant. Follow these rules strictly: ' +
  'use ONLY the aggregated figures provided in the user message; never invent transactions, ' +
  'balances, accounts or statistics; do not perform your own arithmetic (the totals are already ' +
  'computed for you); if the data is insufficient, say so plainly; never request personal ' +
  'identifiers; be concise (under 200 words), practical and non-judgemental; this is general ' +
  'information, not regulated financial advice.';

/** Human-readable, deterministic rendering of the aggregate. Exported for tests. */
export function renderContext(context, language) {
  const lines = [];
  lines.push(`Currency: ${context.currency}`);
  lines.push(`Period covered: last ${context.monthsCovered || context.requestedMonths} month(s) with data`);

  for (const total of context.totals) {
    lines.push(
      `Totals (${total.currency}): income ${formatMajor(total.incomeMinor)}, ` +
        `expenses ${formatMajor(total.expenseMinor)}, net ${formatMajor(total.netMinor)}`,
    );
  }

  if (context.topCategories.length) {
    const parts = context.topCategories.map(
      (c) => `${c.name || 'Uncategorized'} ${formatMajor(c.expenseMinor)} (${Math.round(c.share * 100)}%)`,
    );
    lines.push(`Top expense categories: ${parts.join(', ')}`);
  }

  if (context.monthlyTotals.length) {
    lines.push('Month-by-month (income / expenses):');
    for (const m of context.monthlyTotals) {
      lines.push(`  ${m.month}: ${formatMajor(m.incomeMinor)} / ${formatMajor(m.expenseMinor)}`);
    }
  }

  if (context.deltas && context.deltas.expensePct !== null) {
    const dir = context.deltas.expensePct > 0 ? 'up' : 'down';
    lines.push(`Latest month expenses ${dir} ${Math.abs(context.deltas.expensePct)}% vs the previous month`);
  }

  if (context.budgetCount > 0) lines.push(`Budgets on record: ${context.budgetCount}`);
  if (context.transactionCount === 0) lines.push('No transactions were recorded in this period.');

  lines.push(`Reply in ${language === 'bn' ? 'Bangla (বাংলা)' : 'English'}.`);
  return lines.join('\n');
}

/** Advisor prompt (aggregate + the user's question). Exported for tests. */
export function buildAdvisorPrompt(context, question, language) {
  return [
    'Here is an aggregated summary of my own finances. All amounts are already computed.',
    renderContext(context, language),
    '',
    `My question: ${question}`,
  ].join('\n');
}

/** Insights prompt (aggregate only). Exported for tests. */
export function buildInsightsPrompt(context, language) {
  return [
    'Here is an aggregated summary of my own finances. All amounts are already computed.',
    renderContext(context, language),
    '',
    'Give me a short, practical read of my spending: what stands out, and one or two concrete,',
    'specific suggestions I could act on. Plain text only, no markdown tables.',
  ].join('\n');
}

function assertAiReady(ctx) {
  if (!isGeminiConfigured(ctx.env)) {
    console.error('[ai] GEMINI_API_KEY is not configured');
    throw new HttpError(500, 'ai_not_configured', 'AI features are not configured on this server');
  }
}

/** Deterministic basis shown to the user (transparency: §4A "explain evidence"). */
function basisOf(context) {
  return {
    currency: context.currency,
    monthsCovered: context.monthsCovered,
    transactionCount: context.transactionCount,
    topCategories: context.topCategories.map((c) => ({ name: c.name, share: c.share })),
  };
}

/**
 * POST /api/ai/advisor  { question, language?, consent: true, periodMonths? }
 * -> { answer, basis, model, usage, generatedAt }
 */
export async function advisor(ctx) {
  assertAiReady(ctx);
  enforceQuota(ctx.userId);

  const body = await parseJson(ctx.request, 64 * 1024); // small: a question, not a dataset
  const { question, language, periodMonths } = validateAiRequest(body, { requireQuestion: true });

  const context = await loadFinancialContext(ctx.db, ctx.tenantId, periodMonths);
  const result = await generateContent(ctx.env, {
    system: SYSTEM_RULES,
    prompt: buildAdvisorPrompt(context, question, language),
    temperature: 0.4,
    maxOutputTokens: 1024,
  });

  return json({
    answer: result.text,
    basis: basisOf(context),
    model: result.model,
    usage: result.usage,
    generatedAt: new Date().toISOString(),
  });
}

/**
 * POST /api/ai/insights  { language?, consent: true, periodMonths? }
 * -> { highlights, narrative, basis, model, usage, generatedAt }
 *
 * `highlights` are computed deterministically server-side; the model only adds
 * a short narrative on top.
 */
export async function insights(ctx) {
  assertAiReady(ctx);
  enforceQuota(ctx.userId);

  const body = await parseJson(ctx.request, 64 * 1024);
  const { language, periodMonths } = validateAiRequest(body);

  const context = await loadFinancialContext(ctx.db, ctx.tenantId, periodMonths);
  const highlights = buildHighlights(context);

  const result = await generateContent(ctx.env, {
    system: SYSTEM_RULES,
    prompt: buildInsightsPrompt(context, language),
    temperature: 0.5,
    maxOutputTokens: 800,
  });

  return json({
    highlights,
    narrative: result.text,
    basis: basisOf(context),
    model: result.model,
    usage: result.usage,
    generatedAt: new Date().toISOString(),
  });
}
