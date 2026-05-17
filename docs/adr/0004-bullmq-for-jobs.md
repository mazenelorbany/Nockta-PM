# ADR-0004: BullMQ for background jobs

- **Date:** 2025-02-08
- **Status:** Accepted

## Context

The API does several things asynchronously: notification delivery (email, web-push, outbound webhook), attachment virus-scan + thumbnail generation, AI embedding, scheduled maintenance (partition creation, materialized view refresh, soft-delete cleanup), recurring task spawning, digest delivery. We need:

- Retry / backoff with bounded attempts.
- Job persistence so a process restart doesn't lose work.
- Cron-style scheduling that survives multi-replica.
- Visibility (queue depth, failed jobs, retry counts).

Options:

- **Plain `setTimeout` / cron in-process** — no persistence, no retries, single-replica only. Non-starter.
- **node-cron + manual retry loop** — reinventing BullMQ poorly.
- **Cloud queue (SQS, Cloud Tasks)** — operationally simpler but couples us to a cloud provider and adds network latency for every fan-out.
- **BullMQ on Redis** — Redis-backed, mature, supports priorities / repeat / delayed / rate-limited jobs, has a web UI (`@bull-board/express`), integrates with NestJS via `@nestjs/bullmq`.
- **Temporal / Inngest** — overkill for our durability needs; another service to operate.

We already need Redis for sessions and the Socket.IO adapter, so BullMQ piggybacks without adding a new dependency.

## Decision

Use **BullMQ 5** for all background work. Queues live in-process inside `apps/api` (the `apps/workers` folder is empty by design; see `HANDOVER.md §9`). Each queue has:

- A typed processor class (`@Processor(name)`) registered as a Nest provider.
- Default attempts: 3 (5 for outbound webhooks). Exponential backoff starting at 5 s.
- Dead-letter via the `failed` event + alerting (Sentry).

Queues currently in use:

- `notification` — fanout for in-app + email + web-push delivery.
- `web-push` — VAPID push delivery.
- `outbound-webhook` — POST to user-configured endpoints with HMAC signing.
- `attachment-scan` — invoke ClamAV, move clean files from quarantine to live bucket.
- `attachment-thumb` — generate image thumbnails via sharp.
- `ai-embed` — compute and upsert task embeddings into Qdrant.
- `import` — Jira / Linear import runs (long-running, checkpointed).

Scheduled jobs run inside in-process schedulers (`@nestjs/schedule`), wrapped in `SchedulerLockService.withLock(key, ttl, fn)` — a `SET NX PX` lock with Lua CAS release — so they are safe under `numReplicas > 1`.

## Consequences

- **+** Single Redis dependency for queues, sessions, and Socket.IO scaling.
- **+** Retries and backoff are declarative on the queue definition.
- **+** Workers self-balance across replicas via Redis (BullMQ contract).
- **+** Visibility via Bull Board (gated behind admin auth in prod).
- **−** Redis is now a critical dependency for queue durability; we accept this.
- **−** Workers run in the same process as the API. Under sustained CPU load this can affect HTTP latency. Documented threshold in `HANDOVER.md`: revisit when sustained CPU > 60% on a single replica. The fix is splitting `apps/workers` back out.
- **−** Long-running jobs (imports) need to checkpoint so they survive a process restart; this is enforced by the `ImportRun.status` machine.
