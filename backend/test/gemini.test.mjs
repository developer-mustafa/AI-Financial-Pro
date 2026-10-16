// test/gemini.test.mjs
// Unit tests for the centralized Gemini client. All network I/O is faked via an
// injected `fetchImpl`, so these run offline and never touch Google.

import test from 'node:test';
import assert from 'node:assert/strict';

import { HttpError } from '../src/http.js';
import {
  DEFAULT_MODEL,
  DEFAULT_TIMEOUT_MS,
  generateContent,
  geminiConfig,
  isGeminiConfigured,
  extractJson,
  parseGeminiResponse,
} from '../src/gemini.js';

const ENV = { GEMINI_API_KEY: 'test-key-123', GEMINI_MODEL: 'gemini-2.5-flash' };

function isHttpErrorWith(status, code) {
  return (e) => {
    assert.ok(e instanceof HttpError, `expected HttpError, got ${e && e.constructor && e.constructor.name}`);
    assert.equal(e.status, status);
    if (code) assert.equal(e.code, code);
    return true;
  };
}

function geminiOk(text = 'Hello from Gemini') {
  return {
    status: 200,
    ok: true,
    async json() {
      return {
        candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 22, totalTokenCount: 33 },
      };
    },
  };
}

test('geminiConfig: defaults when unset, override when present', () => {
  const d = geminiConfig({});
  assert.equal(d.configured, false);
  assert.equal(d.model, DEFAULT_MODEL);
  assert.equal(d.timeoutMs, DEFAULT_TIMEOUT_MS);
  assert.equal(isGeminiConfigured({}), false);

  const c = geminiConfig(ENV);
  assert.equal(c.configured, true);
  assert.equal(c.model, 'gemini-2.5-flash');
  assert.equal(isGeminiConfigured(ENV), true);
});

test('generateContent: sends the key in a header (never the URL) and parses text', async () => {
  let captured = null;
  const fetchImpl = async (url, options) => {
    captured = { url, options };
    return geminiOk('Your savings rate looks healthy.');
  };

  const result = await generateContent(ENV, {
    system: 'be concise',
    prompt: 'summarize',
    maxOutputTokens: 256,
    fetchImpl,
  });

  assert.equal(result.text, 'Your savings rate looks healthy.');
  assert.equal(result.model, 'gemini-2.5-flash');
  assert.equal(result.finishReason, 'STOP');
  assert.deepEqual(result.usage, { promptTokens: 11, outputTokens: 22, totalTokens: 33 });

  assert.ok(captured.url.includes('/models/gemini-2.5-flash:generateContent'));
  assert.ok(!captured.url.includes('test-key-123'), 'key must not appear in the URL');
  assert.ok(!captured.url.includes('key='), 'key must not be a query param');
  assert.equal(captured.options.headers['x-goog-api-key'], 'test-key-123');

  const body = JSON.parse(captured.options.body);
  assert.equal(body.systemInstruction.parts[0].text, 'be concise');
  assert.equal(body.contents[0].parts[0].text, 'summarize');
  assert.equal(body.generationConfig.maxOutputTokens, 256);
});

test('generateContent: missing key fails closed with 500 ai_not_configured', async () => {
  await assert.rejects(
    () => generateContent({}, { prompt: 'x', fetchImpl: async () => geminiOk() }),
    isHttpErrorWith(500, 'ai_not_configured'),
  );
  await assert.rejects(
    () => generateContent({ GEMINI_API_KEY: '   ' }, { prompt: 'x', fetchImpl: async () => geminiOk() }),
    isHttpErrorWith(500, 'ai_not_configured'),
  );
});

test('generateContent: 429 becomes ai_quota_exceeded (no upstream body leaked)', async () => {
  await assert.rejects(
    () =>
      generateContent(ENV, {
        prompt: 'x',
        fetchImpl: async () => ({ status: 429, ok: false, json: async () => ({ secret: 'nope' }) }),
      }),
    isHttpErrorWith(429, 'ai_quota_exceeded'),
  );
});

test('generateContent: upstream 5xx becomes 503 ai_unavailable', async () => {
  await assert.rejects(
    () => generateContent(ENV, { prompt: 'x', fetchImpl: async () => ({ status: 503, ok: false, json: async () => ({}) }) }),
    isHttpErrorWith(503, 'ai_unavailable'),
  );
});

test('generateContent: upstream 4xx becomes 502 ai_upstream_error', async () => {
  await assert.rejects(
    () => generateContent(ENV, { prompt: 'x', fetchImpl: async () => ({ status: 400, ok: false, json: async () => ({}) }) }),
    isHttpErrorWith(502, 'ai_upstream_error'),
  );
});

test('generateContent: unreadable JSON becomes 502 ai_bad_response', async () => {
  await assert.rejects(
    () =>
      generateContent(ENV, {
        prompt: 'x',
        fetchImpl: async () => ({ status: 200, ok: true, json: async () => { throw new Error('bad'); } }),
      }),
    isHttpErrorWith(502, 'ai_bad_response'),
  );
});

test('generateContent: a network failure becomes 502, a timeout becomes 504', async () => {
  await assert.rejects(
    () => generateContent(ENV, { prompt: 'x', fetchImpl: async () => { const e = new Error('boom'); e.name = 'TypeError'; throw e; } }),
    isHttpErrorWith(502, 'ai_unavailable'),
  );
  await assert.rejects(
    () => generateContent(ENV, { prompt: 'x', fetchImpl: async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; } }),
    isHttpErrorWith(504, 'ai_timeout'),
  );
});

test('parseGeminiResponse: an empty candidate is rejected', async () => {
  await assert.rejects(
    () => parseGeminiResponse({ status: 200, ok: true, json: async () => ({ candidates: [] }) }, 'm'),
    isHttpErrorWith(502, 'ai_empty_response'),
  );
  await assert.rejects(
    () =>
      parseGeminiResponse(
        { status: 200, ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: '   ' }] } }], promptFeedback: { blockReason: 'SAFETY' } }) },
        'm',
      ),
    isHttpErrorWith(502, 'ai_empty_response'),
  );
});

test('extractJson: plain, fenced, and prose-wrapped JSON', () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('```json\n{"a":2}\n```'), { a: 2 });
  assert.deepEqual(extractJson('Sure! Here it is: {"a":3} — hope that helps.'), { a: 3 });
  assert.deepEqual(extractJson('[1,2,3]'), [1, 2, 3]);
});

test('extractJson: unparseable output fails safely', () => {
  assert.throws(() => extractJson('no json here'), isHttpErrorWith(502, 'ai_bad_response'));
  assert.throws(() => extractJson(''), isHttpErrorWith(502));
  assert.throws(() => extractJson(null), isHttpErrorWith(502));
});
