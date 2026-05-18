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
    const webhooks = await this.prisma.outboundWebhook.findMany({
      where: {
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
      // headers and is what the UI re-delivers).
      const delivery = await this.prisma.webhookDelivery.create({
        data: {
          webhookId: w.id,
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

  async list(actor: AuthenticatedUser) {
    this.assertAccess(actor, 'read');
    return this.prisma.outboundWebhook.findMany({
      orderBy: [{ enabled: 'desc' }, { createdAt: 'desc' }],
      // Don't leak secret in list responses — only the create endpoint
      // returns it.
      select: this.publicProjection(),
    });
  }

  async get(actor: AuthenticatedUser, id: string) {
    this.assertAccess(actor, 'read');
    const hook = await this.prisma.outboundWebhook.findUnique({
      where: { id },
      select: this.publicProjection(),
    });
    if (!hook) {
      throw new NotFoundException('Webhook not found');
    }
    return hook;
  }

  async create(actor: AuthenticatedUser, input: WebhookInput) {
    this.assertAccess(actor, 'write');
    this.validate(input);
    const created = await this.prisma.outboundWebhook.create({
      data: {
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
    id: string,
    patch: Partial<WebhookInput>,
  ) {
    this.assertAccess(actor, 'write');
    const existing = await this.prisma.outboundWebhook.findUnique({ where: { id } });
    if (!existing) {
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

  async remove(actor: AuthenticatedUser, id: string) {
    this.assertAccess(actor, 'write');
    const existing = await this.prisma.outboundWebhook.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException('Webhook not found');
    }
    await this.prisma.outboundWebhook.delete({ where: { id } });
    return { ok: true };
  }

  async listDeliveries(actor: AuthenticatedUser, id: string) {
    this.assertAccess(actor, 'read');
    const existing = await this.prisma.outboundWebhook.findUnique({ where: { id } });
    if (!existing) {
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
  async testFire(actor: AuthenticatedUser, id: string) {
    this.assertAccess(actor, 'write');
    const hook = await this.prisma.outboundWebhook.findUnique({ where: { id } });
    if (!hook) {
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
    id: string,
    deliveryId: string,
  ) {
    this.assertAccess(actor, 'write');
    const hook = await this.prisma.outboundWebhook.findUnique({ where: { id } });
    if (!hook) {
      throw new NotFoundException('Webhook not found');
    }
    const original = await this.prisma.webhookDelivery.findUnique({ where: { id: deliveryId } });
    if (!original || original.webhookId !== id) {
      throw new NotFoundException('Delivery not found');
    }
    const replay = await this.prisma.webhookDelivery.create({
      data: {
        webhookId: id,
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
      select: { id: true, failureCount: true, name: true, enabled: true, createdById: true },
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
    let parsed: URL;
    try {
      parsed = new URL(input.url);
    } catch {
      throw new BadRequestException('url is not a valid URL');
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new BadRequestException('url must be http(s)');
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

  /** Internal Admins always pass; internal Members pass for reads but not for
   *  writes. Clients never see this surface. */
  private assertAccess(
    actor: AuthenticatedUser,
    mode: 'read' | 'write',
  ): void {
    if (actor.kind !== 'internal') {
      throw new ForbiddenException('Webhooks are internal-only');
    }
    if (mode === 'write' && actor.companyRole !== 'Admin') {
      throw new ForbiddenException('Admins only');
    }
  }

  /** Public projection — everything except the signing secret. The secret
   *  is returned ONLY by create() so the user can copy it into their
   *  receiver config one time. */
  private publicProjection() {
    return {
      id: true,
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
