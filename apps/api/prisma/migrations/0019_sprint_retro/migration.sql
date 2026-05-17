-- =============================================================================
-- 0018_sprint_retro
--
-- Pass I — Sprints 8 → 9. Retro + goal hit-rate.
--
-- Adds two thin tables hanging off Sprint:
--
--   SprintRetro            — at most one per sprint. The classic three columns
--                            (wentWell / couldImprove / actionItems) plus a
--                            free-form JSON action-item list.
--
--   SprintGoalEvaluation   — at most one per sprint. Boolean "did we hit the
--                            goal we wrote in Sprint.goal" plus an optional
--                            note. Drives the `analytics.goalHitRate` extension
--                            that reports rolling hit-rates per project.
--
-- Both tables use sprintId as a UNIQUE foreign key so the relation reads as
-- exactly 1-to-0..1 from the Sprint side (Prisma will infer the singular
-- relation). ON DELETE CASCADE because once a sprint is deleted, neither the
-- retro nor the eval row mean anything on their own.
-- =============================================================================

-- ---- SprintRetro ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "SprintRetro" (
    "id"               UUID         NOT NULL DEFAULT gen_random_uuid(),
    "sprintId"         UUID         NOT NULL,
    -- Author may be null when the API itself writes the row (e.g. a
    -- system-generated retro from an AI summary). Most rows will carry the
    -- human author who clicked "Run retro".
    "authorUserId"     UUID,
    "whatWentWell"     TEXT,
    "whatCouldImprove" TEXT,
    -- JSON array of {description, ownerUserId?, status: 'open'|'done', dueDate?}.
    -- Kept inline instead of a separate ActionItem table — listing across a
    -- project still needs only one query and the cardinality is small.
    "actionItems"      JSONB        NOT NULL DEFAULT '[]'::jsonb,
    "createdAt"        TIMESTAMPTZ  NOT NULL DEFAULT now(),
    "updatedAt"        TIMESTAMPTZ  NOT NULL DEFAULT now(),

    CONSTRAINT "SprintRetro_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SprintRetro_sprintId_key" UNIQUE ("sprintId"),
    CONSTRAINT "SprintRetro_sprintId_fkey" FOREIGN KEY ("sprintId")
        REFERENCES "Sprint"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SprintRetro_authorUserId_fkey" FOREIGN KEY ("authorUserId")
        REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "SprintRetro_authorUserId_idx"
    ON "SprintRetro" ("authorUserId");

-- ---- SprintGoalEvaluation ---------------------------------------------------
CREATE TABLE IF NOT EXISTS "SprintGoalEvaluation" (
    "id"                UUID        NOT NULL DEFAULT gen_random_uuid(),
    "sprintId"          UUID        NOT NULL,
    "goalAchieved"      BOOLEAN     NOT NULL,
    "note"              TEXT,
    "evaluatedByUserId" UUID,
    "evaluatedAt"       TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "SprintGoalEvaluation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SprintGoalEvaluation_sprintId_key" UNIQUE ("sprintId"),
    CONSTRAINT "SprintGoalEvaluation_sprintId_fkey" FOREIGN KEY ("sprintId")
        REFERENCES "Sprint"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SprintGoalEvaluation_evaluatedByUserId_fkey"
        FOREIGN KEY ("evaluatedByUserId")
        REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "SprintGoalEvaluation_evaluatedByUserId_idx"
    ON "SprintGoalEvaluation" ("evaluatedByUserId");
