# Contributing to Nockta Flow

Thanks for digging in. This doc is the short version of how we work. The longer reasoning is in the [ADRs](docs/adr/) and in [`GRILL-SUMMARY.md`](GRILL-SUMMARY.md).

---

## Local setup

See the [quick start in the root README](README.md#quick-start). The three things that bite newcomers:

1. **Use pnpm.** `npm install` and `yarn install` will not produce a working tree (the root `package.json` pins `packageManager` and `engines`).
2. **Generate JWT secrets** before starting the API. `pnpm gen:secrets` prints two random ones; append them to your `.env`. The API refuses to boot with the placeholder values.
3. **Bring up the docker stack** (`pnpm docker:up`) before running the API. Postgres, Redis, MinIO, ClamAV, Qdrant, and mailhog all need to be running.

---

## Branches & commits

### Branch naming

```
<type>/<short-kebab-summary>[-<issue-or-ticket>]
```

Examples: `feat/ai-blocker-summary`, `fix/board-drag-flicker-NF-412`, `chore/bump-prisma-5.20`, `docs/contributing-guide`.

Types: `feat`, `fix`, `chore`, `refactor`, `perf`, `test`, `docs`, `build`, `ci`, `revert`.

### Commit messages — Conventional Commits

```
<type>(<scope>): <imperative summary>

<optional body — wrap at 72 cols>

<optional footer>
```

- **type**: same set as branch types.
- **scope**: a module or package: `api/tasks`, `web/board`, `sdk`, `types`, `infra`. Optional.
- **summary**: imperative mood ("add", "fix", "remove"), no trailing period, ≤ 72 chars.
- **body**: explain why, not what. Reference the ADR if the change is structural.
- **footer**: `Refs NF-123`, `Closes NF-456`, `BREAKING CHANGE: ...` for breaking changes.

Examples:

```
feat(api/tasks): blocked flag is independent of status

Splits "blocked" from the status state machine. The status enum no
longer carries Blocked; we set Task.isBlocked + Task.blockedReason
and emit task.blocked events. Migration is backfilling existing
Blocked-status rows.

Closes NF-218
```

```
fix(web/realtime): reconnect drops typing indicator after JTI rotate

Closes NF-401
```

We don't enforce conventional commits with a lint hook, but PR reviewers will ask you to clean up the squash message if it doesn't follow the format.

---

## Pull requests

### Before opening

- [ ] Branch is up to date with `main`.
- [ ] `pnpm lint` clean.
- [ ] `pnpm typecheck` clean.
- [ ] `pnpm test` clean (for the affected packages at minimum).
- [ ] If the change touches the API: tests added or updated.
- [ ] If the change touches the schema: migration is in `apps/api/prisma/migrations/`, `companion.sql` is updated if needed, and `pnpm db:generate` was run.
- [ ] If the change is structural: an ADR is added under `docs/adr/`.
- [ ] If the change touches public API contracts: `@nockta/types` and the SDK have been regenerated.
- [ ] If the change affects env vars: `.env.example` and `docs/operations/env.md` are updated.
- [ ] Manual smoke test in dev (`pnpm dev`) — at least one screenshot or video for UI changes.

### PR description

A good PR description has:

- **What** changed in one sentence.
- **Why** — the user-visible or operator-visible motivation. Link the ticket.
- **How** — bullet points if the change spans multiple files / modules.
- **Risks / rollout notes** — anything an operator should know.
- **Screenshots / videos** for UI changes.

PRs are squash-merged. The squash commit message should match the Conventional Commits format above.

### Review process

- **One approval** from a code owner is required for merge (branch protection).
- **Two approvals** for schema migrations, security-touching code, deploy-config changes, and ADRs.
- **CI must be green.** Lint, typecheck, test, build all run.
- Reviewers should respond within one business day. If they can't, they should reassign.
- Authors should respond to review comments within one business day or note that they're blocked.

---

## Code style

### TypeScript

- **Strict mode is on.** `noImplicitAny`, `strictNullChecks`, `noUncheckedIndexedAccess`. Don't disable, fix.
- **Prefer `type` for shapes, `interface` for extension points.** Both are fine; consistency within a file matters.
- **No `any`.** Use `unknown` and narrow, or model the type properly. If you genuinely need `any`, add a `// eslint-disable-next-line` with a justification.
- **Avoid `as` casts.** If you need one, narrow with a type guard instead.

### Linting & formatting

- **ESLint** config lives in `packages/eslint-config/`. Run `pnpm lint`. Max-warnings is `0` — warnings break the build.
- **Prettier** for formatting. Config in `.prettierrc`. Run `pnpm format` to apply.
- No commented-out code in committed branches.

### Naming

- Files: kebab-case for everything (`tasks.service.ts`, `task-drawer.tsx`). React components are still `PascalCase` exports but the file is kebab-case.
- Variables / functions: camelCase. Booleans use `is`/`has`/`should` prefixes (`isBlocked`, `hasAccess`).
- React components: PascalCase.
- Constants / enums: `UPPER_SNAKE_CASE` for module-level constants; `PascalCase` for enum members.
- DB columns: camelCase in Prisma schema (Prisma maps to whatever the DB has).

### Backend specifics

- Controllers stay thin (validate input, call service, format response).
- Services accept `workspaceId` as the first argument for workspace-scoped operations.
- Don't add new fan-out at call sites — emit a domain event and let `event-writer` / `notification-dispatcher` / `realtime-broadcaster` subscribe.
- Background work goes on a BullMQ queue.

### Frontend specifics

- Server state goes in TanStack Query, not `useState`.
- Local UI state goes in Zustand, not lifted React state.
- No direct `fetch` calls — use the `@nockta/sdk` package.
- Tailwind first; CSS modules only when Tailwind can't express it.
- Logical directional utilities (`ms-`, `me-`, `text-start`) instead of `ml-`, `mr-`, `text-left` so RTL works for free.

---

## Testing requirements

| Change shape | Required tests |
|---|---|
| New service method | Unit tests covering happy path + at least one error path |
| New controller | Smoke test that hits the route + asserts shape; auth path covered |
| New BullMQ processor | Unit test for the handler; mock the queue |
| New scheduler | Unit test that the scheduler-lock is acquired + released |
| New Prisma migration | Manual: `migrate dev` clean, `companion.sql` reapplies, seed runs |
| New React component | Component test if it owns state; visual snapshot for layout-only |
| New mutation hook | Test the optimistic update + rollback path |
| Bug fix | Regression test that fails before the fix and passes after |

We don't enforce a coverage percentage but the trend is monitored. New `*.service.ts` files should aim for ≥ 80% line coverage.

---

## Schema changes

1. Edit `apps/api/prisma/schema.prisma`.
2. Run `pnpm db:migrate` locally and give the migration a descriptive name.
3. If the change needs raw SQL (partial unique, check constraint, generated column, partition, materialized view): add it to `apps/api/prisma/migrations/companion.sql` and make it idempotent.
4. Run `pnpm db:generate` to regenerate the Prisma client.
5. Update `@nockta/types` if any new enum or shape needs to flow to the frontend.
6. Run the seed (`pnpm --filter @nockta/api prisma:seed`) to make sure the new schema is seedable.
7. Verify the test suite passes against the new schema.

Migration PRs get two approvals. See [`runbook.md`](docs/operations/runbook.md#database-migrations) for the rollback procedure if a migration ships broken.

---

## ADRs

Open an ADR when you're about to make a decision that will be hard to reverse: a new framework, a new external dependency, a structural refactor, a tenancy / security boundary choice, or anything you'd want a successor to know about in two years.

Template at `docs/adr/0001-monorepo-pnpm.md`. Number sequentially. Mark `Status: Proposed` during review; flip to `Accepted` on merge.

---

## Reporting security issues

Email `security@nockta.com`. Do not open a public issue. See [`docs/security/threat-model.md`](docs/security/threat-model.md) for the threat surface and the controls we ship.
