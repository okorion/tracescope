import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  timeout: 60000,
  use: { baseURL: process.env.TRACESCOPE_URL || 'http://127.0.0.1:4173', viewport: { width: 1440, height: 1000 }, trace: 'retain-on-failure' },
  webServer: process.env.TRACESCOPE_URL ? undefined : {
    command: 'npm run preview', url: 'http://127.0.0.1:4173', reuseExistingServer: !process.env.CI,
  },
});
