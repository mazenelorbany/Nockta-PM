import { Injectable, Logger } from '@nestjs/common';
import type { EventEmitter2 } from '@nestjs/event-emitter';
import { Cron } from '@nestjs/schedule';

import type { SchedulerLockService } from '../../common/scheduling/scheduler-lock.service';
import type { PrismaService } from '../../prisma/prisma.service';

// =============================================================================
// ProjectsPurgeProcessor — nightly sweep of archived projects.
//
// Lifecycle (Pass 5 R4-deferred A):
//   - Admin clicks Delete → ProjectsService.archive flips archivedAt = now().
//   - Row stays in the 7-day grace window. listForUser() hides it; an Admin
//     can restore via ProjectsService.restore.
//   - This cron, running daily at 03:00 server time, hard-deletes every row
//     whose archivedAt < now() - 7 days. The delete is destructive — there's
//     no undo once the row is gone.
//
// Why behind a feature flag (`ENABLE_PROJECT_PURGE`):
//
//   The Project model has dozens of dependent rows (tasks, comments, events,
//   audit-log entries, attachments, ...) and the schema is a mix of `onDelete:
//   Cascade` and default (Restrict) FKs. A naive `prisma.project.delete` will
//   throw P2003 on the first non-cascading child. Doing this safely requires
//   either:
//
//     1. Auditing every FK in schema.prisma and ensuring they all cascade
//        (we want this long term; it's the right Postgres-level invariant
//        but it's also a large schema-migration patch that needs care to
//        avoid corrupting in-flight production data).
//
//     2. A transactional deleteMany across every child table in dependency
//        order, accepting some duplication of schema knowledge in this
//        worker code (cheaper to ship, harder to keep correct as new
//        tables land).
//
//   Until we land option 1 cleanly, the actual delete is gated by an env
//   flag defaulting to `false`. The cron still runs — it logs which projects
//   ARE eligible for purge, so you can verify the grace-window math is right
//   in staging — it just doesn't pull the trigger.
//
//   See projects.service.archive / restore for the soft side of the
//   lifecycle; this is the only place hard-delete should happen.
//
// Lock semantics: wrapped in SchedulerLockService.withLock so multi-replica
// deployments only run one purge per night. The lock TTL (30 min) is well
// above the expected work duration (counting rows + at most a few hundred
// project rows even in busy workspaces).
// =============================================================================

const GRACE_PERIOD_DAYS = 7;

@Injectable()
export class ProjectsPurgeProcessor {
  private readonly logger = new Logger(ProjectsPurgeProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
    private readonly lock: SchedulerLockService,
  ) {}

  /**
   * Daily at 03:00. Matches the spec's "nightly maintenance window" — the
   * AI standup cron at 09:00 picks fresh data, so we want purges to settle
   * before standup queries run.
   */
  @Cron('0 3 * * *')
  async runDailyPurge(): Promise<void> {
    await this.lock.withLock('projects-purge:nightly', 30 * 60_000, async () => {
      await this.purgeOnce();
    });
  }

  /**
   * Extracted for direct test invocation (vi.useFakeTimers can drive
   * `runDailyPurge` but bypassing the lock keeps unit tests free of Redis).
   * Public so tests in projects.service.archive.test.ts can call it
   * without going through the @Cron decorator's metadata.
   */
  async purgeOnce(now: Date = new Date()): Promise<{ scanned: number; purged: number }> {
    const cutoff = new Date(now.getTime() - GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000);
    const eligible = await this.prisma.project.findMany({
      where: { archivedAt: { lt: cutoff } },
      select: { id: true, key: true, archivedAt: true },
    });

    if (eligible.length === 0) {
      this.logger.debug('Project purge: no rows past the 7-day grace window');
      return { scanned: 0, purged: 0 };
    }

    // Surface the audit trail even when the flag is off — operators inspecting
    // the logs in staging want to know exactly which rows WOULD have been
    // deleted before flipping the flag in production.
    this.logger.log(
      `Project purge: ${eligible.length} project(s) eligible for hard-delete (` +
        eligible.map((p) => `${p.key}@${p.archivedAt?.toISOString()}`).join(', ') +
        `)`,
    );

    const enabled =
      (process.env['ENABLE_PROJECT_PURGE'] ?? 'false').toLowerCase() === 'true';
    if (!enabled) {
      this.logger.warn(
        'ENABLE_PROJECT_PURGE is not set — leaving archived rows in place. ' +
          'Audit cascade FKs in schema.prisma before flipping this on.',
      );
      return { scanned: eligible.length, purged: 0 };
    }

    let purged = 0;
    for (const project of eligible) {
      try {
        // Cascade-delete via Prisma. This relies on every child FK pointing
        // at Project being `onDelete: Cascade` — see warning at the top of
        // the file. Wrapped per-row so one malformed child doesn't abort
        // the entire sweep.
        await this.prisma.project.delete({ where: { id: project.id } });
        this.events.emit('project.purged', {
          projectId: project.id,
          key: project.key,
          archivedAt: project.archivedAt,
          purgedAt: now,
        });
        purged += 1;
      } catch (err) {
        this.logger.error(
          `Project purge failed for ${project.key} (${project.id}): ` +
            (err instanceof Error ? err.message : String(err)),
        );
      }
    }

    this.logger.log(`Project purge: hard-deleted ${purged} / ${eligible.length} project(s)`);
    return { scanned: eligible.length, purged };
  }
}
