-- =============================================================================
-- 0009_workspaces
--
-- Multi-tenant boundary. Establishes a real `Workspace` entity and adds a
-- `workspaceId` foreign key to every resource that was previously implicitly
-- "the single workspace". The bootstrap row is seeded inline with the
-- well-known id `default` so existing single-tenant deployments boot
-- cleanly — every existing User, Project, OutboundWebhook,
-- WorkspaceAiSettings, AuditLogEntry and TaskTemplate row gets its
-- `workspaceId` filled by the column default BEFORE the default is dropped.
--
-- ---- Backfill / multi-tenant honesty ---------------------------------------
-- This migration ships the BOUNDARY, not a tenant-management UI. Admins
-- who want true multi-tenancy will:
--   1. Insert a new Workspace row directly (or via a future admin API).
--   2. UPDATE rows on the per-resource tables to point at the new
--      workspaceId.
-- There is intentionally no automatic row-deletion on workspace delete in
-- this migration — the FK uses ON DELETE RESTRICT so a misguided DELETE
-- on Workspace fails loudly rather than nuking cross-table data. A future
-- migration can flip to ON DELETE CASCADE once the admin UI has guard
-- rails.
--
-- ---- Idempotency -----------------------------------------------------------
-- Every DDL is gated with `IF NOT EXISTS`. Re-running this migration on a
-- database that already has it applied is a no-op. The seed INSERT is an
-- ON CONFLICT DO NOTHING so the row doesn't double-create.
-- =============================================================================

-- ---- Workspace table -------------------------------------------------------
CREATE TABLE IF NOT EXISTS "Workspace" (
    "id"        TEXT NOT NULL,
    "name"      TEXT NOT NULL,
    "slug"      TEXT NOT NULL,
    "settings"  JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Workspace_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "Workspace_slug_key"
    ON "Workspace"("slug");

-- ---- Seed bootstrap workspace ---------------------------------------------
-- Existing rows belong here implicitly. The `DEFAULT 'default'` below
-- relies on this row existing BEFORE the FK constraint is enforced.
INSERT INTO "Workspace" ("id", "name", "slug", "settings", "createdAt", "updatedAt")
VALUES ('default', 'Default Workspace', 'default', '{}', NOW(), NOW())
ON CONFLICT ("id") DO NOTHING;

-- ---- Helper macro (not a real macro — just keeping the pattern visible) ---
-- For each model:
--   1. ADD COLUMN ... DEFAULT 'default' so existing rows are backfilled.
--   2. ADD FOREIGN KEY ... DEFERRABLE INITIALLY IMMEDIATE.
--   3. CREATE INDEX on workspaceId.
--   4. ALTER COLUMN ... DROP DEFAULT so new rows must be explicit (forces
--      callers to set workspaceId — keeps the boundary honest).

-- ---- Project ---------------------------------------------------------------
ALTER TABLE "Project"
    ADD COLUMN IF NOT EXISTS "workspaceId" TEXT NOT NULL DEFAULT 'default';

DO $$ BEGIN
    ALTER TABLE "Project"
        ADD CONSTRAINT "Project_workspaceId_fkey"
        FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "Project_workspaceId_idx"
    ON "Project"("workspaceId");

ALTER TABLE "Project" ALTER COLUMN "workspaceId" DROP DEFAULT;

-- ---- User ------------------------------------------------------------------
ALTER TABLE "User"
    ADD COLUMN IF NOT EXISTS "workspaceId" TEXT NOT NULL DEFAULT 'default';

DO $$ BEGIN
    ALTER TABLE "User"
        ADD CONSTRAINT "User_workspaceId_fkey"
        FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "User_workspaceId_idx"
    ON "User"("workspaceId");

ALTER TABLE "User" ALTER COLUMN "workspaceId" DROP DEFAULT;

-- ---- OutboundWebhook -------------------------------------------------------
-- Already has a free-form workspaceId TEXT column (see 0007). Promote it to
-- a real FK + add an index that covers the per-workspace lookups.
DO $$ BEGIN
    ALTER TABLE "OutboundWebhook"
        ADD CONSTRAINT "OutboundWebhook_workspaceId_fkey"
        FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "OutboundWebhook_workspaceId_idx"
    ON "OutboundWebhook"("workspaceId");

-- ---- WorkspaceAiSettings ---------------------------------------------------
-- Previously a singleton row enforced by `@@unique(singleton)`. The model
-- becomes per-workspace: the existing row attaches to the bootstrap
-- workspace, and a UNIQUE on workspaceId prevents two rows for the same
-- workspace (the singleton role moves UP one level — singleton per
-- workspace, not singleton globally).
ALTER TABLE "WorkspaceAiSettings"
    ADD COLUMN IF NOT EXISTS "workspaceId" TEXT NOT NULL DEFAULT 'default';

DO $$ BEGIN
    ALTER TABLE "WorkspaceAiSettings"
        ADD CONSTRAINT "WorkspaceAiSettings_workspaceId_fkey"
        FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "WorkspaceAiSettings_workspaceId_key"
    ON "WorkspaceAiSettings"("workspaceId");

ALTER TABLE "WorkspaceAiSettings" ALTER COLUMN "workspaceId" DROP DEFAULT;

-- ---- AuditLogEntry ---------------------------------------------------------
-- The brief calls this `AuditLog`; the schema model is `AuditLogEntry`. Same
-- table — security/governance trail that must be per-workspace so
-- cross-tenant queries can't read another tenant's history.
ALTER TABLE "AuditLogEntry"
    ADD COLUMN IF NOT EXISTS "workspaceId" TEXT NOT NULL DEFAULT 'default';

DO $$ BEGIN
    ALTER TABLE "AuditLogEntry"
        ADD CONSTRAINT "AuditLogEntry_workspaceId_fkey"
        FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "AuditLogEntry_workspaceId_idx"
    ON "AuditLogEntry"("workspaceId");

ALTER TABLE "AuditLogEntry" ALTER COLUMN "workspaceId" DROP DEFAULT;

-- ---- TaskTemplate ----------------------------------------------------------
ALTER TABLE "TaskTemplate"
    ADD COLUMN IF NOT EXISTS "workspaceId" TEXT NOT NULL DEFAULT 'default';

DO $$ BEGIN
    ALTER TABLE "TaskTemplate"
        ADD CONSTRAINT "TaskTemplate_workspaceId_fkey"
        FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "TaskTemplate_workspaceId_idx"
    ON "TaskTemplate"("workspaceId");

ALTER TABLE "TaskTemplate" ALTER COLUMN "workspaceId" DROP DEFAULT;
