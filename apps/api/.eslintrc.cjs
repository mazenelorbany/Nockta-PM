module.exports = {
  extends: ['@nockta/eslint-config/node'],
  rules: {
    // NestJS uses runtime reflection on constructor parameter types for
    // dependency injection. If a class is imported as type-only
    // (`import type { Foo }`), TypeScript erases the import at compile
    // time, leaving Nest with `Function` instead of the class to inject.
    // The Nest container then throws
    //   "Nest can't resolve dependencies of the Foo (?). ..."
    // at boot.
    //
    // Disabling this rule on the API package keeps the auto-fixer from
    // silently breaking the DI graph the next time someone runs
    // `pnpm lint --fix`. Bundle size is irrelevant on the server.
    '@typescript-eslint/consistent-type-imports': 'off',
  },
};
