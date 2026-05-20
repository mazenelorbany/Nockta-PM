import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { Prisma } from '@prisma/client';

import { SchedulerLockService } from '../../common/scheduling/scheduler-lock.service';
import { PrismaService } from '../../prisma/prisma.service';

// =============================================================================
// NotificationDigestService — Pass I (Notifications 8 → 9).
//
// The dispatcher consults `enqueueOrBatch` BEFORE adding a delivery job to the
// notifications queue. If the recipient has `User.digestEnabled = true`, we
// append the event to their pending NotificationDigest row instead of
// enqueueing an immediate delivery. A once-per-minute cron sweeps the table
// and flushes any row whose `firstQueuedAt` is older than 5 minutes OR whose
// items[] length exceeds 10.
//
// The flush emits a single domain event per row — `notification.digest_ready`
// — which the existing chat-dispatcher + email path subscribe to. We do NOT
// double-write into the Notification table for digest items; the bell badge
// still shows the underlying individual rows that the dispatcher fans out
// via the inApp channel.
//
// Concurrency:
//   - Two API replicas may both run the cron tick. We wrap the whole sweep in
//     SchedulerLockService.withLock('notification:digest:flush', ...) so only
//     one wins per tick. The unique constraint `(userId, sentAt IS NULL)`
//     would be the next line of defence — but Postgres can't express that
//     with a partial unique index without raw DDL, so the lock is the
//     practical guarantee.
//   - enqueueOrBatch is best-effort transactional: we `upsert` on a unique
//     key derived from the user+channel for an OPEN bucket. A race where
//     two enqueues hit at the same time produces two rows with two open
//     items; harmless — the flush still picks up both.
//
// Behavior captured by the unit test (digest.service.test.ts):
//   - 10 notifications within 5 minutes → 1 digest with 10 items.
//   - The 11th arriving triggers an immediate flush (item-count threshold).
//   - A buffer older than 5 minutes flushes on the next tick (time threshold).
// =============================================================================

const MAX_ITEMS_BEFORE_FLUSH = 10;
const MAX_ITEMS_CAP = 25; // belt-and-braces — we should always flush at 10.
const MAX_BUFFER_AGE_MS = 5 * 60 * 1000;
const FLUSH_TICK_MS = 60 * 1000;

export interface DigestQueueInput {
  recipientUserId: string;
  type: string;
  payload: Record<string, unknown>;
  taskId: string | null;
  projectId: string | null;
  reason: string;
}

interface DigestItemRow {
  notificationType: string;
  payload: Record<string, unknown>;
  taskId: string | null;
  projectId: string | null;
  reason: string;
  queuedAt: string;
}

@Injectable()
export class NotificationDigestService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationDigestService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly emitter: EventEmitter2,
    private readonly lock: SchedulerLockService,
  ) {}

  onModuleInit(): void {
    // Stagger the first tick by 20s so a fresh boot doesn't immediately race
    // the rest of the schedulers competing for Redis locks.
    setTimeout(() => void this.tick(), 20_000);
    this.timer = setInterval(() => void this.tick(), FLUSH_TICK_MS);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * Called by the notification dispatcher BEFORE it enqueues an immediate
   * delivery job. Returns true when the event was folded into a digest (and
   * the dispatcher should NOT enqueue normally); false when the user is not
   * on digest mode and the dispatcher should proceed with the standard path.
   *
   * The "10 items → flush now" threshold is enforced inline: the append
   * transaction returns the post-append length, and if it has reached the
   * trip-wire we fire the flush event immediately rather than waiting for
   * the next cron tick.
   */
  async enqueueOrBatch(input: DigestQueueInput): Promise<boolean> {
    const user = await this.prisma.user.findUnique({
      where: { id: input.recipientUserId },
      select: { digestEnabled: true, digestChannel: true },
    });
    if (!user?.digestEnabled) return false;

    const channel = user.digestChannel || 'email';
    const item: DigestItemRow = {
      notificationType: input.type,
      payload: input.payload,
      taskId: input.taskId,
      projectId: input.projectId,
      reason: input.reason,
      queuedAt: new Date().toISOString(),
    };

    // Find-or-create the open bucket for this user+channel. We can't use
    // upsert directly because the "open bucket" predicate isn't expressible
    // as a Prisma unique key (`sentAt IS NULL` is a partial constraint).
    // Two-step: findFirst → create if missing → update. The race window is
    // small enough that occasional double-bucketing is fine; the flush
    // still drains both.
    const open = await this.prisma.notificationDigest.findFirst({
      where: {
        userId: input.recipientUserId,
        channelKind: channel,
        sentAt: null,
      },
      orderBy: { firstQueuedAt: 'asc' },
    });

    let bucketId: string;
    let newLength: number;
    if (open) {
      const existingItems = Array.isArray(open.items)
        ? (open.items as unknown as DigestItemRow[])
        : [];
      if (existingItems.length >= MAX_ITEMS_CAP) {
        // Hard cap — flush this row out of the way and start a fresh one in
        // the same call so the caller's item is never dropped.
        await this.flushOne(open.id).catch(() => undefined);
        const _fresh = await this.prisma.notificationDigest.create({
          data: {
            userId: input.recipientUserId,
            channelKind: channel,
            items: [item] as unknown as Prisma.InputJsonValue,
          },
        });
        return true; // flushed + recorded, dispatcher must NOT also enqueue
      }
      // Atomic JSONB append. Reading `items` then writing `[...items, item]`
      // is lost-update-prone: two concurrent enqueues both read [A,B] and
      // both write [A,B,C] / [A,B,D]; the second wins and one notification
      // disappears. PostgreSQL's `||` JSONB concat happens in-place, so two
      // concurrent statements both append cleanly. Gated on `sentAt IS NULL`
      // so a row a flusher just claimed can't be revived. count=0 means the
      // bucket was just flushed underneath us — fall through to create a
      // fresh one.
      const appended = await this.prisma.$executeRaw`
        UPDATE "NotificationDigest"
        SET "items" = COALESCE("items", '[]'::jsonb) || ${JSON.stringify(item)}::jsonb
        WHERE "id" = ${open.id}::uuid AND "sentAt" IS NULL
      `;
      if (appended === 0) {
        // Bucket was claimed for flush mid-flight; start a new one so this
        // event isn't dropped.
        const created = await this.prisma.notificationDigest.create({
          data: {
            userId: input.recipientUserId,
            channelKind: channel,
            items: [item] as unknown as Prisma.InputJsonValue,
          },
        });
        bucketId = created.id;
        newLength = 1;
      } else {
        bucketId = open.id;
        newLength = existingItems.length + 1;
      }
    } else {
      const created = await this.prisma.notificationDigest.create({
        data: {
          userId: input.recipientUserId,
          channelKind: channel,
          items: [item] as unknown as Prisma.InputJsonValue,
        },
      });
      bucketId = created.id;
      newLength = 1;
    }

    // 10-item trip-wire: flush this row immediately rather than waiting for
    // the cron. flushOne is idempotent under concurrent flushers (it stamps
    // sentAt with conditional updateMany).
    if (newLength >= MAX_ITEMS_BEFORE_FLUSH) {
      await this.flushOne(bucketId).catch((err) => {
        this.logger.warn(
          `Inline flush failed for digest ${bucketId}: ${err instanceof Error ? err.message : err}`,
        );
      });
    }

    return true;
  }

  /**
   * Cron sweep — flushes every digest whose firstQueuedAt is older than the
   * MAX_BUFFER_AGE_MS threshold. The 10-item trip wire is handled inline by
   * enqueueOrBatch; this path only catches the time threshold + any row
   * that slipped past the trip wire due to a concurrent enqueue race.
   *
   * Exposed `public` for the test suite. Production callers come through
   * the timer set up in onModuleInit.
   */
  async tick(): Promise<void> {
    const acquired = await this.lock.withLock(
      'notification:digest:flush',
      2 * FLUSH_TICK_MS, // longer than one tick — survives a slow flush
      async () => {
        const cutoff = new Date(Date.now() - MAX_BUFFER_AGE_MS);
        const due = await this.prisma.notificationDigest.findMany({
          where: { sentAt: null, firstQueuedAt: { lte: cutoff } },
          select: { id: true },
          take: 500, // bound per-tick work
        });
        for (const row of due) {
          try {
            await this.flushOne(row.id);
          } catch (err) {
            this.logger.warn(
              `Flush of digest ${row.id} failed: ${err instanceof Error ? err.message : err}`,
            );
          }
        }
        if (due.length > 0) {
          this.logger.log(`Flushed ${due.length} digest bucket(s)`);
        }
      },
    );
    if (acquired === false) {
      this.logger.debug('Skipping digest tick — another replica holds the lock');
    }
  }

  /**
   * Stamp the digest row as sent and emit the dispatch event. The
   * `updateMany` predicate (`sentAt: null`) makes this idempotent: a
   * concurrent flusher's update affects 0 rows and we silently skip.
   *
   * Grouping for the rendered message:
   *   mentions / assignments / blocked / due-soon / other
   * — the consumer (chat-dispatcher / email-builder) bucketizes for display.
   */
  private async flushOne(id: string): Promise<void> {
    // Try to acquire ownership of the row via the conditional update.
    const claim = await this.prisma.notificationDigest.updateMany({
      where: { id, sentAt: null },
      data: { sentAt: new Date() },
    });
    if (claim.count === 0) return; // another flusher won

    const row = await this.prisma.notificationDigest.findUnique({
      where: { id },
    });
    if (!row) return;

    const items = Array.isArray(row.items) ? (row.items as unknown as DigestItemRow[]) : [];
    if (items.length === 0) return;

    const grouped = this.groupBySourceType(items);
    this.emitter.emit('notification.digest_ready', {
      digestId: row.id,
      recipientUserId: row.userId,
      channelKind: row.channelKind,
      firstQueuedAt: row.firstQueuedAt.toISOString(),
      totalCount: items.length,
      grouped,
      items,
    });
  }

  /**
   * Bucket items into the four canonical source types the digest renderer
   * cares about. Anything that doesn't map cleanly falls into 'other'.
   * Public so tests + the renderer can reuse the same partitioning.
   */
  groupBySourceType(items: DigestItemRow[]): {
    mentions: DigestItemRow[];
    assignments: DigestItemRow[];
    blocked: DigestItemRow[];
    dueSoon: DigestItemRow[];
    other: DigestItemRow[];
  } {
    const out = {
      mentions: [] as DigestItemRow[],
      assignments: [] as DigestItemRow[],
      blocked: [] as DigestItemRow[],
      dueSoon: [] as DigestItemRow[],
      other: [] as DigestItemRow[],
    };
    for (const it of items) {
      const t = it.notificationType;
      const r = it.reason;
      if (r === 'mentioned' || r === 'team_mentioned' || t === 'MentionedInComment') {
        out.mentions.push(it);
      } else if (t === 'TaskAssigned') {
        out.assignments.push(it);
      } else if (t === 'TaskBlocked') {
        out.blocked.push(it);
      } else if (t === 'TaskDueSoon' || t === 'TaskOverdue') {
        out.dueSoon.push(it);
      } else {
        out.other.push(it);
      }
    }
    return out;
  }

  /**
   * Generate a preview of what the user's most-recent flushed (or in-flight)
   * digest looked like, for the settings UI "preview" line. Returns null
   * when the user has nothing in flight.
   */
  async previewLatest(userId: string): Promise<{
    totalCount: number;
    grouped: Record<string, number>;
    firstQueuedAt: string;
    sentAt: string | null;
  } | null> {
    const row = await this.prisma.notificationDigest.findFirst({
      where: { userId },
      orderBy: { firstQueuedAt: 'desc' },
    });
    if (!row) return null;
    const items = Array.isArray(row.items) ? (row.items as unknown as DigestItemRow[]) : [];
    const grouped = this.groupBySourceType(items);
    return {
      totalCount: items.length,
      grouped: {
        mentions: grouped.mentions.length,
        assignments: grouped.assignments.length,
        blocked: grouped.blocked.length,
        dueSoon: grouped.dueSoon.length,
        other: grouped.other.length,
      },
      firstQueuedAt: row.firstQueuedAt.toISOString(),
      sentAt: row.sentAt?.toISOString() ?? null,
    };
  }
}
