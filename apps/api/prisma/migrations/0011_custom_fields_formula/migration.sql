-- =============================================================================
-- 0011_custom_fields_formula
--
-- Lifts Custom Fields from 7 -> 9 by adding three new capabilities that the
-- Round 5 audit asked for:
--   1. Formula fields    — read-only, computed at fetch time from an
--                          expression that references other custom fields by
--                          key plus a small set of built-ins.
--   2. Rollup fields     — read-only, computed at fetch time from an
--                          aggregation over a relation (subtasks /
--                          linkedTasks) and a numeric field.
--   3. Conditional       — defs can declare a visibility rule; both the
--      visibility         frontend editor list AND the backend value
--                          response filter the field out when the rule
--                          evaluates to false.
--
-- Schema-wise this is three nullable columns on CustomFieldDefinition and
-- two new enum values on CustomFieldKind. No data migration is needed —
-- existing defs stay valid (the new columns default to NULL, which the
-- evaluator and visibility filter both treat as "no rule / not applicable").
--
-- IMPORTANT: the `key` rename audit point. The Round 5 review asked for
-- "bulk-rename without losing data". CustomFieldDefinition has no `key`
-- column — values are bound by `fieldId` (UUID) FK, so renaming the
-- human-readable `name` column is a one-row UPDATE and the per-task
-- CustomFieldValue rows continue to resolve untouched. The formula
-- evaluator references fields by `name` too (we treat name as the
-- formula-identifier slug), so a rename does require formulas that
-- reference the old name to be updated by the user — but VALUES never move.
-- =============================================================================

-- Two new field kinds — formula (computed expression) and rollup
-- (aggregate over a relation). Postgres enums need ALTER TYPE ... ADD VALUE
-- guarded by IF NOT EXISTS so re-applying the migration is a no-op.
ALTER TYPE "CustomFieldKind" ADD VALUE IF NOT EXISTS 'formula';
ALTER TYPE "CustomFieldKind" ADD VALUE IF NOT EXISTS 'rollup';

-- Expression body for kind='formula'. Free-form text, parsed by the
-- hand-rolled tokenizer in formula-evaluator.ts. NULL for non-formula defs.
ALTER TABLE "CustomFieldDefinition"
  ADD COLUMN IF NOT EXISTS "formulaExpression" TEXT;

-- Aggregation config for kind='rollup'. Shape:
--   { relation: 'subtasks' | 'linkedTasks',
--     field:    'estimate' | 'storyPoints' | <customFieldName>,
--     agg:      'sum' | 'avg' | 'min' | 'max' | 'count' }
-- NULL for non-rollup defs.
ALTER TABLE "CustomFieldDefinition"
  ADD COLUMN IF NOT EXISTS "rollupConfig" JSONB;

-- Conditional visibility rule. Shape:
--   { when: { fieldKey: <name>, op: 'equals' | 'in' | 'isSet', value: any } }
-- NULL means "always visible" (default). Evaluated client-side (editor
-- list) AND server-side (response filtering for security so hidden field
-- values aren't leaked for tasks where the field isn't applicable).
ALTER TABLE "CustomFieldDefinition"
  ADD COLUMN IF NOT EXISTS "visibilityRule" JSONB;
