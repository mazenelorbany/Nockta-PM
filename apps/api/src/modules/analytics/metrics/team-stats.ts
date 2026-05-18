import type { PrismaService } from '../../../prisma/prisma.service';
import type { PermissionsService } from '../../permissions/permissions.service';
import type { AuthenticatedUser } from '../../auth/types';

/**
 * Per-assignee rollup for a single project. Used by the Project Dashboard
 * page: one card per teammate showing how many tasks they own (open / done
 * / blocked / overdue) and how much time they've logged. The "this week"
 * window starts on UTC Monday — same convention as the personal dashboard
 * tile so the numbers line up across views.
 *
 * Unassigned tasks are returned as a synthetic row keyed by `userId: null`
 * so the UI can show "+ N open tasks need an owner" without a second query.
 */
export async function teamStats(
  prisma: PrismaService,
  permissions: PermissionsService,
  actor: AuthenticatedUser,
  projectId: string,
) {
  await permissions.assertAtLeast(actor, projectId, 'Viewer');
  const now = new Date();
  const startOfWeek = new Date(now);
  const dow = startOfWeek.getUTCDay();
  const diff = dow === 0 ? 6 : dow - 1;
  startOfWeek.setUTCDate(startOfWeek.getUTCDate() - diff);
  startOfWeek.setUTCHours(0, 0, 0, 0);

  // Pull every task with just enough fields to bucket it. ~hundreds at most.
  const tasks = await prisma.task.findMany({
    where: { projectId },
    select: {
      assigneeUserId: true,
      status: true,
      isBlocked: true,
      dueDate: true,
      priority: true,
    },
  });

  // Worklog roll-ups in parallel: total seconds per user on this project,
  // plus seconds since start-of-week. Both keyed on task.projectId so we
  // don't double-count time logged on other projects.
  const [totalByUser, weekByUser] = await Promise.all([
    prisma.worklog.groupBy({
      by: ['userId'],
      where: { task: { projectId } },
      _sum: { seconds: true },
    }),
    prisma.worklog.groupBy({
      by: ['userId'],
      where: { task: { projectId }, startedAt: { gte: startOfWeek } },
      _sum: { seconds: true },
    }),
  ]);
  const totalSecondsByUser = new Map<string, number>();
  for (const row of totalByUser) totalSecondsByUser.set(row.userId, Number(row._sum.seconds ?? 0));
  const weekSecondsByUser = new Map<string, number>();
  for (const row of weekByUser) weekSecondsByUser.set(row.userId, Number(row._sum.seconds ?? 0));

  // Hydrate users for everyone who has either a task or a worklog row.
  const userIds = new Set<string>();
  for (const t of tasks) if (t.assigneeUserId) userIds.add(t.assigneeUserId);
  for (const k of totalSecondsByUser.keys()) userIds.add(k);
  const users = await prisma.user.findMany({
    where: { id: { in: Array.from(userIds) } },
    select: { id: true, name: true, email: true, avatarUrl: true, kind: true },
  });
  const userById = new Map(users.map((u) => [u.id, u]));

  // Bucket the tasks per user. `null` is the "unassigned" pseudo-bucket.
  type Row = {
    userId: string | null;
    user: typeof users[number] | null;
    taskCount: number;
    openCount: number;
    doneCount: number;
    inProgressCount: number;
    blockedCount: number;
    overdueCount: number;
    criticalOpen: number;
    highOpen: number;
    timeLoggedSeconds: number;
    timeThisWeekSeconds: number;
  };
  const rows = new Map<string | null, Row>();
  function ensure(id: string | null): Row {
    let r = rows.get(id);
    if (!r) {
      r = {
        userId: id,
        user: id ? userById.get(id) ?? null : null,
        taskCount: 0,
        openCount: 0,
        doneCount: 0,
        inProgressCount: 0,
        blockedCount: 0,
        overdueCount: 0,
        criticalOpen: 0,
        highOpen: 0,
        timeLoggedSeconds: 0,
        timeThisWeekSeconds: 0,
      };
      rows.set(id, r);
    }
    return r;
  }
  for (const t of tasks) {
    const r = ensure(t.assigneeUserId);
    r.taskCount += 1;
    const done = t.status === 'Done' || t.status === 'Approved';
    if (done) r.doneCount += 1;
    else r.openCount += 1;
    if (t.status === 'In Progress') r.inProgressCount += 1;
    if (t.isBlocked) r.blockedCount += 1;
    if (!done && t.dueDate && t.dueDate < now) r.overdueCount += 1;
    if (!done && t.priority === 'Critical') r.criticalOpen += 1;
    if (!done && t.priority === 'High') r.highOpen += 1;
  }
  // Make sure every user with logged time appears even if they currently
  // have zero tasks (e.g. they finished theirs, the boss reassigned them).
  for (const [uid, total] of totalSecondsByUser) {
    const r = ensure(uid);
    r.timeLoggedSeconds = total;
    r.timeThisWeekSeconds = weekSecondsByUser.get(uid) ?? 0;
  }
  // Anyone with tasks but no worklog rows still gets 0s assigned.
  for (const r of rows.values()) {
    if (r.userId && r.timeLoggedSeconds === 0) {
      r.timeLoggedSeconds = totalSecondsByUser.get(r.userId) ?? 0;
      r.timeThisWeekSeconds = weekSecondsByUser.get(r.userId) ?? 0;
    }
  }

  // Sort: assigned users first by openCount desc, then unassigned at the
  // end. The unassigned row is a useful "needs an owner" callout.
  const list = Array.from(rows.values());
  const assigned = list
    .filter((r) => r.userId !== null)
    .sort((a, b) => {
      if (b.openCount !== a.openCount) return b.openCount - a.openCount;
      return (a.user?.name ?? '').localeCompare(b.user?.name ?? '');
    });
  const unassigned = list.filter((r) => r.userId === null);
  return [...assigned, ...unassigned];
}
