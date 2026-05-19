import globals from 'globals';
// @eslint-react/eslint-plugin replaces the legacy eslint-plugin-react.
// The legacy plugin (still on v7.37.5) calls context.getFilename() which
// ESLint 10 removed, so it errors at load time. @eslint-react is a
// flat-config-native rewrite with React 19 awareness.
import eslintReact from '@eslint-react/eslint-plugin';
import reactHooksPlugin from 'eslint-plugin-react-hooks';
import jsxA11yPlugin from 'eslint-plugin-jsx-a11y';
import base from './index.mjs';

export default [
  ...base,
  eslintReact.configs.recommended,
  {
    files: ['**/*.{ts,tsx,js,jsx}'],
    plugins: {
      'react-hooks': reactHooksPlugin,
      'jsx-a11y': jsxA11yPlugin,
    },
    languageOptions: {
      globals: { ...globals.browser, ...globals.es2022 },
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    rules: {
      // react-hooks v7's "recommended" preset spreads in 13+ new compiler
      // rules (set-state-in-effect, purity, refs, immutability, …) that flag
      // 55 real-but-fixable patterns across this codebase. Each one is a
      // worthwhile React 19 best-practices refactor but a separate task.
      // For now we wire only the two legacy rules that v5 shipped, matching
      // the prior surface.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // @eslint-react v5 recommended preset enables 11 new React-19 best-
      // practice rules that surface 165 real-but-fixable findings across
      // the codebase. Same story as the react-hooks compiler rules above —
      // worth a dedicated refactor pass, not a blocker for the upgrade.
      // Turning them off here so the upgrade lands; re-enable selectively
      // as the corresponding patches go in.
      '@eslint-react/set-state-in-effect': 'off',
      '@eslint-react/exhaustive-deps': 'off',
      '@eslint-react/purity': 'off',
      '@eslint-react/no-array-index-key': 'off',
      '@eslint-react/use-state': 'off',
      '@eslint-react/naming-convention-ref-name': 'off',
      '@eslint-react/web-api-no-leaked-timeout': 'off',
      '@eslint-react/no-forward-ref': 'off',
      '@eslint-react/jsx-no-leaked-dollar': 'off',
      '@eslint-react/unsupported-syntax': 'off',
      '@eslint-react/dom-no-dangerously-set-innerhtml': 'off',
    },
  },
];
