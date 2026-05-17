-- =============================================================================
-- 0008_project_archive_grace
--
-- Pass 5 (R4 deferred): formalize the 7-day archive grace period for Projects.
--
-- The Project model already gained `archivedAt TIMESTAMP(3)` in 0001_init plus
-- a covering `@@index([archivedAt])`. Archive previously hard-deleted; now
-- archive flips `archivedAt = now()`, restore clears it, and a nightly cron
-- (ProjectsPurgeProcessor) hard-deletes rows where `archivedAt < now() - 7d`.
--
-- Why a no-op-flavored migration: shipping a migration file keeps the migrate
-- ledger contiguous (0006 / 0007 are reserved for parallel passes; 0008 is
-- ours). Wrapping the column add in `IF NOT EXISTS` makes the SQL idempotent
-- when applied against a database that already booted from 0001_init.
-- =============================================================================

ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "archivedAt" TIMESTAMP(3);

-- The index already exists from 0001_init; redeclare with IF NOT EXISTS to
-- protect fresh databases that somehow skipped the original DDL (e.g. a
-- repaired baseline). On the happy path this is a no-op.
CREATE INDEX IF NOT EXISTS "Project_archivedAt_idx" ON "Project"("archivedAt");

-- Pomodoro preference (Pass 5 B). Stored as a plain Boolean column rather than
-- folded into a JSON `preferences` blob to match the existing
-- `weeklyHoursTarget` precedent: each scalar preference is its own typed
-- column so callers can `select` it without parsing JSON.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "pomodoroEnabled" BOOLEAN NOT NULL DEFAULT false;
