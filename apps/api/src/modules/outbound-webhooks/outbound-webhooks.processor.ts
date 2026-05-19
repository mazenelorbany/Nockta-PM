import { randomUUID } from 'node:crypto';

import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';

import { PrismaService } from '../../prisma/prisma.service';

import {
  OUTBOUND_WEBHOOKS_QUEUE,
  OutboundWebhooksService,
  RETRY_ATTEMPTS,
  RETRY_BACKOFF_MS,
  type EnqueueDeliveryJob,
} from './outbound-webhooks.service';

// =============================================================================
// OutboundWebhookProcessor
//
// Delivers a payload to the receiver URL with a hard 10s timeout per attempt.
// Retries on transient failures (network errors, 408, 429, 5xx) on the
// service's published backoff schedule (1s / 5s / 30s / 5min / 30min).
// Non-retryable statuses (4xx other than 408/429) fail terminally so a
// misconfigured receiver doesn't burn through the retry budget.
//
// Headers per delivery attempt:
//   - X-Nockta-Event:     event type, e.g. 'task.created'
//   - X-Nockta-Delivery:  fresh UUID per ATTEMPT — receivers can de-dup by it
//   - X-Nockta-Signature: 'sha256=<hex>' HMAC over the raw body
//   - Content-Type:       application/json
// =============================================================================

const REQUEST_TIMEOUT_MS = 10_000;
const RESPONSE_EXCERPT_BYTES = 1024;

function isRetryable(status: number): boolean {
  return status === 0 || status === 408 || status === 429 || status >= 500;
}

// Register the custom backoff strategy on the worker so BullMQ asks us
// for the delay when retrying. The strategy lives in the same file so the
// schedule + the worker option ship together.
@Processor(OUTBOUND_WEBHOOKS_QUEUE, {
  settings: { backoffStrategy: (attemptsMade: number) => customBackoffStrategy(attemptsMade) },
})
export class OutboundWebhookProcessor extends WorkerHost {
  private readonly logger = new Logger(OutboundWebhookProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly webhooks: OutboundWebhooksService,
  ) {
    super();
  }

  async process(job: Job<EnqueueDeliveryJob>): Promise<void> {
    const { webhookId, eventType, payload, deliveryId } = job.data;
    const attempt = (job.attemptsMade ?? 0) + 1;

    // Re-read the webhook every attempt — the user may have disabled it
    // between retries, in which case we mark the delivery dropped and exit
    // rather than spending the next backoff slot.
    const hook = await this.prisma.outboundWebhook.findUnique({ where: { id: webhookId } });
    if (!hook) {
      await this.webhooks.recordDelivery(deliveryId, {
        status: 'dropped',
        attemptCount: attempt,
      });
      return;
    }
    if (!hook.enabled) {
      await this.webhooks.recordDelivery(deliveryId, {
        status: 'dropped',
        attemptCount: attempt,
      });
      return;
    }

    const body = JSON.stringify({
      event: eventType,
      data: payload,
      firedAt: new Date().toISOString(),
      deliveryId,
    });
    const signature = OutboundWebhooksService.computeSignature(hook.secret, body);
    const deliveryUuid = randomUUID();

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let responseCode: number | null = null;
    let responseExcerpt: string | null = null;
    let networkErr: unknown;
    try {
      const res = await fetch(hook.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-nockta-event': eventType,
          'x-nockta-delivery': deliveryUuid,
          'x-nockta-signature': signature,
        },
        body,
        signal: controller.signal,
      });
      responseCode = res.status;
      try {
        // Cap the captured body — receivers can legitimately stream a huge
        // response, and we never want to pin gigabytes in Postgres for what
        // is debugging UI.
        const text = await res.text();
        responseExcerpt = text.slice(0, RESPONSE_EXCERPT_BYTES);
      } catch {
        responseExcerpt = null;
      }
      if (res.ok) {
        await this.webhooks.recordDelivery(deliveryId, {
          status: 'success',
          attemptCount: attempt,
          responseCode,
          responseExcerpt,
        });
        await this.webhooks.recordSuccess(webhookId);
        return;
      }
      if (!isRetryable(res.status)) {
        // Non-retryable terminal — record + bump consecutive failures.
        await this.webhooks.recordDelivery(deliveryId, {
          status: 'failed',
          attemptCount: attempt,
          responseCode,
          responseExcerpt,
        });
        await this.webhooks.recordTerminalFailure(webhookId, responseCode);
        return;
      }
      // Retryable: throw to let BullMQ rerun us with our chosen delay.
    } catch (err) {
      networkErr = err;
    } finally {
      clearTimeout(timeoutHandle);
    }

    // Reaching here means either retryable HTTP status or network error.
    if (attempt >= RETRY_ATTEMPTS) {
      // Final attempt — terminal failure.
      await this.webhooks.recordDelivery(deliveryId, {
        status: 'failed',
        attemptCount: attempt,
        responseCode,
        responseExcerpt:
          responseExcerpt ?? (networkErr instanceof Error ? networkErr.message : null),
      });
      await this.webhooks.recordTerminalFailure(webhookId, responseCode);
      return;
    }

    // Not the last attempt — record progress, then throw so BullMQ retries.
    await this.webhooks.recordDelivery(deliveryId, {
      status: 'pending',
      attemptCount: attempt,
      responseCode,
      responseExcerpt:
        responseExcerpt ?? (networkErr instanceof Error ? networkErr.message : null),
    });

    const reason =
      networkErr instanceof Error
        ? networkErr.message
        : `Receiver responded ${responseCode}`;
    this.logger.warn(
      { webhookId, deliveryId, attempt, responseCode, reason },
      'outbound webhook delivery failed; will retry',
    );
    // internal: not reached from an HTTP request — signals BullMQ to retry the job.
    throw new Error(reason);
  }
}

/** BullMQ `backoff` strategy registered with the worker. The processor
 *  decorator above is enough for delivery; the strategy itself is exported
 *  here so the queue's worker creation in the module can register it. */
export function customBackoffStrategy(attemptsMade: number): number {
  const idx = Math.max(0, Math.min(attemptsMade - 1, RETRY_BACKOFF_MS.length - 1));
  return RETRY_BACKOFF_MS[idx]!;
}
