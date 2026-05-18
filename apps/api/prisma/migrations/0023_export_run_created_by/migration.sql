-- =============================================================================
-- 0023_export_run_created_by
--
-- Adds ExportRun.createdById so the exports module can enforce per-actor
-- ownership on read/download. Before this column existed, the service treated
-- internal_user.kind === 'internal' as sufficient ownership for any run — a
-- known data-exfiltration vector documented in the audit.
--
-- Nullable + ON DELETE SET NULL because the run history is independent of
-- the user: deleting a user should not delete their export history, and a
-- NULL createdById is treated as "Admin only" by the service layer.
--
-- Backfill populates createdById for scheduled runs from the parent schedule.
-- Inline runs from before this migration stay NULL — they pre-date the
-- ownership model and will resolve as Admin-only on read.
-- =============================================================================

ALTER TABLE "ExportRun"
  ADD COLUMN "createdById" UUID;

CREATE INDEX "ExportRun_createdById_createdAt_idx"
  ON "ExportRun" ("createdById", "createdAt" DESC);

ALTER TABLE "ExportRun"
  ADD CONSTRAINT "ExportRun_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill scheduled runs from their parent schedule's creator.
UPDATE "ExportRun" r
SET "createdById" = s."createdById"
FROM "ExportSchedule" s
WHERE r."scheduleId" = s."id" AND r."createdById" IS NULL;
