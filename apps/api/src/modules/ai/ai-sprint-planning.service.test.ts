import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makePrismaMock } from '../../test-utils/mocks';
import type { PrismaService } from '../../prisma/prisma.service';
import type { AnalyticsService } from '../analytics/analytics.service';
import type { PermissionsService } from '../permissions/permissions.service';
import type { AuthenticatedUser } from '../auth/types';

import { AiSprintPlanningService } from './ai-sprint-planning.service';

// ai-sprint-planning.service — deterministic capacity + task ranking. The
// whole service is plain arithmetic + Prisma reads, so the tests pin:
//   1. Capacity recommendation reads from AnalyticsService.sprintVelocityForProjectId.
//   2. The fresh-project path uses the DEFAULT_CAPACITY_FRESH_PROJECT fallback.
//   3. suggestTasksForSprint NEVER returns more story points than `capacity` —
//      the greedy fill must respect the budget under every input shape.
//   4. Higher-priority tasks always rank above lower-priority ones regardless
//      of age (×100 weight on priority is the canonical invariant).

const ACTOR: AuthenticatedUser = {
  id: 'u-planner',
  email: 'pm@nockta.com',
  kind: 'internal',
  companyRole: 'Member',
} as AuthenticatedUser;

const PROJECT_ID = '11111111-1111-1111-1111-111111111111';

interface Mocks {
  prisma: PrismaService;
  analytics: { sprintVelocityForProjectId: ReturnType<typeof vi.fn> };
  permissions: { assertAtLeast: ReturnType<typeof vi.fn> };
}

function build(): { svc: AiSprintPlanningService; mocks: Mocks } {
  const prisma = makePrismaMock();
  const analytics = { sprintVelocityForProjectId: vi.fn() };
  const permissions = { assertAtLeast: vi.fn().mockResolvedValue(undefined) };
  const svc = new AiSprintPlanningService(
    prisma,
    permissions as unknown as PermissionsService,
    analytics as unknown as AnalyticsService,
  );
  return { svc, mocks: { prisma, analytics, permissions } };
}

describe('AiSprintPlanningService.suggestSprintCapacity', () => {
  let svc: AiSprintPlanningService;
  let mocks: Mocks;

  beforeEach(() => {
    ({ svc, mocks } = build());
  });

  it('falls back to the default capacity when the project has zero completed sprints', async () => {
    mocks.analytics.sprintVelocityForProjectId.mockResolvedValueOnce([]);
    const result = await svc.suggestSprintCapacity(ACTOR, PROJECT_ID);
    expect(result.sampleSize).toBe(0);
    expect(result.suggestedPoints).toBe(20); // DEFAULT_CAPACITY_FRESH_PROJECT
    expect(result.explanation).toMatch(/No completed sprints/i);
  });

  it('uses the last 3 completed sprints when more history is available', async () => {
    // 5 sprints with rising velocity → only the last 3 (20, 24, 22) should
    // contribute to the mean. (16+18 must be ignored.)
    mocks.analytics.sprintVelocityForProjectId.mockResolvedValueOnce([
      { completedEstimate: 16 },
      { completedEstimate: 18 },
      { completedEstimate: 20 },
      { completedEstimate: 24 },
      { completedEstimate: 22 },
    ]);
    const result = await svc.suggestSprintCapacity(ACTOR, PROJECT_ID);
    expect(result.sampleSize).toBe(3);
    expect(result.mean).toBe(22); // (20 + 24 + 22) / 3
    expect(result.suggestedPoints).toBe(22);
  });
});

describe('AiSprintPlanningService.suggestTasksForSprint', () => {
  let svc: AiSprintPlanningService;
  let mocks: Mocks;

  beforeEach(() => {
    ({ svc, mocks } = build());
  });

  function task(
    overrides: { id: string; priority: string; estimate: number; ageDays?: number },
  ): unknown {
    const now = Date.now();
    return {
      id: overrides.id,
      keyNumber: parseInt(overrides.id.replace(/\D/g, ''), 10) || 1,
      title: `Task ${overrides.id}`,
      priority: overrides.priority,
      estimate: overrides.estimate,
      createdAt: new Date(now - (overrides.ageDays ?? 1) * 24 * 60 * 60 * 1000),
      project: { key: 'PRJ' },
    };
  }

  it('never returns more story points than the requested capacity', async () => {
    vi.mocked(mocks.prisma.task.findMany).mockResolvedValueOnce([
      task({ id: 't1', priority: 'Critical', estimate: 5 }),
      task({ id: 't2', priority: 'High', estimate: 8 }),
      task({ id: 't3', priority: 'High', estimate: 5 }),
      task({ id: 't4', priority: 'Medium', estimate: 3 }),
      task({ id: 't5', priority: 'Medium', estimate: 8 }),
      task({ id: 't6', priority: 'Low', estimate: 2 }),
    ] as never);

    const capacity = 15;
    const out = await svc.suggestTasksForSprint(ACTOR, PROJECT_ID, capacity);

    // Capacity invariant — the most important property of the service.
    expect(out.usedPoints).toBeLessThanOrEqual(capacity);
    const sum = out.tasks.reduce((acc, t) => acc + t.storyPoints, 0);
    expect(sum).toBe(out.usedPoints);
    expect(sum).toBeLessThanOrEqual(capacity);
  });

  it('respects priority ordering — Critical/High beats Medium/Low regardless of age', async () => {
    // The old Low has age advantage (60 days) but the priority weight ×100
    // means the fresh Critical still wins.
    vi.mocked(mocks.prisma.task.findMany).mockResolvedValueOnce([
      task({ id: 't-low', priority: 'Low', estimate: 1, ageDays: 60 }),
      task({ id: 't-crit', priority: 'Critical', estimate: 1, ageDays: 1 }),
    ] as never);

    const out = await svc.suggestTasksForSprint(ACTOR, PROJECT_ID, 5);
    expect(out.tasks[0]?.priority).toBe('Critical');
    expect(out.tasks[1]?.priority).toBe('Low');
  });

  it('returns an empty pick list when the capacity is 0', async () => {
    vi.mocked(mocks.prisma.task.findMany).mockResolvedValueOnce([
      task({ id: 't1', priority: 'High', estimate: 5 }),
    ] as never);

    const out = await svc.suggestTasksForSprint(ACTOR, PROJECT_ID, 0);
    expect(out.tasks).toEqual([]);
    expect(out.usedPoints).toBe(0);
  });

  it('skips oversized tasks that would exceed the budget alone', async () => {
    // Capacity 5 with one 8-point and one 3-point candidate — only the 3
    // fits, the 8 must be skipped (not partially counted).
    vi.mocked(mocks.prisma.task.findMany).mockResolvedValueOnce([
      task({ id: 't-big', priority: 'High', estimate: 8 }),
      task({ id: 't-fit', priority: 'High', estimate: 3 }),
    ] as never);

    const out = await svc.suggestTasksForSprint(ACTOR, PROJECT_ID, 5);
    expect(out.tasks.map((t) => t.taskId)).toEqual(['t-fit']);
    expect(out.usedPoints).toBe(3);
    expect(out.usedPoints).toBeLessThanOrEqual(5);
  });
});
