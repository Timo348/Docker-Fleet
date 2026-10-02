import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests',
  testMatch: '**/ui.spec.ts',
  workers: 1,
  timeout: 30000,
  use: {
    baseURL: process.env.FLEET_TEST_URL || 'http://127.0.0.1:18080',
    browserName: 'chromium',
    trace: 'retain-on-failure',
  },
  reporter: 'list',
});
