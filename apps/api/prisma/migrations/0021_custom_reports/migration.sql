-- =============================================================================
-- 0020_custom_reports
--
-- Pass I — Analytics 8 → 9. Custom report builder.
--
-- A saved CustomReport describes a parameterized "groupBy + aggregate" over
-- the Task table. The reports service translates it into a single Prisma
-- $queryRaw with prepared bindings — no string interpolation of user input
-- ever touches the SQL. The dimension/metric/filter fields are validated
-- against a server-side allowlist before any query runs.
--
-- Dimension allowlist (enforced in reports.service.ts):
--   'status' | 'assignee' | 'priority' | 'sprint' | 'label' | 'project'
-- Metric allowlist:
--   'count' | 'sum_estimate' | 'sum_actual'
--
-- The shape is intentionally narrow — a real BI tool isn't the point. We want
-- "show me open Tasks grouped by assignee with their summed estimates"
-- without shipping a new endpoint per slicing.
-- =============================================================================

CREATE TABLE IF NOT EXISTS "CustomReport" (
    "id"              UUID         NOT NULL DEFAULT gen_random_uuid(),
    "workspaceId"     TEXT         NOT NULL DEFAULT 'default',
    "name"            TEXT         NOT NULL,
    -- text[] so dimensions can grow without a column migration. The service
    -- enforces the allowlist; anything outside it is a 400.
    "dimensions"      TEXT[]       NOT NULL DEFAULT ARRAY[]::TEXT[],
    "metric"          TEXT         NOT NULL,
    "filters"         JSONB        NOT NULL DEFAULT '{}'::jsonb,
    -- Optional anchor. When set, the report shows under that project's
    -- analytics tab and the project's id is implicitly added to the
    -- effective filter set so it's impossible to leak cross-project rows
    -- out of a project-scoped report.
    "projectId"       UUID,
    "createdByUserId" UUID,
    "createdAt"       TIMESTAMPTZ  NOT NULL DEFAULT now(),
    "updatedAt"       TIMESTAMPTZ  NOT NULL DEFAULT now(),

    CONSTRAINT "CustomReport_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CustomReport_projectId_fkey" FOREIGN KEY ("projectId")
        REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CustomReport_createdByUserId_fkey"
        FOREIGN KEY ("createdByUserId")
        REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- Workspace-wide list: SELECT * FROM CustomReport WHERE workspaceId = $1.
CREATE INDEX IF NOT EXISTS "CustomReport_workspaceId_idx"
    ON "CustomReport" ("workspaceId");

-- Project-scoped list: rendered as a tab on each project's analytics page.
CREATE INDEX IF NOT EXISTS "CustomReport_projectId_idx"
    ON "CustomReport" ("projectId");

-- "My reports" filter for the reports page.
CREATE INDEX IF NOT EXISTS "CustomReport_createdByUserId_idx"
    ON "CustomReport" ("createdByUserId");
