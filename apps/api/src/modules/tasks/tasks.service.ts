import {
  BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException,
} from '@nestjs/common';
import type { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma, type Priority, type TaskType, type Visibility } from '@prisma/client';
import { generateKeyBetween } from 'fractional-indexing';

import type { PrismaService } from '../../prisma/prisma.service';
import type { PermissionsService } from '../permissions/permissions.service';
import type { AuthenticatedUser } from '../auth/types';

import { defaultStatusFor, doneStatusesFor, isValidStatusFor } from './workflow';

interface CreateTaskInput {
  projectId: string;
  type?: TaskType;
  title: string;
  description?: string;
  priority?: Priority;
  visibility?: Visibility;
  parentTaskId?: string;
  sprintId?: string;
  assigneeUserId?: string;
  dueDate?: Date;
  estimate?: number;
}

interface UpdateTaskInput {
  type?: TaskType;
  title?: string;
  description?: string;
  priority?: Priority;
  visibility?: Visibility;
  parentTaskId?: string | null;
  sprintId?: string | null;
  assigneeUserId?: string | null;
  reporterUserId?: string;
  startDate?: Date | null;
  dueDate?: Date | null;
  estimate?: number | null;
  blockedReason?: string | null;
}

// Hierarchy validation. Subtasks must have a parent; Epics cannot have a parent
// (they sit at the top of the tree). Epics also can't be parented under another
// Epic. Other types are flexible — Story/Task/Bug can roll up to an Epic, or
// be parent-less.
function assertTypeHierarchy(args: {
  type: TaskType;
  parent: { type: TaskType } | null;
}): void {
  const { type, parent } = args;
  if (type === 'Subtask' && !parent) {
    throw new BadRequestException('Subtasks must have a parent task');
  }
  if (type === 'Epic' && parent) {
    throw new BadRequestException('Epics cannot have a parent task');
  }
  if (parent?.type === 'Subtask') {
    throw new BadRequestException('Cannot nest under a Subtask');
  }
}

@Injectable()
export class TasksService {
  private readonly logger = new Logger(TasksService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionsService,
    private readonly events: EventEmitter2,
  ) {}

  async create(actor: AuthenticatedUser, input: CreateTaskInput) {
    // Bug-only restriction is keyed on project role, not user kind. A
    // kind=client user with Contributor role creates real tasks; a user with
    // the `Client` project role (any kind) is restricted to bug-report
    // semantics (forced type=Bug, visibility=client_visible). Viewer cannot
    // create at all; anyone with no role gets 403.
    const role = await this.permissions.effectiveRole(actor, input.projectId);
    if (role === null || role === 'Viewer') {
      throw new ForbiddenException('Requires Contributor or higher to create tasks');
    }
    const isClientBug = role === 'Client';

    const project = await this.prisma.project.findUnique({
      where: { id: input.projectId },
      select: { id: true, key: true, workflowPreset: true, sprintsEnabled: true, archivedAt: true },
    });
    if (!project) throw new NotFoundException('Project not found');
    if (project.archivedAt) throw new BadRequestException('Project is archived');

    if (input.sprintId && !project.sprintsEnabled) {
      throw new BadRequestException('Project does not have sprints enabled');
    }
    let parent: { projectId: string; type: TaskType } | null = null;
    if (input.parentTaskId) {
      parent = await this.prisma.task.findUnique({
        where: { id: input.parentTaskId },
        select: { projectId: true, type: true },
      });
      if (!parent || parent.projectId !== input.projectId) {
        throw new BadRequestException('Parent task must be in the same project');
      }
    }
    const type = (isClientBug ? 'Bug' : input.type ?? 'Task') as TaskType;
    assertTypeHierarchy({ type, parent: parent ? { type: parent.type } : null });

    // Determine the position at the bottom of the Todo column.
    const last = await this.prisma.task.findFirst({
      where: { projectId: input.projectId, status: defaultStatusFor(project.workflowPreset) },
      orderBy: { boardPosition: 'desc' },
      select: { boardPosition: true },
    });
    const boardPosition = generateKeyBetween(last?.boardPosition ?? null, null);

    // Atomically increment the project's task counter and create the task.
    const task = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.project.update({
        where: { id: input.projectId },
        data: { nextTaskNumber: { increment: 1 } },
        select: { nextTaskNumber: true },
      });
      const keyNumber = updated.nextTaskNumber - 1;

      return tx.task.create({
        data: {
          projectId: input.projectId,
          keyNumber,
          type,
          title: input.title,
          description: input.description ?? null,
          status: defaultStatusFor(project.workflowPreset),
          priority: input.priority ?? 'Medium',
          visibility: isClientBug ? 'client_visible' : (input.visibility ?? 'internal'),
          reportedByClient: isClientBug,
          ...(input.parentTaskId ? { parentTaskId: input.parentTaskId } : {}),
          ...(input.sprintId ? { sprintId: input.sprintId } : {}),
          ...(input.assigneeUserId ? { assigneeUserId: input.assigneeUserId } : {}),
          ...(input.dueDate ? { dueDate: input.dueDate } : {}),
          ...(input.estimate != null ? { estimate: input.estimate } : {}),
          boardPosition,
          reporterUserId: actor.id,
          createdById: actor.id,
          watchers: { create: [{ userId: actor.id }] },
        },
      });
    });

    this.events.emit('task.created', {
      taskId: task.id,
      projectId: task.projectId,
      key: `${project.key}-${task.keyNumber}`,
      actorUserId: actor.id,
      assigneeUserId: task.assigneeUserId,
    });
    if (isClientBug) {
      this.events.emit('client.reported_bug', {
        taskId: task.id,
        projectId: task.projectId,
        title: task.title,
        actorUserId: actor.id,
      });
    }
    return this.hydrateKey(task, project.key);
  }

  async listByProject(actor: AuthenticatedUser, projectId: string, filters: {
    status?: string; assigneeUserId?: string; sprintId?: string;
    isBlocked?: boolean; parentTaskId?: string | null; type?: TaskType;
  } = {}) {
    // Clients can list tasks in a project they're granted access to. By
    // default we narrow the result set to tasks explicitly marked
    // client_visible — but a project Manager can flip the project's
    // `defaultTaskVisibility` to 'client_visible' to share the whole scope
    // with guests (common for client engagements where the whole project IS
    // the deliverable). When the project default is 'client_visible' we
    // skip the filter entirely and guests see every task.
    const role = await this.permissions.assertAtLeast(actor, projectId, 'Client');
    const project = await this.prisma.project.findUniqueOrThrow({
      where: { id: projectId },
      select: { key: true, defaultTaskVisibility: true },
    });
    const where: Prisma.TaskWhereInput = { projectId };
    if (role === 'Client' && project.defaultTaskVisibility === 'internal') {
      where.visibility = 'client_visible';
    }
    if (filters.status) where.status = filters.status;
    if (filters.assigneeUserId) where.assigneeUserId = filters.assigneeUserId;
    if (filters.sprintId) where.sprintId = filters.sprintId;
    if (filters.isBlocked !== undefined) where.isBlocked = filters.isBlocked;
    if (filters.parentTaskId !== undefined) {
      where.parentTaskId = filters.parentTaskId;
    }
    if (filters.type) where.type = filters.type;
    const tasks = await this.prisma.task.findMany({
      where,
      orderBy: [{ status: 'asc' }, { boardPosition: 'asc' }],
      include: {
        assignee: { select: { id: true, name: true, avatarUrl: true } },
        // Labels are surfaced on every list endpoint so the board toolbar's
        // Label filter can do its job entirely client-side. Payload bump is
        // small (3 small fields × usually <5 labels per task).
        labels: { include: { label: { select: { id: true, name: true, color: true } } } },
        customFieldValues: {
          include: {
            field: {
              select: { id: true, name: true, kind: true, position: true, options: true },
            },
          },
        },
        // Outgoing "blocks" links only — coarse shape `{ toTaskId, type }` is
        // enough for the timeline view to draw dependency arrows without a
        // second round-trip. Incoming links are derivable by inverting on the
        // client (every blocker is also someone's `toLinks` entry).
        fromLinks: {
          where: { type: 'blocks' },
          select: { id: true, fromTaskId: true, toTaskId: true, type: true },
        },
      },
    });
    return tasks.map((t) => this.hydrateKey(t, project.key));
  }

  async get(actor: AuthenticatedUser, id: string) {
    const task = await this.prisma.task.findUnique({
      where: { id },
      include: {
        project: { select: { id: true, key: true, workflowPreset: true } },
        parent: { select: { id: true, title: true, type: true, keyNumber: true } },
        subtasks: { select: { id: true, title: true, status: true, type: true, keyNumber: true } },
        fromLinks: true, toLinks: true,
      },
    });
    if (!task) throw new NotFoundException('Task not found');
    const canSee = await this.permissions.canSeeTask(actor, task.projectId, task.visibility);
    if (!canSee) throw new ForbiddenException('No access to task');
    return this.hydrateKey(task, task.project.key);
  }

  async update(actor: AuthenticatedUser, id: string, input: UpdateTaskInput) {
    const task = await this.prisma.task.findUniqueOrThrow({
      where: { id },
      select: {
        id: true,
        projectId: true,
        type: true,
        parentTaskId: true,
        assigneeUserId: true,
        createdById: true,
        reporterUserId: true,
      },
    });
    await this.permissions.assertAtLeast(actor, task.projectId, 'Contributor');

    // Re-validate hierarchy if type or parent is changing.
    const nextType = input.type ?? task.type;
    const nextParentId = input.parentTaskId !== undefined ? input.parentTaskId : task.parentTaskId;
    if (input.type !== undefined || input.parentTaskId !== undefined) {
      let parent: { projectId: string; type: TaskType } | null = null;
      if (nextParentId) {
        parent = await this.prisma.task.findUnique({
          where: { id: nextParentId },
          select: { projectId: true, type: true },
        });
        if (!parent || parent.projectId !== task.projectId) {
          throw new BadRequestException('Parent task must be in the same project');
        }
        if (parent && nextParentId === id) {
          throw new BadRequestException('Task cannot be its own parent');
        }
        // Walk up the chain — reject if `id` shows up as an ancestor of the
        // proposed parent (cycle), and reject if any ancestor is a Subtask
        // (the immediate-parent check below would miss "Subtask → Story → me"
        // when re-parenting). Bounded to 50 hops to prevent runaway loops on
        // corrupted data.
        let cursor: string | null = nextParentId;
        for (let i = 0; i < 50 && cursor; i++) {
          const ancestor: { id: string; parentTaskId: string | null; type: TaskType } | null =
            await this.prisma.task.findUnique({
              where: { id: cursor },
              select: { id: true, parentTaskId: true, type: true },
            });
          if (!ancestor) break;
          if (ancestor.id === id) {
            throw new BadRequestException(
              'Re-parenting would create a cycle (this task appears as an ancestor)',
            );
          }
          if (ancestor.type === 'Subtask') {
            throw new BadRequestException(
              'Cannot nest under a chain that contains a Subtask',
            );
          }
          cursor = ancestor.parentTaskId;
        }
      }
      // Promoting/demoting an existing task to Subtask: if it has children,
      // those children's chain would now go through a Subtask. Refuse.
      if (nextType === 'Subtask' && task.type !== 'Subtask') {
        const childCount = await this.prisma.task.count({
          where: { parentTaskId: id },
        });
        if (childCount > 0) {
          throw new BadRequestException(
            `Cannot demote to Subtask while ${childCount} child task(s) reference this task. Re-parent them first.`,
          );
        }
      }
      assertTypeHierarchy({ type: nextType, parent: parent ? { type: parent.type } : null });
    }

    const updated = await this.prisma.task.update({
      where: { id },
      data: {
        ...(input.type !== undefined ? { type: input.type } : {}),
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.priority !== undefined ? { priority: input.priority } : {}),
        ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
        ...(input.parentTaskId !== undefined ? { parentTaskId: input.parentTaskId } : {}),
        ...(input.sprintId !== undefined ? { sprintId: input.sprintId } : {}),
        ...(input.assigneeUserId !== undefined ? { assigneeUserId: input.assigneeUserId } : {}),
        ...(input.reporterUserId !== undefined ? { reporterUserId: input.reporterUserId } : {}),
        ...(input.startDate !== undefined ? { startDate: input.startDate } : {}),
        ...(input.dueDate !== undefined ? { dueDate: input.dueDate } : {}),
        ...(input.estimate !== undefined ? { estimate: input.estimate } : {}),
        ...(input.blockedReason !== undefined ? { blockedReason: input.blockedReason } : {}),
      },
    });
    if (
      input.assigneeUserId !== undefined &&
      input.assigneeUserId !== task.assigneeUserId
    ) {
      // Auto-watch new assignee. Auto-unwatch the previous assignee unless they
      // are also the task's creator or reporter (spec §10).
      if (input.assigneeUserId) {
        await this.addWatcher(updated.id, input.assigneeUserId);
      }
      const prev = task.assigneeUserId;
      if (
        prev &&
        prev !== task.createdById &&
        prev !== task.reporterUserId &&
        prev !== input.assigneeUserId
      ) {
        // Best-effort: P2025 (row not found) is expected if the previous
        // assignee had already unwatched, so we swallow that ONE error code.
        // Any other failure (DB connection, permissions) gets logged with
        // enough context that an operator can investigate.
        await this.prisma.taskWatcher
          .delete({ where: { userId_taskId: { userId: prev, taskId: id } } })
          .catch((err: unknown) => {
            if (
              err instanceof Prisma.PrismaClientKnownRequestError &&
              err.code === 'P2025'
            ) {
              return;
            }
            this.logger.warn(
              { err, prevAssigneeId: prev, taskId: id },
              'Failed to remove previous assignee from task watchers',
            );
          });
      }
    }
    this.events.emit('task.updated', { taskId: id, actorUserId: actor.id, changes: input });
    return updated;
  }

  async changeStatus(actor: AuthenticatedUser, id: string, newStatus: string, triggeredBy: 'user' | 'github' | 'deployment' | 'system' = 'user') {
    const task = await this.prisma.task.findUniqueOrThrow({
      where: { id },
      include: { project: { select: { workflowPreset: true, key: true } }, subtasks: true },
    });
    await this.permissions.assertAtLeast(actor, task.projectId, 'Contributor');

    if (!isValidStatusFor(task.project.workflowPreset, newStatus)) {
      throw new BadRequestException(
        `Status ${newStatus} not valid for workflow preset ${task.project.workflowPreset}`,
      );
    }

    // Parent-completion gate: parents can't move to Done if any subtask isn't done.
    if (doneStatusesFor(task.project.workflowPreset).includes(newStatus) && task.subtasks.length > 0) {
      const incomplete = task.subtasks.filter(
        (s) => !doneStatusesFor(task.project.workflowPreset).includes(s.status),
      );
      if (incomplete.length > 0) {
        throw new ConflictException({
          message: 'Cannot complete parent while subtasks are incomplete',
          incompleteSubtasks: incomplete.map((s) => s.id),
        });
      }
    }

    const previous = task.status;
    if (previous === newStatus) return task;

    // Move to bottom of new column for board ordering.
    const last = await this.prisma.task.findFirst({
      where: { projectId: task.projectId, status: newStatus },
      orderBy: { boardPosition: 'desc' },
      select: { boardPosition: true },
    });
    const boardPosition = generateKeyBetween(last?.boardPosition ?? null, null);

    const updated = await this.prisma.task.update({
      where: { id },
      data: { status: newStatus, boardPosition },
    });
    this.events.emit('task.status_changed', {
      taskId: id, fromStatus: previous, toStatus: newStatus,
      triggeredBy, actorUserId: actor.id, projectId: task.projectId,
    });
    return updated;
  }

  async remove(actor: AuthenticatedUser, id: string) {
    const task = await this.prisma.task.findUniqueOrThrow({
      where: { id }, select: { id: true, projectId: true },
    });
    await this.permissions.assertAtLeast(actor, task.projectId, 'Manager');
    await this.prisma.task.delete({ where: { id } });
    // Emit projectId explicitly — the broadcaster falls back to looking it up
    // from the task row, which is gone by the time it runs.
    this.events.emit('task.deleted', {
      taskId: id, projectId: task.projectId, actorUserId: actor.id,
    });
  }

  async setBlocked(actor: AuthenticatedUser, id: string, isBlocked: boolean, reason?: string) {
    const task = await this.prisma.task.findUniqueOrThrow({ where: { id }, select: { projectId: true } });
    await this.permissions.assertAtLeast(actor, task.projectId, 'Contributor');
    const updated = await this.prisma.task.update({
      where: { id },
      data: { isBlocked, blockedReason: isBlocked ? reason ?? null : null },
    });
    this.events.emit(isBlocked ? 'task.blocked' : 'task.unblocked', {
      taskId: id, actorUserId: actor.id, reason,
    });
    return updated;
  }

  async reorderOnBoard(actor: AuthenticatedUser, id: string, before: string | null, after: string | null) {
    const task = await this.prisma.task.findUniqueOrThrow({ where: { id }, select: { projectId: true } });
    await this.permissions.assertAtLeast(actor, task.projectId, 'Contributor');
    const newPos = generateKeyBetween(before, after);
    return this.prisma.task.update({
      where: { id },
      data: { boardPosition: newPos },
    });
  }

  // ---------- Watchers ----------

  async watch(actor: AuthenticatedUser, taskId: string) {
    const task = await this.prisma.task.findUniqueOrThrow({
      where: { id: taskId }, select: { projectId: true, visibility: true },
    });
    if (!(await this.permissions.canSeeTask(actor, task.projectId, task.visibility))) {
      throw new ForbiddenException('Cannot watch a task you cannot see');
    }
    return this.addWatcher(taskId, actor.id);
  }

  async unwatch(actor: AuthenticatedUser, taskId: string) {
    await this.prisma.taskWatcher
      .delete({ where: { userId_taskId: { userId: actor.id, taskId } } })
      .catch(() => undefined);
  }

  private addWatcher(taskId: string, userId: string) {
    return this.prisma.taskWatcher.upsert({
      where: { userId_taskId: { userId, taskId } },
      update: {},
      create: { userId, taskId },
    });
  }

  // ---------- Mute ----------

  async mute(actor: AuthenticatedUser, taskId: string) {
    await this.prisma.taskMute.upsert({
      where: { userId_taskId: { userId: actor.id, taskId } },
      update: {},
      create: { userId: actor.id, taskId },
    });
  }

  async unmute(actor: AuthenticatedUser, taskId: string) {
    await this.prisma.taskMute
      .delete({ where: { userId_taskId: { userId: actor.id, taskId } } })
      .catch(() => undefined);
  }

  // ---------- Co-reporters ----------

  async listReporters(actor: AuthenticatedUser, taskId: string) {
    const task = await this.prisma.task.findUniqueOrThrow({
      where: { id: taskId }, select: { projectId: true, visibility: true },
    });
    if (!(await this.permissions.canSeeTask(actor, task.projectId, task.visibility))) {
      throw new ForbiddenException('No access to task');
    }
    return this.prisma.taskReporter.findMany({
      where: { taskId },
      include: { user: { select: { id: true, name: true, email: true, avatarUrl: true } } },
      orderBy: { addedAt: 'asc' },
    });
  }

  async addReporter(actor: AuthenticatedUser, taskId: string, userId: string) {
    const task = await this.prisma.task.findUniqueOrThrow({
      where: { id: taskId }, select: { projectId: true, reporterUserId: true },
    });
    await this.permissions.assertAtLeast(actor, task.projectId, 'Contributor');
    // Don't double-add the canonical reporter — they're already "the" reporter
    // and surface separately in the UI.
    if (task.reporterUserId === userId) return { ok: true };
    await this.prisma.taskReporter.upsert({
      where: { taskId_userId: { taskId, userId } },
      update: {},
      create: { taskId, userId, addedById: actor.id },
    });
    this.events.emit('task.reporter_added', {
      taskId, projectId: task.projectId, userId, actorUserId: actor.id,
    });
    return { ok: true };
  }

  async removeReporter(actor: AuthenticatedUser, taskId: string, userId: string) {
    const task = await this.prisma.task.findUniqueOrThrow({
      where: { id: taskId }, select: { projectId: true },
    });
    await this.permissions.assertAtLeast(actor, task.projectId, 'Contributor');
    await this.prisma.taskReporter
      .delete({ where: { taskId_userId: { taskId, userId } } })
      .catch(() => undefined);
    this.events.emit('task.reporter_removed', {
      taskId, projectId: task.projectId, userId, actorUserId: actor.id,
    });
    return { ok: true };
  }

  // ---------- Links ----------

  async createLink(actor: AuthenticatedUser, fromTaskId: string, toTaskId: string, type: 'blocks' | 'related' | 'duplicate') {
    if (fromTaskId === toTaskId) throw new BadRequestException('Task cannot link to itself');
    const [from, to] = await Promise.all([
      this.prisma.task.findUniqueOrThrow({ where: { id: fromTaskId }, select: { projectId: true } }),
      this.prisma.task.findUniqueOrThrow({ where: { id: toTaskId }, select: { projectId: true } }),
    ]);
    await this.permissions.assertAtLeast(actor, from.projectId, 'Contributor');
    await this.permissions.effectiveRole(actor, to.projectId); // require some access to target
    return this.prisma.taskLink.create({
      data: { fromTaskId, toTaskId, type, createdById: actor.id },
    });
  }

  async deleteLink(actor: AuthenticatedUser, linkId: string) {
    const link = await this.prisma.taskLink.findUniqueOrThrow({
      where: { id: linkId },
      include: { fromTask: { select: { projectId: true } } },
    });
    await this.permissions.assertAtLeast(actor, link.fromTask.projectId, 'Contributor');
    await this.prisma.taskLink.delete({ where: { id: linkId } });
  }

  /**
   * Build the predecessor/successor closure around a focal task for the
   * TaskDependencyGraph SVG visualizer (Pass 5 R4-deferred C).
   *
   * BFS in both directions, capped at `depth` hops (default 2). The cap is a
   * hard guard against pathological graphs in big projects — a 500-task
   * blocker chain would otherwise drag the drawer's "View graph" toggle into
   * a multi-second render.
   *
   * Permissions: caller must have at least read access to the focal task's
   * project. Linked tasks in *other* projects (cross-project dependencies)
   * are walked too, but each candidate node is filtered through
   * `canSeeTask` so a guest can't enumerate hidden internal tasks via the
   * dep-graph back door.
   *
   * Shape: `{ nodes: [{id, key, title, status}], edges: [{from, to, kind}] }`
   * — the client lays the graph out itself (no server-side coordinates) so
   * we don't redo work on zoom / pan.
   */
  async getDependencyGraph(
    actor: AuthenticatedUser,
    taskId: string,
    depth = 2,
  ): Promise<{
    focalId: string;
    nodes: Array<{ id: string; key: string; title: string; status: string; projectId: string }>;
    edges: Array<{ from: string; to: string; kind: 'blocks' | 'related' | 'duplicate' }>;
  }> {
    const focal = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: {
        id: true,
        keyNumber: true,
        title: true,
        status: true,
        projectId: true,
        visibility: true,
        project: { select: { key: true } },
      },
    });
    if (!focal) throw new NotFoundException('Task not found');
    const canSee = await this.permissions.canSeeTask(actor, focal.projectId, focal.visibility);
    if (!canSee) throw new ForbiddenException('No access to task');

    // Cap depth defensively. 2 is the spec; 0 still returns the focal node;
    // anything > 4 will OOM the SVG layout, so clamp.
    const safeDepth = Math.max(0, Math.min(4, Math.floor(depth)));

    // BFS frontier. Each frontier element is a (taskId, hops) pair.
    const visited = new Map<string, { hops: number }>();
    visited.set(focal.id, { hops: 0 });
    let frontier: string[] = [focal.id];

    interface RawLink {
      id: string;
      fromTaskId: string;
      toTaskId: string;
      type: 'blocks' | 'related' | 'duplicate';
    }
    const collectedEdges: RawLink[] = [];

    for (let hop = 0; hop < safeDepth && frontier.length > 0; hop += 1) {
      const links = await this.prisma.taskLink.findMany({
        where: {
          OR: [{ fromTaskId: { in: frontier } }, { toTaskId: { in: frontier } }],
        },
        select: { id: true, fromTaskId: true, toTaskId: true, type: true },
      });
      const nextFrontier: string[] = [];
      for (const l of links) {
        collectedEdges.push(l as RawLink);
        for (const id of [l.fromTaskId, l.toTaskId]) {
          if (!visited.has(id)) {
            visited.set(id, { hops: hop + 1 });
            nextFrontier.push(id);
          }
        }
      }
      frontier = nextFrontier;
    }

    // Resolve metadata for every visited node in ONE query.
    const nodeRows = await this.prisma.task.findMany({
      where: { id: { in: Array.from(visited.keys()) } },
      select: {
        id: true,
        keyNumber: true,
        title: true,
        status: true,
        projectId: true,
        visibility: true,
        project: { select: { key: true } },
      },
    });

    // Filter for visibility — a Contributor who can see the focal task in
    // Project A might be a Guest in Project B; the linked task from B is
    // a candidate node but it has to pass canSeeTask before it goes out.
    const visibleNodes: typeof nodeRows = [];
    for (const n of nodeRows) {
      // Fast-path: same project as focal AND the caller already cleared
      // canSee above. Skip the per-task permission check to keep this hot
      // path cheap on the common case (most dep graphs stay in-project).
      if (n.projectId === focal.projectId) {
        visibleNodes.push(n);
        continue;
      }
      const ok = await this.permissions.canSeeTask(actor, n.projectId, n.visibility);
      if (ok) visibleNodes.push(n);
    }
    const visibleIdSet = new Set(visibleNodes.map((n) => n.id));

    // De-duplicate edges (BFS can re-visit a link from both ends) and drop
    // any edge whose endpoint got filtered for permissions.
    const seenEdge = new Set<string>();
    const edges: Array<{ from: string; to: string; kind: 'blocks' | 'related' | 'duplicate' }> = [];
    for (const e of collectedEdges) {
      if (!visibleIdSet.has(e.fromTaskId) || !visibleIdSet.has(e.toTaskId)) continue;
      const k = `${e.fromTaskId}|${e.toTaskId}|${e.type}`;
      if (seenEdge.has(k)) continue;
      seenEdge.add(k);
      edges.push({ from: e.fromTaskId, to: e.toTaskId, kind: e.type });
    }

    return {
      focalId: focal.id,
      nodes: visibleNodes.map((n) => ({
        id: n.id,
        key: `${n.project.key}-${n.keyNumber}`,
        title: n.title,
        status: n.status,
        projectId: n.projectId,
      })),
      edges,
    };
  }

  // ---------- Helpers ----------

  private hydrateKey<T extends { keyNumber: number }>(task: T, projectKey: string): T & { key: string } {
    return { ...task, key: `${projectKey}-${task.keyNumber}` };
  }
}
