import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { SchedulerLockService } from '../../common/scheduling/scheduler-lock.service';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Builds a single rolled-up "Daily digest" notification per user with
 * digestMode=true. Runs at the top of every hour and only emits when local
 * time is 08:00 UTC (approximate one-fire-per-day).
 *
 * Two layers of safety against double-execution:
 *   1. Local: `lastFiredOn` short-circuits if we already ran today on this pid.
 *   2. Cross-replica: SchedulerLockService.withLock('digest:tick', ...) so only
 *      one API replica writes the digest rows even if numReplicas > 1.
 *
 * A production deployment with heavier workload should swap this for BullMQ
 * repeatables with proper cron expressions and per-user TZ awareness.
 */
@Injectable()
export class DigestScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DigestScheduler.name);
  private timer: NodeJS.Timeout | null = null;
  private lastFiredOn: string | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly lock: SchedulerLockService,
  ) {}

  onModuleInit(): void {
    // Check every 5 minutes. Idempotent — only does work when the day
    // changes and the UTC hour is 8.
    setTimeout(() => void this.tick(), 90_000);
    this.timer = setInterval(() => void this.tick(), 5 * 60_000);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    // Local hour-gate first — cheap, avoids hammering Redis 12 times an hour
    // for nothing. The cross-replica lock then guarantees single execution.
    const now = new Date();
    if (now.getUTCHours() !== 8) return;
    const dayKey = now.toISOString().slice(0, 10);
    if (this.lastFiredOn === dayKey) return;

    await this.lock.withLock('digest:tick', 15 * 60_000, async () => {
      try {
        const sinceCutoff = new Date(now.getTime() - 24 * 60 * 60_000);

        // Find users opted into digest mode for any event type. We assemble per
        // user instead of per preference so each user gets a single bundled
        // notification regardless of how many channels they configured.
        const digestUsers = await this.prisma.notificationPreference.findMany({
          where: { digestMode: true },
          select: { userId: true },
          distinct: ['userId'],
        });
        if (digestUsers.length === 0) {
          this.lastFiredOn = dayKey;
          return;
        }

        for (const { userId } of digestUsers) {
          // Snooze-respect: if every digestable preference for this user is
          // currently snoozed, skip them.
          const snooze = await this.prisma.notificationPreference.findFirst({
            where: { userId, digestMode: true, snoozeUntil: { gt: now } },
          });
          if (snooze) continue;

          // Pull every in-app notification that arrived in the last 24h and
          // hasn't already been folded into a digest. Tag-and-drop pattern.
          const items = await this.prisma.notification.findMany({
            where: {
              recipientUserId: userId,
              createdAt: { gte: sinceCutoff },
              type: { not: 'DailyDigest' },
            },
            select: { id: true, type: true, relatedTaskId: true, relatedProjectId: true, createdAt: true },
            take: 50,
          });
          if (items.length === 0) continue;

          const groupedByType: Record<string, number> = {};
          for (const i of items) {
            groupedByType[i.type] = (groupedByType[i.type] ?? 0) + 1;
          }

          await this.prisma.notification
            .create({
              data: {
                recipientUserId: userId,
                type: 'DailyDigest',
                payload: {
                  date: dayKey,
                  total: items.length,
                  groupedByType,
                  sampleIds: items.slice(0, 5).map((i) => i.id),
                },
              },
            })
            .catch(() => undefined);
        }

        this.lastFiredOn = dayKey;
        this.logger.log(`Digest sweep complete for ${digestUsers.length} user(s) on ${dayKey}`);
      } catch (err) {
        this.logger.error(`Digest tick failed: ${err instanceof Error ? err.message : err}`);
      }
    });
  }
}
