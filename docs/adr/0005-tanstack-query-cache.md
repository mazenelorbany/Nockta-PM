# ADR-0005: TanStack Query for server state on the web app

- **Date:** 2025-02-12
- **Status:** Accepted

## Context

The web app has many surfaces that read overlapping server state: a board view and a task drawer for the same task, a backlog and a sprint board pulling from the same task list, the navbar's unread-count badge that must reflect the notification list opened in a drawer. We need:

- A cache layer that dedupes concurrent requests for the same resource.
- Targeted invalidation when a write succeeds or a WebSocket event arrives.
- Optimistic update + rollback support for drag-and-drop reorder.
- Suspense / loading / error UX primitives.
- A way to keep React component state focused on UI state and not on server state.

Options:

- **Redux + RTK Query** — solid, but RTK Query forces a slice-per-endpoint pattern that doesn't fit cleanly with our SDK shape. The full Redux mental model is more than we need.
- **SWR** — same idea as TanStack Query, smaller API. Lacks the depth of mutation primitives, query keys are less ergonomic for our nested resources.
- **Apollo Client / urql** — overkill (and we're not on GraphQL).
- **TanStack Query (formerly React Query)** — industry default for server-state in React; first-class mutations + invalidation; integrates with WebSocket-driven invalidation cleanly.

## Decision

Use **TanStack Query 5** as the server-state cache for `apps/web` (the single SPA serving both internal users and external clients). Conventions:

- Query keys are arrays: `['tasks', projectId, filters]`, `['task', taskId]`, `['notifications', 'unread-count']`.
- The `@nockta/sdk` package exposes typed fetchers; React hooks wrap them with `useQuery` / `useMutation`.
- On mutation success, the mutation hook calls `queryClient.invalidateQueries({ queryKey: [...] })` for the resources it touched.
- On WebSocket events (`task.updated`, `comment.created`, ...), the realtime client invalidates the same keys. No event-replay — the cache is the source of truth and the server is the tiebreaker.
- Optimistic updates use `onMutate` to snapshot the cache, mutate it, and roll back in `onError`. Used for drag-and-drop reorder (fractional indexing makes this safe — the server returns the canonical `boardPosition`).

For Zustand-style client-only state (open drawers, filter UI state), use `zustand` — TanStack Query is for server state only.

## Consequences

- **+** Server state stays out of React component state; render cycles drop dramatically.
- **+** Targeted invalidation makes the WebSocket integration a one-line operation per event type.
- **+** Built-in stale-while-revalidate behaviour keeps the UI responsive on slow networks.
- **+** Devtools (`@tanstack/react-query-devtools`) make cache state inspectable.
- **−** Query-key discipline matters; a typo in a key silently breaks invalidation. Keys are centralised in `apps/web/src/api/queryKeys.ts` to keep this in check.
- **−** Optimistic updates are still a source of bugs when the server-side validation rejects the change. We log and toast on rollback.
- **−** Two state stores (TanStack Query for server state, Zustand for local) means contributors must know which to reach for. Documented in `apps/web/README.md`.
