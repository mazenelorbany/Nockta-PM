-- Import Center: persist every run (source, counts, status) so the UI's
-- "recent runs" table is hydrated from a single source of truth and the
-- re-run affordance has a mapping snapshot to replay.

CREATE TABLE "ImportRun" (
    "id"             UUID NOT NULL DEFAULT gen_random_uuid(),
    "source"         TEXT NOT NULL,
    "actorUserId"    UUID NOT NULL,
    "projectId"      UUID,
    "sourceRef"      TEXT,
    "status"         TEXT NOT NULL,
    "totalRows"      INTEGER NOT NULL DEFAULT 0,
    "createdRows"    INTEGER NOT NULL DEFAULT 0,
    "skippedRows"    INTEGER NOT NULL DEFAULT 0,
    "erroredRows"    INTEGER NOT NULL DEFAULT 0,
    "errorSummary"   TEXT,
    "mappingSnapshot" JSONB,
    "startedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt"     TIMESTAMP(3),

    CONSTRAINT "ImportRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ImportRun_startedAt_idx" ON "ImportRun"("startedAt");
CREATE INDEX "ImportRun_actorUserId_startedAt_idx" ON "ImportRun"("actorUserId", "startedAt");
CREATE INDEX "ImportRun_source_idx" ON "ImportRun"("source");

ALTER TABLE "ImportRun"
  ADD CONSTRAINT "ImportRun_actorUserId_fkey"
  FOREIGN KEY ("actorUserId") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ImportRun"
  ADD CONSTRAINT "ImportRun_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
