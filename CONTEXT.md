# Nockta Flow — context

The "why" file. Use this when you need to understand why a piece of the
system is shaped the way it is, what the domain vocabulary means, or what
decisions were made before you got here. For deploy/operations details, see
[`HANDOVER.md`](HANDOVER.md).

---

## What this product is

Nockta Flow is a single-tenant, single-workspace engineering operations
platform for ~30 engineers replacing a Jira instance. The product brief is
in [`PRODUCT.md`](PRODUCT.md). One sentence: an opinionated, keyboard-first
tracker with first-class WebSocket realtime, Google-Chat-style notifications,
GitHub-webhook integration, and an AI assistive layer (embeddings,
duplicate-detect, sprint summaries).

A small external-client surface lives inside the same SPA — clients log in
via magic link and see a role-restricted view of projects they have access to.

---

## Domain language

Glossary so terms in the code, docs, and conversation line up.

| Term | Meaning |
|---|---|
| **Workspace** | Singular. No multi-tenant model exists; the early `workspaceId` columns were dropped in migration `0022_schema_reconciliation`. |
| **User.kind** | `internal` (a teammate at the org) or `client` (an external user invited to a specific project). |
| **CompanyRole** | `Admin` or `Member`. Admin bypasses project-role gates. |
| **ProjectRole** | `Manager`, `Contributor`, `Viewer`, `Client`. Granted via `ProjectAccess` rows, either per-user (`subjectKind='user'`) or per-team (`subjectKind='team'`). `Client` is the role for external clients on a specific project. |
| **ProjectVisibility** | `public` (every internal user can read), `teams` (members of granted teams plus per-user grants), `private` (per-user grants only). |
| **Task.visibility** | `internal` (default) or `client_visible`. Clients on a project never see `internal` tasks. |
| **Task.isBlocked** | A flag, not a status. Blocked is a property orthogonal to the workflow column. |
| **Sprint state** | `planned` → `active` → `completed`. A partial unique index in `companion.sql` enforces at most one `active` per project. |
| **Event** | The append-only audit/activity log. Table is `PARTITION BY RANGE (createdAt)` — `companion.sql` sets that up, `MaintenanceScheduler.ensureNextMonthEventPartition` creates the next month's partition on the hourly tick. |
| **Notification** | An in-app row delivered to a user. Distinct from a Chat broadcast. Preference matrix lives in `NotificationPreference`; digest batching lives in `NotificationDigest`. |
| **Watcher** | A user subscribed to a Task's events. Auto-watch rules: creator, assignee, reporter. Mention auto-watch fires when someone is `@`-mentioned in a comment. |
| **TaskLink.kind** | `blocks` / `related` / `duplicate`. Cross-project allowed. |
| **Deployment** | A row recording one CI/CD deployment event (Vercel, Railway, GitHub Actions, generic) so the auto-status state machine can move a linked Task from `Testing → Done` on prod success. |
| **Companion SQL** | `apps/api/prisma/migrations/companion.sql`. The seven things Prisma can't express, applied as step 2 of `start.sh`. Idempotent; safe on every boot. |

---

## Non-obvious architectural choices

Every entry has been load-tested at least once by an audit or a refactor.

### Single SPA, role-conditional UI

`apps/web` serves both internal teammates and external clients. An earlier
draft had a separate `apps/client` portal; it was retired because two
parallel design systems drifted, and the API was always the security
boundary anyway. Clients see only the routes their `ProjectRole=Client`
grants admit (Dashboard, Board, List, Backlog, Timeline, Docs). Internal-only
sections (Workload, Standup, Worklog, Deployments, Automations, Settings)
collapse in the sidebar when `user.kind === 'client'`. **UI hiding is a UX
convenience, not a security control** — every route's data access is
re-gated server-side in the corresponding service.

### Workers run in-process inside `apps/api`

BullMQ processors (notification delivery, attachment scan + thumbnail,
embedding, duplicate-detect, sprint-summarize, exports, outbound webhooks)
and all in-process schedulers live inside the `api` service. The earlier
plan to split into a separate `apps/workers` deployable was dropped — one
process is enough for 30 engineers, and the multi-replica safety pattern in
[`SchedulerLockService`](apps/api/src/common/scheduling/scheduler-lock.service.ts)
lets us scale by bumping `numReplicas` without code changes when needed.

### Bearer tokens in `localStorage`, no cookies

All auth is JWT bearer-token. Tokens are issued by the Google OAuth callback
or `/auth/magic-link/verify`, never via `Set-Cookie`. The SPA stores them in
`localStorage` via Zustand `persist` and attaches them on every XHR. CORS
is configured `credentials: false` so an attacker can't forge an
authenticated request from a victim's browser. CSRF middleware is therefore
not required (the long-form rationale is inlined as a comment block in
`apps/api/src/main.ts`). The primary defense against XSS-driven token
exfiltration is the strict CSP applied at the SPA's nginx layer; see
`apps/web/nginx.conf`.

### Postgres FTS as the default search path

`SearchService` reads from the tsvector generated columns on `Task`,
`Comment`, and `Doc` (created by `companion.sql`). Elasticsearch parallel
indexing is wired but disabled — set `SEARCH_ELASTIC_URL` to flip. FTS via
Postgres is the realistic path for 30 engineers; ES is a phase-2 flip.

### LLM provider is swappable (Ollama or Anthropic)

Spec called for Ollama only. We added Anthropic as a swap option because
operating an Ollama deployment in production is non-trivial and the SDK
abstraction is one method (`LlmService.complete`). Flag is `LLM_PROVIDER`
in env. Both providers go through the same retry/cost-tracking path.

### Service-layer permission enforcement, not decorators

`PermissionsModule` is `@Global`. Almost every service that takes a
`projectId` calls `permissions.assertAtLeast(actor, projectId, 'Viewer')`
inline rather than via a controller decorator. The exception is bulk
admin-only surfaces (`@nockta/api/src/modules/import/`,
`workspace-ai-settings`) which use the `RolesGuard` + `@RequireCompanyRoles('Admin')`
decorator pair.

This is **opt-in per-route, not auto-applied**. The audit pattern is
`grep -L 'permissions\.' apps/api/src/modules/*/` to find services that take
a `projectId` but skip the gate. `Exports` was such a miss — fixed in
migration `0023_export_run_created_by` plus a service rewrite.

### Object storage is S3-compatible (R2 in prod, MinIO in dev)

`StorageService` is a thin wrapper around `@aws-sdk/client-s3`. Production
points at Cloudflare R2; dev points at MinIO in `infra/docker-compose.yml`.
The signed-URL flow is three steps: `POST /attachments/sign` → upload to
URL → `POST /attachments/confirm`. The ClamAV scan queue picks up confirmed
uploads and quarantines hits.

### Realtime room authorization is server-enforced

The `RealtimeGateway` Socket.IO server validates JWT on handshake, then
gates every `project:join` / `task:join` / `doc:join` / `import:join`
message via `PermissionsService`. A client cannot subscribe to a project's
room without at-least-Viewer access. The broadcaster emits only to
authorized rooms, so a malicious client can't pivot from one project's
room to another's by string-juggling the room name.

### Migration history was reconciled in `0022_schema_reconciliation`

Earlier development used `prisma db push` for some changes. The schema in
`schema.prisma` drifted ahead of the committed migration files (~10 missing
columns, three missing tables, multiple stale columns from the MFA and
workspace-id removals). Migration `0022_schema_reconciliation` is the
single catch-up — it brings a fresh `prisma migrate deploy` exactly in line
with `schema.prisma`. From `0023` forward, every schema change is a real
committed migration.

---

## File-system map

```
apps/
  api/                NestJS app. All BullMQ processors + in-process schedulers live here.
    prisma/
      schema.prisma   Single source of truth for the DB schema.
      migrations/     0001 → 0023, plus companion.sql for the things Prisma can't express.
    scripts/          start.sh (boot orchestrator), data importers (Jira/Linear), load tests.
    src/
      bootstrap-env.ts   Production secret guard. Refuses to boot on weak/missing.
      main.ts            CORS/Helmet/Throttler bootstrap, integration-status banner.
      common/             Cross-cutting (pagination, scheduling, throttler, RFC7807 filter).
      modules/            One folder per domain capability.
  web/                React SPA. Vite build → nginx serve in prod.
    src/
      main.tsx              React Strict Mode + router mount.
      lib/                  Cross-cutting (auth-store, api client, socket, query-keys).
      components/           Shared UI primitives and the task drawer.
      pages/                Route-level components.
    nginx.conf            Security headers (CSP etc.) for prod static serve.

packages/
  eslint-config         Shared ESLint preset (Node + React).
  sdk                   Typed HTTP client used by apps/web.
  tsconfig              Shared base tsconfigs.
  types                 Shared API/event types between api and web.
  ui                    Shared shadcn-style primitives + a few atoms.

docs/
  adr/                  Architecture decision records — one per major call.
  agents/               Notes on agent-driven workflows (issue tracker, triage labels).
  architecture.md       Diagram-level system overview.
  operations/           Runbooks.
  security/             Threat model.

infra/
  docker-compose.yml    Local dev stack (Postgres, Redis, MinIO, ClamAV, Qdrant, Ollama, Mailhog, Grafana).
  railway/              Per-service railway.json + READMEs.
  grafana/              Pre-provisioned dashboards.
  postgres/             Init scripts.
```

---

## Where to start when…

- **Adding a new entity?** Edit `schema.prisma`, then
  `pnpm --filter @nockta/api prisma migrate dev --name <change>`. Write the
  service in `apps/api/src/modules/<feature>/`. If it has project-scoped
  resources, the service MUST call `permissions.assertAtLeast(...)` before
  reads/writes.
- **Adding a new event type?** Define it in `packages/types/src/events.ts`.
  Emit via `EventEmitter2`. The `EventWriterService`, `NotificationDispatcherService`,
  and `RealtimeBroadcasterService` are subscribed to `onAny` and will fan
  out per their own rules.
- **Adding a new background job?** Register a queue in
  `apps/api/src/modules/<feature>/<feature>.module.ts`, write a
  `@Processor()` class, and inject `@InjectQueue()` where you produce.
- **Adding a new SPA page?** Add a route in `apps/web/src/main.tsx`, write
  the page component in `apps/web/src/pages/`, gate via `useAuth()` +
  `useRequireRole()`.

---

## Where context goes from here

- [`docs/adr/`](docs/adr/) — eight architecture decision records: monorepo,
  NestJS, Prisma, BullMQ, TanStack Query, Socket.IO, service-layer
  isolation, decomposed task drawer.
- [`DESIGN.md`](DESIGN.md) — design tokens (colors, type scale, motion).
- [`PRODUCT.md`](PRODUCT.md) — product brief.
- [`JIRA-IMPORT.md`](JIRA-IMPORT.md) — Jira importer reference.
- Git history at `7d4be13..HEAD` — the audit-driven sweep that produced this
  state. Earlier `GRILL-SUMMARY.md` / `GAP-REPORT.md` /
  `READINESS-SCORE.md` were collapsed into this file and `HANDOVER.md`;
  the originals are recoverable from git if archaeology is ever needed.
