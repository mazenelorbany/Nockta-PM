import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';

import type { SchedulerLockService } from '../../common/scheduling/scheduler-lock.service';
import { attachmentPurgeOps } from '../../health/metrics.controller';
import type { PrismaService } from '../../prisma/prisma.service';
import type { StorageService } from '../storage/storage.service';

/**
 * Background housekeeping. Runs every hour:
 *   1. Hard-delete Comments + Attachments soft-deleted more than 30 days ago.
 *      For attachments, the S3 objects (primary key + thumb keys) are removed
 *      *before* the row, so the row remains as a recovery anchor if the S3
 *      call fails. Storage failures are logged and the row is skipped — the
 *      next tick will retry it.
 *   2. Make sure the Event partition table for next month exists. The Event
 *      table is partitioned by month per the GRILL-SUMMARY contract; without
 *      a future-month partition, inserts at month-rollover will fail.
 *
 * Every tick is wrapped in SchedulerLockService.withLock so that when the API
 * runs with numReplicas > 1, only one instance actually executes the work
 * per scheduled window. Without this guard each replica would tick on its own
 * timer and we'd fan out duplicate deletions, partition creations, etc.
 */
@Injectable()
export class MaintenanceScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MaintenanceScheduler.name);
  private timer: NodeJS.Timeout | null = null;
  private hotMvTimer: NodeJS.Timeout | null = null;
  private dailyTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly lock: SchedulerLockService,
  ) {}

  onModuleInit(): void {
    // Stagger first run so multiple in-process schedulers don't all fire on
    // the same tick. 2 minutes after boot, then hourly.
    setTimeout(() => void this.tick(), 120_000);
    this.timer = setInterval(() => void this.tick(), 60 * 60_000);

    // High-velocity MV refresh (spec §18): every 5 minutes. Used by the
    // workload dashboard which is otherwise expensive to compute live.
    setTimeout(() => void this.refreshHotMaterializedViews(), 60_000);
    this.hotMvTimer = setInterval(
      () => void this.refreshHotMaterializedViews(),
      5 * 60_000,
    );

    // Daily MVs: sprint velocity history + cycle time. Once every 24h is fine.
    setTimeout(() => void this.refreshDailyMaterializedViews(), 180_000);
    this.dailyTimer = setInterval(
      () => void this.refreshDailyMaterializedViews(),
      24 * 60 * 60_000,
    );
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.hotMvTimer) clearInterval(this.hotMvTimer);
    if (this.dailyTimer) clearInterval(this.dailyTimer);
  }

  private async refreshHotMaterializedViews(): Promise<void> {
    // 5-min cadence — give the lock TTL room (10 min) so a slow REFRESH on a
    // large dataset doesn't release before completing.
    await this.lock.withLock('maintenance:mv:hot', 10 * 60_000, async () => {
      await this.refreshMv('mv_workload_open');
    });
  }

  private async refreshDailyMaterializedViews(): Promise<void> {
    await this.lock.withLock('maintenance:mv:daily', 60 * 60_000, async () => {
      await this.refreshMv('mv_sprint_velocity');
      await this.refreshMv('mv_cycle_time_30d');
    });
  }

  private async refreshMv(name: string): Promise<void> {
    try {
      // CONCURRENTLY avoids locking readers; requires a unique index on the
      // view (companion.sql adds one for each).
      await this.prisma.$executeRawUnsafe(`REFRESH MATERIALIZED VIEW CONCURRENTLY "${name}"`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // 42P01 / "does not exist" before companion.sql is applied. Don't spam.
      if (!/does not exist|relation .* does not exist/i.test(msg)) {
        this.logger.warn(`Could not refresh ${name}: ${msg}`);
      }
    }
  }

  private async tick(): Promise<void> {
    // The full hourly tick can take minutes if there's a lot to purge — give
    // it a 30-minute lock so a single slow run doesn't get usurped halfway.
    await this.lock.withLock('maintenance:tick', 30 * 60_000, async () => {
      try {
        const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

        // Hard-delete soft-deleted Comments older than 30d. The `deletedAt`
        // tombstone has already given mentioned users time to read the context.
        const commentResult = await this.prisma.comment.deleteMany({
          where: { deletedAt: { lt: cutoff } },
        });
        if (commentResult.count > 0) {
          this.logger.log(`Hard-deleted ${commentResult.count} stale Comment(s)`);
        }

        // Hard-delete soft-deleted Attachments older than 30d. The S3 objects
        // are purged first; the DB row is the recovery anchor, so we only delete
        // it once storage has gone quiet. Failed S3 deletes are logged and the
        // row is left for the next tick to retry (no fan-out cascade).
        await this.purgeStaleAttachments(cutoff);

        await this.ensureNextMonthEventPartition();
      } catch (err) {
        this.logger.error(`Maintenance tick failed: ${err instanceof Error ? err.message : err}`);
      }
    });
  }

  /**
   * Walk the set of attachments soft-deleted more than `cutoff` ago. For each
   * row, attempt to delete the primary S3 object and any thumbnail derivatives.
   * Only delete the DB row if every storage call succeeded — that way a
   * transient S3 outage leaves us in a recoverable state and the next tick
   * picks up where we left off. Batched at 100 rows per tick to keep load low.
   */
  private async purgeStaleAttachments(cutoff: Date): Promise<void> {
    const batch = await this.prisma.attachment.findMany({
      where: { deletedAt: { lt: cutoff } },
      select: { id: true, storageKey: true, thumb200Key: true, thumb800Key: true },
      take: 100,
    });
    if (batch.length === 0) return;

    let purged = 0;
    let storageFailed = 0;
    for (const att of batch) {
      const keys: string[] = [att.storageKey];
      if (att.thumb200Key) keys.push(att.thumb200Key);
      if (att.thumb800Key) keys.push(att.thumb800Key);

      const results = await Promise.allSettled(
        keys.map((k) => this.storage.deleteObject(k)),
      );
      const failed = results.filter((r) => r.status === 'rejected');
      if (failed.length > 0) {
        storageFailed += 1;
        attachmentPurgeOps.inc({ outcome: 'storage_failed' });
        const first = failed[0] as PromiseRejectedResult;
        const reason = first.reason instanceof Error ? first.reason.message : String(first.reason);
        this.logger.warn(`Storage purge failed for Attachment ${att.id}: ${reason}`);
        continue; // leave the row in place; retry next tick
      }
      try {
        await this.prisma.attachment.delete({ where: { id: att.id } });
        purged += 1;
        attachmentPurgeOps.inc({ outcome: 'purged' });
      } catch (err) {
        // Row vanished between findMany and delete — fine, count it as purged.
        const msg = err instanceof Error ? err.message : String(err);
        if (!/Record to delete does not exist/.test(msg)) {
          attachmentPurgeOps.inc({ outcome: 'db_failed' });
          this.logger.warn(`Failed to drop Attachment ${att.id}: ${msg}`);
        }
      }
    }
    if (purged > 0 || storageFailed > 0) {
      this.logger.log(
        `Hard-deleted ${purged} stale Attachment(s)` +
        (storageFailed > 0 ? `, ${storageFailed} deferred (storage error)` : ''),
      );
    }
  }

  /**
   * Idempotently create next month's Event partition. The Event table is
   * declared as a partitioned-by-RANGE table in companion.sql; without a
   * partition that covers `createdAt` the INSERT fails. We create the slot
   * eagerly so a slow Sunday tick on the 31st of the month doesn't miss it.
   */
  private async ensureNextMonthEventPartition(): Promise<void> {
    const now = new Date();
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    const monthAfter = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 2, 1));
    const year = next.getUTCFullYear();
    const month = String(next.getUTCMonth() + 1).padStart(2, '0');
    const partition = `Event_${year}_${month}`;
    const from = next.toISOString().slice(0, 10);
    const to = monthAfter.toISOString().slice(0, 10);
    try {
      await this.prisma.$executeRawUnsafe(
        `CREATE TABLE IF NOT EXISTS "${partition}" PARTITION OF "Event" ` +
        `FOR VALUES FROM ('${from}') TO ('${to}')`,
      );
      this.logger.log(`Ensured Event partition ${partition} covers [${from}, ${to})`);
    } catch (err) {
      // If the Event table isn't yet declared as partitioned (e.g. fresh dev
      // DB without companion.sql applied), Postgres raises 42P17 / similar.
      // Don't spam the logs — single-line warn and move on.
      const msg = err instanceof Error ? err.message : String(err);
      if (!/not partitioned|relation .* does not exist/i.test(msg)) {
        this.logger.warn(`Could not ensure ${partition}: ${msg}`);
      }
    }
  }
}
