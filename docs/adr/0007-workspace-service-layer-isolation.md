# ADR-0007: Workspace isolation at the service layer, not Postgres RLS

- **Date:** 2026-04-21
- **Status:** Accepted

## Context

R6 introduced multi-tenant workspaces. Every domain row (Project, Task, Sprint, Comment, Attachment, Event, Notification, ...) now belongs to a workspace; users belong to one or more workspaces and must never see another workspace's data. We need a tenancy boundary that is:

- Hard to bypass accidentally (the failure mode of cross-tenant leakage is reputational and contractual).
- Reviewable in code (so we can audit the boundary in PRs).
- Compatible with Prisma's query model.
- Cheap on hot paths (board fetch, search).

Options:

- **Postgres Row-Level Security (RLS)** — set `app.workspace_id` per session, define `USING (workspace_id = current_setting(...))` on every table. Bypass requires SQL injection or a missing policy. Strong defense in depth.
- **Service-layer filtering** — every Prisma query takes `workspaceId` as an explicit `where` clause, enforced by a global `WorkspaceGuard` that pins `request.workspaceId` and a thin repository layer that refuses queries missing the filter.
- **Schema-per-tenant** — one Postgres schema per workspace. Operationally heavy for 100+ tenants, migrations get awkward.
- **Database-per-tenant** — strongest isolation, most expensive. Overkill for our scale.

RLS was the natural first instinct. The problem we hit:

1. **Connection pooling.** Prisma uses a single connection pool. Setting `SET app.workspace_id = $1` per request requires `SET LOCAL` inside a transaction, which means every read becomes a transaction. Measurable overhead on the board-fetch hot path.
2. **Migrations.** RLS policies are SQL, which means more weight in `companion.sql` and more drift between Prisma's mental model and the actual table grants.
3. **BullMQ workers + schedulers.** Background jobs don't have a request scope to attach `workspaceId` to. We'd need a parallel mechanism that supplied the same setting from the job payload. Two ways to bypass instead of one.
4. **Test ergonomics.** Service unit tests would all need to set the session variable; integration tests would need a way to disable RLS for fixture setup.

In the trade-off, the determining factor was the BullMQ point: more than half the writes happen in workers, and forcing them through the same gated mechanism as HTTP requests would mean wrapping every job payload with a workspace context that the worker bootstrapper applies before invoking the service. That is exactly the indirection we'd be using to avoid touching service code — but the service code is already where the workspace boundary is most naturally enforced.

## Decision

Enforce the workspace boundary at the **service layer**, with these rules:

1. A global `WorkspaceGuard` resolves the workspace from the JWT (`payload.workspaceId`), validates the user is a member, and attaches `request.workspaceId`. Routes that don't need a workspace use `@Public()` or `@SkipWorkspace()` and are documented.
2. Services accept `workspaceId` as the first argument of every method. Methods that operate on multiple workspaces (admin-only, observability) are tagged with a `@CrossWorkspace()` decorator and reviewed individually.
3. Every Prisma query on a workspace-scoped table includes `where: { workspaceId, ... }`. A lint rule (custom AST check in `packages/eslint-config`) flags Prisma calls on workspace-scoped models that lack the filter.
4. Workspace-scoped foreign keys are enforced at the DB level via composite `(workspaceId, id)` checks where the relationship can cross workspaces by mistake (e.g. `TaskLink.targetTaskId`, `ProjectAccess.subjectKind=team` must resolve to a team in the same workspace). These are in `companion.sql`.
5. BullMQ job payloads carry `workspaceId`; the processor calls the same service methods with the same first argument. No special path.
6. `Event`, `Notification`, `AuditLog`, `OutboundWebhook`, `AiUsageEvent` all carry `workspaceId` and are filterable by it. Cross-workspace queries by admins go through a separate `AdminController` set that bypasses the guard explicitly and is audit-logged.

We accept that this is "depth one" — a missing `where` clause on a Prisma call would leak. The mitigations are: the lint rule, code review, unit tests that assert cross-workspace fixtures don't appear in results, and integration tests that probe known cross-workspace attack paths.

## Consequences

- **+** No transaction wrapping on every read; board fetch keeps its single-query path.
- **+** Workers + schedulers use the same service layer as HTTP requests; one boundary, not two.
- **+** Migrations stay focused on data shape, not on policies.
- **+** Test setup is straightforward — pass a workspace ID.
- **−** Defense in depth is shallower than RLS. A missed `where` clause leaks. The lint rule + integration tests are the compensating controls.
- **−** Adding a new workspace-scoped model means remembering to:
  1. Add `workspaceId` to the schema with an index.
  2. Add it to the lint rule's allowlist.
  3. Include `workspaceId` in service-method signatures.
  4. Cover with cross-workspace test fixtures.
- **−** Admin / observability paths are explicitly cross-workspace and must be audited carefully. We log every cross-workspace query.

If the threat model changes (e.g. compliance requires hard isolation), we can layer RLS on top later — the service-layer filter is compatible with RLS and would become belt-and-suspenders, not a rewrite.
