import type { PrismaService } from '../../../prisma/prisma.service';
import type { PermissionsService } from '../../permissions/permissions.service';
import type { AuthenticatedUser } from '../../auth/types';

/**
 * Coarse CFD bucket for a raw status string. Shared between the live-compute
 * path in `cumulativeFlow` and the snapshot writer in
 * CfdSnapshotScheduler — keep the two in lockstep.
 */
function bucketForStatus(s: string): 'Backlog' | 'In Progress' | 'In Review' | 'Done' {
  const lo = s.toLowerCase();
  if (['done', 'approved', 'released', 'closed'].some((t) => lo.includes(t))) return 'Done';
  if (['review', 'testing', 'qa'].some((t) => lo.includes(t))) return 'In Review';
  if (['progress', 'designing', 'doing', 'active'].some((t) => lo.includes(t))) return 'In Progress';
  return 'Backlog';
}

/**
 * Returns the per-day count of tasks in each status bucket over the last
 * `days` days. Buckets are normalized to the four high-level lanes: Backlog
 * / In Progress / In Review / Done — matching the all-tasks board axis.
 *
 * Storage strategy (Feature 4):
 *   - For days >= 1 day ago and < `days` days ago, the CfdSnapshot table
 *     holds one row per (projectId, date, bucket). Reading is O(days * 4).
 *   - Today is NOT yet snapshotted (the scheduler at 00:30 UTC writes
 *     yesterday) so we compute it live by replaying TaskStatusChanged
 *     events. Live-compute uses the same logic as CfdSnapshotScheduler so
 *     the seam between stored and live numbers is invisible.
 *
 * If a historical day is missing from CfdSnapshot (e.g. the project was
 * created mid-window, or the scheduler hasn't run yet for a fresh deploy),
 * we fall back to live-replay for the affected days. This keeps the
 * response shape stable so callers like the AnalyticsPage chart never see
 * holes.
 */
export async function cumulativeFlow(
  prisma: PrismaService,
  permissions: PermissionsService,
  actor: AuthenticatedUser,
  projectId: string,
  days = 30,
) {
  await permissions.assertAtLeast(actor, projectId, 'Viewer');

  const tasks = await prisma.task.findMany({
    where: { projectId },
    select: { id: true, status: true, createdAt: true },
  });
  if (tasks.length === 0) return { days, series: [] };

  // Today (UTC midnight) anchors the window. The series covers
  // [today - days, today], oldest → newest. `days` ago through yesterday
  // are candidates for snapshot lookup; today is always live.
  const now = new Date();
  const todayUtc = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const earliestDate = new Date(todayUtc.getTime() - days * 24 * 60 * 60_000);

  // Fetch every snapshot row in the window in ONE query. Skip today — we
  // always compute it live so a stale row from a missed invalidation can't
  // poison the response.
  const yesterdayUtc = new Date(todayUtc.getTime() - 24 * 60 * 60_000);
  const snapshots = await prisma.cfdSnapshot.findMany({
    where: {
      projectId,
      date: { gte: earliestDate, lte: yesterdayUtc },
    },
    select: { date: true, bucket: true, count: true },
  });

  // Index: dateKey -> { Backlog, In Progress, In Review, Done }.
  type BucketRow = { backlog: number; inProgress: number; inReview: number; done: number };
  const snapMap = new Map<string, BucketRow>();
  function ensure(key: string): BucketRow {
    let r = snapMap.get(key);
    if (!r) {
      r = { backlog: 0, inProgress: 0, inReview: 0, done: 0 };
      snapMap.set(key, r);
    }
    return r;
  }
  for (const s of snapshots) {
    const key = s.date.toISOString().slice(0, 10);
    const row = ensure(key);
    if (s.bucket === 'Backlog') row.backlog = s.count;
    else if (s.bucket === 'In Progress') row.inProgress = s.count;
    else if (s.bucket === 'In Review') row.inReview = s.count;
    else if (s.bucket === 'Done') row.done = s.count;
  }

  // Live-replay setup — only needed if (a) we have to compute "today" OR
  // (b) any historical day is missing from snapshots. Build the timelines
  // once and reuse them for every cutoff we have to fall back on.
  let timelines: Map<string, { ts: number; status: string }[]> | null = null;
  const buildTimelinesIfNeeded = async (): Promise<Map<string, { ts: number; status: string }[]>> => {
    if (timelines) return timelines;
    const events = await prisma.event.findMany({
      where: { projectId, type: 'TaskStatusChanged', createdAt: { gte: earliestDate } },
      orderBy: { createdAt: 'asc' },
      select: { entityId: true, createdAt: true, payload: true },
    });
    const tl = new Map<string, { ts: number; status: string }[]>();
    for (const t of tasks) {
      tl.set(t.id, [{ ts: t.createdAt.getTime(), status: 'Todo' }]);
    }
    for (const e of events) {
      const p = e.payload as Record<string, unknown>;
      const arr = tl.get(e.entityId);
      if (!arr) continue;
      arr.push({ ts: e.createdAt.getTime(), status: (p['toStatus'] as string) ?? 'Todo' });
    }
    timelines = tl;
    return tl;
  };

  const computeAt = async (cutoffTs: number): Promise<BucketRow> => {
    const tl = await buildTimelinesIfNeeded();
    const row: BucketRow = { backlog: 0, inProgress: 0, inReview: 0, done: 0 };
    for (const t of tasks) {
      const timeline = tl.get(t.id)!;
      if (timeline[0]!.ts > cutoffTs) continue; // task didn't exist yet
      let status = 'Todo';
      for (let i = timeline.length - 1; i >= 0; i--) {
        if (timeline[i]!.ts <= cutoffTs) {
          status = timeline[i]!.status;
          break;
        }
      }
      const b = bucketForStatus(status);
      if (b === 'Backlog') row.backlog += 1;
      else if (b === 'In Progress') row.inProgress += 1;
      else if (b === 'In Review') row.inReview += 1;
      else row.done += 1;
    }
    return row;
  };

  // Walk every day in the window, oldest → newest, preferring snapshot
  // hits and falling back to live-compute for misses + today.
  const series: { date: string; backlog: number; inProgress: number; inReview: number; done: number }[] = [];
  for (let d = 0; d <= days; d++) {
    const dayDate = new Date(earliestDate.getTime() + d * 24 * 60 * 60_000);
    const dateKey = dayDate.toISOString().slice(0, 10);
    const isToday = dayDate.getTime() === todayUtc.getTime();

    let row: BucketRow | undefined;
    if (!isToday) {
      row = snapMap.get(dateKey);
    }
    if (!row) {
      // Either today OR a snapshot miss — recompute. The cutoff for a
      // given day is its end-of-day (i.e. the NEXT day's 00:00 UTC) so
      // every status change made during that day is included.
      const cutoffTs = dayDate.getTime() + 24 * 60 * 60_000;
      row = await computeAt(Math.min(cutoffTs, Date.now()));
    }
    series.push({ date: dateKey, ...row });
  }
  return { days, series };
}
