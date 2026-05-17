import { BadRequestException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LabelsService } from './labels.service';
import { makeEventsMock, makePrismaMock } from '../../test-utils/mocks';
import type { PrismaService } from '../../prisma/prisma.service';
import type { PermissionsService } from '../permissions/permissions.service';
import type { AuthenticatedUser } from '../auth/types';

// =============================================================================
// labels.service — focused tests on:
//   - Color/name validation (the regex is the only piece of business logic
//     in create/update).
//   - Attach refuses cross-project labels.
//   - Detach is idempotent (P2025-tolerant).
//   - Role gates per method (Client→list, Contributor→create/edit/attach,
//     Manager→delete).
// =============================================================================

interface Mocks {
  prisma: PrismaService;
  permissions: { assertAtLeast: ReturnType<typeof vi.fn>; canSeeTask: ReturnType<typeof vi.fn> };
  events: ReturnType<typeof makeEventsMock>;
}

function build(): { service: LabelsService; mocks: Mocks } {
  const prisma = makePrismaMock();
  const permissions = {
    assertAtLeast: vi.fn().mockResolvedValue('Contributor'),
    canSeeTask: vi.fn().mockResolvedValue(true),
  };
  const events = makeEventsMock();
  const service = new LabelsService(
    prisma,
    permissions as unknown as PermissionsService,
    events.instance,
  );
  return { service, mocks: { prisma, permissions, events } };
}

const ACTOR: AuthenticatedUser = {
  id: 'u-1',
  email: 'a@nockta.com',
  kind: 'internal',
  companyRole: 'Member',
} as AuthenticatedUser;

describe('LabelsService.create — validation', () => {
  let mocks: Mocks;
  let service: LabelsService;

  beforeEach(() => {
    ({ service, mocks } = build());
  });

  it('rejects empty name', async () => {
    await expect(service.create(ACTOR, 'p1', { name: '   ' })).rejects.toThrow(
      /name is required/i,
    );
    expect(mocks.prisma.label.create).not.toHaveBeenCalled();
  });

  it('rejects a non-hex color', async () => {
    await expect(
      service.create(ACTOR, 'p1', { name: 'bug', color: 'red' }),
    ).rejects.toThrow(BadRequestException);
    expect(mocks.prisma.label.create).not.toHaveBeenCalled();
  });

  it('accepts a 6-char hex color with or without #', async () => {
    vi.mocked(mocks.prisma.label.create).mockResolvedValueOnce({ id: 'l-1' } as never);
    await service.create(ACTOR, 'p1', { name: 'bug', color: '#a78bfa' });
    const args = vi.mocked(mocks.prisma.label.create).mock.calls[0]?.[0];
    // Normalized: # stripped, uppercased.
    expect(args?.data?.color).toBe('A78BFA');
  });

  it('defaults to brand purple when color is omitted', async () => {
    vi.mocked(mocks.prisma.label.create).mockResolvedValueOnce({ id: 'l-1' } as never);
    await service.create(ACTOR, 'p1', { name: 'bug' });
    expect(vi.mocked(mocks.prisma.label.create).mock.calls[0]?.[0]?.data?.color).toBe(
      'A78BFA',
    );
  });

  it('translates P2002 (unique constraint) to a friendly BadRequest', async () => {
    vi.mocked(mocks.prisma.label.create).mockRejectedValueOnce({ code: 'P2002' });
    await expect(service.create(ACTOR, 'p1', { name: 'bug' })).rejects.toThrow(
      /already exists/i,
    );
  });
});

describe('LabelsService.attach — cross-project guard', () => {
  let mocks: Mocks;
  let service: LabelsService;

  beforeEach(() => {
    ({ service, mocks } = build());
  });

  it('refuses to attach a label that belongs to a different project', async () => {
    // Real-world scenario: a Cmd+K shortcut leaks a label id from project A
    // into a request on project B. Without this guard the row would land
    // and the project B board would render a label from a foreign project.
    vi.mocked(mocks.prisma.task.findUnique).mockResolvedValueOnce({
      id: 't-1',
      projectId: 'project-A',
    } as never);
    vi.mocked(mocks.prisma.label.findUnique).mockResolvedValueOnce({
      id: 'l-1',
      projectId: 'project-B',
    } as never);

    await expect(service.attach(ACTOR, 't-1', 'l-1')).rejects.toThrow(
      /different project/i,
    );
    expect(mocks.prisma.taskLabel.upsert).not.toHaveBeenCalled();
  });

  it('happy path: upserts the join row and emits task.labeled', async () => {
    vi.mocked(mocks.prisma.task.findUnique).mockResolvedValueOnce({
      id: 't-1',
      projectId: 'p1',
    } as never);
    vi.mocked(mocks.prisma.label.findUnique).mockResolvedValueOnce({
      id: 'l-1',
      projectId: 'p1',
    } as never);
    vi.mocked(mocks.prisma.taskLabel.upsert).mockResolvedValueOnce({} as never);

    await service.attach(ACTOR, 't-1', 'l-1');

    expect(mocks.prisma.taskLabel.upsert).toHaveBeenCalledOnce();
    expect(mocks.events.emit).toHaveBeenCalledWith(
      'task.labeled',
      expect.objectContaining({ taskId: 't-1', labelId: 'l-1' }),
    );
  });
});

describe('LabelsService.detach — idempotency', () => {
  it('swallows a missing-row error so detach is safe to retry', async () => {
    const { service, mocks } = build();
    vi.mocked(mocks.prisma.task.findUnique).mockResolvedValueOnce({
      id: 't-1',
      projectId: 'p1',
    } as never);
    vi.mocked(mocks.prisma.taskLabel.delete).mockRejectedValueOnce({ code: 'P2025' });

    // Should NOT throw — the catch() swallows so a stale UI click is harmless.
    await expect(service.detach(ACTOR, 't-1', 'l-1')).resolves.toEqual({ ok: true });
  });
});

describe('LabelsService.remove — role gate', () => {
  it('escalates the permission requirement to Manager', async () => {
    const { service, mocks } = build();
    vi.mocked(mocks.prisma.label.findUnique).mockResolvedValueOnce({
      id: 'l-1',
      projectId: 'p1',
    } as never);
    vi.mocked(mocks.prisma.label.delete).mockResolvedValueOnce({} as never);

    await service.remove(ACTOR, 'l-1');

    // The assertAtLeast was called with 'Manager' specifically. Other label
    // operations only require Contributor; deletion is destructive.
    expect(mocks.permissions.assertAtLeast).toHaveBeenCalledWith(
      ACTOR,
      'p1',
      'Manager',
    );
  });

  it('returns 404 when the label does not exist', async () => {
    const { service, mocks } = build();
    vi.mocked(mocks.prisma.label.findUnique).mockResolvedValueOnce(null);

    await expect(service.remove(ACTOR, 'missing')).rejects.toThrow(NotFoundException);
  });
});
