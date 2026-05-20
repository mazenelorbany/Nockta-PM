-- Add Task.completedAt for "tasks completed in this window" reports.
-- Stamped on done-transitions by tasks.service.changeStatus and cleared on
-- re-open. Backfill historical tasks currently in a done-marked status to
-- their updatedAt so the new branded sprint/project PDF can still show
-- pre-feature completions (best-effort approximation).

ALTER TABLE "Task"
  ADD COLUMN IF NOT EXISTS "completedAt" TIMESTAMP(3);

-- Backfill: any task whose status is currently one of the preset's
-- "done" names gets completedAt = updatedAt. The preset constants are
-- duplicated here on purpose — the project-level custom statuses
-- ship in the same migration sequence (0029) which marks each
-- status with isDoneStatus. Use that flag where ProjectStatus rows
-- exist; fall back to the legacy preset names for any project that
-- somehow has no status rows yet.
UPDATE "Task" t
SET "completedAt" = t."updatedAt"
WHERE t."completedAt" IS NULL
  AND (
    EXISTS (
      SELECT 1
      FROM "ProjectStatus" ps
      WHERE ps."projectId" = t."projectId"
        AND ps."name" = t."status"
        AND ps."isDoneStatus" = TRUE
    )
    OR t."status" IN ('Done', 'Approved')
  );
