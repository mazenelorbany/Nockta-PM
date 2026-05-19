-- =============================================================================
-- 0024_magic_link_project_invite
--
-- Adds the `project_invite` value to the MagicLinkIntent enum so the
-- project-scoped invite-guest flow can issue magic links with a longer TTL
-- (typically 7 days, vs the 15-minute sign-in TTL) and the verify path can
-- tell invitation acceptance apart from a regular client_login.
--
-- Safe to apply mid-deploy: new enum values are accepted by all consumers
-- that don't check via discriminated union — and the only consumer that
-- does is auth.service.verifyMagicLink, which routes any non-known intent
-- through the same client_login code path.
-- =============================================================================

ALTER TYPE "MagicLinkIntent" ADD VALUE IF NOT EXISTS 'project_invite';
