# ADR-0006: Realtime via Socket.IO with Redis adapter

- **Date:** 2025-02-18
- **Status:** Accepted

## Context

The product needs realtime updates: when someone moves a task on the board, every other person looking at that board needs to see it move; when someone starts typing a comment, the task drawer shows a "Alice is typing…" indicator; when an integration webhook updates a task, the UI reflects it without a page refresh. We need:

- A bidirectional channel with reconnect logic that handles flaky networks.
- Room semantics so we can scope broadcasts (per-project, per-task, per-user).
- A way to fan out across multiple API replicas so a write on replica A reaches a subscriber on replica B.
- JWT-based auth on the socket so an unauthenticated client can't subscribe to a private room.

Options:

- **Server-sent events (SSE)** — one-way; we need typing indicators and presence, which require client → server too.
- **Plain WebSocket via `ws`** — works but every higher-level primitive (rooms, reconnect, ack) is hand-rolled.
- **Pusher / Ably / Pub-Nub** — managed, fast to integrate. We don't want a third-party hot path.
- **Socket.IO** — rooms, reconnect, namespaces, ack, fallback transports, Redis adapter for horizontal scale. Mature client library. First-class NestJS support (`@nestjs/platform-socket.io`).
- **uWebSockets.js** — fastest, lowest-level. Rooms and DI integration would need building.

We already need Redis for queues and sessions, so the Socket.IO Redis adapter is free.

## Decision

Use **Socket.IO 4** with the `@socket.io/redis-adapter`. The gateway lives in `apps/api/src/modules/realtime/` and is wired in `main.ts` via `app.useWebSocketAdapter(new RealtimeAdapter(app, redis))`.

Auth: JWT is presented in the connection handshake (`socket.handshake.auth.token`). The gateway:

1. Verifies the JWT.
2. Checks `SessionService.isRevoked(jti)` in Redis — revoked tokens disconnect immediately.
3. Checks `User.archivedAt is null`.
4. Joins the user's `user:{id}` room automatically.

Room model:

- `user:{id}` — direct broadcasts to a single user (notifications, unread-count bumps).
- `project:{id}` — board / backlog / sprint events scoped to a project.
- `task:{id}` — drawer-scoped events (typing, comment posted).

Room joins are authorized server-side via `PermissionsService.effectiveRole`; clients can't trick the server into joining a project they don't have access to.

Frontend reconnect: TanStack Query's `invalidateQueries` on reconnect refetches affected resources rather than replaying missed events. This keeps the protocol stateless on the wire.

## Consequences

- **+** Redis adapter makes horizontal scale a config change; broadcasts fan across all replicas.
- **+** Reconnect / ack / fallback transports are handled by the client library.
- **+** Room model maps cleanly onto our permission model.
- **+** Auth at the socket layer prevents an authenticated user from subscribing to projects they can't read.
- **−** Socket.IO adds protocol overhead vs. raw WebSocket (engine.io framing, polling fallback). Not a bottleneck at our scale.
- **−** Redis adapter requires two extra Redis connections per replica (`pub`/`sub`). Documented in the connection-limit guidance in `runbook.md`.
- **−** Cross-replica events have ~1 ms additional latency vs. same-replica. Acceptable.
