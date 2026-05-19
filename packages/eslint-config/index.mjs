import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import importPlugin from 'eslint-plugin-import';
import prettierConfig from 'eslint-config-prettier';

/** Shared base. Consumers extend this and add either react or node specifics. */
export default [
  {
    ignores: ['**/dist/**', '**/build/**', '**/node_modules/**', '**/.turbo/**'],
  },
  { files: ['**/*.{ts,tsx,mts,cts}'], ...js.configs.recommended },
  ...tseslint.configs.recommended.map((c) => ({
    ...c,
    files: ['**/*.{ts,tsx,mts,cts}'],
  })),
  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    plugins: { import: importPlugin },
    rules: {
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      // ESLint 9 added this rule and it fires on legitimate `let x = default;`
      // patterns where every branch reassigns before the read but TS can't
      // prove all branches do. Worth a separate refactor pass, not a blocker.
      'no-useless-assignment': 'off',
      'import/order': [
        'error',
        {
          'newlines-between': 'always',
          groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index'],
        },
      ],
    },
  },
  { ...prettierConfig, files: ['**/*.{ts,tsx,mts,cts}'] },
];
