-- =============================================================================
-- 0013_custom_fields_advanced
--
-- Round 6, Pass C — finalize the formula / rollup / conditional-visibility
-- columns on CustomFieldDefinition. The structural schema work was already
-- shipped in 0011_custom_fields_formula (enum values + 3 nullable columns);
-- this migration is the idempotent companion that:
--
--   1. Re-asserts the ADD VALUE / ADD COLUMN statements with IF NOT EXISTS
--      guards so re-running against an already-migrated database is a no-op.
--      (Round-5-audited databases are at 0012 and will pick up the bodies
--      here; 0011-already-applied databases skip everything.)
--   2. Adds a partial GIN index on visibilityRule so a future "find all
--      fields hidden when status=open" admin view can scan in <10ms.
--   3. Adds an index on (projectId, kind) so the per-project formula/rollup
--      scan that the cycle detector runs at save time is point-lookup.
--
-- No data migration. No data loss.
-- =============================================================================

-- 1. Enum values + columns (defensive re-statements; the structural work
--    was done in 0011 but we want this migration to be self-contained for
--    forks/branches that started from a pre-0011 dump).
ALTER TYPE "CustomFieldKind" ADD VALUE IF NOT EXISTS 'formula';
ALTER TYPE "CustomFieldKind" ADD VALUE IF NOT EXISTS 'rollup';

ALTER TABLE "CustomFieldDefinition"
  ADD COLUMN IF NOT EXISTS "formulaExpression" TEXT;
ALTER TABLE "CustomFieldDefinition"
  ADD COLUMN IF NOT EXISTS "rollupConfig" JSONB;
ALTER TABLE "CustomFieldDefinition"
  ADD COLUMN IF NOT EXISTS "visibilityRule" JSONB;

-- 2. Partial GIN index on visibilityRule — only the rows that HAVE a rule
--    pay the index cost, so the storage hit is bounded by "fields with
--    conditional visibility" which is the long tail. Lets admin views
--    answer "which fields depend on field X" without a full table scan.
CREATE INDEX IF NOT EXISTS "CustomFieldDefinition_visibilityRule_idx"
  ON "CustomFieldDefinition"
  USING GIN ("visibilityRule")
  WHERE "visibilityRule" IS NOT NULL;

-- 3. (projectId, kind) covering index — the formula cycle detector runs
--    SELECT name, formulaExpression FROM CustomFieldDefinition WHERE
--    projectId=$1 AND kind='formula' AND archivedAt IS NULL on every save.
--    Without this it sequential-scans the whole table.
CREATE INDEX IF NOT EXISTS "CustomFieldDefinition_projectId_kind_idx"
  ON "CustomFieldDefinition" ("projectId", "kind")
  WHERE "archivedAt" IS NULL;
