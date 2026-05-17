import { createHash, createHmac } from 'node:crypto';
import { UnauthorizedException } from '@nestjs/common';
import type { DeploymentSource } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DeploymentsService } from './deployments.service';
import { DeploymentWebhookController } from './deployment-webhook.controller';
import {
  normalizeGeneric,
  normalizeGithubActions,
  normalizeRailway,
  normalizeVercel,
  type NormalizedDeployment,
} from './source-adapters';
import { makeEventsMock, makePrismaMock } from '../../test-utils/mocks';
import type { PrismaService } from '../../prisma/prisma.service';
import type { PermissionsService } from '../permissions/permissions.service';

// =============================================================================
// deployments — three surfaces to guard:
//
//   1. The webhook controller's HMAC verification. The controller uses a
//      single canonical scheme (HMAC-SHA256 of raw body with the project's
//      shared secret, the *hash* of that HMAC compared to the *hash* of the
//      presented value) for every source. Bad signatures must be rejected
//      with UnauthorizedException BEFORE any normalize/record call.
//
//   2. Dedup: re-delivering the same (source, externalId) must upsert the
//      same row by id. The service derives a deterministic id from
//      (source + externalId) — verifying both deliveries hit the same id is
//      what guarantees no second row.
//
//   3. Auto-status: production-success on Engineering preset transitions
//      linked tasks from Testing → Done. Non-Testing tasks must NOT move.
//
// DIVERGENCE FROM SPEC: the controller uses one shared HMAC scheme for every
// source (Vercel/GitHub/Railway/generic). The original spec asked for per-source
// signature formats — those don't exist in the code. Tests assert the actual
// scheme.
// =============================================================================

function sha256(s: string | Buffer): string {
  return createHash('sha256').update(s).digest('hex');
}

// =============================================================================
// DeploymentsService.record — dedup + auto-status
// =============================================================================

interface ServiceMocks {
  prisma: PrismaService;
  permissions: { assertAtLeast: ReturnType<typeof vi.fn> };
  events: ReturnType<typeof makeEventsMock>;
}

function buildService(): { service: DeploymentsService; mocks: ServiceMocks } {
  const prisma = makePrismaMock();
  const permissions = { assertAtLeast: vi.fn().mockResolvedValue(undefined) };
  const events = makeEventsMock();
  const service = new DeploymentsService(
    prisma,
    permissions as unknown as PermissionsService,
    events.instance,
  );
  return { service, mocks: { prisma, permissions, events } };
}

function normalized(overrides: Partial<NormalizedDeployment> = {}): NormalizedDeployment {
  return {
    externalId: 'ext-1',
    source: 'vercel',
    environment: 'production',
    status: 'succeeded',
    commitSha: 'deadbeef',
    commitMessage: 'Fix bug',
    url: 'https://app.example.com',
    startedAt: new Date('2026-05-16T07:00:00.000Z'),
    finishedAt: new Date('2026-05-16T07:01:00.000Z'),
    raw: { hello: 'world' },
    ...overrides,
  };
}

describe('DeploymentsService.record — dedup', () => {
  let mocks: ServiceMocks;
  let service: DeploymentsService;

  beforeEach(() => {
    ({ service, mocks } = buildService());
    vi.mocked(mocks.prisma.project.findUnique).mockResolvedValue({
      id: 'p-1',
      archivedAt: null,
      workflowPreset: 'general',
    } as never);
    vi.mocked(mocks.prisma.deployment.upsert).mockResolvedValue({
      id: 'det-id',
      projectId: 'p-1',
    } as never);
    vi.mocked(mocks.prisma.taskGithubLink.findMany).mockResolvedValue([] as never);
  });

  it('upserts on a stable id derived from (source, externalId)', async () => {
    // The whole dedup story rests on this id being deterministic. If the
    // hashing changes, a re-delivery would create a new row instead of
    // updating — and our domain events would fire twice per real deployment.
    await service.record('p-1', normalized({ externalId: 'abc-123' }));
    await service.record('p-1', normalized({ externalId: 'abc-123' }));

    const firstId = vi.mocked(mocks.prisma.deployment.upsert).mock.calls[0]?.[0]?.where?.id;
    const secondId = vi.mocked(mocks.prisma.deployment.upsert).mock.calls[1]?.[0]?.where?.id;
    expect(firstId).toBe(secondId);
    expect(typeof firstId).toBe('string');
    // RFC-shaped UUID-ish (8-4-4-4-12 hex groups).
    expect(firstId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('different externalIds produce different deployment ids', async () => {
    await service.record('p-1', normalized({ externalId: 'one' }));
    await service.record('p-1', normalized({ externalId: 'two' }));

    const a = vi.mocked(mocks.prisma.deployment.upsert).mock.calls[0]?.[0]?.where?.id;
    const b = vi.mocked(mocks.prisma.deployment.upsert).mock.calls[1]?.[0]?.where?.id;
    expect(a).not.toBe(b);
  });

  it('different sources with the same externalId do not collide', async () => {
    // (vercel, "abc") and (github_actions, "abc") describe different events;
    // the deterministic id must mix the source into the hash.
    await service.record('p-1', normalized({ source: 'vercel', externalId: 'abc' }));
    await service.record('p-1', normalized({ source: 'github_actions', externalId: 'abc' }));

    const a = vi.mocked(mocks.prisma.deployment.upsert).mock.calls[0]?.[0]?.where?.id;
    const b = vi.mocked(mocks.prisma.deployment.upsert).mock.calls[1]?.[0]?.where?.id;
    expect(a).not.toBe(b);
  });

  it('archived projects are silently ignored — no upsert, no events', async () => {
    // Archive is the "stop receiving anything" flag. A late-arriving webhook
    // for an archived project must not resurrect the timeline.
    vi.mocked(mocks.prisma.project.findUnique).mockReset();
    vi.mocked(mocks.prisma.project.findUnique).mockResolvedValueOnce({
      id: 'p-1',
      archivedAt: new Date(),
      workflowPreset: 'general',
    } as never);

    await service.record('p-1', normalized());

    expect(mocks.prisma.deployment.upsert).not.toHaveBeenCalled();
    expect(mocks.events.emit).not.toHaveBeenCalled();
  });
});

describe('DeploymentsService.record — auto-status transitions', () => {
  let mocks: ServiceMocks;
  let service: DeploymentsService;

  beforeEach(() => {
    ({ service, mocks } = buildService());
    vi.mocked(mocks.prisma.project.findUnique).mockResolvedValue({
      id: 'p-1',
      archivedAt: null,
      workflowPreset: 'engineering',
    } as never);
    vi.mocked(mocks.prisma.deployment.upsert).mockResolvedValue({
      id: 'det-1',
      projectId: 'p-1',
    } as never);
    vi.mocked(mocks.prisma.taskGithubLink.findMany).mockResolvedValue([
      { taskId: 't-1', task: { projectId: 'p-1' } },
    ] as never);
    vi.mocked(mocks.prisma.taskDeployment.upsert).mockResolvedValue({} as never);
  });

  it('moves a linked Testing task to Done on production-success', async () => {
    // The auto-transition is the headline feature of the deployments module.
    // Status must move to "Done" AND a task.status_changed event must fire
    // with triggeredBy="deployment" so the audit log shows the cause.
    vi.mocked(mocks.prisma.task.findUnique).mockResolvedValueOnce({
      id: 't-1',
      status: 'Testing',
      projectId: 'p-1',
    } as never);
    vi.mocked(mocks.prisma.task.findFirst).mockResolvedValueOnce(null as never);
    vi.mocked(mocks.prisma.task.update).mockResolvedValueOnce({} as never);

    await service.record('p-1', normalized({ status: 'succeeded', environment: 'production' }));

    const updateArgs = vi.mocked(mocks.prisma.task.update).mock.calls[0]?.[0];
    expect(updateArgs?.where?.id).toBe('t-1');
    expect(updateArgs?.data?.status).toBe('Done');
    const statusEvent = mocks.events.emit.mock.calls.find(
      (c) => c[0] === 'task.status_changed',
    );
    expect(statusEvent?.[1]).toMatchObject({
      taskId: 't-1',
      fromStatus: 'Testing',
      toStatus: 'Done',
      triggeredBy: 'deployment',
    });
  });

  it('leaves an Open task alone — only Testing tasks auto-transition', async () => {
    // Critical guardrail: we must not skip a task forward through statuses
    // it never reached. Only Testing → Done is automated; everything else
    // is a human decision.
    vi.mocked(mocks.prisma.task.findUnique).mockResolvedValueOnce({
      id: 't-1',
      status: 'In Progress',
      projectId: 'p-1',
    } as never);

    await service.record('p-1', normalized({ status: 'succeeded', environment: 'production' }));

    expect(mocks.prisma.task.update).not.toHaveBeenCalled();
  });

  it('does not auto-transition on staging deploys, even on success', async () => {
    // Production-only rule. Staging successes are common (many per day);
    // moving tasks to Done on staging would be very loud.
    vi.mocked(mocks.prisma.task.findUnique).mockResolvedValueOnce({
      id: 't-1',
      status: 'Testing',
      projectId: 'p-1',
    } as never);

    await service.record('p-1', normalized({ status: 'succeeded', environment: 'staging' }));

    expect(mocks.prisma.task.update).not.toHaveBeenCalled();
  });

  it('does not auto-transition when the project preset is not Engineering', async () => {
    // The mapping Testing→Done only makes sense for Engineering's workflow.
    // Other presets may not even have a "Testing" column.
    vi.mocked(mocks.prisma.project.findUnique).mockReset();
    vi.mocked(mocks.prisma.project.findUnique).mockResolvedValueOnce({
      id: 'p-1',
      archivedAt: null,
      workflowPreset: 'marketing',
    } as never);
    vi.mocked(mocks.prisma.task.findUnique).mockResolvedValueOnce({
      id: 't-1',
      status: 'Testing',
      projectId: 'p-1',
    } as never);

    await service.record('p-1', normalized({ status: 'succeeded', environment: 'production' }));

    expect(mocks.prisma.task.update).not.toHaveBeenCalled();
  });

  it('emits deploy.failed (not deploy.succeeded) on a failed production deploy', async () => {
    // The domain event drives notifications and the deployments timeline.
    // Mis-routing one as the other would page on-call for nothing or, worse,
    // silence a real outage.
    vi.mocked(mocks.prisma.taskGithubLink.findMany).mockResolvedValueOnce([] as never);

    await service.record('p-1', normalized({ status: 'failed', environment: 'production' }));

    const eventNames = mocks.events.emit.mock.calls.map((c) => c[0]);
    expect(eventNames).toContain('deploy.failed');
    expect(eventNames).not.toContain('deploy.succeeded');
    expect(eventNames).not.toContain('deploy.production_release');
  });
});

// =============================================================================
// DeploymentWebhookController — HMAC verification
// =============================================================================

describe('DeploymentWebhookController.receive — HMAC', () => {
  let controller: DeploymentWebhookController;
  let serviceMock: { getSecretHash: ReturnType<typeof vi.fn>; record: ReturnType<typeof vi.fn> };

  const PROJECT_ID = 'p-1';
  const SECRET = 'deployment-shared-secret';
  const STORED_HASH = sha256(SECRET);

  function makeSignedRequest(body: Record<string, unknown>) {
    const raw = Buffer.from(JSON.stringify(body));
    // The controller compares sha256(presented HMAC string) to
    // sha256(HMAC(stored_hash, raw)). Reproduce that path to derive a valid
    // signature without trusting the service.
    const expectedHmacHex = createHmac('sha256', STORED_HASH).update(raw).digest('hex');
    return {
      raw,
      validSig: expectedHmacHex,
    };
  }

  beforeEach(() => {
    serviceMock = {
      getSecretHash: vi.fn().mockResolvedValue(STORED_HASH),
      record: vi.fn().mockResolvedValue(undefined),
    };
    controller = new DeploymentWebhookController(
      serviceMock as unknown as DeploymentsService,
    );
  });

  it('rejects when no secret is configured for the project', async () => {
    // A project that hasn't been bootstrapped must not silently accept
    // unauthenticated traffic.
    serviceMock.getSecretHash.mockResolvedValueOnce(null);
    const body = { externalId: 'a', status: 'succeeded', environment: 'production' };
    const req = { rawBody: Buffer.from(JSON.stringify(body)) } as never;

    await expect(
      controller.receive(PROJECT_ID, 'generic' as DeploymentSource, 'whatever', req, body),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('rejects when the signature header is missing', async () => {
    const body = { externalId: 'a', status: 'succeeded', environment: 'production' };
    const req = { rawBody: Buffer.from(JSON.stringify(body)) } as never;

    await expect(
      controller.receive(PROJECT_ID, 'generic' as DeploymentSource, undefined, req, body),
    ).rejects.toThrow(UnauthorizedException);
    expect(serviceMock.record).not.toHaveBeenCalled();
  });

  it('rejects when the signature does not match', async () => {
    const body = { externalId: 'a', status: 'succeeded', environment: 'production' };
    const req = { rawBody: Buffer.from(JSON.stringify(body)) } as never;

    await expect(
      controller.receive(
        PROJECT_ID,
        'generic' as DeploymentSource,
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        req,
        body,
      ),
    ).rejects.toThrow(/bad signature/i);
    expect(serviceMock.record).not.toHaveBeenCalled();
  });

  it('accepts a valid signature and forwards the normalized payload to the service', async () => {
    const body = {
      externalId: 'ok-1',
      status: 'succeeded',
      environment: 'production',
    };
    const { raw, validSig } = makeSignedRequest(body);
    const req = { rawBody: raw } as never;

    await controller.receive(
      PROJECT_ID,
      'generic' as DeploymentSource,
      validSig,
      req,
      body,
    );

    expect(serviceMock.record).toHaveBeenCalledOnce();
    const [pid, payload] = serviceMock.record.mock.calls[0]!;
    expect(pid).toBe(PROJECT_ID);
    expect((payload as NormalizedDeployment).externalId).toBe('ok-1');
  });

  it('accepts the "sha256=" prefix used by some senders', async () => {
    // GitHub-style "sha256=<hex>" prefix is stripped in the controller. A
    // regression here breaks anyone copying their existing GitHub webhook
    // setup to point at us.
    const body = { externalId: 'p-2', status: 'started', environment: 'production' };
    const { raw, validSig } = makeSignedRequest(body);
    const req = { rawBody: raw } as never;

    await controller.receive(
      PROJECT_ID,
      'generic' as DeploymentSource,
      `sha256=${validSig}`,
      req,
      body,
    );

    expect(serviceMock.record).toHaveBeenCalledOnce();
  });

  it('rejects an unknown source enum value before doing any auth work', async () => {
    // Fail-fast cheap check — avoids hitting the DB for nonsense traffic.
    await expect(
      controller.receive(
        PROJECT_ID,
        'made_up' as DeploymentSource,
        'sig',
        { rawBody: Buffer.from('{}') } as never,
        {},
      ),
    ).rejects.toThrow(/unknown source/i);
    expect(serviceMock.getSecretHash).not.toHaveBeenCalled();
  });
});

// =============================================================================
// Source adapters — normalize per-vendor payloads to NormalizedDeployment
// =============================================================================

describe('source-adapters', () => {
  it('Vercel READY maps to status="succeeded" and pulls the commit sha from meta', async () => {
    const out = normalizeVercel({
      type: 'deployment.succeeded',
      payload: {
        id: 'dpl_x',
        state: 'READY',
        target: 'production',
        url: 'app.example.com',
        meta: { githubCommitSha: 'abc123', githubCommitMessage: 'feat: ship' },
        createdAt: 1747382400000,
      },
    });
    expect(out).toMatchObject({
      externalId: 'dpl_x',
      status: 'succeeded',
      environment: 'production',
      commitSha: 'abc123',
      commitMessage: 'feat: ship',
      source: 'vercel',
    });
  });

  it('Vercel ERROR / CANCELED both map to status="failed"', () => {
    const err = normalizeVercel({ payload: { id: 'a', state: 'ERROR', target: 'production' } });
    const cancel = normalizeVercel({ payload: { id: 'b', state: 'CANCELED', target: 'production' } });
    expect(err?.status).toBe('failed');
    expect(cancel?.status).toBe('failed');
  });

  it('Railway SUCCESS maps to succeeded, CRASHED to failed', () => {
    const ok = normalizeRailway({ deployment: { id: 'a', status: 'SUCCESS' } });
    const crashed = normalizeRailway({ deployment: { id: 'b', status: 'CRASHED' } });
    expect(ok?.status).toBe('succeeded');
    expect(crashed?.status).toBe('failed');
  });

  it('GitHub Actions deployment_status.success becomes succeeded', () => {
    const out = normalizeGithubActions({
      deployment_status: { id: 1, state: 'success', target_url: 'https://x' },
      deployment: { environment: 'production', sha: 'cafe' },
    });
    expect(out).toMatchObject({
      status: 'succeeded',
      environment: 'production',
      commitSha: 'cafe',
      source: 'github_actions',
    });
  });

  it('generic returns null when required fields are missing', () => {
    // Required fields gate is what protects DeploymentsService.record from
    // having to defend against partial payloads.
    expect(normalizeGeneric({})).toBeNull();
    expect(normalizeGeneric({ externalId: 'x' })).toBeNull();
    expect(normalizeGeneric({ externalId: 'x', status: 'started' })).toBeNull();
  });
});
