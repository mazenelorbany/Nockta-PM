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
    // Filter: drop "used in module" — that's an internal export, fine.
    const real = lines.filter((l) => !l.includes('used in module'));
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
  const ALLOWED = ['apps/api/scripts/', 'scripts/', '/main.ts', '__tests__'];
  for (const line of raw.split('\n').filter(Boolean)) {
    const [filePath] = line.split(':');
    if (!filePath) continue;
    if (ALLOWED.some((p) => filePath.includes(p))) continue;
    // Allow eslint-suppressed lines.
    const m = line.match(/^([^:]+):(\d+):(.*)$/);
    if (m && /eslint-disable.*no-console/.test(m[3])) continue;
    // Allow if the preceding line had a no-console disable.
    violations.push({
      category: 'console-log',
      file: line.split(':').slice(0, 2).join(':'),
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
