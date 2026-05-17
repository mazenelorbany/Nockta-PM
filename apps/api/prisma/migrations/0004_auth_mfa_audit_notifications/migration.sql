-- =============================================================================
-- 0004_auth_mfa_audit_notifications
--
-- 1. MFA columns on User (totpSecret encrypted at rest, mfaEnabled toggle,
--    mfaBackupCodes sha256 hashes — consumed on use).
-- 2. AuditLogEntry — append-only security event log; surfaces in
--    Settings → Security → Recent activity.
-- 3. NotificationMute — generalized per-entity mute (task | doc).
-- 4. NotificationSnoozeRule — per-user DND windows.
-- =============================================================================

-- ---- 1. MFA columns -------------------------------------------------------
ALTER TABLE "User" ADD COLUMN "totpSecret"    TEXT;
ALTER TABLE "User" ADD COLUMN "mfaEnabled"    BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User" ADD COLUMN "mfaBackupCodes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- ---- 2. AuditLogEntry -----------------------------------------------------
CREATE TABLE "AuditLogEntry" (
    "id"        UUID NOT NULL DEFAULT gen_random_uuid(),
    "userId"    UUID,
    "action"    TEXT NOT NULL,
    "ip"        TEXT,
    "userAgent" TEXT,
    "metadata"  JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuditLogEntry_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "AuditLogEntry"
    ADD CONSTRAINT "AuditLogEntry_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "AuditLogEntry_userId_createdAt_idx"
    ON "AuditLogEntry"("userId", "createdAt");
CREATE INDEX "AuditLogEntry_action_idx" ON "AuditLogEntry"("action");

-- ---- 3. NotificationMute --------------------------------------------------
CREATE TABLE "NotificationMute" (
    "id"         UUID NOT NULL DEFAULT gen_random_uuid(),
    "userId"     UUID NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId"   UUID NOT NULL,
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "NotificationMute_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "NotificationMute"
    ADD CONSTRAINT "NotificationMute_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "NotificationMute_userId_entityType_entityId_key"
    ON "NotificationMute"("userId", "entityType", "entityId");
CREATE INDEX "NotificationMute_userId_entityType_idx"
    ON "NotificationMute"("userId", "entityType");

-- ---- 4. NotificationSnoozeRule --------------------------------------------
CREATE TABLE "NotificationSnoozeRule" (
    "id"         UUID NOT NULL DEFAULT gen_random_uuid(),
    "userId"     UUID NOT NULL,
    "daysOfWeek" TEXT[] NOT NULL,
    "startHour"  INTEGER NOT NULL,
    "endHour"    INTEGER NOT NULL,
    "enabled"    BOOLEAN NOT NULL DEFAULT true,
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"  TIMESTAMP(3) NOT NULL,
    CONSTRAINT "NotificationSnoozeRule_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "NotificationSnoozeRule"
    ADD CONSTRAINT "NotificationSnoozeRule_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "NotificationSnoozeRule_userId_enabled_idx"
    ON "NotificationSnoozeRule"("userId", "enabled");
