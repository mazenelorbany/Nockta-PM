import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SavedViewsService } from './saved-views.service';
import { makePrismaMock } from '../../test-utils/mocks';
import type { PrismaService } from '../../prisma/prisma.service';
import type { AuthenticatedUser } from '../auth/types';

// =============================================================================
// saved-views.service — per-user persisted board/list filters. The service is
// thin (it's effectively a CRUD wrapper around the savedSearch table) so each
// test pins ONE invariant: ownership scoping on reads + writes + deletes,
// trimming/whitespace validation, and the workspace-vs-project-scoped read.
//
// Note on naming: the underlying Prisma table is `savedSearch` (legacy) while
// the public-facing module is "Saved Views". The service papers over this; we
// assert on the Prisma calls because that's the contract that matters.
// =============================================================================

interface Mocks {
  prisma: PrismaService;
}

function build(): { service: SavedViewsService; mocks: Mocks } {
  const prisma = makePrismaMock();
  const service = new SavedViewsService(prisma);
  return { service, mocks: { prisma } };
}

function buildActor(overrides: Partial<AuthenticatedUser> = {}): AuthenticatedUser {
  return {
    id: 'u-1',
    email: 'a@nockta.com',
    kind: 'internal',
    companyRole: 'Member',
    ...overrides,
  } as AuthenticatedUser;
}

describe('SavedViewsService.listForUser', () => {
  let mocks: Mocks;
  let service: SavedViewsService;

  beforeEach(() => {
    ({ service, mocks } = build());
  });

  it('scopes the read to the actor (never returns another user\'s views)', async () => {
    vi.mocked(mocks.prisma.savedSearch.findMany).mockResolvedValueOnce([] as never);

    await service.listForUser(buildActor());

    const args = vi.mocked(mocks.prisma.savedSearch.findMany).mock.calls[0]?.[0];
    expect(args?.where).toEqual({ userId: 'u-1' });
    // Most-recent-first; this drives the dropdown ordering in the UI.
    expect(args?.orderBy).toEqual({ createdAt: 'desc' });
  });

  it('returns each row exactly as Prisma yields it (no extra projection)', async () => {
    const rows = [
      { id: 'sv-1', userId: 'u-1', name: 'My bugs', query: {}, createdAt: new Date() },
      { id: 'sv-2', userId: 'u-1', name: 'In Review', query: {}, createdAt: new Date() },
    ];
    vi.mocked(mocks.prisma.savedSearch.findMany).mockResolvedValueOnce(rows as never);

    const result = await service.listForUser(buildActor());

    expect(result).toHaveLength(2);
    expect(result.map((r: { id: string }) => r.id)).toEqual(['sv-1', 'sv-2']);
  });
});

describe('SavedViewsService.create — input validation', () => {
  let mocks: Mocks;
  let service: SavedViewsService;

  beforeEach(() => {
    ({ service, mocks } = build());
  });

  it('rejects an empty name (BadRequestException)', async () => {
    await expect(
      service.create(buildActor(), { name: '', query: {} }),
    ).rejects.toThrow(BadRequestException);
    expect(mocks.prisma.savedSearch.create).not.toHaveBeenCalled();
  });

  it('rejects a whitespace-only name', async () => {
    await expect(
      service.create(buildActor(), { name: '   \t  ', query: {} }),
    ).rejects.toThrow(/required/i);
    expect(mocks.prisma.savedSearch.create).not.toHaveBeenCalled();
  });

  it('trims the name before writing', async () => {
    vi.mocked(mocks.prisma.savedSearch.create).mockResolvedValueOnce({
      id: 'sv-1',
    } as never);

    await service.create(buildActor(), {
      name: '  My filter  ',
      query: { status: 'Todo' },
    });

    const args = vi.mocked(mocks.prisma.savedSearch.create).mock.calls[0]?.[0];
    expect(args?.data?.name).toBe('My filter');
    expect(args?.data?.userId).toBe('u-1');
  });
});

describe('SavedViewsService.create — workspace vs project scope', () => {
  let mocks: Mocks;
  let service: SavedViewsService;

  beforeEach(() => {
    ({ service, mocks } = build());
  });

  it('round-trips a workspace-wide view when query has no projectId', async () => {
    vi.mocked(mocks.prisma.savedSearch.create).mockResolvedValueOnce({
      id: 'sv-1',
    } as never);

    await service.create(buildActor(), {
      name: 'All my open work',
      query: { status: 'Todo', assigneeUserId: 'u-1' },
    });

    const args = vi.mocked(mocks.prisma.savedSearch.create).mock.calls[0]?.[0];
    // No projectId field anywhere → it's a workspace-wide view.
    expect(args?.data?.query).toEqual({ status: 'Todo', assigneeUserId: 'u-1' });
    expect((args?.data?.query as Record<string, unknown>)?.projectId).toBeUndefined();
  });

  it('respects the projectId in the query payload when present', async () => {
    vi.mocked(mocks.prisma.savedSearch.create).mockResolvedValueOnce({
      id: 'sv-2',
    } as never);

    await service.create(buildActor(), {
      name: 'PRJ bugs',
      query: { projectId: 'p-prj', type: 'Bug' },
    });

    const args = vi.mocked(mocks.prisma.savedSearch.create).mock.calls[0]?.[0];
    expect((args?.data?.query as Record<string, unknown>)?.projectId).toBe('p-prj');
  });
});

describe('SavedViewsService.update', () => {
  let mocks: Mocks;
  let service: SavedViewsService;

  beforeEach(() => {
    ({ service, mocks } = build());
  });

  it('throws NotFoundException for a missing id', async () => {
    vi.mocked(mocks.prisma.savedSearch.findUnique).mockResolvedValueOnce(null);

    await expect(
      service.update(buildActor(), 'sv-missing', { name: 'rename' }),
    ).rejects.toThrow(NotFoundException);
    expect(mocks.prisma.savedSearch.update).not.toHaveBeenCalled();
  });

  it('refuses when the actor is NOT the owner (ForbiddenException)', async () => {
    vi.mocked(mocks.prisma.savedSearch.findUnique).mockResolvedValueOnce({
      id: 'sv-1',
      userId: 'someone-else',
      name: 'Theirs',
      query: {},
    } as never);

    await expect(
      service.update(buildActor(), 'sv-1', { name: 'pwned' }),
    ).rejects.toThrow(ForbiddenException);
    expect(mocks.prisma.savedSearch.update).not.toHaveBeenCalled();
  });

  it('allows the owner to edit and trims the new name', async () => {
    vi.mocked(mocks.prisma.savedSearch.findUnique).mockResolvedValueOnce({
      id: 'sv-1',
      userId: 'u-1',
      name: 'Old',
      query: {},
    } as never);
    vi.mocked(mocks.prisma.savedSearch.update).mockResolvedValueOnce({
      id: 'sv-1',
    } as never);

    await service.update(buildActor(), 'sv-1', {
      name: '  New name  ',
      query: { status: 'Done' },
    });

    const args = vi.mocked(mocks.prisma.savedSearch.update).mock.calls[0]?.[0];
    expect(args?.where).toEqual({ id: 'sv-1' });
    expect(args?.data?.name).toBe('New name');
    expect(args?.data?.query).toEqual({ status: 'Done' });
  });

  it('updates only the fields that were provided (partial update)', async () => {
    vi.mocked(mocks.prisma.savedSearch.findUnique).mockResolvedValueOnce({
      id: 'sv-1',
      userId: 'u-1',
      name: 'Old',
      query: { status: 'Todo' },
    } as never);
    vi.mocked(mocks.prisma.savedSearch.update).mockResolvedValueOnce({
      id: 'sv-1',
    } as never);

    // Only `name` is supplied; query must not be overwritten with undefined.
    await service.update(buildActor(), 'sv-1', { name: 'Renamed only' });

    const args = vi.mocked(mocks.prisma.savedSearch.update).mock.calls[0]?.[0];
    expect(args?.data?.name).toBe('Renamed only');
    expect(args?.data?.query).toBeUndefined();
  });
});

describe('SavedViewsService.remove', () => {
  let mocks: Mocks;
  let service: SavedViewsService;

  beforeEach(() => {
    ({ service, mocks } = build());
  });

  it('throws NotFoundException for a missing id', async () => {
    vi.mocked(mocks.prisma.savedSearch.findUnique).mockResolvedValueOnce(null);

    await expect(service.remove(buildActor(), 'sv-missing')).rejects.toThrow(
      NotFoundException,
    );
    expect(mocks.prisma.savedSearch.delete).not.toHaveBeenCalled();
  });

  it('refuses when the actor is NOT the owner', async () => {
    vi.mocked(mocks.prisma.savedSearch.findUnique).mockResolvedValueOnce({
      id: 'sv-1',
      userId: 'someone-else',
      name: 'Theirs',
      query: {},
    } as never);

    await expect(service.remove(buildActor(), 'sv-1')).rejects.toThrow(
      ForbiddenException,
    );
    expect(mocks.prisma.savedSearch.delete).not.toHaveBeenCalled();
  });

  it('deletes the row when the actor IS the owner', async () => {
    vi.mocked(mocks.prisma.savedSearch.findUnique).mockResolvedValueOnce({
      id: 'sv-1',
      userId: 'u-1',
      name: 'Mine',
      query: {},
    } as never);
    vi.mocked(mocks.prisma.savedSearch.delete).mockResolvedValueOnce({
      id: 'sv-1',
    } as never);

    const res = await service.remove(buildActor(), 'sv-1');

    expect(res).toEqual({ ok: true });
    const args = vi.mocked(mocks.prisma.savedSearch.delete).mock.calls[0]?.[0];
    expect(args?.where).toEqual({ id: 'sv-1' });
  });
});
