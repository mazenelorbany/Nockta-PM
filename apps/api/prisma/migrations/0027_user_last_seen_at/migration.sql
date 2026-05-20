-- Add User.lastSeenAt so JwtStrategy.touchLastSeen has a column to write to
-- and the Members tab can read "Last Activity". Defaults to CURRENT_TIMESTAMP
-- so existing rows backfill to "now" rather than NULL (avoids a one-time
-- "everyone hasn't been seen" rendering bug on first deploy).
ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
