-- =============================================================================
-- 0013_ai_triage_explanation
--
-- Pass B (Round 6, AI 7→9): adds `Task.aiTriageExplanation` — the longer
-- 2-3 sentence narrative the PrioritizeProcessor writes alongside the existing
-- `aiPriorityReason` one-liner and `aiPriorityFactors` table.
--
-- The triage explanation is the auditable "why did the AI place this task
-- here?" prose. It references concrete signals — title keywords, similar past
-- tasks, blocker risk, due date proximity — so users reading the AiWhyChip
-- tooltip see the model's reasoning, not just a numeric weight breakdown.
--
-- NOTE on migration numbering: the original spec called for 0010_ai_triage,
-- but slot 0010 was claimed in the cost telemetry pass for `0010_ai_usage_events`.
-- 0011, 0012 are similarly already taken. Sliding to 0013 keeps the history
-- contiguous and avoids rewriting the cost telemetry pass.
-- =============================================================================

ALTER TABLE "Task"
  ADD COLUMN "aiTriageExplanation" TEXT;
