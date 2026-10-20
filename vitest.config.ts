import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts', 'scripts/release-provenance.ts'],
      reporter: ['lcov', 'text'],
      reportsDirectory: 'coverage',
    },
  },
});
