-- =============================================================================
-- 0019_comment_templates
--
-- Pass I — Comments 8 → 9. Reusable comment snippets.
--
-- Templates can be either workspace-wide (projectId IS NULL) or project-scoped.
-- The Activity composer fetches both and merges them in the dropdown — there's
-- no merging UI so a project template with the same `name` as a workspace
-- template simply shows up twice (deliberate; they're distinct rows with
-- distinct bodies).
--
-- @here mention expansion is an entirely service-level concern (no schema
-- change). The body field stores whatever the user typed; the comments
-- service rewrites the `@here` marker into a notification fan-out at create
-- time. See comments.service.ts for the expansion path.
-- =============================================================================

CREATE TABLE IF NOT EXISTS "CommentTemplate" (
    "id"              UUID         NOT NULL DEFAULT gen_random_uuid(),
    "workspaceId"     TEXT         NOT NULL DEFAULT 'default',
    -- Nullable for workspace-wide templates. When set, this template only
    -- appears in the picker for tasks within that project.
    "projectId"       UUID,
    "name"            TEXT         NOT NULL,
    "body"            TEXT         NOT NULL,
    -- Nullable so a system-generated seed template survives if its author is
    -- archived later.
    "createdByUserId" UUID,
    "createdAt"       TIMESTAMPTZ  NOT NULL DEFAULT now(),
    "updatedAt"       TIMESTAMPTZ  NOT NULL DEFAULT now(),

    CONSTRAINT "CommentTemplate_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CommentTemplate_projectId_fkey" FOREIGN KEY ("projectId")
        REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CommentTemplate_createdByUserId_fkey"
        FOREIGN KEY ("createdByUserId")
        REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- The composer fetches by (workspaceId) and OPTIONALLY filters by projectId.
-- One compound index covers both the workspace-wide list and the per-project
-- filtered list without needing a redundant single-column index on workspaceId.
CREATE INDEX IF NOT EXISTS "CommentTemplate_workspaceId_projectId_idx"
    ON "CommentTemplate" ("workspaceId", "projectId");

-- The cascade-from-Project path is already a btree on the FK column; this
-- second index exists for the OPPOSITE direction: listing every template
-- pinned to a single project from the project's settings page.
CREATE INDEX IF NOT EXISTS "CommentTemplate_projectId_idx"
    ON "CommentTemplate" ("projectId");
