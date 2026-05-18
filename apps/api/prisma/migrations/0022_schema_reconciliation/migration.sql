-- =============================================================================
-- 0022_schema_reconciliation
--
-- Aligns the migration history with the current `schema.prisma`. Earlier
-- development used `prisma db push` for some schema edits, leaving the
-- migration journal behind. This migration is the single catch-up.
--
-- Three independent kinds of change:
--
--   1. NEW TABLES that only existed in dev (created by `db push`):
--      SprintTaskMembership, DailyWorkloadSnapshot, CfdSnapshot.
--      Backfill for SprintTaskMembership lives at the bottom of this file
--      so it runs once, on this migration, instead of every boot via
--      companion.sql.
--
--   2. NEW COLUMNS added since the last numbered migration:
--      Doc.contentJson, DocRevision.contentJson, Goal.parentGoalId,
--      KeyResult.kind + weight, Project.defaultTaskVisibility, Sprint.goal,
--      Task.aiPriorityReason, TaskTemplate.tags + taskType,
--      User.weeklyHoursTarget.
--
--   3. STALE COLUMNS dropped after cad5aee ("strip MFA, Workspaces, and
--      WebPushSubscription from the API surface"). The code was removed
--      but the column-drop migration was never written. Safe to drop now
--      because nothing in the new code path writes them and production
--      data does not yet exist.
--
-- Foreign-key and index drops/re-adds in this file come from Prisma's diff
-- output: the named constraints in schema.prisma do not match the historical
-- names from prior migrations, so Prisma drops and re-creates them with
-- consistent names. The DB-level shape is identical.
--
-- `ALTER COLUMN id DROP DEFAULT` on several tables removes the legacy
-- `gen_random_uuid()` default. The application now provides the UUID
-- explicitly (verified in service code: createSchedule, createRun, etc.).
-- =============================================================================

-- DropForeignKey
ALTER TABLE "Comment" DROP CONSTRAINT "Comment_quotedCommentId_fkey";

-- DropForeignKey
ALTER TABLE "CommentReaction" DROP CONSTRAINT "CommentReaction_commentId_fkey";

-- DropForeignKey
ALTER TABLE "CommentReaction" DROP CONSTRAINT "CommentReaction_userId_fkey";

-- DropForeignKey
ALTER TABLE "CommentRevision" DROP CONSTRAINT "CommentRevision_commentId_fkey";

-- DropForeignKey
ALTER TABLE "CommentRevision" DROP CONSTRAINT "CommentRevision_editedById_fkey";

-- DropForeignKey
ALTER TABLE "ExportRun" DROP CONSTRAINT "ExportRun_scheduleId_fkey";

-- DropForeignKey
ALTER TABLE "ExportSchedule" DROP CONSTRAINT "ExportSchedule_createdById_fkey";

-- DropForeignKey
ALTER TABLE "JiraStatusMap" DROP CONSTRAINT "JiraStatusMap_createdById_fkey";

-- DropForeignKey
ALTER TABLE "OutboundWebhook" DROP CONSTRAINT "OutboundWebhook_createdById_fkey";

-- DropForeignKey
ALTER TABLE "WebhookDelivery" DROP CONSTRAINT "WebhookDelivery_webhookId_fkey";

-- DropIndex
DROP INDEX "AiUsageEvent_workspaceId_createdAt_idx";

-- DropIndex
DROP INDEX "CommentTemplate_workspaceId_projectId_idx";

-- DropIndex
DROP INDEX "CustomReport_workspaceId_idx";

-- DropIndex
DROP INDEX "ExportSchedule_workspaceId_enabled_idx";

-- DropIndex
DROP INDEX "ExportSchedule_workspaceId_sourceKind_idx";

-- DropIndex
DROP INDEX "JiraStatusMap_workspaceId_idx";

-- DropIndex
DROP INDEX "JiraStatusMap_workspaceId_jiraStatus_key";

-- DropIndex
DROP INDEX "OutboundWebhook_workspaceId_enabled_idx";

-- DropIndex
DROP INDEX "SprintGoalEvaluation_evaluatedByUserId_idx";

-- DropIndex
DROP INDEX "SprintRetro_authorUserId_idx";

-- AlterTable
ALTER TABLE "AiUsageEvent" DROP COLUMN "workspaceId",
ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "AuditLogEntry" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "CommentReaction" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "CommentRevision" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "CommentTemplate" DROP COLUMN "workspaceId",
ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "updatedAt" DROP DEFAULT,
ALTER COLUMN "updatedAt" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "CustomReport" DROP COLUMN "workspaceId",
ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "dimensions" DROP DEFAULT,
ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "updatedAt" DROP DEFAULT,
ALTER COLUMN "updatedAt" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Doc" ADD COLUMN     "contentJson" JSONB;

-- AlterTable
ALTER TABLE "DocRevision" ADD COLUMN     "contentJson" JSONB;

-- AlterTable
ALTER TABLE "ExportRun" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "ExportSchedule" DROP COLUMN "workspaceId",
ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "Goal" ADD COLUMN     "parentGoalId" UUID;

-- AlterTable
ALTER TABLE "ImportRun" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "JiraStatusMap" DROP COLUMN "workspaceId",
ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "KeyResult" ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'number',
ADD COLUMN     "weight" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "NotificationDigest" ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "firstQueuedAt" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "sentAt" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "NotificationMute" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "NotificationSnoozeRule" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "OutboundWebhook" DROP COLUMN "workspaceId",
ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "eventTypes" DROP DEFAULT;

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "defaultTaskVisibility" "Visibility" NOT NULL DEFAULT 'internal';

-- AlterTable
ALTER TABLE "Sprint" ADD COLUMN     "goal" TEXT;

-- AlterTable
ALTER TABLE "SprintGoalEvaluation" ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "evaluatedAt" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "SprintRetro" ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "updatedAt" DROP DEFAULT,
ALTER COLUMN "updatedAt" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "aiPriorityReason" TEXT;

-- AlterTable
ALTER TABLE "TaskTemplate" ADD COLUMN     "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "taskType" "TaskType";

-- AlterTable
ALTER TABLE "User" DROP COLUMN "mfaBackupCodes",
DROP COLUMN "mfaEnabled",
DROP COLUMN "totpSecret",
ADD COLUMN     "weeklyHoursTarget" INTEGER;

-- AlterTable
ALTER TABLE "WebhookDelivery" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "WorkspaceAiSettings" ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "updatedAt" DROP DEFAULT;

-- CreateTable
CREATE TABLE "SprintTaskMembership" (
    "id" UUID NOT NULL,
    "sprintId" UUID NOT NULL,
    "taskId" UUID NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedAt" TIMESTAMP(3),

    CONSTRAINT "SprintTaskMembership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DailyWorkloadSnapshot" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "date" DATE NOT NULL,
    "openTasksCount" INTEGER NOT NULL DEFAULT 0,
    "weightedLoad" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DailyWorkloadSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CfdSnapshot" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "date" DATE NOT NULL,
    "bucket" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CfdSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SprintTaskMembership_sprintId_addedAt_idx" ON "SprintTaskMembership"("sprintId", "addedAt");

-- CreateIndex
CREATE INDEX "SprintTaskMembership_taskId_addedAt_idx" ON "SprintTaskMembership"("taskId", "addedAt");

-- CreateIndex
CREATE INDEX "DailyWorkloadSnapshot_date_idx" ON "DailyWorkloadSnapshot"("date");

-- CreateIndex
CREATE UNIQUE INDEX "DailyWorkloadSnapshot_userId_date_key" ON "DailyWorkloadSnapshot"("userId", "date");

-- CreateIndex
CREATE INDEX "CfdSnapshot_projectId_date_idx" ON "CfdSnapshot"("projectId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "CfdSnapshot_projectId_date_bucket_key" ON "CfdSnapshot"("projectId", "date", "bucket");

-- CreateIndex
CREATE INDEX "AiUsageEvent_createdAt_idx" ON "AiUsageEvent"("createdAt");

-- CreateIndex
CREATE INDEX "ExportSchedule_enabled_idx" ON "ExportSchedule"("enabled");

-- CreateIndex
CREATE INDEX "ExportSchedule_sourceKind_idx" ON "ExportSchedule"("sourceKind");

-- CreateIndex
CREATE INDEX "Goal_parentGoalId_idx" ON "Goal"("parentGoalId");

-- CreateIndex
CREATE UNIQUE INDEX "JiraStatusMap_jiraStatus_key" ON "JiraStatusMap"("jiraStatus");

-- CreateIndex
CREATE INDEX "OutboundWebhook_enabled_idx" ON "OutboundWebhook"("enabled");

-- CreateIndex
CREATE INDEX "TaskTemplate_tags_idx" ON "TaskTemplate"("tags");

-- AddForeignKey
ALTER TABLE "SprintTaskMembership" ADD CONSTRAINT "SprintTaskMembership_sprintId_fkey" FOREIGN KEY ("sprintId") REFERENCES "Sprint"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SprintTaskMembership" ADD CONSTRAINT "SprintTaskMembership_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Goal" ADD CONSTRAINT "Goal_parentGoalId_fkey" FOREIGN KEY ("parentGoalId") REFERENCES "Goal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_quotedCommentId_fkey" FOREIGN KEY ("quotedCommentId") REFERENCES "Comment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommentReaction" ADD CONSTRAINT "CommentReaction_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "Comment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommentReaction" ADD CONSTRAINT "CommentReaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommentRevision" ADD CONSTRAINT "CommentRevision_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "Comment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommentRevision" ADD CONSTRAINT "CommentRevision_editedById_fkey" FOREIGN KEY ("editedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailyWorkloadSnapshot" ADD CONSTRAINT "DailyWorkloadSnapshot_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CfdSnapshot" ADD CONSTRAINT "CfdSnapshot_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JiraStatusMap" ADD CONSTRAINT "JiraStatusMap_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboundWebhook" ADD CONSTRAINT "OutboundWebhook_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_webhookId_fkey" FOREIGN KEY ("webhookId") REFERENCES "OutboundWebhook"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExportSchedule" ADD CONSTRAINT "ExportSchedule_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExportRun" ADD CONSTRAINT "ExportRun_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "ExportSchedule"("id") ON DELETE SET NULL ON UPDATE CASCADE;



-- =============================================================================
-- SprintTaskMembership backfill — moved out of companion.sql so it runs once
-- against pre-existing Task rows that have a sprintId but no membership row.
-- Idempotent: ON CONFLICT DO NOTHING and a NOT EXISTS guard ensure a re-run
-- is a no-op. On a fresh DB Task is empty, so this is a no-op too.
-- =============================================================================

INSERT INTO "SprintTaskMembership" ("id", "sprintId", "taskId", "addedAt", "removedAt")
SELECT
  gen_random_uuid(),
  t."sprintId",
  t."id",
  t."createdAt",
  NULL
FROM "Task" t
WHERE t."sprintId" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "SprintTaskMembership" m
    WHERE m."sprintId" = t."sprintId" AND m."taskId" = t."id"
  )
ON CONFLICT DO NOTHING;
