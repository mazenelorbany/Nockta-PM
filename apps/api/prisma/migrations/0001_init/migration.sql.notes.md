# Manual migration notes — apply after `prisma migrate dev`

Several Prisma constraints can't be expressed natively and need to be
added as raw SQL in this migration (or a follow-up migration).

## 1. Partial unique index — only one active sprint per project

```sql
CREATE UNIQUE INDEX sprint_active_per_project_unique
  ON "Sprint" ("projectId")
  WHERE state = 'active';
```

## 2. ProjectAccess — at most one subject populated

ProjectAccess has nullable `userId` and `teamId` columns scoped by `subjectKind`.
We enforce that exactly one is populated and it matches `subjectKind`:

```sql
ALTER TABLE "ProjectAccess"
  ADD CONSTRAINT project_access_subject_consistent
  CHECK (
    (subject_kind = 'user' AND user_id IS NOT NULL AND team_id IS NULL)
    OR
    (subject_kind = 'team' AND team_id IS NOT NULL AND user_id IS NULL)
  );
```

## 3. CommentMention — exactly one of user_id / team_id populated

```sql
ALTER TABLE "CommentMention"
  ADD CONSTRAINT comment_mention_one_target
  CHECK (
    (user_id IS NOT NULL AND team_id IS NULL)
    OR
    (user_id IS NULL AND team_id IS NOT NULL)
  );
```

## 4. Event table — convert to partitioned

Prisma manages `Event` as a regular table; convert it to monthly RANGE
partitioning before any production data lands.

```sql
-- Drop and recreate as partitioned. Run BEFORE any rows exist.
DROP TABLE "Event" CASCADE;

CREATE TABLE "Event" (
  "id"          UUID NOT NULL DEFAULT gen_random_uuid(),
  "type"        TEXT NOT NULL,
  "actorUserId" UUID,
  "entityType"  TEXT NOT NULL,
  "entityId"    UUID NOT NULL,
  "projectId"   UUID,
  "payload"     JSONB NOT NULL,
  "visibility"  "EventVisibility" NOT NULL DEFAULT 'internal',
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("id", "createdAt")
) PARTITION BY RANGE ("createdAt");

CREATE INDEX "Event_projectId_createdAt_desc_idx"
  ON "Event" ("projectId", "createdAt" DESC);
CREATE INDEX "Event_entity_idx"
  ON "Event" ("entityType", "entityId", "createdAt" DESC);
CREATE INDEX "Event_actor_idx"
  ON "Event" ("actorUserId", "createdAt" DESC);
CREATE INDEX "Event_type_idx"
  ON "Event" ("type", "createdAt");

-- Initial partitions — schedule a monthly job to add the next partition.
CREATE TABLE "Event_2026_05" PARTITION OF "Event"
  FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
CREATE TABLE "Event_2026_06" PARTITION OF "Event"
  FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
-- (Add more as needed — `apps/workers` runs a monthly cron that creates
-- the next partition automatically.)
```

## 5. Task FTS — generated tsvector column + GIN index

```sql
ALTER TABLE "Task"
  ADD COLUMN "search_vector" tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(description, '')), 'B')
  ) STORED;

CREATE INDEX "Task_search_vector_idx" ON "Task" USING GIN ("search_vector");
```

## 6. Comment FTS

```sql
ALTER TABLE "Comment"
  ADD COLUMN "search_vector" tsvector
  GENERATED ALWAYS AS (to_tsvector('english', coalesce("bodyMd", ''))) STORED;

CREATE INDEX "Comment_search_vector_idx" ON "Comment" USING GIN ("search_vector");
```

## 7. Project key validation

```sql
ALTER TABLE "Project"
  ADD CONSTRAINT project_key_format
  CHECK ("key" ~ '^[A-Z]{2,10}$');
```
