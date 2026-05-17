import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AiStandupService } from './ai-standup.service';
import { makePrismaMock } from '../../test-utils/mocks';
import type { PrismaService } from '../../prisma/prisma.service';
import type { LlmService } from './llm.service';
import type { WorkspaceAiSettingsService } from './workspace-ai-settings.service';
import type { AiCostTrackingService } from './ai-cost-tracking.service';
import type { AuthenticatedUser } from '../auth/types';

// ai-standup.service — STRUCTURED standup synthesis with quoted citations.
// We pin:
//   1. The LLM is fed a snippet table with stable [tag] markers AND the
//      synthesized result attaches the correct sourceIds back to each line.
//   2. Feature toggles + budget gates short-circuit before the LLM is called.
//   3. Unknown [tags] in the LLM output are silently dropped (defensive).

const TARGET_ID = 'u-target';
const ACTOR: AuthenticatedUser = {
  id: TARGET_ID,
  email: 't@nockta.com',
  kind: 'internal',
  companyRole: 'Member',
} as AuthenticatedUser;

const SINCE = new Date('2026-05-15T00:00:00.000Z');
const UNTIL = new Date('2026-05-16T00:00:00.000Z');

interface Mocks {
  prisma: PrismaService;
  llm: { generateWithUsage: ReturnType<typeof vi.fn> };
  settings: { get: ReturnType<typeof vi.fn> };
  costs: {
    record: ReturnType<typeof vi.fn>;
    currentMonthSpendCents: ReturnType<typeof vi.fn>;
    computeCostCents: ReturnType<typeof vi.fn>;
  };
}

function build(): { svc: AiStandupService; mocks: Mocks } {
  const prisma = makePrismaMock();
  const llm = { generateWithUsage: vi.fn() };
  const settings = {
    get: vi.fn().mockResolvedValue({
      autoSuggestEnabled: true,
      settings: {
        features: { standupSynthesis: true },
        monthlyBudgetUsdCents: {},
      },
    }),
  };
  const costs = {
    record: vi.fn().mockResolvedValue(undefined),
    currentMonthSpendCents: vi.fn().mockResolvedValue(0),
    computeCostCents: vi.fn().mockReturnValue(42),
  };
  const svc = new AiStandupService(
    prisma,
    llm as unknown as LlmService,
    settings as unknown as WorkspaceAiSettingsService,
    costs as unknown as AiCostTrackingService,
  );
  return { svc, mocks: { prisma, llm, settings, costs } };
}

function stubTarget(prisma: PrismaService): void {
  vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
    id: TARGET_ID, name: 'Alex', kind: 'internal',
  } as never);
}

describe('AiStandupService.synthesize', () => {
  let svc: AiStandupService;
  let mocks: Mocks;

  beforeEach(() => {
    ({ svc, mocks } = build());
  });

  it('returns empty result with no LLM call when autoSuggestEnabled is false', async () => {
    stubTarget(mocks.prisma);
    mocks.settings.get.mockResolvedValueOnce({
      autoSuggestEnabled: false,
      settings: { features: { standupSynthesis: true }, monthlyBudgetUsdCents: {} },
    });
    const out = await svc.synthesize(ACTOR, TARGET_ID, SINCE, UNTIL);
    expect(out).toEqual({ did: [], doing: [], blockers: [], costUsdCents: 0 });
    expect(mocks.llm.generateWithUsage).not.toHaveBeenCalled();
  });

  it('returns empty result when the standupSynthesis feature flag is off', async () => {
    stubTarget(mocks.prisma);
    mocks.settings.get.mockResolvedValueOnce({
      autoSuggestEnabled: true,
      settings: { features: { standupSynthesis: false }, monthlyBudgetUsdCents: {} },
    });
    const out = await svc.synthesize(ACTOR, TARGET_ID, SINCE, UNTIL);
    expect(out.did).toEqual([]);
    expect(mocks.llm.generateWithUsage).not.toHaveBeenCalled();
  });

  it('short-circuits with budget_exceeded telemetry when over the monthly cap', async () => {
    stubTarget(mocks.prisma);
    mocks.settings.get.mockResolvedValueOnce({
      autoSuggestEnabled: true,
      settings: {
        features: { standupSynthesis: true },
        monthlyBudgetUsdCents: { standup: 1000 },
      },
    });
    mocks.costs.currentMonthSpendCents.mockResolvedValueOnce(1500);

    const out = await svc.synthesize(ACTOR, TARGET_ID, SINCE, UNTIL);
    expect(out.did).toEqual([]);
    expect(mocks.llm.generateWithUsage).not.toHaveBeenCalled();
    expect(mocks.costs.record).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'standup', status: 'budget_exceeded' }),
    );
  });

  it('builds citations from the LLM response and attaches the matching source IDs', async () => {
    stubTarget(mocks.prisma);

    // Three buckets of source data — completed event, in-progress task, comment.
    vi.mocked(mocks.prisma.event.findMany).mockResolvedValueOnce([
      { entityId: 'task-done-1', payload: { toStatus: 'Done' }, createdAt: new Date() },
    ] as never);
    vi.mocked(mocks.prisma.task.findMany).mockResolvedValueOnce([
      // in-progress
      { id: 'task-doing-1', keyNumber: 7, title: 'Refactor X', status: 'In Progress', isBlocked: false,
        project: { key: 'PRJ' } },
    ] as never);
    vi.mocked(mocks.prisma.comment.findMany).mockResolvedValueOnce([
      { id: 'comment-1', bodyMd: 'shipped the new auth flow', taskId: 'task-done-1', createdAt: new Date(),
        task: { keyNumber: 3, project: { key: 'PRJ' } } },
    ] as never);
    vi.mocked(mocks.prisma.task.findMany).mockResolvedValueOnce([
      // blocked
      { id: 'task-blocked-1', keyNumber: 9, title: 'Waiting on infra', blockedReason: 'infra ticket #4',
        project: { key: 'PRJ' } },
    ] as never);
    // Resolve titles for the doneTaskIds bucket (the 5th findMany call).
    vi.mocked(mocks.prisma.task.findMany).mockResolvedValueOnce([
      { id: 'task-done-1', keyNumber: 3, title: 'Auth fix', project: { key: 'PRJ' } },
    ] as never);

    // LLM returns structured JSON with citations using our tag scheme. Tag
    // "d1" → task-done-1 (the done-event task), "c1" → comment-1, "p1" →
    // task-doing-1, "b1" → task-blocked-1, "zz" → unknown (must be dropped).
    mocks.llm.generateWithUsage.mockResolvedValueOnce({
      text: JSON.stringify({
        did: ['Shipped the auth fix [d1] [c1]', 'Ungrounded item [zz]'],
        doing: ['Refactoring X [p1]'],
        blockers: ['Infra ticket open [b1]'],
      }),
      modelName: 'claude-sonnet-4-6',
      inputTokens: 1234,
      outputTokens: 567,
    });

    const out = await svc.synthesize(ACTOR, TARGET_ID, SINCE, UNTIL);

    expect(out.did).toHaveLength(2);
    expect(out.did[0]).toEqual({
      line: 'Shipped the auth fix',
      sourceIds: ['task-done-1', 'comment-1'],
    });
    // Unknown tag dropped → sourceIds empty, line preserved sans tag marker.
    expect(out.did[1]).toEqual({ line: 'Ungrounded item', sourceIds: [] });

    expect(out.doing[0]).toEqual({ line: 'Refactoring X', sourceIds: ['task-doing-1'] });
    expect(out.blockers[0]).toEqual({
      line: 'Infra ticket open',
      sourceIds: ['task-blocked-1'],
    });

    // Cost tracking row was written with the model + token counts.
    expect(mocks.costs.record).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'standup',
        modelName: 'claude-sonnet-4-6',
        inputTokens: 1234,
        outputTokens: 567,
        userId: TARGET_ID,
      }),
    );
    expect(out.costUsdCents).toBe(42);
  });

  it('returns empty result without calling the LLM when no source snippets exist', async () => {
    stubTarget(mocks.prisma);
    vi.mocked(mocks.prisma.event.findMany).mockResolvedValueOnce([] as never);
    vi.mocked(mocks.prisma.task.findMany).mockResolvedValueOnce([] as never);
    vi.mocked(mocks.prisma.comment.findMany).mockResolvedValueOnce([] as never);
    vi.mocked(mocks.prisma.task.findMany).mockResolvedValueOnce([] as never);

    const out = await svc.synthesize(ACTOR, TARGET_ID, SINCE, UNTIL);
    expect(out).toEqual({ did: [], doing: [], blockers: [], costUsdCents: 0 });
    expect(mocks.llm.generateWithUsage).not.toHaveBeenCalled();
  });

  it('handles malformed LLM JSON by returning empty buckets (defensive)', async () => {
    stubTarget(mocks.prisma);
    vi.mocked(mocks.prisma.event.findMany).mockResolvedValueOnce([] as never);
    vi.mocked(mocks.prisma.task.findMany).mockResolvedValueOnce([
      { id: 't-1', keyNumber: 1, title: 'x', status: 'In Progress', isBlocked: false,
        project: { key: 'PRJ' } },
    ] as never);
    vi.mocked(mocks.prisma.comment.findMany).mockResolvedValueOnce([] as never);
    vi.mocked(mocks.prisma.task.findMany).mockResolvedValueOnce([] as never);

    mocks.llm.generateWithUsage.mockResolvedValueOnce({
      text: 'this is not json at all',
      modelName: 'claude-sonnet-4-6',
      inputTokens: 10,
      outputTokens: 5,
    });

    const out = await svc.synthesize(ACTOR, TARGET_ID, SINCE, UNTIL);
    expect(out.did).toEqual([]);
    expect(out.doing).toEqual([]);
    expect(out.blockers).toEqual([]);
    // The cost row STILL gets written — we paid for the call even if it
    // failed to come back as JSON.
    expect(mocks.costs.record).toHaveBeenCalled();
  });
});
