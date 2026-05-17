-- =============================================================================
-- Nockta Flow — companion SQL migration.
--
-- These are the constraints, indexes, and structural changes that Prisma
-- can't express in schema.prisma. Run AFTER `prisma db push` (or after the
-- normal Prisma migrate-dev cycle) on every environment.
--
-- All statements are idempotent — safe to run repeatedly.
-- =============================================================================

-- 1. Partial unique index — only one active sprint per project.
CREATE UNIQUE INDEX IF NOT EXISTS sprint_active_per_project_unique
  ON "Sprint" ("projectId")
  WHERE state = 'active';

-- 2. ProjectAccess: exactly one of userId/teamId populated, matching subjectKind.
ALTER TABLE "ProjectAccess"
  DROP CONSTRAINT IF EXISTS project_access_subject_consistent;
ALTER TABLE "ProjectAccess"
  ADD CONSTRAINT project_access_subject_consistent
  CHECK (
    ("subjectKind" = 'user' AND "userId" IS NOT NULL AND "teamId" IS NULL)
    OR
    ("subjectKind" = 'team' AND "teamId" IS NOT NULL AND "userId" IS NULL)
  );

-- 3. CommentMention: exactly one of userId/teamId populated.
ALTER TABLE "CommentMention"
  DROP CONSTRAINT IF EXISTS comment_mention_one_target;
ALTER TABLE "CommentMention"
  ADD CONSTRAINT comment_mention_one_target
  CHECK (
    ("userId" IS NOT NULL AND "teamId" IS NULL)
    OR
    ("userId" IS NULL AND "teamId" IS NOT NULL)
  );

-- 4. Project key format: 2-10 uppercase letters.
ALTER TABLE "Project"
  DROP CONSTRAINT IF EXISTS project_key_format;
ALTER TABLE "Project"
  ADD CONSTRAINT project_key_format
  CHECK ("key" ~ '^[A-Z]{2,10}$');

-- 4b. AI priority rationale column. Added separately so existing prod DBs that
--     pre-date this field pick it up without a full prisma migrate-deploy
--     (companion.sql runs on every boot, idempotent).
ALTER TABLE "Task"
  ADD COLUMN IF NOT EXISTS "aiPriorityReason" TEXT;

-- 4c. Per-project default task visibility. Determines how Guests see this
--     project: 'internal' (the legacy default) keeps the strict per-task
--     visibility filter; 'client_visible' opens up every task to guests
--     regardless of the per-task field. Defaulted to 'internal' so existing
--     projects keep their current behavior.
ALTER TABLE "Project"
  ADD COLUMN IF NOT EXISTS "defaultTaskVisibility" "Visibility" NOT NULL DEFAULT 'internal';

-- 5. FTS columns on Task and Comment — Postgres tsvector + GIN index.
--    Search currently falls back to ILIKE in SearchService (works without these
--    columns). Apply this once you want real FTS in production.
ALTER TABLE "Task"
  ADD COLUMN IF NOT EXISTS "search_vector" tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(description, '')), 'B')
  ) STORED;
CREATE INDEX IF NOT EXISTS "Task_search_vector_idx" ON "Task" USING GIN ("search_vector");

ALTER TABLE "Comment"
  ADD COLUMN IF NOT EXISTS "search_vector" tsvector
  GENERATED ALWAYS AS (to_tsvector('english', coalesce("bodyMd", ''))) STORED;
CREATE INDEX IF NOT EXISTS "Comment_search_vector_idx" ON "Comment" USING GIN ("search_vector");

-- 5c. SprintTaskMembership backfill. The model is created by `prisma db push`
-- (declared in schema.prisma). On the FIRST boot after the model lands, the
-- table is empty even though tasks already have Task.sprintId values. This
-- block creates one open membership row per existing task→sprint link so
-- the burndown rebuilder works against historical data.
--
-- Idempotent: only inserts a row if no existing membership for that
-- (taskId, sprintId, addedAt = task.createdAt) tuple exists. Re-runs are
-- no-ops.
INSERT INTO "SprintTaskMembership" ("id", "sprintId", "taskId", "addedAt", "removedAt")
SELECT
  gen_random_uuid(),
  t."sprintId",
  t."id",
  t."createdAt",
  NULL
FROM "Task" t
WHERE t."sprintId" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "SprintTaskMembership" m
    WHERE m."sprintId" = t."sprintId" AND m."taskId" = t."id"
  )
ON CONFLICT DO NOTHING;

-- 5b. Doc full-text search column + GIN index. Weighted same as Task: A for
-- title, B for body. SearchService.searchDocs prefers this path and falls
-- back to ILIKE only when the column is missing (fresh DB without
-- companion.sql applied).
ALTER TABLE "Doc"
  ADD COLUMN IF NOT EXISTS "search_vector" tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(body, '')), 'B')
  ) STORED;
CREATE INDEX IF NOT EXISTS "Doc_search_vector_idx" ON "Doc" USING GIN ("search_vector");

-- 6. Worklog: only one running timer per user (endedAt IS NULL) at any time.
CREATE UNIQUE INDEX IF NOT EXISTS worklog_one_running_per_user
  ON "Worklog" ("userId")
  WHERE "endedAt" IS NULL;

-- 7. Event-table partitioning. Prisma can't express PARTITION BY; we drop the
--    plain table it created and recreate it as RANGE-partitioned by createdAt.
--    Destructive — must run before any rows land. Idempotent via the partitioned
--    check: if "Event" is already partitioned we skip.
DO $$
DECLARE
  is_partitioned bool;
BEGIN
  SELECT (relkind = 'p') INTO is_partitioned
    FROM pg_class
    WHERE relname = 'Event' AND relnamespace = 'public'::regnamespace;

  IF is_partitioned IS NULL OR is_partitioned = false THEN
    -- Drop the unpartitioned table Prisma created (along with its indexes/FK).
    DROP TABLE IF EXISTS "Event" CASCADE;

    CREATE TABLE "Event" (
      "id"          UUID NOT NULL DEFAULT gen_random_uuid(),
      "type"        TEXT NOT NULL,
      "actorUserId" UUID,
      "entityType"  TEXT NOT NULL,
      "entityId"    UUID NOT NULL,
      "projectId"   UUID,
      "payload"     JSONB NOT NULL,
      "visibility"  "EventVisibility" NOT NULL DEFAULT 'internal',
      "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY ("id", "createdAt")
    ) PARTITION BY RANGE ("createdAt");

    CREATE INDEX "Event_projectId_createdAt_idx"
      ON "Event" ("projectId", "createdAt" DESC);
    CREATE INDEX "Event_entityType_entityId_createdAt_idx"
      ON "Event" ("entityType", "entityId", "createdAt" DESC);
    CREATE INDEX "Event_actorUserId_createdAt_idx"
      ON "Event" ("actorUserId", "createdAt" DESC);
    CREATE INDEX "Event_type_createdAt_idx"
      ON "Event" ("type", "createdAt");
    -- Partial index for Admin-only audit queries (spec §8).
    CREATE INDEX "Event_admin_only_idx"
      ON "Event" ("createdAt" DESC)
      WHERE visibility = 'admin_only';

    -- FK back to User. ON DELETE SET NULL matches the Prisma model.
    ALTER TABLE "Event"
      ADD CONSTRAINT "Event_actorUserId_fkey"
      FOREIGN KEY ("actorUserId") REFERENCES "User"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END
$$;

-- 8a. Materialized views for analytics (spec §18). MaintenanceScheduler issues
--     REFRESH MATERIALIZED VIEW CONCURRENTLY — every 5 min for `mv_workload_open`,
--     daily for `mv_sprint_velocity` and `mv_cycle_time_30d`.

-- Per-assignee open-task workload, priority-weighted.
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_workload_open AS
SELECT
  t."assigneeUserId"                                AS user_id,
  t."projectId"                                     AS project_id,
  COUNT(*)::int                                     AS total,
  COALESCE(SUM(t.estimate), 0)::int                 AS points,
  COUNT(*) FILTER (WHERE t.priority = 'Critical')::int AS critical_count,
  COUNT(*) FILTER (WHERE t.priority = 'High')::int     AS high_count,
  COUNT(*) FILTER (WHERE t.priority = 'Medium')::int   AS medium_count,
  COUNT(*) FILTER (WHERE t.priority = 'Low')::int      AS low_count,
  (
    COUNT(*) FILTER (WHERE t.priority = 'Critical') * 4 +
    COUNT(*) FILTER (WHERE t.priority = 'High')     * 3 +
    COUNT(*) FILTER (WHERE t.priority = 'Medium')   * 2 +
    COUNT(*) FILTER (WHERE t.priority = 'Low')      * 1
  )::int                                            AS load_score
FROM "Task" t
WHERE t."assigneeUserId" IS NOT NULL
  AND t.status NOT IN ('Done', 'Approved')
GROUP BY t."assigneeUserId", t."projectId";

-- CONCURRENTLY requires a unique index. (userId, projectId) is the natural key.
CREATE UNIQUE INDEX IF NOT EXISTS mv_workload_open_pk
  ON mv_workload_open (user_id, project_id);

-- Per-sprint completed-work history (last 6 + lifetime).
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_sprint_velocity AS
SELECT
  s.id                                              AS sprint_id,
  s."projectId"                                     AS project_id,
  s.name                                            AS name,
  s."endDate"                                       AS end_date,
  COUNT(t.id)::int                                  AS completed_count,
  COALESCE(SUM(t.estimate), 0)::int                 AS completed_estimate
FROM "Sprint" s
LEFT JOIN "Task" t ON t."sprintId" = s.id AND t.status IN ('Done', 'Approved')
WHERE s.state = 'completed'
GROUP BY s.id;

CREATE UNIQUE INDEX IF NOT EXISTS mv_sprint_velocity_pk ON mv_sprint_velocity (sprint_id);
CREATE INDEX IF NOT EXISTS mv_sprint_velocity_project_end_idx
  ON mv_sprint_velocity (project_id, end_date DESC);

-- 30-day rolling cycle time per project (avg seconds from first In Progress
-- → Done/Approved transition event). Daily refresh is plenty.
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_cycle_time_30d AS
WITH done_events AS (
  SELECT e."entityId" AS task_id, e."projectId" AS project_id, MIN(e."createdAt") AS done_at
  FROM "Event" e
  WHERE e.type = 'TaskStatusChanged'
    AND e."createdAt" >= NOW() - INTERVAL '30 days'
    AND e.payload ->> 'toStatus' IN ('Done', 'Approved')
  GROUP BY e."entityId", e."projectId"
),
progress_events AS (
  SELECT e."entityId" AS task_id, MIN(e."createdAt") AS first_in_progress
  FROM "Event" e
  WHERE e.type = 'TaskStatusChanged'
    AND e.payload ->> 'toStatus' = 'In Progress'
  GROUP BY e."entityId"
)
SELECT
  d.project_id                                                 AS project_id,
  AVG(EXTRACT(EPOCH FROM (d.done_at - p.first_in_progress)))   AS avg_seconds,
  COUNT(*)::int                                                AS sample_size
FROM done_events d
JOIN progress_events p ON p.task_id = d.task_id
WHERE d.done_at > p.first_in_progress AND d.project_id IS NOT NULL
GROUP BY d.project_id;

CREATE UNIQUE INDEX IF NOT EXISTS mv_cycle_time_30d_pk ON mv_cycle_time_30d (project_id);

-- 8b. Seed current-month and next-month Event partitions. MaintenanceScheduler
--    keeps the rolling window populated after this; this block guarantees the
--    first two months exist on day one.
DO $$
DECLARE
  cur_from date := date_trunc('month', CURRENT_DATE)::date;
  cur_to   date := (date_trunc('month', CURRENT_DATE) + interval '1 month')::date;
  nxt_to   date := (date_trunc('month', CURRENT_DATE) + interval '2 month')::date;
  cur_name text := 'Event_' || to_char(cur_from, 'YYYY_MM');
  nxt_name text := 'Event_' || to_char(cur_to,   'YYYY_MM');
BEGIN
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I PARTITION OF "Event" FOR VALUES FROM (%L) TO (%L)',
    cur_name, cur_from, cur_to
  );
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I PARTITION OF "Event" FOR VALUES FROM (%L) TO (%L)',
    nxt_name, cur_to, nxt_to
  );
END
$$;
