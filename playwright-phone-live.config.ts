import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests', testMatch: 'phone-mvp.spec.ts', workers: 1,
  use: { baseURL: 'https://coinjar-personal-preview.vercel.app', channel: 'chrome' },
});
