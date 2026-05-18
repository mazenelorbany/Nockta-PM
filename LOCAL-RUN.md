# Nockta Flow — Run Locally

**TL;DR: `pnpm install && pnpm dev`.** That's it. Open <http://localhost:5173/login> and click "Sign in as admin (dev only)".

Quick path to a working local instance, signed in as Admin. ~5 minutes once Docker is warm.

## Prerequisites

- Node 20.6 or newer (`.nvmrc` is set to 20; the `process.loadEnvFile` API needs ≥20.6).
- pnpm 9 (`corepack enable && corepack prepare pnpm@9.12.0 --activate` if you don't have it).
- Docker Desktop running.

## One-time setup

From the repo root (`/Users/mazen/Documents/Work/pm`):

```bash
# 1. Install all workspace dependencies (api, web, client, workers, packages).
pnpm install

# 2. Generate the Prisma client (typed DB layer).
pnpm --filter @nockta/api prisma generate

# 3. Bring up Postgres, Redis, MinIO, ClamAV, Qdrant, Ollama, Mailhog, Prometheus, Loki, Grafana.
#    First boot pulls images and primes ClamAV signatures — give it ~2 minutes.
pnpm docker:up

# 4. Apply the Prisma schema to the dev database (creates all tables; no migration files written).
pnpm --filter @nockta/api prisma db push
```

The `apps/api/.env` is already in the repo with dev-friendly defaults. It uses the high ports the docker-compose file actually exposes (postgres `5433`, redis `6380`) — those don't match `.env.example`, which is wrong; ignore it.

## Run

In one terminal:

```bash
pnpm --filter @nockta/api dev
```

You should see `API listening on :3000`. Swagger is at <http://localhost:3000/docs>.

In a second terminal:

```bash
pnpm --filter @nockta/web dev
```

Vite serves the web app at <http://localhost:5173>. Internal users and
external clients use the same SPA; role-conditional UI hides surfaces a
given user can't act on.

## Log in

1. Open <http://localhost:5173/login>.
2. Click **"Sign in as admin (dev only)"** (the dashed-border button below "Continue with Google").
3. That hits `POST /api/v1/auth/dev-login`, which upserts `admin@nockta.com` as an internal Admin and mints a real token pair. You land on the dashboard.

The "Continue with Google" button still won't work until you set real `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` in `apps/api/.env` and register your redirect URI in Google Cloud Console. The dev-login flow doesn't need any of that.

## Common snags

- **`pnpm dev` errors immediately with `ECANCELED: operation canceled, read`** — This happens when a previous `pnpm dev` is still running (often in another terminal window). Two fixes:
  - **Easiest:** close any other terminal where a previous `pnpm dev` is still running.
  - **Bypass pnpm entirely:** run `bash scripts/dev.sh` directly. The script's pre-flight kills strays via `pkill`, then runs everything without any nested pnpm calls.
- **"prisma db push" fails with "Can't reach database server"** — Docker isn't up yet, or Postgres is still booting. `docker compose -f infra/docker-compose.yml ps` should show `nockta-postgres` healthy.
- **API exits at boot with a zod error listing missing env vars** — Make sure `apps/api/.env` exists (not just `.env` at the repo root). The Prisma CLI also reads from `apps/api/.env`, so don't move it.
- **`POST /auth/dev-login` returns 400** — `NODE_ENV` is set to `production` somewhere, or your email isn't on the `@nockta.com` domain. The service rejects both.
- **`apps/workers` was deleted** — workers now run in-process inside `apps/api` (see `CONTEXT.md` § "Non-obvious architectural choices"). If a stale `pnpm-lock.yaml` still references it, run `pnpm install` to refresh.
- **MinIO console** at <http://localhost:9001> (user `nockta_minio`, password `nockta_minio_dev_pw`) — useful for sanity-checking attachment uploads.
- **Mailhog UI** at <http://localhost:8025> — magic-link emails land here, not in a real inbox.

## What's running

| Service | Host port | Notes |
|---|---|---|
| `nockta-postgres` | 5433 | Main DB. |
| `nockta-redis` | 6380 | Sessions, BullMQ, Socket.IO adapter. |
| `nockta-minio` | 9000 (S3) / 9001 (console) | Attachments. |
| `nockta-clamav` | 3310 | Virus scan. Slow to boot. |
| `nockta-qdrant` | 6333 / 6334 | Vector DB. Only used by AI endpoints. |
| `nockta-ollama` | 11434 | LLM. Only used by AI endpoints. |
| `nockta-mailhog` | 1025 (SMTP) / 8025 (UI) | Magic-link delivery. |
| `nockta-prometheus` | 9090 | Metrics. |
| `nockta-grafana` | 3001 | Dashboards. `admin` / `admin`. |
| `nockta-loki` | 3100 | Log aggregation (no Promtail wired yet). |
| API | 3000 | NestJS. |
| Web | 5173 | React SPA — internal users and external clients. |

## Tearing down

```bash
pnpm docker:down            # stop containers (data volumes persist)
docker volume ls            # see them
docker volume rm nockta-flow_postgres_data  # nuke the DB if you want a fresh start
```

## Optional: only run what you need

The API technically only requires Postgres + Redis to boot and run the dev-login flow. ClamAV, Qdrant, Ollama, etc. are touched lazily.

```bash
docker compose -f infra/docker-compose.yml up -d postgres redis minio
```

is enough for the board + tasks + comments paths.
