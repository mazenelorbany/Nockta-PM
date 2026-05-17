import { defineConfig } from 'vitest/config';

// =============================================================================
// Frontend Vitest config — pure-function tests only (no jsdom / RTL).
//
// Security-critical UI logic (auth guards, role gates, visibility filters)
// lives in `src/lib/guards.ts` as pure predicates that the React components
// call. Testing the predicates directly catches the bug-class we care about
// (a wrong condition lets the wrong user see the wrong thing) without
// loading a full DOM environment. When we eventually want to test rendered
// trees, add `@testing-library/react` + `jsdom` and a separate "ui-tests"
// pattern; this config stays focused on the predicate layer.
// =============================================================================

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
});
