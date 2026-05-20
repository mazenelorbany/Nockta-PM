-- Custom statuses + columns per project.
--
-- Backfills 1:1 (one status per column) from each project's WorkflowPreset
-- so existing boards keep rendering exactly the same on day one. Admins
-- can then split / merge / add statuses from the new Workflow settings.
--
-- Status names are unique per project; renames cascade through Task.status
-- and ProjectWorkflowTransition in the service (not enforced at SQL).

-- ---------- Tables ----------

CREATE TABLE IF NOT EXISTS "ProjectColumn" (
  "id"        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "projectId" UUID NOT NULL REFERENCES "Project"("id") ON DELETE CASCADE,
  "name"      TEXT NOT NULL,
  "position"  INTEGER NOT NULL,
  "color"     TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProjectColumn_projectId_name_key" UNIQUE ("projectId", "name")
);
CREATE INDEX IF NOT EXISTS "ProjectColumn_projectId_idx" ON "ProjectColumn" ("projectId");

CREATE TABLE IF NOT EXISTS "ProjectStatus" (
  "id"              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "projectId"       UUID NOT NULL REFERENCES "Project"("id") ON DELETE CASCADE,
  "columnId"        UUID NOT NULL REFERENCES "ProjectColumn"("id") ON DELETE CASCADE,
  "name"            TEXT NOT NULL,
  "position"        INTEGER NOT NULL,
  "color"           TEXT,
  "isInitialStatus" BOOLEAN NOT NULL DEFAULT FALSE,
  "isDoneStatus"    BOOLEAN NOT NULL DEFAULT FALSE,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProjectStatus_projectId_name_key" UNIQUE ("projectId", "name")
);
CREATE INDEX IF NOT EXISTS "ProjectStatus_projectId_idx" ON "ProjectStatus" ("projectId");
CREATE INDEX IF NOT EXISTS "ProjectStatus_columnId_idx" ON "ProjectStatus" ("columnId");

-- ---------- Backfill ----------
-- For each existing project, materialise one column per preset-status and
-- one status that lives inside it. Position mirrors the preset's order.
-- isInitial = the first status in the preset; isDone = the last (Design
-- additionally marks Approved as done — see comment below).

-- Engineering: Todo, In Progress, In Review, Testing, Done
WITH eng AS (
  SELECT p.id AS pid, x.name, x.pos
  FROM "Project" p
  JOIN LATERAL (VALUES
    ('Todo',         0),
    ('In Progress',  1),
    ('In Review',    2),
    ('Testing',      3),
    ('Done',         4)
  ) AS x(name, pos) ON TRUE
  WHERE p."workflowPreset" = 'engineering'
), eng_columns AS (
  INSERT INTO "ProjectColumn" ("projectId", "name", "position")
  SELECT pid, name, pos FROM eng
  ON CONFLICT ("projectId", "name") DO NOTHING
  RETURNING "id", "projectId", "name", "position"
)
INSERT INTO "ProjectStatus" ("projectId", "columnId", "name", "position", "isInitialStatus", "isDoneStatus")
SELECT c."projectId", c."id", c."name", 0,
       (c."position" = 0),
       (c."name" = 'Done')
FROM eng_columns c
ON CONFLICT ("projectId", "name") DO NOTHING;

-- Design: Todo, In Progress, In Review, Approved, Done
-- Both Approved and Done are marked isDoneStatus (Approved is the legacy
-- "design-terminal" used by doneStatusesFor in workflow.ts).
WITH des AS (
  SELECT p.id AS pid, x.name, x.pos
  FROM "Project" p
  JOIN LATERAL (VALUES
    ('Todo',         0),
    ('In Progress',  1),
    ('In Review',    2),
    ('Approved',     3),
    ('Done',         4)
  ) AS x(name, pos) ON TRUE
  WHERE p."workflowPreset" = 'design'
), des_columns AS (
  INSERT INTO "ProjectColumn" ("projectId", "name", "position")
  SELECT pid, name, pos FROM des
  ON CONFLICT ("projectId", "name") DO NOTHING
  RETURNING "id", "projectId", "name", "position"
)
INSERT INTO "ProjectStatus" ("projectId", "columnId", "name", "position", "isInitialStatus", "isDoneStatus")
SELECT c."projectId", c."id", c."name", 0,
       (c."position" = 0),
       (c."name" IN ('Approved', 'Done'))
FROM des_columns c
ON CONFLICT ("projectId", "name") DO NOTHING;

-- Generic: Todo, In Progress, Done
WITH gen AS (
  SELECT p.id AS pid, x.name, x.pos
  FROM "Project" p
  JOIN LATERAL (VALUES
    ('Todo',         0),
    ('In Progress',  1),
    ('Done',         2)
  ) AS x(name, pos) ON TRUE
  WHERE p."workflowPreset" = 'generic'
), gen_columns AS (
  INSERT INTO "ProjectColumn" ("projectId", "name", "position")
  SELECT pid, name, pos FROM gen
  ON CONFLICT ("projectId", "name") DO NOTHING
  RETURNING "id", "projectId", "name", "position"
)
INSERT INTO "ProjectStatus" ("projectId", "columnId", "name", "position", "isInitialStatus", "isDoneStatus")
SELECT c."projectId", c."id", c."name", 0,
       (c."position" = 0),
       (c."name" = 'Done')
FROM gen_columns c
ON CONFLICT ("projectId", "name") DO NOTHING;
