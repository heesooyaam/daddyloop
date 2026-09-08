import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 45000,
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:4318',
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    launchOptions: { args: ['--disable-dev-shm-usage'] },
  },
  webServer: {
    command: 'node dist/server/cli.js --data-dir .reviewloop/e2e serve --demo --port 4318',
    url: 'http://127.0.0.1:4318/api/health',
    reuseExistingServer: false,
    timeout: 20000,
  },
});
