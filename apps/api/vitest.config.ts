import { defineConfig } from 'vitest/config';

// =============================================================================
// Vitest config — runs the API's *.test.ts suites with TypeScript support and
// our `@nockta/types` path alias. Tests instantiate services directly with
// mocked dependencies (no NestJS DI container, no real DB / Redis / S3),
// which keeps each test ~milliseconds and CI-friendly.
//
// setupFiles below seeds process.env BEFORE any module is imported, so
// src/config/env.ts (which parses + validates at module load) doesn't blow
// up. Tests can still override individual env vars per-suite if they need to.
// =============================================================================

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    setupFiles: ['src/test-utils/env-setup.ts'],
    pool: 'forks',
    poolOptions: {
      // Isolate each file in its own worker so module-scoped state from
      // env.ts and others doesn't leak between suites.
      forks: { singleFork: false },
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: [
        'src/modules/auth/**/*.ts',
        'src/modules/permissions/**/*.ts',
        'src/modules/tasks/workflow.ts',
        'src/modules/attachments/**/*.ts',
      ],
      exclude: [
        '**/*.test.ts',
        '**/*.module.ts',
        '**/index.ts',
        '**/types.ts',
        '**/__tests__/**',
      ],
    },
  },
  resolve: {
    alias: {
      '@nockta/types': new URL('../../packages/types/src', import.meta.url).pathname,
    },
  },
  esbuild: {
    // NestJS uses decorators; vitest's transformer needs this to emit metadata.
    target: 'es2022',
  },
});
