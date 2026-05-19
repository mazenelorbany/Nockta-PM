import { Injectable, Logger, type OnModuleInit, type OnModuleDestroy } from '@nestjs/common';

import { SchedulerLockService } from '../../common/scheduling/scheduler-lock.service';

import { RecurrenceService } from './recurrence.service';

/**
 * Polls every 60 seconds and spawns any due recurrences. Wrapped in
 * SchedulerLockService.withLock so multi-replica deploys don't fan out
 * duplicate task creations.
 */
@Injectable()
export class RecurrenceSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RecurrenceSchedulerService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly recurrence: RecurrenceService,
    private readonly lock: SchedulerLockService,
  ) {}

  onModuleInit(): void {
    // Run once after boot, then on a 60s interval.
    setTimeout(() => void this.tick(), 30_000);
    this.timer = setInterval(() => void this.tick(), 60_000);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    // 90s lock TTL — comfortably longer than the 60s tick cadence so a slow
    // tick won't be usurped, but short enough that a crashed leader recovers
    // within ~1 minute.
    await this.lock.withLock('recurrence:tick', 90_000, async () => {
      try {
        const { spawned } = await this.recurrence.spawnDueRecurrences();
        if (spawned > 0) {
          this.logger.log(`Spawned ${spawned} recurring tasks`);
        }
      } catch (err) {
        this.logger.error(`Recurrence tick failed: ${err instanceof Error ? err.message : err}`);
      }
    });
  }
}
