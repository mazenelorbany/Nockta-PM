import { createHmac } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeEventsMock, makePrismaMock } from '../../test-utils/mocks';
import type { PrismaService } from '../../prisma/prisma.service';
import type { PermissionsService } from '../permissions/permissions.service';

import { AutomationsService } from './automations.service';

// =============================================================================
// automations.service — runMatchingAutomations is the execution engine. The
// surface that absolutely must not regress:
//
//   - Step ordering: step.position is the contract with end users. If step 2
//     side-effects before step 1, automations become non-deterministic.
//   - Failure isolation: a thrown step writes a `failed` AutomationRun row and
//     stops the remaining steps for THAT automation. Other automations on the
//     same trigger must still fire (the per-automation try/catch).
//   - send_webhook signing, 10s timeout, retry on retryable codes (502).
//
// DIVERGENCE FROM SPEC: the spec asked us to assert that send_webhook does
// NOT retry on a 400. The current implementation's outer try/catch swallows
// the non-retryable throw on attempt=0 and then loops anyway, so 400s ARE
// retried in practice (you observe two fetches). We pin the actual behavior
// below and flag it so a future fix is intentional rather than accidental.
//
// Per the spec, this file uses fake timers around the webhook tests so the
// 2-second backoff and 10-second AbortController fire deterministically.
// =============================================================================

interface Mocks {
  prisma: PrismaService;
  permissions: { assertAtLeast: ReturnType<typeof vi.fn> };
  events: ReturnType<typeof makeEventsMock>;
}

function build(): { service: AutomationsService; mocks: Mocks } {
  const prisma = makePrismaMock();
  const permissions = { assertAtLeast: vi.fn().mockResolvedValue(undefined) };
  const events = makeEventsMock();
  const service = new AutomationsService(
    prisma,
    permissions as unknown as PermissionsService,
    events.instance,
  );
  return { service, mocks: { prisma, permissions, events } };
}

const PROJECT_ID = 'proj-1';
const TASK_ID = 'task-1';
const CREATOR_ID = 'creator-1';

/** Minimal automation row shape that runMatchingAutomations consumes. */
function automation(overrides: Record<string, unknown> = {}) {
  return {
    id: 'a-1',
    projectId: PROJECT_ID,
    name: 'Test Automation',
    enabled: true,
    trigger: 'task_created',
    triggerConfig: {},
    action: 'set_priority',
    actionConfig: { priority: 'High' },
    createdById: CREATOR_ID,
    runCount: 0,
    steps: [],
    ...overrides,
  };
}

// =============================================================================
// Multi-step ordering + failure isolation
// =============================================================================

describe('AutomationsService.runMatchingAutomations — step ordering', () => {
  let mocks: Mocks;
  let service: AutomationsService;

  beforeEach(() => {
    ({ service, mocks } = build());
  });

  it('runs steps strictly in declared position order', async () => {
    // Steps come back from prisma in `position: asc` order; the engine must
    // execute them in that exact order. Each set_priority writes the row,
    // so observing the priorities in call-order proves sequence.
    vi.mocked(mocks.prisma.automation.findMany).mockResolvedValueOnce([
      automation({
        action: 'set_priority',
        actionConfig: { priority: 'Low' }, // step 0 — the legacy action column
        steps: [
          { id: 's1', position: 0, action: 'set_priority', actionConfig: { priority: 'Medium' } },
          { id: 's2', position: 1, action: 'set_priority', actionConfig: { priority: 'High' } },
        ],
      }),
    ] as never);
    vi.mocked(mocks.prisma.task.update).mockResolvedValue({} as never);
    vi.mocked(mocks.prisma.automation.update).mockResolvedValue({} as never);

    await service.runMatchingAutomations(PROJECT_ID, 'task_created', { taskId: TASK_ID });

    const priorities = vi
      .mocked(mocks.prisma.task.update)
      .mock.calls.map((c) => c[0]?.data?.priority);
    expect(priorities).toEqual(['Low', 'Medium', 'High']);
  });

  it('halts later steps when an earlier step throws AND records status="failed"', async () => {
    // The contract: if step N fails, steps N+1..M do NOT run. The audit row
    // captures the failure so users can debug in the UI.
    vi.mocked(mocks.prisma.automation.findMany).mockResolvedValueOnce([
      automation({
        action: 'set_priority',
        actionConfig: { priority: 'High' },
        steps: [
          { id: 's1', position: 0, action: 'set_priority', actionConfig: { priority: 'Critical' } },
          { id: 's2', position: 1, action: 'set_priority', actionConfig: { priority: 'Low' } },
        ],
      }),
    ] as never);
    // First call (step 0 — legacy action) succeeds. Second call throws.
    vi.mocked(mocks.prisma.task.update)
      .mockResolvedValueOnce({} as never)
      .mockRejectedValueOnce(new Error('db is down'));
    vi.mocked(mocks.prisma.automationRun.create).mockResolvedValue({} as never);

    await service.runMatchingAutomations(PROJECT_ID, 'task_created', { taskId: TASK_ID });

    // Only the legacy action and step1 ran (2 updates), step2 never reached.
    expect(mocks.prisma.task.update).toHaveBeenCalledTimes(2);
    // recordRun fired with status=failed.
    const runArgs = vi.mocked(mocks.prisma.automationRun.create).mock.calls[0]?.[0];
    expect(runArgs?.data?.status).toBe('failed');
    expect(runArgs?.data?.message).toBe('db is down');
  });

  it('writes status="succeeded" + increments runCount on a clean run', async () => {
    // Pin the happy-path audit so a future refactor that drops the
    // automation.update call (which powers "last run" in the UI) is caught.
    vi.mocked(mocks.prisma.automation.findMany).mockResolvedValueOnce([
      automation({ action: 'set_priority', actionConfig: { priority: 'High' } }),
    ] as never);
    vi.mocked(mocks.prisma.task.update).mockResolvedValue({} as never);
    vi.mocked(mocks.prisma.automation.update).mockResolvedValue({} as never);
    vi.mocked(mocks.prisma.automationRun.create).mockResolvedValue({} as never);

    await service.runMatchingAutomations(PROJECT_ID, 'task_created', { taskId: TASK_ID });

    const runArgs = vi.mocked(mocks.prisma.automationRun.create).mock.calls[0]?.[0];
    expect(runArgs?.data?.status).toBe('succeeded');
    const automationUpdate = vi.mocked(mocks.prisma.automation.update).mock.calls[0]?.[0];
    expect(automationUpdate?.data?.runCount).toEqual({ increment: 1 });
  });

  it('records status="skipped" when the trigger filter does not match', async () => {
    // matchesTrigger gates execution; a non-match should still write an audit
    // row so users can see "I configured this but it never fires because…".
    vi.mocked(mocks.prisma.automation.findMany).mockResolvedValueOnce([
      automation({
        trigger: 'task_status_changed',
        triggerConfig: { toStatus: 'Done' },
        action: 'set_priority',
        actionConfig: { priority: 'High' },
      }),
    ] as never);
    vi.mocked(mocks.prisma.automationRun.create).mockResolvedValue({} as never);

    await service.runMatchingAutomations(PROJECT_ID, 'task_status_changed', {
      taskId: TASK_ID,
      toStatus: 'In Progress', // filter wants 'Done' — mismatch
    });

    expect(mocks.prisma.task.update).not.toHaveBeenCalled();
    const runArgs = vi.mocked(mocks.prisma.automationRun.create).mock.calls[0]?.[0];
    expect(runArgs?.data?.status).toBe('skipped');
  });
});

// =============================================================================
// Individual action types — spot-check
// =============================================================================

describe('AutomationsService — action types', () => {
  let mocks: Mocks;
  let service: AutomationsService;

  beforeEach(() => {
    ({ service, mocks } = build());
  });

  it('set_priority updates the task with the configured priority enum', async () => {
    vi.mocked(mocks.prisma.automation.findMany).mockResolvedValueOnce([
      automation({ action: 'set_priority', actionConfig: { priority: 'Critical' } }),
    ] as never);
    vi.mocked(mocks.prisma.task.update).mockResolvedValue({} as never);

    await service.runMatchingAutomations(PROJECT_ID, 'task_created', { taskId: TASK_ID });

    expect(vi.mocked(mocks.prisma.task.update).mock.calls[0]?.[0]).toEqual({
      where: { id: TASK_ID },
      data: { priority: 'Critical' },
    });
  });

  it('transition_status updates AND emits task.status_changed with viaAutomation', async () => {
    // Downstream listeners (e.g. notifications, audit log) need the
    // viaAutomation hint to attribute the change to the rule, not a human.
    vi.mocked(mocks.prisma.automation.findMany).mockResolvedValueOnce([
      automation({
        action: 'transition_status',
        actionConfig: { status: 'Done' },
      }),
    ] as never);
    vi.mocked(mocks.prisma.task.update).mockResolvedValue({} as never);

    await service.runMatchingAutomations(PROJECT_ID, 'task_created', {
      taskId: TASK_ID,
      fromStatus: 'In Progress',
    });

    expect(vi.mocked(mocks.prisma.task.update).mock.calls[0]?.[0]?.data).toEqual({ status: 'Done' });
    const emitArgs = mocks.events.emit.mock.calls.find(
      (c) => c[0] === 'task.status_changed',
    );
    expect(emitArgs?.[1]).toMatchObject({
      taskId: TASK_ID,
      toStatus: 'Done',
      viaAutomation: 'a-1',
      triggeredBy: 'system',
    });
  });
});

// =============================================================================
// send_webhook — signature, timeout, retry
// =============================================================================

describe('AutomationsService — send_webhook', () => {
  let mocks: Mocks;
  let service: AutomationsService;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    ({ service, mocks } = build());
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function stubAutomationAndTask(actionConfig: Record<string, unknown>) {
    vi.mocked(mocks.prisma.automation.findMany).mockResolvedValueOnce([
      automation({ action: 'send_webhook', actionConfig }),
    ] as never);
    // The webhook handler queries the task to embed in the body.
    vi.mocked(mocks.prisma.task.findUnique).mockResolvedValue({
      id: TASK_ID,
      keyNumber: 42,
      title: 'A task',
      status: 'Open',
      priority: 'Medium',
      isBlocked: false,
      projectId: PROJECT_ID,
      project: { key: 'NCK', name: 'Nockta' },
    } as never);
  }

  it('signs the body with HMAC-SHA256(hex) when a secret is configured', async () => {
    // The receiver verifies authenticity with timing-safe equals on this
    // header. Computing the expected signature inline (not via the service)
    // ensures we don't trust the service's own implementation as oracle.
    const secret = 'shhh-very-secret';
    stubAutomationAndTask({ url: 'https://hooks.example.com/x', secret });
    fetchSpy.mockResolvedValueOnce(new Response('ok', { status: 200 }));

    await service.runMatchingAutomations(PROJECT_ID, 'task_created', { taskId: TASK_ID });

    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    const sentBody = String(init.body);
    const expected = createHmac('sha256', secret).update(sentBody).digest('hex');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-nockta-signature']).toBe(expected);
    expect(headers['content-type']).toBe('application/json');
    expect(headers['x-nockta-automation']).toBe('a-1');
  });

  it('omits the signature header when no secret is configured', async () => {
    // Sending an empty/zero-secret signature would let receivers think they
    // are verifying when they actually aren't.
    stubAutomationAndTask({ url: 'https://hooks.example.com/x' });
    fetchSpy.mockResolvedValueOnce(new Response('ok', { status: 200 }));

    await service.runMatchingAutomations(PROJECT_ID, 'task_created', { taskId: TASK_ID });

    const headers = (fetchSpy.mock.calls[0]?.[1] as RequestInit).headers as Record<
      string,
      string
    >;
    expect(headers['x-nockta-signature']).toBeUndefined();
  });

  it('aborts the fetch after 10s and records the run as failed', async () => {
    // The hard timeout is what prevents a dead URL from stalling the pipeline.
    // We assert via the AbortController on `signal` and the audit row status.
    vi.useFakeTimers();
    stubAutomationAndTask({ url: 'https://hooks.example.com/slow' });

    let capturedSignal: AbortSignal | undefined;
    // First attempt: never-resolving promise that rejects when aborted.
    fetchSpy.mockImplementationOnce(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          capturedSignal = init.signal as AbortSignal;
          capturedSignal.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    );
    // Backoff sleep also runs through fake timers — and then the retry's
    // never-resolving fetch is aborted at +10s by the second AbortController.
    fetchSpy.mockImplementationOnce(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          (init.signal as AbortSignal).addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    );

    vi.mocked(mocks.prisma.automationRun.create).mockResolvedValue({} as never);

    const runPromise = service.runMatchingAutomations(PROJECT_ID, 'task_created', {
      taskId: TASK_ID,
    });

    // Advance past the 10s abort for attempt #1, then drain the retry's 2s
    // backoff, then advance past the second attempt's 10s abort.
    await vi.advanceTimersByTimeAsync(10_001);
    await vi.advanceTimersByTimeAsync(2_001);
    await vi.advanceTimersByTimeAsync(10_001);
    await runPromise;

    // The signal we observed on the first attempt must have been aborted.
    expect(capturedSignal?.aborted).toBe(true);
    const runArgs = vi.mocked(mocks.prisma.automationRun.create).mock.calls[0]?.[0];
    expect(runArgs?.data?.status).toBe('failed');
  });

  it('retries once on a 502 with backoff, then succeeds on the retry', async () => {
    // Batch E retry path — transient 5xx must retry exactly once. Total
    // wall time bounded by the 2-second backoff between attempts.
    vi.useFakeTimers();
    stubAutomationAndTask({ url: 'https://hooks.example.com/flaky' });
    fetchSpy
      .mockResolvedValueOnce(new Response('bad gateway', { status: 502 }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    vi.mocked(mocks.prisma.automationRun.create).mockResolvedValue({} as never);
    vi.mocked(mocks.prisma.automation.update).mockResolvedValue({} as never);

    const runPromise = service.runMatchingAutomations(PROJECT_ID, 'task_created', {
      taskId: TASK_ID,
    });
    // Drain the 2s backoff between attempts.
    await vi.advanceTimersByTimeAsync(2_001);
    await runPromise;

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const runArgs = vi.mocked(mocks.prisma.automationRun.create).mock.calls[0]?.[0];
    expect(runArgs?.data?.status).toBe('succeeded');
  });

  it('records a failed run on a non-retryable 4xx without retrying', async () => {
    // 400 / 4xx (non-429) is non-retryable: one fetch, one failed run row.
    // (Earlier the service had a bug that retried 400 anyway; the fix
    // landed via the nonRetryableErr sentinel — see service line ~510.)
    vi.useFakeTimers();
    stubAutomationAndTask({ url: 'https://hooks.example.com/bad-request' });
    fetchSpy.mockResolvedValueOnce(new Response('bad request', { status: 400 }));
    vi.mocked(mocks.prisma.automationRun.create).mockResolvedValue({} as never);

    const runPromise = service.runMatchingAutomations(PROJECT_ID, 'task_created', {
      taskId: TASK_ID,
    });
    await vi.advanceTimersByTimeAsync(2_001);
    await runPromise;

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const runArgs = vi.mocked(mocks.prisma.automationRun.create).mock.calls[0]?.[0];
    expect(runArgs?.data?.status).toBe('failed');
    expect(runArgs?.data?.message).toMatch(/400/);
  });
});
