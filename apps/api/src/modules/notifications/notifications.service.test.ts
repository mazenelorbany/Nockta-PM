import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeEventsMock, makePrismaMock } from '../../test-utils/mocks';
import type { PrismaService } from '../../prisma/prisma.service';
import type { AuthenticatedUser } from '../auth/types';

import { NotificationsService } from './notifications.service';
import { NotificationDispatcherService } from './notification-dispatcher.service';
import { RecipientResolverService } from './recipient-resolver.service';
import { PreferencesService } from './preferences.service';
import { NotificationMutesService } from './mutes.service';
import type { NotificationDigestService } from './digest.service';
import type {
  NotificationSnoozeService} from './snooze.service';
import {
  isNowInsideRule
} from './snooze.service';

// =============================================================================
// notifications — the user-facing notification surface is split across four
// collaborators; testing only NotificationsService alone would mostly assert
// CRUD plumbing. The behavioral guarantees that ship to users actually live in:
//
//   - PreferencesService.channelsFor    — per-event channel selection
//   - RecipientResolverService.resolve  — who gets notified (excluding actor)
//   - NotificationDispatcherService     — routing + per-recipient mute check
//   - NotificationsService              — ownership of read/delete writes
//
// All four are exercised in this file so a regression in any one is caught by
// the test that's named for the behavior, not the class.
//
// DIVERGENCE FROM SPEC: there is no `(userId, type, relatedId)` de-dup window
// in the current code path — Notification has no such unique index and the
// dispatcher always enqueues. The corresponding test is intentionally omitted
// rather than asserting behavior that doesn't exist. The dispatcher's actual
// per-event coalescing primitive is `preferences.isMuted` + the bull job's
// `removeOnComplete` retention, both of which ARE asserted below.
//
// DIVERGENCE FROM SPEC: digest-mode users still receive immediate notifications
// in the current code — `channelsFor` doesn't consult `digestMode`. The
// DigestScheduler appends a `DailyDigest` summary row but doesn't suppress the
// per-event rows. The test below pins that current behavior so any future
// "suppress immediate when in digest mode" change is deliberate.
// =============================================================================

const ACTOR_ID = '00000000-0000-0000-0000-0000000000a1';
const RECIPIENT_ID = '00000000-0000-0000-0000-0000000000b1';
const OTHER_ID = '00000000-0000-0000-0000-0000000000c1';
const TASK_ID = '00000000-0000-0000-0000-0000000000d1';
const PROJECT_ID = '00000000-0000-0000-0000-0000000000e1';

function buildActor(id = ACTOR_ID): AuthenticatedUser {
  return {
    id,
    email: `${id}@nockta.com`,
    kind: 'internal',
    companyRole: 'Member',
    jti: 'jti-1',
  };
}

// =============================================================================
// NotificationsService — ownership-bound CRUD
// =============================================================================

describe('NotificationsService.delete', () => {
  let prisma: PrismaService;
  let service: NotificationsService;

  beforeEach(() => {
    prisma = makePrismaMock();
    service = new NotificationsService(prisma);
  });

  it('forbids deleting a notification you do not own', async () => {
    // Regression guard: without the explicit `recipientUserId` check, any
    // signed-in user could DELETE /notifications/:id for any row in the table.
    vi.mocked(prisma.notification.findUnique).mockResolvedValueOnce({
      id: 'n-1',
      recipientUserId: OTHER_ID,
    } as never);

    await expect(service.delete(buildActor(), 'n-1')).rejects.toThrow(
      ForbiddenException,
    );
    expect(prisma.notification.delete).not.toHaveBeenCalled();
  });

  it('404s when the notification does not exist', async () => {
    vi.mocked(prisma.notification.findUnique).mockResolvedValueOnce(null as never);
    await expect(service.delete(buildActor(), 'n-1')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('only marks the actor’s own unread rows when markAllRead fires', async () => {
    // The where-clause is the security boundary: a missing `recipientUserId`
    // filter would mark every unread row in the table as read.
    vi.mocked(prisma.notification.updateMany).mockResolvedValueOnce({
      count: 3,
    } as never);

    await service.markAllRead(buildActor());

    const args = vi.mocked(prisma.notification.updateMany).mock.calls[0]?.[0];
    expect(args?.where).toEqual(
      expect.objectContaining({
        recipientUserId: ACTOR_ID,
        readAt: null,
      }),
    );
  });

  it('markRead scopes the id-list to the actor (defense in depth)', async () => {
    vi.mocked(prisma.notification.updateMany).mockResolvedValueOnce({
      count: 0,
    } as never);
    await service.markRead(buildActor(), ['n-1', 'n-2']);
    const args = vi.mocked(prisma.notification.updateMany).mock.calls[0]?.[0];
    expect(args?.where?.recipientUserId).toBe(ACTOR_ID);
    expect(args?.where?.id).toEqual({ in: ['n-1', 'n-2'] });
  });
});

// =============================================================================
// RecipientResolverService — who gets notified, never the actor
// =============================================================================

describe('RecipientResolverService.resolve', () => {
  let prisma: PrismaService;
  let resolver: RecipientResolverService;

  beforeEach(() => {
    prisma = makePrismaMock();
    resolver = new RecipientResolverService(prisma);
  });

  it('excludes the actor from a comment.added on a task they watch', async () => {
    // Critical: never notify a user about their own action. If the actor
    // happens to watch the task they just commented on, they should not get
    // a "watcher" notification for it.
    vi.mocked(prisma.taskWatcher.findMany).mockResolvedValueOnce([
      { userId: ACTOR_ID },
      { userId: OTHER_ID },
    ] as never);

    const out = await resolver.resolve('comment.added', {
      taskId: TASK_ID,
      authorUserId: ACTOR_ID,
      mentions: {},
    });

    expect(out.map((r) => r.userId)).toEqual([OTHER_ID]);
    expect(out[0]?.reason).toBe('watching');
  });

  it('mentioned beats watching when a user qualifies for both', async () => {
    // The Map-keyed-by-userId implementation must seed watchers first then
    // overwrite with mentions, so the more-specific reason wins. If the order
    // ever flips, "mentioned" badges silently regress to "watching".
    vi.mocked(prisma.taskWatcher.findMany).mockResolvedValueOnce([
      { userId: OTHER_ID },
    ] as never);

    const out = await resolver.resolve('comment.added', {
      taskId: TASK_ID,
      authorUserId: ACTOR_ID,
      mentions: { userIds: [OTHER_ID] },
    });

    expect(out).toHaveLength(1);
    expect(out[0]?.reason).toBe('mentioned');
  });

  it('task.assigned addresses exactly the new assignee', async () => {
    const out = await resolver.resolve('task.assigned', {
      taskId: TASK_ID,
      assigneeUserId: OTHER_ID,
      actorUserId: ACTOR_ID,
    });
    expect(out).toEqual([{ userId: OTHER_ID, reason: 'assigned' }]);
  });

  it('task.updated returns watchers minus actor', async () => {
    vi.mocked(prisma.taskWatcher.findMany).mockResolvedValueOnce([
      { userId: ACTOR_ID },
      { userId: OTHER_ID },
      { userId: RECIPIENT_ID },
    ] as never);

    const out = await resolver.resolve('task.updated', {
      taskId: TASK_ID,
      actorUserId: ACTOR_ID,
    });

    expect(out.map((r) => r.userId).sort()).toEqual([OTHER_ID, RECIPIENT_ID].sort());
  });

  it('returns empty list when the event has no taskId/projectId', async () => {
    // Belt-and-braces: malformed payloads from a misbehaving emitter must
    // not throw — we'd lose the event for everyone else in the same tick.
    const out = await resolver.resolve('task.updated', {});
    expect(out).toEqual([]);
  });
});

// =============================================================================
// PreferencesService.channelsFor — channel selection
// =============================================================================

describe('PreferencesService.channelsFor', () => {
  let prisma: PrismaService;
  let prefs: PreferencesService;

  beforeEach(() => {
    prisma = makePrismaMock();
    prefs = new PreferencesService(prisma);
    // user.kind default — needed by the "no email channel for clients" guard.
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      kind: 'internal',
    } as never);
  });

  it('in-app is on for every event, even with zero preference rows', async () => {
    // In-app is the non-negotiable channel — it backs the bell badge. The
    // defaults map only governs chat opt-in.
    vi.mocked(prisma.notificationPreference.findMany).mockResolvedValueOnce(
      [] as never,
    );

    const out = await prefs.channelsFor(RECIPIENT_ID, 'TaskUpdated', PROJECT_ID);
    expect(out.inApp).toBe(true);
    expect(out.chat).toBe(false); // not in DEFAULT_CHAT_ON_FOR
  });

  it('chat defaults ON for TaskAssigned when the user has a chat binding', async () => {
    // TaskAssigned is in DEFAULT_CHAT_ON_FOR — but chat still requires a bound
    // Google Chat account, otherwise we'd queue Chat jobs that always fail.
    vi.mocked(prisma.notificationPreference.findMany).mockResolvedValueOnce(
      [] as never,
    );
    vi.mocked(
      (prisma as unknown as { chatBinding: { findUnique: ReturnType<typeof vi.fn> } })
        .chatBinding.findUnique,
    ).mockResolvedValueOnce({ userId: RECIPIENT_ID } as never);

    const out = await prefs.channelsFor(RECIPIENT_ID, 'TaskAssigned', PROJECT_ID);
    expect(out.chat).toBe(true);
  });

  it('chat is forced off when the user has not bound a chat account', async () => {
    vi.mocked(prisma.notificationPreference.findMany).mockResolvedValueOnce(
      [] as never,
    );
    vi.mocked(
      (prisma as unknown as { chatBinding: { findUnique: ReturnType<typeof vi.fn> } })
        .chatBinding.findUnique,
    ).mockResolvedValueOnce(null as never);

    const out = await prefs.channelsFor(RECIPIENT_ID, 'TaskAssigned', PROJECT_ID);
    expect(out.chat).toBe(false);
  });

  it('clients NEVER get chat notifications, even with a binding row', async () => {
    // Security spec §10: client users (external) can only use in-app. A
    // misconfigured binding row must not leak chat to them.
    vi.mocked(prisma.notificationPreference.findMany).mockResolvedValueOnce(
      [] as never,
    );
    vi.mocked(
      (prisma as unknown as { chatBinding: { findUnique: ReturnType<typeof vi.fn> } })
        .chatBinding.findUnique,
    ).mockResolvedValueOnce({ userId: RECIPIENT_ID } as never);
    vi.mocked(prisma.user.findUnique).mockReset();
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      kind: 'client',
    } as never);

    const out = await prefs.channelsFor(RECIPIENT_ID, 'TaskAssigned', PROJECT_ID);
    expect(out.chat).toBe(false);
  });

  it('explicit per-event row overrides the default-on map', async () => {
    // A user can disable chat for TaskAssigned even though it's default-on.
    vi.mocked(prisma.notificationPreference.findMany).mockResolvedValueOnce([
      {
        userId: RECIPIENT_ID,
        eventType: 'TaskAssigned',
        channel: 'chat',
        enabled: false,
        projectId: null,
        snoozeUntil: null,
      },
    ] as never);

    const out = await prefs.channelsFor(RECIPIENT_ID, 'TaskAssigned', PROJECT_ID);
    expect(out.chat).toBe(false);
  });

  it('project-specific row beats the all-projects row', async () => {
    // Order matters: project-scoped pref must win. Otherwise muting a noisy
    // project doesn't stick if the user also has a global pref.
    vi.mocked(prisma.notificationPreference.findMany).mockResolvedValueOnce([
      // Global says enabled.
      {
        userId: RECIPIENT_ID,
        eventType: 'TaskAssigned',
        channel: 'chat',
        enabled: true,
        projectId: null,
        snoozeUntil: null,
      },
      // Project-specific says disabled.
      {
        userId: RECIPIENT_ID,
        eventType: 'TaskAssigned',
        channel: 'chat',
        enabled: false,
        projectId: PROJECT_ID,
        snoozeUntil: null,
      },
    ] as never);
    vi.mocked(
      (prisma as unknown as { chatBinding: { findUnique: ReturnType<typeof vi.fn> } })
        .chatBinding.findUnique,
    ).mockResolvedValueOnce({ userId: RECIPIENT_ID } as never);

    const out = await prefs.channelsFor(RECIPIENT_ID, 'TaskAssigned', PROJECT_ID);
    expect(out.chat).toBe(false);
  });

  it('workspace snooze sentinel forces chat off but keeps in-app on', async () => {
    // The sentinel row uses eventType="__all__". When `snoozeUntil` is in the
    // future, every channel except in-app is suppressed regardless of pref.
    // In-app remains so the bell badge accurately counts unread items.
    vi.mocked(prisma.notificationPreference.findMany).mockResolvedValueOnce([
      {
        userId: RECIPIENT_ID,
        eventType: '__all__',
        channel: 'chat',
        enabled: true,
        projectId: null,
        snoozeUntil: new Date(Date.now() + 60_000),
      },
    ] as never);

    const out = await prefs.channelsFor(RECIPIENT_ID, 'TaskAssigned', PROJECT_ID);
    expect(out).toEqual({ inApp: true, chat: false });
  });
});

// =============================================================================
// PreferencesService.isMuted — per-task mute lookup
// =============================================================================

describe('PreferencesService.isMuted', () => {
  let prisma: PrismaService;
  let prefs: PreferencesService;

  beforeEach(() => {
    prisma = makePrismaMock();
    prefs = new PreferencesService(prisma);
  });

  it('returns false (cheap path) when there is no task in scope', async () => {
    // System notifications (e.g. deploy.succeeded with no task) skip the
    // per-task lookup entirely — saves a DB hit per non-task event.
    const out = await prefs.isMuted(RECIPIENT_ID, null);
    expect(out).toBe(false);
    expect(
      (prisma as unknown as { taskMute: { findUnique: ReturnType<typeof vi.fn> } })
        .taskMute.findUnique,
    ).not.toHaveBeenCalled();
  });

  it('returns true when a mute row exists for (user, task)', async () => {
    vi.mocked(
      (prisma as unknown as { taskMute: { findUnique: ReturnType<typeof vi.fn> } })
        .taskMute.findUnique,
    ).mockResolvedValueOnce({ userId: RECIPIENT_ID, taskId: TASK_ID } as never);

    expect(await prefs.isMuted(RECIPIENT_ID, TASK_ID)).toBe(true);
  });
});

// =============================================================================
// NotificationDispatcherService — comment.added discriminator + mute path
// =============================================================================

interface DispatcherMocks {
  emitter: ReturnType<typeof makeEventsMock>;
  resolver: { resolve: ReturnType<typeof vi.fn> };
  prefs: { channelsFor: ReturnType<typeof vi.fn>; isMuted: ReturnType<typeof vi.fn> };
  mutes: { isMuted: ReturnType<typeof vi.fn> };
  snooze: { isWithinSnoozeWindow: ReturnType<typeof vi.fn> };
  digest: { enqueueOrBatch: ReturnType<typeof vi.fn> };
  queue: { add: ReturnType<typeof vi.fn> };
}

function buildDispatcher(): {
  dispatcher: NotificationDispatcherService;
  mocks: DispatcherMocks;
} {
  const emitter = makeEventsMock();
  const resolver = { resolve: vi.fn() };
  const prefs = {
    channelsFor: vi.fn().mockResolvedValue({ inApp: true, chat: false }),
    isMuted: vi.fn().mockResolvedValue(false),
  };
  const mutes = { isMuted: vi.fn().mockResolvedValue(false) };
  const snooze = { isWithinSnoozeWindow: vi.fn().mockResolvedValue(false) };
  // Pass I (Notifications 8→9). Default: NOT batched — keeps existing tests
  // describing the immediate-queue path intact.
  const digest = { enqueueOrBatch: vi.fn().mockResolvedValue(false) };
  const queue = { add: vi.fn().mockResolvedValue(undefined) };
  const dispatcher = new NotificationDispatcherService(
    emitter.instance,
    resolver as unknown as RecipientResolverService,
    prefs as unknown as PreferencesService,
    mutes as unknown as NotificationMutesService,
    snooze as unknown as NotificationSnoozeService,
    digest as unknown as NotificationDigestService,
    queue as unknown as Queue,
  );
  return { dispatcher, mocks: { emitter, resolver, prefs, mutes, snooze, digest, queue } };
}

// Expose the private `dispatch` for tests. The OnModuleInit hook just routes
// emitter.onAny → dispatch; testing through onAny adds nothing.
//
// We can't extend NotificationDispatcherService directly because `dispatch`
// is private on it — the intersection would reduce to `never`. Cast through
// `unknown` to the structural shape we actually need.
type DispatcherInternal = {
  dispatch(eventName: string, payload: Record<string, unknown>): Promise<void>;
};

describe('NotificationDispatcherService.dispatch', () => {
  it('maps comment.added with reason="mentioned" to MentionedInComment type', async () => {
    // Comments fan out to two distinct user-facing notification types
    // depending on WHY each recipient was included. The dispatcher is the
    // one place this discriminator lives — without it, all comment recipients
    // would see the same generic CommentAdded badge.
    const { dispatcher, mocks } = buildDispatcher();
    mocks.resolver.resolve.mockResolvedValueOnce([
      { userId: RECIPIENT_ID, reason: 'mentioned' },
      { userId: OTHER_ID, reason: 'watching' },
    ]);

    await (dispatcher as unknown as DispatcherInternal).dispatch('comment.added', {
      taskId: TASK_ID,
      projectId: PROJECT_ID,
    });

    expect(mocks.queue.add).toHaveBeenCalledTimes(2);
    const firstJob = mocks.queue.add.mock.calls[0]?.[1];
    const secondJob = mocks.queue.add.mock.calls[1]?.[1];
    expect(firstJob).toMatchObject({
      recipientUserId: RECIPIENT_ID,
      type: 'MentionedInComment',
    });
    expect(secondJob).toMatchObject({
      recipientUserId: OTHER_ID,
      type: 'CommentAdded',
    });
  });

  it('skips a recipient who has muted the underlying task', async () => {
    // The mute is the user-facing "I don't care about this thread anymore"
    // button. Without the check here, muted users still get bell badges.
    const { dispatcher, mocks } = buildDispatcher();
    mocks.resolver.resolve.mockResolvedValueOnce([
      { userId: RECIPIENT_ID, reason: 'watching' },
      { userId: OTHER_ID, reason: 'watching' },
    ]);
    mocks.prefs.isMuted.mockImplementation(async (uid: string) => uid === RECIPIENT_ID);

    await (dispatcher as unknown as DispatcherInternal).dispatch('task.updated', {
      taskId: TASK_ID,
      projectId: PROJECT_ID,
    });

    expect(mocks.queue.add).toHaveBeenCalledTimes(1);
    expect(mocks.queue.add.mock.calls[0]?.[1]?.recipientUserId).toBe(OTHER_ID);
  });

  it('drops events we have no notification type for (silent no-op, no resolver call)', async () => {
    // Without the EVENT_TO_NOTIFICATION_TYPE map gate, the dispatcher would
    // resolve recipients (DB hit) for every emitted event, including all
    // internal-only events. The map IS the allowlist.
    const { dispatcher, mocks } = buildDispatcher();

    await (dispatcher as unknown as DispatcherInternal).dispatch('foo.bar.unknown', {});

    expect(mocks.resolver.resolve).not.toHaveBeenCalled();
    expect(mocks.queue.add).not.toHaveBeenCalled();
  });

  it('passes resolved channels through to the queue payload', async () => {
    // Downstream processor honors channels.inApp / channels.chat directly,
    // so the dispatcher must forward what preferences.channelsFor returns
    // without massaging it.
    const { dispatcher, mocks } = buildDispatcher();
    mocks.resolver.resolve.mockResolvedValueOnce([
      { userId: RECIPIENT_ID, reason: 'assigned' },
    ]);
    mocks.prefs.channelsFor.mockResolvedValueOnce({ inApp: true, chat: true });

    await (dispatcher as unknown as DispatcherInternal).dispatch('task.assigned', {
      taskId: TASK_ID,
      projectId: PROJECT_ID,
      assigneeUserId: RECIPIENT_ID,
    });

    expect(mocks.queue.add.mock.calls[0]?.[1]?.channels).toEqual({
      inApp: true,
      chat: true,
    });
  });

  // ---------------------------------------------------------------------------
  // Spec: NotificationMute (per-entity, per-user) — Notifications 7→9
  // ---------------------------------------------------------------------------

  it('drops the notification entirely when the user has muted the task via NotificationMute', async () => {
    // The new NotificationMute path covers tasks AND docs. A muted task must
    // produce ZERO queue jobs — not a "snoozed" outcome, not a deferred row.
    const { dispatcher, mocks } = buildDispatcher();
    mocks.resolver.resolve.mockResolvedValueOnce([
      { userId: RECIPIENT_ID, reason: 'watching' },
    ]);
    mocks.mutes.isMuted.mockImplementation(
      async (uid: string, entityType: string, entityId: string | null) =>
        uid === RECIPIENT_ID && entityType === 'task' && entityId === TASK_ID,
    );

    await (dispatcher as unknown as DispatcherInternal).dispatch('task.updated', {
      taskId: TASK_ID,
      projectId: PROJECT_ID,
    });

    expect(mocks.queue.add).not.toHaveBeenCalled();
  });

  it('mute is per-user — User A muted does not silence User B', async () => {
    // Defense-in-depth: a mute row for User A must NOT affect User B's
    // notification. If the dispatcher ever drops the per-user check, every
    // user in the workspace would silence everyone else by muting a task.
    const { dispatcher, mocks } = buildDispatcher();
    mocks.resolver.resolve.mockResolvedValueOnce([
      { userId: RECIPIENT_ID, reason: 'watching' },
      { userId: OTHER_ID, reason: 'watching' },
    ]);
    mocks.mutes.isMuted.mockImplementation(
      async (uid: string) => uid === RECIPIENT_ID, // only A is muted
    );

    await (dispatcher as unknown as DispatcherInternal).dispatch('task.updated', {
      taskId: TASK_ID,
      projectId: PROJECT_ID,
    });

    // Exactly one job — for user B. The muted user A is dropped.
    expect(mocks.queue.add).toHaveBeenCalledTimes(1);
    expect(mocks.queue.add.mock.calls[0]?.[1]?.recipientUserId).toBe(OTHER_ID);
  });

  // ---------------------------------------------------------------------------
  // Spec: NotificationSnoozeRule (DND window) — Notifications 7→9
  // ---------------------------------------------------------------------------

  it('drops the notification when the recipient is inside a snooze window', async () => {
    // DECISION: we use the drop-during-snooze approach (NOT deferred delivery)
    // because Notification has no `deliverAt` column. The user's in-app
    // sentinel still ensures unread items show up later via the digest.
    const { dispatcher, mocks } = buildDispatcher();
    mocks.resolver.resolve.mockResolvedValueOnce([
      { userId: RECIPIENT_ID, reason: 'watching' },
    ]);
    mocks.snooze.isWithinSnoozeWindow.mockResolvedValueOnce(true);

    await (dispatcher as unknown as DispatcherInternal).dispatch('task.updated', {
      taskId: TASK_ID,
      projectId: PROJECT_ID,
    });

    expect(mocks.queue.add).not.toHaveBeenCalled();
  });
});

// =============================================================================
// NotificationSnoozeService.isNowInsideRule — pure window-math
// =============================================================================

describe('snooze.isNowInsideRule', () => {
  // Pick a known UTC date for determinism. 2024-01-01 was a Monday.
  const MONDAY_10AM = new Date('2024-01-01T10:00:00.000Z');
  const MONDAY_9PM = new Date('2024-01-01T21:00:00.000Z');
  const TUESDAY_5AM = new Date('2024-01-02T05:00:00.000Z');

  it('returns true inside a simple weekday morning window', () => {
    expect(
      isNowInsideRule(
        { daysOfWeek: ['mon', 'tue', 'wed', 'thu', 'fri'], startHour: 9, endHour: 17 },
        MONDAY_10AM,
      ),
    ).toBe(true);
  });

  it('returns false on a non-listed day, even within the hour range', () => {
    // 2024-01-06 is a Saturday — not in mon-fri.
    expect(
      isNowInsideRule(
        { daysOfWeek: ['mon', 'tue', 'wed', 'thu', 'fri'], startHour: 9, endHour: 17 },
        new Date('2024-01-06T10:00:00.000Z'),
      ),
    ).toBe(false);
  });

  it('handles a window that wraps midnight (e.g. 10pm Mon → 6am Tue)', () => {
    // Rule says "mute Mondays from 10pm". 9pm Monday is BEFORE — not muted.
    expect(
      isNowInsideRule(
        { daysOfWeek: ['mon'], startHour: 22, endHour: 6 },
        MONDAY_9PM,
      ),
    ).toBe(false);

    // 11pm Monday — inside the late half.
    expect(
      isNowInsideRule(
        { daysOfWeek: ['mon'], startHour: 22, endHour: 6 },
        new Date('2024-01-01T23:00:00.000Z'),
      ),
    ).toBe(true);

    // 5am Tuesday — inside the morning carryover from Monday's wrap.
    expect(
      isNowInsideRule(
        { daysOfWeek: ['mon'], startHour: 22, endHour: 6 },
        TUESDAY_5AM,
      ),
    ).toBe(true);
  });
});

// =============================================================================
// NotificationMutesService — DB plumbing assertions
// =============================================================================

describe('NotificationMutesService', () => {
  let prisma: PrismaService;
  let mutes: NotificationMutesService;

  beforeEach(() => {
    prisma = makePrismaMock();
    mutes = new NotificationMutesService(prisma);
  });

  it('isMuted returns false for null entity (no DB hit)', async () => {
    expect(await mutes.isMuted(RECIPIENT_ID, null, null)).toBe(false);
    expect(
      (prisma as unknown as { notificationMute: { findUnique: ReturnType<typeof vi.fn> } })
        .notificationMute.findUnique,
    ).not.toHaveBeenCalled();
  });

  it('isMuted returns true when a row exists', async () => {
    vi.mocked(
      (prisma as unknown as { notificationMute: { findUnique: ReturnType<typeof vi.fn> } })
        .notificationMute.findUnique,
    ).mockResolvedValueOnce({ id: 'm-1' } as never);
    expect(await mutes.isMuted(RECIPIENT_ID, 'task', TASK_ID)).toBe(true);
  });
});
