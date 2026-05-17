// Vitest setup: seed process.env BEFORE any module is imported. The Env
// module parses on first load via zod and refuses to boot without these
// values, so tests would otherwise blow up the moment they import any service
// that transitively touches `config/env`.
//
// All values here are inert: they're either localhost URLs that nothing
// in the test process will actually connect to, or harmless secrets sized
// to satisfy the schema's `.min(32)` etc. Tests can still override individual
// vars with vi.stubEnv or process.env mutation before re-importing.

const TEST_JWT_SECRET = 'test-secret-test-secret-test-secret-1234';

const defaults: Record<string, string> = {
  NODE_ENV: 'test',
  PORT: '0',
  LOG_LEVEL: 'fatal',
  DATABASE_URL: 'postgresql://localhost:5432/test',
  REDIS_URL: 'redis://localhost:6379',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_REGION: 'us-east-1',
  S3_ACCESS_KEY: 'test-access',
  S3_SECRET_KEY: 'test-secret',
  S3_BUCKET: 'test-bucket',
  S3_QUARANTINE_BUCKET: 'test-quarantine',
  S3_FORCE_PATH_STYLE: 'true',
  CLAMAV_HOST: 'localhost',
  CLAMAV_PORT: '3310',
  QDRANT_URL: 'http://localhost:6333',
  OLLAMA_URL: 'http://localhost:11434',
  JWT_ACCESS_SECRET: TEST_JWT_SECRET,
  JWT_REFRESH_SECRET: `${TEST_JWT_SECRET}-refresh-flavored`,
  JWT_ACCESS_TTL_SECONDS: '900',
  JWT_REFRESH_TTL_SECONDS: '2592000',
  GOOGLE_OAUTH_CLIENT_ID: 'test-client-id',
  GOOGLE_OAUTH_CLIENT_SECRET: 'test-client-secret',
  GOOGLE_OAUTH_REDIRECT_URI: 'http://localhost:3000/auth/google/callback',
  GOOGLE_OAUTH_ALLOWED_DOMAIN: 'nockta.com',
  SMTP_HOST: 'localhost',
  SMTP_PORT: '1025',
  SMTP_FROM: 'no-reply@test.local',
  MAGIC_LINK_BASE_URL: 'http://localhost:5173/auth/magic',
  APP_URL_INTERNAL: 'http://localhost:5173',
  APP_URL_CLIENT: 'http://localhost:5173',
  APP_URL_API: 'http://localhost:3000',
};

for (const [k, v] of Object.entries(defaults)) {
  if (process.env[k] === undefined) {
    process.env[k] = v;
  }
}
