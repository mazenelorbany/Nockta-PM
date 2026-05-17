# Nockta Flow — Design Decisions

Summary of grilling session. Source of truth for build. Every decision here was either:
- pulled from the brief (`Nockta Flow.pdf`) and accepted, or
- resolved by an explicit decision during grilling (and may override the brief)

Where this doc and the brief disagree, **this doc wins**.

---

## 1. Foundational scope

- **Internal-only** product for Nockta. Single workspace. No multi-tenant abstraction.
- **Scale target:** 30 internal engineers, 20 clients, 40 active projects. "Build for scale" — architecture, not feature count.
- **Phasing:** none. All 15 modules from the brief ship in one phase. No v1/v2 deferrals.

---

## 2. Identity & auth

- **Internal users:** Google OAuth, hard-restricted to `@nockta.com`.
- **Clients/Guests:** magic-link auth on the separate client subdomain. Optional Google OAuth for clients who want it.
- **One user = one role.** A person is either internal or client. Never both. Contractors needing internal access get an `@nockta.com` account.
- **Session strategy:** short-lived JWT access tokens + rotating refresh tokens + Redis-backed session tracking.
- **Stack:** NestJS + Passport.js + JWT + Google OAuth strategy.

---

## 3. Org model

- **Workspace abstraction killed.** Teams and Projects sit at the root.
- **Teams = Groups** — one concept. Used for filtering, assignments, reporting, **and access control**. (This overrides the brief's "NOT permissions inheritance" rule. Cost noted: every permission check resolves group memberships.)
- A user can belong to multiple Teams. Only Admins create/manage Teams.

---

## 4. Permissions

- **Company roles:** Admin, Member.
- **Project roles:** Manager, Contributor, Viewer, Client.
- **Only Admins create projects.** Admin is prompted at creation for visibility.
- **Project visibility (Admin chooses at creation):**
  - `public` — all Members get default Viewer access.
  - `teams` — only listed Teams have access (with a role per Team grant).
  - `private` — explicit user grants only.
- **Project access grants** can be by user OR by team, each carrying a role (Manager/Contributor/Viewer/Client). Multiple grants per project are allowed.
- **Effective role on a project** = the *maximum* of: direct user grant, any team-based grant for teams the user belongs to, or `Viewer` if project is `public`.
- **Admins bypass all project membership** — they see every project, including private ones.
- **Clients are never granted via Teams.** Always per-user, per-project, always role = `Client`.
- **Task-level visibility:** `internal` | `client_visible` enum on tasks and comments. Default-secure (`internal` is the default).

---

## 5. Projects

- **Project key/prefix** (e.g. `MOB`, `ADMIN`, `WEBSITE`) — 2-10 uppercase letters, auto-suggested from name, Admin-confirmed, **immutable**, **never reused** even if project is archived/deleted.
- **Workflow preset chosen at creation, not customizable per-project:**
  - **Engineering:** `Todo` → `In Progress` → `In Review` → `Testing` → `Done`
  - **Design:** `Todo` → `In Progress` → `In Review` → `Approved` → `Done`
  - **Generic:** `Todo` → `In Progress` → `Done`
- **Blocked is a flag, not a status.** A task in any status can be flagged blocked. Boolean + optional reason. Independent of workflow.
- **QA/Testing is a real step** distinct from code review in Nockta culture — keep both columns in the Engineering preset.
- **Sprints toggle** is per-project, **independent of workflow preset**. Engineering project can run sprintless (kanban) or sprint-based.

---

## 6. Task engine

### Schema
```
Task
├── id (uuid)
├── key (per-project prefix + per-project incrementing number, e.g. MOB-142)
├── project_id
├── title
├── description (markdown)
├── status (workflow-preset-dependent enum)
├── priority (Low | Medium | High | Critical)
├── is_blocked (bool)
├── blocked_reason (nullable text)
├── visibility ('internal' | 'client_visible')
├── reported_by_client (bool, default false)
├── parent_task_id (nullable — subtask relationship)
├── sprint_id (nullable)
├── assignee_user_id (nullable)
├── reporter_user_id
├── due_date (nullable)
├── estimate (nullable int, unit-agnostic)
├── board_position (string, fractional index, board-scoped)
├── created_by_user_id
├── created_at
├── updated_at
```

Notable absence: **no custom metadata column**. Future feature-specific data gets its own typed table (e.g. `task_github_links`, `task_deployments`).

### Subtasks
- Subtasks are full tasks with `parent_task_id` set.
- Parent task **cannot move to `Done`** while any child is not `Done` or canceled. (Hard rule — only enforced relationship.)

### Task relationships (`task_links` table)
- `blocks` — directional, **advisory**. Confirmation modal when moving the blocked task forward.
- `related` — bidirectional, purely informational.
- `duplicate` — directional. UI prompt: "Mark X as duplicate of Y and close X? [Yes / Just link]".
- **Cross-project relationships allowed.**

### Board ordering
- **Fractional indexing** (`fractional-indexing` npm package).
- `board_position` is board-scoped — only used for board view ordering.
- List view sorts by user-selected column.

---

## 7. Sprints

- Per-project `sprints_enabled` toggle.
- Sprint has: name, `start_date`, `end_date`, `state` (`planned` | `active` | `completed`), `project_id`.
- **One active sprint at a time per project.** Multiple `planned` sprints allowed.
- Tasks have nullable `sprint_id`. `NULL` in a sprint-enabled project = backlog.
- **Complete sprint:** incomplete tasks → backlog (prompt confirms).
- **Velocity** = task count + sum of estimates (`estimate` is a unit-agnostic integer field, optional per task).
- **Burndown charts included.**

---

## 8. Activity timeline + audit log

- **Single `events` table, two views.**
- Schema: id, type, actor_user_id, entity_type, entity_id, project_id, payload (jsonb), visibility (`public` | `internal` | `admin_only`), created_at.
- **Activity Timeline** view: surfaced on task pages, project pages, user profiles. Filtered to entities the viewer can access AND `visibility != 'admin_only'`.
- **Audit Log** view: Admin-only. Includes `admin_only` events (logins, permission changes, integration installs, signature failures, data exports, etc.).
- **Client timeline filter:** `visibility = 'public'` AND `payload.is_internal != true`.
- **Event log is the system of record.** Realtime, notifications, and timeline all derive from the same source.
- **Partition by month from day one.** Indexes on `(project_id, created_at DESC)`, `(entity_type, entity_id, created_at)`, `(actor_user_id, created_at DESC)`, plus partial index for `admin_only`.
- No retention/deletion. Immutable history.

---

## 9. Realtime

- **Socket.IO + NestJS gateway + Redis adapter from day one.**
- **JWT in handshake** for auth.
- **Rooms:**
  - `project:{id}` — joined on project view.
  - `task:{id}` — joined on task detail.
  - `user:{id}` — joined on connect.
- **Backend-enforced join authorization** (not just broadcast-time check).
- **Realtime events:** task moves/updates, new comments, notification badge, sprint state changes, **online presence**, **typing indicators**.
- **Optimistic UI** + last-write-wins server-side.
- **On reconnect:** refetch all active queries via TanStack Query. No event replay.
- **Domain event flow:** API → DB → in-process EventEmitter → 3 consumers (events table writer, notification dispatcher, Socket.IO broadcaster).

---

## 10. Notifications

### Triggers
| Event | Recipient |
|---|---|
| Task assigned to me | assignee |
| Watched task updated (status/priority/due date/description) | watchers (not the editor) |
| Comment on watched task | watchers (not the commenter) |
| `@mention` in comment/description | mentioned user |
| Watched task moved sprints | watchers |
| Client bug report in project | project Managers |
| Sprint started/completed | project Managers |
| GitHub auto-transition on watched task | watchers |
| Task marked Blocked | watchers + reporter |

### Watcher auto-add
- Creator: auto-watch.
- Assignee: auto-watch on assignment (auto-unwatch on reassignment unless also creator).
- Reporter: auto-watch.
- Commenters: do **not** auto-watch.
- Mentioned users: do **not** auto-watch.

### Channels
- **In-app** — always on, can't disable.
- **Google Chat DM** — default OFF until user binds account. Per-event-type override after binding.
- **Email as notification channel: removed.** Internal users get Chat + in-app; clients get in-app on the portal. (Email is reserved for magic-link auth delivery only — see §23.)

### Other
- **Per-task mute** supported.
- `@everyone` not supported. `@team-name` mentions a Team (fires DMs to each member).
- **Digest mode, snooze, per-project notification overrides — all included.**

### Client notifications
- **In-app on client portal only.** No email, no Google Chat.
- Triggered for: comments on tasks they reported (client_visible only), status changes on tasks they reported, mentions in client-visible comments.
- Never triggered by internal-only comments/tasks.
- Magic-link login emails are auth-flow, not notifications — handled separately via Gmail SMTP.

---

## 11. Comments

- **Markdown editor.** CommonMark + extensions: `@user`, `@team`, `#TASK-KEY` autolinks, code fences, image embed.
- **Mentions:** autocomplete from project members (Admins always visible). For `client_visible` comments, autocomplete restricted to client-visible members.
- **Edit/delete:** 15-minute grace window for the author. After 15 minutes: locked.
- **Admin/Manager can delete any comment.** Tombstone left ("Comment deleted by [admin]"), soft-delete for 30 days, hard-delete by cleanup job.
- **No public edit history** (no "edited X minutes ago" tooltip).
- **Inline image embed** via paste/drop. Markdown `![](attachment:abc123)` inserted automatically.
- **Per-comment visibility toggle** with default-secure: on a `client_visible` task, new comments default to `internal` — author must toggle to share.
- **Clients writing comments are always `client_visible`** (no toggle for them).

---

## 12. Storage & attachments

- **MinIO** from day one. S3-compatible.
- **Per-file limit:** 100MB default (Admin can raise), 500MB hard cap.
- **No per-task or per-project quota.** Monitor bucket size in Grafana; alert on growth.
- **Allowed types:** nearly everything. Block executables and double-extensions: `.exe`, `.bat`, `.cmd`, `.sh`, `.ps1`, `.msi`, `.dmg`, `.app`, `.jar`, `.com`, `.scr`, `.vbs`, `*.pdf.exe`-style. Server-side check on confirm step.
- **Virus scanning (ClamAV) included.** Workers scan on confirm; quarantine bucket for failures.
- **Three-step signed-URL upload flow:**
  1. `POST /attachments/sign` → server returns signed PUT URL + `upload_id`.
  2. Client uploads to MinIO directly.
  3. `POST /attachments/confirm` → server verifies, creates `attachments` row, fires event.
- **Signed PUT TTL:** 5 minutes. **Signed GET TTL:** 15 minutes (client renews on expiry).
- **Storage key:** `projects/{projectId}/{parent_type}/{parent_id}/{attachmentId}-{slugifiedFilename}`.
- **Image thumbnails:** 200px + 800px WebP via Sharp worker.
- **Video thumbnails included.** PDF first-page previews included.
- **Soft-delete + 30-day retention** before hard-delete by cleanup job.
- **Schema:**
  ```
  attachments
  ├── id
  ├── parent_type (Task | Comment | BugReport)
  ├── parent_id
  ├── project_id
  ├── uploader_user_id
  ├── original_filename
  ├── mime_type
  ├── size_bytes
  ├── storage_key
  ├── thumb_200_key (nullable)
  ├── thumb_800_key (nullable)
  ├── visibility ('internal' | 'client_visible')
  ├── scan_status ('pending' | 'clean' | 'infected')
  ├── deleted_at (nullable)
  ├── created_at
  ```

---

## 13. GitHub integration

- **GitHub App** (not OAuth, not PAT).
- **One Nockta org.** Single installation.
- **Loose binding:** routing is by task-key prefix from any repo the App has access to. Project↔repo binding is for display/sidebar only.
- **Parse for task keys in:** commit messages, PR title, PR description, branch name.
- **Multi-task references:** all matched tasks transition (where rules apply).

### Auto-status rules (Engineering preset only, per-project toggle, default ON for Engineering)

| GitHub event | Task currently in | Auto-action |
|---|---|---|
| Push first commit referencing key | `Todo` | → `In Progress` |
| Push first commit referencing key | anything else | no change, attach commit |
| PR opened (draft) | any | no status change, attach link |
| PR opened non-draft / ready-for-review | `Todo` or `In Progress` | → `In Review` |
| PR merged | `In Review` or `In Progress` | → `Testing` |
| PR closed without merge | any | log + UI banner, **no auto-revert** |
| PR reopened | `In Progress` | → `In Review` |
| Any of the above | already past target state | no-op |

- **Compatible-state override semantics:** auto-transitions only fire if the current state matches the rule's "currently in" column. Manual moves to non-source states are respected.
- **Blocked flag is independent** of status — persists across auto-transitions.

---

## 14. Google Chat

- **Build a Google Chat App** (bot identity), one-time Workspace install by Admin.
- **Service-account auth.** Scopes: `chat.bot`, `chat.messages.create`.
- **User binding flow:**
  1. User signs into Nockta Flow via Google OAuth.
  2. First-time prompt: "Connect Google Chat?"
  3. User clicks "Add to Chat" deeplink → sends any message to the bot → bot's `onMessage` handler maps Chat user ID → space ID → Nockta Flow user (matched by email).
  4. Stored: `user.google_chat_space_id`, `user.google_chat_user_id`.
- **Cards v2** for all message formatting. One card builder per event type, in `apps/api/src/modules/chat/card-builders.ts` (was originally planned for `apps/workers/` — workers are now in-process; see §21).
- **Inline interactive actions included:**
  - `TaskAssigned` → Open / Accept / Reassign… / Mark Done
  - `CommentAdded` → Open / Reply…
  - `MentionedInComment` → Open / Reply…
  - `TaskBlocked` → Open / Unblock / Comment…
  - `PRMerged` → Open / Mark Done
  - `ClientReportedBug` → Open / Acknowledge / Assign to me
- **Callback URL:** `POST /chat/interactions`. Google Chat bearer token verified on every callback. Idempotent via `action_id`.
- **Dialog-based actions** (Reassign…, Reply…) open a Chat dialog; on submit, hit same API endpoints as web. Realtime + notifications propagate normally.
- **Authorization** enforced server-side as if action were taken in-app. Dialog response on 403.
- **Team/project Chat-space delivery (broadcast in rooms):**
  - Per-project setting (Manager/Admin configures): "Broadcast to space [picker]".
  - Bot must be invited to the space first.
  - Events broadcast: `SprintStarted`, `SprintCompleted`, `DeploymentSuccess`, `DeploymentFailed`, `ProductionReleaseTagged`, `CriticalTaskBlocked`, `ClientReportedBug`.
  - DM-only for: `TaskAssigned`, `CommentAdded`, `MentionedInComment`.
- **Chat hidden from client portal.** Clients can't bind Chat.
- **Failure handling:** BullMQ retry with exponential backoff (3 attempts). Stale `space_id` → null + reconnect prompt. In-app notification is source of truth.

---

## 15. External-client experience

- **One SPA for everyone** — `apps/web` serves internal users and external clients. The original `apps/client` portal was retired; two parallel design systems drifted and the API was always the boundary. Role-conditional UI hides internal-only sections (Workload, Standup, Worklog, Deployments, Automations, Settings) for `kind=client` users.
- **One domain:** `app.nockta.com` for everyone.
- **Magic-link auth** for clients via `/auth/magic`. Internal users use Google OAuth.
- **Backend enforces role permissions at the API layer** — a client request to internal endpoints gets 403, never an exposed view.
- **Three project-role flavours for external collaborators:** Contributor (full edit), Viewer (read-only), Client (bug-report only, forced type=Bug + visibility=client_visible). Restriction is keyed on project role, not user kind.
- **Bug report → direct task** in the project's `Todo` column with `reportedByClient = true`, attachments allowed, project Manager gets Google Chat notification.
- **No internal triage queue** — keeps the pipeline single-rail.

---

## 16. Deployment / CI/CD tracking

- **Integrations supported:** Vercel, Railway, GitHub Actions, generic Docker pipeline webhooks.
- **Events attached to tasks:** `DeploymentStarted`, `DeploymentSucceeded`, `DeploymentFailed`, `RollbackTriggered`, `ProductionReleaseTagged`.
- **Per-project deployment config:** webhook receiver URL per project (signed with HMAC).
- **Auto-status on `DeploymentSucceeded`** for production environment + linked tasks in `Testing`: → `Done`. (Other environments/branches: log only, no auto-transition.)
- **Schema:** `deployments` table — id, project_id, environment, status, source (vercel/railway/github/docker), commit_sha, started_at, finished_at, metadata (jsonb).
- **`task_deployments`** join table linking deployments to tasks (via the commit→task linking pipeline).
- **Chat-space broadcast** to configured space on `DeploymentFailed` and `DeploymentSucceeded` (production only).

---

## 17. Search

- **Postgres full-text search** with `tsvector` generated columns on tasks (title + description) and comments (body).
- **Scope:** task titles, descriptions, comments, labels, assignee names, project names.
- **Filters:** project, status, priority, assignee, sprint, blocked flag, date range, reported_by_client, has-attachments.
- **Permission-aware:** search results filtered by viewer's project access and task visibility.
- **Saved searches** per user.
- **Elasticsearch/OpenSearch** wired in as a parallel index for full-text + fuzzy + ranking. Postgres FTS remains for exact + filter queries.

---

## 18. Analytics & reporting

- **Metrics tracked:**
  - Overdue tasks (current count, weekly trend)
  - Sprint velocity (per project, trailing 6 sprints)
  - Workload distribution (open tasks per assignee, weighted by priority)
  - Blocker frequency (count of `is_blocked` toggles per week)
  - Deployment success rate + frequency
  - Cycle time (time from `In Progress` → `Done`)
- **Dashboards:**
  - Personal dashboard (every user): "My tasks overdue, my tasks in progress, my mentions"
  - Project dashboard (Manager+): everything above, scoped to project
  - Org dashboard (Admin only): all projects, deployment health, blocked tasks across org, workload per team
- **Burndown charts** per active sprint.
- **Storage:** materialized views refreshed on a cron schedule (every 5 min for high-velocity metrics, daily for trailing trend metrics).

---

## 19. AI layer

- **Stack:** Ollama for local LLM inference + Qdrant for vector search.
- **Capabilities included:**
  - AI sprint summaries (text generation over completed sprint's events)
  - Standup generator (per user, "what did I do yesterday, what's planned today, blockers")
  - Duplicate issue detection (vector similarity against open tasks on bug creation)
  - Automatic prioritization suggestions (LLM read of task description + history → priority recommendation)
  - PR summarization (LLM read of PR diff + description → posted as comment on linked task)
  - Blocker prediction (warn on tasks likely to slip based on history)
- **Trigger model:** background workers consume domain events from the event bus and produce AI artifacts asynchronously.
- **Embeddings stored in Qdrant.** Task vectors keyed by task ID; refreshed on title/description change.

---

## 20. Technical stack (from brief, accepted)

| Layer | Choice |
|---|---|
| Backend | NestJS |
| ORM | Prisma |
| Database | PostgreSQL |
| Cache / sessions / presence | Redis |
| Queue | BullMQ |
| Frontend (internal + client) | React + Vite |
| UI library | Tailwind CSS + shadcn/ui |
| Client state | Zustand |
| Server state | TanStack Query |
| Realtime | Socket.IO |
| Object storage | MinIO |
| Reverse proxy | Nginx |
| Monitoring | Grafana + Prometheus + Loki |
| Local LLM (AI layer) | Ollama |
| Vector DB (AI layer) | Qdrant |
| Search (later) | Elasticsearch/OpenSearch |
| Image processing | Sharp |
| Virus scanning | ClamAV |
| Transactional email (magic links only) | Gmail SMTP via Google Workspace (Nodemailer + service account, impersonating `noreply@nockta.com`) |

---

## 21. Monorepo structure

```
apps/
├── api          NestJS backend (also hosts in-process BullMQ workers)
└── web          React + Vite — internal users AND external clients
                  (single shell on app.nockta.com, role-conditional UI)

packages/
├── ui           shared shadcn/ui component layer + design tokens
├── types        shared TypeScript types (DTOs, event payloads)
├── sdk          shared API client (typed, used by apps/web)
├── eslint-config
└── tsconfig
```

**Workers run in-process inside `apps/api`.** The original design had a
separate `apps/workers` process for BullMQ jobs (notification, attachment
scan / thumbnail, AI embed/duplicate/summarize, partition creation,
soft-delete cleanup, materialized-view refresh). At 30 internal engineers
the operational cost of a second deployable doesn't pay for itself, so all
processors and `setInterval`-based schedulers live inside the API. The
trade-off: any horizontal-scale-out of the API requires distributed-lock
guards on the schedulers (or carving workers back out). Revisit when
either job throughput or API replica count exceeds a single node.

**Monorepo tool:** pnpm workspaces + Turborepo.
**Repo location:** `/Users/mazen/Documents/Work/pm/` (this directory).

---

## 22. API design

- **REST + OpenAPI/Swagger** for documented endpoints.
- **GraphQL not built** — listed as future in brief, no concrete demand.
- **Versioning:** URL-prefixed (`/api/v1/...`).
- **Error shape:** RFC 7807 problem details.
- **Pagination:** cursor-based for list endpoints.

---

## 23. Security

- **JWT rotation** with refresh-token rotation + reuse detection.
- **RBAC middleware** at every endpoint.
- **CSRF protection** for cookie-based session flows.
- **Rate limiting** per user + per IP (Redis-backed).
- **Signed upload URLs** (5min PUT, 15min GET).
- **Webhook signature validation** on GitHub + Chat + deployment webhooks.
- **Audit logging** of all `admin_only` events.
- **Secrets management:** environment variables in dev, GCP Secret Manager in prod (pending hosting confirmation).

---

## 24. Infrastructure

- **Containerized services** — `frontend-internal`, `frontend-client`, `backend`, `workers`, `postgres`, `redis`, `minio`, `nginx`, `ollama`, `qdrant`, `clamav`, `prometheus`, `grafana`, `loki`.
- **Docker Compose** for local dev + initial deploy.
- **Production hosting target:** pending Final Q confirmation.
- **Reverse proxy:** Nginx — SSL termination, routing, websocket proxying.
- **Logging:** structured JSON to stdout → Loki via Promtail.
- **Metrics:** Prometheus scrape on every service's `/metrics`.
- **Dashboards:** Grafana — API latency, websocket connections, worker queue depth, error rates, deployment frequency.

---

## 25. UI/UX direction

- **Jira-familiar** for navigation, board interactions, issue modal, keyboard shortcuts, sidebar layout.
- **Avoid** Jira's admin panels, workflow complexity, deep config trees, overloaded issue types, complicated permissions.
- **Keyboard-first navigation** — `?` for shortcut help, `c` to create task, `/` to search, `j/k` to move through lists, etc.

---

## Decisions explicitly overriding the brief

1. **Workspace abstraction removed** (brief implied multi-tenant via Workspace; we collapsed to single-org).
2. **Teams have permission semantics** (brief said "NOT permissions inheritance").
3. **Blocked is a flag, not a status** (brief listed it as a status).
4. **Subtasks are full tasks with `parent_task_id`** — collapsed the brief's separate "subtasks" and "parent-child relationship" into one concept.
5. **No customizable workflow engine** — workflow is a preset chosen at project creation, not user-defined per project. (Brief said "Avoid customizable workflow engines initially" — we lock this in permanently.)
6. **No "custom metadata" JSONB column.** Feature-specific attached data goes in proper typed tables.
7. **Workflow preset Engineering keeps both `In Review` and `Testing`** (brief showed `Review` + `Testing`; we clarified roles: Review = code review, Testing = QA).
8. **All deferrals removed** — burndown charts, presence/typing, digest/snooze, virus scanning, video/PDF previews, AI layer, etc. all in scope.
