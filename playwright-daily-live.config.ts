import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: './tests', testMatch: 'phone-daily-live.spec.ts', workers: 1, use: { baseURL: 'https://coinjar-personal-preview.vercel.app', channel: 'chrome', trace: 'off', screenshot: 'off', video: 'off' } });
