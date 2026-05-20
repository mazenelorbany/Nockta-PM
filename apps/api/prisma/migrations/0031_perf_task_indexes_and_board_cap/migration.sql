-- Performance: add the index that the sprint + project PDF reports
-- actually use.
--
-- `Task.completedAt` was added by migration 0030 specifically so the
-- branded sprint/project PDF could filter "tasks completed in this
-- window". The report's hot query is
--   SELECT … FROM "Task"
--   WHERE "projectId" = $1
--     AND "completedAt" >= $2
--     AND "completedAt" <  $3
--     AND "status" IN ('Done','Approved')
--   ORDER BY "completedAt" DESC
-- Without a covering composite index Postgres scans every task in the
-- project even though `completedAt IS NULL` for in-progress work — a
-- 5K-task project means scanning 5K rows for every PDF download.
--
-- The DESC sort ordering matches the report's display order so the index
-- can also satisfy the ORDER BY without a separate sort step.

CREATE INDEX IF NOT EXISTS "Task_projectId_completedAt_idx"
  ON "Task" ("projectId", "completedAt" DESC);
