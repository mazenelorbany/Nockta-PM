-- =============================================================================
-- 0014_import_resumable
--
-- Pass D — Imports overhaul. Two concerns:
--   * ImportRun.lastError — short, human-readable failure message captured at
--     the moment a run goes from `running` → `failed`. Distinct from
--     `errorSummary`, which is the *aggregated* per-row error feed (top 10
--     joined by newlines). `lastError` is what POST /import/:id/resume reads
--     to decide whether the run is replayable and what to show in the
--     "Resume" affordance tooltip.
--   * JiraStatusMap — workspace-scoped overrides for the Jira-CSV adapter's
--     status mapping. Lets a workspace admin pin "Awaiting Triage" → "Todo"
--     once and have every subsequent Jira CSV import respect the override,
--     without round-tripping the mapping through the UI on every run.
--
-- NB: `resumableFromRow` + `resumePayload` already landed in 0012 alongside
-- the Exports tables; this migration is purely additive on top of that.
-- =============================================================================

-- ---- ImportRun: short-form failure message --------------------------------
ALTER TABLE "ImportRun"
    ADD COLUMN "lastError" TEXT;

-- ---- JiraStatusMap: workspace-level status overrides ----------------------
-- Workspace + lowercased Jira status name is unique; Nockta status string is
-- whatever the destination project's workflow preset accepts. The Jira-CSV
-- importer merges this table on top of the in-code preset table before any
-- per-run override the user supplies via the mapper UI.
CREATE TABLE "JiraStatusMap" (
    "id"            UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspaceId"   TEXT NOT NULL,
    "jiraStatus"    TEXT NOT NULL,
    "nocktaStatus"  TEXT NOT NULL,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMP(3) NOT NULL,
    "createdById"   UUID NOT NULL,
    CONSTRAINT "JiraStatusMap_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "JiraStatusMap_workspaceId_jiraStatus_key"
    ON "JiraStatusMap"("workspaceId", "jiraStatus");
CREATE INDEX "JiraStatusMap_workspaceId_idx"
    ON "JiraStatusMap"("workspaceId");

ALTER TABLE "JiraStatusMap"
    ADD CONSTRAINT "JiraStatusMap_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT;
