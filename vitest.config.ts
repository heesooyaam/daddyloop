import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    setupFiles: ['tests/setup.ts'],
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    maxWorkers: 2,
    testTimeout: 15000,
  },
});
