import { defineConfig } from 'vitest/config';

const MOCK = 'http://127.0.0.1:4599';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/global-setup.ts'],
    testTimeout: 20_000,
    // Every external provider is pointed at the local mock upstream.
    env: {
      DATABASE_PATH: ':memory:',
      NEWS_REFRESH_MINUTES: '0',
      ANTHROPIC_API_KEY: 'test-key',
      ANTHROPIC_BASE_URL: `${MOCK}/anthropic`,
      YAHOO_CHART_BASE: `${MOCK}/yahoo`,
      YAHOO_SEARCH_BASE: `${MOCK}/yahoo`,
      STOOQ_BASE: `${MOCK}/stooq`,
      SEC_DATA_BASE: `${MOCK}/sec`,
      SEC_WWW_BASE: `${MOCK}/sec`,
      GDELT_BASE: `${MOCK}/gdelt`,
    },
  },
});
