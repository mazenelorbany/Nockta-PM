import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makePrismaMock } from '../../test-utils/mocks';
import type { PrismaService } from '../../prisma/prisma.service';
import type { PermissionsService } from '../permissions/permissions.service';
import type { AuthenticatedUser } from '../auth/types';

import { CustomReportsService } from './reports.service';

// =============================================================================
// CustomReportsService — Pass I (Analytics 8 → 9).
//
// Three test cases pinned by the grill summary:
//   1. Count by status.
//   2. sum_estimate by assignee.
//   3. Filter by date range (createdAfter / createdBefore).
//
// Plus the security guarantees:
//   - Unknown dimensions / metrics → 400 BEFORE any SQL is built.
//   - Filter values flow through Prisma.sql bindings (no string concat).
//   - A project-scoped report can't be run by a Viewer who lacks access to
//     the report's project.
// =============================================================================

interface Mocks {
  prisma: PrismaService;
  permissions: {
    assertAtLeast: ReturnType<typeof vi.fn>;
    effectiveRole: ReturnType<typeof vi.fn>;
  };
}

function build(): { service: CustomReportsService; mocks: Mocks } {
  const prisma = makePrismaMock();
  const permissions = {
    assertAtLeast: vi.fn().mockResolvedValue(undefined),
    effectiveRole: vi.fn().mockResolvedValue('Viewer'),
  };
  const service = new CustomReportsService(
    prisma,
    permissions as unknown as PermissionsService,
  );
  return { service, mocks: { prisma, permissions } };
}

const ADMIN: AuthenticatedUser = {
  id: 'admin-1',
  email: 'admin@nockta.com',
  kind: 'internal',
  companyRole: 'Admin',
} as AuthenticatedUser;

const PROJECT_ID = '11111111-1111-1111-1111-111111111111';

describe('CustomReportsService validation', () => {
  let mocks: Mocks;
  let service: CustomReportsService;

  beforeEach(() => {
    ({ service, mocks } = build());
  });

  it('rejects unknown dimensions before touching prisma', async () => {
    await expect(
      service.createReport(ADMIN, {
        name: 'bad',
        dimensions: ['totally-fake' as never],
        metric: 'count',
      }),
    ).rejects.toThrow(BadRequestException);
    expect(mocks.prisma.customReport.create).not.toHaveBeenCalled();
  });

  it('rejects unknown metrics', async () => {
    await expect(
      service.createReport(ADMIN, {
        name: 'bad',
        dimensions: ['status'],
        metric: 'kabooms' as never,
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects > 3 dimensions', async () => {
    await expect(
      service.createReport(ADMIN, {
        name: 'too-wide',
        dimensions: ['status', 'priority', 'assignee', 'sprint'],
        metric: 'count',
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('strips empty filter arrays from the persisted JSON', async () => {
    vi.mocked(mocks.prisma.customReport.create).mockResolvedValueOnce({ id: 'r-1' } as never);
    await service.createReport(ADMIN, {
      name: 'ok',
      dimensions: ['status'],
      metric: 'count',
      filters: { statuses: [], priorities: ['High'] } as never,
    });
    const args = vi.mocked(mocks.prisma.customReport.create).mock.calls[0]?.[0];
    expect(args?.data?.filters).toEqual({ priorities: ['High'] });
  });
});

describe('CustomReportsService.runReport', () => {
  let mocks: Mocks;
  let service: CustomReportsService;

  beforeEach(() => {
    ({ service, mocks } = build());
  });

  it('count by status — produces a parameterized $queryRaw and shapes rows', async () => {
    vi.mocked(mocks.prisma.customReport.findUnique).mockResolvedValueOnce({
      id: 'r-1',
      projectId: PROJECT_ID,
      dimensions: ['status'],
      metric: 'count',
      filters: {},
    } as never);
    // Admin: accessibleProjectIds returns everything not archived.
    vi.mocked(mocks.prisma.project.findMany).mockResolvedValueOnce([
      { id: PROJECT_ID },
    ] as never);
    vi.mocked(mocks.prisma.$queryRaw as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([
        { dim_status: 'Todo', metric_value: 12n },
        { dim_status: 'Done', metric_value: 3n },
      ]);

    const result = await service.runReport(ADMIN, 'r-1');

    expect(result.dimensions).toEqual(['status']);
    expect(result.metric).toBe('count');
    expect(result.rows).toEqual([
      { dimensionValues: { status: 'Todo' }, metricValue: 12 },
      { dimensionValues: { status: 'Done' }, metricValue: 3 },
    ]);
    // Critical: bigint metric is normalised to Number for JSON safety.
    expect(typeof result.rows[0].metricValue).toBe('number');
  });

  it('sum_estimate by assignee — picks the SUM aggregate', async () => {
    vi.mocked(mocks.prisma.customReport.findUnique).mockResolvedValueOnce({
      id: 'r-2',
      projectId: null,
      dimensions: ['assignee'],
      metric: 'sum_estimate',
      filters: {},
    } as never);
    vi.mocked(mocks.prisma.project.findMany).mockResolvedValueOnce([
      { id: PROJECT_ID },
    ] as never);
    vi.mocked(mocks.prisma.$queryRaw as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([
        { dim_assignee: 'alice', metric_value: 21n },
        { dim_assignee: 'bob',   metric_value: 8n },
      ]);

    const result = await service.runReport(ADMIN, 'r-2');

    expect(result.metric).toBe('sum_estimate');
    expect(result.rows[0]).toEqual({
      dimensionValues: { assignee: 'alice' },
      metricValue: 21,
    });
    // We can't easily snapshot the prepared SQL string without exposing it,
    // but we CAN assert the SUM aggregate keyword appears in the call.
    const sqlArg = vi.mocked(mocks.prisma.$queryRaw as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    // Prisma.sql produces a TemplateLiteral with a `strings` array. Walk it
    // and concatenate the raw fragments to assert against.
    const fragments = (sqlArg as unknown as { strings?: string[]; values?: unknown[] })?.strings;
    const joined = Array.isArray(fragments) ? fragments.join('') : String(sqlArg);
    expect(joined).toMatch(/SUM\(t\."estimate"\)/);
  });

  it('filter by date range — both bounds end up as bindings in the prepared SQL', async () => {
    vi.mocked(mocks.prisma.customReport.findUnique).mockResolvedValueOnce({
      id: 'r-3',
      projectId: PROJECT_ID,
      dimensions: ['status'],
      metric: 'count',
      filters: { createdAfter: '2025-01-01', createdBefore: '2025-02-01' },
    } as never);
    vi.mocked(mocks.prisma.project.findMany).mockResolvedValueOnce([
      { id: PROJECT_ID },
    ] as never);
    vi.mocked(mocks.prisma.$queryRaw as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([
        { dim_status: 'Todo', metric_value: 5n },
      ]);

    await service.runReport(ADMIN, 'r-3');

    const sqlArg = vi.mocked(mocks.prisma.$queryRaw as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    const values = (sqlArg as unknown as { values?: unknown[] }).values ?? [];
    // The two Date objects we passed should be present as bound values —
    // proving the dates are NOT interpolated into the SQL string.
    const dateValues = values.filter((v): v is Date => v instanceof Date);
    expect(dateValues).toHaveLength(2);
  });

  it('refuses to run a project-anchored report when actor cannot see the project', async () => {
    // Viewer with no access — accessibleProjectIds returns [].
    const viewer: AuthenticatedUser = {
      id: 'viewer-1',
      email: 'v@nockta.com',
      kind: 'internal',
      companyRole: 'Member',
    } as AuthenticatedUser;
    vi.mocked(mocks.prisma.customReport.findUnique).mockResolvedValueOnce({
      id: 'r-x',
      projectId: PROJECT_ID,
      dimensions: ['status'],
      metric: 'count',
      filters: {},
    } as never);
    mocks.permissions.effectiveRole.mockResolvedValueOnce(null);

    await expect(service.runReport(viewer, 'r-x')).rejects.toThrow(ForbiddenException);
  });
});
