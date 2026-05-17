#!/usr/bin/env node
// =============================================================================
// gen-secrets — prints freshly random 32-byte secrets sized for the Env
// schema's `.min(32)` constraint on JWT and similar fields. Run with
// `pnpm gen:secrets` and copy the lines into your .env file (or pipe to
// `>> .env`). Each invocation produces unique values; rerun for rotation.
//
// We use the standard crypto.randomBytes (libuv → kernel CSPRNG via
// /dev/urandom on Linux/macOS, BCryptGenRandom on Windows). 32 bytes of
// entropy is the OWASP minimum for HS256-class signing keys; we encode as
// base64url so the resulting string is ASCII-safe in .env files and shells.
//
// We intentionally don't write to .env automatically — devs frequently have
// per-environment .env files (.env, .env.production, etc.) and overwriting
// the wrong one silently has burned us before. Print + copy is friction
// but safer.
// =============================================================================

import { randomBytes } from 'node:crypto';

const SECRET_VARS = [
  'JWT_ACCESS_SECRET',
  'JWT_REFRESH_SECRET',
];

const OPTIONAL_HMAC_VARS = [
  // Deploy webhook signing secrets — listed because they're the next-most-
  // common foot-gun. Run with --all to emit them too.
  'DEPLOY_WEBHOOK_SECRET_VERCEL',
  'DEPLOY_WEBHOOK_SECRET_RAILWAY',
  'DEPLOY_WEBHOOK_SECRET_GITHUB_ACTIONS',
  'DEPLOY_WEBHOOK_SECRET_GENERIC',
  'GITHUB_APP_WEBHOOK_SECRET',
];

function randomSecret(byteLength = 32) {
  // base64url is URL-safe, no padding, ASCII-only — ideal for .env values.
  return randomBytes(byteLength).toString('base64url');
}

const includeOptional = process.argv.includes('--all');
const targets = includeOptional ? [...SECRET_VARS, ...OPTIONAL_HMAC_VARS] : SECRET_VARS;

const lines = targets.map((name) => `${name}=${randomSecret()}`);

// Stderr for the human, stdout for the values — that way you can pipe
// stdout to .env without polluting the file with banner text.
process.stderr.write('# Generated secrets — paste into your .env file:\n');
process.stderr.write('# (re-run with --all to include webhook HMAC secrets)\n');
for (const line of lines) {
  process.stdout.write(`${line}\n`);
}
