import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { SchedulerLockService } from '../../common/scheduling/scheduler-lock.service';
import { PrismaService } from '../../prisma/prisma.service';

// =============================================================================
// CfdSnapshotScheduler — once per day at 00:30 UTC, walks every active project
// and writes one CfdSnapshot row per (project, day, bucket) covering YESTERDAY'S
// end-of-day state. The historical rows are read by
// `analytics.cumulativeFlow` so the CFD endpoint no longer reconstructs every
// task's status timeline from scratch on every render — it just merges the
// stored rows with a single live-computed row for "today".
//
// Why 00:30 UTC? The DigestScheduler fires at 08:00 UTC and the workload
// snapshot at 00:05 UTC. We pick 00:30 to stay clear of those two windows
// (single Redis box, no point fanning out heavy reads at the same instant).
// We also boot-fire 4 minutes after process start so a freshly-deployed
// instance backfills "yesterday" without having to wait until next midnight.
//
// Safety layers (same pattern as the existing schedulers):
//   1. Local `lastFiredOn` short-circuits if we already snapshotted today on
//      this pid.
//   2. Cross-replica SchedulerLockService.withLock('cfd:snapshot', ...) so
//      multi-replica deployments don't double-write.
//
// Pruning: rows older than 90 days are dropped on every tick — bounded
// retention keeps the table small (90 days × ~20 projects × 4 buckets =
// ~7200 rows, trivial).
// =============================================================================

const BUCKETS = ['Backlog', 'In Progress', 'In Review', 'Done'] as const;
type Bucket = (typeof BUCKETS)[number];

/** Same mapping as analytics.cumulativeFlow — keep them in lockstep. */
function bucketFor(status: string): Bucket {
  const lo = status.toLowerCase();
  if (['done', 'approved', 'released', 'closed'].some((t) => lo.includes(t))) return 'Done';
  if (['review', 'testing', 'qa'].some((t) => lo.includes(t))) return 'In Review';
  if (['progress', 'designing', 'doing', 'active'].some((t) => lo.includes(t))) return 'In Progress';
  return 'Backlog';
}

@Injectable()
export class CfdSnapshotScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CfdSnapshotScheduler.name);
  private timer: NodeJS.Timeout | null = null;
  private lastFiredOn: string | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly lock: SchedulerLockService,
  ) {}

  onModuleInit(): void {
    // Stagger boot — 4 min after start so fresh instances backfill yesterday
    // without colliding with the workload snapshot's boot tick (90s).
    setTimeout(() => void this.tick(), 4 * 60_000);
    // Re-check every 5 minutes; tick() short-circuits unless the day window is open.
    this.timer = setInterval(() => void this.tick(), 5 * 60_000);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    const now = new Date();
    const dayKey = now.toISOString().slice(0, 10);
    if (this.lastFiredOn === dayKey) return;

    // Window: fire at 00:30 UTC OR on first boot if we've never run on this pid.
    const isWindowOpen =
      now.getUTCHours() === 0 && now.getUTCMinutes() >= 30;
    if (!isWindowOpen && this.lastFiredOn !== null) return;

    await this.lock.withLock('cfd:snapshot', 15 * 60_000, async () => {
      try {
        await this.snapshotAllActiveProjects(now);
        await this.prune(now);
        this.lastFiredOn = dayKey;
      } catch (err) {
        this.logger.error(
          `CFD snapshot failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });
  }

  /**
   * For every active project, compute the bucket counts as of YESTERDAY's
   * end-of-day (today at 00:00 UTC) and upsert one row per (projectId, date,
   * bucket). "date" is stored as the snapshot day (yesterday) — i.e. the
   * count represents the state at the end of that day.
   */
  private async snapshotAllActiveProjects(now: Date): Promise<void> {
    // Yesterday's end-of-day = today at 00:00 UTC. Stored `date` is yesterday.
    const todayMidnightUtc = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    const snapshotDate = new Date(todayMidnightUtc.getTime() - 24 * 60 * 60_000);
    const cutoffTs = todayMidnightUtc.getTime();

    const projects = await this.prisma.project.findMany({
      where: { archivedAt: null },
      select: { id: true },
    });
    if (projects.length === 0) {
      this.logger.log('CFD snapshot: no active projects');
      return;
    }

    let totalRows = 0;
    for (const p of projects) {
      const counts = await this.computeBucketCountsAt(p.id, cutoffTs);
      for (const b of BUCKETS) {
        await this.prisma.cfdSnapshot.upsert({
          where: {
            projectId_date_bucket: {
              projectId: p.id,
              date: snapshotDate,
              bucket: b,
            },
          },
          update: { count: counts[b] },
          create: {
            projectId: p.id,
            date: snapshotDate,
            bucket: b,
            count: counts[b],
          },
        });
        totalRows += 1;
      }
    }
    this.logger.log(
      `CFD snapshot: wrote ${totalRows} row(s) for ${projects.length} project(s) as of ${snapshotDate
        .toISOString()
        .slice(0, 10)}`,
    );
  }

  /**
   * Reconstruct the per-bucket count for a project at a specific instant by
   * replaying TaskStatusChanged events. Mirrors the live-compute path in
   * analytics.cumulativeFlow so historical and live numbers match.
   */
  async computeBucketCountsAt(
    projectId: string,
    cutoffTs: number,
  ): Promise<Record<Bucket, number>> {
    const out: Record<Bucket, number> = {
      Backlog: 0,
      'In Progress': 0,
      'In Review': 0,
      Done: 0,
    };
    const tasks = await this.prisma.task.findMany({
      where: { projectId },
      select: { id: true, createdAt: true },
    });
    if (tasks.length === 0) return out;

    const events = await this.prisma.event.findMany({
      where: {
        projectId,
        type: 'TaskStatusChanged',
        createdAt: { lte: new Date(cutoffTs) },
      },
      orderBy: { createdAt: 'asc' },
      select: { entityId: true, createdAt: true, payload: true },
    });

    // Build per-task timeline: seed at (createdAt, Todo) then replay events.
    const timelines = new Map<string, { ts: number; status: string }[]>();
    for (const t of tasks) {
      timelines.set(t.id, [{ ts: t.createdAt.getTime(), status: 'Todo' }]);
    }
    for (const e of events) {
      const p = e.payload as Record<string, unknown>;
      const arr = timelines.get(e.entityId);
      if (!arr) continue;
      arr.push({
        ts: e.createdAt.getTime(),
        status: (p['toStatus'] as string) ?? 'Todo',
      });
    }

    for (const t of tasks) {
      const tl = timelines.get(t.id)!;
      if (tl[0]!.ts > cutoffTs) continue; // task didn't exist yet
      // Walk backwards to find the last status <= cutoff.
      let status = 'Todo';
      for (let i = tl.length - 1; i >= 0; i--) {
        if (tl[i]!.ts <= cutoffTs) {
          status = tl[i]!.status;
          break;
        }
      }
      out[bucketFor(status)] += 1;
    }
    return out;
  }

  private async prune(now: Date): Promise<void> {
    const cutoff = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
    const result = await this.prisma.cfdSnapshot.deleteMany({
      where: { date: { lt: cutoff } },
    });
    if (result.count > 0) {
      this.logger.log(`Pruned ${result.count} CFD snapshot row(s) older than 90d`);
    }
  }
}
