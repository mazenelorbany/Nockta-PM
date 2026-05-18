import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import type { PrismaService } from '../../prisma/prisma.service';

import type { AutomationsService } from './automations.service';

/**
 * Hooks event-emitter events into the automation engine.
 * We deliberately ignore automation-driven events (viaAutomation) to prevent
 * infinite loops where a transition_status fires task.status_changed which
 * triggers the same automation again.
 */
@Injectable()
export class AutomationsListener {
  private readonly logger = new Logger(AutomationsListener.name);

  constructor(
    private readonly automations: AutomationsService,
    private readonly prisma: PrismaService,
  ) {}

  @OnEvent('task.created', { async: true })
  async onTaskCreated(payload: Record<string, unknown>) {
    if (payload.viaAutomation) return;
    const projectId = await this.resolveProjectId(payload);
    if (!projectId) return;
    await this.automations.runMatchingAutomations(projectId, 'task_created', { ...payload, projectId });
  }

  @OnEvent('task.status_changed', { async: true })
  async onTaskStatusChanged(payload: Record<string, unknown>) {
    if (payload.viaAutomation) return;
    const projectId = await this.resolveProjectId(payload);
    if (!projectId) return;
    await this.automations.runMatchingAutomations(projectId, 'task_status_changed', { ...payload, projectId });
  }

  @OnEvent('task.updated', { async: true })
  async onTaskUpdated(payload: Record<string, unknown>) {
    if (payload.viaAutomation) return;
    const changes = (payload.changes ?? {}) as Record<string, unknown>;
    const projectId = await this.resolveProjectId(payload);
    if (!projectId) return;

    if ('assigneeUserId' in changes) {
      const assigneeUserId = changes.assigneeUserId as string | null;
      if (assigneeUserId) {
        await this.automations.runMatchingAutomations(projectId, 'task_assigned', {
          ...payload, projectId, assigneeUserId,
        });
      } else {
        await this.automations.runMatchingAutomations(projectId, 'task_unassigned', {
          ...payload, projectId,
        });
      }
    }
  }

  @OnEvent('task.blocked', { async: true })
  async onTaskBlocked(payload: Record<string, unknown>) {
    if (payload.viaAutomation) return;
    const projectId = await this.resolveProjectId(payload);
    if (!projectId) return;
    await this.automations.runMatchingAutomations(projectId, 'task_blocked', { ...payload, projectId });
  }

  @OnEvent('task.labeled', { async: true })
  async onTaskLabeled(payload: Record<string, unknown>) {
    if (payload.viaAutomation) return;
    const projectId = (payload.projectId as string | undefined) ?? await this.resolveProjectId(payload);
    if (!projectId) return;
    await this.automations.runMatchingAutomations(projectId, 'task_labeled', { ...payload, projectId });
  }

  @OnEvent('comment.added', { async: true })
  async onCommentAdded(payload: Record<string, unknown>) {
    if (payload.viaAutomation) return;
    const projectId = await this.resolveProjectId(payload);
    if (!projectId) return;
    await this.automations.runMatchingAutomations(projectId, 'comment_added', { ...payload, projectId });
  }

  /** Fired by the in-process DueSoonScheduler when a task crosses into the
   *  next-24h window. The scheduler is responsible for de-duplicating so this
   *  listener only sees each task once per due-date crossing. */
  @OnEvent('task.due_soon', { async: true })
  async onTaskDueSoon(payload: Record<string, unknown>) {
    if (payload.viaAutomation) return;
    const projectId = await this.resolveProjectId(payload);
    if (!projectId) return;
    await this.automations.runMatchingAutomations(projectId, 'task_due_soon', { ...payload, projectId });
  }

  /** Resolve the project from a payload — fall back to looking up the task if needed. */
  private async resolveProjectId(payload: Record<string, unknown>): Promise<string | null> {
    if (typeof payload.projectId === 'string') return payload.projectId;
    const taskId = payload.taskId as string | undefined;
    if (!taskId) return null;
    const task = await this.prisma.task.findUnique({
      where: { id: taskId }, select: { projectId: true },
    }).catch(() => null);
    return task?.projectId ?? null;
  }
}
