import { defineConfig } from 'vitest/config';

/**
 * Test configuration.
 *
 * The unit suites exercise pure business logic (calculations, validation,
 * currency, dates, import/export, domain services). A jsdom environment is
 * used because a few modules touch `localStorage`/`document` at import time.
 */
export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.js'],
    globals: false,
    restoreMocks: true,
    clearMocks: true,
    reporters: ['default']
  }
});
