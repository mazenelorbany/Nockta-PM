-- =============================================================================
-- 0005_comments_reactions_revisions_selection
--
-- 1. CommentReaction — emoji reactions on a Comment. One row per
--    (commentId, userId, emoji). Allowed emoji set is enforced at the app
--    layer (see comments.service.ts ALLOWED_REACTION_EMOJIS) so we can
--    expand the list without a schema migration.
-- 2. CommentRevision — append-only edit-history rows. Each row stores what
--    the comment USED to say; the current body always lives on
--    Comment.bodyMd. The service snapshots the prior body before writing
--    the new one inside a single transaction.
-- 3. Comment.quotedCommentId / quotedRangeStart / quotedRangeEnd —
--    selection-threading. A reply that quotes a [start, end) range of
--    another comment persists the source id and char offsets so the API
--    can resolve the excerpt server-side (defeating client-side excerpt
--    forgery).
-- =============================================================================

-- ---- 1. CommentReaction ---------------------------------------------------
CREATE TABLE "CommentReaction" (
    "id"        UUID NOT NULL DEFAULT gen_random_uuid(),
    "commentId" UUID NOT NULL,
    "userId"    UUID NOT NULL,
    "emoji"     TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CommentReaction_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "CommentReaction"
    ADD CONSTRAINT "CommentReaction_commentId_fkey"
    FOREIGN KEY ("commentId") REFERENCES "Comment"("id") ON DELETE CASCADE;

ALTER TABLE "CommentReaction"
    ADD CONSTRAINT "CommentReaction_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE;

CREATE UNIQUE INDEX "CommentReaction_commentId_userId_emoji_key"
    ON "CommentReaction"("commentId", "userId", "emoji");

CREATE INDEX "CommentReaction_commentId_idx"
    ON "CommentReaction"("commentId");

-- ---- 2. CommentRevision ---------------------------------------------------
CREATE TABLE "CommentRevision" (
    "id"         UUID NOT NULL DEFAULT gen_random_uuid(),
    "commentId"  UUID NOT NULL,
    "bodyMd"     TEXT NOT NULL,
    "editedById" UUID NOT NULL,
    "editedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CommentRevision_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "CommentRevision"
    ADD CONSTRAINT "CommentRevision_commentId_fkey"
    FOREIGN KEY ("commentId") REFERENCES "Comment"("id") ON DELETE CASCADE;

ALTER TABLE "CommentRevision"
    ADD CONSTRAINT "CommentRevision_editedById_fkey"
    FOREIGN KEY ("editedById") REFERENCES "User"("id") ON DELETE RESTRICT;

CREATE INDEX "CommentRevision_commentId_editedAt_idx"
    ON "CommentRevision"("commentId", "editedAt");

-- ---- 3. Comment selection-threading columns -------------------------------
ALTER TABLE "Comment" ADD COLUMN "quotedCommentId"  UUID;
ALTER TABLE "Comment" ADD COLUMN "quotedRangeStart" INTEGER;
ALTER TABLE "Comment" ADD COLUMN "quotedRangeEnd"   INTEGER;

ALTER TABLE "Comment"
    ADD CONSTRAINT "Comment_quotedCommentId_fkey"
    FOREIGN KEY ("quotedCommentId") REFERENCES "Comment"("id") ON DELETE SET NULL;

CREATE INDEX "Comment_quotedCommentId_idx"
    ON "Comment"("quotedCommentId");
