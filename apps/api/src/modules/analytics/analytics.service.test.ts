import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makePrismaMock } from '../../test-utils/mocks';
import type { PrismaService } from '../../prisma/prisma.service';
import type { PermissionsService } from '../permissions/permissions.service';
import type { AuthenticatedUser } from '../auth/types';

import { AnalyticsService } from './analytics.service';

// =============================================================================
// analytics.service — fixture-based tests on the pure-math layer:
//
//   - velocity()'s EWMA projection produces a sensible weighted average
//     (recent sprints dominate; alpha=0.4 ≈ 5-sprint half-life).
//   - velocity() short-circuits cleanly on empty history.
//   - cumulativeFlow() returns an empty series when the project has no tasks.
//
// burndown() is deliberately NOT covered here — it's being rewritten in
// Phase 2 to use the new SprintTaskMembership table, and the test fixtures
// will need to change with it.
// =============================================================================

interface Mocks {
  prisma: PrismaService;
  permissions: { assertAtLeast: ReturnType<typeof vi.fn>; canSeeTask: ReturnType<typeof vi.fn> };
}

function build(): { service: AnalyticsService; mocks: Mocks } {
  const prisma = makePrismaMock();
  const permissions = {
    assertAtLeast: vi.fn().mockResolvedValue('Viewer'),
    canSeeTask: vi.fn().mockResolvedValue(true),
  };
  const service = new AnalyticsService(
    prisma,
    permissions as unknown as PermissionsService,
  );
  return { service, mocks: { prisma, permissions } };
}

const ACTOR: AuthenticatedUser = {
  id: 'u-1',
  email: 'a@nockta.com',
  kind: 'internal',
  companyRole: 'Member',
} as AuthenticatedUser;

describe('AnalyticsService.velocity', () => {
  let service: AnalyticsService;

  beforeEach(() => {
    ({ service } = build());
  });

  it('returns zeros and null projection when there is no sprint history', async () => {
    // Stub the private sprintVelocity at the instance level. Couples the
    // test to the helper name, but the alternative (mocking 4 separate
    // prisma calls) would be much more brittle.
    (service as unknown as { sprintVelocity: (id: string) => Promise<unknown[]> }).sprintVelocity = vi
      .fn()
      .mockResolvedValueOnce([]);

    const result = await service.velocity(ACTOR, 'p1');

    expect(result).toEqual({
      sprints: [],
      averageCount: 0,
      averageEstimate: 0,
      projectedNext: null,
    });
  });

  it('computes a recency-weighted EWMA: late jumps move the projection', async () => {
    // Sprint history: 5 sprints of 10 each, then a sprint of 30.
    // Simple mean = (10*5 + 30) / 6 = 13.33
    // EWMA with alpha=0.4 should land HIGHER than the simple mean because
    // recent sprints carry more weight. Hand-computed expected: ~17.5.
    const sprints = [
      { sprintId: 's1', completedCount: 10, completedEstimate: 100 },
      { sprintId: 's2', completedCount: 10, completedEstimate: 100 },
      { sprintId: 's3', completedCount: 10, completedEstimate: 100 },
      { sprintId: 's4', completedCount: 10, completedEstimate: 100 },
      { sprintId: 's5', completedCount: 10, completedEstimate: 100 },
      { sprintId: 's6', completedCount: 30, completedEstimate: 300 },
    ];
    (service as unknown as { sprintVelocity: (id: string) => Promise<unknown[]> }).sprintVelocity = vi
      .fn()
      .mockResolvedValueOnce(sprints);

    const result = await service.velocity(ACTOR, 'p1');

    expect(result.averageCount).toBe(13.3);
    // projectedNext is rounded; manually computed EWMA = 18 (alpha=0.4
    // recursive: starts at 10, runs 4 times at 10, then jumps once to 30).
    // The recurrence converges to 10 over the flat runs, then 0.4*30+0.6*10 = 18.
    expect(result.projectedNext?.count).toBe(18);
  });

  it('projects equals the single sprint when only one exists', async () => {
    (service as unknown as { sprintVelocity: (id: string) => Promise<unknown[]> }).sprintVelocity = vi
      .fn()
      .mockResolvedValueOnce([
        { sprintId: 's1', completedCount: 7, completedEstimate: 42 },
      ]);

    const result = await service.velocity(ACTOR, 'p1');

    expect(result.averageCount).toBe(7);
    expect(result.projectedNext?.count).toBe(7);
    expect(result.projectedNext?.estimate).toBe(42);
  });
});

// =============================================================================
// sprintVelocity (private helper) — planned-vs-completed reconstruction.
// Membership history is the source of "planned scope" so a task that got
// moved back to the backlog at sprint completion still counts as planned.
// =============================================================================

describe('AnalyticsService.sprintVelocity (private) — planned/completed reconstruction', () => {
  let mocks: Mocks;
  let service: AnalyticsService;

  beforeEach(() => {
    ({ service, mocks } = build());
  });

  function callPrivate(): Promise<{
    sprintId: string;
    name: string;
    plannedCount: number;
    plannedEstimate: number;
    completedCount: number;
    completedEstimate: number;
  }[]> {
    return (service as unknown as { sprintVelocity: (id: string) => Promise<{
      sprintId: string;
      name: string;
      plannedCount: number;
      plannedEstimate: number;
      completedCount: number;
      completedEstimate: number;
    }[]> }).sprintVelocity('p1');
  }

  it('plannedCount unions live tasks with historical (removed) memberships', async () => {
    // Three tasks were members at some point:
    //   - task-a: still in the sprint, Done
    //   - task-b: still in the sprint, not Done
    //   - task-c: was removed mid-sprint (only appears in memberships)
    //
    // plannedCount must equal 3 — completedCount must equal 1 (task-a).
    vi.mocked(mocks.prisma.sprint.findMany).mockResolvedValueOnce([
      {
        id: 's-1',
        name: 'Sprint 1',
        endDate: new Date('2026-02-01'),
        tasks: [
          { id: 'task-a', status: 'Done', estimate: 5 },
          { id: 'task-b', status: 'In Progress', estimate: 3 },
        ],
        memberships: [
          { taskId: 'task-a', addedAt: new Date(), removedAt: null },
          { taskId: 'task-b', addedAt: new Date(), removedAt: null },
          { taskId: 'task-c', addedAt: new Date(), removedAt: new Date() },
        ],
      },
    ] as never);

    const out = await callPrivate();

    expect(out).toHaveLength(1);
    expect(out[0]?.plannedCount).toBe(3);
    expect(out[0]?.completedCount).toBe(1);
  });

  it('treats Approved-status tasks as completed (design workflow preset)', async () => {
    vi.mocked(mocks.prisma.sprint.findMany).mockResolvedValueOnce([
      {
        id: 's-1',
        name: 'Sprint 1',
        endDate: new Date('2026-02-01'),
        tasks: [
          { id: 'task-a', status: 'Approved', estimate: 8 },
          { id: 'task-b', status: 'Done', estimate: 2 },
          { id: 'task-c', status: 'Designing', estimate: 5 },
        ],
        memberships: [],
      },
    ] as never);

    const out = await callPrivate();

    expect(out[0]?.completedCount).toBe(2);
    expect(out[0]?.completedEstimate).toBe(10);
  });

  it('plannedEstimate sums every CURRENT task in the sprint (regardless of status)', async () => {
    vi.mocked(mocks.prisma.sprint.findMany).mockResolvedValueOnce([
      {
        id: 's-1',
        name: 'Sprint 1',
        endDate: new Date(),
        tasks: [
          { id: 'task-a', status: 'Done', estimate: 5 },
          { id: 'task-b', status: 'In Progress', estimate: 3 },
          { id: 'task-c', status: 'Todo', estimate: 8 },
        ],
        memberships: [],
      },
    ] as never);

    const out = await callPrivate();

    expect(out[0]?.plannedEstimate).toBe(16);
    expect(out[0]?.completedEstimate).toBe(5);
  });

  it('returns sprints in oldest→newest order (reversed from the DESC query)', async () => {
    vi.mocked(mocks.prisma.sprint.findMany).mockResolvedValueOnce([
      { id: 's-3', name: 'Newest', endDate: new Date(), tasks: [], memberships: [] },
      { id: 's-2', name: 'Middle', endDate: new Date(), tasks: [], memberships: [] },
      { id: 's-1', name: 'Oldest', endDate: new Date(), tasks: [], memberships: [] },
    ] as never);

    const out = await callPrivate();

    expect(out.map((s) => s.sprintId)).toEqual(['s-1', 's-2', 's-3']);
  });
});

describe('AnalyticsService.cumulativeFlow', () => {
  let mocks: Mocks;
  let service: AnalyticsService;

  beforeEach(() => {
    ({ service, mocks } = build());
  });

  it('returns empty series when the project has zero tasks', async () => {
    vi.mocked(mocks.prisma.task.findMany).mockResolvedValueOnce([] as never);

    const result = await service.cumulativeFlow(ACTOR, 'p1', 7);

    expect(result.days).toBe(7);
    expect(result.series).toEqual([]);
  });

  it('clamps days to a sensible range via the controller (test the service accepts custom days)', async () => {
    vi.mocked(mocks.prisma.task.findMany).mockResolvedValueOnce([] as never);
    const result = await service.cumulativeFlow(ACTOR, 'p1', 60);
    expect(result.days).toBe(60);
  });
});

describe('AnalyticsService.burndown — membership-history reconstruction', () => {
  let mocks: Mocks;
  let service: AnalyticsService;

  beforeEach(() => {
    ({ service, mocks } = build());
  });

  it('caps the x-axis at sprint.endDate for completed sprints (not extending to today)', async () => {
    // The bug from the prior audit: `end = sprint.endDate ?? new Date()`
    // extended completed sprints' burndown all the way to today. The fix:
    // for state='completed', use the actual endDate without falling back.
    const start = new Date('2026-01-01T00:00:00Z');
    const end = new Date('2026-01-04T00:00:00Z'); // 3-day sprint
    vi.mocked(mocks.prisma.sprint.findUniqueOrThrow).mockResolvedValueOnce({
      id: 's-1',
      projectId: 'p1',
      state: 'completed',
      startDate: start,
      endDate: end,
      createdAt: start,
      memberships: [
        {
          taskId: 't-1',
          addedAt: start,
          removedAt: null,
          task: { id: 't-1', estimate: 5 },
        },
      ],
    } as never);
    vi.mocked(mocks.prisma.event.findMany).mockResolvedValueOnce([] as never);

    const result = await service.burndown(ACTOR, 's-1');

    // 3-day sprint → day 0 + day 1 + day 2 + day 3 = 4 points.
    expect(result.points.length).toBe(4);
    expect(result.points[0]?.date).toBe('2026-01-01');
    // The LAST point must equal endDate, not today.
    expect(result.points[result.points.length - 1]?.date).toBe('2026-01-04');
  });

  it('counts a task that LEFT the sprint mid-way as flat-line continuation up to its removal', async () => {
    // The other half of the bug: tasks removed from the sprint used to
    // disappear entirely from burndown. Now: while membership window is
    // open (addedAt..removedAt), the task counts toward scope; outside it,
    // it doesn't. So a task removed on day 2 shows up on days 0 and 1 but
    // not 2 onward — the line drops as if it were finished, but in a
    // separate window than the "Done" tasks.
    const start = new Date('2026-01-01T00:00:00Z');
    const end = new Date('2026-01-05T00:00:00Z');
    const removedDay2 = new Date('2026-01-03T00:00:00Z');
    vi.mocked(mocks.prisma.sprint.findUniqueOrThrow).mockResolvedValueOnce({
      id: 's-1',
      projectId: 'p1',
      state: 'completed',
      startDate: start,
      endDate: end,
      createdAt: start,
      memberships: [
        {
          taskId: 't-stays',
          addedAt: start,
          removedAt: null,
          task: { id: 't-stays', estimate: 3 },
        },
        {
          taskId: 't-left',
          addedAt: start,
          removedAt: removedDay2,
          task: { id: 't-left', estimate: 5 },
        },
      ],
    } as never);
    vi.mocked(mocks.prisma.event.findMany).mockResolvedValueOnce([] as never);

    const result = await service.burndown(ACTOR, 's-1');

    // Day 0 (Jan 1): both tasks in scope, both Todo → remaining = 2.
    expect(result.points[0]?.remaining).toBe(2);
    // Day 1 (Jan 2): still both → 2.
    expect(result.points[1]?.remaining).toBe(2);
    // Day 2 (Jan 3): t-left removed at start-of-day; out of scope. Only
    // t-stays remains → 1.
    expect(result.points[2]?.remaining).toBe(1);
    // Day 3 (Jan 4): only t-stays → 1.
    expect(result.points[3]?.remaining).toBe(1);
  });

  it('returns empty when no memberships exist (no historical scope)', async () => {
    vi.mocked(mocks.prisma.sprint.findUniqueOrThrow).mockResolvedValueOnce({
      id: 's-1',
      projectId: 'p1',
      state: 'active',
      startDate: new Date(),
      endDate: null,
      createdAt: new Date(),
      memberships: [],
    } as never);

    const result = await service.burndown(ACTOR, 's-1');

    expect(result).toEqual({ points: [], totalTasks: 0 });
  });
});

// =============================================================================
// goalHitRate — Pass I (Sprints 8→9). Aggregates SprintGoalEvaluation across
// the project's completed sprints.
// =============================================================================

describe('AnalyticsService.goalHitRate', () => {
  it('returns rate = null when no sprints have been evaluated yet', async () => {
    const { service, mocks } = build();
    vi.mocked(mocks.prisma.sprint.findMany).mockResolvedValueOnce([
      { id: 's-1', name: 'S1', endDate: new Date(), goalEval: null },
      { id: 's-2', name: 'S2', endDate: new Date(), goalEval: null },
    ] as never);

    const result = await service.goalHitRate(ACTOR, 'p-1');

    expect(result.totalSprints).toBe(2);
    expect(result.totalEvaluated).toBe(0);
    expect(result.rate).toBeNull();
  });

  it('computes rate = achieved / evaluated', async () => {
    const { service, mocks } = build();
    vi.mocked(mocks.prisma.sprint.findMany).mockResolvedValueOnce([
      { id: 's-1', name: 'S1', endDate: new Date(), goalEval: { goalAchieved: true } },
      { id: 's-2', name: 'S2', endDate: new Date(), goalEval: { goalAchieved: true } },
      { id: 's-3', name: 'S3', endDate: new Date(), goalEval: { goalAchieved: false } },
      { id: 's-4', name: 'S4', endDate: new Date(), goalEval: null }, // not yet evaluated
    ] as never);

    const result = await service.goalHitRate(ACTOR, 'p-1');

    expect(result.totalSprints).toBe(4);
    expect(result.totalEvaluated).toBe(3);
    expect(result.goalsAchieved).toBe(2);
    expect(result.rate).toBeCloseTo(2 / 3);
  });
});
