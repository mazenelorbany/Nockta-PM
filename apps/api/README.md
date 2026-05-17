# @nockta/api

The Nockta Flow backend. NestJS 10 + Prisma 5 + Postgres + Redis + S3 + Socket.IO + BullMQ. Single deployable process that hosts the REST API, the WebSocket gateway, all BullMQ workers, and all schedulers.

See also: [`/README.md`](../../README.md) for the project overview, [`/docs/architecture.md`](../../docs/architecture.md) for the full architecture, [`/docs/operations/runbook.md`](../../docs/operations/runbook.md) for ops, [`/HANDOVER.md`](../../HANDOVER.md) for Railway deploy details.

---

## Running

```bash
# Install (from repo root)
pnpm install

# Dev server with hot-reload
pnpm --filter @nockta/api dev          # rimraf dist && nest build && nest start --watch
# or, with the full docker stack:
pnpm dev                                # from repo root, starts API + supporting services

# Production-style start (uses pre-built dist/)
pnpm --filter @nockta/api build
pnpm --filter @nockta/api start         # node dist/main.js

# Debug mode (Node inspector on :9229)
pnpm --filter @nockta/api start:debug
```

The API binds to `http://localhost:3000` and mounts everything under `/api/v1` except `/health` and `/metrics` (`setGlobalPrefix` in `main.ts`).

In non-production, Swagger UI is at `/docs`.

---

## Testing

```bash
pnpm --filter @nockta/api test          # vitest run
pnpm --filter @nockta/api test:watch    # vitest --watch

# Lint + typecheck
pnpm --filter @nockta/api lint
pnpm --filter @nockta/api typecheck
```

Test conventions:

- **Unit tests** colocated next to the source: `tasks.service.ts` ↔ `tasks.service.test.ts`. Use `Test.createTestingModule` from `@nestjs/testing` for DI; mock external services (Prisma, Redis, S3) at the provider boundary.
- **Integration tests** live under `apps/api/test/` (when added). They run against a test Postgres + Redis brought up via `docker compose -f infra/docker-compose.test.yml`.
- **Test database isolation**: each integration test gets its own schema via a `BEGIN; ... ROLLBACK;` envelope or a per-test `truncate` strategy.
- **No live network in unit tests.** GitHub / Chat / SMTP / LLM calls are stubbed via the service interface.
- **Coverage**: aim for ≥ 80% line coverage on `*.service.ts` files. Controllers are thin; their coverage is incidental from integration tests.

Notable existing tests:

- `tasks/workflow.test.ts` — workflow transition validation.
- `permissions/permissions.service.test.ts` — `effectiveRole` matrix.
- `automations/automations.service.test.ts` — automation rule evaluation.
- `maintenance/digest.scheduler.test.ts` — scheduler-lock + digest-batching.
- `github/github-webhook.controller.test.ts` — HMAC verification + parser.
- `labels/labels.service.test.ts` — label CRUD + workspace scoping.
- `deployments/deployments.service.test.ts` — provider adapters.
- `attachments/attachments.service.test.ts` — quarantine flow + signed URLs.
- `projects/projects.service.test.ts` — visibility + access grants.

---

## Migrations & Prisma

```bash
# Apply schema changes (creates a new migration in apps/api/prisma/migrations)
pnpm db:migrate                          # from repo root → prisma migrate dev
# Apply existing migrations without prompting (CI / prod)
pnpm --filter @nockta/api prisma:deploy

# Regenerate the Prisma client without applying migrations
pnpm db:generate

# Open Prisma Studio
pnpm db:studio
```

**Always** run `migrate dev` against a local Postgres. **Never** edit a committed migration that has been applied to production — write a new reverse migration instead (procedure in [`runbook.md`](../../docs/operations/runbook.md#rolling-back-a-migration)).

After every migration, also re-run the companion SQL locally to verify it still applies cleanly:

```bash
psql "$DATABASE_URL" --single-transaction --set ON_ERROR_STOP=1 \
  -f apps/api/prisma/migrations/companion.sql
```

In production, `apps/api/scripts/start.sh` runs `prisma migrate deploy` then `companion.sql` automatically on boot.

### Seeding

```bash
pnpm --filter @nockta/api prisma:seed    # tsx prisma/seed.ts
```

Creates a default workspace, admin user, sample projects, and a few tasks. Safe to re-run; idempotent on `email`.

### Wipe local data

```bash
pnpm --filter @nockta/api wipe:local
```

Drops application tables (preserves migration metadata). Refuses with `NODE_ENV=production`. Use after schema-breaking experiments.

---

## Module structure

The codebase is organised by domain under `apps/api/src/modules/`. Every module follows the same shape:

```
modules/<feature>/
  <feature>.module.ts        ← Nest module definition
  <feature>.controller.ts    ← HTTP controller
  <feature>.service.ts       ← business logic (the part with tests)
  dto/                       ← class-validator DTOs
  <feature>.service.test.ts  ← unit tests
  (processors / schedulers / listeners as needed)
```

### Current modules (~45)

| Domain | Modules |
|---|---|
| Auth | `auth` (Google OAuth + magic-link + JWT), `permissions` |
| Workspace | `workspace`, `users`, `teams` |
| Project work | `projects`, `tasks`, `sprints`, `comments`, `attachments`, `labels`, `worklog`, `goals`, `docs`, `saved-views`, `recurrence`, `task-templates`, `custom-fields` |
| Observability | `events` (timeline + audit-log), `analytics`, `dashboards` |
| Realtime | `realtime` (Socket.IO gateway + broadcaster) |
| Notifications | `notifications`, `web-push`, snooze, mutes, preferences |
| Integrations | `github`, `chat` (Google Chat), `deployments`, `outbound-webhooks`, `import` |
| AI | `ai` (Qdrant + LLM dispatcher + cron) |
| Maintenance | `maintenance` (schedulers), `automations` |
| Search | `search` (Postgres FTS + optional Elasticsearch) |
| Exports / client portal | `exports`, `client` |

### Cross-cutting

- `common/filters/all-exceptions.filter.ts` — global exception → ProblemJSON.
- `common/interceptors/correlation-id.interceptor.ts` — attaches `correlationId` to logs.
- `common/guards/identity-aware-throttler.guard.ts` — IP / user / auth-bucket throttling.
- `common/scheduling/scheduler-lock.service.ts` — Redis-backed leader election for in-process schedulers.
- `auth/guards/jwt-auth.guard.ts`, `auth/guards/roles.guard.ts` — global.
- `prisma/prisma.service.ts` — Prisma client with shutdown hook.
- `redis/redis.module.ts` — single `ioredis` client provider.
- `health/health.controller.ts`, `health/metrics.controller.ts`, `health/config.controller.ts` — operational endpoints.

### Conventions

- **Controllers stay thin.** No DB calls, no business logic — they validate input, call a service, format the response. Tests for controllers, if any, cover routing and DTO validation.
- **Services own the rules.** Workspace scoping, permission checks (via `PermissionsService`), state-machine validation, and Prisma writes live here. Service methods accept `workspaceId` as the first argument (see [`ADR-0007`](../../docs/adr/0007-workspace-service-layer-isolation.md)).
- **Events go through `EventEmitter2`.** Services emit (`'task.created'`, `'comment.posted'`, ...); event-writer + notification-dispatcher + realtime-broadcaster + AI-dispatcher subscribe. Don't add new fan-out call sites in services — emit and subscribe.
- **DTOs are the API contract.** Add a DTO under `dto/`, annotate with `class-validator`, export the type through `@nockta/types` if the frontend needs it.
- **Background work goes on a queue.** If a service method takes > 100 ms or hits an external API, enqueue it rather than awaiting it inline.
