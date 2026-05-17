import {
  BadRequestException, ForbiddenException, Injectable, NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma, type AutomationAction, type AutomationTrigger, type Priority } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { PermissionsService } from '../permissions/permissions.service';
import type { AuthenticatedUser } from '../auth/types';

type JsonObject = Record<string, unknown>;

export interface AutomationInput {
  name: string;
  description?: string | null;
  enabled?: boolean;
  trigger: AutomationTrigger;
  triggerConfig?: JsonObject;
  action: AutomationAction;
  actionConfig?: JsonObject;
}

@Injectable()
export class AutomationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionsService,
    private readonly events: EventEmitter2,
  ) {}

  // -------- CRUD --------

  async listForProject(actor: AuthenticatedUser, projectId: string) {
    await this.permissions.assertAtLeast(actor, projectId, 'Viewer');
    return this.prisma.automation.findMany({
      where: { projectId },
      orderBy: [{ enabled: 'desc' }, { createdAt: 'desc' }],
      include: {
        createdBy: { select: { id: true, name: true, avatarUrl: true } },
      },
    });
  }

  async get(actor: AuthenticatedUser, automationId: string) {
    const a = await this.prisma.automation.findUnique({
      where: { id: automationId },
      include: {
        createdBy: { select: { id: true, name: true, avatarUrl: true } },
        runs: { orderBy: { createdAt: 'desc' }, take: 20 },
      },
    });
    if (!a) throw new NotFoundException('Automation not found');
    await this.permissions.assertAtLeast(actor, a.projectId, 'Viewer');
    return a;
  }

  async create(actor: AuthenticatedUser, projectId: string, input: AutomationInput) {
    await this.permissions.assertAtLeast(actor, projectId, 'Manager');
    this.validate(input);
    const created = await this.prisma.automation.create({
      data: {
        projectId,
        name: input.name.trim(),
        description: input.description?.trim() || null,
        enabled: input.enabled ?? true,
        trigger: input.trigger,
        triggerConfig: (input.triggerConfig ?? {}) as Prisma.InputJsonValue,
        action: input.action,
        actionConfig: (input.actionConfig ?? {}) as Prisma.InputJsonValue,
        createdById: actor.id,
      },
    });
    this.events.emit('automation.created', {
      automationId: created.id, projectId, actorUserId: actor.id,
    });
    return created;
  }

  async update(actor: AuthenticatedUser, automationId: string, input: Partial<AutomationInput>) {
    const existing = await this.prisma.automation.findUnique({ where: { id: automationId } });
    if (!existing) throw new NotFoundException('Automation not found');
    await this.permissions.assertAtLeast(actor, existing.projectId, 'Manager');

    const merged: AutomationInput = {
      name: input.name ?? existing.name,
      description: input.description ?? existing.description,
      enabled: input.enabled ?? existing.enabled,
      trigger: input.trigger ?? existing.trigger,
      triggerConfig: (input.triggerConfig ?? (existing.triggerConfig as JsonObject)) as JsonObject,
      action: input.action ?? existing.action,
      actionConfig: (input.actionConfig ?? (existing.actionConfig as JsonObject)) as JsonObject,
    };
    this.validate(merged);

    return this.prisma.automation.update({
      where: { id: automationId },
      data: {
        name: merged.name,
        description: merged.description,
        enabled: merged.enabled,
        trigger: merged.trigger,
        triggerConfig: merged.triggerConfig as Prisma.InputJsonValue,
        action: merged.action,
        actionConfig: merged.actionConfig as Prisma.InputJsonValue,
      },
    });
  }

  async toggle(actor: AuthenticatedUser, automationId: string, enabled: boolean) {
    const existing = await this.prisma.automation.findUnique({ where: { id: automationId } });
    if (!existing) throw new NotFoundException('Automation not found');
    await this.permissions.assertAtLeast(actor, existing.projectId, 'Manager');
    return this.prisma.automation.update({
      where: { id: automationId },
      data: { enabled },
    });
  }

  async remove(actor: AuthenticatedUser, automationId: string) {
    const existing = await this.prisma.automation.findUnique({ where: { id: automationId } });
    if (!existing) throw new NotFoundException('Automation not found');
    await this.permissions.assertAtLeast(actor, existing.projectId, 'Manager');
    await this.prisma.automation.delete({ where: { id: automationId } });
    return { ok: true };
  }

  async listRuns(actor: AuthenticatedUser, automationId: string) {
    const a = await this.prisma.automation.findUnique({ where: { id: automationId } });
    if (!a) throw new NotFoundException('Automation not found');
    await this.permissions.assertAtLeast(actor, a.projectId, 'Viewer');
    return this.prisma.automationRun.findMany({
      where: { automationId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  // -------- Multi-step actions --------

  async listSteps(actor: AuthenticatedUser, automationId: string) {
    const a = await this.prisma.automation.findUnique({ where: { id: automationId } });
    if (!a) throw new NotFoundException('Automation not found');
    await this.permissions.assertAtLeast(actor, a.projectId, 'Viewer');
    return this.prisma.automationStep.findMany({
      where: { automationId },
      orderBy: { position: 'asc' },
    });
  }

  async addStep(
    actor: AuthenticatedUser,
    automationId: string,
    input: { action: AutomationAction; actionConfig?: JsonObject },
  ) {
    const a = await this.prisma.automation.findUnique({ where: { id: automationId } });
    if (!a) throw new NotFoundException('Automation not found');
    await this.permissions.assertAtLeast(actor, a.projectId, 'Manager');
    // Reuse the existing single-action validator so step config is sound.
    this.validate({
      name: a.name, trigger: a.trigger,
      action: input.action,
      actionConfig: input.actionConfig ?? {},
    });
    const maxPos = await this.prisma.automationStep.aggregate({
      where: { automationId }, _max: { position: true },
    });
    return this.prisma.automationStep.create({
      data: {
        automationId,
        position: (maxPos._max.position ?? -1) + 1,
        action: input.action,
        actionConfig: (input.actionConfig ?? {}) as Prisma.InputJsonValue,
      },
    });
  }

  async removeStep(actor: AuthenticatedUser, stepId: string) {
    const step = await this.prisma.automationStep.findUnique({
      where: { id: stepId },
      include: { automation: { select: { projectId: true } } },
    });
    if (!step) throw new NotFoundException('Step not found');
    await this.permissions.assertAtLeast(actor, step.automation.projectId, 'Manager');
    await this.prisma.automationStep.delete({ where: { id: stepId } });
    return { ok: true };
  }

  // -------- Execution engine — invoked by the listener --------

  /**
   * Run all enabled automations in a project that match the given trigger.
   * Designed to be called from event listeners. Never throws — failures are logged
   * to AutomationRun so users can debug from the UI.
   */
  async runMatchingAutomations(
    projectId: string,
    trigger: AutomationTrigger,
    payload: JsonObject,
  ): Promise<void> {
    const automations = await this.prisma.automation.findMany({
      where: { projectId, trigger, enabled: true },
      include: { steps: { orderBy: { position: 'asc' } } },
    });
    if (automations.length === 0) return;

    for (const a of automations) {
      try {
        const matches = this.matchesTrigger(trigger, a.triggerConfig as JsonObject, payload);
        if (!matches) {
          await this.recordRun(a.id, 'skipped', payload['taskId'] as string | undefined,
            'Trigger filter did not match', payload);
          continue;
        }
        // Step 0 = the legacy action column. Steps 1..N = extra rows.
        await this.executeAction(a, payload);
        for (const step of a.steps) {
          await this.executeAction(
            { ...a, action: step.action, actionConfig: step.actionConfig },
            payload,
          );
        }
        await this.recordRun(a.id, 'succeeded', payload['taskId'] as string | undefined,
          null, payload);
        await this.prisma.automation.update({
          where: { id: a.id },
          data: { runCount: { increment: 1 }, lastRunAt: new Date() },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await this.recordRun(a.id, 'failed', payload['taskId'] as string | undefined, msg, payload);
      }
    }
  }

  // -------- Internals --------

  private validate(input: AutomationInput) {
    if (!input.name?.trim()) throw new BadRequestException('Name is required');
    if (input.name.length > 100) throw new BadRequestException('Name too long');

    const cfg = input.actionConfig ?? {};
    switch (input.action) {
      case 'set_priority':
        if (!['Low', 'Medium', 'High', 'Critical'].includes(String(cfg.priority))) {
          throw new BadRequestException('actionConfig.priority must be Low|Medium|High|Critical');
        }
        break;
      case 'set_assignee':
        if (typeof cfg.assigneeUserId !== 'string' || !cfg.assigneeUserId) {
          throw new BadRequestException('actionConfig.assigneeUserId is required');
        }
        break;
      case 'add_label':
      case 'remove_label':
        if (typeof cfg.labelId !== 'string' || !cfg.labelId) {
          throw new BadRequestException('actionConfig.labelId is required');
        }
        break;
      case 'transition_status':
        if (typeof cfg.status !== 'string' || !cfg.status) {
          throw new BadRequestException('actionConfig.status is required');
        }
        break;
      case 'add_comment':
        if (typeof cfg.body !== 'string' || !cfg.body.trim()) {
          throw new BadRequestException('actionConfig.body is required');
        }
        break;
      case 'add_watcher':
      case 'notify_user':
        if (typeof cfg.userId !== 'string' || !cfg.userId) {
          throw new BadRequestException('actionConfig.userId is required');
        }
        break;
      case 'set_due_date':
        if (typeof cfg.offsetDays !== 'number') {
          throw new BadRequestException('actionConfig.offsetDays is required (number)');
        }
        break;
      case 'set_sprint':
        // sprintId may be null (= unset sprint)
        if (cfg.sprintId !== null && typeof cfg.sprintId !== 'string') {
          throw new BadRequestException('actionConfig.sprintId must be string or null');
        }
        break;
      case 'send_webhook': {
        if (typeof cfg.url !== 'string' || !cfg.url) {
          throw new BadRequestException('actionConfig.url is required');
        }
        try {
          const u = new URL(cfg.url);
          if (!['http:', 'https:'].includes(u.protocol)) {
            throw new BadRequestException('actionConfig.url must be http(s)');
          }
        } catch {
          throw new BadRequestException('actionConfig.url is not a valid URL');
        }
        if (cfg.headers !== undefined && (typeof cfg.headers !== 'object' || cfg.headers === null)) {
          throw new BadRequestException('actionConfig.headers must be an object');
        }
        if (cfg.secret !== undefined && typeof cfg.secret !== 'string') {
          throw new BadRequestException('actionConfig.secret must be a string');
        }
        break;
      }
    }
  }

  private matchesTrigger(
    trigger: AutomationTrigger,
    triggerConfig: JsonObject,
    payload: JsonObject,
  ): boolean {
    // task_status_changed: optional { fromStatus, toStatus }
    if (trigger === 'task_status_changed') {
      if (triggerConfig.fromStatus && triggerConfig.fromStatus !== payload.fromStatus) return false;
      if (triggerConfig.toStatus && triggerConfig.toStatus !== payload.toStatus) return false;
      return true;
    }
    // task_labeled: optional { labelId }
    if (trigger === 'task_labeled') {
      if (triggerConfig.labelId && triggerConfig.labelId !== payload.labelId) return false;
      return true;
    }
    // task_assigned: optional { assigneeUserId }
    if (trigger === 'task_assigned') {
      if (
        triggerConfig.assigneeUserId &&
        triggerConfig.assigneeUserId !== payload.assigneeUserId
      ) return false;
      return true;
    }
    // Other triggers have no filter for now — always match.
    return true;
  }

  private async executeAction(
    automation: { id: string; projectId: string; action: AutomationAction; actionConfig: unknown; createdById: string },
    payload: JsonObject,
  ): Promise<void> {
    const cfg = (automation.actionConfig ?? {}) as JsonObject;
    const taskId = payload.taskId as string | undefined;
    if (!taskId) {
      // Nothing to act on if there's no task in scope.
      throw new Error('No taskId in trigger payload');
    }

    switch (automation.action) {
      case 'set_priority': {
        await this.prisma.task.update({
          where: { id: taskId },
          data: { priority: cfg.priority as Priority },
        });
        break;
      }
      case 'set_assignee': {
        await this.prisma.task.update({
          where: { id: taskId },
          data: { assigneeUserId: cfg.assigneeUserId as string },
        });
        await this.prisma.taskWatcher.upsert({
          where: { userId_taskId: { userId: cfg.assigneeUserId as string, taskId } },
          update: {},
          create: { userId: cfg.assigneeUserId as string, taskId },
        });
        break;
      }
      case 'add_label': {
        await this.prisma.taskLabel.upsert({
          where: { taskId_labelId: { taskId, labelId: cfg.labelId as string } },
          update: {},
          create: { taskId, labelId: cfg.labelId as string, addedById: automation.createdById },
        });
        break;
      }
      case 'remove_label': {
        await this.prisma.taskLabel.delete({
          where: { taskId_labelId: { taskId, labelId: cfg.labelId as string } },
        }).catch(() => { /* idempotent */ });
        break;
      }
      case 'transition_status': {
        await this.prisma.task.update({
          where: { id: taskId },
          data: { status: cfg.status as string },
        });
        this.events.emit('task.status_changed', {
          taskId,
          fromStatus: payload.toStatus ?? payload.fromStatus ?? null,
          toStatus: cfg.status as string,
          triggeredBy: 'system',
          actorUserId: automation.createdById,
          projectId: automation.projectId,
          viaAutomation: automation.id,
        });
        break;
      }
      case 'add_comment': {
        await this.prisma.comment.create({
          data: {
            taskId,
            authorUserId: automation.createdById,
            bodyMd: String(cfg.body),
            visibility: 'internal',
          },
        });
        this.events.emit('comment.added', {
          taskId, projectId: automation.projectId,
          actorUserId: automation.createdById,
          viaAutomation: automation.id,
        });
        break;
      }
      case 'add_watcher': {
        await this.prisma.taskWatcher.upsert({
          where: { userId_taskId: { userId: cfg.userId as string, taskId } },
          update: {},
          create: { userId: cfg.userId as string, taskId },
        });
        break;
      }
      case 'notify_user': {
        await this.prisma.notification.create({
          data: {
            recipientUserId: cfg.userId as string,
            type: 'AutomationNotify',
            payload: {
              automationId: automation.id,
              taskId,
              message: cfg.message ?? 'Automation triggered',
            },
            relatedTaskId: taskId,
            relatedProjectId: automation.projectId,
          },
        });
        break;
      }
      case 'set_due_date': {
        const days = Number(cfg.offsetDays);
        const due = new Date();
        due.setDate(due.getDate() + days);
        await this.prisma.task.update({
          where: { id: taskId },
          data: { dueDate: due },
        });
        break;
      }
      case 'set_sprint': {
        await this.prisma.task.update({
          where: { id: taskId },
          data: { sprintId: (cfg.sprintId as string | null) ?? null },
        });
        break;
      }
      case 'send_webhook': {
        // POST the trigger payload + a small task snapshot to a user-defined
        // URL. Optional `secret` adds an HMAC-SHA256 signature header so the
        // receiver can verify authenticity. We use a hard 10s timeout so a
        // dead URL doesn't stall the automation pipeline.
        const url = String(cfg.url);
        const userHeaders = (cfg.headers ?? {}) as Record<string, string>;
        const secret = typeof cfg.secret === 'string' ? cfg.secret : undefined;

        const task = await this.prisma.task.findUnique({
          where: { id: taskId },
          select: {
            id: true, keyNumber: true, title: true, status: true, priority: true,
            isBlocked: true, projectId: true,
            project: { select: { key: true, name: true } },
          },
        });

        const body = JSON.stringify({
          automationId: automation.id,
          projectId: automation.projectId,
          taskId,
          trigger: payload,
          task: task ? {
            id: task.id,
            key: `${task.project.key}-${task.keyNumber}`,
            title: task.title,
            status: task.status,
            priority: task.priority,
            isBlocked: task.isBlocked,
            project: task.project.name,
          } : null,
          firedAt: new Date().toISOString(),
        });

        const headers: Record<string, string> = {
          'content-type': 'application/json',
          'x-nockta-automation': automation.id,
          ...userHeaders,
        };
        if (secret) {
          // HMAC-SHA256 hex digest over the request body. Receiver computes
          // the same and compares with timing-safe equals.
          const { createHmac } = await import('node:crypto');
          headers['x-nockta-signature'] = createHmac('sha256', secret).update(body).digest('hex');
        }

        // Retry once on transient failures with a short backoff. Receivers
        // can be flaky (transient 502s, cold-start latency). We DO NOT retry
        // on 4xx — those are the receiver's contract problem, not ours, and
        // double-firing on a 400 just doubles the noise. Total wall time
        // bounded to ~12s (10s timeout + 2s backoff + 10s second attempt).
        //
        // Earlier version had a subtle bug: a non-retryable 400 was thrown
        // inside the inner try block, then caught and swallowed at attempt=0
        // (because `if (attempt > 0) throw err`). The loop then iterated
        // anyway and DID retry the 400. Fix: explicit `nonRetryableErr`
        // sentinel that bypasses the retry loop entirely.
        const RETRYABLE = (status: number): boolean =>
          status === 0 || status === 408 || status === 429 || status >= 500;

        let attempt = 0;
        let lastErr: unknown;
        let nonRetryableErr: unknown;
        while (attempt < 2) {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 10_000);
          try {
            const res = await fetch(url, {
              method: 'POST',
              headers,
              body,
              signal: controller.signal,
            });
            if (res.ok) {
              lastErr = undefined;
              break;
            }
            // Non-OK: store as retryable or non-retryable. Network/abort
            // errors caught below are ALWAYS retryable (we can't tell the
            // receiver's intent from a network failure).
            if (RETRYABLE(res.status)) {
              lastErr = new Error(`Webhook responded ${res.status}`);
            } else {
              nonRetryableErr = new Error(`Webhook responded ${res.status}`);
              break;
            }
          } catch (err) {
            lastErr = err;
          } finally {
            clearTimeout(timeout);
          }
          attempt += 1;
          if (attempt < 2 && lastErr) {
            await new Promise((r) => setTimeout(r, 2000));
          }
        }
        if (nonRetryableErr) throw nonRetryableErr;
        if (lastErr) throw lastErr;
        break;
      }
    }
  }

  private async recordRun(
    automationId: string,
    status: 'succeeded' | 'skipped' | 'failed',
    taskId: string | undefined,
    message: string | null,
    payload: JsonObject,
  ) {
    await this.prisma.automationRun.create({
      data: {
        automationId,
        taskId: taskId ?? null,
        status,
        message,
        payload: payload as Prisma.InputJsonValue,
      },
    }).catch(() => { /* don't blow up real work over a log row */ });
  }
}
