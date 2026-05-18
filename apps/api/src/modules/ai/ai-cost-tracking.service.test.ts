import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AiCostTrackingService } from './ai-cost-tracking.service';
import { makePrismaMock } from '../../test-utils/mocks';
import type { PrismaService } from '../../prisma/prisma.service';

// ai-cost-tracking.service — verifies:
//   1. record() computes costUsdCents from the static price table and persists
//      a row through the Prisma client.
//   2. record() never throws even when Prisma errors (cost tracking must not
//      block the caller's LLM call).
//   3. currentMonthSpendCents() aggregates only the current calendar month.
//   4. summary() turns the raw $queryRaw rows into a continuous daily series.

function build(): { svc: AiCostTrackingService; prisma: PrismaService } {
  const prisma = makePrismaMock();
  // makePrismaMock seeds `aiUsageEvent` with bare vi.fn()s; nudge sensible
  // defaults so individual tests can mockResolvedValueOnce when they care.
  vi.mocked(prisma.aiUsageEvent.create).mockResolvedValue({} as never);
  vi.mocked(prisma.aiUsageEvent.aggregate).mockResolvedValue({
    _sum: { costUsdCents: 0 },
  } as never);
  const svc = new AiCostTrackingService(prisma);
  return { svc, prisma };
}

describe('AiCostTrackingService.computeCostCents', () => {
  it('uses the static price table for Claude Sonnet (300 in / 1500 out cents per Mtok)', () => {
    const { svc } = build();
    // 100k input tokens at 300 cents/Mtok = 30 cents.
    // 50k output tokens at 1500 cents/Mtok = 75 cents.
    expect(svc.computeCostCents('claude-sonnet-4-6', 100_000, 50_000)).toBe(105);
  });

  it('treats Ollama models as zero-cost', () => {
    const { svc } = build();
    expect(svc.computeCostCents('llama3.2', 100_000, 50_000)).toBe(0);
  });

  it('falls back to the default Anthropic price for unknown model names', () => {
    const { svc } = build();
    // Unknown model uses DEFAULT_PRICE = Sonnet-equivalent.
    expect(svc.computeCostCents('claude-future-model-xyz', 100_000, 50_000)).toBe(105);
  });
});

describe('AiCostTrackingService.record', () => {
  let svc: AiCostTrackingService;
  let prisma: PrismaService;

  beforeEach(() => {
    ({ svc, prisma } = build());
  });

  it('persists one row with the computed cost and provided fields', async () => {
    await svc.record({
      kind: 'prioritize',
      modelName: 'claude-sonnet-4-6',
      inputTokens: 100_000,
      outputTokens: 50_000,
      userId: 'u-1',
    });
    const create = vi.mocked(prisma.aiUsageEvent.create);
    expect(create).toHaveBeenCalledTimes(1);
    const args = create.mock.calls[0]?.[0];
    expect(args?.data?.kind).toBe('prioritize');
    expect(args?.data?.modelName).toBe('claude-sonnet-4-6');
    expect(args?.data?.inputTokens).toBe(100_000);
    expect(args?.data?.outputTokens).toBe(50_000);
    expect(args?.data?.costUsdCents).toBe(105);
    expect(args?.data?.userId).toBe('u-1');
    expect(args?.data?.status).toBe('ok');
  });

  it('does NOT throw when Prisma create errors (cost tracking is best-effort)', async () => {
    const create = vi.mocked(prisma.aiUsageEvent.create);
    create.mockRejectedValueOnce(new Error('db down'));
    await expect(
      svc.record({
        kind: 'duplicate',
        modelName: 'claude-sonnet-4-6',
        inputTokens: 100,
        outputTokens: 50,
      }),
    ).resolves.toBeUndefined();
  });

  it('records budget_exceeded short-circuits with cost=0 and the explicit status', async () => {
    await svc.record({
      kind: 'summarize',
      modelName: 'claude-sonnet-4-6',
      inputTokens: 0,
      outputTokens: 0,
      status: 'budget_exceeded',
    });
    const create = vi.mocked(prisma.aiUsageEvent.create);
    const args = create.mock.calls[0]?.[0];
    expect(args?.data?.status).toBe('budget_exceeded');
    expect(args?.data?.costUsdCents).toBe(0);
  });
});

describe('AiCostTrackingService.currentMonthSpendCents', () => {
  it('aggregates costUsdCents starting at the first of the current UTC month', async () => {
    const { svc, prisma } = build();
    const agg = vi.mocked(prisma.aiUsageEvent.aggregate);
    agg.mockResolvedValueOnce({ _sum: { costUsdCents: 4200 } } as never);

    const total = await svc.currentMonthSpendCents('prioritize');
    expect(total).toBe(4200);

    const args = agg.mock.calls[0]?.[0];
    expect(args?.where?.kind).toBe('prioritize');
    expect(args?.where?.status).toBe('ok');
    // since-of-month must be on day 1 of the current month, UTC.
    // `createdAt` is typed as `Date | DateTimeFilter` — at runtime it's
    // always the filter object. Cast through unknown for the assertion.
    const createdAt = args?.where?.createdAt as { gte?: Date } | undefined;
    const since = createdAt?.gte as Date;
    expect(since.getUTCDate()).toBe(1);
    expect(since.getUTCHours()).toBe(0);
  });

  it('returns 0 when no rows exist for the period', async () => {
    const { svc } = build();
    const total = await svc.currentMonthSpendCents();
    expect(total).toBe(0);
  });
});

describe('AiCostTrackingService.summary — record-then-aggregate round trip', () => {
  it('builds a continuous daily series and groups cost by kind/model', async () => {
    const { svc, prisma } = build();
    const since = new Date('2026-05-01T00:00:00.000Z');
    const until = new Date('2026-05-04T00:00:00.000Z');

    // Pretend three rows were persisted (record → aggregate round trip is
    // simulated by stubbing $queryRaw with what the GROUP BY would return).
    vi.mocked(prisma.$queryRaw as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { day: new Date('2026-05-01T00:00:00.000Z'), kind: 'prioritize', modelName: 'claude-sonnet-4-6', cost: 105n },
      { day: new Date('2026-05-02T00:00:00.000Z'), kind: 'duplicate', modelName: 'claude-sonnet-4-6', cost: 30n },
      { day: new Date('2026-05-02T00:00:00.000Z'), kind: 'summarize', modelName: 'claude-sonnet-4-6', cost: 20n },
    ]);

    const out = await svc.summary({ since, until });

    expect(out.totalCostCents).toBe(155);
    // The window is May 1..May 4 inclusive of both ends → 4 day buckets.
    expect(out.days.map((d) => d.date)).toEqual([
      '2026-05-01',
      '2026-05-02',
      '2026-05-03',
      '2026-05-04',
    ]);
    expect(out.days[0]?.totalCostCents).toBe(105);
    expect(out.days[0]?.byKind.prioritize).toBe(105);
    expect(out.days[0]?.byModel['claude-sonnet-4-6']).toBe(105);

    expect(out.days[1]?.totalCostCents).toBe(50);
    expect(out.days[1]?.byKind.duplicate).toBe(30);
    expect(out.days[1]?.byKind.summarize).toBe(20);

    // Empty days stay zero-valued (no holes in the series).
    expect(out.days[2]?.totalCostCents).toBe(0);
    expect(out.days[3]?.totalCostCents).toBe(0);
  });
});
