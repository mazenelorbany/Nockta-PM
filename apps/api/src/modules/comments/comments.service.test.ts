import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeEventsMock, makePrismaMock } from '../../test-utils/mocks';
import type { PrismaService } from '../../prisma/prisma.service';
import type { PermissionsService } from '../permissions/permissions.service';
import type { AuthenticatedUser } from '../auth/types';

import { CommentsService } from './comments.service';

// =============================================================================
// comments.service — covers the user-facing behaviors that diverge from CRUD:
//
//   - Mention parsing (regex extracts user + team ids; de-dupes).
//   - Inline-attachment validation (must belong to same task; client-visible
//     comments can't embed internal attachments).
//   - Comment URL rewrite (attachment:<id> → /api/v1/attachments/<id>/inline).
//   - 15-minute edit window enforcement.
//   - Reply flattening (reply-to-a-reply attaches to the top-level comment).
//   - Visibility coercion for clients (their comments are always client_visible
//     even if visibility was passed explicitly).
//   - Soft-delete authorization (author within edit window OR Admin/Manager).
// =============================================================================

interface Mocks {
  prisma: PrismaService;
  permissions: { effectiveRole: ReturnType<typeof vi.fn>; canSeeTask: ReturnType<typeof vi.fn> };
  events: ReturnType<typeof makeEventsMock>;
}

function build(): { service: CommentsService; mocks: Mocks } {
  const prisma = makePrismaMock();
  const permissions = {
    effectiveRole: vi.fn(),
    canSeeTask: vi.fn(),
  };
  const events = makeEventsMock();
  const service = new CommentsService(
    prisma,
    permissions as unknown as PermissionsService,
    events.instance,
  );
  return { service, mocks: { prisma, permissions, events } };
}

function buildActor(overrides: Partial<AuthenticatedUser> = {}): AuthenticatedUser {
  return {
    id: 'actor-1',
    email: 'someone@nockta.com',
    kind: 'internal',
    companyRole: 'Member',
    ...overrides,
  } as AuthenticatedUser;
}

const VALID_UUID_A = '11111111-1111-1111-1111-111111111111';
const VALID_UUID_B = '22222222-2222-2222-2222-222222222222';
const ATTACHMENT_UUID = '33333333-3333-3333-3333-333333333333';

describe('CommentsService.create', () => {
  let mocks: Mocks;
  let service: CommentsService;

  beforeEach(() => {
    ({ service, mocks } = build());
  });

  function stubVisibleTask(visibility: 'internal' | 'client_visible' = 'internal') {
    vi.mocked(mocks.prisma.task.findUniqueOrThrow).mockResolvedValueOnce({
      id: 'task-1',
      projectId: 'p1',
      visibility,
    } as never);
    mocks.permissions.canSeeTask.mockResolvedValueOnce(true);
  }

  it('refuses when the actor cannot see the task', async () => {
    vi.mocked(mocks.prisma.task.findUniqueOrThrow).mockResolvedValueOnce({
      id: 'task-1',
      projectId: 'p1',
      visibility: 'internal',
    } as never);
    mocks.permissions.canSeeTask.mockResolvedValueOnce(false);

    await expect(
      service.create(buildActor(), 'task-1', 'hello'),
    ).rejects.toThrow(ForbiddenException);
  });

  it('refuses clients commenting on internal tasks', async () => {
    stubVisibleTask('internal');
    await expect(
      service.create(buildActor({ kind: 'client', companyRole: null }), 'task-1', 'hi'),
    ).rejects.toThrow(/internal tasks/i);
  });

  it('forces client comments to client_visible even if internal was passed', async () => {
    // The "even if internal was passed" branch is the subtle one — a forged
    // request from a guest could otherwise hide their comment from other
    // guests on the same project. Coercion happens before the DB write.
    stubVisibleTask('client_visible');
    vi.mocked(mocks.prisma.comment.create).mockResolvedValueOnce({
      id: 'c-1',
      visibility: 'client_visible',
    } as never);

    await service.create(
      buildActor({ kind: 'client', companyRole: null }),
      'task-1',
      'hello',
      'internal', // <-- attempted elevation
    );

    const args = vi.mocked(mocks.prisma.comment.create).mock.calls[0]?.[0];
    expect(args?.data?.visibility).toBe('client_visible');
  });

  it('on an internal task, comment is always internal (visibility flag ignored)', async () => {
    // Toggle-up makes no sense on a hidden task — the comment should inherit.
    stubVisibleTask('internal');
    vi.mocked(mocks.prisma.comment.create).mockResolvedValueOnce({
      id: 'c-1',
    } as never);

    await service.create(buildActor(), 'task-1', 'hi', 'client_visible');

    const args = vi.mocked(mocks.prisma.comment.create).mock.calls[0]?.[0];
    expect(args?.data?.visibility).toBe('internal');
  });

  it('parses @user and @team mentions and de-dupes', async () => {
    stubVisibleTask('internal');
    vi.mocked(mocks.prisma.comment.create).mockResolvedValueOnce({
      id: 'c-1',
    } as never);

    const body = `@[${VALID_UUID_A}](user) @[${VALID_UUID_A}](user) and @[${VALID_UUID_B}](team)`;
    await service.create(buildActor(), 'task-1', body);

    const args = vi.mocked(mocks.prisma.comment.create).mock.calls[0]?.[0];
    const mentionData = args?.data?.mentions?.createMany?.data ?? [];
    expect(mentionData).toEqual([
      { userId: VALID_UUID_A },
      { teamId: VALID_UUID_B },
    ]);
  });

  it('rejects inline attachments that belong to a different task', async () => {
    stubVisibleTask('internal');
    vi.mocked(mocks.prisma.attachment.findMany).mockResolvedValueOnce([
      {
        id: ATTACHMENT_UUID,
        parentType: 'Task',
        parentId: 'some-other-task',
        visibility: 'internal',
      },
    ] as never);

    await expect(
      service.create(buildActor(), 'task-1', `see attachment:${ATTACHMENT_UUID}`),
    ).rejects.toThrow(/does not belong to this task/i);
  });

  it('rejects an internal attachment embedded in a client-visible comment', async () => {
    // Critical: prevents an internal user from leaking internal screenshots
    // into a comment the client portal will render.
    stubVisibleTask('client_visible');
    vi.mocked(mocks.prisma.attachment.findMany).mockResolvedValueOnce([
      {
        id: ATTACHMENT_UUID,
        parentType: 'Task',
        parentId: 'task-1',
        visibility: 'internal',
      },
    ] as never);

    await expect(
      service.create(
        buildActor(),
        'task-1',
        `look at attachment:${ATTACHMENT_UUID}`,
        'client_visible',
      ),
    ).rejects.toThrow(/cannot embed in a client-visible comment/i);
  });

  it('rewrites valid attachment refs to the inline URL', async () => {
    stubVisibleTask('internal');
    vi.mocked(mocks.prisma.attachment.findMany).mockResolvedValueOnce([
      {
        id: ATTACHMENT_UUID,
        parentType: 'Task',
        parentId: 'task-1',
        visibility: 'internal',
      },
    ] as never);
    vi.mocked(mocks.prisma.comment.create).mockResolvedValueOnce({ id: 'c-1' } as never);

    await service.create(
      buildActor(),
      'task-1',
      `see attachment:${ATTACHMENT_UUID} for context`,
    );

    const args = vi.mocked(mocks.prisma.comment.create).mock.calls[0]?.[0];
    expect(args?.data?.bodyMd).toBe(
      `see /api/v1/attachments/${ATTACHMENT_UUID}/inline for context`,
    );
  });

  it('flattens reply-to-reply to the top-level parent', async () => {
    stubVisibleTask('internal');
    // The "parent" comment is itself a reply (parentCommentId set). The
    // service should resolve the grandparent (`top-level`) so threads stay
    // 2 levels deep max.
    vi.mocked(mocks.prisma.comment.findUnique).mockResolvedValueOnce({
      id: 'mid-reply',
      taskId: 'task-1',
      parentCommentId: 'top-level',
      visibility: 'internal',
    } as never);
    vi.mocked(mocks.prisma.comment.create).mockResolvedValueOnce({ id: 'new' } as never);

    await service.create(buildActor(), 'task-1', 'reply', undefined, 'mid-reply');

    const args = vi.mocked(mocks.prisma.comment.create).mock.calls[0]?.[0];
    expect(args?.data?.parentCommentId).toBe('top-level');
  });

  it('silently drops a stale parent that points at a different task', async () => {
    stubVisibleTask('internal');
    vi.mocked(mocks.prisma.comment.findUnique).mockResolvedValueOnce({
      id: 'parent-x',
      taskId: 'a-different-task', // <-- bad
      parentCommentId: null,
    } as never);
    vi.mocked(mocks.prisma.comment.create).mockResolvedValueOnce({ id: 'new' } as never);

    await service.create(buildActor(), 'task-1', 'reply', undefined, 'parent-x');

    const args = vi.mocked(mocks.prisma.comment.create).mock.calls[0]?.[0];
    expect(args?.data?.parentCommentId).toBeUndefined();
  });
});

describe('CommentsService.update — edit window', () => {
  let mocks: Mocks;
  let service: CommentsService;

  beforeEach(() => {
    ({ service, mocks } = build());
  });

  it('rejects edits from a non-author', async () => {
    vi.mocked(mocks.prisma.comment.findUniqueOrThrow).mockResolvedValueOnce({
      id: 'c-1',
      authorUserId: 'someone-else',
      editLockedAt: new Date(Date.now() + 60_000),
      taskId: 'task-1',
      deletedAt: null,
      visibility: 'internal',
    } as never);

    await expect(service.update(buildActor(), 'c-1', 'new body')).rejects.toThrow(
      /only the author/i,
    );
  });

  it('rejects edits past the 15-minute window', async () => {
    vi.mocked(mocks.prisma.comment.findUniqueOrThrow).mockResolvedValueOnce({
      id: 'c-1',
      authorUserId: 'actor-1',
      editLockedAt: new Date(Date.now() - 1), // expired 1ms ago
      taskId: 'task-1',
      deletedAt: null,
      visibility: 'internal',
    } as never);

    await expect(service.update(buildActor(), 'c-1', 'new body')).rejects.toThrow(
      /edit window/i,
    );
  });

  it('rejects edits on a deleted comment', async () => {
    vi.mocked(mocks.prisma.comment.findUniqueOrThrow).mockResolvedValueOnce({
      id: 'c-1',
      authorUserId: 'actor-1',
      editLockedAt: new Date(Date.now() + 60_000),
      taskId: 'task-1',
      deletedAt: new Date(),
      visibility: 'internal',
    } as never);

    await expect(service.update(buildActor(), 'c-1', 'edit')).rejects.toThrow(
      BadRequestException,
    );
  });
});

describe('CommentsService.delete — authorization', () => {
  let mocks: Mocks;
  let service: CommentsService;

  beforeEach(() => {
    ({ service, mocks } = build());
  });

  it('allows author to delete within edit window', async () => {
    vi.mocked(mocks.prisma.comment.findUniqueOrThrow).mockResolvedValueOnce({
      id: 'c-1',
      authorUserId: 'actor-1',
      editLockedAt: new Date(Date.now() + 60_000),
      task: { projectId: 'p1' },
    } as never);
    mocks.permissions.effectiveRole.mockResolvedValueOnce('Contributor');
    vi.mocked(mocks.prisma.comment.update).mockResolvedValueOnce({} as never);

    await service.delete(buildActor(), 'c-1');

    expect(mocks.prisma.comment.update).toHaveBeenCalledOnce();
  });

  it('rejects author after edit window closes', async () => {
    vi.mocked(mocks.prisma.comment.findUniqueOrThrow).mockResolvedValueOnce({
      id: 'c-1',
      authorUserId: 'actor-1',
      editLockedAt: new Date(Date.now() - 1),
      task: { projectId: 'p1' },
    } as never);
    mocks.permissions.effectiveRole.mockResolvedValueOnce('Contributor');

    await expect(service.delete(buildActor(), 'c-1')).rejects.toThrow(ForbiddenException);
  });

  it('allows Admin to delete any comment regardless of window', async () => {
    vi.mocked(mocks.prisma.comment.findUniqueOrThrow).mockResolvedValueOnce({
      id: 'c-1',
      authorUserId: 'someone-else',
      editLockedAt: new Date(Date.now() - 365 * 24 * 3600 * 1000), // a year ago
      task: { projectId: 'p1' },
    } as never);
    mocks.permissions.effectiveRole.mockResolvedValueOnce('Viewer');
    vi.mocked(mocks.prisma.comment.update).mockResolvedValueOnce({} as never);

    await service.delete(buildActor({ companyRole: 'Admin' }), 'c-1');

    expect(mocks.prisma.comment.update).toHaveBeenCalledOnce();
  });

  it('allows project Manager to delete any comment', async () => {
    vi.mocked(mocks.prisma.comment.findUniqueOrThrow).mockResolvedValueOnce({
      id: 'c-1',
      authorUserId: 'someone-else',
      editLockedAt: null,
      task: { projectId: 'p1' },
    } as never);
    mocks.permissions.effectiveRole.mockResolvedValueOnce('Manager');
    vi.mocked(mocks.prisma.comment.update).mockResolvedValueOnce({} as never);

    await service.delete(buildActor(), 'c-1');

    expect(mocks.prisma.comment.update).toHaveBeenCalledOnce();
  });
});

// =============================================================================
// @here mentions (Pass I — Comments 8→9). A comment body containing the
// literal `@here` marker should fan out a "mentioned" notification to every
// watcher of the task (NOT every project member). The watcher list is
// computed at create time and stamped into the emitted `comment.added` event
// so the dispatcher's recipient resolver doesn't have to re-query.
//
// The key invariant the test pins: @here folds the watcher set INTO
// payload.mentions.userIds. This forces the dispatcher (which maps
// reason='mentioned' to MentionedInComment) to route @here recipients
// through the same mute/DND/Chat-binding pipeline as a direct @user mention —
// satisfying the spec's "must go through the same notification dispatcher
// used by mentions, so they respect mute/DND" requirement.
// =============================================================================

describe('CommentsService.create — @here expansion', () => {
  let mocks: Mocks;
  let service: CommentsService;

  beforeEach(() => {
    ({ service, mocks } = build());
  });

  function stubVisibleTask(visibility: 'internal' | 'client_visible' = 'internal') {
    vi.mocked(mocks.prisma.task.findUniqueOrThrow).mockResolvedValueOnce({
      id: 'task-1', projectId: 'p1', visibility,
    } as never);
    mocks.permissions.canSeeTask.mockResolvedValueOnce(true);
  }

  it('notifies every watcher when the body contains @here (excludes the author)', async () => {
    stubVisibleTask();
    vi.mocked(mocks.prisma.taskWatcher.findMany).mockResolvedValueOnce([
      { userId: 'actor-1' }, // author — must be filtered out
      { userId: 'w-2' },
      { userId: 'w-3' },
    ] as never);
    vi.mocked(mocks.prisma.comment.create).mockResolvedValueOnce({ id: 'c-1' } as never);

    await service.create(buildActor(), 'task-1', '@here heads up, deploy at 5pm');

    // Watcher fan-out was done.
    expect(mocks.prisma.taskWatcher.findMany).toHaveBeenCalledOnce();
    // The emitted event carries the expanded mentions set so the dispatcher
    // maps each recipient to reason='mentioned' (→ MentionedInComment),
    // routing through the same mute / DND pipeline as a direct @mention.
    const lastEmit = mocks.events.emit.mock.calls.find((c) => c[0] === 'comment.added');
    expect(lastEmit).toBeDefined();
    const payload = lastEmit?.[1] as { mentions: { userIds: string[]; hereCount: number } };
    expect(payload.mentions.userIds).toEqual(expect.arrayContaining(['w-2', 'w-3']));
    expect(payload.mentions.userIds).not.toContain('actor-1');
    expect(payload.mentions.hereCount).toBe(2);
  });

  it('does NOT query watchers when the body has no @here marker', async () => {
    stubVisibleTask();
    vi.mocked(mocks.prisma.comment.create).mockResolvedValueOnce({ id: 'c-1' } as never);

    await service.create(buildActor(), 'task-1', 'just a plain comment');

    expect(mocks.prisma.taskWatcher.findMany).not.toHaveBeenCalled();
    const payload = mocks.events.emit.mock.calls
      .find((c) => c[0] === 'comment.added')?.[1] as { mentions: { hereCount: number } };
    expect(payload.mentions.hereCount).toBe(0);
  });

  it('treats @hereafter as ordinary prose (word boundary required)', async () => {
    stubVisibleTask();
    vi.mocked(mocks.prisma.comment.create).mockResolvedValueOnce({ id: 'c-1' } as never);

    await service.create(buildActor(), 'task-1', '@hereafter we will use semver');

    expect(mocks.prisma.taskWatcher.findMany).not.toHaveBeenCalled();
  });
});

// =============================================================================
// Reactions (Batch 7→9): toggle add/remove with the 6 allowed emojis. The
// service upserts via the (commentId, userId, emoji) composite unique so
// replaying the same call is idempotent. Anything off the allowlist is a 400.
// =============================================================================

describe('CommentsService.addReaction / removeReaction', () => {
  let mocks: Mocks;
  let service: CommentsService;

  beforeEach(() => {
    ({ service, mocks } = build());
  });

  function stubVisibleComment() {
    vi.mocked(mocks.prisma.comment.findUnique).mockResolvedValueOnce({
      id: 'c-1',
      taskId: 'task-1',
      deletedAt: null,
      task: { projectId: 'p1', visibility: 'internal' },
    } as never);
    mocks.permissions.canSeeTask.mockResolvedValueOnce(true);
  }

  it('rejects an emoji that is not on the 6-allowed list', async () => {
    await expect(
      service.addReaction(buildActor(), 'c-1', 'rocket'),
    ).rejects.toThrow(BadRequestException);
    // Should never even reach the comment lookup.
    expect(mocks.prisma.comment.findUnique).not.toHaveBeenCalled();
  });

  it('upserts via the composite unique so replaying is idempotent', async () => {
    stubVisibleComment();
    vi.mocked(mocks.prisma.commentReaction.upsert).mockResolvedValueOnce({
      id: 'r-1',
      emoji: 'heart',
    } as never);

    await service.addReaction(buildActor(), 'c-1', 'heart');

    const args = vi.mocked(mocks.prisma.commentReaction.upsert).mock.calls[0]?.[0];
    expect(args?.where).toEqual({
      commentId_userId_emoji: { commentId: 'c-1', userId: 'actor-1', emoji: 'heart' },
    });
    expect(args?.create).toMatchObject({ commentId: 'c-1', userId: 'actor-1', emoji: 'heart' });
  });

  it('removeReaction deletes the actor\'s own row and is a no-op otherwise', async () => {
    stubVisibleComment();
    vi.mocked(mocks.prisma.commentReaction.deleteMany).mockResolvedValueOnce({
      count: 0, // already gone — still returns ok
    } as never);

    const res = await service.removeReaction(buildActor(), 'c-1', 'heart');
    expect(res).toEqual({ ok: true });

    const args = vi.mocked(mocks.prisma.commentReaction.deleteMany).mock.calls[0]?.[0];
    expect(args?.where).toEqual({ commentId: 'c-1', userId: 'actor-1', emoji: 'heart' });
  });

  it('refuses when the actor cannot see the underlying task', async () => {
    vi.mocked(mocks.prisma.comment.findUnique).mockResolvedValueOnce({
      id: 'c-1',
      taskId: 'task-1',
      deletedAt: null,
      task: { projectId: 'p1', visibility: 'internal' },
    } as never);
    mocks.permissions.canSeeTask.mockResolvedValueOnce(false);

    await expect(service.addReaction(buildActor(), 'c-1', 'heart')).rejects.toThrow(
      ForbiddenException,
    );
  });
});

// =============================================================================
// Revisions: every update() snapshots the PRIOR body before writing the new
// one, so two consecutive edits produce two ordered revision rows. The trail
// is append-only — the head version always lives on Comment.bodyMd.
// =============================================================================

describe('CommentsService.update — revision history', () => {
  let mocks: Mocks;
  let service: CommentsService;

  beforeEach(() => {
    ({ service, mocks } = build());
  });

  it('snapshots the prior body into CommentRevision before writing the new body', async () => {
    vi.mocked(mocks.prisma.comment.findUniqueOrThrow).mockResolvedValueOnce({
      id: 'c-1',
      authorUserId: 'actor-1',
      editLockedAt: new Date(Date.now() + 60_000),
      taskId: 'task-1',
      deletedAt: null,
      visibility: 'internal',
      bodyMd: 'original body',
    } as never);
    vi.mocked(mocks.prisma.commentRevision.create).mockResolvedValueOnce({} as never);
    vi.mocked(mocks.prisma.comment.update).mockResolvedValueOnce({ id: 'c-1' } as never);

    await service.update(buildActor(), 'c-1', 'edited body');

    expect(mocks.prisma.commentRevision.create).toHaveBeenCalledOnce();
    const revArgs = vi.mocked(mocks.prisma.commentRevision.create).mock.calls[0]?.[0];
    // Critical invariant: the revision stores the OLD body, not the new one.
    expect(revArgs?.data?.bodyMd).toBe('original body');
    expect(revArgs?.data?.commentId).toBe('c-1');
    expect(revArgs?.data?.editedById).toBe('actor-1');
  });

  it('two consecutive edits write two revisions in order', async () => {
    // First edit: original → v1
    vi.mocked(mocks.prisma.comment.findUniqueOrThrow).mockResolvedValueOnce({
      id: 'c-1',
      authorUserId: 'actor-1',
      editLockedAt: new Date(Date.now() + 60_000),
      taskId: 'task-1',
      deletedAt: null,
      visibility: 'internal',
      bodyMd: 'original',
    } as never);
    vi.mocked(mocks.prisma.commentRevision.create).mockResolvedValueOnce({} as never);
    vi.mocked(mocks.prisma.comment.update).mockResolvedValueOnce({} as never);
    await service.update(buildActor(), 'c-1', 'v1');

    // Second edit: v1 → v2. The read in the second call now sees 'v1'.
    vi.mocked(mocks.prisma.comment.findUniqueOrThrow).mockResolvedValueOnce({
      id: 'c-1',
      authorUserId: 'actor-1',
      editLockedAt: new Date(Date.now() + 60_000),
      taskId: 'task-1',
      deletedAt: null,
      visibility: 'internal',
      bodyMd: 'v1',
    } as never);
    vi.mocked(mocks.prisma.commentRevision.create).mockResolvedValueOnce({} as never);
    vi.mocked(mocks.prisma.comment.update).mockResolvedValueOnce({} as never);
    await service.update(buildActor(), 'c-1', 'v2');

    const calls = vi.mocked(mocks.prisma.commentRevision.create).mock.calls;
    expect(calls).toHaveLength(2);
    // First snapshot captured 'original'; second captured 'v1'. The head
    // body 'v2' is never written to revisions — that's the live row.
    expect(calls[0]?.[0]?.data?.bodyMd).toBe('original');
    expect(calls[1]?.[0]?.data?.bodyMd).toBe('v1');
  });
});

// =============================================================================
// Selection threading: a reply can quote a [start, end) range of another
// comment. Range must be in bounds against the source's body length.
// =============================================================================

describe('CommentsService.create — quoted-selection threading', () => {
  let mocks: Mocks;
  let service: CommentsService;

  beforeEach(() => {
    ({ service, mocks } = build());
  });

  function stubVisibleTask() {
    vi.mocked(mocks.prisma.task.findUniqueOrThrow).mockResolvedValueOnce({
      id: 'task-1',
      projectId: 'p1',
      visibility: 'internal',
    } as never);
    mocks.permissions.canSeeTask.mockResolvedValueOnce(true);
  }

  it('rejects a quoted range that exceeds the source body length', async () => {
    stubVisibleTask();
    vi.mocked(mocks.prisma.comment.findUnique).mockResolvedValueOnce({
      id: 'src-1',
      taskId: 'task-1',
      bodyMd: 'short body',
      deletedAt: null,
    } as never);

    await expect(
      service.create(
        buildActor(),
        'task-1',
        'reply',
        undefined,
        undefined,
        { commentId: 'src-1', rangeStart: 0, rangeEnd: 9999 },
      ),
    ).rejects.toThrow(/out of bounds/i);

    // The new comment was NOT created — the validation comes before the write.
    expect(mocks.prisma.comment.create).not.toHaveBeenCalled();
  });

  it('rejects an inverted range (end <= start)', async () => {
    stubVisibleTask();
    await expect(
      service.create(
        buildActor(),
        'task-1',
        'reply',
        undefined,
        undefined,
        { commentId: 'src-1', rangeStart: 10, rangeEnd: 10 },
      ),
    ).rejects.toThrow(/invalid quoted range/i);
  });

  it('writes the quoted fields when the range is valid', async () => {
    stubVisibleTask();
    vi.mocked(mocks.prisma.comment.findUnique).mockResolvedValueOnce({
      id: 'src-1',
      taskId: 'task-1',
      bodyMd: 'the quick brown fox jumps over the lazy dog',
      deletedAt: null,
    } as never);
    vi.mocked(mocks.prisma.comment.create).mockResolvedValueOnce({ id: 'c-new' } as never);

    await service.create(
      buildActor(),
      'task-1',
      'reply with quote',
      undefined,
      undefined,
      { commentId: 'src-1', rangeStart: 4, rangeEnd: 19 },
    );

    const args = vi.mocked(mocks.prisma.comment.create).mock.calls[0]?.[0];
    expect(args?.data?.quotedCommentId).toBe('src-1');
    expect(args?.data?.quotedRangeStart).toBe(4);
    expect(args?.data?.quotedRangeEnd).toBe(19);
  });
});
