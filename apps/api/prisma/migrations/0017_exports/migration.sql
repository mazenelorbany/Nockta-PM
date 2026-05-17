-- =============================================================================
-- 0015_exports
--
-- Pass E (Round 6) — Exports overhaul, second cut.
--
-- 0012_exports landed an initial pair of tables (ExportSchedule + ExportRun) but
-- the column shape was tuned for the early "single JSON `query` blob" UI:
--   ExportSchedule had `query JSONB` and `cron`/`delivery` columns.
--   ExportRun had no `sourceKind`/`sourceId`/`scheduleCron`/`errorMessage`.
--
-- The new UI splits "where does this come from?" (sourceKind + sourceId) from
-- the per-format options, and the processor needs the cron expression hanging
-- off ExportSchedule rather than the JSON blob so the in-process scheduler can
-- evaluate cron strings without parsing JSON every tick. The new ExportRun has
-- a richer status set ('completed'/'failed' instead of 'succeeded') plus
-- explicit `sourceKind`/`sourceId` mirrors so the History view can render the
-- run independently of whether the parent schedule still exists.
--
-- This migration is ADDITIVE — every column we still need from 0012 stays
-- (workspaceId, kind, enabled, lastRunAt, etc.). We add the new columns,
-- backfill the source-shape columns from the existing JSON `query` blob where
-- possible, and leave the legacy `query`/`cron`/`delivery` columns in place so
-- a partial deploy doesn't break either side. A follow-up `0016` will drop the
-- legacy columns once every replica is on the new code path.
-- =============================================================================

-- ---- ExportSchedule: new columns -------------------------------------------
ALTER TABLE "ExportSchedule"
    ADD COLUMN IF NOT EXISTS "sourceKind"     TEXT,
    ADD COLUMN IF NOT EXISTS "sourceId"       TEXT,
    ADD COLUMN IF NOT EXISTS "scheduleCron"   TEXT,
    ADD COLUMN IF NOT EXISTS "deliveryKind"   TEXT,
    ADD COLUMN IF NOT EXISTS "deliveryEmailNew" TEXT;

-- Backfill from the 0012 shape. The legacy `query` column is JSON of the form
--   { source: 'savedView'|'project'|'allTasks', savedViewId, projectId, ... }
-- map source -> sourceKind, and savedViewId/projectId -> sourceId.
UPDATE "ExportSchedule"
SET
    "sourceKind" = CASE
        WHEN ("query"->>'source') = 'savedView' THEN 'saved_view'
        WHEN ("query"->>'source') = 'project'   THEN 'project'
        WHEN ("query"->>'source') = 'allTasks'  THEN 'all_tasks'
        ELSE 'all_tasks'
    END,
    "sourceId" = COALESCE(
        "query"->>'savedViewId',
        "query"->>'projectId',
        NULL
    ),
    "scheduleCron"     = COALESCE("scheduleCron", "cron"),
    "deliveryKind"     = COALESCE("deliveryKind", "delivery"),
    "deliveryEmailNew" = COALESCE("deliveryEmailNew", "deliveryEmail")
WHERE "sourceKind" IS NULL;

-- Once the backfill has run, the new columns are non-null with sensible
-- defaults. Add the NOT NULL constraint + default at the schema level so the
-- ORM doesn't insert NULLs going forward.
ALTER TABLE "ExportSchedule"
    ALTER COLUMN "sourceKind" SET NOT NULL,
    ALTER COLUMN "sourceKind" SET DEFAULT 'all_tasks';
ALTER TABLE "ExportSchedule"
    ALTER COLUMN "deliveryKind" SET NOT NULL,
    ALTER COLUMN "deliveryKind" SET DEFAULT 'download';

-- workspaceId default lifted to 'default' to match the rest of the codebase
-- (OutboundWebhook, etc.) for single-tenant boot.
ALTER TABLE "ExportSchedule"
    ALTER COLUMN "workspaceId" SET DEFAULT 'default';

CREATE INDEX IF NOT EXISTS "ExportSchedule_workspaceId_sourceKind_idx"
    ON "ExportSchedule"("workspaceId", "sourceKind");

-- ---- ExportRun: new columns -----------------------------------------------
ALTER TABLE "ExportRun"
    ADD COLUMN IF NOT EXISTS "sourceKind"   TEXT,
    ADD COLUMN IF NOT EXISTS "sourceId"     TEXT,
    ADD COLUMN IF NOT EXISTS "errorMessage" TEXT;

-- Status name reconciliation. 0012 used 'succeeded'; the new processor emits
-- 'completed'. Translate any rows the old code wrote so the History view
-- doesn't surface a status string the frontend doesn't recognise.
UPDATE "ExportRun" SET "status" = 'completed' WHERE "status" = 'succeeded';

-- Copy the error summary into the new column so the migration is reversible.
UPDATE "ExportRun"
SET "errorMessage" = COALESCE("errorMessage", "errorSummary")
WHERE "errorMessage" IS NULL AND "errorSummary" IS NOT NULL;

-- Mirror the schedule's source onto each run so the History view can describe
-- the run after the parent schedule is deleted. New runs always set this
-- inline; we backfill the historical rows here.
UPDATE "ExportRun" r
SET
    "sourceKind" = s."sourceKind",
    "sourceId"   = s."sourceId"
FROM "ExportSchedule" s
WHERE r."scheduleId" = s."id"
  AND r."sourceKind" IS NULL;

-- For one-off historical runs (no schedule) we can't recover the source — leave
-- the columns null and rely on the new code to always populate them on insert.

CREATE INDEX IF NOT EXISTS "ExportRun_sourceKind_sourceId_idx"
    ON "ExportRun"("sourceKind", "sourceId");
