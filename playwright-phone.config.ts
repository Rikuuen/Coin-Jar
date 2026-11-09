import { defineConfig } from '@playwright/test';

const port = process.env.PORT ?? '4371';
export default defineConfig({
  testDir: './tests', testMatch: 'phone-mvp.spec.ts', workers: 1,
  use: { baseURL: `http://127.0.0.1:${port}`, channel: 'chrome' },
  webServer: { command: 'node phone-server.mjs', url: `http://127.0.0.1:${port}`, reuseExistingServer: process.env.COINJAR_REUSE_TEST_SERVER === '1' },
});
