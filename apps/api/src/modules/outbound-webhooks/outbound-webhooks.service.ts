import { createHmac, randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';
import { Queue, type JobsOptions } from 'bullmq';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthenticatedUser } from '../auth/types';
import { WorkspaceContextService } from '../workspace/workspace-context.service';

// =============================================================================
// OutboundWebhooksService
//
// Workspace-level webhook subscriptions. Distinct from automation-rule
// `send_webhook`:
//   - send_webhook is a project-scoped automation ACTION fired by the
//     automations engine when a rule matches.
//   - OutboundWebhook is a SUBSCRIPTION — the user picks the event types
//     they care about and we fan the existing EventEmitter2 stream to their
//     URL via a BullMQ-backed queue with exponential backoff retry, HMAC
//     signing, dedup, and auto-disable on consecutive failures.
//
// The two systems are intentionally separate so the automation engine
// stays focused on per-project rule evaluation and the integrations
// surface (this module) doesn't have to model triggers/filters — every
// subscribed event fires, and the receiver is responsible for any
// filtering.
// =============================================================================

export const OUTBOUND_WEBHOOKS_QUEUE = 'outbound-webhooks';

/** Bootstrap workspace id. Equal to WorkspaceContextService.DEFAULT_WORKSPACE_ID
 *  — re-exported here so existing tests that imported this name keep working
 *  after migration 0009 split workspaces into their own table. New callers
 *  should pull this from WorkspaceContextService. */
export const DEFAULT_WORKSPACE_ID = 'default';

/** Auto-disable threshold — five terminal failures in a row and we flip
 *  the webhook off. Picked to absorb a flaky receiver but not so high that
 *  a permanently dead URL piles deliveries forever. */
export const AUTO_DISABLE_THRESHOLD = 5;

/** Retry backoff schedule (ms) — 1s, 5s, 30s, 5min, 30min. Total wall time
 *  ~35min, which is long enough for a normal incident-and-recovery cycle
 *  without holding job slots indefinitely. */
export const RETRY_BACKOFF_MS = [1_000, 5_000, 30_000, 300_000, 1_800_000];
export const RETRY_ATTEMPTS = RETRY_BACKOFF_MS.length;

/** Event types we currently fan out. Strings (not an enum) so adding a new
 *  one is a one-line change here — the dispatcher catches everything via
 *  EventEmitter2.onAny but only enqueues for subscribed events that match a
 *  webhook's eventTypes array. */
export const SUPPORTED_EVENT_TYPES = [
  'task.created',
  'task.updated',
  'task.status_changed',
  'task.deleted',
  'task.assigned',
  'comment.created',    // alias for comment.added — receivers expect this name
  'comment.added',
  'sprint.started',
  'sprint.completed',
  'project.created',
  'project.archived',
  'deployment.succeeded',
  'deploy.succeeded',   // internal event name
  'automation.fired',
] as const;
export type SupportedEventType = (typeof SUPPORTED_EVENT_TYPES)[number];

export interface WebhookInput {
  name: string;
  url: string;
  secret: string;
  eventTypes: string[];
  enabled?: boolean;
}

export interface EnqueueDeliveryJob {
  webhookId: string;
  eventType: string;
  payload: Record<string, unknown>;
  deliveryId: string;
}

@Injectable()
export class OutboundWebhooksService implements OnModuleInit {
  private readonly logger = new Logger(OutboundWebhooksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly emitter: EventEmitter2,
    @InjectQueue(OUTBOUND_WEBHOOKS_QUEUE) private readonly queue: Queue,
    private readonly workspaceCtx?: WorkspaceContextService,
  ) {}

  onModuleInit(): void {
    // Fan-out subscription: catch every event the app emits and route the
    // configured ones to enabled webhooks. Using onAny (vs N @OnEvent
    // listeners) keeps the supported event list maintained in ONE place —
    // SUPPORTED_EVENT_TYPES — and means new events show up automatically as
    // long as a webhook subscribes to them.
    //
    // We could use @OnEvent decorators per event but that scatters the
    // subscription list across the file; onAny + a switch on eventName
    // keeps it co-located with the dedup + workspace-resolution logic.
    this.emitter.onAny((event, payload) => {
      const name = Array.isArray(event) ? event.join('.') : (event as string);
      if (!SUPPORTED_EVENT_TYPES.includes(name as SupportedEventType)) return;
      // Skip our own disabled-emission to avoid a self-fan-out loop where
      // turning off a webhook re-fires through the system.
      if (name === 'outbound_webhook.disabled') return;
      void this.enqueueForEvent(name, payload as Record<string, unknown>).catch((err) => {
        this.logger.error({ err, event: name }, 'failed to enqueue outbound webhook deliveries');
      });
    });
  }

  // ---------------------------------------------------------------- Listener

  /** Resolve the workspaceId for an event payload.
   *
   * Multi-tenant resolution order:
   *   1. Payload-supplied `workspaceId` — the emitter wins when it sets it.
   *   2. `projectId` -> Project.workspaceId — one cheap select; covers the
   *      vast majority of domain events (task.*, comment.*, sprint.*,
   *      project.*, automation.*).
   *   3. `taskId` -> Task.project.workspaceId — fallback for events that
   *      only carry the task id.
   *   4. DEFAULT_WORKSPACE_ID — last resort so a legacy event still routes
   *      to the bootstrap workspace rather than dropping silently.
   *
   * The lookup hits Prisma each call. We accept that cost (a single
   * indexed read per delivery) rather than caching here because:
   *   - Project rows change workspace rarely; the in-process cache window
   *     would have to be invalidated cross-process anyway.
   *   - WorkspaceContextService is for user-scoped resolution, not
   *     project-scoped — keeping the two separate avoids overloading
   *     either with the other's semantics. */
  private async resolveWorkspaceIdForEvent(
    payload: Record<string, unknown>,
  ): Promise<string> {
    const direct = payload['workspaceId'];
    if (typeof direct === 'string' && direct.length > 0) return direct;

    const projectId = payload['projectId'];
    if (typeof projectId === 'string' && projectId.length > 0) {
      const proj = await this.prisma.project.findUnique({
        where: { id: projectId },
        select: { workspaceId: true },
      });
      if (proj?.workspaceId) return proj.workspaceId;
    }

    const taskId = payload['taskId'];
    if (typeof taskId === 'string' && taskId.length > 0) {
      const task = await this.prisma.task.findUnique({
        where: { id: taskId },
        select: { project: { select: { workspaceId: true } } },
      });
      if (task?.project?.workspaceId) return task.project.workspaceId;
    }

    return this.workspaceCtx?.getDefault() ?? DEFAULT_WORKSPACE_ID;
  }

  /**
   * Catch an event and enqueue a delivery job for every enabled webhook
   * subscribed to that event type. Public so tests + an external dispatcher
   * (e.g. event-replay) can drive it directly.
   *
   * Dedup: BullMQ jobId is `${webhookId}:${eventType}:${entityId}:${ts}`.
   * Duplicate jobIds are rejected by BullMQ, so re-emitting the same
   * domain event (e.g. via a retry) won't duplicate deliveries.
   */
  async enqueueForEvent(eventType: string, payload: Record<string, unknown>): Promise<void> {
    const workspaceId = await this.resolveWorkspaceIdForEvent(payload);
    const webhooks = await this.prisma.outboundWebhook.findMany({
      where: {
        workspaceId,
        enabled: true,
        eventTypes: { has: eventType },
      },
      select: { id: true },
    });
    if (webhooks.length === 0) return;

    // Entity id resolution — prefer the most specific id available in the
    // payload so the dedup key is tight. Falls back to a random uuid when
    // no id is present (then dedup degrades to "don't double-enqueue the
    // exact same wall-clock moment", which is still correct).
    const entityId =
      (payload['taskId'] as string | undefined) ??
      (payload['commentId'] as string | undefined) ??
      (payload['sprintId'] as string | undefined) ??
      (payload['projectId'] as string | undefined) ??
      (payload['deploymentId'] as string | undefined) ??
      (payload['automationId'] as string | undefined) ??
      randomUUID();
    const eventTimestamp =
      typeof payload['eventTimestamp'] === 'string'
        ? (payload['eventTimestamp'] as string)
        : new Date().toISOString();

    for (const w of webhooks) {
      // Pre-create the delivery row so we have a stable id to thread through
      // the queue (BullMQ jobId is for dedup; deliveryId carries through
      // headers and is what the UI re-delivers). workspaceId is denormalised
      // onto the row (Round 6 Pass A — migration 0013) so the per-workspace
      // deliveries dashboard can filter without joining OutboundWebhook.
      const delivery = await this.prisma.webhookDelivery.create({
        data: {
          webhookId: w.id,
          workspaceId,
          eventType,
          payload: payload as Prisma.InputJsonValue,
          status: 'pending',
          attemptCount: 0,
        },
        select: { id: true },
      });
      const jobId = `${w.id}:${eventType}:${entityId}:${eventTimestamp}`;
      await this.queue
        .add(
          'deliver',
          {
            webhookId: w.id,
            eventType,
            payload,
            deliveryId: delivery.id,
          } satisfies EnqueueDeliveryJob,
          this.jobOptionsFor(jobId),
        )
        .catch((err: Error) => {
          // jobId collision is the expected dedup outcome — log + drop the
          // pre-created delivery row so we don't leave orphan pending rows.
          if (err.message?.includes('already exists')) {
            void this.prisma.webhookDelivery.delete({ where: { id: delivery.id } }).catch(() => {});
            return;
          }
          throw err;
        });
    }
  }

  /** BullMQ job options for a delivery — exponential backoff with the
   *  5-step schedule we expose. Centralized so tests can assert on the
   *  exact shape without re-deriving it. */
  jobOptionsFor(jobId: string): JobsOptions {
    return {
      jobId,
      attempts: RETRY_ATTEMPTS,
      // Custom step schedule via the 'fixed' type per-attempt would be ideal
      // but BullMQ doesn't natively support a per-attempt list. We pass the
      // schedule as a custom delay and read it from the processor using
      // attemptsMade. The exponential type below is the FALLBACK behavior
      // BullMQ uses if the processor doesn't return its own backoff; in
      // practice we throw with our chosen delay so this is a safety net.
      backoff: { type: 'custom' },
      removeOnComplete: 1000,
      removeOnFail: 5000,
    };
  }

  // ---------------------------------------------------------------- CRUD

  async list(actor: AuthenticatedUser, workspaceId: string) {
    this.assertWorkspaceAccess(actor, workspaceId, 'read');
    return this.prisma.outboundWebhook.findMany({
      where: { workspaceId },
      orderBy: [{ enabled: 'desc' }, { createdAt: 'desc' }],
      // Don't leak secret in list responses — only the create endpoint
      // returns it.
      select: this.publicProjection(),
    });
  }

  async get(actor: AuthenticatedUser, workspaceId: string, id: string) {
    this.assertWorkspaceAccess(actor, workspaceId, 'read');
    const hook = await this.prisma.outboundWebhook.findUnique({
      where: { id },
      select: this.publicProjection(),
    });
    if (!hook || hook.workspaceId !== workspaceId) {
      throw new NotFoundException('Webhook not found');
    }
    return hook;
  }

  async create(actor: AuthenticatedUser, workspaceId: string, input: WebhookInput) {
    this.assertWorkspaceAccess(actor, workspaceId, 'write');
    this.validate(input);
    const created = await this.prisma.outboundWebhook.create({
      data: {
        workspaceId,
        name: input.name.trim(),
        url: input.url.trim(),
        secret: input.secret,
        eventTypes: input.eventTypes,
        enabled: input.enabled ?? true,
        createdById: actor.id,
      },
    });
    // Returned in full ONCE here so the user can copy the secret into their
    // receiver's verifier. Subsequent reads omit it via publicProjection.
    return created;
  }

  async update(
    actor: AuthenticatedUser,
    workspaceId: string,
    id: string,
    patch: Partial<WebhookInput>,
  ) {
    this.assertWorkspaceAccess(actor, workspaceId, 'write');
    const existing = await this.prisma.outboundWebhook.findUnique({ where: { id } });
    if (!existing || existing.workspaceId !== workspaceId) {
      throw new NotFoundException('Webhook not found');
    }
    const merged: WebhookInput = {
      name: patch.name ?? existing.name,
      url: patch.url ?? existing.url,
      secret: patch.secret ?? existing.secret,
      eventTypes: patch.eventTypes ?? existing.eventTypes,
      enabled: patch.enabled ?? existing.enabled,
    };
    this.validate(merged);
    // Re-enabling resets the failure counter so a previously dead webhook
    // gets a clean retry budget after the user fixes the receiver.
    const failureReset = !existing.enabled && merged.enabled ? { failureCount: 0 } : {};
    return this.prisma.outboundWebhook.update({
      where: { id },
      data: {
        name: merged.name.trim(),
        url: merged.url.trim(),
        secret: merged.secret,
        eventTypes: merged.eventTypes,
        enabled: merged.enabled ?? true,
        ...failureReset,
      },
      select: this.publicProjection(),
    });
  }

  async remove(actor: AuthenticatedUser, workspaceId: string, id: string) {
    this.assertWorkspaceAccess(actor, workspaceId, 'write');
    const existing = await this.prisma.outboundWebhook.findUnique({ where: { id } });
    if (!existing || existing.workspaceId !== workspaceId) {
      throw new NotFoundException('Webhook not found');
    }
    await this.prisma.outboundWebhook.delete({ where: { id } });
    return { ok: true };
  }

  async listDeliveries(actor: AuthenticatedUser, workspaceId: string, id: string) {
    this.assertWorkspaceAccess(actor, workspaceId, 'read');
    const existing = await this.prisma.outboundWebhook.findUnique({ where: { id } });
    if (!existing || existing.workspaceId !== workspaceId) {
      throw new NotFoundException('Webhook not found');
    }
    return this.prisma.webhookDelivery.findMany({
      where: { webhookId: id },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  /** Test-fire a synthetic payload so the user can validate their receiver
   *  end-to-end before relying on a real event. Returns the delivery row;
   *  the processor will update it asynchronously. */
  async testFire(actor: AuthenticatedUser, workspaceId: string, id: string) {
    this.assertWorkspaceAccess(actor, workspaceId, 'write');
    const hook = await this.prisma.outboundWebhook.findUnique({ where: { id } });
    if (!hook || hook.workspaceId !== workspaceId) {
      throw new NotFoundException('Webhook not found');
    }
    const payload = {
      test: true,
      message: 'Nockta Flow test delivery',
      firedAt: new Date().toISOString(),
      actorUserId: actor.id,
    };
    const delivery = await this.prisma.webhookDelivery.create({
      data: {
        webhookId: id,
        workspaceId,
        eventType: 'test.delivery',
        payload,
        status: 'pending',
        attemptCount: 0,
      },
    });
    const jobId = `${id}:test.delivery:${delivery.id}`;
    await this.queue.add(
      'deliver',
      { webhookId: id, eventType: 'test.delivery', payload, deliveryId: delivery.id } satisfies EnqueueDeliveryJob,
      this.jobOptionsFor(jobId),
    );
    return delivery;
  }

  /** Re-fire a past delivery with its stored payload. Useful when the user
   *  fixes a receiver bug and wants to replay the events that 500'd. */
  async redeliver(
    actor: AuthenticatedUser,
    workspaceId: string,
    id: string,
    deliveryId: string,
  ) {
    this.assertWorkspaceAccess(actor, workspaceId, 'write');
    const hook = await this.prisma.outboundWebhook.findUnique({ where: { id } });
    if (!hook || hook.workspaceId !== workspaceId) {
      throw new NotFoundException('Webhook not found');
    }
    const original = await this.prisma.webhookDelivery.findUnique({ where: { id: deliveryId } });
    if (!original || original.webhookId !== id) {
      throw new NotFoundException('Delivery not found');
    }
    const replay = await this.prisma.webhookDelivery.create({
      data: {
        webhookId: id,
        workspaceId,
        eventType: original.eventType,
        payload: original.payload as Prisma.InputJsonValue,
        status: 'pending',
        attemptCount: 0,
      },
    });
    // Always include the replay id in the jobId so the dedup logic doesn't
    // collapse manual re-deliveries with the original.
    const jobId = `${id}:${original.eventType}:redeliver:${replay.id}`;
    await this.queue.add(
      'deliver',
      {
        webhookId: id,
        eventType: original.eventType,
        payload: original.payload as Record<string, unknown>,
        deliveryId: replay.id,
      } satisfies EnqueueDeliveryJob,
      this.jobOptionsFor(jobId),
    );
    return replay;
  }

  // ------------------------------------------------- Processor call-backs

  /** Called by the processor on a terminal failure (all retries exhausted
   *  or non-retryable status code). Bumps failureCount and auto-disables at
   *  the threshold, emitting an event so the UI / digest can surface it. */
  async recordTerminalFailure(webhookId: string, lastResponseCode: number | null): Promise<void> {
    const updated = await this.prisma.outboundWebhook.update({
      where: { id: webhookId },
      data: {
        failureCount: { increment: 1 },
        lastDeliveryAt: new Date(),
      },
      select: { id: true, failureCount: true, workspaceId: true, name: true, enabled: true, createdById: true },
    });
    if (updated.failureCount >= AUTO_DISABLE_THRESHOLD && updated.enabled) {
      await this.prisma.outboundWebhook.update({
        where: { id: webhookId },
        data: { enabled: false },
      });
      // Write a notification row so the creator sees it in the in-app bell.
      // We don't go through NotificationsService (it's owned by other passes
      // and the API is heavier than we need); a raw Notification row hits
      // the same surface.
      await this.prisma.notification
        .create({
          data: {
            recipientUserId: updated.createdById,
            type: 'OutboundWebhookDisabled',
            payload: {
              webhookId: updated.id,
              name: updated.name,
              lastResponseCode,
              reason: 'consecutive_failures',
              threshold: AUTO_DISABLE_THRESHOLD,
            },
          },
        })
        .catch(() => {
          /* don't blow up the processor over a notification row */
        });
      // Domain event so listeners (audit log, etc.) can pick it up.
      this.emitter.emit('outbound_webhook.disabled', {
        webhookId: updated.id,
        workspaceId: updated.workspaceId,
        reason: 'consecutive_failures',
        threshold: AUTO_DISABLE_THRESHOLD,
      });
    }
  }

  /** Called by the processor on a successful delivery. Resets the failure
   *  counter so a flaky receiver that's now back can rack up a fresh
   *  5-strike budget. */
  async recordSuccess(webhookId: string): Promise<void> {
    await this.prisma.outboundWebhook.update({
      where: { id: webhookId },
      data: { failureCount: 0, lastDeliveryAt: new Date() },
    });
  }

  /** Write the per-attempt delivery row update. The processor calls this
   *  after each fetch; status is 'pending' between retries, 'success' on
   *  the final 2xx, and 'failed' once attempts are exhausted. */
  async recordDelivery(
    deliveryId: string,
    update: {
      status: 'pending' | 'success' | 'failed' | 'dropped';
      attemptCount: number;
      responseCode?: number | null;
      responseExcerpt?: string | null;
    },
  ): Promise<void> {
    await this.prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: {
        status: update.status,
        attemptCount: update.attemptCount,
        responseCode: update.responseCode ?? null,
        responseExcerpt: update.responseExcerpt ?? null,
        deliveredAt:
          update.status === 'success' || update.status === 'failed' || update.status === 'dropped'
            ? new Date()
            : null,
      },
    });
  }

  // ------------------------------------------------------- Signing helpers

  /** HMAC-SHA256(hex) over the raw body. Exported so the processor and the
   *  tests share the exact same computation — we don't want two definitions
   *  drifting. */
  static computeSignature(secret: string, body: string): string {
    return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  }

  // ---------------------------------------------------------------- Internals

  private validate(input: WebhookInput): void {
    if (!input.name?.trim()) throw new BadRequestException('name is required');
    if (input.name.length > 100) throw new BadRequestException('name too long');
    if (!input.url?.trim()) throw new BadRequestException('url is required');
    try {
      const u = new URL(input.url);
      if (!['http:', 'https:'].includes(u.protocol)) {
        throw new BadRequestException('url must be http(s)');
      }
    } catch {
      throw new BadRequestException('url is not a valid URL');
    }
    if (!input.secret || input.secret.length < 16) {
      throw new BadRequestException('secret must be at least 16 characters');
    }
    if (!Array.isArray(input.eventTypes) || input.eventTypes.length === 0) {
      throw new BadRequestException('eventTypes must be a non-empty array');
    }
    for (const e of input.eventTypes) {
      if (!SUPPORTED_EVENT_TYPES.includes(e as SupportedEventType)) {
        throw new BadRequestException(`Unsupported event type: ${e}`);
      }
    }
  }

  /** Outbound webhooks are workspace-admin territory. Internal Admins always
   *  pass; internal Members pass for reads but not for writes (Manager+ in
   *  spec terms — for workspace-level resources we map that to Admin since
   *  there's no per-workspace Manager). Clients never see this surface. */
  private assertWorkspaceAccess(
    actor: AuthenticatedUser,
    _workspaceId: string,
    mode: 'read' | 'write',
  ): void {
    if (actor.kind !== 'internal') {
      throw new ForbiddenException('Workspace webhooks are internal-only');
    }
    if (mode === 'write' && actor.companyRole !== 'Admin') {
      throw new ForbiddenException('Workspace Admins only');
    }
  }

  /** Public projection — everything except the signing secret. The secret
   *  is returned ONLY by create() so the user can copy it into their
   *  receiver config one time. */
  private publicProjection() {
    return {
      id: true,
      workspaceId: true,
      name: true,
      url: true,
      eventTypes: true,
      enabled: true,
      failureCount: true,
      lastDeliveryAt: true,
      createdAt: true,
      updatedAt: true,
      createdById: true,
    } satisfies Prisma.OutboundWebhookSelect;
  }

}
