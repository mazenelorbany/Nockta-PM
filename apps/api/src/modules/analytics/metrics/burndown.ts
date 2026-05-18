import type { PrismaService } from '../../../prisma/prisma.service';
import type { PermissionsService } from '../../permissions/permissions.service';
import type { AuthenticatedUser } from '../../auth/types';

export async function burndown(
  prisma: PrismaService,
  permissions: PermissionsService,
  actor: AuthenticatedUser,
  sprintId: string,
) {
  const sprint = await prisma.sprint.findUniqueOrThrow({
    where: { id: sprintId },
    include: {
      // The full membership history: every (taskId, addedAt, removedAt)
      // tuple. A single task can have multiple rows if it was removed and
      // re-added later — we treat each as a separate scope window.
      memberships: {
        include: { task: { select: { id: true, estimate: true } } },
        orderBy: { addedAt: 'asc' },
      },
    },
  });
  await permissions.assertAtLeast(actor, sprint.projectId, 'Viewer');

  if (sprint.memberships.length === 0) {
    return { points: [], totalTasks: 0 };
  }

  const start = sprint.startDate ?? sprint.createdAt;
  // For completed sprints, the x-axis caps at endDate so the chart doesn't
  // extend a flat line to today (the old `end ?? new Date()` bug). For
  // active sprints we extend to "now" — that's where the trajectory is
  // actually being judged from.
  const isCompleted = sprint.state === 'completed';
  const end = isCompleted
    ? (sprint.endDate ?? new Date())
    : (sprint.endDate && sprint.endDate.getTime() < Date.now()
        ? sprint.endDate
        : new Date());
  const dayCount = Math.max(
    1,
    Math.ceil((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000)),
  );

  // Collect the unique task IDs that were EVER members. The same task may
  // appear in multiple memberships; we still only count it once per day
  // if at least one membership window covers that day.
  const taskIds = Array.from(
    new Set(sprint.memberships.map((m) => m.taskId)),
  );

  // Build per-task status timelines from TaskStatusChanged events, same as
  // before. The change vs the old implementation is that we no longer
  // assume `sprint.tasks` reflects historical scope; instead we use
  // membership windows to decide whether to count the task on a given day.
  const events = await prisma.event.findMany({
    where: { entityType: 'Task', entityId: { in: taskIds }, type: 'TaskStatusChanged' },
    orderBy: { createdAt: 'asc' },
  });

  const taskTimelines = new Map<string, { ts: number; status: string }[]>();
  // Seed every task at "Todo" at its creation time. We don't have a clean
  // "status at sprint-add time" record; Todo is the most defensible default
  // because newly-created tasks always start there and any subsequent
  // status change emits an event we'll observe below.
  for (const tid of taskIds) {
    taskTimelines.set(tid, [{ ts: 0, status: 'Todo' }]);
  }
  for (const e of events) {
    const p = e.payload as Record<string, unknown>;
    const arr = taskTimelines.get(e.entityId);
    if (!arr) continue;
    arr.push({ ts: e.createdAt.getTime(), status: (p['toStatus'] as string) ?? 'Todo' });
  }

  // Build per-task membership windows. A task counts toward sprint scope
  // on day t iff at least one of its membership rows satisfies
  // `addedAt <= t AND (removedAt IS NULL OR removedAt > t)`.
  type Window = { from: number; to: number };
  const windowsByTask = new Map<string, Window[]>();
  for (const m of sprint.memberships) {
    const arr = windowsByTask.get(m.taskId) ?? [];
    arr.push({
      from: m.addedAt.getTime(),
      to: m.removedAt?.getTime() ?? Number.POSITIVE_INFINITY,
    });
    windowsByTask.set(m.taskId, arr);
  }
  const estimateByTask = new Map<string, number>();
  for (const m of sprint.memberships) {
    if (!estimateByTask.has(m.taskId)) {
      estimateByTask.set(m.taskId, m.task.estimate ?? 0);
    }
  }

  function wasInScopeAt(taskId: string, ts: number): boolean {
    const arr = windowsByTask.get(taskId);
    if (!arr) return false;
    for (const w of arr) {
      if (ts >= w.from && ts < w.to) return true;
    }
    return false;
  }

  const points: { date: string; remaining: number; remainingEstimate: number }[] = [];
  for (let day = 0; day <= dayCount; day++) {
    const cutoff = start.getTime() + day * 24 * 60 * 60 * 1000;
    let remaining = 0;
    let remainingEstimate = 0;
    for (const tid of taskIds) {
      if (!wasInScopeAt(tid, cutoff)) continue;
      const timeline = taskTimelines.get(tid)!;
      const lastBefore = [...timeline].reverse().find((p) => p.ts <= cutoff);
      const status = lastBefore?.status ?? 'Todo';
      if (status !== 'Done' && status !== 'Approved') {
        remaining += 1;
        remainingEstimate += estimateByTask.get(tid) ?? 0;
      }
    }
    points.push({
      date: new Date(cutoff).toISOString().split('T')[0]!,
      remaining,
      remainingEstimate,
    });
  }
  return { points, totalTasks: taskIds.length };
}
