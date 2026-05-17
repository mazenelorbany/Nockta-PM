# ADR-0002: NestJS over plain Express / Fastify

- **Date:** 2025-02-05
- **Status:** Accepted

## Context

The API has ~40 controllers, multiple BullMQ workers, a Socket.IO gateway, Passport strategies for two auth flows (Google OAuth + JWT), and a cross-cutting concern set (rate limiting, validation, logging, metrics, throttling, auth guards, role-based access, audit logging). A plain Express app would either grow ad-hoc module boundaries or reinvent dependency injection. We want:

- A real module graph so features (`tasks`, `sprints`, `ai`, `github`, ...) compose cleanly.
- Decorator-based controllers + DTOs so request validation, auth, and OpenAPI are colocated with the handler.
- A guard / interceptor pipeline that makes "every authenticated route checks workspace membership" easy to enforce repo-wide.
- A WebSocket gateway that shares the same DI container as the REST surface so services can be injected the same way.

Options:

- **Express + custom DI** — full control, but every cross-cutting concern is hand-rolled. We've all seen this end badly.
- **Fastify** — faster on benchmarks, but our bottleneck is Postgres, not the HTTP layer. Fastify's plugin model isn't a substitute for module-graph DI.
- **NestJS over Express** — opinionated framework with DI, modules, guards, interceptors, pipes, decorators, first-class WebSocket + BullMQ + Swagger integrations.
- **NestJS over Fastify** — Nest supports either adapter. We chose Express for the broader middleware ecosystem (helmet, pino-http, multer) and because Fastify would mean re-vetting every middleware.

## Decision

Use **NestJS 10 on the Express adapter** as the API framework. Use `@nestjs/swagger` for OpenAPI (Swagger UI on `/docs` in non-production), `@nestjs/throttler` for rate limiting, `@nestjs/bullmq` for queues, `@nestjs/platform-socket.io` for the gateway, `@nestjs/terminus` for health checks.

Module boundaries follow domain: `tasks`, `sprints`, `comments`, `attachments`, `events`, `notifications`, `ai`, `github`, `chat`, ... each with `*.module.ts`, `*.service.ts`, `*.controller.ts`, DTOs, and tests colocated.

Cross-cutting concerns are global:

- `JwtAuthGuard` + `WorkspaceGuard` + `RolesGuard` registered globally; opt-out with `@Public()`.
- `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })` global.
- `AllExceptionsFilter` + `CorrelationIdInterceptor` global.
- `IdentityAwareThrottlerGuard` global with three buckets.

## Consequences

- **+** Consistent project structure; every feature has the same shape, easy to navigate.
- **+** Cross-cutting concerns are declarative and global — no risk of a controller skipping auth by forgetting middleware.
- **+** Test ergonomics: Nest's `Test.createTestingModule` makes unit tests with mocked deps trivial.
- **+** First-class Swagger generation; the dev `/docs` endpoint stays in sync with controllers automatically.
- **−** Decorator-heavy code is unfamiliar to engineers coming from plain Express.
- **−** Cold-start is slower than Express by ~200 ms (irrelevant for a long-lived server, would matter for Lambda).
- **−** Some debugging requires understanding Nest's request lifecycle (guard → interceptor → pipe → handler → interceptor → filter).
