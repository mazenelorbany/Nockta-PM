import { ForbiddenException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { PermissionsService } from '../permissions/permissions.service';
import type { AuthenticatedUser } from '../auth/types';

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

@Injectable()
export class AnalyticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionsService,
  ) {}

  // ---------------- Personal dashboard ----------------

  async personal(actor: AuthenticatedUser) {
    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    // Start-of-this-week (Monday) in UTC. We don't honour user TZ here — a 1-day
    // edge case is acceptable for a personal dashboard widget.
    const startOfWeek = new Date(now);
    const dow = startOfWeek.getUTCDay(); // 0=Sun..6=Sat
    const diff = dow === 0 ? 6 : dow - 1;
    startOfWeek.setUTCDate(startOfWeek.getUTCDate() - diff);
    startOfWeek.setUTCHours(0, 0, 0, 0);

    const [openByPriority, overdue, watching, recentMentions, weekSeconds, weekByDay, userPrefs] = await Promise.all([
      this.prisma.task.groupBy({
        by: ['priority'],
        where: { assigneeUserId: actor.id, status: { notIn: ['Done', 'Approved'] } },
        _count: true,
      }),
      this.prisma.task.count({
        where: {
          assigneeUserId: actor.id,
          dueDate: { lt: now },
          status: { notIn: ['Done', 'Approved'] },
        },
      }),
      this.prisma.taskWatcher.count({ where: { userId: actor.id } }),
      this.prisma.commentMention.count({
        where: { userId: actor.id, comment: { createdAt: { gte: sevenDaysAgo } } },
      }),
      this.prisma.worklog.aggregate({
        where: { userId: actor.id, startedAt: { gte: startOfWeek } },
        _sum: { seconds: true },
      }),
      this.prisma.$queryRaw<{ day: Date; seconds: bigint }[]>`
        SELECT date_trunc('day', "startedAt") AS day, SUM("seconds")::bigint AS seconds
        FROM "Worklog"
        WHERE "userId" = ${actor.id}::uuid AND "startedAt" >= ${startOfWeek}
        GROUP BY 1
        ORDER BY 1 ASC
      `,
      this.prisma.user.findUnique({
        where: { id: actor.id },
        select: { weeklyHoursTarget: true },
      }),
    ]);

    const weeklyHoursTarget = userPrefs?.weeklyHoursTarget ?? null;
    const targetSeconds = weeklyHoursTarget !== null ? weeklyHoursTarget * 3600 : null;
    const totalWeekSeconds = weekSeconds._sum.seconds ?? 0;

    // Streak — only computed when the user actually set a target. Counts back
    // through prior ISO weeks (Mon-Sun in UTC) and tallies how many of them
    // hit `>= target`, stopping on the first miss. The current in-flight week
    // counts only if the user ALREADY hit the target this week (so a fresh
    // Monday morning doesn't show "streak 5" and then drop to 4 on Sunday).
    const streakWeeks = targetSeconds !== null
      ? await this.computeWeeklyStreak(actor.id, startOfWeek, totalWeekSeconds, targetSeconds)
      : 0;

    return {
      openByPriority: openByPriority.map((p) => ({ priority: p.priority, count: p._count })),
      overdueCount: overdue,
      watchingCount: watching,
      mentionsLast7Days: recentMentions,
      timeThisWeek: {
        totalSeconds: totalWeekSeconds,
        byDay: weekByDay.map((r) => ({
          day: r.day.toISOString().slice(0, 10),
          seconds: Number(r.seconds),
        })),
      },
      weeklyTarget: weeklyHoursTarget !== null
        ? {
            hours: weeklyHoursTarget,
            secondsLogged: totalWeekSeconds,
            secondsTarget: targetSeconds ?? 0,
            hit: targetSeconds !== null && totalWeekSeconds >= targetSeconds,
            streakWeeks,
          }
        : null,
    };
  }

  /**
   * Walk back through ISO-week buckets (Monday-anchored, UTC) and count
   * consecutive weeks where the user met `targetSeconds`. The current week
   * only counts when it's ALREADY hit — a Monday-morning render shouldn't
   * inflate the streak.
   *
   * Implementation: pull the last ~26 weeks of Worklog rows in one query,
   * bucket client-side. Capped at 26 to bound memory; longer streaks render
   * as "26+".
   */
  private async computeWeeklyStreak(
    userId: string,
    startOfThisWeek: Date,
    totalThisWeekSeconds: number,
    targetSeconds: number,
  ): Promise<number> {
    const HORIZON_WEEKS = 26;
    const earliest = new Date(startOfThisWeek.getTime() - HORIZON_WEEKS * 7 * 24 * 60 * 60 * 1000);
    const rows = await this.prisma.$queryRaw<{ week_start: Date; seconds: bigint }[]>`
      SELECT date_trunc('week', "startedAt") AS week_start, SUM("seconds")::bigint AS seconds
      FROM "Worklog"
      WHERE "userId" = ${userId}::uuid
        AND "startedAt" >= ${earliest}
        AND "startedAt" < ${startOfThisWeek}
      GROUP BY 1
      ORDER BY 1 DESC
    `;
    // Postgres date_trunc('week', ...) returns Monday 00:00 UTC.
    const seenWeeks = new Map<number, number>();
    for (const r of rows) {
      seenWeeks.set(r.week_start.getTime(), Number(r.seconds));
    }

    let streak = 0;
    // Optionally include the current week if it's ALREADY met the target.
    if (totalThisWeekSeconds >= targetSeconds) {
      streak += 1;
    }
    // Walk backward from "last week" until we miss.
    const weekMs = 7 * 24 * 60 * 60 * 1000;
    for (let i = 1; i <= HORIZON_WEEKS; i++) {
      const wk = new Date(startOfThisWeek.getTime() - i * weekMs).getTime();
      const got = seenWeeks.get(wk) ?? 0;
      if (got >= targetSeconds) {
        streak += 1;
      } else {
        break;
      }
    }
    return streak;
  }

  // ---------------- Project dashboard ----------------

  async project(actor: AuthenticatedUser, projectId: string) {
    await this.permissions.assertAtLeast(actor, projectId, 'Viewer');
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const [byStatus, overdue, blocked, activeSprint, deploys] = await Promise.all([
      this.prisma.task.groupBy({
        by: ['status'],
        where: { projectId },
        _count: true,
      }),
      this.prisma.task.count({
        where: { projectId, dueDate: { lt: now }, status: { notIn: ['Done', 'Approved'] } },
      }),
      this.prisma.task.count({ where: { projectId, isBlocked: true } }),
      this.prisma.sprint.findFirst({
        where: { projectId, state: 'active' },
        include: { _count: { select: { tasks: true } } },
      }),
      this.prisma.deployment.findMany({
        where: { projectId, startedAt: { gte: thirtyDaysAgo } },
        select: { status: true },
      }),
    ]);

    const succeeded = deploys.filter((d) => d.status === 'succeeded').length;
    const failed = deploys.filter((d) => d.status === 'failed').length;
    const total = deploys.length;

    const [velocity, cycleTime] = await Promise.all([
      this.sprintVelocity(projectId),
      this.cycleTime(projectId, thirtyDaysAgo),
    ]);

    return {
      byStatus: byStatus.map((s) => ({ status: s.status, count: s._count })),
      overdueCount: overdue,
      blockedCount: blocked,
      activeSprint,
      deploymentsLast30Days: {
        total,
        succeeded,
        failed,
        successRate: total > 0 ? Math.round((succeeded / total) * 100) : null,
      },
      sprintVelocity: velocity,
      avgCycleTimeHours: cycleTime,
    };
  }

  // ---------------- Per-project team stats ----------------

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
  async teamStats(actor: AuthenticatedUser, projectId: string) {
    await this.permissions.assertAtLeast(actor, projectId, 'Viewer');
    const now = new Date();
    const startOfWeek = new Date(now);
    const dow = startOfWeek.getUTCDay();
    const diff = dow === 0 ? 6 : dow - 1;
    startOfWeek.setUTCDate(startOfWeek.getUTCDate() - diff);
    startOfWeek.setUTCHours(0, 0, 0, 0);

    // Pull every task with just enough fields to bucket it. ~hundreds at most.
    const tasks = await this.prisma.task.findMany({
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
      this.prisma.worklog.groupBy({
        by: ['userId'],
        where: { task: { projectId } },
        _sum: { seconds: true },
      }),
      this.prisma.worklog.groupBy({
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
    const users = await this.prisma.user.findMany({
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

  // ---------------- Org dashboard (Admin only) ----------------

  async org(actor: AuthenticatedUser) {
    if (!(actor.kind === 'internal' && actor.companyRole === 'Admin')) {
      throw new ForbiddenException('Admin only');
    }
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const [activeProjects, activeEngineers, blockedOrgWide, deploymentsLast30, workloadByAssignee] = await Promise.all([
      this.prisma.project.count({ where: { archivedAt: null } }),
      this.prisma.user.count({ where: { kind: 'internal', archivedAt: null } }),
      this.prisma.task.count({ where: { isBlocked: true } }),
      this.prisma.deployment.findMany({
        where: { startedAt: { gte: thirtyDaysAgo } },
        select: { status: true },
      }),
      this.prisma.task.groupBy({
        by: ['assigneeUserId'],
        where: { status: { notIn: ['Done', 'Approved'] }, assigneeUserId: { not: null } },
        _count: true,
      }),
    ]);

    const succeeded = deploymentsLast30.filter((d) => d.status === 'succeeded').length;

    return {
      activeProjects,
      activeEngineers,
      blockedTasks: blockedOrgWide,
      deploymentsLast30Days: {
        total: deploymentsLast30.length,
        succeeded,
        successRate:
          deploymentsLast30.length > 0
            ? Math.round((succeeded / deploymentsLast30.length) * 100)
            : null,
      },
      workloadTop: workloadByAssignee
        .sort((a, b) => b._count - a._count)
        .slice(0, 20)
        .map((w) => ({ userId: w.assigneeUserId, openTasks: w._count })),
    };
  }

  // ---------------- Sprint burndown ----------------

  async burndown(actor: AuthenticatedUser, sprintId: string) {
    const sprint = await this.prisma.sprint.findUniqueOrThrow({
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
    await this.permissions.assertAtLeast(actor, sprint.projectId, 'Viewer');

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
    const events = await this.prisma.event.findMany({
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

  // ---------------- Per-project worklog report ----------------

  /**
   * Per-member worklog matrix for a single project, bucketed by week. Rows are
   * the teammates who logged time on the project's tasks; columns are the last
   * `weeks` ISO weeks (Monday-start, UTC), oldest → newest. Cells hold seconds
   * logged in that week.
   *
   * The week bucket is computed in SQL via `date_trunc('week', ...)` which is
   * Postgres-native and uses Monday as the week start — matching the rest of
   * the codebase (personal dashboard, team-stats start-of-week).
   *
   * Returns rows sorted by total descending; users with zero seconds across
   * the window are filtered out so the table doesn't show empty rows.
   */
  async worklogReport(
    actor: AuthenticatedUser,
    projectId: string,
    weeks: number,
  ): Promise<{
    weekStartsUTC: string[];
    rows: Array<{
      user: { id: string; name: string; email: string; avatarUrl: string | null };
      cells: number[];
      totalSeconds: number;
    }>;
  }> {
    await this.permissions.assertAtLeast(actor, projectId, 'Viewer');
    const clampedWeeks = Math.min(52, Math.max(1, Math.floor(weeks) || 12));

    // Compute the start-of-window: Monday of (clampedWeeks - 1) weeks ago, UTC.
    const now = new Date();
    const dow = now.getUTCDay();
    const diff = dow === 0 ? 6 : dow - 1;
    const thisWeekStart = new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() - diff,
    ));
    const windowStart = new Date(thisWeekStart);
    windowStart.setUTCDate(windowStart.getUTCDate() - (clampedWeeks - 1) * 7);

    // Build the ordered list of week-start ISO dates (oldest → newest).
    const weekStartsUTC: string[] = [];
    const weekIndexByISO = new Map<string, number>();
    for (let i = 0; i < clampedWeeks; i++) {
      const d = new Date(windowStart);
      d.setUTCDate(d.getUTCDate() + i * 7);
      const iso = d.toISOString().slice(0, 10);
      weekStartsUTC.push(iso);
      weekIndexByISO.set(iso, i);
    }

    // Raw SQL: groupBy userId + date_trunc('week', startedAt). Prisma's
    // groupBy can't accept an expression so we drop to $queryRaw. The cast
    // to ::date matches the ISO-string output we use as the bucket key.
    const rawRows = await this.prisma.$queryRaw<{
      userId: string;
      weekStart: Date;
      seconds: bigint;
    }[]>`
      SELECT w."userId" AS "userId",
             date_trunc('week', w."startedAt") AS "weekStart",
             SUM(w."seconds")::bigint AS seconds
      FROM "Worklog" w
      JOIN "Task" t ON t.id = w."taskId"
      WHERE t."projectId" = ${projectId}::uuid
        AND w."startedAt" >= ${windowStart}
      GROUP BY w."userId", date_trunc('week', w."startedAt")
    `;

    // Fold the rows into per-user cell arrays. Use the same ISO-date format
    // as the column keys; date_trunc returns Monday 00:00 UTC.
    type Acc = { cells: number[]; total: number };
    const byUser = new Map<string, Acc>();
    for (const r of rawRows) {
      const iso = r.weekStart.toISOString().slice(0, 10);
      const colIdx = weekIndexByISO.get(iso);
      // Defensive: ignore rows that fall outside our generated bucket list
      // (could happen if windowStart drifted by a day across DST boundaries
      // since Postgres date_trunc is timezone-aware on `timestamp with time
      // zone`. Practically a non-issue with UTC inputs.)
      if (colIdx === undefined) continue;
      const seconds = Number(r.seconds);
      let acc = byUser.get(r.userId);
      if (!acc) {
        acc = { cells: new Array(clampedWeeks).fill(0), total: 0 };
        byUser.set(r.userId, acc);
      }
      acc.cells[colIdx] = (acc.cells[colIdx] ?? 0) + seconds;
      acc.total += seconds;
    }

    if (byUser.size === 0) {
      return { weekStartsUTC, rows: [] };
    }

    const users = await this.prisma.user.findMany({
      where: { id: { in: Array.from(byUser.keys()) } },
      select: { id: true, name: true, email: true, avatarUrl: true },
    });
    const userById = new Map(users.map((u) => [u.id, u]));

    const rows = Array.from(byUser.entries())
      .map(([userId, acc]) => {
        const u = userById.get(userId);
        if (!u) return null;
        return {
          user: { id: u.id, name: u.name, email: u.email, avatarUrl: u.avatarUrl },
          cells: acc.cells,
          totalSeconds: acc.total,
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null && r.totalSeconds > 0)
      .sort((a, b) => b.totalSeconds - a.totalSeconds);

    return { weekStartsUTC, rows };
  }

  // ---------------- Workload (cross-project) ----------------

  /**
   * Per-person open-task workload across every project the actor can see.
   * Returns counts + sum of estimates + a priority-weighted "load" score so
   * Critical/High items can be visually weighted in the UI.
   */
  async workload(actor: AuthenticatedUser, opts: { projectId?: string; teamId?: string } = {}) {
    if (actor.kind !== 'internal') {
      throw new ForbiddenException('Internal only');
    }
    const projectIds = opts.projectId
      ? [opts.projectId]
      : await this.accessibleProjectIds(actor);
    if (projectIds.length === 0) return { rows: [] };

    // If a team is supplied, only include that team's members.
    let userIdFilter: string[] | undefined;
    if (opts.teamId) {
      const members = await this.prisma.teamMember.findMany({
        where: { teamId: opts.teamId }, select: { userId: true },
      });
      userIdFilter = members.map((m) => m.userId);
      if (userIdFilter.length === 0) return { rows: [] };
    }

    const grouped = await this.prisma.task.groupBy({
      by: ['assigneeUserId', 'priority'],
      where: {
        projectId: { in: projectIds },
        status: { notIn: ['Done', 'Approved'] },
        assigneeUserId: userIdFilter ? { in: userIdFilter } : { not: null },
      },
      _count: { _all: true },
      _sum: { estimate: true },
    });

    // Reshape into per-user rows.
    type Row = {
      userId: string;
      total: number;
      points: number;
      byPriority: { Critical: number; High: number; Medium: number; Low: number };
      loadScore: number;
    };
    const map = new Map<string, Row>();
    const weights = { Critical: 4, High: 3, Medium: 2, Low: 1 };
    for (const g of grouped) {
      if (!g.assigneeUserId) continue;
      const row = map.get(g.assigneeUserId) ?? {
        userId: g.assigneeUserId,
        total: 0,
        points: 0,
        byPriority: { Critical: 0, High: 0, Medium: 0, Low: 0 },
        loadScore: 0,
      };
      row.total += g._count._all;
      row.points += g._sum.estimate ?? 0;
      row.byPriority[g.priority] = g._count._all;
      row.loadScore += g._count._all * weights[g.priority];
      map.set(g.assigneeUserId, row);
    }
    const rows = Array.from(map.values()).sort((a, b) => b.loadScore - a.loadScore);

    // Hydrate with names.
    const users = await this.prisma.user.findMany({
      where: { id: { in: rows.map((r) => r.userId) } },
      select: { id: true, name: true, email: true, avatarUrl: true },
    });
    const userMap = new Map(users.map((u) => [u.id, u]));

    // Read the last 7 days of DailyWorkloadSnapshot for every user in the
    // result set. The scheduler at WorkloadSnapshotScheduler writes one row
    // per (user, day) at 00:05 UTC; today's count is implicit from the
    // current `r.total`. Missing days (the user had zero open work that
    // day) are filled with 0.
    const userIds = rows.map((r) => r.userId);
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const snapshots = userIds.length > 0
      ? await this.prisma.dailyWorkloadSnapshot.findMany({
          where: { userId: { in: userIds }, date: { gte: sevenDaysAgo } },
          select: { userId: true, date: true, openTasksCount: true },
        })
      : [];
    // Build a (userId, dateKey) → count map for O(1) lookup.
    const snapMap = new Map<string, number>();
    for (const s of snapshots) {
      const key = `${s.userId}::${s.date.toISOString().slice(0, 10)}`;
      snapMap.set(key, s.openTasksCount);
    }
    // For each user, build a 7-element series oldest→newest. Today (index 6)
    // uses the live `r.total` rather than the snapshot — the snapshot is
    // written at 00:05 UTC and we want the latest live count to drive the
    // most-recent sparkline point.
    function buildSeries(userId: string, todayTotal: number): number[] {
      const out: number[] = [];
      for (let i = 6; i >= 0; i--) {
        const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
        const dateKey = d.toISOString().slice(0, 10);
        if (i === 0) {
          out.push(todayTotal);
        } else {
          out.push(snapMap.get(`${userId}::${dateKey}`) ?? 0);
        }
      }
      return out;
    }

    return {
      rows: rows.map((r) => ({
        ...r,
        user: userMap.get(r.userId) ?? null,
        series: buildSeries(r.userId, r.total),
      })),
    };
  }

  /**
   * Drill-down for one person on the /workload page. Returns their open task
   * list (with project + priority + due-date for routing into the task
   * drawer), priority + status breakdowns, overdue / due-soon counts, and a
   * 30-day completion trend so the modal can show speed alongside load.
   *
   * Scoped to projects the actor can read — a client user opening the
   * modal won't see internal tasks. Internal-only for parity with workload().
   */
  async workloadDetail(actor: AuthenticatedUser, userId: string) {
    if (actor.kind !== 'internal') {
      throw new ForbiddenException('Internal only');
    }
    const projectIds = await this.accessibleProjectIds(actor);
    const now = new Date();
    const sevenDaysAhead = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, email: true, avatarUrl: true },
    });

    if (projectIds.length === 0 || !user) {
      return {
        user,
        summary: { total: 0, points: 0, loadScore: 0, byPriority: { Critical: 0, High: 0, Medium: 0, Low: 0 } },
        byStatus: [],
        overdueCount: 0,
        dueSoonCount: 0,
        openTasks: [],
        completionTrend: this.emptyDailyTrend(thirtyDaysAgo, now),
      };
    }

    const [openTasksRaw, doneEvents] = await Promise.all([
      this.prisma.task.findMany({
        where: {
          assigneeUserId: userId,
          projectId: { in: projectIds },
          status: { notIn: ['Done', 'Approved'] },
        },
        select: {
          id: true,
          keyNumber: true,
          title: true,
          status: true,
          priority: true,
          isBlocked: true,
          dueDate: true,
          estimate: true,
          updatedAt: true,
          project: { select: { id: true, key: true, name: true } },
        },
        orderBy: [{ priority: 'asc' }, { dueDate: 'asc' }, { updatedAt: 'desc' }],
      }),
      this.prisma.event.findMany({
        where: {
          type: 'TaskStatusChanged',
          actorUserId: userId,
          projectId: { in: projectIds },
          createdAt: { gte: thirtyDaysAgo },
        },
        select: { createdAt: true, payload: true },
      }),
    ]);

    // --- Summary (mirrors the row math in workload()) ---
    const weights = { Critical: 4, High: 3, Medium: 2, Low: 1 } as const;
    const byPriority = { Critical: 0, High: 0, Medium: 0, Low: 0 };
    const byStatusMap = new Map<string, number>();
    let points = 0;
    let loadScore = 0;
    let overdueCount = 0;
    let dueSoonCount = 0;
    for (const t of openTasksRaw) {
      byPriority[t.priority] += 1;
      loadScore += weights[t.priority];
      points += t.estimate ?? 0;
      byStatusMap.set(t.status, (byStatusMap.get(t.status) ?? 0) + 1);
      if (t.dueDate) {
        if (t.dueDate < now) overdueCount += 1;
        else if (t.dueDate < sevenDaysAhead) dueSoonCount += 1;
      }
    }

    // --- 30-day completion trend ---
    // Count TaskStatusChanged events where the actor moved a task to a
    // terminal status. Keyed on the actor (not the assignee) so credit goes
    // to whoever did the merge/approval, matching how /workload itself
    // measures "open" by current assignment.
    const completionsByDay = new Map<string, number>();
    for (const e of doneEvents) {
      const p = (e.payload ?? {}) as Record<string, unknown>;
      const to = p['toStatus'];
      if (to !== 'Done' && to !== 'Approved') continue;
      const key = e.createdAt.toISOString().slice(0, 10);
      completionsByDay.set(key, (completionsByDay.get(key) ?? 0) + 1);
    }
    const completionTrend = this.emptyDailyTrend(thirtyDaysAgo, now).map((d) => ({
      date: d.date,
      completed: completionsByDay.get(d.date) ?? 0,
    }));

    return {
      user,
      summary: {
        total: openTasksRaw.length,
        points,
        loadScore,
        byPriority,
      },
      byStatus: Array.from(byStatusMap.entries())
        .map(([status, count]) => ({ status, count }))
        .sort((a, b) => b.count - a.count),
      overdueCount,
      dueSoonCount,
      openTasks: openTasksRaw.map((t) => ({
        id: t.id,
        keyNumber: t.keyNumber,
        title: t.title,
        status: t.status,
        priority: t.priority,
        isBlocked: t.isBlocked,
        dueDate: t.dueDate?.toISOString() ?? null,
        estimate: t.estimate,
        project: t.project,
      })),
      completionTrend,
    };
  }

  /** 30-element [{date}] series oldest→newest, used as a base for trend fills. */
  private emptyDailyTrend(from: Date, to: Date): { date: string; completed: number }[] {
    const out: { date: string; completed: number }[] = [];
    const fromDay = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
    const toDay = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate()));
    for (let d = new Date(fromDay); d <= toDay; d.setUTCDate(d.getUTCDate() + 1)) {
      out.push({ date: d.toISOString().slice(0, 10), completed: 0 });
    }
    return out;
  }

  // ---------------- Sprint goal hit-rate (Pass I) ----------------

  /**
   * Across all completed sprints in a project (optionally filtered by
   * `since`), how many had a SprintGoalEvaluation row with goalAchieved=true?
   * Pass I — Sprints 8 → 9.
   *
   * The numerator is "sprints with goalAchieved=true". The denominator is
   * "completed sprints with any evaluation row" so a project that doesn't
   * use the evaluation feature yet doesn't get a misleading 0% — it gets a
   * `totalEvaluated: 0` and `rate: null` and the UI hides the badge.
   *
   * `since` filters by Sprint.endDate (the canonical "when did this sprint
   * close" timestamp). Sprints without an endDate are excluded — they're
   * either still in flight or were force-deleted and never closed cleanly.
   */
  async goalHitRate(
    actor: AuthenticatedUser,
    projectId: string,
    since?: Date,
  ): Promise<{
    totalSprints: number;
    totalEvaluated: number;
    goalsAchieved: number;
    rate: number | null;
    series: Array<{ sprintId: string; name: string; endDate: string | null; goalAchieved: boolean | null }>;
  }> {
    await this.permissions.assertAtLeast(actor, projectId, 'Viewer');
    const sprints = await this.prisma.sprint.findMany({
      where: {
        projectId,
        state: 'completed',
        ...(since ? { endDate: { gte: since } } : {}),
      },
      orderBy: { endDate: 'asc' },
      include: {
        goalEval: { select: { goalAchieved: true } },
      },
    });

    const totalSprints = sprints.length;
    const evaluated = sprints.filter((s) => s.goalEval !== null);
    const goalsAchieved = evaluated.filter((s) => s.goalEval?.goalAchieved === true).length;
    const totalEvaluated = evaluated.length;
    const rate = totalEvaluated > 0 ? goalsAchieved / totalEvaluated : null;

    return {
      totalSprints,
      totalEvaluated,
      goalsAchieved,
      rate,
      series: sprints.map((s) => ({
        sprintId: s.id,
        name: s.name,
        endDate: s.endDate?.toISOString() ?? null,
        goalAchieved: s.goalEval?.goalAchieved ?? null,
      })),
    };
  }

  // ---------------- Velocity (richer report) ----------------

  /**
   * Velocity history with computed average + naive next-sprint projection.
   * Used by the Analytics page chart. Returns oldest→newest sprints.
   */
  async velocity(actor: AuthenticatedUser, projectId: string) {
    await this.permissions.assertAtLeast(actor, projectId, 'Viewer');
    const sprints = await this.sprintVelocity(projectId);
    if (sprints.length === 0) {
      return { sprints: [], averageCount: 0, averageEstimate: 0, projectedNext: null };
    }
    const sumCount = sprints.reduce((acc, s) => acc + s.completedCount, 0);
    const sumEst = sprints.reduce((acc, s) => acc + s.completedEstimate, 0);
    const averageCount = sumCount / sprints.length;
    const averageEstimate = sumEst / sprints.length;
    // Light EWMA so the most recent 1-2 sprints carry more weight than 6
    // weeks ago. Alpha 0.4 = ~5-sprint half-life.
    const alpha = 0.4;
    let ewCount = sprints[0].completedCount;
    let ewEst = sprints[0].completedEstimate;
    for (let i = 1; i < sprints.length; i++) {
      ewCount = alpha * sprints[i].completedCount + (1 - alpha) * ewCount;
      ewEst = alpha * sprints[i].completedEstimate + (1 - alpha) * ewEst;
    }
    return {
      sprints,
      averageCount: Number(averageCount.toFixed(1)),
      averageEstimate: Number(averageEstimate.toFixed(1)),
      projectedNext: {
        count: Math.round(ewCount),
        estimate: Math.round(ewEst),
      },
    };
  }

  // ---------------- Cumulative Flow Diagram ----------------

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
  async cumulativeFlow(actor: AuthenticatedUser, projectId: string, days = 30) {
    await this.permissions.assertAtLeast(actor, projectId, 'Viewer');

    const tasks = await this.prisma.task.findMany({
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
    const snapshots = await this.prisma.cfdSnapshot.findMany({
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
      const events = await this.prisma.event.findMany({
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

  // ---------------- Helpers ----------------

  /**
   * Public wrapper around the private sprintVelocity. Sibling modules
   * (AiSprintPlanningService) call this without re-importing the same
   * Prisma query. Skips the permissions check because callers are expected
   * to have already gated on `projectId`.
   */
  async sprintVelocityForProjectId(projectId: string) {
    return this.sprintVelocity(projectId);
  }

  private async sprintVelocity(projectId: string) {
    const completed = await this.prisma.sprint.findMany({
      where: { projectId, state: 'completed' },
      orderBy: { endDate: 'desc' },
      take: 6,
      include: {
        // Live membership — what's STILL in the sprint right now. For a
        // completed sprint that's the final set; for tasks that got booted
        // back to the backlog at completion, the membership snapshot below
        // is what carries "this used to be planned scope".
        tasks: {
          select: { id: true, status: true, estimate: true },
        },
        memberships: {
          select: { taskId: true, addedAt: true, removedAt: true },
        },
      },
    });

    // For each sprint, planned scope = the set of tasks that were members at
    // any point during its lifecycle (joined live tasks ∪ task ids appearing
    // in the membership history). Completed scope = the subset whose CURRENT
    // status is Done/Approved. This handles the "moved out incomplete" case
    // cleanly: a task removed from the sprint at completion stays counted in
    // planned, contributing to the planned-vs-completed gap on the chart.
    return completed
      .map((s) => {
        const liveIds = new Set(s.tasks.map((t) => t.id));
        const histIds = new Set(s.memberships.map((m) => m.taskId));
        const plannedIds = new Set<string>([...liveIds, ...histIds]);
        const completedTasks = s.tasks.filter(
          (t) => t.status === 'Done' || t.status === 'Approved',
        );
        const plannedEstimate = s.tasks.reduce((sum, t) => sum + (t.estimate ?? 0), 0);
        return {
          sprintId: s.id,
          name: s.name,
          endDate: s.endDate,
          plannedCount: plannedIds.size,
          plannedEstimate,
          completedCount: completedTasks.length,
          completedEstimate: completedTasks.reduce((sum, t) => sum + (t.estimate ?? 0), 0),
        };
      })
      .reverse();
  }

  private async cycleTime(projectId: string, since: Date): Promise<number | null> {
    const rows = await this.prisma.$queryRaw<{ avg_seconds: number | null }[]>(Prisma.sql`
      WITH done_events AS (
        SELECT e."entityId" AS task_id, e."createdAt" AS done_at
        FROM "Event" e
        WHERE e.type = 'TaskStatusChanged'
          AND e."projectId" = ${projectId}::uuid
          AND e."createdAt" >= ${since}
          AND e.payload ->> 'toStatus' IN ('Done', 'Approved')
      ),
      progress_events AS (
        SELECT e."entityId" AS task_id, MIN(e."createdAt") AS first_in_progress
        FROM "Event" e
        WHERE e.type = 'TaskStatusChanged'
          AND e.payload ->> 'toStatus' = 'In Progress'
        GROUP BY e."entityId"
      )
      SELECT AVG(EXTRACT(EPOCH FROM (d.done_at - p.first_in_progress))) AS avg_seconds
      FROM done_events d
      JOIN progress_events p ON p.task_id = d.task_id
      WHERE d.done_at > p.first_in_progress;
    `);
    const seconds = rows[0]?.avg_seconds;
    return seconds ? Math.round(seconds / 3600) : null;
  }

  /**
   * Project ids the actor can read. Mirrors the same predicate used by
   * SearchService so analytics scopes match what users see in search.
   */
  private async accessibleProjectIds(actor: AuthenticatedUser): Promise<string[]> {
    if (actor.kind === 'internal' && actor.companyRole === 'Admin') {
      const all = await this.prisma.project.findMany({
        where: { archivedAt: null }, select: { id: true },
      });
      return all.map((p) => p.id);
    }
    if (actor.kind === 'internal') {
      const memberships = await this.prisma.teamMember.findMany({
        where: { userId: actor.id }, select: { teamId: true },
      });
      const teamIds = memberships.map((m) => m.teamId);
      const projects = await this.prisma.project.findMany({
        where: {
          archivedAt: null,
          OR: [
            { visibility: 'public' },
            { accessGrants: { some: { userId: actor.id, subjectKind: 'user' } } },
            ...(teamIds.length > 0
              ? [{ accessGrants: { some: { subjectKind: 'team' as const, teamId: { in: teamIds } } } }]
              : []),
          ],
        },
        select: { id: true },
      });
      return projects.map((p) => p.id);
    }
    const projects = await this.prisma.project.findMany({
      where: {
        archivedAt: null,
        accessGrants: { some: { userId: actor.id, role: 'Client', subjectKind: 'user' } },
      },
      select: { id: true },
    });
    return projects.map((p) => p.id);
  }
}
