import { ForbiddenException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeEventsMock, makePrismaMock } from '../../test-utils/mocks';
import type { PrismaService } from '../../prisma/prisma.service';
import type { AuthenticatedUser } from '../auth/types';
import { DuplicateDetectionProcessor } from './ai.processors';
import type { EmbeddingService } from './embedding.service';
import type { LlmService } from './llm.service';
import type { QdrantService } from './qdrant.service';
import { WorkspaceAiSettingsService } from './workspace-ai-settings.service';
import type { AiCostTrackingService } from './ai-cost-tracking.service';

// workspace-ai-settings.service — singleton row that drives the AI dup
// threshold, priority weights, autosuggest toggle, and LLM provider override.
// Tests pin: (1) lazy bootstrap on first get(), (2) Admin-only update gate,
// (3) the duplicate processor reads from this service (no env coupling).

function adminActor(): AuthenticatedUser {
  return { id: 'u-admin', email: 'admin@nockta.com', kind: 'internal', companyRole: 'Admin', jti: 't' };
}

function memberActor(): AuthenticatedUser {
  return { id: 'u-mem', email: 'mem@nockta.com', kind: 'internal', companyRole: 'Member', jti: 't' };
}

function clientActor(): AuthenticatedUser {
  return { id: 'u-cli', email: 'cli@example.com', kind: 'client', companyRole: null, jti: 't' };
}

function defaultsRow(updatedById = 'u-admin') {
  return {
    id: 'cfg-1',
    singleton: 1,
    // workspaceId is now the meaningful uniqueness key (migration 0009).
    workspaceId: 'default',
    dupThreshold: 0.85,
    priorityWeights: { deadline: 1, blocked: 2, customerImpact: 1.5 },
    autoSuggestEnabled: true,
    modelPreference: 'auto',
    updatedAt: new Date('2026-01-01'),
    updatedById,
  };
}

describe('WorkspaceAiSettingsService.get — singleton bootstrap', () => {
  let prisma: PrismaService;
  let svc: WorkspaceAiSettingsService;

  beforeEach(() => {
    prisma = makePrismaMock();
    svc = new WorkspaceAiSettingsService(prisma);
  });

  it('creates the singleton on first call when no row exists', async () => {
    vi.mocked(prisma.workspaceAiSettings.findUnique).mockResolvedValueOnce(null as never);
    vi.mocked(prisma.workspaceAiSettings.create).mockResolvedValueOnce(defaultsRow() as never);

    const row = await svc.get('u-admin');

    expect(prisma.workspaceAiSettings.create).toHaveBeenCalledWith({
      data: { singleton: 1, workspaceId: 'default', updatedById: 'u-admin' },
    });
    expect(row.dupThreshold).toBe(0.85);
    expect(row.modelPreference).toBe('auto');
  });

  it('returns the existing row without creating when one exists', async () => {
    vi.mocked(prisma.workspaceAiSettings.findUnique).mockResolvedValueOnce(defaultsRow() as never);
    const row = await svc.get();
    expect(prisma.workspaceAiSettings.create).not.toHaveBeenCalled();
    expect(row.dupThreshold).toBe(0.85);
  });

  it('falls back to first Admin user when no actor id is supplied', async () => {
    vi.mocked(prisma.workspaceAiSettings.findUnique).mockResolvedValueOnce(null as never);
    vi.mocked(prisma.user.findFirst).mockResolvedValueOnce({ id: 'u-admin-fallback' } as never);
    vi.mocked(prisma.workspaceAiSettings.create).mockResolvedValueOnce(
      defaultsRow('u-admin-fallback') as never,
    );

    const row = await svc.get();
    expect(prisma.workspaceAiSettings.create).toHaveBeenCalledWith({
      data: { singleton: 1, workspaceId: 'default', updatedById: 'u-admin-fallback' },
    });
    expect(row.updatedById).toBe('u-admin-fallback');
  });

  it('throws when no actor AND no Admin exists yet (fresh database)', async () => {
    vi.mocked(prisma.workspaceAiSettings.findUnique).mockResolvedValueOnce(null as never);
    vi.mocked(prisma.user.findFirst).mockResolvedValueOnce(null as never);
    await expect(svc.get()).rejects.toThrow(/no actor and no Admin user/);
  });

  it('caches subsequent calls for 30s (does not re-query Prisma)', async () => {
    vi.mocked(prisma.workspaceAiSettings.findUnique).mockResolvedValueOnce(defaultsRow() as never);
    await svc.get();
    await svc.get();
    expect(prisma.workspaceAiSettings.findUnique).toHaveBeenCalledTimes(1);
  });
});

describe('WorkspaceAiSettingsService.update — Admin gate', () => {
  let prisma: PrismaService;
  let svc: WorkspaceAiSettingsService;

  beforeEach(() => {
    prisma = makePrismaMock();
    svc = new WorkspaceAiSettingsService(prisma);
    // Default existing row — update() calls get() first, which hits this.
    vi.mocked(prisma.workspaceAiSettings.findUnique).mockResolvedValue(defaultsRow() as never);
    vi.mocked(prisma.workspaceAiSettings.update).mockResolvedValue(
      { ...defaultsRow(), dupThreshold: 0.91 } as never,
    );
  });

  it('rejects internal Members', async () => {
    await expect(svc.update(memberActor(), { dupThreshold: 0.91 })).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.workspaceAiSettings.update).not.toHaveBeenCalled();
  });

  it('rejects clients outright', async () => {
    await expect(svc.update(clientActor(), { dupThreshold: 0.91 })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('lets Admin write and clamps dupThreshold into [0.7, 0.99]', async () => {
    await svc.update(adminActor(), { dupThreshold: 5 }); // way above 0.99
    const args = vi.mocked(prisma.workspaceAiSettings.update).mock.calls[0]?.[0];
    expect(args?.data?.dupThreshold).toBe(0.99);
    expect(args?.data?.updatedById).toBe('u-admin');
  });

  it('clamps priority weights into [0, 5]', async () => {
    await svc.update(adminActor(), { priorityWeights: { deadline: -2, blocked: 99, customerImpact: 1 } });
    const args = vi.mocked(prisma.workspaceAiSettings.update).mock.calls[0]?.[0];
    const w = args?.data?.priorityWeights as Record<string, number>;
    expect(w.deadline).toBe(0);
    expect(w.blocked).toBe(5);
    expect(w.customerImpact).toBe(1);
  });

  it('persists modelPreference and autoSuggestEnabled when supplied', async () => {
    await svc.update(adminActor(), {
      modelPreference: 'anthropic',
      autoSuggestEnabled: false,
    });
    const args = vi.mocked(prisma.workspaceAiSettings.update).mock.calls[0]?.[0];
    expect(args?.data?.modelPreference).toBe('anthropic');
    expect(args?.data?.autoSuggestEnabled).toBe(false);
  });
});

describe('dupThreshold propagates to DuplicateDetectionProcessor', () => {
  it('processor reads from WorkspaceAiSettingsService.getDupThreshold (no env coupling)', async () => {
    const prisma = makePrismaMock();
    const settingsSvc = new WorkspaceAiSettingsService(prisma);
    // Seed the singleton with a high threshold (0.95). The processor should
    // then treat a 0.9-similarity hit as BELOW threshold (no comment).
    vi.mocked(prisma.workspaceAiSettings.findUnique).mockResolvedValueOnce({
      ...defaultsRow(), dupThreshold: 0.95,
    } as never);

    const embeddings = { ensureFreshEmbedding: vi.fn().mockResolvedValue(undefined) };
    const llm = { embed: vi.fn().mockResolvedValue([0.1, 0.2]) };
    const qdrant = { searchSimilar: vi.fn().mockResolvedValue([
      { id: 'c-1', score: 0.9, payload: { status: 'Todo', title: 'similar', key: '12' } },
    ]) };
    const events = makeEventsMock();
    // AiCostTrackingService is a no-op stub here — the test doesn't assert
    // against cost recording, but the constructor signature requires it.
    // Method name is `record` (the service used to be `recordUsage` long
    // ago; the test stub still carried the old name).
    const costs = { record: vi.fn().mockResolvedValue(undefined) };
    const processor = new DuplicateDetectionProcessor(
      prisma,
      embeddings as unknown as EmbeddingService,
      llm as unknown as LlmService,
      qdrant as unknown as QdrantService,
      events.instance,
      settingsSvc,
      costs as unknown as AiCostTrackingService,
    );

    // Source task stub.
    vi.mocked(prisma.task.findUnique).mockResolvedValueOnce({
      id: 't-1', projectId: 'p1', title: 'login broken', description: '',
      project: { key: 'PRJ' },
    } as never);

    await processor.process({ data: { taskId: 't-1' } } as never);
    expect(prisma.comment.create).not.toHaveBeenCalled();

    // Now flip the threshold down by writing via Admin. The processor's next
    // run should let the same 0.9 hit through.
    vi.mocked(prisma.workspaceAiSettings.update).mockResolvedValueOnce({
      ...defaultsRow(), dupThreshold: 0.8,
    } as never);
    await settingsSvc.update(adminActor(), { dupThreshold: 0.8 });

    // Stub a fresh source task for the second run.
    vi.mocked(prisma.task.findUnique).mockResolvedValueOnce({
      id: 't-2', projectId: 'p1', title: 'login broken (dup)', description: '',
      project: { key: 'PRJ' },
    } as never);
    vi.mocked(prisma.user.findFirst).mockResolvedValueOnce({ id: 'system-admin' } as never);
    vi.mocked(prisma.comment.create).mockResolvedValueOnce({ id: 'ai-comment' } as never);

    await processor.process({ data: { taskId: 't-2' } } as never);
    expect(prisma.comment.create).toHaveBeenCalled();
  });
});
