import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { SchedulerLockService } from '../../common/scheduling/scheduler-lock.service';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Scans tasks every 10 minutes for ones whose due date enters the next-24h
 * window and emits `task.due_soon`. Each task fires at most once per due-date
 * crossing via the `dueSoonNotifiedAt` marker — clearing only when dueDate
 * shifts farther into the future.
 *
 * Wrapped in SchedulerLockService.withLock so multi-replica deploys don't
 * fan out duplicate `task.due_soon` events. The `dueSoonNotifiedAt` column
 * also acts as a second-layer idempotency guard.
 */
@Injectable()
export class DueSoonScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DueSoonScheduler.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
    private readonly lock: SchedulerLockService,
  ) {}

  onModuleInit(): void {
    setTimeout(() => void this.tick(), 60_000);
    this.timer = setInterval(() => void this.tick(), 10 * 60_000);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    await this.lock.withLock('due-soon:tick', 5 * 60_000, async () => {
      try {
        const now = new Date();
        const horizon = new Date(now.getTime() + 24 * 60 * 60_000);
        // Tasks newly entering the next-24h window — never notified, not done.
        const due = await this.prisma.task.findMany({
          where: {
            dueDate: { gte: now, lte: horizon },
            dueSoonNotifiedAt: null,
            status: { notIn: ['Done', 'Approved'] },
          },
          select: {
            id: true,
            projectId: true,
            assigneeUserId: true,
            dueDate: true,
          },
          take: 500,
        });
        if (due.length === 0) return;

        const ids = due.map((t) => t.id);
        await this.prisma.task.updateMany({
          where: { id: { in: ids } },
          data: { dueSoonNotifiedAt: now },
        });
        for (const t of due) {
          this.events.emit('task.due_soon', {
            taskId: t.id,
            projectId: t.projectId,
            assigneeUserId: t.assigneeUserId,
            dueDate: t.dueDate?.toISOString() ?? null,
          });
        }
        this.logger.log(`Emitted task.due_soon for ${due.length} task(s)`);

        // Reverse direction: any task previously marked but now far from due
        // gets its marker cleared so a future move-out-then-back re-fires.
        await this.prisma.task.updateMany({
          where: {
            dueSoonNotifiedAt: { not: null },
            OR: [{ dueDate: null }, { dueDate: { gt: horizon } }, { status: { in: ['Done', 'Approved'] } }],
          },
          data: { dueSoonNotifiedAt: null },
        });
      } catch (err) {
        this.logger.error(`Tick failed: ${err instanceof Error ? err.message : err}`);
      }
    });
  }
}
