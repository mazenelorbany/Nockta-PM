import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeEventsMock, makePrismaMock } from '../../test-utils/mocks';
import type { PrismaService } from '../../prisma/prisma.service';
import type { PermissionsService } from '../permissions/permissions.service';
import type { AuthenticatedUser } from '../auth/types';

import { SprintRetroService } from './retro.service';

// =============================================================================
// SprintRetroService — Pass I (Sprints 8 → 9).
//
// Pins:
//   - createRetro upserts (idempotent across re-clicks of "Save retro").
//   - listActionItems aggregates JSON columns from every retro in a project.
//   - evaluateGoal upserts the eval row + emits the analytics event.
//   - Permission gating: Manager+ for writes, Viewer+ for reads.
// =============================================================================

interface Mocks {
  prisma: PrismaService;
  permissions: { assertAtLeast: ReturnType<typeof vi.fn> };
  events: ReturnType<typeof makeEventsMock>;
}

function build(): { service: SprintRetroService; mocks: Mocks } {
  const prisma = makePrismaMock();
  const permissions = { assertAtLeast: vi.fn().mockResolvedValue(undefined) };
  const events = makeEventsMock();
  const service = new SprintRetroService(
    prisma,
    permissions as unknown as PermissionsService,
    events.instance,
  );
  return { service, mocks: { prisma, permissions, events } };
}

const ACTOR: AuthenticatedUser = {
  id: 'actor-1',
  email: 'a@nockta.com',
  kind: 'internal',
  companyRole: 'Member',
} as AuthenticatedUser;

const SPRINT_ID = '11111111-1111-1111-1111-111111111111';
const PROJECT_ID = '22222222-2222-2222-2222-222222222222';

describe('SprintRetroService.createRetro', () => {
  let mocks: Mocks;
  let service: SprintRetroService;

  beforeEach(() => {
    ({ service, mocks } = build());
  });

  it('throws NotFoundException when the sprint does not exist', async () => {
    vi.mocked(mocks.prisma.sprint.findUnique).mockResolvedValueOnce(null);
    await expect(
      service.createRetro(ACTOR, SPRINT_ID, { whatWentWell: 'shipped a thing' }),
    ).rejects.toThrow(NotFoundException);
  });

  it('upserts via Prisma upsert (idempotent on save)', async () => {
    vi.mocked(mocks.prisma.sprint.findUnique).mockResolvedValueOnce({
      id: SPRINT_ID, projectId: PROJECT_ID, state: 'completed',
    } as never);
    vi.mocked(mocks.prisma.sprintRetro.upsert).mockResolvedValueOnce({ id: 'r-1' } as never);

    await service.createRetro(ACTOR, SPRINT_ID, {
      whatWentWell: 'team velocity up',
      whatCouldImprove: 'sprint planning ran long',
      actionItems: [
        { id: '', description: 'Time-box planning to 60min', status: 'open' } as never,
      ],
    });

    expect(mocks.prisma.sprintRetro.upsert).toHaveBeenCalledOnce();
    const args = vi.mocked(mocks.prisma.sprintRetro.upsert).mock.calls[0]?.[0];
    expect(args?.where).toEqual({ sprintId: SPRINT_ID });
    expect(args?.create?.whatWentWell).toBe('team velocity up');
    expect(args?.update?.whatCouldImprove).toBe('sprint planning ran long');
    // The author is only set on create — re-saves don't overwrite authorship.
    expect(args?.create?.authorUserId).toBe('actor-1');
    expect(args?.update).not.toHaveProperty('authorUserId');
  });

  it('rejects action items with an empty description', async () => {
    vi.mocked(mocks.prisma.sprint.findUnique).mockResolvedValueOnce({
      id: SPRINT_ID, projectId: PROJECT_ID, state: 'completed',
    } as never);
    await expect(
      service.createRetro(ACTOR, SPRINT_ID, {
        actionItems: [{ description: '   ', status: 'open' } as never],
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('refuses non-Managers (Viewer attempting to save a retro)', async () => {
    vi.mocked(mocks.prisma.sprint.findUnique).mockResolvedValueOnce({
      id: SPRINT_ID, projectId: PROJECT_ID, state: 'completed',
    } as never);
    mocks.permissions.assertAtLeast.mockRejectedValueOnce(new ForbiddenException());

    await expect(
      service.createRetro(ACTOR, SPRINT_ID, { whatWentWell: 'x' }),
    ).rejects.toThrow(ForbiddenException);
  });
});

describe('SprintRetroService.listActionItems', () => {
  let mocks: Mocks;
  let service: SprintRetroService;

  beforeEach(() => {
    ({ service, mocks } = build());
  });

  it('flattens action items across every retro in a project', async () => {
    vi.mocked(mocks.prisma.sprintRetro.findMany).mockResolvedValueOnce([
      {
        id: 'r-1',
        sprintId: 's-1',
        actionItems: [
          { id: 'a', description: 'Try pair-programming', status: 'open', ownerUserId: null, dueDate: null },
          { id: 'b', description: 'Refactor CI', status: 'done', ownerUserId: null, dueDate: null },
        ],
        sprint: { id: 's-1', name: 'Sprint 1' },
      },
      {
        id: 'r-2',
        sprintId: 's-2',
        actionItems: [
          { id: 'c', description: 'Bring back demo Fridays', status: 'open', ownerUserId: 'u-1', dueDate: null },
        ],
        sprint: { id: 's-2', name: 'Sprint 2' },
      },
    ] as never);
    vi.mocked(mocks.prisma.user.findMany).mockResolvedValueOnce([
      { id: 'u-1', name: 'Alice', avatarUrl: null },
    ] as never);

    const items = await service.listActionItems(ACTOR, PROJECT_ID);

    expect(items).toHaveLength(3);
    const open = items.filter((i) => i.status === 'open');
    expect(open).toHaveLength(2);
    const withOwner = items.find((i) => i.ownerUserId === 'u-1');
    expect(withOwner?.owner).toMatchObject({ id: 'u-1', name: 'Alice' });
  });

  it('honours the status filter', async () => {
    vi.mocked(mocks.prisma.sprintRetro.findMany).mockResolvedValueOnce([
      {
        id: 'r-1',
        sprintId: 's-1',
        actionItems: [
          { id: 'a', description: 'open one', status: 'open', ownerUserId: null, dueDate: null },
          { id: 'b', description: 'done one', status: 'done', ownerUserId: null, dueDate: null },
        ],
        sprint: { id: 's-1', name: 'S1' },
      },
    ] as never);

    const opens = await service.listActionItems(ACTOR, PROJECT_ID, { status: 'open' });
    expect(opens).toHaveLength(1);
    expect(opens[0].description).toBe('open one');
  });
});

describe('SprintRetroService.evaluateGoal', () => {
  let mocks: Mocks;
  let service: SprintRetroService;

  beforeEach(() => {
    ({ service, mocks } = build());
  });

  it('upserts the eval row and emits sprint.goal_evaluated', async () => {
    vi.mocked(mocks.prisma.sprint.findUnique).mockResolvedValueOnce({
      id: SPRINT_ID, projectId: PROJECT_ID,
    } as never);
    vi.mocked(mocks.prisma.sprintGoalEvaluation.upsert).mockResolvedValueOnce({
      id: 'g-1', goalAchieved: true,
    } as never);

    await service.evaluateGoal(ACTOR, SPRINT_ID, { goalAchieved: true, note: 'shipped' });

    expect(mocks.prisma.sprintGoalEvaluation.upsert).toHaveBeenCalledOnce();
    expect(mocks.events.emit).toHaveBeenCalledWith(
      'sprint.goal_evaluated',
      expect.objectContaining({
        sprintId: SPRINT_ID,
        projectId: PROJECT_ID,
        goalAchieved: true,
        actorUserId: 'actor-1',
      }),
    );
  });
});
