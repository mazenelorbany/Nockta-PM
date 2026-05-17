-- =============================================================================
-- 0017_notification_digests
--
-- Pass I — Notifications 8 → 9. Smart digest batching.
--
-- A user with User.digestEnabled=true gets their immediate notifications folded
-- into a single rolled-up email/Chat message every ~5 minutes (or after 10
-- items, whichever comes first). The dispatcher writes into NotificationDigest
-- instead of enqueueing a per-event delivery job; the
-- NotificationDigestService cron flushes due rows.
--
-- This file adds:
--   1. Two User columns:  digestEnabled bool, digestChannel text
--      Default OFF / 'email' so the rollout doesn't change existing UX.
--   2. NotificationDigest table with the buffered items + sentAt marker.
--
-- The dispatcher path is NOT modified by SQL — that's a code-level decision
-- (see NotificationDispatcherService.dispatch). The schema is additive and a
-- pre-rollout replica that doesn't know about the new code path simply
-- continues to enqueue immediate deliveries; no data corruption is possible.
-- =============================================================================

-- ---- User: digest preferences ----------------------------------------------
ALTER TABLE "User"
    ADD COLUMN IF NOT EXISTS "digestEnabled" BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS "digestChannel" TEXT    NOT NULL DEFAULT 'email';

-- ---- NotificationDigest -----------------------------------------------------
CREATE TABLE IF NOT EXISTS "NotificationDigest" (
    "id"            UUID         NOT NULL DEFAULT gen_random_uuid(),
    "userId"        UUID         NOT NULL,
    -- 'email' | 'chat'. Captured at first-queue time; mid-buffer channel
    -- changes flush the existing row to the OLD channel rather than retroactively
    -- moving items between channels.
    "channelKind"   TEXT         NOT NULL,
    -- Items are appended via jsonb concatenation so the cron flush + the
    -- enqueue path can race without losing entries. Capped at ~25 by the
    -- service to keep the row small.
    "items"         JSONB        NOT NULL DEFAULT '[]'::jsonb,
    "firstQueuedAt" TIMESTAMPTZ  NOT NULL DEFAULT now(),
    -- Non-null = the row has been flushed (email/chat message sent). Kept for
    -- a short window for debugging; pruned by the maintenance scheduler.
    "sentAt"        TIMESTAMPTZ,

    CONSTRAINT "NotificationDigest_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "NotificationDigest_userId_fkey" FOREIGN KEY ("userId")
        REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Hot index: "is there a buffer row for this user still open?" Reads filter
-- by userId + sentAt IS NULL; we also need a way to find every pending digest
-- across users during a flush tick — covered by the secondary index below.
CREATE INDEX IF NOT EXISTS "NotificationDigest_userId_sentAt_idx"
    ON "NotificationDigest" ("userId", "sentAt");

-- Cron flush: SELECT * FROM NotificationDigest WHERE sentAt IS NULL — this
-- second index lets the cron tick scan only the small set of open buffers
-- without a sequential scan across the archived rows.
CREATE INDEX IF NOT EXISTS "NotificationDigest_sentAt_idx"
    ON "NotificationDigest" ("sentAt");
