// =============================================================================
// Side-effect-only module: loads apps/api/.env into process.env BEFORE any
// module that depends on it is evaluated.
//
// Imported FIRST in main.ts (before @nestjs/* / ./app.module / ./config/env)
// so that TypeScript's CommonJS output runs the requires in textual order and
// process.env is fully populated by the time `./config/env` parses it with zod.
//
// Uses Node 20.6+'s built-in process.loadEnvFile() so we don't need dotenv as
// a dependency. Silently skipped when no .env is present (production deploys
// inject env vars directly via the platform).
// =============================================================================

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const envPath = resolve(process.cwd(), '.env');
if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

// =============================================================================
// Production safety guard. The committed apps/api/.env ships with placeholder
// secrets like `dev-access-secret-change-me-in-prod-0000000` so a fresh clone
// boots locally. We refuse to start under NODE_ENV=production if any of those
// placeholders are still in effect — better a loud crash than silently signing
// forgeable JWTs in a real deployment.
// =============================================================================

if (process.env.NODE_ENV === 'production') {
  const required = [
    'JWT_ACCESS_SECRET',
    'JWT_REFRESH_SECRET',
    'DATABASE_URL',
    'REDIS_URL',
    'S3_ACCESS_KEY',
    'S3_SECRET_KEY',
    'S3_BUCKET',
    'GOOGLE_OAUTH_CLIENT_ID',
    'GOOGLE_OAUTH_CLIENT_SECRET',
  ] as const;
  const secretsNeedingLength: Record<string, number> = {
    JWT_ACCESS_SECRET: 32,
    JWT_REFRESH_SECRET: 32,
  };
  const missing: string[] = [];
  const placeholders: string[] = [];
  const tooShort: string[] = [];
  for (const key of required) {
    const v = process.env[key];
    if (!v) {
      missing.push(key);
      continue;
    }
    if (/change-me|placeholder|dev-secret|^secret$|^changeme$/i.test(v)) {
      placeholders.push(key);
    }
    const min = secretsNeedingLength[key];
    if (min !== undefined && v.length < min) {
      tooShort.push(`${key} (got ${v.length} chars, need ≥${min})`);
    }
  }
  // Weak/duplicate JWT pair — different secrets must be different to avoid a
  // refresh-as-access mix-up if either signing path is ever wired wrong.
  if (
    process.env.JWT_ACCESS_SECRET &&
    process.env.JWT_REFRESH_SECRET &&
    process.env.JWT_ACCESS_SECRET === process.env.JWT_REFRESH_SECRET
  ) {
    tooShort.push('JWT_ACCESS_SECRET and JWT_REFRESH_SECRET are identical');
  }
  if (missing.length > 0 || placeholders.length > 0 || tooShort.length > 0) {
    // eslint-disable-next-line no-console
    console.error(
      `[bootstrap-env] Refusing to boot in production:` +
      (missing.length ? `\n  Missing env vars: ${missing.join(', ')}` : '') +
      (placeholders.length
        ? `\n  Placeholder/dev value detected for: ${placeholders.join(', ')}`
        : '') +
      (tooShort.length ? `\n  Secret issues: ${tooShort.join(', ')}` : ''),
    );
    process.exit(1);
  }
}
