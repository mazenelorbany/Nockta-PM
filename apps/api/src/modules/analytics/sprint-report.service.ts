import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { PermissionsService } from '../permissions/permissions.service';
import type { AuthenticatedUser } from '../auth/types';

// =============================================================================
// SprintReportService — produces the structured data the branded sprint PDF
// renderer needs. Kept separate from the PDF renderer so the same payload
// could power an HTML preview or a CSV export later.
//
// The "report window" is the time range we attribute hours + completions to.
// Default = the sprint's startDate..endDate (or createdAt..now() for sprints
// without scheduled dates). Callers can override with custom `from`/`to` so
// the "with certain dates" requirement is reachable for a board-level
// (project-wide) report too.
// =============================================================================

export interface SprintReportTaskRow {
  id: string;
  key: string;          // ACME-42
  title: string;
  status: string;
  priority: 'Low' | 'Medium' | 'High' | 'Critical';
  assignee: { id: string; name: string; email: string } | null;
  estimateHours: number | null;
  /** Total seconds logged across all worklog entries for this task in the report window. */
  loggedSeconds: number;
  completedAt: Date | null;
}

export interface SprintReportUserRow {
  user: { id: string; name: string; email: string };
  totalSeconds: number;
  taskCount: number;
}

export interface SprintReportPayload {
  kind: 'sprint';
  project: { id: string; key: string; name: string };
  sprint: {
    id: string;
    name: string;
    goal: string | null;
    state: 'planned' | 'active' | 'completed';
    startDate: Date | null;
    endDate: Date | null;
  };
  window: { from: Date; to: Date };
  totals: {
    tasksCompleted: number;
    tasksInScope: number;
    totalSeconds: number;
  };
  completedTasks: SprintReportTaskRow[];
  byUser: SprintReportUserRow[];
  generatedAt: Date;
  generatedBy: { id: string; name: string; email: string };
}

export interface ProjectReportPayload {
  kind: 'project';
  project: { id: string; key: string; name: string };
  window: { from: Date; to: Date };
  totals: {
    tasksCompleted: number;
    totalSeconds: number;
  };
  completedTasks: SprintReportTaskRow[];
  byUser: SprintReportUserRow[];
  generatedAt: Date;
  generatedBy: { id: string; name: string; email: string };
}

@Injectable()
export class SprintReportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionsService,
  ) {}

  /**
   * Build the payload for a single sprint. Manager+ on the project — admins
   * can also bypass when fetching reports from /settings/archived-projects.
   */
  async buildSprintReport(
    actor: AuthenticatedUser,
    sprintId: string,
    override?: { from?: Date; to?: Date },
  ): Promise<SprintReportPayload> {
    const sprint = await this.prisma.sprint.findUnique({
      where: { id: sprintId },
      include: { project: { select: { id: true, key: true, name: true } } },
    });
    if (!sprint) throw new NotFoundException('Sprint not found');
    await this.permissions.assertAtLeast(actor, sprint.projectId, 'Manager');

    // Report window — defaults to the sprint's dates; override lets the UI
    // surface arbitrary ranges if a manager wants "this sprint up to today"
    // before the sprint closes.
    const from = override?.from
      ?? sprint.startDate
      ?? sprint.createdAt;
    const to = override?.to
      ?? sprint.endDate
      ?? new Date();

    // Tasks that belong to this sprint via the live Task.sprintId AND every
    // task that was ever a member during the window (memberships table).
    // We do BOTH because:
    //   1. Tasks removed from the sprint before completion should still
    //      contribute hours within their membership window — but NOT count
    //      as "completed in this sprint" if they finished after removal.
    //   2. Tasks currently in the sprint but completed during the window
    //      are the headline list.
    const memberships = await this.prisma.sprintTaskMembership.findMany({
      where: {
        sprintId,
        OR: [{ removedAt: null }, { removedAt: { gte: from } }],
      },
      select: { taskId: true, addedAt: true, removedAt: true },
    });
    const taskIds = Array.from(new Set(memberships.map((m) => m.taskId)));
    if (taskIds.length === 0) {
      return this.emptySprintPayload(actor, sprint, sprint.project, from, to);
    }

    // Pull task + assignee details + worklog totals in parallel.
    const [tasks, worklog] = await Promise.all([
      this.prisma.task.findMany({
        where: { id: { in: taskIds } },
        select: {
          id: true,
          keyNumber: true,
          title: true,
          status: true,
          priority: true,
          estimate: true,
          completedAt: true,
          assignee: { select: { id: true, name: true, email: true } },
        },
      }),
      // All worklog rows for these tasks that overlap the window. We attribute
      // the seconds value (already computed at stop-timer time) to the
      // worklog row's user — there's no need to apportion by time-of-day.
      this.prisma.worklog.findMany({
        where: {
          taskId: { in: taskIds },
          endedAt: { not: null },
          startedAt: { lt: to },
          OR: [{ endedAt: null }, { endedAt: { gte: from } }],
        },
        select: { taskId: true, userId: true, seconds: true },
      }),
    ]);

    // Build per-task secondaries
    const loggedByTask = new Map<string, number>();
    for (const w of worklog) {
      loggedByTask.set(w.taskId, (loggedByTask.get(w.taskId) ?? 0) + w.seconds);
    }

    const projectKey = sprint.project.key;
    const completedTasks: SprintReportTaskRow[] = tasks
      // "Completed in window" = status Done/Approved AND completedAt within range.
      // We don't gate on whether the membership was still active when the
      // task completed (a task could be removed from the sprint then
      // completed shortly after — the sprint that PLANNED it still gets
      // credit for the close).
      .filter((t) => /done|approved/i.test(t.status))
      .filter((t) => {
        const c = t.completedAt;
        if (!c) return false;
        return c >= from && c < to;
      })
      .map((t) => ({
        id: t.id,
        key: `${projectKey}-${t.keyNumber}`,
        title: t.title,
        status: t.status,
        priority: t.priority,
        assignee: t.assignee
          ? { id: t.assignee.id, name: t.assignee.name, email: t.assignee.email }
          : null,
        estimateHours: t.estimate ?? null,
        loggedSeconds: loggedByTask.get(t.id) ?? 0,
        completedAt: t.completedAt,
      }))
      .sort((a, b) => (b.completedAt?.getTime() ?? 0) - (a.completedAt?.getTime() ?? 0));

    const byUser = await this.aggregateByUser(worklog);
    const totalSeconds = worklog.reduce((sum, w) => sum + w.seconds, 0);
    const generatedBy = await this.resolveActor(actor);

    return {
      kind: 'sprint',
      project: sprint.project,
      sprint: {
        id: sprint.id,
        name: sprint.name,
        goal: sprint.goal,
        state: sprint.state,
        startDate: sprint.startDate,
        endDate: sprint.endDate,
      },
      window: { from, to },
      totals: {
        tasksCompleted: completedTasks.length,
        tasksInScope: taskIds.length,
        totalSeconds,
      },
      completedTasks,
      byUser,
      generatedAt: new Date(),
      generatedBy,
    };
  }

  /**
   * Build a project-level report for an arbitrary date window. Same shape as
   * the sprint report sans sprint metadata.
   */
  async buildProjectReport(
    actor: AuthenticatedUser,
    projectId: string,
    window: { from: Date; to: Date },
  ): Promise<ProjectReportPayload> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, key: true, name: true },
    });
    if (!project) throw new NotFoundException('Project not found');
    await this.permissions.assertAtLeast(actor, projectId, 'Manager');

    if (window.from.getTime() >= window.to.getTime()) {
      throw new ForbiddenException('Report window must have from < to');
    }

    const projectKey = project.key;
    const tasks = await this.prisma.task.findMany({
      where: {
        projectId,
        completedAt: { gte: window.from, lt: window.to },
        status: { in: ['Done', 'Approved'] },
      },
      select: {
        id: true,
        keyNumber: true,
        title: true,
        status: true,
        priority: true,
        estimate: true,
        completedAt: true,
        assignee: { select: { id: true, name: true, email: true } },
      },
      orderBy: { completedAt: 'desc' },
    });

    const taskIds = tasks.map((t) => t.id);
    const worklog = taskIds.length
      ? await this.prisma.worklog.findMany({
          where: {
            taskId: { in: taskIds },
            endedAt: { not: null },
            startedAt: { lt: window.to },
            OR: [{ endedAt: null }, { endedAt: { gte: window.from } }],
          },
          select: { taskId: true, userId: true, seconds: true },
        })
      : [];

    const loggedByTask = new Map<string, number>();
    for (const w of worklog) {
      loggedByTask.set(w.taskId, (loggedByTask.get(w.taskId) ?? 0) + w.seconds);
    }
    const completedTasks: SprintReportTaskRow[] = tasks.map((t) => ({
      id: t.id,
      key: `${projectKey}-${t.keyNumber}`,
      title: t.title,
      status: t.status,
      priority: t.priority,
      assignee: t.assignee
        ? { id: t.assignee.id, name: t.assignee.name, email: t.assignee.email }
        : null,
      estimateHours: t.estimate ?? null,
      loggedSeconds: loggedByTask.get(t.id) ?? 0,
      completedAt: t.completedAt,
    }));
    const byUser = await this.aggregateByUser(worklog);
    const totalSeconds = worklog.reduce((sum, w) => sum + w.seconds, 0);
    const generatedBy = await this.resolveActor(actor);

    return {
      kind: 'project',
      project,
      window,
      totals: {
        tasksCompleted: completedTasks.length,
        totalSeconds,
      },
      completedTasks,
      byUser,
      generatedAt: new Date(),
      generatedBy,
    };
  }

  // ----- helpers -----

  private emptySprintPayload(
    actor: AuthenticatedUser,
    sprint: {
      id: string;
      name: string;
      goal: string | null;
      state: 'planned' | 'active' | 'completed';
      startDate: Date | null;
      endDate: Date | null;
    },
    project: { id: string; key: string; name: string },
    from: Date,
    to: Date,
  ): SprintReportPayload {
    return {
      kind: 'sprint',
      project,
      sprint: {
        id: sprint.id,
        name: sprint.name,
        goal: sprint.goal,
        state: sprint.state,
        startDate: sprint.startDate,
        endDate: sprint.endDate,
      },
      window: { from, to },
      totals: { tasksCompleted: 0, tasksInScope: 0, totalSeconds: 0 },
      completedTasks: [],
      byUser: [],
      generatedAt: new Date(),
      generatedBy: { id: actor.id, name: actor.email, email: actor.email },
    };
  }

  private async aggregateByUser(
    worklog: Array<{ userId: string; seconds: number; taskId: string }>,
  ): Promise<SprintReportUserRow[]> {
    if (worklog.length === 0) return [];
    const acc = new Map<string, { secs: number; tasks: Set<string> }>();
    for (const w of worklog) {
      let row = acc.get(w.userId);
      if (!row) {
        row = { secs: 0, tasks: new Set() };
        acc.set(w.userId, row);
      }
      row.secs += w.seconds;
      row.tasks.add(w.taskId);
    }
    const users = await this.prisma.user.findMany({
      where: { id: { in: Array.from(acc.keys()) } },
      select: { id: true, name: true, email: true },
    });
    const byId = new Map(users.map((u) => [u.id, u]));
    const out: SprintReportUserRow[] = [];
    for (const [userId, { secs, tasks }] of acc.entries()) {
      const u = byId.get(userId);
      if (!u) continue;
      out.push({
        user: { id: u.id, name: u.name, email: u.email },
        totalSeconds: secs,
        taskCount: tasks.size,
      });
    }
    return out.sort((a, b) => b.totalSeconds - a.totalSeconds);
  }

  private async resolveActor(
    actor: AuthenticatedUser,
  ): Promise<{ id: string; name: string; email: string }> {
    const u = await this.prisma.user.findUnique({
      where: { id: actor.id },
      select: { id: true, name: true, email: true },
    });
    return u ?? { id: actor.id, name: actor.email, email: actor.email };
  }
}
