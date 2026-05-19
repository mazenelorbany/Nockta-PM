import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { Priority, RecurrenceFrequency, Visibility } from '@prisma/client';
import { generateKeyBetween } from 'fractional-indexing';

import { PrismaService } from '../../prisma/prisma.service';
import { PermissionsService } from '../permissions/permissions.service';
import type { AuthenticatedUser } from '../auth/types';

export interface RecurrenceInput {
  frequency: RecurrenceFrequency;
  interval?: number;
  weekdays?: number[];
  dayOfMonth?: number | null;
  timezone?: string;
  endsAt?: string | null;
  enabled?: boolean;
}

@Injectable()
export class RecurrenceService {
  private readonly logger = new Logger(RecurrenceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionsService,
    private readonly events: EventEmitter2,
  ) {}

  async getForTask(actor: AuthenticatedUser, taskId: string) {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: { projectId: true, visibility: true },
    });
    if (!task) throw new NotFoundException('Task not found');
    if (!(await this.permissions.canSeeTask(actor, task.projectId, task.visibility))) {
      throw new NotFoundException('Task not found');
    }
    return this.prisma.taskRecurrence.findUnique({ where: { taskId } });
  }

  async upsert(actor: AuthenticatedUser, taskId: string, input: RecurrenceInput) {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId }, select: { projectId: true },
    });
    if (!task) throw new NotFoundException('Task not found');
    await this.permissions.assertAtLeast(actor, task.projectId, 'Contributor');
    this.validate(input);

    const next = this.computeNextRun({
      frequency: input.frequency,
      interval: input.interval ?? 1,
      weekdays: input.weekdays ?? [],
      dayOfMonth: input.dayOfMonth ?? null,
      from: new Date(),
    });

    return this.prisma.taskRecurrence.upsert({
      where: { taskId },
      update: {
        frequency: input.frequency,
        interval: input.interval ?? 1,
        weekdays: input.weekdays ?? [],
        dayOfMonth: input.dayOfMonth ?? null,
        timezone: input.timezone ?? 'UTC',
        endsAt: input.endsAt ? new Date(input.endsAt) : null,
        enabled: input.enabled ?? true,
        nextRunAt: next,
      },
      create: {
        taskId,
        frequency: input.frequency,
        interval: input.interval ?? 1,
        weekdays: input.weekdays ?? [],
        dayOfMonth: input.dayOfMonth ?? null,
        timezone: input.timezone ?? 'UTC',
        endsAt: input.endsAt ? new Date(input.endsAt) : null,
        enabled: input.enabled ?? true,
        nextRunAt: next,
      },
    });
  }

  async remove(actor: AuthenticatedUser, taskId: string) {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId }, select: { projectId: true },
    });
    if (!task) throw new NotFoundException('Task not found');
    await this.permissions.assertAtLeast(actor, task.projectId, 'Contributor');
    await this.prisma.taskRecurrence.delete({ where: { taskId } }).catch(() => { /* idempotent */ });
    return { ok: true };
  }

  // ---------- Worker entrypoint ----------

  /**
   * Spawn copies for every due, enabled recurrence. Called from the recurrence
   * cron-style job. Idempotent: re-running before nextRunAt is harmless.
   */
  async spawnDueRecurrences(now: Date = new Date()): Promise<{ spawned: number }> {
    const due = await this.prisma.taskRecurrence.findMany({
      where: {
        enabled: true,
        nextRunAt: { lte: now },
        OR: [{ endsAt: null }, { endsAt: { gt: now } }],
      },
      include: {
        task: {
          include: { labels: { include: { label: true } } },
        },
      },
      take: 100,
    });

    let spawned = 0;
    for (const r of due) {
      try {
        await this.spawnOne(r);
        spawned += 1;
      } catch (err) {
        this.logger.error(`Failed to spawn recurrence ${r.id}: ${err instanceof Error ? err.message : err}`);
      }
    }
    return { spawned };
  }

  private async spawnOne(r: {
    id: string; taskId: string; frequency: RecurrenceFrequency;
    interval: number; weekdays: number[]; dayOfMonth: number | null;
    task: { projectId: string; title: string; description: string | null; priority: Priority; assigneeUserId: string | null; reporterUserId: string; createdById: string; estimate: number | null; sprintId: string | null; status: string; visibility: Visibility; labels: { label: { id: string } }[] };
  }): Promise<void> {
    const project = await this.prisma.project.findUniqueOrThrow({
      where: { id: r.task.projectId },
      select: { id: true, key: true, nextTaskNumber: true },
    });

    // Place the spawned task at the bottom of its column (same status as the
    // template task). The original code looked for 'Backlog' which doesn't
    // exist in any workflow preset — that produced degraded board ordering.
    const last = await this.prisma.task.findFirst({
      where: { projectId: project.id, status: r.task.status },
      orderBy: { boardPosition: 'desc' },
      select: { boardPosition: true },
    });
    const boardPosition = generateKeyBetween(last?.boardPosition ?? null, null);

    const updatedProject = await this.prisma.project.update({
      where: { id: project.id },
      data: { nextTaskNumber: { increment: 1 } },
      select: { nextTaskNumber: true },
    });
    const keyNumber = updatedProject.nextTaskNumber - 1;

    const created = await this.prisma.task.create({
      data: {
        projectId: project.id,
        keyNumber,
        title: r.task.title,
        description: r.task.description,
        status: r.task.status,
        priority: r.task.priority,
        visibility: r.task.visibility,
        assigneeUserId: r.task.assigneeUserId,
        reporterUserId: r.task.reporterUserId,
        createdById: r.task.createdById,
        estimate: r.task.estimate,
        sprintId: r.task.sprintId,
        boardPosition,
        watchers: { create: [{ userId: r.task.createdById }] },
        labels: r.task.labels.length
          ? { create: r.task.labels.map((l) => ({ labelId: l.label.id, addedById: r.task.createdById })) }
          : undefined,
      },
    });

    const nextRunAt = this.computeNextRun({
      frequency: r.frequency,
      interval: r.interval,
      weekdays: r.weekdays,
      dayOfMonth: r.dayOfMonth,
      from: new Date(),
    });

    await this.prisma.taskRecurrence.update({
      where: { id: r.id },
      data: { lastRunAt: new Date(), nextRunAt },
    });

    this.events.emit('task.created', {
      taskId: created.id,
      projectId: project.id,
      key: `${project.key}-${keyNumber}`,
      actorUserId: r.task.createdById,
      assigneeUserId: created.assigneeUserId,
      viaRecurrence: r.id,
    });
  }

  // ---------- Helpers ----------

  private validate(input: RecurrenceInput) {
    if (!['daily', 'weekly', 'monthly'].includes(input.frequency)) {
      throw new BadRequestException('Invalid frequency');
    }
    if (input.interval !== undefined && (input.interval < 1 || input.interval > 365)) {
      throw new BadRequestException('Interval must be 1..365');
    }
    if (input.weekdays) {
      for (const d of input.weekdays) {
        if (d < 0 || d > 6) throw new BadRequestException('weekdays must be 0..6');
      }
    }
    if (input.dayOfMonth !== undefined && input.dayOfMonth !== null) {
      if (input.dayOfMonth < 1 || input.dayOfMonth > 28) {
        throw new BadRequestException('dayOfMonth must be 1..28');
      }
    }
  }

  private computeNextRun(opts: {
    frequency: RecurrenceFrequency;
    interval: number;
    weekdays: number[];
    dayOfMonth: number | null;
    from: Date;
  }): Date {
    const { frequency, interval, weekdays, dayOfMonth, from } = opts;
    const next = new Date(from);
    // Reset to start of the next minute for cleanliness.
    next.setSeconds(0, 0);
    next.setMinutes(next.getMinutes() + 1);

    if (frequency === 'daily') {
      next.setDate(next.getDate() + interval);
      return next;
    }
    if (frequency === 'weekly') {
      if (weekdays.length === 0) {
        next.setDate(next.getDate() + 7 * interval);
        return next;
      }
      // Find the next weekday in the list.
      const sorted = [...weekdays].sort((a, b) => a - b);
      const currentDow = next.getUTCDay();
      for (const d of sorted) {
        if (d > currentDow) {
          next.setDate(next.getDate() + (d - currentDow));
          return next;
        }
      }
      // Wrap into next interval-cycle.
      const daysUntilFirst = (7 - currentDow) + sorted[0];
      next.setDate(next.getDate() + daysUntilFirst + 7 * (interval - 1));
      return next;
    }
    if (frequency === 'monthly') {
      const target = dayOfMonth ?? next.getDate();
      next.setMonth(next.getMonth() + interval);
      const lastDayOfTargetMonth = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
      next.setDate(Math.min(target, lastDayOfTargetMonth));
      return next;
    }
    return next;
  }
}
