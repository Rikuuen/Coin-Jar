import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests', testMatch: 'phone-activity-current.spec.ts', workers: 1,
  use: { baseURL: 'http://127.0.0.1:4371', browserName: 'chromium', timezoneId: 'Asia/Manila', viewport: { width: 412, height: 915 } },
  webServer: { command: 'node phone-server.mjs', url: 'http://127.0.0.1:4371', reuseExistingServer: false },
});
