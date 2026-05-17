-- Workspace-wide AI knobs. Singleton table — only one row ever (enforced by
-- @@unique on a constant `singleton` int). Drives runtime values that used
-- to live in env: AI duplicate threshold, priority weighting, LLM provider
-- preference, master autosuggest toggle.

CREATE TABLE "WorkspaceAiSettings" (
    "id"                  UUID NOT NULL DEFAULT gen_random_uuid(),
    "singleton"           INTEGER NOT NULL DEFAULT 1,
    "dupThreshold"        DOUBLE PRECISION NOT NULL DEFAULT 0.85,
    "priorityWeights"     JSONB NOT NULL DEFAULT '{"deadline":1,"blocked":2,"customerImpact":1.5}',
    "autoSuggestEnabled"  BOOLEAN NOT NULL DEFAULT true,
    "modelPreference"     TEXT NOT NULL DEFAULT 'auto',
    "updatedAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedById"         UUID NOT NULL,

    CONSTRAINT "WorkspaceAiSettings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WorkspaceAiSettings_singleton_key"
  ON "WorkspaceAiSettings"("singleton");

-- Per-task structured priority breakdown surfaced in the task drawer. Existing
-- aiPriorityReason (free-text rationale) stays — this is the structured sibling.
ALTER TABLE "Task" ADD COLUMN "aiPriorityFactors" JSONB;
