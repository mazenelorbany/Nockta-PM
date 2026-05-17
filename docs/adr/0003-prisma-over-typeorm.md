# ADR-0003: Prisma over TypeORM / Kysely / raw SQL

- **Date:** 2025-02-06
- **Status:** Accepted

## Context

The schema is non-trivial: ~40 models, composite primary keys (e.g. `Event(id, createdAt)` for partitioning), partial unique indexes, check constraints, generated columns, and self-referential trees (parent task, comment thread). We need:

- A single source of truth for the schema that supports migrations.
- Generated types so the API and `@nockta/types` package share DTO shape without manual sync.
- Predictable migration history that survives many engineers editing the schema in parallel.
- Performance close to hand-written SQL on the hot paths (board fetch, search, timeline).

Options:

- **TypeORM** — schema-from-classes, fine for small apps. Migrations are fragile (entity drift, decorator quirks). Active record style mixes data with behaviour.
- **Sequelize** — JavaScript-first; weak TypeScript story.
- **Kysely** — fluent query builder over hand-written types. Great DX but no migration tool of its own; we'd need a separate migration story.
- **Prisma** — schema-first DSL (`schema.prisma`), generates a typed client, owns the migration history. Migrations are diff-based and committed as SQL.
- **Raw SQL via pg / postgres.js** — most control, no abstractions. Too much manual labour for 40 models.

## Decision

Use **Prisma 5** as the ORM and migration tool. `schema.prisma` is the source of truth; `prisma migrate dev` (local) and `prisma migrate deploy` (CI/prod) apply migrations.

For features Prisma can't express natively, ship a companion file (`apps/api/prisma/migrations/companion.sql`) applied immediately after `migrate deploy` in `start.sh`. This file is idempotent and covers:

- Partial unique indexes (one active sprint per project).
- Check constraints (`ProjectAccess.subjectKind`, `CommentMention` exactly-one, `Project.key` regex).
- Generated columns + GIN indexes for FTS (`Task`, `Comment`).
- `PARTITION BY RANGE (createdAt)` on `Event` with current + next month partitions.
- Materialized views (`mv_workload_open`, `mv_sprint_velocity`, `mv_cycle_time_30d`).

Drop down to raw SQL via `prisma.$queryRaw` only when the query optimizer needs help (materialized view refreshes, recursive CTEs for subtask trees, partition maintenance).

## Consequences

- **+** Single schema file is the authoritative artifact; PRs touching the schema are reviewable.
- **+** Generated types flow into `@nockta/types` and the SDK with no manual sync.
- **+** Migrations are SQL files in git, not opaque ORM operations.
- **+** Connection pooling, prepared statements, soft-delete via `deletedAt` filter — all handled.
- **−** Prisma can't express partial indexes, check constraints, or partitioning natively. Hence `companion.sql`. This is a known cost and is documented.
- **−** Some advanced query shapes (window functions, recursive CTEs) require `$queryRaw`. Acceptable trade-off.
- **−** The Prisma client is a heavy import; we pay ~50 ms cold-start vs. a thin query builder.
- **−** `migrate deploy` requires `_prisma_migrations` table ownership. On Railway the plugin role has it; documented in `HANDOVER.md`.
