import { defineConfig } from 'vitest/config';

// =============================================================================
// Frontend Vitest config.
//
// Default environment is `node` so pure-function tests (guards, formula
// evaluator, query-key builders) stay fast. RTL tests opt in to jsdom per
// file via the `// @vitest-environment jsdom` directive at the top of the
// file.
//
// `setupFiles` registers jest-dom matchers + RTL cleanup. Without the
// cleanup, `render()` calls accumulate into a shared `document.body` across
// tests in the same file — visible as "Found multiple elements with the
// text X" failures across the dashboard suite.
// =============================================================================

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
});
