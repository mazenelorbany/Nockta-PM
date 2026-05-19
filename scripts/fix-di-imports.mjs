#!/usr/bin/env node
// =============================================================================
// Sweep: convert `import type { X }` -> `import { X }` for every X that is
// used as a NestJS constructor parameter type in the same file.
//
// Background. NestJS resolves DI by reading runtime reflection metadata that
// TypeScript emits for constructor parameter types. A `import type { X }` is
// erased at compile time, so the metadata for that parameter is `Function`
// and Nest fails at boot with:
//   "Nest can't resolve dependencies of the Foo (?). ..."
//
// The ESLint `@typescript-eslint/consistent-type-imports` rule WILL convert
// runtime imports to type-only imports for any class that's only referenced
// in type positions — which is exactly what happens in a Nest service
// (PrismaService is only mentioned in the constructor parameter type). The
// rule and Nest's DI are fundamentally at odds. We disable the rule on the
// API package (see apps/api/.eslintrc.cjs) and run this script once to
// restore the imports the rule already corrupted.
//
// Safe to re-run: a no-op when nothing needs converting.
// =============================================================================

import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const root = new URL('../apps/api/src/', import.meta.url).pathname;
const files = execSync(`find "${root}" -name "*.ts" -not -name "*.test.ts"`)
  .toString()
  .trim()
  .split('\n')
  .filter(Boolean);

let fixedFiles = 0;
let fixedSymbols = 0;

for (const file of files) {
  const src = readFileSync(file, 'utf8');

  // Collect every TypeScript identifier used as a constructor parameter type.
  // The constructor body can wrap across many lines, so we grab from
  // `constructor(` up to the matching `)` allowing newlines.
  const diTypes = new Set();
  const ctorRegex = /constructor\s*\(([\s\S]*?)\)\s*\{/g;
  for (const match of src.matchAll(ctorRegex)) {
    const params = match[1];
    for (const t of params.matchAll(/:\s*([A-Z][A-Za-z0-9_]*)/g)) {
      diTypes.add(t[1]);
    }
  }
  if (diTypes.size === 0) continue;

  // For each DI'd type, find any `import type { … T … }` statement (single-
  // or multi-line) and strip the leading `type` keyword. The regex spans
  // newlines and accepts the whole brace block on either side.
  let next = src;
  let changed = false;
  for (const t of diTypes) {
    const re = new RegExp(
      `^(import)\\s+type(\\s*\\{[^}]*\\b${t}\\b[^}]*\\}\\s*from\\s*['"][^'"]+['"];?)`,
      'm',
    );
    if (re.test(next)) {
      next = next.replace(re, '$1$2');
      changed = true;
      fixedSymbols += 1;
    }
  }
  if (changed) {
    writeFileSync(file, next);
    fixedFiles += 1;
  }
}

console.log(`Converted ${fixedSymbols} type-only import(s) to runtime imports across ${fixedFiles} file(s).`);
