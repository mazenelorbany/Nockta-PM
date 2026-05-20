-- Add the ProjectWorkflowTransition table that defines the directed graph of
-- allowed status flips per project. Rows are (from → to) edges; the API
-- consults this set before mutating Task.status so admins can enforce
-- "no Todo → Done direct-jumps".
--
-- The table is backfilled with the linear-with-reopen defaults for every
-- existing project so the new constraint doesn't retroactively block legal
-- transitions on day one. Admins can edit the set per project from the
-- Project Settings → Workflow section.

CREATE TABLE IF NOT EXISTS "ProjectWorkflowTransition" (
  "id"         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "projectId"  UUID NOT NULL REFERENCES "Project"("id") ON DELETE CASCADE,
  "fromStatus" TEXT NOT NULL,
  "toStatus"   TEXT NOT NULL,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProjectWorkflowTransition_projectId_fromStatus_toStatus_key"
    UNIQUE ("projectId", "fromStatus", "toStatus")
);

CREATE INDEX IF NOT EXISTS "ProjectWorkflowTransition_projectId_idx"
  ON "ProjectWorkflowTransition" ("projectId");

-- Backfill defaults per preset. Done as INSERT … SELECT so it's idempotent
-- (the unique index drops duplicates if the migration is re-applied) and
-- so we never hand-write more than one row per (project, preset) tuple.
--
-- Engineering: Todo → InProgress → InReview → Testing → Done, every step
-- reversible. Done can be reopened back to Testing or In Progress.
-- Design: same shape with "Approved" before "Done".
-- Generic: Todo ↔ In Progress ↔ Done.
--
-- The arrays below are paired (fromStatus[i], toStatus[i]).
WITH eng (frm, too) AS (
  VALUES
    ('Todo',        'In Progress'),
    ('In Progress', 'Todo'),
    ('In Progress', 'In Review'),
    ('In Review',   'In Progress'),
    ('In Review',   'Testing'),
    ('Testing',     'In Review'),
    ('Testing',     'Done'),
    ('Done',        'Testing'),
    ('Done',        'In Progress')
),
design (frm, too) AS (
  VALUES
    ('Todo',        'In Progress'),
    ('In Progress', 'Todo'),
    ('In Progress', 'In Review'),
    ('In Review',   'In Progress'),
    ('In Review',   'Approved'),
    ('Approved',    'In Review'),
    ('Approved',    'Done'),
    ('Done',        'Approved'),
    ('Done',        'In Progress')
),
generic (frm, too) AS (
  VALUES
    ('Todo',        'In Progress'),
    ('In Progress', 'Todo'),
    ('In Progress', 'Done'),
    ('Done',        'In Progress')
)
INSERT INTO "ProjectWorkflowTransition" ("projectId", "fromStatus", "toStatus")
SELECT p."id", e.frm, e.too
FROM "Project" p
JOIN eng e ON p."workflowPreset" = 'engineering'
UNION ALL
SELECT p."id", d.frm, d.too
FROM "Project" p
JOIN design d ON p."workflowPreset" = 'design'
UNION ALL
SELECT p."id", g.frm, g.too
FROM "Project" p
JOIN generic g ON p."workflowPreset" = 'generic'
ON CONFLICT ("projectId", "fromStatus", "toStatus") DO NOTHING;
