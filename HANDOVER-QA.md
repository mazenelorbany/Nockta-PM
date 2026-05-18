# Handover Q&A — questions to expect and the answers

The team lead will probe for the things that bite first. This is the cheat sheet. Each answer points to the file you'd open to defend it.

---

## Deployment

**Q: How do migrations run on Railway?**
A: `apps/api/Dockerfile` `CMD` runs `apps/api/scripts/start.sh`, which does `prisma migrate deploy && psql -f prisma/migrations/companion.sql && node dist/main.js`. Idempotent on every boot. Failures halt boot so Railway restarts cleanly. The companion SQL applies the seven things Prisma can't express (partitioning, FTS, MVs, partial unique index for one-active-sprint, check constraints).

**Q: Why a shell script instead of letting `migrate deploy` handle everything?**
A: Prisma can't represent `PARTITION BY RANGE`, tsvector generated columns, partial unique indexes, or check constraints. `companion.sql` does. It's wrapped in `--single-transaction --set ON_ERROR_STOP=1` so a typo halts boot loudly. psql comes from the alpine image's `postgresql-client` package.

**Q: Is the Event table actually partitioned in prod?**
A: Yes — `companion.sql` drops Prisma's unpartitioned `Event` and recreates it with `PARTITION BY RANGE (createdAt)` plus initial-month + next-month partitions. The `MaintenanceScheduler.ensureNextMonthEventPartition()` creates the next month's partition on the hourly tick so we never miss a rollover.

**Q: What happens if the API has two replicas?**
A: Safe. Every scheduler tick wraps in `SchedulerLockService.withLock(key, ttlMs, fn)` — Redis `SET NX PX` with a unique token, atomic CAS-DEL release. Only one replica executes the body per scheduled window. BullMQ self-balances. The Socket.IO Redis adapter (already wired) handles cross-replica pubsub. The only thing that still says `numReplicas: 1` is the conservative default in `apps/api/railway.json` — change it freely.

**Q: How long does first deploy take?**
A: ~30–60 seconds. Prisma `migrate deploy` on fresh Postgres, then `companion.sql` builds indexes + materialized views. Subsequent boots are 1–2 s.

---

## Security

**Q: Where are secrets stored?**
A: Railway's secret store. No `.env` is committed for production; `.env.production.example` is the template. The `bootstrap-env.ts` guard refuses to boot in production if any of `JWT_*_SECRET`, `DATABASE_URL`, `REDIS_URL`, `S3_*`, `GOOGLE_OAUTH_*` are missing, placeholder, or weak.

**Q: How are JWT secrets validated?**
A: At process startup. Minimum 32 chars. They must differ from each other. Placeholder strings like `change-me` / `dev-secret` are rejected. The check fires before Nest even initializes.

**Q: What protects against CSRF?**
A: Nothing — and that's correct. The API is bearer-token only (`main.ts:36 — credentials: false`). No cookies anywhere. No CSRF surface to defend.

**Q: How do refresh tokens stay safe?**
A: Rotation with reuse detection. Every refresh issues a new pair, marks the old refresh as `rotatedTo`. Presenting an already-rotated token invalidates the whole chain — the user gets logged out and must sign in again. See `auth.service.ts` for the rotation logic and `session.service.ts` for the Redis-backed JTI revocation cache.

**Q: How are uploads scanned?**
A: Three-step signed-URL flow. `POST /attachments/sign` → client PUTs to MinIO/R2 → `POST /attachments/confirm` enqueues a BullMQ job that streams the object to ClamAV. Infected files get moved to the quarantine bucket and the row's `scanStatus` is set to `infected`. Executable extensions (`.exe`, `.bat`, `.sh`, `.dmg`, `.app`, `.jar`, `*.pdf.exe`-style) are blocklisted at the controller before the signed URL is even minted.

**Q: How are webhooks verified?**
A: HMAC-SHA256 with `timingSafeEqual` for GitHub and deployment webhooks; OAuth2Client.verifyIdToken for Google Chat. Raw body capture is enabled via `NestFactory.create(AppModule, { rawBody: true })` so signature comparison works on the exact bytes.

---

## Scaling

**Q: Where does this break first?**
A: Single API replica → CPU-bound. Postgres connections are pooled but the Event table grows unbounded (no retention by design — spec §8 explicitly says immutable history). At ~50 engineers + 100k tasks the workload MV refresh starts to noticeably slow.

**Q: What about Redis?**
A: One Redis instance handles BullMQ, sessions, the Socket.IO adapter, presence, and scheduler locks. Railway's plugin is sized fine for 30 users. If it ever hits 70%+ memory, the BullMQ completed-job retention is the cheap thing to lower.

**Q: Where do the BullMQ workers run?**
A: In-process inside `apps/api`. Conscious deviation from the original spec, which contemplated a separate `apps/workers` deployable; that folder was retired. At 30 engineers the operational cost of a second deployable doesn't pay for itself, and BullMQ + `@nestjs/schedule` are happy in-process. The day we measure sustained CPU > 60% on the `api` replica is the day we split them back out — until then, fewer moving parts.

**Q: Multiple sprints active at once — possible?**
A: No. `companion.sql` line 12: `CREATE UNIQUE INDEX sprint_active_per_project_unique ON "Sprint" ("projectId") WHERE state = 'active'`. The DB rejects a second active-sprint INSERT for the same project.

---

## Data integrity

**Q: What if companion.sql fails partway?**
A: It can't — the whole file runs inside one `--single-transaction`. Any error rolls back the entire script and boot halts. You see the failure in the Railway logs as the contents of `/tmp/companion.log`.

**Q: Attachments — what happens when a Comment is hard-deleted but the S3 object can't be reached?**
A: The Postgres row stays in place; the next hourly maintenance tick retries. Failed S3 deletes are logged with the attachment id. No row is dropped until every object (primary + thumb200 + thumb800) is gone. See `maintenance.scheduler.ts:purgeStaleAttachments`.

**Q: What's the retention story?**
A: Soft-delete for 30 days on Comments and Attachments, then hard-delete by the maintenance scheduler. Events are immutable — never deleted, partitioned by month so old data can be detached if you ever want to archive (spec §8 said "no retention" — keep it).

---

## Observability

**Q: How do I find out why something's failing in prod?**
A: Three layers: Railway service logs (structured JSON via pino, `req.headers.authorization` redacted), Sentry if `SENTRY_DSN` is set, and `/health/deep` for live dependency status. The boot-time integration banner in `main.ts` tells you at a glance which optional integrations are actually live.

**Q: Are there pre-built dashboards?**
A: Yes — `infra/grafana/dashboards/api-overview.json` is auto-loaded by the grafana service in `docker-compose.yml`. Panels: RPS, error rate %, p99 latency stat, WebSocket connections, requests-by-route timeseries, p50/p95/p99 latency lines, Loki-backed error log tail. Grafana datasource UIDs are wired (`prometheus`, `loki`) so the JSON is stable.

---

## Edge cases the lead might poke at

**Q: Two replicas, both fire the partition-creation tick. Which one wins?**
A: Whichever wins the Redis `SET NX`. The other gets `false` from `withLock` and skips silently. The DDL itself is `CREATE TABLE IF NOT EXISTS`, so even if both ran (they won't), it would be a no-op on the second.

**Q: User signs in, signs out everywhere, signs in again — does the new access token still get rejected by stale revocations?**
A: No. Revocations are keyed by JTI, not user. A fresh login mints a new JTI and a new pair. The Redis revocation cache only carries the previously-emitted JTIs.

**Q: Bearer-only API + Socket.IO with `credentials: true` — contradiction?**
A: No. Socket.IO uses the JWT in the handshake payload, not in a cookie. `credentials: true` on the WS endpoint is required by Engine.IO's polling transport for the initial upgrade; it doesn't make the API cookie-based.

**Q: GitHub App webhook arrives for an installation we don't have a row for. What happens?**
A: `installation.created` events create the row inside the webhook handler before any other event is processed. Out-of-order arrivals: the webhook handler does `upsert` on `installationId`, so a `push` event arriving before `installation.created` triggers an upsert anyway (with whatever account info is on the push event).

**Q: The in-product GitHub install flow — what if someone forges the callback URL?**
A: The `state` nonce is server-minted (Redis-resident, 24 bytes), single-use (Redis `GETDEL`), and TTL-bounded (10 min). A forged callback fails state validation and redirects to `/settings/integrations?error=state_mismatch`. The installation row itself only exists if GitHub's webhook fired with valid HMAC.

**Q: Rate limiter behavior under proxied IPs (Railway → app)?**
A: `IdentityAwareThrottlerGuard` namespaces by JWT subject when authenticated, falls back to `req.ip` when not. Railway sets `X-Forwarded-For` correctly and Express trusts the proxy in production (NestJS default). Ensure the express trust-proxy setting is enabled if you ever change `app.useGlobalPipes` order — currently it's implicit.

---

## What I would change if I had another sprint

Be honest:

1. Split BullMQ workers out into a separate deployable (a real `apps/workers`) so Redis pressure doesn't compete with HTTP. Trigger: sustained CPU > 60% on a single `api` replica.
2. Promtail config exists; the loop is fully wired (Grafana datasource UIDs, dashboards, scrape config). But I haven't validated it under Railway's networking. Worth a 1-hour sanity test.
3. CI/CD: there's a `.github/workflows/ci.yml` that runs typecheck + tests; no auto-deploy. Add a deploy stage that triggers Railway's deploy webhook on a push to `main`.
4. Mobile pass on the remaining 11 non-driver pages.
5. Replace the in-process embedding pipeline with a separate worker if Anthropic latency spikes — currently it shares the API event loop.
