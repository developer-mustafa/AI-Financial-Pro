/**
 * Client façade for the AI endpoints (`/api/ai/*`).
 *
 * Read-only by design: these calls only ask the Worker for advice or insights
 * over an aggregated, PII-free summary of the caller's own workspace. The Gemini
 * key and all aggregation live server-side — nothing secret or raw reaches the
 * browser. Explicit consent is passed on every call; the Worker refuses without it.
 *
 * Uses the shared API client, so the `Authorization` (session) and `X-Tenant-Id`
 * (workspace selector) headers are attached exactly as for every other endpoint.
 */

export function createAiService({ client } = {}) {
  const isConfigured = () => Boolean(client) && client.configured !== false;

  return {
    get configured() {
      return isConfigured();
    },

    /**
     * Ask the financial advisor a question about the current workspace.
     * @param {string} question
     * @param {{language?: 'en'|'bn', consent?: boolean, periodMonths?: number|null}} [options]
     */
    async advisor(question, { language = 'en', consent = false, periodMonths = null } = {}) {
      const payload = { question, language, consent };
      if (periodMonths) payload.periodMonths = periodMonths;
      return client.post('/api/ai/advisor', payload);
    },

    /**
     * Deterministic highlights plus a short narrative.
     * @param {{language?: 'en'|'bn', consent?: boolean, periodMonths?: number|null}} [options]
     */
    async insights({ language = 'en', consent = false, periodMonths = null } = {}) {
      const payload = { language, consent };
      if (periodMonths) payload.periodMonths = periodMonths;
      return client.post('/api/ai/insights', payload);
    }
  };
}
