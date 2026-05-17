-- =============================================================================
-- 0006_web_push_subscriptions
--
-- Adds the PushSubscription table — one row per (user, browser endpoint).
-- The endpoint column is unique so re-subscribing from the same browser
-- upserts the existing row instead of duplicating it. Cascade on user
-- delete so wiping an account also wipes their push targets.
-- =============================================================================

CREATE TABLE "PushSubscription" (
    "id"         UUID NOT NULL DEFAULT gen_random_uuid(),
    "userId"     UUID NOT NULL,
    "endpoint"   TEXT NOT NULL,
    "p256dh"     TEXT NOT NULL,
    "auth"       TEXT NOT NULL,
    "label"      TEXT,
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PushSubscription_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "PushSubscription"
    ADD CONSTRAINT "PushSubscription_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE;

CREATE UNIQUE INDEX "PushSubscription_endpoint_key"
    ON "PushSubscription"("endpoint");

CREATE INDEX "PushSubscription_userId_idx"
    ON "PushSubscription"("userId");
