import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';

import type { PrismaService } from '../../prisma/prisma.service';
import type { PermissionsService } from '../permissions/permissions.service';
import type { AuthenticatedUser } from '../auth/types';

@Injectable()
export class SprintsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionsService,
    private readonly events: EventEmitter2,
  ) {}

  async create(actor: AuthenticatedUser, projectId: string, data: { name: string; startDate?: Date; endDate?: Date; goal?: string | null }) {
    await this.permissions.assertAtLeast(actor, projectId, 'Manager');
    const project = await this.prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    if (!project.sprintsEnabled) {
      throw new BadRequestException('Project does not have sprints enabled');
    }
    const goal = this.normaliseGoal(data.goal);
    const sprint = await this.prisma.sprint.create({
      data: {
        projectId,
        name: data.name,
        ...(data.startDate ? { startDate: data.startDate } : {}),
        ...(data.endDate ? { endDate: data.endDate } : {}),
        ...(goal !== undefined ? { goal } : {}),
        createdById: actor.id,
      },
    });
    this.events.emit('sprint.created', { sprintId: sprint.id, projectId, actorUserId: actor.id });
    return sprint;
  }

  /**
   * Patch a sprint's mutable fields. Today only the goal/theme — name + dates
   * + state still go through dedicated endpoints because they each touch other
   * tables (membership, events, etc.). Keeping this endpoint narrow means a
   * single goal-edit doesn't accidentally drag in side-effects.
   */
  async updateMetadata(actor: AuthenticatedUser, id: string, input: { goal?: string | null }) {
    const sprint = await this.prisma.sprint.findUnique({
      where: { id }, select: { projectId: true },
    });
    if (!sprint) throw new NotFoundException('Sprint not found');
    await this.permissions.assertAtLeast(actor, sprint.projectId, 'Manager');
    const data: { goal?: string | null } = {};
    if (input.goal !== undefined) {
      data.goal = this.normaliseGoal(input.goal) ?? null;
    }
    if (Object.keys(data).length === 0) {
      return this.prisma.sprint.findUniqueOrThrow({ where: { id } });
    }
    const updated = await this.prisma.sprint.update({ where: { id }, data });
    this.events.emit('sprint.updated', {
      sprintId: id, projectId: sprint.projectId, actorUserId: actor.id, changes: data,
    });
    return updated;
  }

  /**
   * Trim, drop empty, cap at 200 chars. Returns undefined when the caller
   * didn't supply a value (so the create/update paths can skip the column);
   * returns null when the caller explicitly cleared the goal.
   */
  private normaliseGoal(goal: string | null | undefined): string | null | undefined {
    if (goal === undefined) return undefined;
    if (goal === null) return null;
    const trimmed = goal.trim();
    if (trimmed.length === 0) return null;
    if (trimmed.length > 200) {
      throw new BadRequestException('Sprint goal must be 200 characters or fewer');
    }
    return trimmed;
  }

  async listByProject(actor: AuthenticatedUser, projectId: string) {
    await this.permissions.assertAtLeast(actor, projectId, 'Viewer');
    return this.prisma.sprint.findMany({
      where: { projectId },
      orderBy: [{ state: 'asc' }, { createdAt: 'desc' }],
      include: { _count: { select: { tasks: true } } },
    });
  }

  async get(actor: AuthenticatedUser, id: string) {
    const sprint = await this.prisma.sprint.findUnique({
      where: { id },
      include: { tasks: true },
    });
    if (!sprint) throw new NotFoundException('Sprint not found');
    await this.permissions.assertAtLeast(actor, sprint.projectId, 'Viewer');
    return sprint;
  }

  async start(actor: AuthenticatedUser, id: string) {
    const sprint = await this.prisma.sprint.findUniqueOrThrow({ where: { id } });
    await this.permissions.assertAtLeast(actor, sprint.projectId, 'Manager');
    if (sprint.state !== 'planned') throw new BadRequestException(`Sprint is ${sprint.state}, can only start planned`);
    try {
      const started = await this.prisma.sprint.update({
        where: { id },
        data: {
          state: 'active',
          startDate: sprint.startDate ?? new Date(),
        },
      });
      this.events.emit('sprint.started', { sprintId: id, projectId: sprint.projectId, actorUserId: actor.id });
      return started;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('Another sprint is already active in this project');
      }
      throw e;
    }
  }

  async complete(actor: AuthenticatedUser, id: string, options: { moveIncompleteTo?: 'backlog' | 'next_planned_sprint' } = {}) {
    const sprint = await this.prisma.sprint.findUniqueOrThrow({
      where: { id },
      include: { project: { select: { workflowPreset: true } } },
    });
    await this.permissions.assertAtLeast(actor, sprint.projectId, 'Manager');
    if (sprint.state !== 'active') throw new BadRequestException(`Sprint is ${sprint.state}, can only complete active`);

    const completed = await this.prisma.$transaction(async (tx) => {
      const dest = options.moveIncompleteTo ?? 'backlog';
      const doneFilter = sprint.project.workflowPreset === 'design'
        ? { in: ['Approved', 'Done'] }
        : { in: ['Done'] };
      // Snapshot which tasks are about to leave this sprint so we can close
      // their membership rows in the same transaction. Membership history
      // is what burndown reads to reconstruct sprint scope over time.
      const movingOut = await tx.task.findMany({
        where: { sprintId: id, NOT: { status: doneFilter } },
        select: { id: true },
      });
      const movingIds = movingOut.map((t) => t.id);

      if (dest === 'backlog') {
        await tx.task.updateMany({
          where: { sprintId: id, NOT: { status: doneFilter } },
          data: { sprintId: null },
        });
      } else {
        const nextPlanned = await tx.sprint.findFirst({
          where: { projectId: sprint.projectId, state: 'planned' },
          orderBy: { createdAt: 'asc' },
        });
        if (nextPlanned) {
          await tx.task.updateMany({
            where: { sprintId: id, NOT: { status: { in: ['Done', 'Approved'] } } },
            data: { sprintId: nextPlanned.id },
          });
          // Open new membership rows under the next sprint.
          const now = new Date();
          await tx.sprintTaskMembership.createMany({
            data: movingIds.map((tid) => ({
              sprintId: nextPlanned.id,
              taskId: tid,
              addedAt: now,
            })),
          });
        } else {
          await tx.task.updateMany({
            where: { sprintId: id, NOT: { status: { in: ['Done', 'Approved'] } } },
            data: { sprintId: null },
          });
        }
      }
      // Close every open membership for tasks that just left this sprint.
      if (movingIds.length > 0) {
        await tx.sprintTaskMembership.updateMany({
          where: { sprintId: id, taskId: { in: movingIds }, removedAt: null },
          data: { removedAt: new Date() },
        });
      }
      return tx.sprint.update({
        where: { id },
        data: { state: 'completed', endDate: new Date() },
      });
    });
    this.events.emit('sprint.completed', { sprintId: id, projectId: sprint.projectId, actorUserId: actor.id });
    return completed;
  }

  async delete(actor: AuthenticatedUser, id: string) {
    const sprint = await this.prisma.sprint.findUniqueOrThrow({ where: { id } });
    await this.permissions.assertAtLeast(actor, sprint.projectId, 'Manager');
    await this.prisma.sprint.delete({ where: { id } });
    this.events.emit('sprint.deleted', { sprintId: id, projectId: sprint.projectId, actorUserId: actor.id });
  }

  // ============================================================================
  // Sprint planning — backlog + per-sprint task lists + bulk move
  // ============================================================================

  /**
   * Tasks in a project that are NOT in any sprint and not done. The "backlog".
   * Subtasks (anything with parentTaskId) are filtered out so the planning UI
   * only shows top-level work — bringing a parent into a sprint pulls its
   * children along visually.
   */
  async listBacklog(actor: AuthenticatedUser, projectId: string) {
    await this.permissions.assertAtLeast(actor, projectId, 'Viewer');
    const project = await this.prisma.project.findUniqueOrThrow({
      where: { id: projectId },
      select: { key: true, workflowPreset: true },
    });
    const doneStatuses = project.workflowPreset === 'design' ? ['Approved', 'Done'] : ['Done'];
    const rows = await this.prisma.task.findMany({
      where: {
        projectId,
        sprintId: null,
        parentTaskId: null,
        status: { notIn: doneStatuses },
      },
      orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
      include: {
        assignee: { select: { id: true, name: true, avatarUrl: true } },
        labels: { include: { label: true } },
        _count: { select: { subtasks: true } },
      },
    });
    return rows.map((t) => ({
      ...t,
      key: `${project.key}-${t.keyNumber}`,
      labels: t.labels.map((l) => l.label),
    }));
  }

  /** Tasks currently assigned to a sprint, sorted for planning view. */
  async listTasksInSprint(actor: AuthenticatedUser, sprintId: string) {
    const sprint = await this.prisma.sprint.findUnique({
      where: { id: sprintId },
      include: { project: { select: { key: true } } },
    });
    if (!sprint) throw new NotFoundException('Sprint not found');
    await this.permissions.assertAtLeast(actor, sprint.projectId, 'Viewer');
    const rows = await this.prisma.task.findMany({
      where: { sprintId, parentTaskId: null },
      orderBy: [{ priority: 'desc' }, { boardPosition: 'asc' }],
      include: {
        assignee: { select: { id: true, name: true, avatarUrl: true } },
        labels: { include: { label: true } },
        _count: { select: { subtasks: true } },
      },
    });
    return rows.map((t) => ({
      ...t,
      key: `${sprint.project.key}-${t.keyNumber}`,
      labels: t.labels.map((l) => l.label),
    }));
  }

  /**
   * Add tasks to a sprint. Idempotent and bulk — accepts an array of task IDs.
   *
   * Validates that every task belongs to the same project as the sprint
   * BEFORE writing. Previously we silently dropped cross-project IDs via the
   * `projectId: sprint.projectId` filter, which left clients confused when
   * their "moved 4 tasks" indicator said "moved 2" with no explanation. Now
   * any cross-project (or non-existent) id is a hard 400 listing the
   * offenders.
   */
  async addTasks(actor: AuthenticatedUser, sprintId: string, taskIds: string[]) {
    const sprint = await this.prisma.sprint.findUnique({ where: { id: sprintId } });
    if (!sprint) throw new NotFoundException('Sprint not found');
    await this.permissions.assertAtLeast(actor, sprint.projectId, 'Contributor');
    if (sprint.state === 'completed') {
      throw new BadRequestException('Cannot modify a completed sprint');
    }
    const ids = Array.from(new Set(taskIds)).filter(Boolean);
    if (ids.length === 0) return { moved: 0 };

    // Pre-flight: every id must exist AND share the sprint's project.
    const tasks = await this.prisma.task.findMany({
      where: { id: { in: ids } },
      select: { id: true, projectId: true },
    });
    const foundIds = new Set(tasks.map((t) => t.id));
    const missingIds = ids.filter((id) => !foundIds.has(id));
    const crossProject = tasks
      .filter((t) => t.projectId !== sprint.projectId)
      .map((t) => t.id);
    if (missingIds.length > 0 || crossProject.length > 0) {
      throw new BadRequestException({
        message: 'Some task IDs are not in this sprint\'s project',
        ...(missingIds.length > 0 ? { missingIds } : {}),
        ...(crossProject.length > 0 ? { crossProjectIds: crossProject } : {}),
        sprintProjectId: sprint.projectId,
      });
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.task.updateMany({
        where: { id: { in: ids }, projectId: sprint.projectId },
        data: { sprintId },
      });
      // Append-only membership row per task so burndown can reconstruct
      // historical scope. skipDuplicates handles the re-add-after-removal
      // pattern (which is legal — the row just gets a fresh addedAt window
      // alongside an older closed one).
      const now = new Date();
      await tx.sprintTaskMembership.createMany({
        data: ids.map((id) => ({ sprintId, taskId: id, addedAt: now })),
        skipDuplicates: false,
      });
      return updated;
    });
    this.events.emit('sprint.tasks_added', {
      sprintId, projectId: sprint.projectId, taskIds: ids, actorUserId: actor.id,
    });
    return { moved: result.count };
  }

  /**
   * Remove a single task from a sprint (returns it to backlog).
   * Convenience over passing `sprintId: null` to the generic task update.
   */
  async removeTask(actor: AuthenticatedUser, sprintId: string, taskId: string) {
    const [sprint, task] = await Promise.all([
      this.prisma.sprint.findUnique({ where: { id: sprintId } }),
      this.prisma.task.findUnique({ where: { id: taskId }, select: { projectId: true, sprintId: true } }),
    ]);
    if (!sprint) throw new NotFoundException('Sprint not found');
    if (!task) throw new NotFoundException('Task not found');
    if (task.projectId !== sprint.projectId) {
      throw new BadRequestException('Task is not in the same project as the sprint');
    }
    if (task.sprintId !== sprintId) {
      // No-op if the task isn't in this sprint — keeps the endpoint idempotent.
      return { ok: true };
    }
    await this.permissions.assertAtLeast(actor, sprint.projectId, 'Contributor');
    if (sprint.state === 'completed') {
      throw new BadRequestException('Cannot modify a completed sprint');
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.task.update({ where: { id: taskId }, data: { sprintId: null } });
      // Close every open membership row for this (sprint, task). updateMany
      // covers the legitimate single open row plus any orphaned rows from
      // a past data inconsistency.
      await tx.sprintTaskMembership.updateMany({
        where: { sprintId, taskId, removedAt: null },
        data: { removedAt: new Date() },
      });
    });
    this.events.emit('sprint.task_removed', {
      sprintId, projectId: sprint.projectId, taskId, actorUserId: actor.id,
    });
    return { ok: true };
  }
}
