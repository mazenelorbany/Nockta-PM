# Operator runbook

For operators on call. Assumes Railway is the deploy target; concepts port to any host.

Related: [`HANDOVER.md`](../../HANDOVER.md) for the full deploy playbook, [`env.md`](env.md) for environment-variable reference.

---

## Health checks

### `GET /health` — fast liveness probe

- What it does: pings Postgres only.
- What to expect: `200 OK`, JSON body `{"status":"ok","info":{"postgres":{"status":"up"}}}`.
- Used by: Railway's healthcheck (this is what determines container ready / restart).
- Diagnose failures: 503 means Postgres is unreachable. Check `DATABASE_URL`, the Postgres service status on Railway, and the connection-limit metric in the dashboard.

### `GET /health/deep` — full dependency probe

- What it does: pings Postgres + Redis + S3 + Qdrant + LLM provider in parallel, each bounded by a 2 s timeout.
- What to expect: `200 OK` with per-dep `status: "ok"`. A degraded dep returns its own error message; the overall response is still 200 if at least one critical dep is healthy. (Postgres + Redis are critical; others are best-effort.)
- Used by: external uptime monitors, manual triage.
- Diagnose failures:
  - `postgres: down` → check `DATABASE_URL`, plugin health, connection saturation.
  - `redis: down` → check `REDIS_URL`, plugin health. Note: Redis down means queues, sessions, schedulers, and Socket.IO all stop working — this is a P1.
  - `s3: down` → check `S3_ENDPOINT`, credentials, bucket existence. Attachment upload/download will fail; rest of app works.
  - `qdrant: down` → AI features (duplicate detection, embeddings) will fail; rest works.
  - `llm: down` → AI chat features fail. Provider-specific; check `LLM_PROVIDER` and the corresponding API key.

### `GET /metrics` — Prometheus scrape

- HTTP request counter (`http_requests_total`) labeled by method/route/status.
- Duration histogram (`http_request_duration_seconds`) p50/p95/p99 by route.
- Process metrics (CPU, RSS, event-loop lag) via `prom-client`.
- Excluded from auth and the global rate-limit guard.

### Sentry

If `SENTRY_DSN` is set, unhandled exceptions and tagged warnings go to Sentry with `correlationId` from the `CorrelationIdInterceptor`.

---

## Database migrations

### Running

```bash
# Development
pnpm db:migrate                 # prisma migrate dev — creates new migration if schema diverged
pnpm db:generate                # regenerate client without applying migrations

# Production / staging
pnpm --filter @nockta/api prisma:deploy
```

On Railway, `prisma migrate deploy` runs automatically as step 1 of `apps/api/scripts/start.sh`. A failed migration halts boot (Railway will restart per `restartPolicyType: ON_FAILURE`), which is the correct behaviour — never serve traffic against a half-migrated DB.

### Companion SQL

Immediately after `migrate deploy`, the start script runs `psql --single-transaction --set ON_ERROR_STOP=1 -f prisma/migrations/companion.sql`. This applies the seven features Prisma cannot express (partial unique indexes, check constraints, tsvector, partitioning, materialized views). Idempotent — safe to re-run on every boot.

### Rolling back a migration

Prisma has no `migrate undo`. The procedure is manual and deliberately friction-laden:

1. **Stop deploys.** Pause CI / disable auto-deploy on Railway.
2. **Take a fresh `pg_dump`** of the current state (see Backups below). This is your safety net if the rollback goes wrong.
3. **Write a reverse migration.** Create a new Prisma migration that undoes the bad one:
   ```bash
   pnpm --filter @nockta/api prisma migrate dev --name revert_<original_name> --create-only
   ```
   Edit the generated SQL to be the inverse of the bad migration (drop the added column, restore the dropped index, etc.).
4. **Apply locally**, run the test suite, confirm the schema matches what production looked like before the bad migration.
5. **Deploy the reverse migration** through the normal CI path.
6. **Mark the original migration as rolled-back** in `_prisma_migrations` only if it has already been applied and you need Prisma to forget it (rare; usually preferred to leave the audit trail).

Never edit a migration that has been applied in production. Always write a new reverse migration.

---

## Queue management

### BullMQ Web UI

In dev / staging: Bull Board is mounted at `/admin/queues` and gated by `@Roles('Admin')`. Production deploys may omit it; if so, use the CLI:

```bash
pnpm --filter @nockta/api exec tsx scripts/queue-inspect.ts <queue-name>
```

### Paused queues

A queue can be paused by setting the Redis flag manually:

```bash
redis-cli -u "$REDIS_URL" SET "bull:{notification}:paused" "true"
```

Use sparingly; paused queues block delivery. Resume:

```bash
redis-cli -u "$REDIS_URL" DEL "bull:{notification}:paused"
```

### Retry semantics

| Queue              | Attempts | Backoff (starting)   |
|--------------------|----------|----------------------|
| `notification`     | 3        | exponential, 5 s     |
| `web-push`         | 3        | exponential, 5 s     |
| `outbound-webhook` | 5        | exponential, 10 s    |
| `attachment-scan`  | 3        | fixed, 30 s          |
| `attachment-thumb` | 3        | exponential, 5 s     |
| `ai-embed`         | 3        | exponential, 5 s     |
| `import`           | 1        | n/a (checkpointed)   |

Failed-after-retries jobs land in the `failed` set; we log + Sentry-report and leave them there for manual triage (do not auto-discard).

---

## Redis

### Connection limits

Each API replica opens:

- 1 client for the cache / session layer (`SessionService`, `SchedulerLockService`, integration nonces).
- 2 clients for the Socket.IO Redis adapter (pub + sub).
- 1 client per BullMQ queue connection (BullMQ multiplexes shared usage).

Railway's Redis plugin defaults to 256 connections. We're nowhere near the limit, but if you bump replicas dramatically, check `CLIENT LIST | wc -l`.

### Cache eviction policy

We don't set `maxmemory-policy` explicitly — the plugin default is `noeviction`. If memory pressure becomes an issue, switch to `allkeys-lru`. Today the dataset is bounded:

- Sessions: keyed on JTI, TTL = `JWT_ACCESS_TTL_SECONDS` (default 900 s).
- Magic-link nonces: TTL = `MAGIC_LINK_TTL_SECONDS` (900 s).
- Scheduler locks: short TTLs (90 s – 60 min, per `HANDOVER.md §5`).
- Integration status banner: 60 s.

### What gets cached

- **Sessions / JTI revocation list** — `session:{jti}` (value: user-id or `revoked` flag).
- **Magic-link tokens** — `magic-link:{hash}` → user-id, single-use, deleted on verify.
- **GitHub install nonces** — `github:install:nonce:{state}` → workspace-id, 5 min TTL.
- **Integration banner** — `boot:integrations` → JSON status, 60 s TTL.
- **Scheduler locks** — `lock:sched:{key}` → random token, per-job TTL.
- **BullMQ** — `bull:{queue}:*` (BullMQ internal).
- **Socket.IO adapter** — `socket.io#*` (adapter internal).

Nothing user-facing is cached by URL; the cache is operational state, not a content cache.

---

## S3

### Bucket configuration

Two buckets, configured via `S3_BUCKET` and `S3_QUARANTINE_BUCKET`:

- `nockta-flow-prod` — live attachments. Public access disabled. Lifecycle rule: nothing — files survive until the soft-delete cleanup purges them.
- `nockta-flow-quarantine` — uploads land here first. AV scan moves clean files to live, deletes infected. Lifecycle rule: delete objects older than 7 days (catches scan failures).

CORS must allow the web origins (`APP_URL_INTERNAL`, `APP_URL_CLIENT`) on `PUT` (for signed-URL uploads) and `GET` (for signed-URL downloads). The exact policy is documented in [`HANDOVER.md`](../../HANDOVER.md).

### Signed URL expiry

- **Upload (PUT):** 10 minutes. The client has 10 min to complete the upload after the signed URL is issued.
- **Download (GET):** 5 minutes for inline / preview, 60 minutes for explicit download (thumbnail, attachment file). Configurable in `attachments.service.ts`.

Signed URLs include the `Content-Type` header in the signature; the client must use the exact `Content-Type` it presented at signing time.

### Attachment lifecycle

```
Upload → quarantine bucket → attachment-scan queue → ClamAV
                                                     │
                            ┌────────────────────────┴────────────────────────┐
                            ▼                                                 ▼
                  Clean: move to live bucket,                    Infected: delete from quarantine,
                  set status='ready',                            set status='infected',
                  trigger thumb generation                       notify uploader
```

Soft-delete: `Attachment.deletedAt` is set on `DELETE`. The `maintenance:tick` scheduler (hourly) purges S3 objects + DB rows for attachments soft-deleted > 30 days ago, in batches of 100.

---

## Backups

### Schedule

- **Postgres**: `pg_dump` nightly at 02:00 UTC via the Railway Postgres plugin's built-in backup. Retention: 7 daily + 4 weekly + 3 monthly.
- **S3 / R2**: object versioning enabled on the production bucket; versions kept for 30 days. R2 also supports a separate destination bucket for disaster-recovery replication if compliance ever requires it.
- **Redis**: not backed up. State is ephemeral (sessions, locks, queues). A Redis loss means queued jobs lose their state — acceptable given the volumes.

### Restore procedure

Postgres point-in-time restore (Railway):

1. Open the Postgres plugin in the Railway UI.
2. "Backups" tab → select a snapshot → "Restore to new database".
3. Wait for the new DB to provision (5–10 min for ~10 GB).
4. Repoint `DATABASE_URL` on the `api` service to the restored DB.
5. Redeploy the `api` service. `start.sh` will run `migrate deploy` + `companion.sql` — both are idempotent.
6. Verify `/health/deep` and a smoke set of read paths before reopening to users.

Total expected time: **20–30 minutes** for a clean restore on a ~10 GB DB.

S3 restore: per object, via the bucket's "previous versions" UI or `aws s3api list-object-versions` + `restore-object`.

---

## Common incidents

### "API is down"

1. Check `/health` from a probe outside Railway.
2. If 5xx or timeout, check Railway logs: `[start] step N/3` lines show where boot is stuck.
3. If boot is past `step 3/3 — starting NestJS on :3000`, hit `/health/deep` and look at the per-dep status.
4. Common causes, in rough order of frequency:
   - **Redis down** → check the Redis plugin; the API hard-depends on Redis for sessions and queues, so this is fatal.
   - **Postgres connection saturation** → check `pg_stat_activity` count vs. the plugin's max. Bounce the `api` service to release leaked connections.
   - **OOM** → Railway will restart on OOM. Check process memory in the dashboard; if RSS climbs over multiple restarts there's a leak — page Engineering.
   - **Migration failure** → `step 1/3` failure. Inspect `_prisma_migrations` table and the failing migration's SQL.

### "Webhooks not firing"

The user-configured outbound webhooks aren't reaching their destination.

1. Find the `OutboundWebhook` record by id or by `targetUrl`.
2. Check `failureCount`. If it's incrementing, the queue is firing but the destination is rejecting. Inspect the last delivery's response in the BullMQ failed set.
3. Check queue depth: `redis-cli -u $REDIS_URL XLEN bull:outbound-webhook:wait`. A growing wait list means workers are slow or paused.
4. Common causes:
   - **Destination is returning non-2xx** — the user changed their endpoint. The webhook is correctly retrying.
   - **HMAC signature mismatch** — the user changed their `secret`. Failed deliveries should be diagnosable from response body.
   - **Queue paused** (see Redis flag above).

### "Imports stuck"

A user kicked off a Jira / Linear import and it's not progressing.

1. Find the `ImportRun` row by `userId` or `workspaceId`. Inspect `status` and `cursor` fields.
2. `status: 'running'` with a stale `updatedAt` → worker likely crashed mid-run. The import is checkpointed; resume with:
   ```bash
   pnpm --filter @nockta/api exec tsx scripts/resume-import.ts <importRunId>
   ```
   This reads the cursor and continues from the last successful batch.
3. `status: 'failed'` → check `errorMessage`. Most failures are upstream rate-limit (Jira) or auth (token expired). User must re-authenticate.
4. `status: 'completed'` but the user "doesn't see anything" → confirm they're looking at the right project; partial-completed imports write their results progressively.

### "AI cost spike"

The `AiUsageEvent` table is showing more spend than expected.

1. Query the daily / weekly aggregate: `SELECT workspaceId, SUM(tokensIn + tokensOut) FROM "AiUsageEvent" WHERE "createdAt" > NOW() - INTERVAL '7 days' GROUP BY 1 ORDER BY 2 DESC LIMIT 10;`.
2. If a single workspace is dominating, check `WorkspaceAiSettings.monthlyTokenCap` — was it bumped recently?
3. Spike sources to look at:
   - **Embedding burst** — someone re-ran `/ai/embed-all` on a workspace with many tasks. One-off.
   - **Duplicate detection loop** — a task with very generic text matching many neighbours; check the `ai-cron:blockers-nightly` scheduler's logs.
   - **Compromised account** — unusual usage from one user; revoke their session (`POST /auth/sessions/revoke-all`) and rotate JWT secrets if it looks bad.
4. Lower `WorkspaceAiSettings.monthlyTokenCap` for the offending workspace and notify Admin.

---

## Escalation

- **P1 (data loss, full outage)** — page Engineering on-call.
- **P2 (degraded — AI down, integrations not delivering)** — file a ticket, notify in `#nockta-ops`.
- **P3 (slow, individual user issue)** — file a ticket, follow up async.

Sentry alerts route to `#nockta-alerts`; the Grafana dashboard (`infra/grafana/dashboards/api-overview.json`) is the single pane of glass for RPS / error rate / latency.
