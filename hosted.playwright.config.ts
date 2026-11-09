import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests', testMatch: 'hosted-browser.spec.ts', workers: 1,
  use: { baseURL: 'http://127.0.0.1:47839', channel: 'chrome' },
  webServer: { command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 47839 --strictPort', url: 'http://127.0.0.1:47839', reuseExistingServer: process.env.COINJAR_REUSE_TEST_SERVER === '1', env: { VITE_COINJAR_HOSTED: 'true', VITE_NEON_AUTH_URL: 'http://127.0.0.1:4400/auth' } },
});
