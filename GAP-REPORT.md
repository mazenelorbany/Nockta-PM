# Nockta Flow — What's Built / Gap Report

Inventory of what's in the repo as of today, mapped against `GRILL-SUMMARY.md`. Each section: ✅ built, 🟡 partial / shaky, ❌ missing.

---

## TL;DR

The **backend is ~90% scaffolded with real implementation**, the **frontend is ~15%** (board + login + dashboard skeleton, that's about it), and the **workers app is empty** (the BullMQ processors live inside `apps/api`). The Prisma schema is complete and matches GRILL-SUMMARY, but **no actual migration SQL exists yet** — only a notes file — so the DB cannot be brought up by `prisma migrate deploy` today. The `apps/workers` folder is a package.json with no source.

The biggest functional gaps are: (1) UI surfaces for everything past the board, (2) generated migration SQL + the raw-SQL companion for partitions/FTS/check constraints, (3) the standalone workers app.

The biggest **deltas from spec** are conscious: Railway as the prod host, Anthropic API as a swappable LLM, R2 as the prod object store — all called out in `infra/railway/README.md`.

---

## Per-section status

### §1 Scope — single-tenant, single-workspace
- ✅ Schema and code never reference a Workspace entity. Confirmed.

### §2 Identity & auth
- ✅ `User` model with `kind` (internal/client), `companyRole`, `googleId`.
- ✅ Google OAuth strategy + callback + domain restriction (`GOOGLE_OAUTH_ALLOWED_DOMAIN`).
- ✅ Magic-link request/verify endpoints, hashed token in DB, TTL via env.
- ✅ JWT access + refresh, refresh-token rotation via `RefreshToken` model with `rotatedToId`.
- ✅ Redis-backed session/JTI revocation tracking (`SessionService`, used by `JwtAuthGuard` and the WebSocket gateway).
- ✅ `mail.service.ts` for sending magic links (Gmail SMTP / mailhog).
- ✅ `/auth/me`, `/auth/logout`.

### §3 Org model (Teams = groups, no Workspace)
- ✅ `Team` + `TeamMember` models.
- ✅ Teams CRUD + add/remove members endpoints.
- ✅ Multi-team membership allowed (composite PK).
- 🟡 "Only Admins create Teams" — need to verify the guard inside `TeamsService.create`; the controller doesn't gate it visibly. Worth checking.

### §4 Permissions
- ✅ Enums: `CompanyRole` (Admin/Member), `ProjectRole` (Manager/Contributor/Viewer/Client).
- ✅ `ProjectAccess` model supports `subjectKind = user | team` with role per grant. Composite check constraint documented in migration notes.
- ✅ `ProjectVisibility = public | teams | private` on `Project`.
- ✅ `PermissionsService.effectiveRole(actor, projectId)` is referenced from realtime, AI, deployments — implementation present at `permissions.service.ts`.
- ✅ Admin bypass: visible in `ai.controller.ts` summarize-sprint endpoint pattern.
- ✅ Clients-via-Teams disallowed — schema doesn't structurally enforce this, but `ProjectAccess` for clients is per-user by convention.
- ✅ Task-level `Visibility = internal | client_visible` default-secure.

### §5 Projects
- ✅ `Project.key` is unique, format check `^[A-Z]{2,10}$` documented in migration notes (raw SQL).
- ✅ `nextTaskNumber` counter on Project for per-project task keys.
- ✅ `workflowPreset` enum (engineering/design/generic), `sprintsEnabled` boolean, `githubAutoStatus` toggle.
- ✅ `chatSpaceId` + `chatBroadcastEvents` for per-project Chat broadcast.
- ✅ CRUD + access list/grant/revoke endpoints.
- ✅ Workflow definitions and transition validation in `apps/api/src/modules/tasks/workflow.ts` (paired with the per-preset status lists in `packages/types/src/enums.ts`).
- ✅ "Blocked is a flag, not a status" — `isBlocked` + `blockedReason` columns on Task; separate `PATCH /tasks/:id/blocked` endpoint.
- ❌ Project-level **Labels** model. GRILL-SUMMARY mentions filtering by labels in §17 search, and the brief lists labels in the Task schema, but there's no `Label` or `TaskLabel` table. **Either delete the requirement or add the model + endpoints.**

### §6 Task engine
- ✅ All schema fields from GRILL-SUMMARY §6 are present.
- ✅ Fractional indexing (`boardPosition` string), with a `/tasks/:id/reorder` endpoint accepting `before` / `after`.
- ✅ `parentTaskId` self-relation. Subtasks are full tasks. The "parent can't move to Done while children open" rule lives in `tasks.service.ts` (the controller exposes `changeStatus`; the service is what to verify).
- ✅ `TaskLink` table with `blocks`/`related`/`duplicate`, cross-project allowed.
- ✅ Watch/unwatch + mute/unmute endpoints + tables.
- ✅ `TaskGithubLink` typed table per the spec ("no custom metadata column").

### §7 Sprints
- ✅ `Sprint` model with state machine; partial unique index for "one active per project" documented in migration notes (must be applied as raw SQL).
- ✅ CRUD + start + complete (with `moveIncompleteTo` option).
- ✅ Burndown endpoint stub at `/analytics/sprints/:sprintId/burndown`.

### §8 Events / Activity timeline / Audit log
- ✅ `Event` table with composite PK `(id, createdAt)` to support partitioning.
- ✅ `event-writer.service.ts` writes events; `events.service.ts` exposes timeline + audit-log queries.
- ✅ Separate `TimelineController` and `AuditLogController`.
- ✅ Indexes in Prisma match the spec; partial index for `admin_only` documented in migration notes.
- 🟡 **Partitioning is not actually set up.** The notes file at `prisma/migrations/0001_init/migration.sql.notes.md` documents the raw SQL but there's no executable migration. **Run before any production data lands.**
- ❌ **Monthly partition-creation cron** — GRILL-SUMMARY says `apps/workers` runs this. `apps/workers` has no source. Currently no scheduled job will create the next month's partition.

### §9 Realtime
- ✅ NestJS WebSocket gateway with Redis adapter (`realtime.adapter.ts`, wired in `main.ts`).
- ✅ JWT-in-handshake auth + Redis-backed JTI revocation check + archived-user check on connect.
- ✅ Rooms: `project:{id}`, `task:{id}`, `user:{id}`. Backend-enforced join authorization via `PermissionsService`.
- ✅ Presence broadcast on join/leave + typing-start/stop messages.
- ✅ Domain event flow: in-process `EventEmitter2` fans out to event-writer + notification-dispatcher + realtime-broadcaster (visible in module imports).
- ✅ Frontend reconnect via TanStack Query `invalidateQueries` (no event replay) — matches §9.

### §10 Notifications
- ✅ `Notification` model + `NotificationPreference` model with `channel`, `eventType`, `enabled`, `snoozeUntil`, `digestMode`, optional `projectId` override.
- ✅ `notification-dispatcher.service.ts` listens to all domain events, resolves recipients, queues delivery via BullMQ.
- ✅ `recipient-resolver.service.ts` + `preferences.service.ts` handle watcher / mention / mute resolution.
- ✅ `notification.processor.ts` is the BullMQ delivery worker (lives in `apps/api`, not `apps/workers`).
- ✅ Endpoints: list / unread-count / mark-read / mark-all-read / delete + preferences upsert / snooze-all.
- 🟡 Auto-watch rules (creator/assignee/reporter auto-watch, commenters/mentioned do not) need to be verified inside `tasks.service.ts` and `comments.service.ts`. Not visible from the controllers alone.
- 🟡 Digest mode is a column but unclear whether a cron actually batches the digest. Likely missing — `apps/workers` is empty.

### §11 Comments
- ✅ `Comment` + `CommentMention` models with check constraint (one of user/team) documented in migration notes.
- ✅ Visibility per comment; `editLockedAt` column for 15-minute edit grace.
- ✅ CRUD endpoints. Soft-delete via `deletedAt` + `deletedById`.
- 🟡 Hard-delete cleanup job after 30 days — no such cron is wired (workers app empty).
- ❌ Inline image upload "attachment:abc123" auto-rewrite — no evidence of this transform in `comments.service.ts` (worth confirming).

### §12 Storage & attachments
- ✅ `Attachment` model matches spec exactly (parentType polymorphic enum, scan status, thumbs).
- ✅ Three-step signed-URL flow: `POST /attachments/sign`, `POST /attachments/confirm`, `GET /attachments/:id/download`.
- ✅ `storage.service.ts` (S3-compatible client) + `clamav.service.ts` for scanning.
- ✅ BullMQ processors `attachment-scan.processor.ts` + `attachment-thumb.processor.ts` (live in `apps/api`).
- ✅ Executable-extension blocklist enforced at the controller via DTO + service (`attachments.service.ts`).
- ✅ Docker Compose includes MinIO + minio-init bucket bootstrap + ClamAV.
- 🟡 Soft-delete + 30-day retention — schema has `deletedAt`, but the cleanup cron is missing (workers app empty).
- 🟡 PDF first-page previews + video thumbnails — `sharp` is in deps for images, but no `ffmpeg`/`pdf-poppler` integration visible. Likely **not implemented** despite being in §12.
- 🟡 Per-file 100MB default cap — DTOs enforce the 500MB hard cap (`@Max(500 * 1024 * 1024)`) but not the 100MB soft cap. Configurable cap is missing.

### §13 GitHub integration
- ✅ GitHub App webhook controller with HMAC-SHA256 signature verification.
- ✅ `installation`, `push`, `pull_request` events parsed and dispatched.
- ✅ `task-key-parser.ts`, `auto-status.service.ts`, `github-events.service.ts`, `github-app.service.ts` all present.
- ✅ Schema: `GithubInstallation`, `GithubRepo`, `ProjectRepo`, `TaskGithubLink`.
- 🟡 Auto-status transition matrix from §13 — implemented in `auto-status.service.ts`; correctness of the rule table needs a unit-test sweep.
- ❌ No GitHub App manifest, no OAuth flow for installing the App from inside Nockta Flow — installation is assumed to be configured out-of-band via env vars.

### §14 Google Chat
- ✅ Chat events webhook with Google ID token verification (`OAuth2Client.verifyIdToken`).
- ✅ Binding handshake via "send any message to the bot" flow.
- ✅ `chat.service.ts`, `chat-dispatcher.service.ts`, `card-builders.ts`.
- ✅ Inline interactive actions: accept / self-assign / mark-done / unblock / acknowledge — wired in `chat-events.controller.ts`.
- 🟡 Dialog flows (Reassign…, Reply…) — controller responds with "coming soon" text. Stubbed, not implemented.
- ✅ Per-project chat broadcast: schema has `chatSpaceId` + `chatBroadcastEvents[]`.
- ❌ Client portal Chat-hiding check is implicit (clients have no binding flow); fine in practice.

### §15 External-client experience
- ✅ Consolidated into `apps/web` (the `apps/client` portal was retired). One SPA, role-conditional UI hides internal-only surfaces (Workload, Standup, Worklog, Deployments, Automations, Settings) for `kind=client` users. The dedicated portal was replaced because two parallel design systems drifted and the API already enforces all permissions.
- ✅ Magic-link sign-in on `/auth/magic` — `RequestMagicLink` form lives on `LoginPage`; callback at `/auth/magic` verifies + redirects.
- ✅ Bug-only restriction (type=Bug, visibility=client_visible) is now keyed on **project role** (`Client`), not user kind. A kind=client user with Contributor or Manager grants can create real tasks like an internal contributor.
- ✅ Contributor / Viewer / Client project roles all admit clients onto the board / dashboard / list / backlog / timeline / docs tabs.

### §16 Deployment / CI/CD tracking
- ✅ `Deployment` + `TaskDeployment` + `ProjectDeploymentSecret` schemas.
- ✅ Webhook receiver with HMAC verification per project + per source.
- ✅ Source adapters (`source-adapters.ts`) normalize Vercel / Railway / GitHub Actions / generic.
- ✅ Manager-only secret rotation endpoint.
- 🟡 Auto-status "Testing → Done on production DeploymentSucceeded" — lives in `deployments.service.ts`; verify the rule isn't firing for non-prod environments.
- 🟡 Chat-space broadcast on prod success/fail — wired to `chatBroadcastEvents[]` plumbing, but worth a dry-run integration test.

### §17 Search
- ✅ `SearchService` + `SearchController` with all filters from spec.
- ✅ `SavedSearch` model and CRUD.
- ✅ FTS via Postgres `tsvector` generated columns — **documented but not migrated**. Currently the search likely falls back to `ILIKE` (worth confirming in `search.service.ts`).
- ❌ **Elasticsearch/OpenSearch parallel index** — no infra container, no client code. Listed in GRILL §17 but not built. (Probably fine for MVP — Postgres FTS is the realistic phase-1 path.)
- ❌ Label filter advertised in §17 but no Label model exists (same gap as §5).

### §18 Analytics & reporting
- ✅ Endpoints: `/analytics/me`, `/projects/:id`, `/org`, `/sprints/:id/burndown`.
- 🟡 Materialized-view-on-cron strategy from GRILL — no migration that creates materialized views. The service is likely computing on-the-fly via Prisma aggregates. **Will not meet the 5-minute / daily refresh design at scale, but acceptable for 30 engineers.**

### §19 AI layer
- ✅ `LlmService` (Ollama + Anthropic switchable), `QdrantService`, `EmbeddingService`.
- ✅ Three BullMQ queues: embed / detect-duplicates / summarize.
- ✅ `ai-cron.service.ts` + `ai-dispatcher.service.ts` for scheduled work + event-driven triggers.
- ✅ `TaskEmbeddingMeta` table for Qdrant point↔task mapping with `sourceHash` invalidation.
- ✅ Endpoints for manual re-embed / duplicate-detect / sprint-summarize.
- 🟡 **PR summarization** — not visible. Needs a hook from `github-events.service.ts` into the AI dispatcher.
- 🟡 **Blocker prediction** + **automatic prioritization** — listed in spec, no evidence in code.
- 🟡 **Standup generation** — not visible; no endpoint surfaced from `ai.controller.ts`.

### §20 Stack — matches spec, except…
- ✅ Everything in the GRILL-SUMMARY table is present.
- 🟡 **LLM provider** — `.env.example` and the Railway README explicitly add Anthropic as a swap option. Mild deviation from "Ollama only" but documented.
- 🟡 **Object storage** — Railway README recommends Cloudflare R2 for prod over MinIO. Acceptable since both are S3-compatible.

### §21 Monorepo structure
- ✅ Apps: api, web, client, workers (folder exists, but…).
- ✅ Packages: ui, types, sdk, eslint-config, tsconfig.
- ❌ **`apps/workers` has no source code** — just a `package.json`. All BullMQ processors run in-process inside `apps/api`. This is a deviation from §21/§24 but Railway README acknowledges it as the chosen approach. **Decision should be made explicit in GRILL-SUMMARY: do we delete `apps/workers` or split processors out?**
- 🟡 **`packages/ui` is barebones** — exports `cn()` only, no shared shadcn components. GRILL §21 promised "shared shadcn/ui component layer + design tokens." Frontend apps inline their own Tailwind classes, which will diverge over time.
- 🟡 **`packages/sdk`** has a typed HTTP client base but no endpoint methods. Apps use it as a thin wrapper around `fetch`. Fine for now, but defeats the "typed SDK" point.

### §22 API design
- ✅ `/api/v1` prefix in `main.ts`.
- ✅ Swagger at `/docs` in non-prod.
- ✅ RFC 7807 problem details defined in `@nockta/types`; verify `all-exceptions.filter.ts` emits this shape on every error.
- ✅ Cursor pagination helper at `common/pagination/cursor-pagination.ts`; used by timeline, audit-log, notifications, search.

### §23 Security
- ✅ Refresh-token rotation with reuse detection — `auth.service.ts` references `rotatedToId`.
- ✅ Helmet + CORS + global validation pipe with `forbidNonWhitelisted`.
- ✅ ThrottlerModule wired (global limit). 🟡 Per-user limit from §23 is **not differentiated** (only the global throttle is configured in `app.module.ts`).
- ✅ Webhook signature validation: GitHub HMAC, Chat Google ID token, deployments HMAC.
- ❌ **CSRF protection** — no CSRF middleware visible. Acceptable if all auth is bearer-token (no cookies), but `app.enableCors({ credentials: true })` is set, which implies cookies are used somewhere. Worth confirming.
- 🟡 Secrets management — env vars only. `GCP Secret Manager in prod` from GRILL §23 isn't wired; Railway provides its own secret store, which is acceptable.

### §24 Infrastructure
- ✅ Docker Compose covers all services from spec: postgres, redis, minio + minio-init, clamav, qdrant, ollama, mailhog, prometheus, loki, grafana.
- ✅ Prometheus + Loki + Grafana provisioning files.
- ✅ Railway as the prod target — confirmed in `infra/railway/README.md` (the GRILL §24 "pending Final Q confirmation" is now resolved).
- 🟡 Frontends have Dockerfile + nginx.conf + railway.json. API does **not** — `apps/api/Dockerfile` is referenced by the Railway README but **doesn't exist** in the repo today.
- ❌ Promtail config to ship logs to Loki — not present. Apps log structured JSON to stdout (pino), but the Loki pipeline isn't wired.

### §25 UI/UX direction
- ✅ Tailwind + shadcn-style tokens (priority/status semantic colors visible in `ProjectBoardPage.tsx`).
- ❌ Keyboard shortcuts — no `?`/`c`/`/`/`j`/`k` handlers visible. Not yet implemented.
- ❌ Sidebar, navigation, issue modal, search palette — **none of these UI surfaces exist yet**. Only the board, projects list, dashboard, and auth pages.

---

## Cross-cutting gaps (the ones to prioritize)

1. **No real Prisma migration.** `prisma/migrations/0001_init/` has only a `.notes.md`. The first `prisma migrate dev` has never been run. Until it is, `prisma migrate deploy` on Railway will do nothing.

2. **Raw-SQL companion migration is also unwritten.** The notes file describes 7 things Prisma can't express (active-sprint partial unique index, ProjectAccess and CommentMention check constraints, partitioned Event table, FTS tsvector columns, project key regex). None are in an executable file. Going to prod without these creates real bugs (e.g. two active sprints possible, search degrades to ILIKE).

3. **`apps/workers` is empty.** All processors run in-process inside `apps/api`. Either (a) delete `apps/workers` and acknowledge the deviation in GRILL-SUMMARY, or (b) split processors out before scale becomes a problem.

4. **`apps/api/Dockerfile` is missing.** The Railway README references it. Deploy will fail.

5. **Frontend gap is large.** Only board + projects list + login exist. Missing: task detail/modal, comments UI, sprint view, audit log, notification panel, search UI, analytics dashboard, settings, admin pages, client comments/notifications/attachments. **At least 60% of UI surfaces remain to be built.**

6. **Missing `Label` model.** Referenced in §17 search filters and §6 brief but no schema/endpoints/UI.

7. **Workers-shaped jobs that have no runner:**
   - Monthly Event-table partition creation
   - 30-day soft-delete cleanup (comments, attachments)
   - Materialized-view refresh for analytics
   - Digest-mode notification batching

8. **AI layer is half-built.** Embed / duplicate / sprint-summarize work; PR summarization, blocker prediction, prioritization, standup generation are stubs or absent.

9. **Sources of truth divergence:** Railway README has decisions (R2 over MinIO, Anthropic as LLM fallback, in-process workers) that are not in `GRILL-SUMMARY.md`. **Either move them into GRILL-SUMMARY or note that the README supersedes it for hosting decisions.**

10. **Per-user rate limit** from §23 is not differentiated from the global limit — only one throttler is configured.

---

## What's solid

- **Schema completeness.** Every entity in GRILL-SUMMARY has a model and the relations look right.
- **Auth.** Google OAuth + magic link + JWT rotation + Redis JTI revocation + WebSocket auth — all wired and consistent.
- **Realtime.** Auth-gated rooms, presence, typing, Redis adapter for horizontal scaling. This is the kind of plumbing that's painful to retrofit and it's done.
- **Webhook security.** GitHub, Chat, and deployment webhooks all verify signatures/tokens with `timingSafeEqual`.
- **Event/notification flow.** EventEmitter2 → recipient resolver → preferences gate → BullMQ → in-app + Chat. The wiring matches the design.
- **API endpoint coverage.** Counting endpoints, the backend surface is ~85–90 routes, and they map cleanly to GRILL-SUMMARY sections.
