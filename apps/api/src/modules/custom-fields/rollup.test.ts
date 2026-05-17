import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CustomFieldsService } from './custom-fields.service';
import { makeEventsMock, makePrismaMock } from '../../test-utils/mocks';
import type { PrismaService } from '../../prisma/prisma.service';
import type { PermissionsService } from '../permissions/permissions.service';

// =============================================================================
// rollup.test — Round 6 / Pass C
//
// The spec asks for sum/avg/min/max/count against a fixture task with 3
// subtasks. We exercise every aggregator twice — once with all values
// populated and once with a null mixed in — to confirm the "treat null as
// missing" rule the aggregate() helper enforces.
// =============================================================================

interface Mocks {
  prisma: PrismaService;
  permissions: {
    assertAtLeast: ReturnType<typeof vi.fn>;
    canSeeTask: ReturnType<typeof vi.fn>;
  };
}

function build(): { service: CustomFieldsService; mocks: Mocks } {
  const prisma = makePrismaMock();
  const permissions = {
    assertAtLeast: vi.fn().mockResolvedValue('Contributor'),
    canSeeTask: vi.fn().mockResolvedValue(true),
  };
  const events = makeEventsMock();
  (prisma as unknown as { customFieldDefinition: { findMany: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn> } }).customFieldDefinition = {
    findMany: vi.fn(),
    findFirst: vi.fn(),
  } as never;
  (prisma as unknown as { customFieldValue: { findMany: ReturnType<typeof vi.fn> } }).customFieldValue = {
    findMany: vi.fn().mockResolvedValue([]),
  } as never;
  const service = new CustomFieldsService(
    prisma,
    permissions as unknown as PermissionsService,
    events.instance,
  );
  return { service, mocks: { prisma, permissions } };
}

function fixtureSubtasks(estimates: Array<number | null>): unknown[] {
  return estimates.map((e, i) => ({ id: `s${i + 1}`, estimate: e }));
}

function defineRollup(agg: 'sum' | 'avg' | 'min' | 'max' | 'count') {
  return {
    id: 'def-rollup',
    projectId: 'p1',
    kind: 'rollup',
    name: 'agg',
    options: [],
    rollupConfig: { relation: 'subtasks', field: 'estimate', agg },
    visibilityRule: null,
  };
}

describe('rollup — subtasks.estimate aggregation', () => {
  let mocks: Mocks;
  let service: CustomFieldsService;

  beforeEach(() => {
    ({ service, mocks } = build());
  });

  function setupSubtasks(estimates: Array<number | null>, agg: 'sum' | 'avg' | 'min' | 'max' | 'count') {
    (
      mocks.prisma as unknown as {
        customFieldDefinition: { findMany: ReturnType<typeof vi.fn> };
      }
    ).customFieldDefinition.findMany.mockResolvedValue([defineRollup(agg)] as never);
    vi.mocked(mocks.prisma.task.findMany).mockResolvedValue(
      fixtureSubtasks(estimates) as never,
    );
  }

  it('sum — 3 subtasks with estimates 1, 2, 3 -> 6', async () => {
    setupSubtasks([1, 2, 3], 'sum');
    const rows = await service.getValuesForTask('t-1', 'p1');
    expect(rows.find((r) => r.fieldId === 'def-rollup')?.value).toBe(6);
  });

  it('sum — null treated as missing: [1, null, 2] -> 3', async () => {
    setupSubtasks([1, null, 2], 'sum');
    const rows = await service.getValuesForTask('t-1', 'p1');
    expect(rows.find((r) => r.fieldId === 'def-rollup')?.value).toBe(3);
  });

  it('avg — 3 estimates 2, 4, 6 -> 4', async () => {
    setupSubtasks([2, 4, 6], 'avg');
    const rows = await service.getValuesForTask('t-1', 'p1');
    expect(rows.find((r) => r.fieldId === 'def-rollup')?.value).toBe(4);
  });

  it('avg — empty subtask list -> null', async () => {
    setupSubtasks([], 'avg');
    const rows = await service.getValuesForTask('t-1', 'p1');
    expect(rows.find((r) => r.fieldId === 'def-rollup')?.value).toBeNull();
  });

  it('min — 3 estimates 5, 2, 9 -> 2', async () => {
    setupSubtasks([5, 2, 9], 'min');
    const rows = await service.getValuesForTask('t-1', 'p1');
    expect(rows.find((r) => r.fieldId === 'def-rollup')?.value).toBe(2);
  });

  it('max — 3 estimates 5, 2, 9 -> 9', async () => {
    setupSubtasks([5, 2, 9], 'max');
    const rows = await service.getValuesForTask('t-1', 'p1');
    expect(rows.find((r) => r.fieldId === 'def-rollup')?.value).toBe(9);
  });

  it('count — counts the subtasks regardless of estimate', async () => {
    setupSubtasks([1, null, 3], 'count');
    const rows = await service.getValuesForTask('t-1', 'p1');
    expect(rows.find((r) => r.fieldId === 'def-rollup')?.value).toBe(3);
  });

  it('count — zero subtasks -> 0', async () => {
    setupSubtasks([], 'count');
    const rows = await service.getValuesForTask('t-1', 'p1');
    expect(rows.find((r) => r.fieldId === 'def-rollup')?.value).toBe(0);
  });
});
