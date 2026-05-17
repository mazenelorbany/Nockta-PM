import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { PermissionsService } from '../permissions/permissions.service';
import type { AuthenticatedUser } from '../auth/types';

@Injectable()
export class WorklogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionsService,
    private readonly events: EventEmitter2,
  ) {}

  /** Start a live timer on a task. Only one active timer per user at a time. */
  async start(actor: AuthenticatedUser, taskId: string, note?: string) {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: { id: true, projectId: true, visibility: true },
    });
    if (!task) throw new NotFoundException('Task not found');
    const canSee = await this.permissions.canSeeTask(actor, task.projectId, task.visibility);
    if (!canSee) throw new ForbiddenException('No access');

    // Stop any other running timer the user has.
    await this.prisma.worklog.updateMany({
      where: { userId: actor.id, endedAt: null },
      data: { endedAt: new Date(), seconds: 0 },
    });

    const log = await this.prisma.worklog.create({
      data: {
        taskId,
        userId: actor.id,
        startedAt: new Date(),
        ...(note ? { note } : {}),
      },
    });
    this.events.emit('worklog.started', {
      worklogId: log.id, taskId, projectId: task.projectId, actorUserId: actor.id,
    });
    return log;
  }

  /** Stop the user's running timer for this task (or any task if not specified). */
  async stop(actor: AuthenticatedUser, taskId: string) {
    const running = await this.prisma.worklog.findFirst({
      where: { userId: actor.id, taskId, endedAt: null },
    });
    if (!running) throw new BadRequestException('No running timer for this task');
    const endedAt = new Date();
    const seconds = Math.max(0, Math.floor((endedAt.getTime() - running.startedAt.getTime()) / 1000));
    const updated = await this.prisma.worklog.update({
      where: { id: running.id },
      data: { endedAt, seconds },
    });
    this.events.emit('worklog.stopped', {
      worklogId: updated.id, taskId, seconds, actorUserId: actor.id,
    });
    return updated;
  }

  /** Manually log time (no live timer). */
  async logManual(
    actor: AuthenticatedUser,
    taskId: string,
    input: { seconds: number; note?: string; startedAt?: Date },
  ) {
    if (!Number.isFinite(input.seconds) || input.seconds <= 0) {
      throw new BadRequestException('Seconds must be a positive number');
    }
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: { projectId: true, visibility: true },
    });
    if (!task) throw new NotFoundException('Task not found');
    const canSee = await this.permissions.canSeeTask(actor, task.projectId, task.visibility);
    if (!canSee) throw new ForbiddenException('No access');

    const startedAt = input.startedAt ?? new Date(Date.now() - input.seconds * 1000);
    const endedAt = new Date(startedAt.getTime() + input.seconds * 1000);

    const log = await this.prisma.worklog.create({
      data: {
        taskId,
        userId: actor.id,
        seconds: Math.floor(input.seconds),
        startedAt,
        endedAt,
        ...(input.note ? { note: input.note } : {}),
      },
    });
    this.events.emit('worklog.logged', {
      worklogId: log.id, taskId, seconds: log.seconds, actorUserId: actor.id,
    });
    return log;
  }

  /** List worklogs for a task (most recent first) + summary. */
  async listForTask(actor: AuthenticatedUser, taskId: string) {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: { projectId: true, visibility: true },
    });
    if (!task) throw new NotFoundException('Task not found');
    const canSee = await this.permissions.canSeeTask(actor, task.projectId, task.visibility);
    if (!canSee) throw new ForbiddenException('No access');

    const entries = await this.prisma.worklog.findMany({
      where: { taskId },
      orderBy: { startedAt: 'desc' },
      include: { user: { select: { id: true, name: true, avatarUrl: true } } },
    });
    const totalSeconds = entries.reduce((sum, e) => sum + e.seconds, 0);
    const running = entries.find((e) => e.endedAt === null) ?? null;
    return { entries, totalSeconds, running };
  }

  async delete(actor: AuthenticatedUser, worklogId: string) {
    const log = await this.prisma.worklog.findUnique({
      where: { id: worklogId },
      include: { task: { select: { projectId: true } } },
    });
    if (!log) throw new NotFoundException('Worklog not found');
    // The author or a project Manager can delete.
    if (log.userId !== actor.id) {
      await this.permissions.assertAtLeast(actor, log.task.projectId, 'Manager');
    }
    await this.prisma.worklog.delete({ where: { id: worklogId } });
    return { ok: true };
  }

  /** Bonus: who is currently running a timer right now (org-wide)? */
  async listActive(actor: AuthenticatedUser) {
    if (actor.kind !== 'internal') return [];
    return this.prisma.worklog.findMany({
      where: { endedAt: null },
      include: {
        user: { select: { id: true, name: true, avatarUrl: true } },
        task: { select: { id: true, title: true, projectId: true } },
      },
    } satisfies Prisma.WorklogFindManyArgs);
  }

  /**
   * The CURRENT user's running timer, if any. Hit on app load by the web
   * client so the timer chip can hydrate from server-state instead of relying
   * on local storage that may not survive a hard reload across devices.
   *
   * Returns `null` (not 404) when no timer is running so the SDK call site is
   * a straight `if (result) hydrate(...)`.
   */
  async getMyActive(actor: AuthenticatedUser): Promise<{
    id: string;
    taskId: string;
    startedAt: Date;
    note: string | null;
    task: { id: string; title: string; projectId: string; key: string };
  } | null> {
    const row = await this.prisma.worklog.findFirst({
      where: { userId: actor.id, endedAt: null },
      orderBy: { startedAt: 'desc' },
      include: {
        task: {
          select: {
            id: true,
            title: true,
            projectId: true,
            keyNumber: true,
            project: { select: { key: true } },
          },
        },
      },
    });
    if (!row) return null;
    return {
      id: row.id,
      taskId: row.taskId,
      startedAt: row.startedAt,
      note: row.note,
      task: {
        id: row.task.id,
        title: row.task.title,
        projectId: row.task.projectId,
        key: `${row.task.project.key}-${row.task.keyNumber}`,
      },
    };
  }
}
