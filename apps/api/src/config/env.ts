import { z } from 'zod';

// =============================================================================
// Single source of truth for runtime environment variables.
// Parsed once at module load. Fail fast on missing/invalid values.
// =============================================================================

const optionalNonEmpty = z
  .string()
  .optional()
  .or(z.literal(''))
  .transform((v) => (v && v.length > 0 ? v : undefined));

const csv = z
  .string()
  .transform((s) =>
    s
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean),
  );

// Plain z.coerce.boolean() treats any non-empty string as true, so "false" → true.
// This helper parses booleans the way humans expect.
const bool = (defaultValue: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => {
      if (v === undefined || v === '') return defaultValue;
      const lower = v.toLowerCase();
      if (lower === 'true' || lower === '1' || lower === 'yes') return true;
      if (lower === 'false' || lower === '0' || lower === 'no') return false;
      return defaultValue;
    });

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  DATABASE_URL: z.string().url(),
  DATABASE_DIRECT_URL: z.string().url().optional(),
  REDIS_URL: z.string().url(),

  S3_ENDPOINT: z.string().url(),
  S3_REGION: z.string().default('us-east-1'),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  S3_BUCKET: z.string().min(1),
  S3_QUARANTINE_BUCKET: z.string().min(1),
  S3_FORCE_PATH_STYLE: bool(true),

  CLAMAV_HOST: z.string().default('localhost'),
  CLAMAV_PORT: z.coerce.number().default(3310),

  QDRANT_URL: z.string().url(),
  QDRANT_API_KEY: optionalNonEmpty,

  LLM_PROVIDER: z.enum(['ollama', 'anthropic']).default('ollama'),
  OLLAMA_URL: z.string().url(),
  OLLAMA_MODEL: z.string().default('llama3.2'),
  ANTHROPIC_API_KEY: optionalNonEmpty,
  ANTHROPIC_MODEL: z.string().default('claude-sonnet-4-6'),
  /** AI duplicate-detection threshold. Tasks whose embedding cosine
   *  similarity ≥ this value get flagged as duplicates. Range 0..1; 0.85
   *  is a sensible default. Raise toward 0.95 to reduce false positives,
   *  lower toward 0.75 to surface more candidates. */
  AI_DUP_THRESHOLD: z.coerce.number().min(0).max(1).default(0.85),

  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().default(900),
  JWT_REFRESH_TTL_SECONDS: z.coerce.number().default(2_592_000),

  GOOGLE_OAUTH_CLIENT_ID: z.string().min(1),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().min(1),
  GOOGLE_OAUTH_REDIRECT_URI: z.string().url(),
  GOOGLE_OAUTH_ALLOWED_DOMAIN: z.string().default('nockta.com'),

  SMTP_HOST: z.string().min(1),
  SMTP_PORT: z.coerce.number(),
  SMTP_USER: optionalNonEmpty,
  SMTP_PASSWORD: optionalNonEmpty,
  SMTP_FROM: z.string().min(1),
  SMTP_USE_TLS: bool(false),

  MAGIC_LINK_TTL_SECONDS: z.coerce.number().default(900),
  MAGIC_LINK_BASE_URL: z.string().url(),

  GITHUB_APP_ID: optionalNonEmpty,
  GITHUB_APP_SLUG: optionalNonEmpty,
  GITHUB_APP_PRIVATE_KEY: optionalNonEmpty,
  GITHUB_APP_WEBHOOK_SECRET: optionalNonEmpty,
  GITHUB_APP_INSTALLATION_ID: optionalNonEmpty,

  GOOGLE_CHAT_SERVICE_ACCOUNT_JSON: optionalNonEmpty,
  GOOGLE_CHAT_PROJECT_ID: optionalNonEmpty,
  GOOGLE_CHAT_APP_ID: optionalNonEmpty,
  GOOGLE_CHAT_INTERACTION_TOKEN_AUDIENCE: optionalNonEmpty,

  DEPLOY_WEBHOOK_SECRET_VERCEL: optionalNonEmpty,
  DEPLOY_WEBHOOK_SECRET_RAILWAY: optionalNonEmpty,
  DEPLOY_WEBHOOK_SECRET_GITHUB_ACTIONS: optionalNonEmpty,
  DEPLOY_WEBHOOK_SECRET_GENERIC: optionalNonEmpty,

  APP_URL_INTERNAL: z.string().url(),
  APP_URL_CLIENT: z.string().url(),
  APP_URL_API: z.string().url(),

  CORS_ORIGINS: csv.default('http://localhost:5173'),

  RATE_LIMIT_GLOBAL_PER_MIN: z.coerce.number().default(600),
  RATE_LIMIT_PER_USER_PER_MIN: z.coerce.number().default(120),

  PROMETHEUS_METRICS_ENABLED: bool(true),

  // Elasticsearch / OpenSearch — when set, SearchService prefers ES for the
  // FTS path and indexes task/comment changes via the in-process indexer.
  // Postgres FTS remains the source of truth and fallback (spec §17).
  SEARCH_ELASTIC_URL: optionalNonEmpty,
  SEARCH_ELASTIC_INDEX_TASKS: z.string().default('nockta_tasks'),
  SEARCH_ELASTIC_API_KEY: optionalNonEmpty,

  // Sentry DSN — when set, the API initializes @sentry/node early and captures
  // unhandled exceptions. Leave empty to disable Sentry entirely.
  SENTRY_DSN: optionalNonEmpty,
  SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0.1),

  // Dev auth gate — `devLoginByEmail`, `devLoginAsPersona`, `devLoginFor` all
  // check this in addition to NODE_ENV. Defaults to false so even a misconfig
  // that flips NODE_ENV to 'development' in production can't mint Admin
  // tokens — both must hold. Set to 'true' only in dev/staging.
  DEV_AUTH_ENABLED: bool(false),
});

export type EnvType = z.infer<typeof EnvSchema>;

// =============================================================================
// Placeholder values that must NEVER ship to a real environment.
//
// The strings here are the literal placeholders we leave in `.env.example` so
// a fresh checkout boots cleanly in dev. If a deployer copy-pastes the example
// into a real .env and forgets to fill these in, the API would silently sign
// JWTs with predictable secrets — an attacker forging tokens is one google
// search away. The bootGuard below refuses to start in `production` when any
// of these match, naming the offending var so a sleepy ops engineer at 2am
// knows exactly which line to fix.
//
// Match by EXACT string. Don't fuzzy-match — a deployer who deliberately uses
// `change-me-prod-2026` (or any other readable string of ≥32 chars) gets the
// boot. The check is here to catch obvious mistakes, not enforce strong-
// password policy. Strong-password rotation is what `pnpm gen:secrets` is for.
// =============================================================================
const PLACEHOLDER_VALUES: Record<string, string[]> = {
  JWT_ACCESS_SECRET: ['change-me-to-a-real-secret-at-least-32-chars-long'],
  JWT_REFRESH_SECRET: [
    'change-me-to-a-different-real-secret-at-least-32-chars-long',
  ],
  GOOGLE_OAUTH_CLIENT_ID: ['test-client-id', ''],
  GOOGLE_OAUTH_CLIENT_SECRET: ['test-client-secret', ''],
};

function bootGuard(env: EnvType): void {
  // intentional — boot log
  /* eslint-disable no-console */
  if (env.NODE_ENV !== 'production') return;

  const violations: { name: string; hint: string }[] = [];

  for (const [name, placeholders] of Object.entries(PLACEHOLDER_VALUES)) {
    const value = (env as Record<string, unknown>)[name];
    if (typeof value !== 'string') continue;
    if (placeholders.includes(value)) {
      violations.push({
        name,
        hint:
          name === 'JWT_ACCESS_SECRET' || name === 'JWT_REFRESH_SECRET'
            ? 'Run `pnpm gen:secrets` and paste the output into your production .env.'
            : `Provision real credentials in the upstream provider and set ${name}.`,
      });
    }
  }

  // Also refuse to boot when JWT_ACCESS_SECRET === JWT_REFRESH_SECRET. Reuse
  // detection works only if compromise of one secret can't fake the other.
  if (env.JWT_ACCESS_SECRET === env.JWT_REFRESH_SECRET) {
    violations.push({
      name: 'JWT_REFRESH_SECRET',
      hint:
        'JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must differ. Run `pnpm gen:secrets` to get two unique values.',
    });
  }

  if (violations.length === 0) return;

  console.error('❌ Refusing to start: production .env contains placeholder values.');
  console.error('   These look like the strings from `.env.example`. Replace them:');
  for (const v of violations) {
    console.error(`     - ${v.name}: ${v.hint}`);
  }
  console.error('');
  console.error('   Quick fix:');
  console.error('     pnpm gen:secrets >> apps/api/.env    # appends new JWT secrets');
  console.error('   Then edit apps/api/.env to remove the old placeholder lines.');
  /* eslint-enable no-console */
  // internal: not reached from an HTTP request — boot guard, process exits.
  throw new Error('Refusing to boot with placeholder secrets in production');
}

function parseEnv(): EnvType {
  const result = EnvSchema.safeParse(process.env);
  if (!result.success) {
    // intentional — boot log
    /* eslint-disable no-console */
    console.error('❌ Environment validation failed:');
    for (const issue of result.error.issues) {
      const path = issue.path.join('.');
      const hint = describeEnvHint(path);
      console.error(`  - ${path}: ${issue.message}${hint ? ` — ${hint}` : ''}`);
    }
    /* eslint-enable no-console */
    // internal: not reached from an HTTP request — boot guard, process exits.
    throw new Error('Environment validation failed — see logs above');
  }
  bootGuard(result.data);
  return result.data;
}

// Per-variable boot-time hint: when env validation fails, surface the
// remediation the deployer needs. Especially valuable for the variables a
// new dev is most likely to miss — Google OAuth + JWT secrets.
function describeEnvHint(name: string): string {
  switch (name) {
    case 'JWT_ACCESS_SECRET':
    case 'JWT_REFRESH_SECRET':
      return 'run `pnpm gen:secrets` and paste the output into your .env';
    case 'GOOGLE_OAUTH_CLIENT_ID':
    case 'GOOGLE_OAUTH_CLIENT_SECRET':
      return 'create an OAuth 2.0 Web client at https://console.cloud.google.com/apis/credentials and set the callback URL to ${APP_URL_API}/auth/google/callback';
    case 'GOOGLE_OAUTH_REDIRECT_URI':
      return 'this MUST be exactly the same URL you registered in Google Cloud Console (typically https://api.your-domain/auth/google/callback)';
    case 'DATABASE_URL':
      return 'postgres connection string, e.g. postgresql://user:pass@host:5432/db';
    case 'REDIS_URL':
      return 'redis connection string, e.g. redis://localhost:6379';
    case 'S3_ENDPOINT':
      return 'use the MinIO URL (http://localhost:9000) in dev, or your provider endpoint in prod';
    default:
      return '';
  }
}

export const Env: EnvType = parseEnv();
