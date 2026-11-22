import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts'],
    // A handful of tests exercise route handlers end-to-end against the
    // real local Postgres (mocking only 'octokit' and '@/lib/session') so
    // the DB transaction / row-lock behavior in adopt is actually
    // exercised rather than re-implemented as a fake in test code.
    setupFiles: ['./vitest.setup.ts'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
