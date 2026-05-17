# Nockta Flow — Readiness Score

Honest assessment as of the end of this session. No sugar-coating. If a thing has a number next to it, that number is calibrated against "what a senior eng would expect from a v1 internal tool."

---

## Bottom-line score: **62 / 100**

The repo runs locally, the dev-admin path is solid end to end, and the backend has surprising depth (real WebSocket gateway, real BullMQ pipeline, real webhook signature verification). What pulls the score down is the **frontend — only ~15% of the UI surfaces in the design exist**. The platform behind the curtain is much more complete than the user-facing app would lead you to believe.

| Pillar | Score | One-line take |
|---|---:|---|
| Local dev setup | **9 / 10** | One command works end to end. |
| Backend correctness | **8 / 10** | Solid wiring, modules clean, schema honest. |
| Database / migrations | **6 / 10** | `prisma db push` works; the real migration files don't exist yet. |
| Frontend (internal) | **3 / 10** | Login + dashboard + projects list + board. That's all. |
| Frontend (client portal) | **3 / 10** | Same shape — just enough to file a bug. |
| Integrations | **7 / 10** | GitHub + Chat + Deployments wired with signature verification; not exercised. |
| Realtime + Notifications | **8 / 10** | Plumbing is real and clean. Visible features that consume it are sparse. |
| Security hygiene | **6 / 10** | JWT rotation, webhook HMAC, rate-limit set up. CSRF missing; admin endpoints rely on service-layer guards rather than decorators. |
| Test coverage | **0 / 10** | Zero tests. Vitest is configured but unused. |
| Documentation | **8 / 10** | GRILL-SUMMARY, GAP-REPORT, LOCAL-RUN, READINESS-SCORE, env example all live in the repo. |

Weighted (60% backend, 30% frontend, 10% ops) → **62**.

---

## What works right now, end to end

1. `pnpm install` (first time only) — installs all workspace deps.
2. `pnpm dev` — starts Postgres, Redis, MinIO; waits for healthy; runs `prisma db push`; applies the companion SQL (partial unique indexes, check constraints, FTS columns); kills any orphan dev-port holders; runs the API, web app, client portal, and a workers stub via Turborepo.
3. Open <http://localhost:5173/login> → click "Sign in as admin (dev only)" → land on the dashboard signed in as `admin@nockta.com` with role `Admin`.
4. Click "Projects" in the sidebar → see the empty projects list. Create a project via Swagger at <http://localhost:3000/docs> (POST `/projects`), refresh, click into it → see the empty Kanban board with the engineering preset columns.
5. Create a task via Swagger (POST `/tasks`), refresh the board → see it. Drag-and-drop between columns → status updates via PATCH, board syncs.

The realtime channel is live: open the same project in two browser tabs, drag a task in one, see it move in the other.

---

## Issues fixed this session (compared to the audit findings)

**Blockers (would have prevented basic use):**
- Clients got 403 on `GET /tasks/project/:projectId` — `assertAtLeast('Viewer')` excluded `Client` rank. Now `assertAtLeast('Client')` with the visibility filter doing the actual narrowing.
- Search endpoint crashed with `column "search_vector" does not exist` because the FTS column was in raw-SQL-only territory. Rewrote `SearchService.searchTasks` to use Prisma `contains: q, mode: 'insensitive'` over title + description + comments. FTS path can come back when the companion SQL has had time to bake in production.
- `pnpm dev` failed if a previous run had crashed and left ports held. Now pre-flights `lsof -ti tcp:$port | xargs kill -9` on 3000/5173/5555.
- `docker compose --wait` failed on `minio-init` because it's a one-shot container. Split into "wait on long-running services" + "run init with tolerated exit".
- Sidebar `Search` / `Notifications` / `Settings` links pointed to routes that didn't exist; clicking bounced back to `/` via the catch-all. Removed from `navItems` until the pages exist.

**High-impact bugs (would have crashed core flows):**
- `GrantAccessDto.subjectKind` used `@IsEnum(['user','team'])` which class-validator parses as positional indices. Switched to `@IsIn(['user','team'])`. Project access grants were unusable from the frontend.
- `UpdateProjectDto` did not declare `chatBroadcastEvents` but the service accepted it. With `forbidNonWhitelisted: true` set globally, every request that tried to set it 400'd. Field is now in the DTO.
- `setBlocked` DTO ran `@Type(() => Boolean)` which truthy-coerces the literal string `"false"` to `true`. Removed.

**Hygiene / security:**
- `/auth/me` returned the JWT `jti` to the client and the Zustand store persisted it to `localStorage`. `me()` now projects out `jti` and returns `name` + `avatarUrl` so the sidebar can show a real display name.
- `getSocket()` would leak a stale, disconnected socket on reconnect. Now properly disposes the old socket before creating a new one.
- Dead `buildCardForNotification` import removed from `ai-cron.service.ts`.
- `LoginPage` and `RequestMagicLinkPage` now surface real server error messages instead of swallowing them into generic "Could not …" toasts.
- `ClientProjectPage` read the project id from `window.location.pathname`, which was a) non-reactive and b) fragile. Switched to `useParams`. Added a project header fetched via `/projects/:id`.

**Infrastructure:**
- Created `apps/api/.env` with corrected ports (the `.env.example` had `5432`/`6379`; docker-compose actually exposes `5433`/`6380`).
- Added `process.loadEnvFile()` (Node 20.6+ built-in) to `apps/api/src/main.ts` so the dev script picks up `.env` without adding `dotenv` as a dep.
- Created `apps/workers/src/main.ts` as a stub so `turbo run dev` doesn't crash on the empty workspace member.
- Added the dev-login endpoint plus an `AuthService.devLoginByEmail()` that upserts an admin on first call — the frontend button was wired to a non-existent endpoint before.
- Wrote `apps/api/prisma/migrations/companion.sql` (idempotent) for the constraints + FTS that Prisma can't express, applied automatically by `pnpm dev`.

---

## Issues that are NOT fixed and what they mean

### Backend
- **`github-events.service.ts` `isFirstLink` logic bug** — the side effect that posts a comment to the PR when it's first linked to a task never fires (always reads as not-first). LOW severity for local dev; only matters when GitHub is actually wired up.
- **`/projects` and `/projects/:id` leak internal fields** to all callers (`createdById`, `chatBroadcastEvents`, `chatSpaceId`, etc.). Frontend ignores them, but it's a small contract leak — especially to client users. Add explicit `select` to both list/get methods.
- **Per-user rate limiting** declared in GRILL-SUMMARY §23 but not differentiated from the global throttle. The `RATE_LIMIT_PER_USER_PER_MIN` env var is read but never used.
- **`Event` table partitioning is documented but not applied.** For 30 internal engineers this is fine. Will become a slow-query problem at scale.
- **No real Prisma migration files** — `prisma db push` is used to sync the schema. Fine for local dev; not how you want to deploy to prod. First production deploy will need a real `prisma migrate dev` run committed.

### Frontend (the big one)
The web app has exactly four routes (`/`, `/login`, `/auth/callback`, `/projects`, `/projects/:id/board`). What's missing:
- **Task detail / modal** — clicking a card on the board does nothing. Every Jira-style flow funnels through the issue modal; without it you cannot edit a task title, change priority, set a due date, assign a sprint, link tasks, attach files, write comments, or read activity. This is the single highest-leverage missing piece.
- **Project creation UI** — projects can only be created via Swagger or curl. There is no UI form.
- **Sprint view** — backend supports planned/active/completed sprints; no UI to plan or run them.
- **Audit log + activity timeline** — backend writes events; no UI to read them.
- **Notifications panel + bell** — backend dispatches notifications; no UI to read them.
- **Search palette** — backend has the endpoint; no UI to invoke it.
- **Analytics dashboard** — backend exposes personal/project/org metrics + burndown; no UI to render them.
- **Settings / admin pages** — no UI for team management, project access management, notification preferences, Chat binding, GitHub installation, deployment webhook secrets, etc. All admin work has to be done via Swagger today.
- **Keyboard shortcuts** — none. The brief calls for `?`, `c`, `/`, `j`/`k`.

The client portal is the same shape: four routes (`/login`, `/auth/magic`, `/`, `/projects/:id`, `/projects/:id/report-bug`). Missing: comments on tasks, attachment uploads, approvals, notifications.

### Workers
**`apps/workers/` is a no-op stub.** All BullMQ processors run inside `apps/api`. For 30 engineers this is fine, but several cron-flavoured jobs that should exist (monthly Event-table partition creation, soft-delete cleanup, materialized-view refresh, digest-mode notification batching) are simply not implemented anywhere.

### Tests
Zero. Vitest is wired in `apps/api/package.json` but no test files exist. Same for the frontends. For a system whose value prop is "fast, reliable engineering operations," not writing a single unit/integration test is the most glaring omission in the repo.

---

## What I'd build next, in order

1. **Task detail modal** in `apps/web`. Unblocks 80% of remaining UI work.
2. **Project creation UI** in `apps/web`. Currently you can't even bootstrap a usable instance without Swagger.
3. **Notifications bell + panel.** The pipeline already produces notifications; you just can't see them.
4. **A handful of integration tests** against the dev-login + tasks/projects/comments paths using `supertest` against the running NestJS app. ~200 lines, would catch 80% of regressions.
5. **Real Prisma migrations** committed to the repo. `prisma migrate dev --name init`, check in the generated SQL, fold `companion.sql` into a second migration file.
6. **Replace `prisma db push` in `scripts/dev.sh` with `prisma migrate dev --skip-seed`** once #5 is done.
7. **Activity timeline UI** on the task detail modal. Backend already records everything.
8. **Sprint planning UI.**
9. **Search palette** (`Cmd/Ctrl-K`).
10. **Split `apps/workers` out for real** OR delete it and document the decision in GRILL-SUMMARY.

---

## The honest version

This codebase is the back half of a real product. The schema, the auth model, the event flow, and the webhook security are at a level you'd expect from someone who's shipped this kind of system before. The front half — the UI you'd actually click — is barely sketched in. If you handed someone the running instance right now and said "use this instead of Jira," they'd come back inside an hour saying "I can't even edit a task title."

The good news: every missing UI surface has a working backend endpoint waiting for it. The remaining frontend work is "draw the rest of the owl" with a complete reference implementation, not "design the owl from scratch." A focused two-week sprint on UI would lift this from 62 to 80+.

The bad news: that two-week sprint hasn't happened yet, and the test suite is empty, so any UI work will be flying without instruments.
