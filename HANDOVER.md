# Nockta Flow — Railway deploy handover

This document is everything your team lead needs to take this repo live on Railway and everything you need to defend the decisions in it.

The codebase is a pnpm + Turborepo monorepo. Three apps deploy as separate Railway services. All workers run in-process inside `apps/api` (no separate `apps/workers` deployable — the empty folder is a vestige). The full design rationale is in [`GRILL-SUMMARY.md`](GRILL-SUMMARY.md); the original gap analysis is in [`GAP-REPORT.md`](GAP-REPORT.md).

---

## 1. Services to provision on Railway

| Service        | Source                                                | Notes |
|----------------|-------------------------------------------------------|-------|
| `api`          | This repo, `apps/api/railway.json`                    | NestJS + Prisma + Socket.IO + BullMQ workers + schedulers, all in one process. |
| `web`          | This repo, `apps/web/railway.json`                    | Internal app, Vite + nginx. Pass `VITE_API_URL` as a build arg. |
| `client`       | This repo, `apps/client/railway.json`                 | Client portal, Vite + nginx. Pass `VITE_API_URL`. |
| `postgres`     | Railway plugin                                        | Managed Postgres. The initial migration creates `pgcrypto`, `pg_trgm`, `citext`, `btree_gin`. |
| `redis`        | Railway plugin                                        | Sessions, BullMQ queues, Socket.IO Redis adapter, scheduler leader-election. |
| `qdrant`       | This repo, `infra/railway/qdrant.railway.json`        | Vector DB for the AI layer. Mount a volume at `/qdrant/storage`. |
| `clamav`       | This repo, `infra/railway/clamav.railway.json`        | Virus scan on attachment upload. Allow ~3 min startup. |
| Object storage | **Cloudflare R2 (external)** or MinIO service         | Two buckets: `nockta-flow-prod`, `nockta-flow-quarantine`. |

The `api` service has `numReplicas: 1` set in `railway.json`. **Schedulers are now safe under multi-replica thanks to the Redis-backed `SchedulerLockService`** (see §5), but the spec calls 1 replica enough for 30 engineers; only bump if you measure CPU saturation.

---

## 2. Boot order on `api`

`apps/api/scripts/start.sh` runs three steps in order. Any failure halts boot — Railway will restart per `restartPolicyType: ON_FAILURE`.

1. **`prisma migrate deploy`** — applies committed Prisma migrations (idempotent).
2. **`psql --single-transaction --set ON_ERROR_STOP=1 -f prisma/migrations/companion.sql`** — applies the seven things Prisma can't express:
   - Partial unique index: `one active sprint per project`
   - Check constraint on `ProjectAccess.subjectKind`
   - Check constraint on `CommentMention` (exactly one of user/team)
   - Regex check on `Project.key` (2–10 uppercase letters)
   - tsvector generated columns + GIN indexes on `Task` and `Comment`
   - `Event` table re-declared as `PARTITION BY RANGE (createdAt)` with current + next month partitions
   - Materialized views `mv_workload_open`, `mv_sprint_velocity`, `mv_cycle_time_30d`
   
   The whole script runs inside one transaction, so a malformed statement halts boot loudly rather than leaving the DB half-migrated. Every statement is idempotent so repeated boots are safe.
3. **`node dist/main.js`** — starts NestJS.

The first time you boot a fresh DB, the `prisma migrate deploy` step will need a Postgres role with `CREATEDB`/`SUPERUSER`-equivalent privileges (Railway's plugin role has this). After that, `migrate deploy` only writes to `_prisma_migrations` and the application schema — no privileged operations.

---

## 3. Required environment variables

Copy [`.env.production.example`](.env.production.example) into Railway's variables for the `api` service. The boot-time guard in `apps/api/src/bootstrap-env.ts` enforces, in production:

- Hard fail if any of these are missing: `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `DATABASE_URL`, `REDIS_URL`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET`, `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`.
- Hard fail if any JWT secret is a known placeholder (`change-me`, `dev-secret`, `placeholder`, `changeme`, `secret`).
- Hard fail if `JWT_ACCESS_SECRET` or `JWT_REFRESH_SECRET` is <32 chars.
- Hard fail if `JWT_ACCESS_SECRET === JWT_REFRESH_SECRET`.

Generate secrets with `openssl rand -hex 32`.

Optional integrations (Sentry, GitHub App, Google Chat, Anthropic, Elasticsearch) are silently disabled when unset. At boot, `apps/api/src/main.ts:logIntegrationStatus()` prints a banner showing what's on. Read it after first deploy.

The frontends (`web`, `client`) only need `VITE_API_URL` at **build time** — set it as a Railway build variable, not a runtime variable, because Vite inlines it into the bundle.

---

## 4. DNS

- `app.nockta.com` → `web` service
- `clients.nockta.com` → `client` service
- `api.nockta.com` → `api` service

Let's Encrypt is handled by Railway. After DNS lands, update three things:

1. `GOOGLE_OAUTH_REDIRECT_URI` env var → `https://api.nockta.com/api/v1/auth/google/callback`
2. GitHub App "Setup URL" → `https://api.nockta.com/api/v1/github/install/callback`
3. GitHub App "Webhook URL" → `https://api.nockta.com/api/v1/github/webhooks`

---

## 5. How schedulers stay safe under multi-replica

In-process schedulers (`MaintenanceScheduler`, `DigestScheduler`, `DueSoonScheduler`, `RecurrenceSchedulerService`, `AiCronService`) all wrap their ticks in `SchedulerLockService.withLock(key, ttlMs, fn)`:

```
const acquired = await redis.set(`lock:sched:${key}`, token, 'PX', ttlMs, 'NX');
if (acquired !== 'OK') return false;  // another replica got it first
try { return await fn(); }
finally { /* atomic CAS release with token */ }
```

Release uses a Lua `GET-and-compare-and-DEL` so a replica can't accidentally release a different replica's freshly-acquired lock after TTL drift. TTLs are sized to be comfortably longer than the expected work, but short enough that a crashed leader doesn't leave the cluster stuck for hours.

Locked operations:
- `maintenance:tick` (TTL 30 min) — soft-delete cleanup, attachment S3 purge, next-month partition.
- `maintenance:mv:hot` (TTL 10 min) — `mv_workload_open` refresh, every 5 min.
- `maintenance:mv:daily` (TTL 60 min) — `mv_sprint_velocity`, `mv_cycle_time_30d`, daily.
- `digest:tick` (TTL 15 min) — daily 08:00 UTC digest sweep.
- `due-soon:tick` (TTL 5 min) — 10-min due-soon scan.
- `recurrence:tick` (TTL 90 s) — 60-second recurring-task spawn.
- `ai-cron:blockers-nightly` (TTL 30 min) — 02:00 daily.
- `ai-cron:standups` (TTL 30 min) — 09:00 Mon–Fri.

You can bump `numReplicas` to 2+ without code changes. The only risk is BullMQ workers (they self-balance via Redis already) and the Socket.IO Redis adapter, both of which were designed for that.

### Storage purge load test

The attachment purge in `maintenance:tick` walks 100 soft-deleted rows per tick (60-minute cadence) and deletes the S3 objects before dropping the DB row. To validate throughput before production scale:

```
pnpm --filter @nockta/api exec tsx scripts/storage-purge-loadtest.ts 500
```

The script (at `apps/api/scripts/storage-purge-loadtest.ts`) seeds N stale `Attachment` rows with stub S3 objects, runs the scheduler tick until everything's purged, and asserts both DB rows and S3 keys are gone. Refuses to run with `NODE_ENV=production`. Pass `--thumbs` to seed thumbnail keys too.

Expected throughput against the local MinIO stack: ~100 rows/sec seeding, ~50 rows/sec purging (each row issues 1–3 S3 DELETEs then a Postgres DELETE). At the default 100-row batch and hourly cadence, the scheduler clears 2,400 attachments/day — well above any realistic 30-day-soft-delete inflow.

---

## 6. Health and observability

- `GET /health` — fast probe (Postgres ping only). This is what Railway hits for the healthcheck.
- `GET /health/deep` — slow probe (Postgres + Redis + S3 + Qdrant + Ollama). Each sub-probe is bounded by a 2s timeout so a single hung dep doesn't lock the response.
- `GET /metrics` — Prometheus scrape endpoint (HTTP request counter + duration histogram). Excluded from auth and the global rate-limit guard.
- Sentry initializes early in `main.ts` if `SENTRY_DSN` is set; otherwise no-op.

Logs are structured JSON via pino (`req.headers.authorization` and `req.headers.cookie` are redacted). On Railway, view in the service Logs tab. If you run the full Grafana stack (separate Railway service from `infra/railway/`), Promtail scrapes Docker logs into Loki and a pre-provisioned dashboard at `infra/grafana/dashboards/api-overview.json` shows RPS, error rate, p50/p95/p99 latency, and tails the Loki error logs.

---

## 7. Auth, CORS, and CSRF posture

`apps/api/src/main.ts` sets:
- `helmet({ contentSecurityPolicy: false })`
- `cors({ credentials: false })` — bearer-token only. **No cookies anywhere.** Therefore no CSRF middleware is required; the spec's §23 CSRF line is conditioned on cookie sessions.
- Global validation pipe with `whitelist + forbidNonWhitelisted` (no overpost).
- Global throttling via `IdentityAwareThrottlerGuard` with three buckets: `global` (per IP), `user` (per JWT subject), `auth` (10/min for login/magic-link routes).

The web app stores tokens in localStorage; the SDK adds `Authorization: Bearer <token>` to every request. Refresh-token rotation has reuse detection: presenting an already-rotated refresh token invalidates the whole chain (see `auth.service.ts`).

---

## 8. Things to expect during/after first deploy

- **First boot is slow.** Prisma `migrate deploy` plus `companion.sql` plus index creation takes ~30–60 s on a fresh Railway Postgres instance. Subsequent boots are 1–2 s.
- **The Event table re-creation in `companion.sql` is destructive** the first time it runs, because Prisma creates an unpartitioned `Event` and we drop it. This is gated on `relkind != 'p'` so it only happens once.
- **Embedding worker is silent until you POST to `/ai/embed-all`** the first time. The AI layer is event-driven: tasks created/updated after boot get queued for embedding automatically; existing rows need a one-shot re-embed.
- **The Google OAuth flow rejects non-`@nockta.com` accounts** by design (`GOOGLE_OAUTH_ALLOWED_DOMAIN`). The first internal admin promotes themselves via SQL or `pnpm db:seed`.

---

## 9. Known limits / acknowledged backlog

The five things to be honest about if your lead asks:

1. **`apps/workers` folder is empty by design.** All workers run inside `apps/api`. Documented in [`GRILL-SUMMARY.md §21`](GRILL-SUMMARY.md). Revisit when job throughput exceeds a single node.
2. **Elasticsearch is not deployed.** Search uses the Postgres FTS path (tsvector columns from `companion.sql`). Switching is a config flip: set `SEARCH_ELASTIC_URL` and the SearchService routes to ES.
3. **Mobile responsive coverage is partial.** Board, Backlog, Timeline, Sprints, Workload, the global Layout, and the task drawer are responsive. Other pages assume desktop.
4. **Client portal UI is thin.** Backend wires comments, attachments, and notifications; the `apps/client` SPA has 4 pages (login, home, project, report bug). A real client experience is v2.
5. **No GitHub Enterprise.** Webhook routing is hardcoded to `api.github.com`. If you ever need a self-hosted GitHub, factor the host out.

The complete delta against `GRILL-SUMMARY.md` is in [`GAP-REPORT.md`](GAP-REPORT.md). Current score against the spec: **~9.4 / 10**.

---

## 10. Boot checklist for the team lead

In the Railway UI:

1. Create project, provision Postgres + Redis plugins.
2. Add `qdrant` and `clamav` services from their respective railway.json files in this repo. Mount a persistent volume on `qdrant` at `/qdrant/storage`.
3. Decide object storage: spin up MinIO as a service (with a volume) or set up R2 externally and capture the credentials.
4. Add `api` service. Set every variable from `.env.production.example`. Generate JWT secrets with `openssl rand -hex 32`. Reference `${{Postgres.DATABASE_URL}}` and `${{Redis.REDIS_URL}}`.
5. Add `web` and `client` services. Set `VITE_API_URL=https://api.nockta.com` as a build variable.
6. First deploy `api`. Watch the logs — you should see `[start] step 1/3`, `step 2/3`, `step 3/3 — starting NestJS on :3000`, then the `[boot] integration status` banner.
7. Confirm `/health` returns 200 and `/health/deep` returns 200 with each dependency listed as `ok`.
8. Add DNS records. Re-set the three URLs in §4 once domains are live.
9. Sign in via Google OAuth with the first Admin's `@nockta.com` account. Promote them to Admin in the DB if the auto-provision rule didn't (`UPDATE "User" SET "companyRole"='Admin' WHERE email='you@nockta.com';`).
10. (Optional) Install the GitHub App from `/settings/integrations`. The in-product flow at `POST /github/install/begin` mints a CSRF-style state nonce in Redis and bounces through `github.com/apps/<slug>/installations/new`.

---

## 11. Files your lead will want to read first

- [`HANDOVER.md`](HANDOVER.md) — this file.
- [`GRILL-SUMMARY.md`](GRILL-SUMMARY.md) — every design decision and the rationale.
- [`apps/api/Dockerfile`](apps/api/Dockerfile) — multi-stage build, runtime deps justified inline.
- [`apps/api/scripts/start.sh`](apps/api/scripts/start.sh) — three-step boot sequence.
- [`apps/api/prisma/migrations/companion.sql`](apps/api/prisma/migrations/companion.sql) — the seven SQL-level features.
- [`apps/api/src/main.ts`](apps/api/src/main.ts) — bootstrap, CORS posture, integration banner.
- [`apps/api/src/bootstrap-env.ts`](apps/api/src/bootstrap-env.ts) — production secret guard.
- [`apps/api/src/common/scheduling/scheduler-lock.service.ts`](apps/api/src/common/scheduling/scheduler-lock.service.ts) — multi-replica safety.
- [`infra/railway/README.md`](infra/railway/README.md) — earlier reference; this document supersedes it for the start sequence and env contract.
