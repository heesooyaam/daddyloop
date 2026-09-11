import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';
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
    env: { DADDYLOOP_CONFIG: resolve('.daddyloop/e2e/config.json') },
    command: 'node tests/e2e/host.mjs',
    url: 'http://127.0.0.1:4318/api/health',
    reuseExistingServer: false,
    timeout: 20000,
  },
});
