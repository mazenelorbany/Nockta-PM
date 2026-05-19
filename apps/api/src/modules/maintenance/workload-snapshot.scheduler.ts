import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';

import { SchedulerLockService } from '../../common/scheduling/scheduler-lock.service';
import { PrismaService } from '../../prisma/prisma.service';

// =============================================================================
// WorkloadSnapshotScheduler — writes one DailyWorkloadSnapshot row per active
// user, once per day at 00:05 UTC. Powers the 7-day sparkline on the workload
// page and the personal dashboard.
//
// Two safety layers (same pattern as DigestScheduler):
//   1. Local `lastFiredOn` short-circuits when we already ran today on this pid.
//   2. Cross-replica SchedulerLockService.withLock('workload:snapshot', ...)
//      so multi-replica deployments don't double-write.
//
// On first run (lastFiredOn empty AND today's row missing for any user) we
// also backfill today's snapshot for every active user so the sparkline
// isn't empty on day one.
//
// Pruning: rows older than 60 days are deleted on every tick — bounded
// retention keeps the table small (60 days × ~50 users ≈ 3000 rows).
// =============================================================================

const PRIORITY_WEIGHT: Record<'Critical' | 'High' | 'Medium' | 'Low', number> = {
  Critical: 4,
  High: 3,
  Medium: 2,
  Low: 1,
};

@Injectable()
export class WorkloadSnapshotScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WorkloadSnapshotScheduler.name);
  private timer: NodeJS.Timeout | null = null;
  private lastFiredOn: string | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly lock: SchedulerLockService,
  ) {}

  onModuleInit(): void {
    // Boot path: fire after 90s to backfill today's snapshot. Then check
    // every 5 minutes for the daily window.
    setTimeout(() => void this.tick(), 90_000);
    this.timer = setInterval(() => void this.tick(), 5 * 60_000);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    const now = new Date();
    const dayKey = now.toISOString().slice(0, 10);

    // Local short-circuit: already ran today on this pid. The lock below
    // handles the cross-replica case.
    if (this.lastFiredOn === dayKey) return;

    // Fire either at 00:05 UTC OR on boot if today's row is missing (the
    // sparkline shouldn't be empty for a freshly-deployed instance).
    const isWindowOpen = now.getUTCHours() === 0 && now.getUTCMinutes() >= 5;
    if (!isWindowOpen && this.lastFiredOn !== null) return;

    await this.lock.withLock('workload:snapshot', 10 * 60_000, async () => {
      try {
        await this.snapshotAllActiveUsers(now);
        await this.prune(now);
        this.lastFiredOn = dayKey;
      } catch (err) {
        this.logger.error(
          `Workload snapshot failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });
  }

  private async snapshotAllActiveUsers(now: Date): Promise<void> {
    // Group open tasks by assignee + priority in ONE query. The shape mirrors
    // analytics.service.workload so the sparkline value stays consistent with
    // the load score it sits next to.
    const grouped = await this.prisma.task.groupBy({
      by: ['assigneeUserId', 'priority'],
      where: {
        status: { notIn: ['Done', 'Approved'] },
        assigneeUserId: { not: null },
      },
      _count: { _all: true },
    });

    interface Agg { count: number; weighted: number }
    const perUser = new Map<string, Agg>();
    for (const g of grouped) {
      if (!g.assigneeUserId) continue;
      const row = perUser.get(g.assigneeUserId) ?? { count: 0, weighted: 0 };
      row.count += g._count._all;
      row.weighted += PRIORITY_WEIGHT[g.priority] * g._count._all;
      perUser.set(g.assigneeUserId, row);
    }

    // Date for today at UTC midnight — the @db.Date column truncates time
    // anyway but being explicit avoids drift between server tz and storage.
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

    // We also want to snapshot users with zero open tasks IF they had any
    // open tasks recently — otherwise their sparkline is flat-zero and we
    // shouldn't pollute the table. Pragmatic compromise: only snapshot
    // users who currently have at least one open task. Users who go to
    // zero get an implicit zero from the absence of a row.
    let writes = 0;
    for (const [userId, agg] of perUser) {
      await this.prisma.dailyWorkloadSnapshot.upsert({
        where: { userId_date: { userId, date } },
        update: { openTasksCount: agg.count, weightedLoad: agg.weighted },
        create: {
          userId,
          date,
          openTasksCount: agg.count,
          weightedLoad: agg.weighted,
        },
      });
      writes += 1;
    }
    this.logger.log(`Workload snapshot: ${writes} user row(s) at ${date.toISOString().slice(0, 10)}`);
  }

  private async prune(now: Date): Promise<void> {
    const cutoff = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);
    const result = await this.prisma.dailyWorkloadSnapshot.deleteMany({
      where: { date: { lt: cutoff } },
    });
    if (result.count > 0) {
      this.logger.log(`Pruned ${result.count} workload snapshot row(s) older than 60d`);
    }
  }
}
