-- =============================================================================
-- 0025_magic_link_project_context
--
-- Lets MagicLink remember the project + inviter context when intent =
-- 'project_invite'. Two follow-on features depend on this:
--
--   1. The "Pending invitations" admin panel in Settings → Members renders
--      `<Inviter> invited <email> to <Project> as <role>` rows. Without
--      these columns we can only show the email + expiry.
--   2. The /auth/magic verify path uses `projectId` to route the recipient
--      to the project board they were invited to, instead of dropping them
--      on the generic dashboard.
--
-- Both columns are nullable + ON DELETE SET NULL so a project deletion or
-- user archive doesn't cascade-delete the audit trail of who was invited
-- where. The new composite index supports the pending-invites query
-- (intent=project_invite AND usedAt IS NULL ORDER BY createdAt).
-- =============================================================================

ALTER TABLE "MagicLink"
  ADD COLUMN "projectId"       UUID,
  ADD COLUMN "invitedByUserId" UUID;

CREATE INDEX "MagicLink_intent_projectId_usedAt_idx"
  ON "MagicLink" ("intent", "projectId", "usedAt");

ALTER TABLE "MagicLink"
  ADD CONSTRAINT "MagicLink_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "MagicLink"
  ADD CONSTRAINT "MagicLink_invitedByUserId_fkey"
  FOREIGN KEY ("invitedByUserId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
