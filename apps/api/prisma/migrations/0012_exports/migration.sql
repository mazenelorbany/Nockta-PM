-- =============================================================================
-- 0012_exports
--
-- Pass D — Exports overhaul. Adds:
--   * ImportRun.resumableFromRow + ImportRun.resumePayload (partial-fail
--     resume). Allows POST /import/:id/resume to pick up from the last
--     successfully-processed row without re-doing completed inserts.
--   * ExportSchedule — user-defined "give me this report on a cadence" row.
--     One-off exports leave `cron` null and disable themselves on first run.
--   * ExportRun — one materialised export. Holds the signed URL the user
--     downloads via, the row count, and a hard `expiresAt` cutoff (default
--     createdAt + 24h) the maintenance cron uses to purge stale objects.
--
-- 0009/0010/0011 are reserved for parallel passes (workspace/ai/custom-fields).
-- 0012 keeps this PR isolated from those merges.
-- =============================================================================

-- ---- ImportRun: resume bookkeeping -----------------------------------------
ALTER TABLE "ImportRun"
    ADD COLUMN "resumableFromRow" INTEGER;
ALTER TABLE "ImportRun"
    ADD COLUMN "resumePayload" JSONB;

-- ---- ExportSchedule --------------------------------------------------------
CREATE TABLE "ExportSchedule" (
    "id"            UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspaceId"   TEXT NOT NULL,
    "name"          TEXT NOT NULL,
    "kind"          TEXT NOT NULL,
    "query"         JSONB NOT NULL,
    "cron"          TEXT,
    "delivery"      TEXT NOT NULL DEFAULT 'download',
    "deliveryEmail" TEXT,
    "enabled"       BOOLEAN NOT NULL DEFAULT true,
    "lastRunAt"     TIMESTAMP(3),
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMP(3) NOT NULL,
    "createdById"   UUID NOT NULL,
    CONSTRAINT "ExportSchedule_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "ExportSchedule"
    ADD CONSTRAINT "ExportSchedule_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT;

CREATE INDEX "ExportSchedule_workspaceId_enabled_idx"
    ON "ExportSchedule"("workspaceId", "enabled");
CREATE INDEX "ExportSchedule_createdById_idx"
    ON "ExportSchedule"("createdById");

-- ---- ExportRun -------------------------------------------------------------
CREATE TABLE "ExportRun" (
    "id"           UUID NOT NULL DEFAULT gen_random_uuid(),
    "scheduleId"   UUID,
    "kind"         TEXT NOT NULL,
    "status"       TEXT NOT NULL DEFAULT 'queued',
    "storageKey"   TEXT,
    "signedUrl"    TEXT,
    "expiresAt"    TIMESTAMP(3),
    "fileSize"     INTEGER NOT NULL DEFAULT 0,
    "rowCount"     INTEGER NOT NULL DEFAULT 0,
    "errorSummary" TEXT,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt"  TIMESTAMP(3),
    CONSTRAINT "ExportRun_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "ExportRun"
    ADD CONSTRAINT "ExportRun_scheduleId_fkey"
    FOREIGN KEY ("scheduleId") REFERENCES "ExportSchedule"("id") ON DELETE SET NULL;

CREATE INDEX "ExportRun_scheduleId_createdAt_idx"
    ON "ExportRun"("scheduleId", "createdAt" DESC);
CREATE INDEX "ExportRun_status_createdAt_idx"
    ON "ExportRun"("status", "createdAt");
