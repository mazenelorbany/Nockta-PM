-- =============================================================================
-- 0007_outbound_webhooks
--
-- Workspace-level outbound webhooks. Distinct from automation-rule
-- send_webhook (which fires one-shot when an automation matches a
-- project-scoped trigger). OutboundWebhook fans the existing event
-- stream out to a subscriber-configured URL with HMAC-SHA256 signing,
-- exponential backoff, and auto-disable on consecutive failures.
--
-- See schema.prisma OutboundWebhook + WebhookDelivery for the model
-- rationale; src/modules/outbound-webhooks/ for the runtime.
-- =============================================================================

-- ---- OutboundWebhook -------------------------------------------------------
CREATE TABLE "OutboundWebhook" (
    "id"             UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspaceId"    TEXT NOT NULL,
    "name"           TEXT NOT NULL,
    "url"            TEXT NOT NULL,
    "secret"         TEXT NOT NULL,
    "eventTypes"     TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "enabled"        BOOLEAN NOT NULL DEFAULT true,
    "failureCount"   INTEGER NOT NULL DEFAULT 0,
    "lastDeliveryAt" TIMESTAMP(3),
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMP(3) NOT NULL,
    "createdById"    UUID NOT NULL,
    CONSTRAINT "OutboundWebhook_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "OutboundWebhook"
    ADD CONSTRAINT "OutboundWebhook_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT;

CREATE INDEX "OutboundWebhook_workspaceId_enabled_idx"
    ON "OutboundWebhook"("workspaceId", "enabled");

-- ---- WebhookDelivery -------------------------------------------------------
CREATE TABLE "WebhookDelivery" (
    "id"              UUID NOT NULL DEFAULT gen_random_uuid(),
    "webhookId"       UUID NOT NULL,
    "eventType"       TEXT NOT NULL,
    "payload"         JSONB NOT NULL,
    "status"          TEXT NOT NULL,
    "attemptCount"    INTEGER NOT NULL DEFAULT 0,
    "responseCode"    INTEGER,
    "responseExcerpt" TEXT,
    "deliveredAt"     TIMESTAMP(3),
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "WebhookDelivery"
    ADD CONSTRAINT "WebhookDelivery_webhookId_fkey"
    FOREIGN KEY ("webhookId") REFERENCES "OutboundWebhook"("id") ON DELETE CASCADE;

CREATE INDEX "WebhookDelivery_webhookId_createdAt_idx"
    ON "WebhookDelivery"("webhookId", "createdAt" DESC);
