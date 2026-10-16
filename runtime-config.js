/**
 * Runtime configuration — the ONLY deployment-specific file.
 *
 * This file is loaded by index.html as a plain (non-module) script BEFORE the
 * ES modules, so it must stay dependency-free and synchronous.
 *
 * SECURITY: never put secrets here. This file is served to the browser. It may
 * only contain public URLs. Database credentials live exclusively in the
 * Worker's environment (see backend/).
 *
 *   apiBaseUrl   Public base URL of the Worker, e.g.
 *                "https://spendwise-api.<you>.workers.dev".
 *                Leave it empty ("") to run entirely offline (local-only mode).
 *   neonAuthUrl  Public Auth Base URL of Managed Better Auth (Neon Auth), e.g.
 *                "https://<endpoint>.neonauth.<region>.aws.neon.tech/<db>/auth".
 *                Found in the Neon Console under Settings → Better Auth.
 *                Leave it empty ("") to disable magic-link sign-in; email +
 *                password sign-in through the Worker still works.
 *   cloudEnabled When false the app never calls the network, even if a URL is
 *                set. Useful for demos and privacy-restricted deployments.
 */
globalThis.SPENDWISE_RUNTIME = {
  // Deployed Cloudflare Worker (backend/). Set back to 'http://127.0.0.1:8787'
  // to use local `wrangler dev`, or to '' for offline-only mode.
  apiBaseUrl: 'https://spendwise-api.mustafa-rahman-official.workers.dev',
  neonAuthUrl: 'https://ep-noisy-field-b3vzkk80.neonauth.c-4.ap-southeast-1.aws.neon.tech/expense-tracker-pro/auth',
  cloudEnabled: true
};
