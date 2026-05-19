import 'reflect-metadata';
// MUST be imported before anything that touches process.env — bootstrap-env.ts
// loads apps/api/.env via Node's built-in env-file loader so subsequent imports
// (./config/env, etc.) see the populated process.env.
import './bootstrap-env';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';

import { maybeInitSentry } from './bootstrap-sentry';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { CorrelationIdInterceptor } from './common/interceptors/correlation-id.interceptor';
import { MetricsInterceptor } from './common/interceptors/metrics.interceptor';
import { Env } from './config/env';
import { RedisIoAdapter } from './modules/realtime/realtime.adapter';

async function bootstrap(): Promise<void> {
  // Initialize Sentry first so it captures any errors thrown during Nest boot.
  // No-ops when SENTRY_DSN isn't set.
  await maybeInitSentry();

  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
    // Capture the raw request body — needed by webhook signature verifiers (GitHub, Chat, deployments).
    rawBody: true,
  });
  app.useLogger(app.get(Logger));

  app.use(helmet({ contentSecurityPolicy: false }));
  // ─────────────────────────────────────────────────────────────────────────
  // CSRF: intentionally NOT mounted. Close-out for GRILL-SUMMARY §23
  // ("CSRF protection for cookie-based session flows").
  //
  // GRILL §23 scopes CSRF protection to cookie-based session flows. This
  // service has none. Specifically:
  //
  //   1. Authentication is JWT bearer-token only (see Swagger addBearerAuth
  //      + JwtAuthGuard + JwtStrategy.fromAuthHeaderAsBearerToken). The
  //      access token is delivered to the SPA via URL fragment after the
  //      Google OAuth callback (auth.controller.ts googleCallback) or as
  //      a JSON body on /auth/magic-link/verify and /auth/dev-login —
  //      never via Set-Cookie. The SPA stores it in localStorage (Zustand
  //      persist) and attaches it on every XHR as `Authorization: Bearer`.
  //
  //   2. CORS is opened with `credentials: false` (see below). Browsers
  //      will not attach cookies on cross-origin requests, and we accept
  //      no ambient credentials. An attacker on evil.example cannot forge
  //      an authenticated request from a victim's browser because they
  //      cannot read localStorage (same-origin policy) and therefore
  //      cannot set the Authorization header.
  //
  //   3. No code path calls res.cookie() or uses cookie-parser. The only
  //      `cookie` references in src/ are (a) pino redact rules for
  //      defense-in-depth log scrubbing and (b) comments explaining this
  //      stance (see github-install.controller.ts: OAuth state lives in
  //      Redis, not a cookie, for the same reason).
  //
  // If a future flow ever calls res.cookie() — e.g. a session cookie for
  // a server-rendered admin page, or a SameSite=None refresh cookie — it
  // MUST be paired with double-submit CSRF (the maintained `csrf-csrf`
  // package; `csurf` is deprecated). Mount it ONLY on the cookie-bearing
  // routes, never on the bearer-token API surface, and update this block.
  // ─────────────────────────────────────────────────────────────────────────
  app.enableCors({
    origin: Env.CORS_ORIGINS,
    credentials: false,
    exposedHeaders: ['x-correlation-id'],
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );
  app.useGlobalInterceptors(new CorrelationIdInterceptor(), new MetricsInterceptor());
  app.useGlobalFilters(new AllExceptionsFilter());
  app.setGlobalPrefix('api/v1', { exclude: ['health', 'metrics'] });

  if (Env.NODE_ENV !== 'production') {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('Nockta Flow API')
      .setDescription('Internal engineering operations platform.')
      .setVersion('0.1.0')
      .addBearerAuth()
      .build();
    const doc = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('docs', app, doc, {
      swaggerOptions: { persistAuthorization: true },
    });
  }

  // Socket.IO with Redis adapter for horizontal scaling
  const ioAdapter = new RedisIoAdapter(app);
  await ioAdapter.connectToRedis();
  app.useWebSocketAdapter(ioAdapter);

  app.enableShutdownHooks();
  await app.listen(Env.PORT);
  // intentional — boot log
  // eslint-disable-next-line no-console
  console.log(`API listening on :${Env.PORT}`);

  // Loud, scary log if the dev-auth backdoor is open. Visible at every boot
  // so an ops engineer SSHing into a misconfigured instance spots it before
  // an attacker does. The warning fires in EVERY environment — dev-auth in
  // production is sometimes a deliberate temporary measure (e.g., poking at
  // a fresh deploy before Google OAuth is wired), and the warning is loudest
  // exactly when that posture has been forgotten about.
  if (Env.DEV_AUTH_ENABLED) {
    console.warn(
      `⚠️  DEV_AUTH_ENABLED=true (NODE_ENV=${Env.NODE_ENV}) — dev login endpoints ` +
        '(POST /auth/dev-login) are active and accept arbitrary persona ' +
        'requests without OAuth. Disable by setting DEV_AUTH_ENABLED=false ' +
        'or unsetting it.',
    );
  }
  logIntegrationStatus();
}

/**
 * Print a compact integration banner at boot so the operator can spot at a
 * glance which optional features are active in this deployment. Anything
 * marked DISABLED is silent at runtime — if you expected it to be on, this
 * is the line that will tell you why a feature is no-op.
 */
function logIntegrationStatus(): void {
  const on = (v: unknown) => (v ? 'ENABLED ' : 'disabled');
  const lines = [
    `  LLM provider     : ${Env.LLM_PROVIDER}${Env.LLM_PROVIDER === 'anthropic' ? (Env.ANTHROPIC_API_KEY ? '' : ' (NO API KEY!)') : ` @ ${Env.OLLAMA_URL}`}`,
    `  Sentry           : ${on(Env.SENTRY_DSN)}`,
    `  GitHub App       : ${on(Env.GITHUB_APP_ID && Env.GITHUB_APP_PRIVATE_KEY)}${Env.GITHUB_APP_SLUG ? ` (slug=${Env.GITHUB_APP_SLUG})` : ''}`,
    `  Google Chat bot  : ${on(Env.GOOGLE_CHAT_SERVICE_ACCOUNT_JSON && Env.GOOGLE_CHAT_APP_ID)}`,
    `  SMTP (magic link): ${Env.SMTP_HOST}:${Env.SMTP_PORT}${Env.SMTP_USER ? ' (authed)' : ' (unauthed)'}`,
    `  Elasticsearch    : ${on(Env.SEARCH_ELASTIC_URL)}${Env.SEARCH_ELASTIC_URL ? '' : ' — using Postgres FTS'}`,
    `  Qdrant           : ${Env.QDRANT_URL}`,
    `  S3 storage       : ${Env.S3_ENDPOINT} (bucket=${Env.S3_BUCKET})`,
    `  Metrics          : ${on(Env.PROMETHEUS_METRICS_ENABLED)}`,
    `  CORS origins     : ${Env.CORS_ORIGINS.join(', ')}`,
  ];
  // intentional — boot log
  // eslint-disable-next-line no-console
  console.log(`\n[boot] integration status (NODE_ENV=${Env.NODE_ENV}):\n${lines.join('\n')}\n`);
}

void bootstrap();
