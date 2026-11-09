import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testMatch: 'browser.spec.ts',
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:4319',
    trace: 'retain-on-failure',
    channel: 'chrome',
  },
  webServer: {
    command: 'node --import tsx scripts/test-server.ts',
    url: 'http://127.0.0.1:4319',
    reuseExistingServer: process.env.COINJAR_REUSE_TEST_SERVER === '1',
    env: {
      PORT: '4319',
      COINJAR_DB: `.data/browser-test-${Date.now()}.sqlite`,
      MEMWAL_PRIVATE_KEY: '',
      MEMWAL_ACCOUNT_ID: '',
      TATUM_API_KEY: '',
      COINJAR_ALLOW_SETUP: '0',
      COINJAR_MODE: 'demo',
    },
  },
});
