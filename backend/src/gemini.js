// src/gemini.js
// Centralized Gemini (Google Generative Language API) client.
//
// Design goals (prompt2.txt §3 and §6):
//   * ONE module owns every call to the AI provider; routes never call fetch.
//   * The API key is read from the Worker secret `GEMINI_API_KEY` and is NEVER
//     logged, echoed into a URL, or returned to a client. It travels in the
//     `x-goog-api-key` header so it cannot leak via access logs / Referer.
//   * Model and timeout are server-configurable (`GEMINI_MODEL`,
//     `GEMINI_TIMEOUT_MS`), never chosen by the browser.
//   * Every failure becomes a safe, predictable HttpError. Upstream response
//     bodies are never surfaced (they can echo the prompt / user data).
//   * Pure: it only needs global fetch/AbortController, so it unit-tests with a
//     fake fetch and performs no network I/O in the test suite.

import { HttpError } from './http.js';

export const DEFAULT_MODEL = 'gemini-2.5-flash';
export const DEFAULT_TIMEOUT_MS = 20000;
export const DEFAULT_MAX_OUTPUT_TOKENS = 1024;
export const MAX_OUTPUT_TOKENS_LIMIT = 4096;

const API_ROOT = 'https://generativelanguage.googleapis.com/v1beta';

function positiveInt(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n < min) return fallback;
  return Math.min(Math.floor(n), max);
}

/**
 * Effective Gemini configuration for an env. The key is included for internal
 * use by generateContent() only and must never be logged or returned.
 * @param {Record<string, unknown>} env
 */
export function geminiConfig(env) {
  const apiKey = typeof env?.GEMINI_API_KEY === 'string' ? env.GEMINI_API_KEY.trim() : '';
  const modelRaw = typeof env?.GEMINI_MODEL === 'string' ? env.GEMINI_MODEL.trim() : '';
  return {
    configured: apiKey.length > 0,
    apiKey,
    model: modelRaw || DEFAULT_MODEL,
    timeoutMs: positiveInt(env?.GEMINI_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, { min: 1000, max: 60000 }),
  };
}

/** True when a non-empty GEMINI_API_KEY is present. */
export function isGeminiConfigured(env) {
  return geminiConfig(env).configured;
}

/**
 * Call `models/{model}:generateContent`.
 *
 * @param {Record<string, unknown>} env
 * @param {{
 *   system?: string,
 *   prompt?: string,
 *   messages?: Array<object>,
 *   temperature?: number,
 *   maxOutputTokens?: number,
 *   responseMimeType?: string|null,
 *   responseSchema?: object|null,
 *   fetchImpl?: Function,
 *   signal?: AbortSignal|null
 * }} [options]
 * @returns {Promise<{text:string, model:string, finishReason:string|null, usage:object|null}>}
 */
export async function generateContent(env, options = {}) {
  const { apiKey, model, timeoutMs } = geminiConfig(env);
  if (!apiKey) {
    console.error('[gemini] GEMINI_API_KEY is not configured');
    throw new HttpError(500, 'ai_not_configured', 'AI features are not configured on this server');
  }

  const {
    system = '',
    prompt = '',
    messages = null,
    temperature = 0.4,
    maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS,
    responseMimeType = null,
    responseSchema = null,
    fetchImpl = globalThis.fetch,
    signal = null,
  } = options;

  if (typeof fetchImpl !== 'function') {
    console.error('[gemini] no fetch implementation available');
    throw new HttpError(500, 'ai_not_configured', 'AI features are not configured on this server');
  }

  const contents = Array.isArray(messages) && messages.length
    ? messages
    : [{ role: 'user', parts: [{ text: String(prompt) }] }];

  const body = {
    contents,
    generationConfig: {
      temperature,
      maxOutputTokens: positiveInt(maxOutputTokens, DEFAULT_MAX_OUTPUT_TOKENS, { min: 1, max: MAX_OUTPUT_TOKENS_LIMIT }),
      ...(responseMimeType ? { responseMimeType } : {}),
      ...(responseSchema ? { responseSchema } : {}),
    },
  };
  if (system) body.systemInstruction = { parts: [{ text: String(system) }] };

  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  const onAbort = () => controller?.abort();
  if (signal && controller) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  let response;
  try {
    response = await fetchImpl(`${API_ROOT}/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify(body),
      signal: controller?.signal,
    });
  } catch (e) {
    const aborted = (e && e.name === 'AbortError') || Boolean(controller && controller.signal.aborted);
    // Log only the failure class: never the request or upstream content.
    console.error(`[gemini] request failed (${aborted ? 'timeout' : (e && e.name) || 'network error'})`);
    throw new HttpError(
      aborted ? 504 : 502,
      aborted ? 'ai_timeout' : 'ai_unavailable',
      aborted ? 'The AI service did not respond in time' : 'The AI service is unavailable',
    );
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && controller) signal.removeEventListener('abort', onAbort);
  }

  return parseGeminiResponse(response, model);
}

/**
 * Validate/parse a Gemini HTTP response. Exported for tests.
 * @param {Response} response
 * @param {string} model
 */
export async function parseGeminiResponse(response, model) {
  if (response.status === 429) {
    throw new HttpError(429, 'ai_quota_exceeded', 'The AI service is busy right now; please try again shortly');
  }
  if (!response.ok) {
    // Status only — the body may echo prompt (user) content.
    console.error(`[gemini] upstream status ${response.status} for model ${model}`);
    if (response.status >= 500) {
      throw new HttpError(503, 'ai_unavailable', 'The AI service is temporarily unavailable');
    }
    throw new HttpError(502, 'ai_upstream_error', 'The AI service rejected the request');
  }

  let data;
  try {
    data = await response.json();
  } catch {
    console.error('[gemini] upstream returned unreadable JSON');
    throw new HttpError(502, 'ai_bad_response', 'The AI service returned an unreadable response');
  }

  const candidate = data && data.candidates ? data.candidates[0] : null;
  const text = ((candidate && candidate.content && candidate.content.parts) || [])
    .map((part) => (part && typeof part.text === 'string' ? part.text : ''))
    .join('')
    .trim();

  if (!text) {
    const blocked = data && data.promptFeedback ? data.promptFeedback.blockReason : null;
    console.error(`[gemini] empty candidate${blocked ? ` (blockReason=${blocked})` : ''}`);
    throw new HttpError(502, 'ai_empty_response', 'The AI service returned no usable answer');
  }

  const usage = data && data.usageMetadata && typeof data.usageMetadata === 'object'
    ? {
        promptTokens: data.usageMetadata.promptTokenCount ?? null,
        outputTokens: data.usageMetadata.candidatesTokenCount ?? null,
        totalTokens: data.usageMetadata.totalTokenCount ?? null,
      }
    : null;

  return {
    text,
    model,
    finishReason: candidate && typeof candidate.finishReason === 'string' ? candidate.finishReason : null,
    usage,
  };
}

/**
 * Extract a JSON value from model text that may be wrapped in prose or a fenced
 * code block. Throws a safe HttpError(502) when nothing parseable is found, so
 * callers never fall through with `undefined`.
 *
 * @param {string} text
 */
export function extractJson(text) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new HttpError(502, 'ai_bad_response', 'The AI service returned an unreadable response');
  }
  const trimmed = text.trim();
  const candidates = [trimmed];

  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) candidates.push(fence[1].trim());

  const firstBrace = trimmed.indexOf('{');
  const firstBracket = trimmed.indexOf('[');
  const starts = [firstBrace, firstBracket].filter((i) => i >= 0);
  if (starts.length) {
    const start = Math.min(...starts);
    const end = Math.max(trimmed.lastIndexOf('}'), trimmed.lastIndexOf(']'));
    if (end > start) candidates.push(trimmed.slice(start, end + 1));
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      /* try the next candidate */
    }
  }
  throw new HttpError(502, 'ai_bad_response', 'The AI service returned an unreadable response');
}
