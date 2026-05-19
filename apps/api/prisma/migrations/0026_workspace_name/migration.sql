-- Add workspaceName to the singleton WorkspaceAiSettings row so the
-- displayed workspace name (sidebar pill, page title) is editable from
-- /settings/ai instead of being hardcoded in apps/web.
ALTER TABLE "WorkspaceAiSettings"
  ADD COLUMN IF NOT EXISTS "workspaceName" TEXT NOT NULL DEFAULT 'Nockta';
