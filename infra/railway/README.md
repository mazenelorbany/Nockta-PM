# Railway deploy — Nockta Flow

> **For the canonical handover, read [`HANDOVER.md`](../../HANDOVER.md) and [`HANDOVER-QA.md`](../../HANDOVER-QA.md) at the repo root.** This file is kept for the per-service tables below and any specialized notes; the start-sequence + env-var contract live in the root handover docs.

## Services

Set up one Railway *project* with the following services:

| Service       | Source                                              | Notes |
|---------------|-----------------------------------------------------|-------|
| `api`         | This monorepo, `apps/api/railway.json`              | Builds via `apps/api/Dockerfile`. Runs `prisma migrate deploy` then starts NestJS. In-process BullMQ workers, Socket.IO with Redis adapter, scheduled crons. |
| `postgres`    | Railway plugin                                      | Provisions managed Postgres. The `pgcrypto`, `pg_trgm`, `citext`, `btree_gin` extensions are created by the initial migration. |
| `redis`       | Railway plugin                                      | Managed Redis — sessions, BullMQ queues, Socket.IO adapter, presence. |
| `qdrant`      | This monorepo, `infra/railway/qdrant.railway.json`  | Vector DB for the AI layer. Mount a persistent volume at `/qdrant/storage`. |
| `clamav`      | This monorepo, `infra/railway/clamav.railway.json`  | Virus scanner for uploaded attachments. Allow ~3-minute startup for signature DB. |

### Object storage

Two choices:

- **MinIO on Railway** — deploy `minio/minio` from the Marketplace; mount a persistent volume; configure two buckets (`nockta-flow-prod`, `nockta-flow-quarantine`).
- **Cloudflare R2 (recommended)** — set `S3_ENDPOINT`, `S3_REGION=auto`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` from R2; no egress fees.

### LLM provider

- **Ollama on Railway** — CPU-only inference is slow but works for embeddings and small completions. Add as a Docker service.
- **Anthropic API (recommended)** — set `LLM_PROVIDER=anthropic` + `ANTHROPIC_API_KEY`. The `LlmService` switches transparently.
  Embeddings still go through Ollama by default; if you don't want to host Ollama in prod, swap embeddings to Voyage AI in `apps/api/src/modules/ai/llm.service.ts` (~10 lines).

## Required environment variables

See `.env.example` at the repo root. Per Railway service:

| Variable                                  | api | qdrant | clamav |
|-------------------------------------------|:---:|:------:|:------:|
| `DATABASE_URL` (from Postgres plugin)     | ✓   |        |        |
| `REDIS_URL` (from Redis plugin)           | ✓   |        |        |
| `S3_*` (MinIO or R2)                      | ✓   |        |        |
| `QDRANT_URL` = `http://qdrant.railway.internal:6333` | ✓ |        |        |
| `CLAMAV_HOST` = `clamav.railway.internal`, `CLAMAV_PORT=3310` | ✓ |  |  |
| `OLLAMA_URL` / `ANTHROPIC_API_KEY`        | ✓   |        |        |
| `GOOGLE_OAUTH_*`                          | ✓   |        |        |
| `GITHUB_APP_*`                            | ✓   |        |        |
| `GOOGLE_CHAT_*`                           | ✓   |        |        |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` | ✓   |        |        |
| `SMTP_*` (Gmail SMTP via Workspace)       | ✓   |        |        |
| `APP_URL_INTERNAL`, `APP_URL_CLIENT`, `APP_URL_API` | ✓ |  |  |
| `CORS_ORIGINS`                            | ✓   |        |        |

## DNS

- `app.nockta.com` → web app service (serves both internal users and external clients)
- `api.nockta.com` → `api` service
- Both served with Let's Encrypt certs (Railway handles automatically)

## Migrations

The `api` service runs `apps/api/scripts/start.sh` on every boot, which does:

1. `prisma migrate deploy`
2. `psql --single-transaction --set ON_ERROR_STOP=1 -f apps/api/prisma/migrations/companion.sql`
3. `node dist/main.js`

`companion.sql` carries everything Prisma can't represent: Event-table partitioning, tsvector + GIN indexes, partial unique index for one-active-sprint, check constraints on `ProjectAccess` / `CommentMention`, regex constraint on `Project.key`, and the three analytics materialized views. The whole file is idempotent — every statement is gated on `IF NOT EXISTS` / `DROP CONSTRAINT IF EXISTS`.

## Monitoring

- Railway gives you logs + per-service metrics out of the box.
- For deeper observability, deploy `prom/prometheus`, `grafana/loki`, and `grafana/grafana`
  as additional services (the local `infra/docker-compose.yml` is your reference for
  configuration).

## Initial bootstrap checklist

See [`HANDOVER.md` §10](../../HANDOVER.md#10-boot-checklist-for-the-team-lead) for the up-to-date checklist.
