import { Global, Module } from '@nestjs/common';
import { SchedulerLockService } from './scheduler-lock.service';

/**
 * Provides the SchedulerLockService globally so every scheduler (digest,
 * maintenance, due-soon, recurrence, ai-cron) can wrap its ticks in a
 * Redis-backed leader-election without manually importing this module.
 */
@Global()
@Module({
  providers: [SchedulerLockService],
  exports: [SchedulerLockService],
})
export class SchedulingModule {}
