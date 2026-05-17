import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { SchedulerLockService } from '../../common/scheduling/scheduler-lock.service';
import { ExportsService } from './exports.service';

// =============================================================================
// ExportsScheduler — one-minute tick that scans ExportSchedule rows whose
// cron matches "now" and fires a run. Wrapped in SchedulerLockService.withLock
// so multi-replica deploys don't fire the same schedule N times.
//
// The cron evaluator lives in exports.service.ts (cronMatchesMinute) and is
// deliberately tiny. A future refactor could swap this scheduler for BullMQ
// repeatables with proper cron expressions; today the in-process approach
// keeps everything in Postgres + Redis without an additional repeat-bookkeeping
// layer.
// =============================================================================

@Injectable()
export class ExportsScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ExportsScheduler.name);
  private timer: NodeJS.Timeout | null = null;
  private firedMinute: string | null = null;

  constructor(
    private readonly exports: ExportsService,
    private readonly lock: SchedulerLockService,
  ) {}

  onModuleInit(): void {
    // Stagger initial fire by 30s so a freshly-deployed pod doesn't pile
    // onto the same tick as the rest of the fleet.
    setTimeout(() => void this.tick(), 30_000);
    this.timer = setInterval(() => void this.tick(), 60_000);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    const now = new Date();
    const minuteKey = now.toISOString().slice(0, 16); // 'YYYY-MM-DDTHH:MM'
    if (this.firedMinute === minuteKey) return;
    this.firedMinute = minuteKey;
    await this.lock.withLock('exports:tick', 90_000, async () => {
      try {
        const fired = await this.exports.fireDueSchedules(now);
        if (fired > 0) {
          this.logger.log(`Tick fired ${fired} export schedule(s)`);
        }
      } catch (err) {
        this.logger.error(
          `Tick failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    });
  }
}
