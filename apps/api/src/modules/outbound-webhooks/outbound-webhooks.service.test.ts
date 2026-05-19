import { createHmac } from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Queue } from 'bullmq';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { makePrismaMock } from '../../test-utils/mocks';
import type { PrismaService } from '../../prisma/prisma.service';
import type { AuthenticatedUser } from '../auth/types';

import {
  AUTO_DISABLE_THRESHOLD,
  OutboundWebhooksService,
  RETRY_ATTEMPTS,
  RETRY_BACKOFF_MS,
} from './outbound-webhooks.service';
import { customBackoffStrategy } from './outbound-webhooks.processor';

// Legacy constant retained for tests that pre-date the workspace removal.
const DEFAULT_WORKSPACE_ID = 'default';

// =============================================================================
// outbound-webhooks.service — the behaviors that absolutely must not regress:
//
//   - HMAC signature is deterministic for a given (secret, body) and uses the
//     sha256= prefix the receiver verifier expects.
//   - Retry backoff schedule is the documented 5-step exponential (1s, 5s,
//     30s, 5min, 30min) and BullMQ asks the strategy function for that exact
//     value per attempt.
//   - 5 consecutive terminal failures auto-disable the webhook and emit
//     `outbound_webhook.disabled`.
//   - Dedup: enqueuing the same logical event twice doesn't double-deliver
//     (BullMQ rejects duplicate jobIds; we tolerate that by cleaning up the
//     pre-created delivery row).
//   - Event listener: emitting `task.created` enqueues one job per subscribed
//     enabled webhook in the workspace; webhooks not subscribing to that event
//     get nothing.
//   - Disabled webhooks aren't enqueued.
// =============================================================================

interface Mocks {
  prisma: PrismaService;
  queue: { add: ReturnType<typeof vi.fn> };
  emitter: EventEmitter2;
  emitSpy: ReturnType<typeof vi.fn>;
}

const ADMIN_ACTOR: AuthenticatedUser = {
  id: 'admin-1',
  email: 'a@nockta.com',
  kind: 'internal',
  companyRole: 'Admin',
} as AuthenticatedUser;

function build(): { service: OutboundWebhooksService; mocks: Mocks } {
  const prisma = makePrismaMock();
  const queue = { add: vi.fn().mockResolvedValue({ id: 'job-1' }) };
  // Real EventEmitter2 so onAny inside onModuleInit actually subscribes.
  const emitter = new EventEmitter2({ wildcard: true, delimiter: '.' });
  const emitSpy = vi.fn();
  // Wrap emit so tests can inspect outbound_webhook.disabled firings without
  // intercepting Symbol-based event routing.
  const origEmit = emitter.emit.bind(emitter);
  emitter.emit = ((event: string | string[], ...args: unknown[]) => {
    emitSpy(event, ...args);
    return origEmit(event as string, ...args);
  }) as typeof emitter.emit;
  const service = new OutboundWebhooksService(
    prisma,
    emitter,
    queue as unknown as Queue,
  );
  service.onModuleInit();
  return { service, mocks: { prisma, queue, emitter, emitSpy } };
}

// =============================================================================
// HMAC signing
// =============================================================================

describe('OutboundWebhooksService.computeSignature', () => {
  it('returns sha256=<hex> deterministic for a given (secret, body) pair', () => {
    // Receivers verify with timing-safe equals on this exact header value;
    // any drift (algorithm, prefix, hex vs base64) is a silent break.
    const secret = 'a-very-secret-key-aaaa';
    const body = JSON.stringify({ event: 'task.created', data: { taskId: 't1' } });
    const sig1 = OutboundWebhooksService.computeSignature(secret, body);
    const sig2 = OutboundWebhooksService.computeSignature(secret, body);
    const expected =
      'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
    expect(sig1).toBe(sig2); // deterministic
    expect(sig1).toBe(expected); // matches receiver-side computation
    expect(sig1.startsWith('sha256=')).toBe(true);
  });

  it('produces different signatures for different secrets even with the same body', () => {
    const body = '{}';
    const a = OutboundWebhooksService.computeSignature('secret-aaaa-aaaa-aaaa', body);
    const b = OutboundWebhooksService.computeSignature('secret-bbbb-bbbb-bbbb', body);
    expect(a).not.toBe(b);
  });
});

// =============================================================================
// Retry backoff schedule
// =============================================================================

describe('OutboundWebhooksService retry backoff', () => {
  it('uses the 5-step exponential schedule (1s, 5s, 30s, 5min, 30min)', () => {
    expect(RETRY_ATTEMPTS).toBe(5);
    expect(RETRY_BACKOFF_MS).toEqual([1_000, 5_000, 30_000, 300_000, 1_800_000]);
  });

  it('customBackoffStrategy returns the per-attempt delay BullMQ asks for', () => {
    // The strategy is what BullMQ calls between attempts. Worker passes a
    // 1-indexed `attemptsMade`; the function maps each to our schedule.
    expect(customBackoffStrategy(1)).toBe(1_000);
    expect(customBackoffStrategy(2)).toBe(5_000);
    expect(customBackoffStrategy(3)).toBe(30_000);
    expect(customBackoffStrategy(4)).toBe(300_000);
    expect(customBackoffStrategy(5)).toBe(1_800_000);
  });

  it('caps the delay at the final step if asked for an attempt past the schedule', () => {
    // Should never happen (attempts = 5) but if the queue is reconfigured
    // to a higher attempts cap, we don't want to crash with an undefined
    // delay — last step wins.
    expect(customBackoffStrategy(99)).toBe(1_800_000);
  });
});

// =============================================================================
// Auto-disable on consecutive failures
// =============================================================================

describe('OutboundWebhooksService.recordTerminalFailure', () => {
  let mocks: Mocks;
  let service: OutboundWebhooksService;

  beforeEach(() => {
    ({ service, mocks } = build());
  });

  it('flips enabled=false and emits outbound_webhook.disabled at the threshold', async () => {
    // The processor calls recordTerminalFailure after the final retry
    // exhausts. When the resulting failureCount reaches the threshold AND
    // the webhook is still enabled, we flip it off so a dead receiver
    // doesn't churn the queue forever.
    vi.mocked(mocks.prisma.outboundWebhook.update).mockResolvedValueOnce({
      id: 'wh-1',
      failureCount: AUTO_DISABLE_THRESHOLD, // 5th failure tips us over
      workspaceId: DEFAULT_WORKSPACE_ID,
      name: 'My Hook',
      enabled: true,
      createdById: 'user-1',
    } as never);
    // updateMany returns count=1 so the disable + notification path runs.
    // A 0-count would mean another concurrent failure already flipped it.
    vi.mocked(mocks.prisma.outboundWebhook.updateMany).mockResolvedValueOnce({
      count: 1,
    } as never);
    vi.mocked(mocks.prisma.notification.create).mockResolvedValueOnce({} as never);

    await service.recordTerminalFailure('wh-1', 500);

    // update called once (the increment), updateMany once (the conditional
    // disable). Tests the new race-safe shape: the second write is now an
    // updateMany guarded on `enabled: true` so only one of N concurrent
    // failures performs the flip.
    expect(mocks.prisma.outboundWebhook.update).toHaveBeenCalledTimes(1);
    expect(mocks.prisma.outboundWebhook.updateMany).toHaveBeenCalledTimes(1);
    const disableCall = vi.mocked(mocks.prisma.outboundWebhook.updateMany).mock.calls[0]?.[0];
    expect(disableCall?.data?.enabled).toBe(false);
    expect(disableCall?.where?.enabled).toBe(true);

    // A notification row is written to the creator so they see the bell badge.
    expect(mocks.prisma.notification.create).toHaveBeenCalledTimes(1);
    const notifCall = vi.mocked(mocks.prisma.notification.create).mock.calls[0]?.[0];
    expect(notifCall?.data?.type).toBe('OutboundWebhookDisabled');
    expect(notifCall?.data?.recipientUserId).toBe('user-1');

    // Domain event fired so listeners (audit log etc.) can react.
    expect(mocks.emitSpy).toHaveBeenCalledWith(
      'outbound_webhook.disabled',
      expect.objectContaining({ webhookId: 'wh-1', reason: 'consecutive_failures' }),
    );
  });

  it('does NOT auto-disable below the threshold', async () => {
    vi.mocked(mocks.prisma.outboundWebhook.update).mockResolvedValueOnce({
      id: 'wh-1',
      failureCount: AUTO_DISABLE_THRESHOLD - 1,
      workspaceId: DEFAULT_WORKSPACE_ID,
      name: 'My Hook',
      enabled: true,
      createdById: 'user-1',
    } as never);

    await service.recordTerminalFailure('wh-1', 500);

    // Only the increment update — no second update to disable.
    expect(mocks.prisma.outboundWebhook.update).toHaveBeenCalledTimes(1);
    expect(mocks.prisma.notification.create).not.toHaveBeenCalled();
    expect(mocks.emitSpy).not.toHaveBeenCalledWith(
      'outbound_webhook.disabled',
      expect.anything(),
    );
  });
});

// =============================================================================
// Dedup — same logical event doesn't double-enqueue
// =============================================================================

describe('OutboundWebhooksService.enqueueForEvent — dedup', () => {
  let mocks: Mocks;
  let service: OutboundWebhooksService;

  beforeEach(() => {
    ({ service, mocks } = build());
  });

  it('uses a deterministic jobId so the same event-entity-timestamp does not enqueue twice', async () => {
    // BullMQ rejects duplicate jobIds. We rely on that rather than an
    // app-level dedup table — one less moving piece and the rejection is
    // synchronous.
    vi.mocked(mocks.prisma.outboundWebhook.findMany).mockResolvedValue([
      { id: 'wh-1' },
    ] as never);
    vi.mocked(mocks.prisma.webhookDelivery.create).mockResolvedValue({ id: 'd-1' } as never);

    const payload = {
      taskId: 'task-abc',
      eventTimestamp: '2025-01-01T00:00:00.000Z',
    };
    await service.enqueueForEvent('task.created', payload);
    await service.enqueueForEvent('task.created', payload);

    // Both calls enqueue with the same jobId — BullMQ would reject the
    // second one in production. We assert that the jobIds we'd hand it are
    // identical so the dedup contract is upheld.
    const jobId1 = mocks.queue.add.mock.calls[0]?.[2]?.jobId;
    const jobId2 = mocks.queue.add.mock.calls[1]?.[2]?.jobId;
    expect(jobId1).toBe(jobId2);
    expect(jobId1).toBe('wh-1:task.created:task-abc:2025-01-01T00:00:00.000Z');
  });

  it('cleans up the pre-created delivery row on a duplicate jobId rejection', async () => {
    // We pre-create the delivery row BEFORE enqueuing (so it has a stable id
    // for headers). If the enqueue is rejected by jobId collision, the row
    // would orphan unless we delete it.
    vi.mocked(mocks.prisma.outboundWebhook.findMany).mockResolvedValue([
      { id: 'wh-1' },
    ] as never);
    vi.mocked(mocks.prisma.webhookDelivery.create).mockResolvedValue({ id: 'd-orphan' } as never);
    vi.mocked(mocks.prisma.webhookDelivery.delete).mockResolvedValue({} as never);
    mocks.queue.add.mockRejectedValueOnce(new Error('job already exists with id ...'));

    await service.enqueueForEvent('task.created', {
      taskId: 'task-abc',
      eventTimestamp: '2025-01-01T00:00:00.000Z',
    });

    expect(mocks.prisma.webhookDelivery.delete).toHaveBeenCalledWith({ where: { id: 'd-orphan' } });
  });
});

// =============================================================================
// Event subscription wiring
// =============================================================================

describe('OutboundWebhooksService.enqueueForEvent — fan-out', () => {
  let mocks: Mocks;
  let service: OutboundWebhooksService;

  beforeEach(() => {
    ({ service, mocks } = build());
  });

  it('enqueues one job per enabled webhook subscribed to the event', async () => {
    // The dispatcher's job: every webhook that opted into this event AND is
    // enabled gets a delivery. Disabled webhooks and ones not subscribed to
    // this specific event must NOT be enqueued.
    vi.mocked(mocks.prisma.outboundWebhook.findMany).mockResolvedValue([
      { id: 'wh-1' },
      { id: 'wh-2' },
    ] as never);
    vi.mocked(mocks.prisma.webhookDelivery.create)
      .mockResolvedValueOnce({ id: 'd-1' } as never)
      .mockResolvedValueOnce({ id: 'd-2' } as never);

    await service.enqueueForEvent('task.created', {
      taskId: 'task-1',
      eventTimestamp: '2025-01-01T00:00:00.000Z',
    });

    expect(mocks.queue.add).toHaveBeenCalledTimes(2);
    // Confirm we filtered on enabled=true and the eventTypes array contains the event.
    const findCall = vi.mocked(mocks.prisma.outboundWebhook.findMany).mock.calls[0]?.[0];
    expect(findCall?.where).toMatchObject({
      enabled: true,
      eventTypes: { has: 'task.created' },
    });
  });

  it('no-ops when no webhook subscribes to the event', async () => {
    // The findMany filter on `eventTypes: { has: ... }` returns an empty
    // array for events nobody opted into; we must exit early without writing
    // delivery rows or hitting the queue.
    vi.mocked(mocks.prisma.outboundWebhook.findMany).mockResolvedValue([] as never);

    await service.enqueueForEvent('task.created', { taskId: 'task-1' });

    expect(mocks.queue.add).not.toHaveBeenCalled();
    expect(mocks.prisma.webhookDelivery.create).not.toHaveBeenCalled();
  });

  it('routes EventEmitter2 events through the listener (onModuleInit wires onAny)', async () => {
    // The integration path: a domain event emitted anywhere in the app ends
    // up at enqueueForEvent without any other module knowing this exists.
    vi.mocked(mocks.prisma.outboundWebhook.findMany).mockResolvedValue([
      { id: 'wh-1' },
    ] as never);
    vi.mocked(mocks.prisma.webhookDelivery.create).mockResolvedValue({ id: 'd-1' } as never);

    mocks.emitter.emit('task.created', {
      taskId: 'task-abc',
      eventTimestamp: '2025-01-01T00:00:00.000Z',
    });
    // Listener invocation is async — flush the microtask queue. A single
    // setTimeout(0) isn't always enough because enqueueForEvent awaits
    // multiple mocked promises (findMany → create → queue.add); we drain
    // by yielding a few times.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(mocks.queue.add).toHaveBeenCalledTimes(1);
  });

  it('ignores unrelated events (e.g. notification.created)', async () => {
    // Without the SUPPORTED_EVENT_TYPES gate, every event in the system
    // would trip a findMany. The gate is the allowlist.
    mocks.emitter.emit('notification.created', { recipientUserId: 'u1' });
    await new Promise((r) => setTimeout(r, 0));

    expect(mocks.prisma.outboundWebhook.findMany).not.toHaveBeenCalled();
    expect(mocks.queue.add).not.toHaveBeenCalled();
  });
});

// =============================================================================
// CRUD authorisation + validation
// =============================================================================

describe('OutboundWebhooksService.create — auth + validation', () => {
  let mocks: Mocks;
  let service: OutboundWebhooksService;

  beforeEach(() => {
    ({ service, mocks } = build());
  });

  it('rejects writes from a non-Admin internal user', async () => {
    const member: AuthenticatedUser = {
      ...ADMIN_ACTOR,
      companyRole: 'Member',
    } as AuthenticatedUser;
    await expect(
      service.create(member, {
        name: 'X',
        url: 'https://x.example',
        secret: 'aaaaaaaaaaaaaaaa',
        eventTypes: ['task.created'],
      }),
    ).rejects.toThrow(/Admins only/i);
    expect(mocks.prisma.outboundWebhook.create).not.toHaveBeenCalled();
  });

  it('rejects clients entirely (workspace-level surface is internal-only)', async () => {
    const client: AuthenticatedUser = {
      ...ADMIN_ACTOR,
      kind: 'client',
      companyRole: null,
    } as AuthenticatedUser;
    await expect(service.list(client)).rejects.toThrow(
      /internal-only/i,
    );
  });

  it('rejects an URL that is not http(s)', async () => {
    await expect(
      service.create(ADMIN_ACTOR, {
        name: 'X',
        url: 'ftp://x.example',
        secret: 'aaaaaaaaaaaaaaaa',
        eventTypes: ['task.created'],
      }),
    ).rejects.toThrow(/url must be http\(s\)/i);
  });

  it('rejects an unsupported event type', async () => {
    // The eventTypes array is the SOLE filter on what receivers get; an
    // unknown event would never fire, so reject up front rather than
    // silently storing it.
    await expect(
      service.create(ADMIN_ACTOR, {
        name: 'X',
        url: 'https://x.example',
        secret: 'aaaaaaaaaaaaaaaa',
        eventTypes: ['not.a.real.event'],
      }),
    ).rejects.toThrow(/Unsupported event type/i);
  });
});
