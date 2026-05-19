import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { Visibility } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { PermissionsService } from '../permissions/permissions.service';
import type { AuthenticatedUser } from '../auth/types';

const EDIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

/**
 * The fixed set of emoji a reaction may carry. The schema stores `emoji` as a
 * free-form string so we can grow this list without a migration, but the
 * service rejects anything not on the list. See spec — comments §7-9.
 */
export const ALLOWED_REACTION_EMOJIS = [
  'thumbsup',
  'thumbsdown',
  'heart',
  'laugh',
  'celebrate',
  'eyes',
] as const;
export type ReactionEmoji = (typeof ALLOWED_REACTION_EMOJIS)[number];

function isAllowedEmoji(value: string): value is ReactionEmoji {
  return (ALLOWED_REACTION_EMOJIS as readonly string[]).includes(value);
}

const MENTION_USER_REGEX  = /@\[([0-9a-f-]{36})\]\((user)\)/g;
const MENTION_TEAM_REGEX  = /@\[([0-9a-f-]{36})\]\((team)\)/g;

// Pass I (Comments 8→9). `@here` is a literal marker the composer inserts
// when the user picks "here" from the @mention typeahead. The comments
// service expands it to a notification fan-out targeting every watcher of
// the current task (NOT every project member — @here = "everyone watching
// this thread"). The marker stays in bodyMd verbatim so the renderer can
// style it as a pill; the watcher list is computed at create-time and
// stamped onto the emitted event so the dispatcher's RecipientResolverService
// can read it without re-querying.
//
// Word boundary on both sides keeps "@hereafter" from triggering. We do NOT
// require @here to be the first token of the comment — common patterns like
// "@here heads up, …" should fire.
const HERE_MARKER_REGEX = /(^|\s)@here(?=\s|$|[.,!?;:])/;

// Inline image marker emitted by the editor on paste/drop (spec §11/§12).
// Server validates each referenced attachment belongs to the same task and
// matches the comment's visibility, then rewrites the marker to a relative
// API URL the renderer can resolve into a signed-GET on display.
const INLINE_ATTACHMENT_REGEX = /attachment:([0-9a-f-]{36})/g;

interface ParsedMentions {
  userIds: string[];
  teamIds: string[];
  hasHere: boolean;
}

function parseMentions(body: string): ParsedMentions {
  const userIds = Array.from(body.matchAll(MENTION_USER_REGEX), (m) => m[1]!);
  const teamIds = Array.from(body.matchAll(MENTION_TEAM_REGEX), (m) => m[1]!);
  return {
    userIds: Array.from(new Set(userIds)),
    teamIds: Array.from(new Set(teamIds)),
    hasHere: HERE_MARKER_REGEX.test(body),
  };
}

function parseAttachmentRefs(body: string): string[] {
  return Array.from(
    new Set(Array.from(body.matchAll(INLINE_ATTACHMENT_REGEX), (m) => m[1]!)),
  );
}

@Injectable()
export class CommentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionsService,
    private readonly events: EventEmitter2,
  ) {}

  /**
   * Validate every `attachment:<uuid>` reference in the comment body and
   * rewrite to a stable relative URL the markdown renderer can swap for a
   * signed-GET at display time. Throws if the comment references an
   * attachment that doesn't belong to its task or that the comment's
   * visibility isn't allowed to see.
   */
  private async validateAndRewriteInlineAttachments(
    body: string,
    taskId: string,
    commentVisibility: Visibility,
  ): Promise<string> {
    const ids = parseAttachmentRefs(body);
    if (ids.length === 0) return body;

    const atts = await this.prisma.attachment.findMany({
      where: { id: { in: ids }, deletedAt: null },
      select: { id: true, parentType: true, parentId: true, visibility: true },
    });
    const byId = new Map(atts.map((a) => [a.id, a]));

    for (const id of ids) {
      const att = byId.get(id);
      if (!att) {
        throw new BadRequestException(`Unknown attachment ${id}`);
      }
      const boundToTask =
        (att.parentType === 'Task' || att.parentType === 'BugReport') && att.parentId === taskId;
      if (!boundToTask) {
        // Comments can only embed attachments uploaded to their own task —
        // prevents leaking files across projects via a forged reference.
        throw new BadRequestException(`Attachment ${id} does not belong to this task`);
      }
      if (commentVisibility === 'client_visible' && att.visibility !== 'client_visible') {
        throw new BadRequestException(
          `Attachment ${id} is internal — cannot embed in a client-visible comment`,
        );
      }
    }

    // Rewrite `attachment:<id>` → `/api/v1/attachments/<id>/inline`. The
    // renderer resolves this against the API base; the inline endpoint redirects
    // to a fresh signed-GET URL on every request, so links never go stale.
    return body.replace(INLINE_ATTACHMENT_REGEX, (_m, id: string) =>
      `/api/v1/attachments/${id}/inline`,
    );
  }

  async create(
    actor: AuthenticatedUser,
    taskId: string,
    body: string,
    visibility?: Visibility,
    parentCommentId?: string,
    quoted?: { commentId: string; rangeStart: number; rangeEnd: number },
  ) {
    const task = await this.prisma.task.findUniqueOrThrow({
      where: { id: taskId },
      select: { id: true, projectId: true, visibility: true },
    });
    if (!(await this.permissions.canSeeTask(actor, task.projectId, task.visibility))) {
      throw new ForbiddenException('No access to task');
    }
    if (actor.kind === 'client') {
      // Clients can only see/comment on client-visible tasks; their comments are always client-visible.
      if (task.visibility !== 'client_visible') {
        throw new ForbiddenException('Clients cannot comment on internal tasks');
      }
    }

    const effectiveVisibility: Visibility =
      actor.kind === 'client'
        ? 'client_visible'
        : task.visibility === 'internal'
        ? 'internal'
        : visibility ?? 'internal'; // on a client-visible task, default-secure to internal unless toggled

    // Replies must point at a comment on the same task. We also flatten any
    // attempt to reply-to-a-reply: the resolved parent always points at a
    // top-level comment.
    let resolvedParentId: string | undefined;
    if (parentCommentId) {
      const parent = await this.prisma.comment.findUnique({
        where: { id: parentCommentId },
        select: { id: true, taskId: true, parentCommentId: true, visibility: true },
      });
      if (!parent || parent.taskId !== taskId) {
        // Silently drop a bad parent reference rather than failing the create —
        // a stale parent ID from an old client shouldn't block a comment.
        resolvedParentId = undefined;
      } else {
        // Flatten: replies to replies attach to the original top-level comment.
        resolvedParentId = parent.parentCommentId ?? parent.id;
      }
    }

    // Selection-threading: if the caller is quoting a range out of another
    // comment, verify (1) the quoted comment exists, (2) it lives on the same
    // task (no cross-task quoting), and (3) the [start, end) range is in
    // bounds against its bodyMd. Out-of-bounds is a 400 — it almost always
    // means a stale rangeEnd against a body that was edited shorter.
    let quotedFields:
      | { quotedCommentId: string; quotedRangeStart: number; quotedRangeEnd: number }
      | undefined;
    if (quoted) {
      const { commentId: qId, rangeStart, rangeEnd } = quoted;
      if (
        !Number.isInteger(rangeStart) ||
        !Number.isInteger(rangeEnd) ||
        rangeStart < 0 ||
        rangeEnd <= rangeStart
      ) {
        throw new BadRequestException('Invalid quoted range');
      }
      const quotedSource = await this.prisma.comment.findUnique({
        where: { id: qId },
        select: { id: true, taskId: true, bodyMd: true, deletedAt: true },
      });
      if (!quotedSource || quotedSource.deletedAt) {
        throw new BadRequestException('Quoted comment not found');
      }
      if (quotedSource.taskId !== taskId) {
        throw new BadRequestException('Quoted comment is on a different task');
      }
      if (rangeEnd > quotedSource.bodyMd.length) {
        throw new BadRequestException('Quoted range out of bounds');
      }
      quotedFields = {
        quotedCommentId: qId,
        quotedRangeStart: rangeStart,
        quotedRangeEnd: rangeEnd,
      };
    }

    const mentions = parseMentions(body);
    const rewrittenBody = await this.validateAndRewriteInlineAttachments(
      body, taskId, effectiveVisibility,
    );

    // Pass I (Comments 8→9). When the comment contains `@here`, expand it
    // to every watcher of this task. We compute the list NOW (so the event
    // payload carries it inline) rather than letting the recipient resolver
    // re-derive — keeping the work in one query saves a DB round-trip in the
    // dispatcher and means the watcher set is stable across an async retry.
    let hereWatcherIds: string[] = [];
    if (mentions.hasHere) {
      const watchers = await this.prisma.taskWatcher.findMany({
        where: { taskId },
        select: { userId: true },
      });
      hereWatcherIds = watchers
        .map((w) => w.userId)
        .filter((uid) => uid !== actor.id); // never self-notify
    }

    const editLockedAt = new Date(Date.now() + EDIT_WINDOW_MS);
    const comment = await this.prisma.comment.create({
      data: {
        taskId,
        authorUserId: actor.id,
        bodyMd: rewrittenBody,
        visibility: effectiveVisibility,
        editLockedAt,
        ...(resolvedParentId ? { parentCommentId: resolvedParentId } : {}),
        ...(quotedFields ?? {}),
        mentions: {
          createMany: {
            data: [
              ...mentions.userIds.map((userId) => ({ userId })),
              ...mentions.teamIds.map((teamId) => ({ teamId })),
            ],
          },
        },
      },
      include: { mentions: true, author: { select: { id: true, name: true, avatarUrl: true } } },
    });
    this.events.emit('comment.added', {
      commentId: comment.id, taskId, authorUserId: actor.id,
      visibility: effectiveVisibility,
      // Pass I — fold @here watchers into the mentions.userIds set the
      // dispatcher already consumes. The reason discriminator in the
      // resolver picks "mentioned" for these recipients, which the
      // dispatcher already maps to the MentionedInComment type. That means
      // @here notifications flow through the SAME mute/DND pipeline as
      // direct @user mentions — exactly the "respect mute/DND" requirement
      // in the spec.
      mentions: {
        userIds: Array.from(new Set([...mentions.userIds, ...hereWatcherIds])),
        teamIds: mentions.teamIds,
        hereCount: hereWatcherIds.length,
      },
    });
    return comment;
  }

  async update(actor: AuthenticatedUser, id: string, body: string) {
    // We need the existing bodyMd so we can snapshot it into CommentRevision
    // BEFORE writing the new body — that table stores what the comment USED
    // to say (the head version lives on Comment.bodyMd). Selecting it here
    // costs nothing the previous read didn't already need; we just widen the
    // projection.
    const comment = await this.prisma.comment.findUniqueOrThrow({
      where: { id },
      select: {
        id: true,
        authorUserId: true,
        editLockedAt: true,
        taskId: true,
        deletedAt: true,
        visibility: true,
        bodyMd: true,
      },
    });
    if (comment.deletedAt) throw new BadRequestException('Comment deleted');
    if (comment.authorUserId !== actor.id) throw new ForbiddenException('Only the author can edit');
    if (comment.editLockedAt && comment.editLockedAt.getTime() < Date.now()) {
      throw new ForbiddenException('Edit window has expired');
    }
    const mentions = parseMentions(body);
    const rewrittenBody = await this.validateAndRewriteInlineAttachments(
      body, comment.taskId, comment.visibility,
    );
    const updated = await this.prisma.$transaction(async (tx) => {
      // Snapshot the PRIOR body into CommentRevision before we overwrite it.
      // This runs in the same tx so an `update` failure rolls back the
      // revision row too — no orphaned "edited from X to (nothing)" trails.
      await tx.commentRevision.create({
        data: {
          commentId: id,
          bodyMd: comment.bodyMd,
          editedById: actor.id,
        },
      });
      await tx.commentMention.deleteMany({ where: { commentId: id } });
      return tx.comment.update({
        where: { id },
        data: {
          bodyMd: rewrittenBody,
          mentions: {
            createMany: {
              data: [
                ...mentions.userIds.map((userId) => ({ userId })),
                ...mentions.teamIds.map((teamId) => ({ teamId })),
              ],
            },
          },
        },
        include: { mentions: true },
      });
    });
    this.events.emit('comment.edited', { commentId: id, taskId: comment.taskId, actorUserId: actor.id });
    return updated;
  }

  async delete(actor: AuthenticatedUser, id: string) {
    const comment = await this.prisma.comment.findUniqueOrThrow({
      where: { id },
      include: { task: { select: { projectId: true } } },
    });
    const role = await this.permissions.effectiveRole(actor, comment.task.projectId);
    const isAuthorWithinWindow =
      comment.authorUserId === actor.id &&
      comment.editLockedAt !== null &&
      comment.editLockedAt.getTime() >= Date.now();
    const isAdminOrManager =
      (actor.kind === 'internal' && actor.companyRole === 'Admin') || role === 'Manager';
    if (!isAuthorWithinWindow && !isAdminOrManager) {
      throw new ForbiddenException('Cannot delete this comment');
    }
    // Idempotent soft-delete. Using updateMany with a `deletedAt: null`
    // guard means a concurrent second delete is a no-op instead of a
    // P2025 "record not found" — the comment is already gone, that's
    // the desired end state. count===0 here also catches the case where
    // a concurrent edit already deleted it, which the activity timeline
    // should still emit once (not twice) so we skip the event then.
    const res = await this.prisma.comment.updateMany({
      where: { id, deletedAt: null },
      data: { deletedAt: new Date(), deletedById: actor.id },
    });
    if (res.count > 0) {
      this.events.emit('comment.deleted', { commentId: id, actorUserId: actor.id });
    }
  }

  async listByTask(actor: AuthenticatedUser, taskId: string) {
    const task = await this.prisma.task.findUniqueOrThrow({
      where: { id: taskId },
      select: { projectId: true, visibility: true },
    });
    const role = await this.permissions.effectiveRole(actor, task.projectId);
    if (role === null) throw new ForbiddenException('No access');
    const where = {
      taskId,
      deletedAt: null,
      ...(role === 'Client' ? { visibility: 'client_visible' as const } : {}),
    };
    const comments = await this.prisma.comment.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      include: {
        author: { select: { id: true, name: true, avatarUrl: true } },
        mentions: true,
        reactions: { select: { userId: true, emoji: true } },
        revisions: { select: { id: true }, orderBy: { editedAt: 'asc' } },
        // Selection-threading: pull just enough of the quoted source to render
        // the inline blockquote — author for attribution, body slice for the
        // excerpt. `null` quotedCommentId leaves this field null.
        quotedComment: {
          select: {
            id: true,
            bodyMd: true,
            authorUserId: true,
            deletedAt: true,
            author: { select: { id: true, name: true, avatarUrl: true } },
          },
        },
      },
    });

    // Group reactions by emoji for each comment so the UI doesn't have to do
    // it on every render. `youReacted` flags whether the current actor's
    // reaction is in the bucket — drives the "your" highlight on the chip.
    return comments.map((c) => {
      const buckets = new Map<string, { count: number; youReacted: boolean }>();
      for (const r of c.reactions) {
        const cur = buckets.get(r.emoji) ?? { count: 0, youReacted: false };
        cur.count += 1;
        if (r.userId === actor.id) cur.youReacted = true;
        buckets.set(r.emoji, cur);
      }
      const reactionsGrouped = Array.from(buckets.entries()).map(([emoji, v]) => ({
        emoji,
        count: v.count,
        youReacted: v.youReacted,
      }));
      // Resolve the quoted snippet — slice the source body using the persisted
      // range so we don't trust the client to recompute it. If the source was
      // soft-deleted, return a placeholder marker the renderer turns into
      // "[deleted comment]" rather than leaking the prior body.
      let quotedSnippet:
        | { commentId: string; author: { id: string; name: string; avatarUrl: string | null } | null; excerpt: string; deleted: boolean }
        | null = null;
      if (c.quotedComment && c.quotedRangeStart !== null && c.quotedRangeEnd !== null) {
        const src = c.quotedComment;
        if (src.deletedAt) {
          quotedSnippet = {
            commentId: src.id,
            author: src.author ?? null,
            excerpt: '',
            deleted: true,
          };
        } else {
          // Clamp defensively — schema can't enforce range ≤ body length once
          // the source is edited shorter post-quote.
          const start = Math.max(0, Math.min(c.quotedRangeStart, src.bodyMd.length));
          const end = Math.max(start, Math.min(c.quotedRangeEnd, src.bodyMd.length));
          quotedSnippet = {
            commentId: src.id,
            author: src.author ?? null,
            excerpt: src.bodyMd.slice(start, end),
            deleted: false,
          };
        }
      }
      const editedCount = c.revisions.length;
      // Drop the raw reactions/revisions arrays from the response — we replace
      // them with their grouped/count shapes.
      const { reactions: _r, revisions: _rv, quotedComment: _q, ...rest } = c;
      return {
        ...rest,
        reactions: reactionsGrouped,
        editedCount,
        quotedSnippet,
      };
    });
  }

  /**
   * Toggle an emoji reaction onto a comment. Idempotent under the
   * (commentId, userId, emoji) unique key — replaying the same call leaves
   * exactly one row. The actor must be able to see the underlying task
   * (else 403). Returns the canonical reaction row.
   */
  async addReaction(actor: AuthenticatedUser, commentId: string, emoji: string) {
    if (!isAllowedEmoji(emoji)) {
      throw new BadRequestException(`Emoji "${emoji}" is not in the allowed set`);
    }
    const comment = await this.prisma.comment.findUnique({
      where: { id: commentId },
      select: { id: true, taskId: true, deletedAt: true, task: { select: { projectId: true, visibility: true } } },
    });
    if (!comment || comment.deletedAt) throw new NotFoundException('Comment not found');
    if (!(await this.permissions.canSeeTask(actor, comment.task.projectId, comment.task.visibility))) {
      throw new ForbiddenException('No access to comment');
    }
    // Upsert via the composite unique. `update` is a no-op (we re-set the
    // same emoji) but it lets prisma resolve the row without a follow-up read.
    const reaction = await this.prisma.commentReaction.upsert({
      where: { commentId_userId_emoji: { commentId, userId: actor.id, emoji } },
      create: { commentId, userId: actor.id, emoji },
      update: {},
    });
    this.events.emit('comment.reaction_added', {
      commentId,
      taskId: comment.taskId,
      actorUserId: actor.id,
      emoji,
    });
    return reaction;
  }

  /**
   * Remove the actor's reaction. Returns silently if there was nothing to
   * remove — toggling off a reaction the user never added isn't an error.
   */
  async removeReaction(actor: AuthenticatedUser, commentId: string, emoji: string) {
    if (!isAllowedEmoji(emoji)) {
      throw new BadRequestException(`Emoji "${emoji}" is not in the allowed set`);
    }
    const comment = await this.prisma.comment.findUnique({
      where: { id: commentId },
      select: { id: true, taskId: true, task: { select: { projectId: true, visibility: true } } },
    });
    if (!comment) throw new NotFoundException('Comment not found');
    if (!(await this.permissions.canSeeTask(actor, comment.task.projectId, comment.task.visibility))) {
      throw new ForbiddenException('No access to comment');
    }
    await this.prisma.commentReaction.deleteMany({
      where: { commentId, userId: actor.id, emoji },
    });
    this.events.emit('comment.reaction_removed', {
      commentId,
      taskId: comment.taskId,
      actorUserId: actor.id,
      emoji,
    });
    return { ok: true };
  }

  /**
   * Read the ordered revision trail of a comment. Readable by the comment's
   * author, by Admins, and by project Managers — same audience as
   * delete() (they're the people who can rewrite history, so they're the
   * people who can audit it).
   */
  async listRevisions(actor: AuthenticatedUser, commentId: string) {
    const comment = await this.prisma.comment.findUnique({
      where: { id: commentId },
      select: {
        id: true,
        authorUserId: true,
        task: { select: { projectId: true, visibility: true } },
      },
    });
    if (!comment) throw new NotFoundException('Comment not found');
    if (!(await this.permissions.canSeeTask(actor, comment.task.projectId, comment.task.visibility))) {
      throw new ForbiddenException('No access to comment');
    }
    const role = await this.permissions.effectiveRole(actor, comment.task.projectId);
    const isAuthor = comment.authorUserId === actor.id;
    const isAdminOrManager =
      (actor.kind === 'internal' && actor.companyRole === 'Admin') || role === 'Manager';
    if (!isAuthor && !isAdminOrManager) {
      throw new ForbiddenException('Cannot read revision history');
    }
    return this.prisma.commentRevision.findMany({
      where: { commentId },
      orderBy: { editedAt: 'asc' },
      include: {
        editedBy: { select: { id: true, name: true, avatarUrl: true } },
      },
    });
  }

  /**
   * Recent comments across an entire project — used by the client portal's
   * "Project discussion" panel. Visibility is enforced per-row: clients see
   * client_visible only, internal users see everything. Capped at a small N
   * by default so the panel stays compact.
   */
  async listRecentForProject(
    actor: AuthenticatedUser,
    projectId: string,
    limit = 20,
  ) {
    const role = await this.permissions.effectiveRole(actor, projectId);
    if (role === null) throw new ForbiddenException('No access');
    return this.prisma.comment.findMany({
      where: {
        deletedAt: null,
        task: { projectId },
        ...(role === 'Client' ? { visibility: 'client_visible' as const } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 50),
      include: {
        author: { select: { id: true, name: true, avatarUrl: true } },
        // Task carries `keyNumber` (an int); the human-readable key is
        // composed as `${project.key}-${keyNumber}`. We pull the project's
        // prefix in the same query so the client portal doesn't have to do
        // a follow-up fetch.
        task: {
          select: {
            id: true,
            title: true,
            keyNumber: true,
            project: { select: { key: true } },
          },
        },
      },
    });
  }
}
