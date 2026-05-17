# ADR-0001: pnpm workspaces + Turborepo for the monorepo

- **Date:** 2025-02-04
- **Status:** Accepted

## Context

Nockta Flow ships three deployable apps (`api`, `web`, `client`) and four shared packages (`types`, `sdk`, `ui`, `eslint-config`, `tsconfig`). We need shared TypeScript types between API and frontends (so the SDK is generated from the same enum + DTO source), a single lockfile to keep dependency versions aligned, and a build orchestrator that caches per-package builds for CI speed.

Options considered:

- **npm workspaces** — works, but the install tree duplicates packages aggressively, no content-addressable store, and no remote build cache out of the box.
- **yarn (v1)** — workspace support is OK but no caching, hoisting strategy is finicky.
- **yarn (berry / PnP)** — fast, but PnP plays badly with several of our dependencies (Prisma, Nest CLI) that expect a real `node_modules`. Not worth fighting.
- **pnpm + Turborepo** — content-addressable store, strict isolation by default (catches "phantom dependency" bugs), `workspace:*` protocol for internal links, and Turborepo gives us task graph + cache.
- **Nx** — overlapping with Turbo; richer plugin ecosystem but heavier mental model. We don't need the code-gen layer.

## Decision

Use **pnpm 9 workspaces** with `workspace:*` for internal packages, declared in `pnpm-workspace.yaml`:

```yaml
packages:
  - "apps/*"
  - "packages/*"
```

Use **Turborepo** for `build`, `lint`, `test`, `typecheck`, `dev`, configured in `turbo.json`. CI consumes the local Turbo cache today; a remote cache can be wired later without code changes.

Pin to pnpm 9 via `packageManager` and `engines` in the root `package.json` so contributors can't accidentally use npm or yarn.

## Consequences

- **+** Single lockfile (`pnpm-lock.yaml`); reproducible installs across dev/CI/prod.
- **+** Strict dependency boundaries — a package can only import what it declares, surfacing missing deps before deploy.
- **+** Fast installs (content-addressable store, hardlinks).
- **+** Turbo caches `tsc`/`vite build`/`nest build` output by input hash; clean CI runs in single-digit seconds for unchanged packages.
- **−** Some legacy tooling (mostly older ESLint plugin authors) assumes flat `node_modules`. We carry `shamefully-hoist=false` and fix the few that complain.
- **−** Developers new to pnpm sometimes get confused by `workspace:` protocol. Documented in `CONTRIBUTING.md`.
