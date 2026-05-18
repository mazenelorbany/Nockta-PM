// =============================================================================
// Vitest setup. Runs once before each test file.
//
// Two responsibilities:
//   1. Wire up jest-dom matchers (`toBeInTheDocument`, `toHaveAttribute`, …)
//      so RTL tests can assert against the rendered DOM with the standard
//      vocabulary.
//   2. Call testing-library's `cleanup()` after every test. This is no
//      longer automatic from RTL v16 onwards (the package stopped patching
//      `afterEach` to avoid global side effects). Without this, every
//      render accumulates into a shared `document.body`, and a subsequent
//      `getByText` matches across all tests in the file — visible as the
//      "Found multiple elements with the text X" failures that broke the
//      whole dashboard test set on first run.
// =============================================================================

import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => {
  cleanup();
});
