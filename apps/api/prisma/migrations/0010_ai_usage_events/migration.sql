-- =============================================================================
-- 0010_ai_usage_events
--
-- Pass B (Round 6, AI 7→9): cost telemetry + per-feature workspace settings.
--
-- Adds two pieces:
--   1. `AiUsageEvent` — one row per LLM call (success + short-circuit). Drives
--      the /ai/usage/summary dashboard and the per-kind monthly budget gate in
--      the processors. Indexed on (workspaceId, createdAt) so the dashboard
--      query stays O(window) regardless of total volume.
--   2. `WorkspaceAiSettings.settings` JSONB — bag for per-feature enable flags
--      and per-kind monthly budgets in USD cents. Default has every feature ON
--      and no budget caps; the processors short-circuit when the kind's
--      month-to-date spend exceeds its budget.
--
-- `workspaceId` defaults to the literal `'default'` so the column ships filled
-- in a single-workspace database. The R6 multi-tenant pass will swap callers
-- to inject a real workspace id; no migration needed there.
-- =============================================================================

CREATE TABLE "AiUsageEvent" (
    "id"            UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspaceId"   TEXT NOT NULL DEFAULT 'default',
    "kind"          TEXT NOT NULL,
    "modelName"     TEXT NOT NULL,
    "inputTokens"   INTEGER NOT NULL DEFAULT 0,
    "outputTokens"  INTEGER NOT NULL DEFAULT 0,
    "costUsdCents"  INTEGER NOT NULL DEFAULT 0,
    "status"        TEXT NOT NULL DEFAULT 'ok',
    "userId"        UUID,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiUsageEvent_pkey" PRIMARY KEY ("id")
);

-- Primary lookup pattern is "everything for workspace X in window [t0, t1]";
-- secondary is "this kind, this month" for the budget gate. Two compound
-- indexes cover both without a sequential scan.
CREATE INDEX "AiUsageEvent_workspaceId_createdAt_idx"
  ON "AiUsageEvent"("workspaceId", "createdAt");
CREATE INDEX "AiUsageEvent_kind_createdAt_idx"
  ON "AiUsageEvent"("kind", "createdAt");

-- Optional FK to the actor user when the call was on a user's behalf. Set null
-- on user delete so we keep the cost row for historical reporting.
ALTER TABLE "AiUsageEvent"
  ADD CONSTRAINT "AiUsageEvent_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- WorkspaceAiSettings.settings — JSONB holding per-feature toggles + per-kind
-- monthly budgets. See schema.prisma for the canonical shape.
ALTER TABLE "WorkspaceAiSettings"
  ADD COLUMN "settings" JSONB NOT NULL
  DEFAULT '{"features":{"duplicateDetection":true,"prioritySuggestion":true,"standupSynthesis":true,"sprintPlanning":true},"monthlyBudgetUsdCents":{}}';
