# Environment variable reference

Every env var consumed by Nockta Flow, grouped by service. The source of truth is `.env.example` (development defaults) and `.env.production.example` (production template); this file annotates and links them.

The API enforces required vars at boot via `apps/api/src/bootstrap-env.ts` — production refuses to start if any required var is missing, if any JWT secret is a known placeholder, if any JWT secret is < 32 chars, or if both JWT secrets are equal.

Generate secrets with `pnpm gen:secrets` (prints two random base64url secrets) or `pnpm gen:secrets --all` (also generates webhook HMAC secrets).

---

## Node / runtime

| Name | Purpose | Required | Default | Example | Consumed by |
|---|---|---|---|---|---|
| `NODE_ENV` | Runtime mode. Production triggers stricter bootstrap checks and disables `/docs`. | yes | `development` | `production` | `apps/api/src/bootstrap-env.ts`, `apps/api/src/main.ts` |
| `LOG_LEVEL` | pino log level | no | `debug` (dev) / `info` (prod) | `info` | `apps/api/src/main.ts` |
| `DEV_AUTH_ENABLED` | Enables `/auth/dev/*` shortcuts (persona login, login-as). Ignored when `NODE_ENV=production`. | no | `false` | `true` | `apps/api/src/modules/auth/auth.controller.ts` |
| `OTEL_SERVICE_NAME` | Service label for OpenTelemetry exporters | no | `nockta-api` | `nockta-api` | `apps/api/src/main.ts` |
| `PROMETHEUS_METRICS_ENABLED` | Toggle `/metrics` endpoint | no | `true` | `true` | `apps/api/src/health/metrics.controller.ts` |

## Database (Postgres)

| Name | Purpose | Required | Default | Example | Consumed by |
|---|---|---|---|---|---|
| `DATABASE_URL` | Postgres connection string (pooled) | **yes** | — | `postgresql://nockta:pw@host:5432/nockta_flow?schema=public` | `apps/api/prisma/schema.prisma`, `apps/api/src/prisma/prisma.service.ts` |
| `DATABASE_DIRECT_URL` | Direct (non-pooled) Postgres URL used by Prisma migrations | yes | same as `DATABASE_URL` | `postgresql://nockta:pw@host:5432/nockta_flow?schema=public` | `apps/api/prisma/schema.prisma` |

## Redis

| Name | Purpose | Required | Default | Example | Consumed by |
|---|---|---|---|---|---|
| `REDIS_URL` | Redis connection URL (queues, sessions, Socket.IO adapter, scheduler locks) | **yes** | — | `redis://default:pw@host:6379` | `apps/api/src/modules/redis/redis.module.ts` |

## Object storage (S3 / R2 / MinIO)

| Name | Purpose | Required | Default | Example | Consumed by |
|---|---|---|---|---|---|
| `S3_ENDPOINT` | S3-compatible endpoint URL | yes (omit for AWS S3) | — | `https://<accountid>.r2.cloudflarestorage.com` | `apps/api/src/modules/storage/storage.module.ts` |
| `S3_REGION` | Region label (required by aws-sdk; arbitrary for R2 / MinIO) | yes | `us-east-1` | `auto` | `storage.module.ts` |
| `S3_ACCESS_KEY` | Access key ID | **yes** | — | `nockta_minio` | `storage.module.ts` |
| `S3_SECRET_KEY` | Secret access key | **yes** | — | `nockta_minio_dev_pw` | `storage.module.ts` |
| `S3_BUCKET` | Production attachment bucket | **yes** | — | `nockta-flow-prod` | `apps/api/src/modules/storage/storage.service.ts` |
| `S3_QUARANTINE_BUCKET` | Pre-AV-scan upload bucket | yes | `nockta-flow-quarantine` | `nockta-flow-quarantine` | `apps/api/src/modules/attachments/attachments.service.ts` |
| `S3_FORCE_PATH_STYLE` | Use path-style URLs (required for MinIO) | no | `false` | `true` | `storage.module.ts` |

## Email (SMTP)

| Name | Purpose | Required | Default | Example | Consumed by |
|---|---|---|---|---|---|
| `SMTP_HOST` | SMTP server | yes (for magic links + notifications) | `localhost` | `smtp.gmail.com` | `apps/api/src/modules/auth/mail.service.ts` |
| `SMTP_PORT` | SMTP port | yes | `1025` | `465` | `mail.service.ts` |
| `SMTP_USER` | SMTP username | no (dev mailhog needs none) | — | `noreply@nockta.com` | `mail.service.ts` |
| `SMTP_PASSWORD` | SMTP password / app password | no (dev) / yes (prod) | — | `xxx` | `mail.service.ts` |
| `SMTP_FROM` | From header | yes | `Nockta Flow <noreply@nockta.com>` | `Nockta Flow <noreply@nockta.com>` | `mail.service.ts` |
| `SMTP_USE_TLS` | Enable TLS (use `true` for port 465) | no | `false` | `true` | `mail.service.ts` |

## Auth (JWT)

| Name | Purpose | Required | Default | Example | Consumed by |
|---|---|---|---|---|---|
| `JWT_ACCESS_SECRET` | HS256 secret for access tokens. ≥ 32 chars, not a placeholder. | **yes** | — | (`pnpm gen:secrets`) | `apps/api/src/modules/auth/auth.module.ts`, `apps/api/src/bootstrap-env.ts` |
| `JWT_REFRESH_SECRET` | HS256 secret for refresh tokens. ≥ 32 chars, ≠ access secret. | **yes** | — | (`pnpm gen:secrets`) | `auth.module.ts`, `bootstrap-env.ts` |
| `JWT_ACCESS_TTL_SECONDS` | Access token lifetime | no | `900` (15 min) | `900` | `auth.module.ts` |
| `JWT_REFRESH_TTL_SECONDS` | Refresh token lifetime | no | `2592000` (30 days) | `2592000` |  `auth.module.ts` |

## Google OAuth (internal user login)

| Name | Purpose | Required | Default | Example | Consumed by |
|---|---|---|---|---|---|
| `GOOGLE_OAUTH_CLIENT_ID` | OAuth 2.0 client ID | **yes** | — | `xxx.apps.googleusercontent.com` | `apps/api/src/modules/auth/strategies/google.strategy.ts` |
| `GOOGLE_OAUTH_CLIENT_SECRET` | OAuth 2.0 client secret | **yes** | — | `xxx` | `google.strategy.ts` |
| `GOOGLE_OAUTH_REDIRECT_URI` | Callback URL (must include `/api/v1/` prefix) | yes | `http://localhost:3000/api/v1/auth/google/callback` | `https://api.nockta.com/api/v1/auth/google/callback` | `google.strategy.ts` |
| `GOOGLE_OAUTH_ALLOWED_DOMAIN` | Allowlisted Google Workspace domain for internal users | yes | `nockta.com` | `nockta.com` | `google.strategy.ts` |

## Magic links

| Name | Purpose | Required | Default | Example | Consumed by |
|---|---|---|---|---|---|
| `MAGIC_LINK_TTL_SECONDS` | Lifetime of issued magic-link tokens | no | `900` | `900` | `apps/api/src/modules/auth/auth.service.ts` |
| `MAGIC_LINK_BASE_URL` | Frontend URL hosting `/auth/magic` | yes | `http://localhost:5174/auth/magic` | `https://clients.nockta.com/auth/magic` | `auth.service.ts`, `mail.service.ts` |

## AI providers

| Name | Purpose | Required | Default | Example | Consumed by |
|---|---|---|---|---|---|
| `LLM_PROVIDER` | `ollama` (dev) or `anthropic` (prod) | no | `ollama` | `anthropic` | `apps/api/src/modules/ai/ai.module.ts` |
| `OLLAMA_URL` | Local Ollama URL | yes (when `LLM_PROVIDER=ollama`) | `http://localhost:11434` | `http://localhost:11434` | `apps/api/src/modules/ai/embedding.service.ts` |
| `OLLAMA_MODEL` | Ollama model name | yes (when `LLM_PROVIDER=ollama`) | `llama3.2` | `llama3.2` | `embedding.service.ts` |
| `ANTHROPIC_API_KEY` | Anthropic API key | yes (when `LLM_PROVIDER=anthropic`) | — | `sk-ant-...` | `apps/api/src/modules/ai/ai-dispatcher.service.ts` |
| `ANTHROPIC_MODEL` | Anthropic model ID | yes (when `LLM_PROVIDER=anthropic`) | `claude-sonnet-4-6` | `claude-sonnet-4-6` | `ai-dispatcher.service.ts` |
| `AI_DUP_THRESHOLD` | Cosine similarity threshold for duplicate detection (0..1) | no | `0.85` | `0.9` | `ai-dispatcher.service.ts` |
| `QDRANT_URL` | Qdrant vector DB URL | yes (for AI features) | `http://localhost:6333` | `https://qdrant.internal:6333` | `apps/api/src/modules/ai/qdrant.service.ts` |
| `QDRANT_API_KEY` | Qdrant API key (optional in dev) | no | — | `xxx` | `qdrant.service.ts` |

## ClamAV

| Name | Purpose | Required | Default | Example | Consumed by |
|---|---|---|---|---|---|
| `CLAMAV_HOST` | ClamAV daemon host | yes (for attachments) | `localhost` | `clamav.internal` | `apps/api/src/modules/attachments/clamav.service.ts` |
| `CLAMAV_PORT` | ClamAV TCP port | yes | `3310` | `3310` | `clamav.service.ts` |

## GitHub App

| Name | Purpose | Required | Default | Example | Consumed by |
|---|---|---|---|---|---|
| `GITHUB_APP_ID` | GitHub App numeric ID | no (integration disabled when unset) | — | `123456` | `apps/api/src/modules/github/github-app.service.ts` |
| `GITHUB_APP_SLUG` | Public app slug (URL segment) | no | — | `nockta-flow` | `apps/web/src/pages/settings/IntegrationsPage.tsx` |
| `GITHUB_APP_PRIVATE_KEY` | App private key (PEM, single-line with `\n`) | yes (if `GITHUB_APP_ID` set) | — | `-----BEGIN RSA PRIVATE KEY-----...` | `github-app.service.ts` |
| `GITHUB_APP_WEBHOOK_SECRET` | HMAC secret for inbound webhooks | yes (if installed) | — | (`pnpm gen:secrets --all`) | `apps/api/src/modules/github/github-webhook.controller.ts` |
| `GITHUB_APP_CLIENT_ID` | OAuth client ID for installation flow | yes | — | `Iv1.xxx` | `apps/api/src/modules/github/github-install.controller.ts` |
| `GITHUB_APP_CLIENT_SECRET` | OAuth client secret | yes | — | `xxx` | `github-install.controller.ts` |
| `GITHUB_APP_INSTALLATION_ID` | Default installation ID (when single-tenant) | no | — | `123456` | `github-app.service.ts` |

## Google Chat App

| Name | Purpose | Required | Default | Example | Consumed by |
|---|---|---|---|---|---|
| `GOOGLE_CHAT_SERVICE_ACCOUNT_JSON` | Service account JSON (single line) | no (integration disabled when unset) | — | `{"type":"service_account",...}` | `apps/api/src/modules/chat/chat.service.ts` |
| `GOOGLE_CHAT_PROJECT_ID` | GCP project ID | yes (if integration on) | — | `nockta-chat` | `chat.service.ts` |
| `GOOGLE_CHAT_APP_ID` | Chat app numeric ID | yes (if integration on) | — | `xxx` | `chat.service.ts` |
| `GOOGLE_CHAT_INTERACTION_TOKEN_AUDIENCE` | Audience for verifying interaction tokens | yes (if integration on) | — | `nockta-flow` | `apps/api/src/modules/chat/chat-events.controller.ts` |

## Deployment webhooks

| Name | Purpose | Required | Default | Example | Consumed by |
|---|---|---|---|---|---|
| `DEPLOY_WEBHOOK_SECRET_VERCEL` | HMAC secret for Vercel deployment webhooks | no | — | (`pnpm gen:secrets --all`) | `apps/api/src/modules/deployments/deployment-webhook.controller.ts` |
| `DEPLOY_WEBHOOK_SECRET_RAILWAY` | HMAC secret for Railway deployment webhooks | no | — | (`pnpm gen:secrets --all`) | `deployment-webhook.controller.ts` |
| `DEPLOY_WEBHOOK_SECRET_GITHUB_ACTIONS` | HMAC secret for GitHub Actions deploys | no | — | (`pnpm gen:secrets --all`) | `deployment-webhook.controller.ts` |
| `DEPLOY_WEBHOOK_SECRET_GENERIC` | HMAC secret for generic deploy hook | no | — | (`pnpm gen:secrets --all`) | `deployment-webhook.controller.ts` |

## App URLs

| Name | Purpose | Required | Default | Example | Consumed by |
|---|---|---|---|---|---|
| `APP_URL_INTERNAL` | Internal web app URL (used in emails, Chat cards) | yes | `http://localhost:5173` | `https://app.nockta.com` | `apps/api/src/modules/auth/mail.service.ts`, chat card builders |
| `APP_URL_CLIENT` | Client portal URL | yes | `http://localhost:5174` | `https://clients.nockta.com` | `mail.service.ts` |
| `APP_URL_API` | API public URL (for OAuth redirects, webhook URLs) | yes | `http://localhost:3000` | `https://api.nockta.com` | `apps/api/src/main.ts`, OAuth strategy |

## CORS / rate limiting

| Name | Purpose | Required | Default | Example | Consumed by |
|---|---|---|---|---|---|
| `CORS_ORIGINS` | Comma-separated origins | yes | `http://localhost:5173,http://localhost:5174` | `https://app.nockta.com,https://clients.nockta.com` | `apps/api/src/main.ts` |
| `RATE_LIMIT_GLOBAL_PER_MIN` | Global per-IP throttle | no | `600` | `600` | `apps/api/src/common/guards/identity-aware-throttler.guard.ts` |
| `RATE_LIMIT_PER_USER_PER_MIN` | Per-JWT-subject throttle | no | `120` | `120` | `identity-aware-throttler.guard.ts` |

## Observability

| Name | Purpose | Required | Default | Example | Consumed by |
|---|---|---|---|---|---|
| `SENTRY_DSN` | Sentry project DSN | no | — | `https://xxx@sentry.io/xxx` | `apps/api/src/bootstrap-sentry.ts` |
| `LOKI_URL` | Loki ingestion URL (for log shipping when running the full Grafana stack) | no | — | `http://loki:3100` | infra config |

---

## Frontend (`apps/web`, `apps/client`)

Frontends only need build-time variables. Vite inlines `VITE_*` into the bundle, so set these as **build-time** variables on the host (not runtime env).

| Name | Purpose | Required | Default | Example | Consumed by |
|---|---|---|---|---|---|
| `VITE_API_URL` | API base URL | **yes** | `http://localhost:3000` | `https://api.nockta.com` | `apps/web/src/api/client.ts`, `apps/client/src/api/client.ts` |
| `VITE_SENTRY_DSN` | Optional frontend Sentry DSN | no | — | `https://xxx@sentry.io/xxx` | `apps/web/src/lib/sentry.ts` |

---

## Quick reference: secrets that must be generated, not copy-pasted

Run `pnpm gen:secrets --all` and put the output in your env:

- `JWT_ACCESS_SECRET`
- `JWT_REFRESH_SECRET`
- `GITHUB_APP_WEBHOOK_SECRET` (if integrating GitHub)
- `DEPLOY_WEBHOOK_SECRET_*` (per provider)

Anything else with the word "SECRET" or "KEY" should come from the upstream provider's console, not from `gen:secrets`.
