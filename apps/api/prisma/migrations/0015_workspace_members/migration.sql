-- =============================================================================
-- 0013_workspace_members
--
-- Round 6 — Pass A: lifts the workspace boundary from a hardcoded constant to
-- a real per-user membership table.
--
-- Why a separate migration (vs folding into 0009_workspaces):
--   - 0009 already shipped the Workspace row + per-resource workspaceId
--     columns. This migration ships the missing piece — the User <-> Workspace
--     join + the WebhookDelivery denormalisation that the brief calls out.
--   - Splitting keeps `migrate diff` quiet on existing databases where 0009
--     already applied; only the new objects below get created.
--
-- What this migration does:
--   1. CREATE TABLE WorkspaceMember (workspaceId, userId, role) with
--      composite primary key.
--   2. Backfill: every existing User -> 'default' workspace, mapping
--      User.companyRole='Admin' to WorkspaceMember.role='Admin' and the
--      rest to 'Member'. Idempotent via ON CONFLICT DO NOTHING.
--   3. Add WebhookDelivery.workspaceId — denormalised from
--      OutboundWebhook.workspaceId so deliveries dashboards can filter
--      without a join, and so a future Postgres RLS pass has a column
--      to bind on. Backfilled from the parent webhook row.
--
-- Idempotency: every DDL is gated with IF NOT EXISTS; the backfill INSERT
-- uses ON CONFLICT DO NOTHING. Re-running is a no-op.
-- =============================================================================

-- ---- WorkspaceMember table -------------------------------------------------
CREATE TABLE IF NOT EXISTS "WorkspaceMember" (
    "workspaceId" TEXT NOT NULL,
    "userId"      UUID NOT NULL,
    -- Free-form string ('Owner' | 'Admin' | 'Member'). Validated at the
    -- service layer; not an enum so a new tier (e.g. Viewer) doesn't
    -- require a Postgres enum migration.
    "role"        TEXT NOT NULL,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WorkspaceMember_pkey" PRIMARY KEY ("workspaceId", "userId")
);

DO $$ BEGIN
    ALTER TABLE "WorkspaceMember"
        ADD CONSTRAINT "WorkspaceMember_workspaceId_fkey"
        FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "WorkspaceMember"
        ADD CONSTRAINT "WorkspaceMember_userId_fkey"
        FOREIGN KEY ("userId") REFERENCES "User"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "WorkspaceMember_userId_idx"
    ON "WorkspaceMember"("userId");

CREATE INDEX IF NOT EXISTS "WorkspaceMember_workspaceId_role_idx"
    ON "WorkspaceMember"("workspaceId", "role");

-- ---- Backfill memberships --------------------------------------------------
-- One row per existing User into the bootstrap 'default' workspace. The
-- company-wide companyRole is folded into the per-workspace role for the
-- bootstrap pass: Admins become workspace Admins; Members + clients become
-- Members. (Clients usually wouldn't be workspace members in a real
-- multi-tenant world, but the backfill keeps the legacy single-tenant
-- behaviour intact — they can be removed via a future admin endpoint.)
INSERT INTO "WorkspaceMember" ("workspaceId", "userId", "role", "createdAt")
SELECT
    'default',
    "id",
    CASE WHEN "companyRole" = 'Admin' THEN 'Admin' ELSE 'Member' END,
    "createdAt"
FROM "User"
ON CONFLICT ("workspaceId", "userId") DO NOTHING;

-- ---- WebhookDelivery.workspaceId ------------------------------------------
-- Denormalised so per-workspace deliveries dashboards don't need a join,
-- and so RLS (future) has something to bind on. Backfilled from the
-- parent OutboundWebhook row.
ALTER TABLE "WebhookDelivery"
    ADD COLUMN IF NOT EXISTS "workspaceId" TEXT NOT NULL DEFAULT 'default';

UPDATE "WebhookDelivery" d
SET "workspaceId" = w."workspaceId"
FROM "OutboundWebhook" w
WHERE d."webhookId" = w."id"
  AND d."workspaceId" = 'default'
  AND w."workspaceId" <> 'default';

DO $$ BEGIN
    ALTER TABLE "WebhookDelivery"
        ADD CONSTRAINT "WebhookDelivery_workspaceId_fkey"
        FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "WebhookDelivery_workspaceId_createdAt_idx"
    ON "WebhookDelivery"("workspaceId", "createdAt" DESC);
