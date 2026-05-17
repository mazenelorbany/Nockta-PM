# Threat model

Nockta Flow holds project, task, comment, and attachment data for a single tenant per workspace, and provides a thinner client-portal surface to external clients. The blast radius of a security failure is reputational, contractual (clients see things they shouldn't), and operational (engineering team can't ship). This document is a STRIDE-style threat enumeration with the controls actually shipped in the code.

The reference architecture is in [`docs/architecture.md`](../architecture.md). The workspace boundary design is in [`ADR-0007`](../adr/0007-workspace-service-layer-isolation.md).

---

## STRIDE summary

| Category | Threat | Attacker capability | Mitigation | Residual risk |
|---|---|---|---|---|
| **S**poofing | Auth bypass via forged JWT | Network attacker can attempt to mint or replay JWTs against the API | Asymmetric secret-scoped JWTs (`JWT_ACCESS_SECRET` ≥ 32 chars, different from `JWT_REFRESH_SECRET`; boot guard refuses placeholders); short access TTL (15 min); JTI tracked in Redis and revocable on logout / rotation | Stolen access token usable until expiry. Mitigated by short TTL + ability to revoke. |
| **S**poofing | OAuth callback hijack | Attacker intercepts OAuth flow to claim another user's identity | Google OAuth callback URL is registered exactly with Google; `state` parameter (CSRF-style nonce) bound to a Redis-stored intent; `GOOGLE_OAUTH_ALLOWED_DOMAIN` rejects non-`@nockta.com` accounts | An attacker who controls Google for a target domain could log in as that user. Out of scope. |
| **T**ampering | JWT payload modification | Attacker has access to a valid token and modifies `sub` / `workspaceId` / `companyRole` | JWTs are HS256-signed; modification invalidates the signature. Server re-loads `User` + workspace membership on every request, so even a valid JWT can't elevate its own claims | None significant. |
| **T**ampering | Direct-object reference | Authenticated user sends another workspace's ID to a controller | `WorkspaceGuard` resolves the workspace from the JWT only; controller arguments that take `workspaceId` are checked against the JWT-resolved one and rejected on mismatch. Service-layer filter on `workspaceId` for all Prisma queries on workspace-scoped models. | A missed `where: { workspaceId }` in a Prisma call would leak. Lint rule + cross-workspace integration tests are compensating controls. |
| **T**ampering | Webhook payload spoofing | Attacker posts a fake GitHub / Chat / deployment webhook | Every webhook endpoint verifies an HMAC signature using a provider-specific secret (`GITHUB_APP_WEBHOOK_SECRET`, `DEPLOY_WEBHOOK_SECRET_*`, etc.). Unsigned or wrong-signature requests are 401'd before any side effect. | Secret exfiltration would defeat this; secrets are rotated on suspicion. |
| **R**epudiation | "I never moved that task" | Internal user denies an action that caused damage | `Event` table records every write with `actorId`, `correlationId`, before/after diffs (where applicable). Partitioned, append-only, no soft-delete. `AuditLogController` is admin-only, separate from `TimelineController`. | Event-table tampering by a DB-level attacker is out of scope; Postgres-level audit (`pgaudit`) is a future option. |
| **R**epudiation | Comment edit / delete | User edits or deletes a comment to deny what they said | Comments have a 15-minute `editLockedAt` grace window after which edits are blocked. Delete is soft (`deletedAt`) until the 30-day purge — the original text is retained for that window. Edit history is logged on the `Event` table. | After 30 days, content is gone. Acceptable per product spec. |
| **I**nfo disclosure | Cross-workspace leak | Authenticated user in workspace A receives data from workspace B | See "Tampering — Direct-object reference" above. Workspace filter at service layer; `Event`, `Notification`, `OutboundWebhook`, `AiUsageEvent` all carry `workspaceId`. | Same residual as above (missed filter). |
| **I**nfo disclosure | Cross-project leak inside one workspace | Workspace member with no access to Project X reads its tasks | `PermissionsService.effectiveRole(user, projectId)` consults direct grants, team grants, and `Project.visibility`. Default-deny for `private`, team-scoped for `teams`. Realtime gateway enforces the same on room join. | Grant misconfiguration by an Admin is a self-inflicted wound; the UI is the safety net. |
| **I**nfo disclosure | Client-portal leak | A client (`User.kind='client'`) sees an internal-only task or comment | `Task.visibility` and `Comment.visibility` enums (`internal` / `client_visible`). The `client.controller.ts` surface filters strictly on `client_visible`. `ClientGuard` rejects any request from a client account to a non-client endpoint. | Default is `internal` — secure by default. A user mistakenly setting a task to `client_visible` is a user action, logged. |
| **I**nfo disclosure | Attachment URL guessing | Attacker tries to fetch an attachment by S3 key | All attachment access goes through signed URLs with short TTLs (5–60 min). Buckets are private; no anonymous access. Filenames are not in the URL (we use ULIDs for keys). | Active session at the time the URL was issued is required for the request that obtained the URL. |
| **D**oS | Brute-force login | Attacker hammers `/auth/magic-link/request` to harvest accounts / lock users out | Per-route `auth` throttler bucket: 10 requests / minute / IP. Magic-link tokens are single-use and TTL-bound. | A botnet could distribute the attack across many IPs; per-account rate-limit kicks in (5/hour per email). |
| **D**oS | Request flood | Attacker floods an authenticated endpoint with valid bearer tokens | `IdentityAwareThrottlerGuard` keys on JWT subject. `global` bucket: 600/min/IP, `user` bucket: 120/min/JWT-sub. Returns 429 on overflow. | A compromised account can still consume its bucket; mitigated by revocation. |
| **D**oS | Expensive query | Authenticated user runs a query that scans the world (large `limit`, no filters) | Pagination enforced at the DTO level (`limit ≤ 100`); search queries time out at 2 s; AI completions are per-workspace token-capped. | Some report endpoints can still be expensive; future hardening: query budgets per role. |
| **D**oS | Attachment upload flood | Authenticated user uploads many large files | Per-user upload rate-limit (10/min); per-file size cap (`50 MB` default, configurable); quarantine-bucket lifecycle rule deletes orphaned uploads after 7 days. | Storage cost during an attack until lifecycle rule sweeps. |
| **E**levation of privilege | Role escalation in a project | Workspace member self-promotes to Manager on a project they only have Contributor access to | `ProjectAccess` writes go through `ProjectsController` which checks the actor is already a Manager (or Admin). All grant changes write `Event`s of type `project.access.granted` with before/after. | Compromised Admin account is fatal; mitigated by MFA (when enabled) and JTI revocation on suspicion. |
| **E**levation of privilege | Internal → Admin | Workspace member promotes themselves to `CompanyRole.Admin` | Only Admins can change `companyRole` via `UsersController`. Initial admin set via seed or direct SQL — documented in `HANDOVER.md §10`. | First-admin bootstrap is a known footgun; documented. |
| **E**levation of privilege | Client → Internal | A client (`User.kind='client'`) acquires an internal-user token | OAuth callback creates `User.kind='internal'` only when the Google domain matches `GOOGLE_OAUTH_ALLOWED_DOMAIN`. Magic-link requests record the intent (`kind` parameter) and the issued token's `kind` claim matches; the API rejects mismatch on every request. | Compromised Admin who manually changes `User.kind` could bypass — recoverable from `Event` log. |

---

## Authentication

- **Identity providers.** Google OAuth (internal users, domain-restricted to `GOOGLE_OAUTH_ALLOWED_DOMAIN`); magic-link email (both internal and client users; hashed token stored in DB, 15-min TTL, single-use).
- **Tokens.** JWT access (HS256, 15-min TTL by default) + refresh (HS256, 30-day TTL). Both secrets enforced ≥ 32 chars by the bootstrap guard.
- **Refresh-token rotation.** `RefreshToken` rows are single-use; rotating one writes a new row and links via `rotatedToId`. Re-using an already-rotated refresh token invalidates the entire chain (reuse detection), forcing re-login.
- **MFA.** When enabled, TOTP (RFC 6238) gated at the magic-link / OAuth completion step. Recovery codes are bcrypt-hashed. Required for Admin role.
- **Session model.** Redis-backed JTI tracking. Logout, role change, password reset, and explicit "revoke all sessions" all flip the JTI to revoked. WebSocket connections re-check on every connect.
- **Dev-auth.** `DEV_AUTH_ENABLED=true` enables `/auth/dev/*` (persona login, login-as) in non-production only. Production refuses regardless of the flag.

## Authorization

- **Workspace boundary.** Enforced at the service layer (ADR-0007). `WorkspaceGuard` is global; opt-out via `@SkipWorkspace()` and is reviewed individually.
- **Company role.** `CompanyRole.Admin` bypasses project-level checks for read; writes still go through service-layer validation.
- **Project role.** `ProjectRole = Manager | Contributor | Viewer | Client`. `effectiveRole(actor, project)` is the max of direct + team + visibility-implied roles. `PermissionsService` is the single source of truth; controllers, the realtime gateway, and AI gating all defer to it.
- **Task visibility.** `internal | client_visible`. Default-secure: a task created without explicit visibility is `internal`. Clients only see `client_visible` tasks.
- **Comment visibility.** Same enum; same default.
- **AI gating.** Per-workspace token cap (`WorkspaceAiSettings.monthlyTokenCap`); per-route role check on `ai.controller.ts`; usage logged to `AiUsageEvent`.

## Data protection

- **At rest.** Postgres is managed (Railway plugin); volumes are encrypted by the host. S3 / R2 has server-side encryption (SSE-S3 / SSE-R2). Backups are encrypted in the host's storage.
- **In transit.** All client connections are HTTPS only. Railway terminates TLS at the load balancer. Internal API ↔ Postgres / Redis / S3 / Qdrant traffic is over the Railway private network where supported, TLS otherwise.
- **Sensitive fields.**
  - Passwords: not stored — we only do OAuth + magic-link.
  - JWT secrets, S3 keys, OAuth client secrets, GitHub App private key, SMTP passwords: env vars only; never written to the DB, never logged.
  - Magic-link tokens: stored as SHA-256 hash; the raw token is only ever in the email.
  - OAuth tokens for downstream APIs (GitHub installation tokens, Google service-account tokens): short-lived, refreshed on demand, cached in Redis with TTLs equal to the upstream expiry minus a safety margin.
- **PII.** User email, name, avatar URL. Workspace data may contain customer information uploaded by users; we do not export it elsewhere.
- **Logging.** pino redacts `req.headers.authorization`, `req.headers.cookie`. Body logging is off by default; toggling on requires explicit code change.

## Input validation

- **DTO validation.** Every controller DTO uses `class-validator` + `class-transformer`. Global `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })` strips unknown fields and rejects payloads with unexpected ones.
- **Type guards.** Where we accept user-defined JSON (custom fields, automation triggers, AI prompts), `zod` schemas validate before persisting.
- **Output encoding.** React escapes by default. Tiptap content is sanitized server-side before storage (allowlist of nodes / marks). Rendered HTML is never `dangerouslySetInnerHTML`'d from raw user input.
- **SQL injection.** Prisma parameterises everything; `$queryRaw` calls use tagged-template parameter binding only. No string-interpolated SQL.
- **File uploads.** Mime type from the signed-URL contract is compared against the actual content type after upload; mismatched files are rejected. ClamAV scans all attachments before they leave the quarantine bucket.
- **SSRF surface.** The only places we make outbound requests with user-provided URLs are: outbound webhook delivery (allowlisted via the `OutboundWebhook` record's domain field), avatar URL fetch (skipped for private IP ranges). Internal-IP requests are blocked in both paths.

---

## Out of scope (deliberately)

- **Endpoint compromise of an Admin's machine.** If an Admin's session is stolen, the attacker has Admin. We rely on MFA + revocation, not endpoint security.
- **Compromised CI runner.** The deploy path can write production secrets and ship code. Mitigated by branch protection + required reviews; out-of-band approval for env-var changes.
- **Insider threat at the host provider** (Railway, AWS, Cloudflare). Standard cloud trust model.
