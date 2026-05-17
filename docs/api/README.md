# API documentation

Nockta Flow exposes a versioned REST API under `/api/v1/*` (with `/health` and `/metrics` outside the prefix). This document is the index — for each controller it lists the base path, a one-line description, and a link to the source file.

For the interactive spec:

- In dev / staging the API mounts **Swagger UI at `/docs`** (`apps/api/src/main.ts` only enables this when `NODE_ENV !== 'production'`).
- The OpenAPI JSON is available at **`/docs-json`**.
- DTOs are decorated with `@nestjs/swagger` decorators and class-validator metadata; the spec is generated at boot.

To inspect the spec without running the server, generate it from the test harness:

```bash
pnpm --filter @nockta/api exec tsx scripts/dump-openapi.ts > openapi.json
```

---

## Controllers

All paths are prefixed with `/api/v1` unless noted. Controllers tagged "no prefix" are excluded from the global prefix in `main.ts`.

### Operational

| Base path | Description | File |
|---|---|---|
| `/health` (no prefix) | Fast liveness probe (Postgres ping); plus `/health/deep` for full dependency probe | [`apps/api/src/health/health.controller.ts`](../../apps/api/src/health/health.controller.ts) |
| `/metrics` (no prefix) | Prometheus scrape endpoint (HTTP counter + duration histogram + process metrics) | [`apps/api/src/health/metrics.controller.ts`](../../apps/api/src/health/metrics.controller.ts) |
| `/config` | Public client-side feature flags + integration-status banner | [`apps/api/src/health/config.controller.ts`](../../apps/api/src/health/config.controller.ts) |

### Auth & identity

| Base path | Description | File |
|---|---|---|
| `/auth` | Google OAuth + magic-link request/verify + JWT issue/refresh/logout + `/auth/me` | [`apps/api/src/modules/auth/auth.controller.ts`](../../apps/api/src/modules/auth/auth.controller.ts) |
| `/users` | User CRUD, role management, archive / restore, profile updates | [`apps/api/src/modules/users/users.controller.ts`](../../apps/api/src/modules/users/users.controller.ts) |
| `/onboarding` | First-run onboarding state per user (checklist progress, sample data) | [`apps/api/src/modules/onboarding/onboarding.controller.ts`](../../apps/api/src/modules/onboarding/onboarding.controller.ts) |

### Workspace & organization

| Base path | Description | File |
|---|---|---|
| `/workspace` | Current workspace settings, member list, switch-workspace | [`apps/api/src/modules/workspace/workspace.controller.ts`](../../apps/api/src/modules/workspace/workspace.controller.ts) |
| `/teams` | Team CRUD + member add/remove (multi-team membership allowed) | [`apps/api/src/modules/teams/teams.controller.ts`](../../apps/api/src/modules/teams/teams.controller.ts) |
| `/projects` | Project CRUD; access list / grant / revoke; visibility; workflow preset | [`apps/api/src/modules/projects/projects.controller.ts`](../../apps/api/src/modules/projects/projects.controller.ts) |

### Tasks, sprints, work

| Base path | Description | File |
|---|---|---|
| `/tasks` | Task CRUD, status / blocked / assignee / position; subtasks; links; watch / mute | [`apps/api/src/modules/tasks/tasks.controller.ts`](../../apps/api/src/modules/tasks/tasks.controller.ts) |
| (per-project, in same controller) | Comments and Labels endpoints are mounted with project-scoped paths via this controller | [`apps/api/src/modules/comments/comments.controller.ts`](../../apps/api/src/modules/comments/comments.controller.ts) |
| (per-project) | Sprint CRUD + start / complete with optional carry-over | [`apps/api/src/modules/sprints/sprints.controller.ts`](../../apps/api/src/modules/sprints/sprints.controller.ts) |
| (per-project) | Label CRUD + assign / unassign on tasks | [`apps/api/src/modules/labels/labels.controller.ts`](../../apps/api/src/modules/labels/labels.controller.ts) |
| (per-task) | Worklog entries: log time, list, edit, delete | [`apps/api/src/modules/worklog/worklog.controller.ts`](../../apps/api/src/modules/worklog/worklog.controller.ts) |
| (per-task) | Recurrence rules (cron-style); next-spawn preview | [`apps/api/src/modules/recurrence/recurrence.controller.ts`](../../apps/api/src/modules/recurrence/recurrence.controller.ts) |
| (per-workspace) | Task templates (reusable shapes for new tasks) | [`apps/api/src/modules/task-templates/task-templates.controller.ts`](../../apps/api/src/modules/task-templates/task-templates.controller.ts) |
| (per-project) | Custom fields: definition + per-task values (text, number, select, multi-select, date) | [`apps/api/src/modules/custom-fields/custom-fields.controller.ts`](../../apps/api/src/modules/custom-fields/custom-fields.controller.ts) |
| `/saved-views` | Persisted filter / sort state per user | [`apps/api/src/modules/saved-views/saved-views.controller.ts`](../../apps/api/src/modules/saved-views/saved-views.controller.ts) |
| `/goals` | Goal CRUD; link tasks; progress tracking | [`apps/api/src/modules/goals/goals.controller.ts`](../../apps/api/src/modules/goals/goals.controller.ts) |
| (mounted root) | Project docs (Tiptap content; folder tree) | [`apps/api/src/modules/docs/docs.controller.ts`](../../apps/api/src/modules/docs/docs.controller.ts) |

### Observability

| Base path | Description | File |
|---|---|---|
| `/timeline` | Per-project / per-task event timeline (read-only) | [`apps/api/src/modules/events/timeline.controller.ts`](../../apps/api/src/modules/events/timeline.controller.ts) |
| `/audit-log` | Admin-only cross-workspace audit query | [`apps/api/src/modules/events/audit-log.controller.ts`](../../apps/api/src/modules/events/audit-log.controller.ts) |
| `/analytics` | Sprint burndown, cycle time, workload, throughput | [`apps/api/src/modules/analytics/analytics.controller.ts`](../../apps/api/src/modules/analytics/analytics.controller.ts) |
| `/dashboards` | Dashboard CRUD; widget config; data fetchers | [`apps/api/src/modules/dashboards/dashboards.controller.ts`](../../apps/api/src/modules/dashboards/dashboards.controller.ts) |
| `/search` | Postgres FTS (default) or Elasticsearch (when `SEARCH_ELASTIC_URL` set) | [`apps/api/src/modules/search/search.controller.ts`](../../apps/api/src/modules/search/search.controller.ts) |
| `/exports` | CSV / JSON exports of tasks, sprints, events | [`apps/api/src/modules/exports/exports.controller.ts`](../../apps/api/src/modules/exports/exports.controller.ts) |

### Notifications

| Base path | Description | File |
|---|---|---|
| `/notifications` | List / unread-count / mark-read / mark-all-read / delete | [`apps/api/src/modules/notifications/notifications.controller.ts`](../../apps/api/src/modules/notifications/notifications.controller.ts) |
| `/notifications/preferences` (alias `/notification-preferences`) | Per-event / per-channel / per-project preference upsert | [`apps/api/src/modules/notifications/preferences.controller.ts`](../../apps/api/src/modules/notifications/preferences.controller.ts) |
| `/notifications/mutes` | Mute task / project / type | [`apps/api/src/modules/notifications/mutes.controller.ts`](../../apps/api/src/modules/notifications/mutes.controller.ts) |
| `/notifications/snooze-rules` | Quiet-hours and weekday rules | [`apps/api/src/modules/notifications/snooze.controller.ts`](../../apps/api/src/modules/notifications/snooze.controller.ts) |
| `/notifications/digest` | Digest preview + manual trigger | [`apps/api/src/modules/notifications/digest.controller.ts`](../../apps/api/src/modules/notifications/digest.controller.ts) |
| `/notifications/web-push` | VAPID subscription management | [`apps/api/src/modules/web-push/web-push.controller.ts`](../../apps/api/src/modules/web-push/web-push.controller.ts) |

### Attachments

| Base path | Description | File |
|---|---|---|
| `/attachments` | Signed upload URL, list per parent, download signed URL, delete | [`apps/api/src/modules/attachments/attachments.controller.ts`](../../apps/api/src/modules/attachments/attachments.controller.ts) |

### Integrations

| Base path | Description | File |
|---|---|---|
| `/github` | GitHub App installation flow (begin / callback); manual link/unlink | [`apps/api/src/modules/github/github-install.controller.ts`](../../apps/api/src/modules/github/github-install.controller.ts) |
| `/webhooks/github` | Inbound GitHub webhook receiver (HMAC verified) | [`apps/api/src/modules/github/github-webhook.controller.ts`](../../apps/api/src/modules/github/github-webhook.controller.ts) |
| `/chat/binding` | Per-project Google Chat space binding | [`apps/api/src/modules/chat/chat-binding.controller.ts`](../../apps/api/src/modules/chat/chat-binding.controller.ts) |
| `/webhooks/chat` | Google Chat interaction events (button clicks on cards) | [`apps/api/src/modules/chat/chat-events.controller.ts`](../../apps/api/src/modules/chat/chat-events.controller.ts) |
| (mounted root) | Deployment CRUD; manual sync; rollback | [`apps/api/src/modules/deployments/deployments.controller.ts`](../../apps/api/src/modules/deployments/deployments.controller.ts) |
| `/webhooks/deployments` | Deployment webhook receivers (Vercel / Railway / GitHub Actions / generic, HMAC verified per provider) | [`apps/api/src/modules/deployments/deployment-webhook.controller.ts`](../../apps/api/src/modules/deployments/deployment-webhook.controller.ts) |
| `/outbound-webhooks` | User-configured outbound webhooks (URL + secret + event filter) | [`apps/api/src/modules/outbound-webhooks/outbound-webhooks.controller.ts`](../../apps/api/src/modules/outbound-webhooks/outbound-webhooks.controller.ts) |
| `/import` | Jira / Linear import run management; status, resume, cancel | [`apps/api/src/modules/import/import.controller.ts`](../../apps/api/src/modules/import/import.controller.ts) |
| (mounted root) | Automation rule CRUD; manual run; preview | [`apps/api/src/modules/automations/automations.controller.ts`](../../apps/api/src/modules/automations/automations.controller.ts) |

### AI

| Base path | Description | File |
|---|---|---|
| `/ai` | Duplicate detection, blocker summaries, standup generation, ask-the-task, embed-all | [`apps/api/src/modules/ai/ai.controller.ts`](../../apps/api/src/modules/ai/ai.controller.ts) |
| `/workspace/ai-settings` | Per-workspace AI provider + token caps | [`apps/api/src/modules/ai/workspace-ai-settings.controller.ts`](../../apps/api/src/modules/ai/workspace-ai-settings.controller.ts) |

### Client portal

| Base path | Description | File |
|---|---|---|
| `/client` | Read-only project + task + comment surface for `User.kind=client`. Strict `client_visible` filter | [`apps/api/src/modules/client/client.controller.ts`](../../apps/api/src/modules/client/client.controller.ts) |

---

## Conventions

- Every authenticated route runs through (in order): `IdentityAwareThrottlerGuard`, `JwtAuthGuard`, `WorkspaceGuard`, `RolesGuard`, the global `ValidationPipe`, the controller, then `AllExceptionsFilter` on the way out. See [architecture diagram](../architecture.md#request-flow--typical-write).
- DTOs use `class-validator` + `class-transformer`. Global validation pipe is `whitelist: true, forbidNonWhitelisted: true` — unknown fields are stripped, extra fields 400.
- Errors are returned as RFC 9457 Problem Details JSON via `AllExceptionsFilter`.
- Every response carries a `x-correlation-id` header populated by the `CorrelationIdInterceptor`; use it when raising issues.
- Webhooks (`/webhooks/*`) bypass JWT auth and rely on HMAC signature verification at the controller. They are `@Public()`.

### Pagination

Endpoints that return lists use cursor-based pagination on `(createdAt, id)` for stable ordering:

```
GET /api/v1/tasks?projectId=...&limit=50&cursor=<opaque>
→ 200 { items: [...], nextCursor: "<opaque>" | null }
```

`limit` is capped at 100 server-side. Some endpoints (search, analytics) use offset pagination instead — documented per route in the Swagger spec.

### Versioning

The `v1` prefix is the only versioning today. A breaking change would be a `v2` controller mounted in parallel, with `v1` deprecated and removed after a sunset window (minimum 90 days announced).
