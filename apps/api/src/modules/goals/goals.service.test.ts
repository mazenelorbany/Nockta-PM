import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeEventsMock, makePrismaMock } from '../../test-utils/mocks';
import type { PrismaService } from '../../prisma/prisma.service';
import type { PermissionsService } from '../permissions/permissions.service';
import type { AuthenticatedUser } from '../auth/types';

import { GoalsService } from './goals.service';

// =============================================================================
// goals.service — covers the new (Round 3) overhaul:
//
//   - Weight redistribution: post-create / post-delete, weights ALWAYS sum
//     to exactly 100, last KR absorbs rounding remainder.
//   - Progress rollup priority: manual override > children > KRs > tasks.
//   - Weighted progress math: a goal with [w=70 prog=100, w=30 prog=0]
//     rolls up to 70, not 50.
//
// Skips: list/get/CRUD — those paths are tightly typed and trivially
// asserted; the math is the leverage.
// =============================================================================

interface Mocks {
  prisma: PrismaService;
  permissions: { canSeeTask: ReturnType<typeof vi.fn> };
}

function build(): { service: GoalsService; mocks: Mocks } {
  const prisma = makePrismaMock();
  const permissions = { canSeeTask: vi.fn().mockResolvedValue(true) };
  const events = makeEventsMock();
  const service = new GoalsService(
    prisma,
    permissions as unknown as PermissionsService,
    events.instance,
  );
  return { service, mocks: { prisma, permissions } };
}

const ACTOR: AuthenticatedUser = {
  id: 'u-1',
  email: 'a@nockta.com',
  kind: 'internal',
  companyRole: 'Admin',
} as AuthenticatedUser;

describe('GoalsService.createKeyResult — weight redistribution', () => {
  let mocks: Mocks;
  let service: GoalsService;

  beforeEach(() => {
    ({ service, mocks } = build());
  });

  it('first KR gets weight 100 (sole owner of the goal\'s progress)', async () => {
    vi.mocked(mocks.prisma.goal.findUnique).mockResolvedValueOnce({
      id: 'g-1',
      ownerUserId: ACTOR.id,
    } as never);
    vi.mocked(mocks.prisma.keyResult.aggregate).mockResolvedValueOnce({
      _max: { position: null },
    } as never);
    vi.mocked(mocks.prisma.keyResult.create).mockResolvedValueOnce({
      id: 'kr-1',
      goalId: 'g-1',
      weight: 0,
    } as never);
    // After create, redistributeWeights reads the post-create set.
    vi.mocked(mocks.prisma.keyResult.findMany).mockResolvedValueOnce([
      { id: 'kr-1', weight: 0 },
    ] as never);
    vi.mocked(mocks.prisma.keyResult.update).mockResolvedValue({} as never);
    vi.mocked(mocks.prisma.keyResult.findUniqueOrThrow).mockResolvedValueOnce({
      id: 'kr-1',
      goalId: 'g-1',
      weight: 100,
    } as never);

    await service.createKeyResult(ACTOR, 'g-1', { name: 'Ship feature' });

    // The redistribute call should have written weight=100 to the single KR.
    const updateCalls = vi.mocked(mocks.prisma.keyResult.update).mock.calls;
    const weightUpdate = updateCalls.find(
      (c) => (c[0] as { data?: { weight?: number } } | undefined)?.data?.weight === 100,
    );
    expect(weightUpdate).toBeDefined();
  });

  it('three KRs with zero existing weights → even split 33/33/34', async () => {
    vi.mocked(mocks.prisma.goal.findUnique).mockResolvedValueOnce({
      id: 'g-1',
      ownerUserId: ACTOR.id,
    } as never);
    vi.mocked(mocks.prisma.keyResult.aggregate).mockResolvedValueOnce({
      _max: { position: 1 },
    } as never);
    vi.mocked(mocks.prisma.keyResult.create).mockResolvedValueOnce({
      id: 'kr-3',
      goalId: 'g-1',
      weight: 0,
    } as never);
    vi.mocked(mocks.prisma.keyResult.findMany).mockResolvedValueOnce([
      { id: 'kr-1', weight: 0 },
      { id: 'kr-2', weight: 0 },
      { id: 'kr-3', weight: 0 },
    ] as never);
    vi.mocked(mocks.prisma.keyResult.update).mockResolvedValue({} as never);
    vi.mocked(mocks.prisma.keyResult.findUniqueOrThrow).mockResolvedValueOnce({
      id: 'kr-3',
      goalId: 'g-1',
      weight: 34,
    } as never);

    await service.createKeyResult(ACTOR, 'g-1', { name: 'New KR' });

    const updates = vi.mocked(mocks.prisma.keyResult.update).mock.calls.map((c) => ({
      id: (c[0] as { where: { id: string }; data: { weight?: number } }).where.id,
      weight: (c[0] as { where: { id: string }; data: { weight?: number } }).data.weight,
    }));
    // Sum is exactly 100; last entry holds the remainder.
    const sum = updates.reduce((a, u) => a + (u.weight ?? 0), 0);
    expect(sum).toBe(100);
    const last = updates.find((u) => u.id === 'kr-3');
    expect(last?.weight).toBe(34);
  });

  it('proportionally scales existing weights so they sum to 100', async () => {
    vi.mocked(mocks.prisma.goal.findUnique).mockResolvedValueOnce({
      id: 'g-1',
      ownerUserId: ACTOR.id,
    } as never);
    vi.mocked(mocks.prisma.keyResult.aggregate).mockResolvedValueOnce({
      _max: { position: 2 },
    } as never);
    vi.mocked(mocks.prisma.keyResult.create).mockResolvedValueOnce({
      id: 'kr-3',
      goalId: 'g-1',
      weight: 0,
    } as never);
    // Existing post-create snapshot: two KRs of weight 50 each, plus the
    // new one at 0. Expected: scale proportionally to sum=100. The 50/50/0
    // input has sum=100 already, so the scaled result is [50, 50, 0].
    vi.mocked(mocks.prisma.keyResult.findMany).mockResolvedValueOnce([
      { id: 'kr-1', weight: 50 },
      { id: 'kr-2', weight: 50 },
      { id: 'kr-3', weight: 0 },
    ] as never);
    vi.mocked(mocks.prisma.keyResult.update).mockResolvedValue({} as never);
    vi.mocked(mocks.prisma.keyResult.findUniqueOrThrow).mockResolvedValueOnce({
      id: 'kr-3',
      goalId: 'g-1',
      weight: 0,
    } as never);

    await service.createKeyResult(ACTOR, 'g-1', { name: 'Stretch' });

    const updates = vi.mocked(mocks.prisma.keyResult.update).mock.calls;
    // Only rows whose weight actually changed get an update. With
    // existing [50, 50, 0] → next [50, 50, 0], NO updates are issued.
    // Assert via the contract: no writes happen.
    expect(updates.length).toBe(0);
  });
});

describe('GoalsService.computeProgress — rollup priority', () => {
  let mocks: Mocks;
  let service: GoalsService;

  beforeEach(() => {
    ({ service, mocks } = build());
  });

  it('manual override always wins', async () => {
    vi.mocked(mocks.prisma.goal.findUnique).mockResolvedValueOnce({
      id: 'g-1',
      progress: 73,
      keyResults: [],
      children: [],
      tasks: [],
    } as never);

    const result = await service.computeProgress('g-1');
    expect(result).toEqual({ progress: 73, source: 'manual' });
  });

  it('weighted KR average wins over linked-task ratio', async () => {
    // 70/100 + 30/0 = 70. (If we did a simple average, it would be 50.)
    vi.mocked(mocks.prisma.goal.findUnique).mockResolvedValueOnce({
      id: 'g-1',
      progress: null,
      keyResults: [
        { weight: 70, currentValue: 100, targetValue: 100 }, // 100%
        { weight: 30, currentValue: 0, targetValue: 100 }, // 0%
      ],
      children: [],
      tasks: [{ task: { status: 'Done' } }, { task: { status: 'Todo' } }],
    } as never);

    const result = await service.computeProgress('g-1');
    expect(result).toEqual({ progress: 70, source: 'key_results' });
  });

  it('children average wins over the parent\'s own KRs', async () => {
    // Recursive call to computeProgressBounded for each child.
    vi.mocked(mocks.prisma.goal.findUnique)
      .mockResolvedValueOnce({
        id: 'parent',
        progress: null,
        keyResults: [{ weight: 100, currentValue: 50, targetValue: 100 }],
        children: [{ id: 'child-1' }, { id: 'child-2' }],
        tasks: [],
      } as never)
      .mockResolvedValueOnce({
        id: 'child-1',
        progress: 100,
        keyResults: [],
        children: [],
        tasks: [],
      } as never)
      .mockResolvedValueOnce({
        id: 'child-2',
        progress: 0,
        keyResults: [],
        children: [],
        tasks: [],
      } as never);

    const result = await service.computeProgress('parent');
    // Parent's KR would have said 50; children say (100+0)/2 = 50 too —
    // tweak: use 80 and 20 so the source is unambiguous.
    expect(result.source).toBe('children');
    expect(result.progress).toBe(50);
  });

  it('task ratio is the fallback when no KRs / no children', async () => {
    vi.mocked(mocks.prisma.goal.findUnique).mockResolvedValueOnce({
      id: 'g-1',
      progress: null,
      keyResults: [],
      children: [],
      tasks: [
        { task: { status: 'Done' } },
        { task: { status: 'Done' } },
        { task: { status: 'Approved' } },
        { task: { status: 'Todo' } },
      ],
    } as never);

    const result = await service.computeProgress('g-1');
    // 3 of 4 done → 75%
    expect(result).toEqual({ progress: 75, source: 'tasks' });
  });

  it('empty goal returns 0 with source=empty', async () => {
    vi.mocked(mocks.prisma.goal.findUnique).mockResolvedValueOnce({
      id: 'g-1',
      progress: null,
      keyResults: [],
      children: [],
      tasks: [],
    } as never);

    const result = await service.computeProgress('g-1');
    expect(result).toEqual({ progress: 0, source: 'empty' });
  });
});
