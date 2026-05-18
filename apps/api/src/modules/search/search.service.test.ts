import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makePrismaMock } from '../../test-utils/mocks';
import type { PrismaService } from '../../prisma/prisma.service';
import type { AuthenticatedUser } from '../auth/types';

import type { ElasticSearchService } from './elastic-search.service';
import { SearchService } from './search.service';

// =============================================================================
// search.service — focused tests on the listSaved dedup fix (Batch A item A1)
// and the saveSearch / deleteSaved round-trip. Full searchTasks() coverage
// would require modeling Postgres FTS responses; skipped here in favor of
// the higher-signal cases.
// =============================================================================

interface Mocks {
  prisma: PrismaService;
  elastic: { enabled: ReturnType<typeof vi.fn>; search: ReturnType<typeof vi.fn> };
}

function build(): { service: SearchService; mocks: Mocks } {
  const prisma = makePrismaMock();
  const elastic = {
    enabled: vi.fn(() => false),
    search: vi.fn(),
  };
  const service = new SearchService(prisma, elastic as unknown as ElasticSearchService);
  return { service, mocks: { prisma, elastic } };
}

const ACTOR: AuthenticatedUser = {
  id: 'u-1',
  email: 'a@nockta.com',
  kind: 'internal',
  companyRole: 'Member',
} as AuthenticatedUser;

describe('SearchService.listSaved — dedup fix (Batch A item A1)', () => {
  let mocks: Mocks;
  let service: SearchService;

  beforeEach(() => {
    ({ service, mocks } = build());
  });

  it('returns each saved row exactly once (no double-read duplication)', async () => {
    // Previously this method did Promise.all([findMany, findMany]) on the
    // same `savedSearch` table and concatenated the results, so every row
    // appeared twice in the UI. The fix reads ONCE.
    const rows = [
      { id: 'sv-1', userId: 'u-1', name: 'My Bugs', query: {}, createdAt: new Date() },
      { id: 'sv-2', userId: 'u-1', name: 'In Review', query: {}, createdAt: new Date() },
    ];
    vi.mocked(mocks.prisma.savedSearch.findMany).mockResolvedValueOnce(rows as never);

    const result = await service.listSaved(ACTOR);

    expect(result).toHaveLength(2);
    expect(result.map((r: { id: string }) => r.id)).toEqual(['sv-1', 'sv-2']);
    // The savedSearch table should have been queried exactly ONCE — not
    // twice as in the bug. This is the regression guard.
    expect(mocks.prisma.savedSearch.findMany).toHaveBeenCalledOnce();
  });

  it('scopes the read to the actor', async () => {
    vi.mocked(mocks.prisma.savedSearch.findMany).mockResolvedValueOnce([] as never);

    await service.listSaved(ACTOR);

    const args = vi.mocked(mocks.prisma.savedSearch.findMany).mock.calls[0]?.[0];
    expect(args?.where).toEqual({ userId: 'u-1' });
  });
});

describe('SearchService.saveSearch / deleteSaved', () => {
  let mocks: Mocks;
  let service: SearchService;

  beforeEach(() => {
    ({ service, mocks } = build());
  });

  it('saveSearch writes a single row with the user-scoped query', async () => {
    vi.mocked(mocks.prisma.savedSearch.create).mockResolvedValueOnce({
      id: 'sv-1',
      name: 'My filter',
    } as never);

    await service.saveSearch(ACTOR, 'My filter', { q: 'bug', priority: 'High' });

    const args = vi.mocked(mocks.prisma.savedSearch.create).mock.calls[0]?.[0];
    expect(args?.data?.userId).toBe('u-1');
    expect(args?.data?.name).toBe('My filter');
    expect(args?.data?.query).toEqual({ q: 'bug', priority: 'High' });
  });

  it('deleteSaved only touches rows owned by the actor (no cross-user delete)', async () => {
    vi.mocked(mocks.prisma.savedSearch.deleteMany).mockResolvedValueOnce({
      count: 1,
    } as never);

    await service.deleteSaved(ACTOR, 'sv-1');

    const args = vi.mocked(mocks.prisma.savedSearch.deleteMany).mock.calls[0]?.[0];
    expect(args?.where).toEqual({ id: 'sv-1', userId: 'u-1' });
  });
});

// =============================================================================
// parseQuery — pulls structured filters out of free text. Happy paths first,
// then graceful-degradation cases where bad input falls back to text without
// 500ing. The grammar lives in search.service.ts above the function.
// =============================================================================

describe('SearchService.parseQuery', () => {
  let service: SearchService;

  beforeEach(() => {
    ({ service } = build());
  });

  it('extracts a bare status:open into filters and drops it from text', () => {
    const r = service.parseQuery('login bug status:open');
    expect(r.filters.status).toBe('open');
    expect(r.text).toBe('login bug');
    expect(r.parseError).toBeUndefined();
  });

  it('handles a quoted status value with whitespace', () => {
    const r = service.parseQuery('foo status:"in progress" bar');
    expect(r.filters.status).toBe('in progress');
    expect(r.text).toBe('foo bar');
  });

  it('parses assignee:me into the actor-relative form', () => {
    const r = service.parseQuery('crash assignee:me');
    expect(r.filters.assignee).toEqual({ kind: 'me' });
    expect(r.text).toBe('crash');
  });

  it('parses assignee:@email into an email filter', () => {
    const r = service.parseQuery('assignee:@alice@nockta.com retry');
    expect(r.filters.assignee).toEqual({ kind: 'email', email: 'alice@nockta.com' });
    expect(r.text).toBe('retry');
  });

  it('collects multiple label: filters into the labels array', () => {
    const r = service.parseQuery('label:bug label:"front end"');
    expect(r.filters.labels).toEqual(['bug', 'front end']);
    expect(r.text).toBe('');
  });

  it('parses priority:high|critical as multi-select priorities', () => {
    const r = service.parseQuery('priority:high|critical urgent');
    expect(r.filters.priorities).toEqual(['High', 'Critical']);
    expect(r.text).toBe('urgent');
  });

  it('parses created:>7d as a from-date roughly 7 days ago', () => {
    const before = Date.now();
    const r = service.parseQuery('created:>7d slow');
    const after = Date.now();
    const from = r.filters.dateRange?.from?.getTime();
    expect(from).toBeDefined();
    // Allow a few ms of slop — assertion is "approximately 7 days in the past".
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    expect(from!).toBeGreaterThanOrEqual(before - sevenDaysMs - 5);
    expect(from!).toBeLessThanOrEqual(after - sevenDaysMs + 5);
    expect(r.text).toBe('slow');
  });

  it('parses created:<2024-01-01 as a to-date', () => {
    const r = service.parseQuery('created:<2024-01-01');
    expect(r.filters.dateRange?.to?.toISOString().startsWith('2024-01-01')).toBe(true);
    expect(r.filters.dateRange?.from).toBeUndefined();
  });

  it('falls back to free text on garbage like created:>asdf and sets parseError', () => {
    const r = service.parseQuery('login created:>asdf');
    // The bad date filter is dropped — no dateRange recorded.
    expect(r.filters.dateRange).toBeUndefined();
    // The original garbage stays in text so the user still gets results.
    expect(r.text).toContain('created:>asdf');
    expect(r.parseError).toMatch(/created:>asdf/);
  });

  it('falls back on a malformed range like 2024-13-40', () => {
    const r = service.parseQuery('created:>2024-13-40');
    expect(r.filters.dateRange).toBeUndefined();
    expect(r.parseError).toBeDefined();
  });

  it('rejects an unknown priority value (priority:urgent) gracefully', () => {
    const r = service.parseQuery('priority:urgent');
    expect(r.filters.priorities).toBeUndefined();
    expect(r.parseError).toMatch(/priority:urgent/);
  });

  it('mixes free text + a recognized filter and an unknown token (kept in text)', () => {
    const r = service.parseQuery('payment failure status:open foo:bar');
    expect(r.filters.status).toBe('open');
    // Unknown keys ARE NOT errors — they stay in text so users can include
    // colon-bearing words ("error: timeout").
    expect(r.text).toContain('foo:bar');
    expect(r.parseError).toBeUndefined();
  });
});

// =============================================================================
// facets — aggregate counts per dimension over the FILTERED set. We mock the
// full pipeline: the initial matched-task pull, then the seven groupBys, then
// the FK-name hydration. The assertion is that counts in === counts out.
// =============================================================================

describe('SearchService.facets', () => {
  let mocks: Mocks;
  let service: SearchService;

  beforeEach(() => {
    ({ service, mocks } = build());
  });

  it('returns counts that match the filtered task set', async () => {
    // Admin path — accessibleProjectIds returns every project, project.findMany
    // is hit once for that and once during FK hydration.
    vi.mocked(mocks.prisma.project.findMany)
      .mockResolvedValueOnce([{ id: 'p-1' }] as never) // accessibleProjectIds
      .mockResolvedValueOnce([{ id: 'p-1', name: 'Project One' }] as never); // hydration

    // Three tasks survive the where clause.
    vi.mocked(mocks.prisma.task.findMany).mockResolvedValueOnce([
      { id: 't-1', projectId: 'p-1', assigneeUserId: 'u-a', sprintId: null },
      { id: 't-2', projectId: 'p-1', assigneeUserId: 'u-a', sprintId: null },
      { id: 't-3', projectId: 'p-1', assigneeUserId: 'u-b', sprintId: null },
    ] as never);

    // Stub the seven groupBys.
    vi.mocked(mocks.prisma.task.groupBy)
      .mockResolvedValueOnce([
        { status: 'Todo', _count: { _all: 2 } },
        { status: 'Done', _count: { _all: 1 } },
      ] as never)
      .mockResolvedValueOnce([
        { priority: 'High', _count: { _all: 3 } },
      ] as never)
      .mockResolvedValueOnce([
        { type: 'Task', _count: { _all: 3 } },
      ] as never)
      .mockResolvedValueOnce([
        { projectId: 'p-1', _count: { _all: 3 } },
      ] as never)
      .mockResolvedValueOnce([
        { assigneeUserId: 'u-a', _count: { _all: 2 } },
        { assigneeUserId: 'u-b', _count: { _all: 1 } },
      ] as never)
      .mockResolvedValueOnce([] as never); // bySprint — empty

    vi.mocked(mocks.prisma.taskLabel.groupBy).mockResolvedValueOnce([
      { labelId: 'l-1', _count: { _all: 2 } },
    ] as never);

    // Hydration queries.
    vi.mocked(mocks.prisma.user.findMany).mockResolvedValueOnce([
      { id: 'u-a', name: 'Alice' },
      { id: 'u-b', name: 'Bob' },
    ] as never);
    vi.mocked(mocks.prisma.sprint.findMany).mockResolvedValueOnce([] as never);
    vi.mocked(mocks.prisma.label.findMany).mockResolvedValueOnce([
      { id: 'l-1', name: 'bug' },
    ] as never);

    const result = await service.facets(
      { ...ACTOR, companyRole: 'Admin' } as never,
      { q: 'status:Todo' },
    );

    expect(result.byStatus).toEqual([
      { status: 'Todo', count: 2 },
      { status: 'Done', count: 1 },
    ]);
    expect(result.byAssignee).toEqual([
      { userId: 'u-a', name: 'Alice', count: 2 },
      { userId: 'u-b', name: 'Bob', count: 1 },
    ]);
    expect(result.byLabel).toEqual([
      { labelId: 'l-1', name: 'bug', count: 2 },
    ]);
    expect(result.byProject).toEqual([
      { projectId: 'p-1', name: 'Project One', count: 3 },
    ]);
  });

  it('returns an empty shape when the actor has no accessible projects', async () => {
    vi.mocked(mocks.prisma.project.findMany).mockResolvedValueOnce([] as never);

    const result = await service.facets(
      { ...ACTOR, companyRole: 'Admin' } as never,
      {},
    );

    expect(result.byStatus).toEqual([]);
    expect(result.byProject).toEqual([]);
    // Critically, the groupBys are NEVER called — short circuit.
    expect(mocks.prisma.task.groupBy).not.toHaveBeenCalled();
  });
});

// =============================================================================
// promoteToView / promoteToSearch — copies the query JSON across the
// SavedSearch/SavedView discriminator and wires linkedId bookkeeping. Both
// are idempotent: a replay returns the existing cross-linked row.
// =============================================================================

describe('SearchService.promoteToView (and inverse)', () => {
  let mocks: Mocks;
  let service: SearchService;

  beforeEach(() => {
    ({ service, mocks } = build());
  });

  it('creates a new SavedView row with kind:view and back-links the source', async () => {
    vi.mocked(mocks.prisma.savedSearch.findUnique).mockResolvedValueOnce({
      id: 'src-1',
      userId: 'u-1',
      name: 'My filter',
      query: { q: 'bug', priority: 'High' },
    } as never);
    vi.mocked(mocks.prisma.savedSearch.create).mockResolvedValueOnce({
      id: 'view-1',
      userId: 'u-1',
      name: 'My filter',
      query: { q: 'bug', priority: 'High', kind: 'view', linkedId: 'src-1' },
    } as never);
    vi.mocked(mocks.prisma.savedSearch.update).mockResolvedValueOnce({} as never);

    const result = await service.promoteToView(ACTOR, 'src-1');

    expect(result.id).toBe('view-1');
    const createArgs = vi.mocked(mocks.prisma.savedSearch.create).mock.calls[0]?.[0];
    expect(createArgs?.data?.userId).toBe('u-1');
    expect(createArgs?.data?.name).toBe('My filter');
    expect(createArgs?.data?.query).toMatchObject({
      q: 'bug',
      priority: 'High',
      kind: 'view',
      linkedId: 'src-1',
    });
    // Source was patched to point at the new view.
    const updateArgs = vi.mocked(mocks.prisma.savedSearch.update).mock.calls[0]?.[0];
    expect(updateArgs?.where).toEqual({ id: 'src-1' });
    expect(updateArgs?.data?.query).toMatchObject({ kind: 'search', linkedId: 'view-1' });
  });

  it('is idempotent — promoting an already-linked SavedSearch returns the existing view', async () => {
    vi.mocked(mocks.prisma.savedSearch.findUnique)
      .mockResolvedValueOnce({
        id: 'src-1',
        userId: 'u-1',
        name: 'My filter',
        // Already cross-linked to view-existing.
        query: { q: 'bug', kind: 'search', linkedId: 'view-existing' },
      } as never)
      .mockResolvedValueOnce({
        id: 'view-existing',
        userId: 'u-1',
        name: 'My filter',
        query: { q: 'bug', kind: 'view', linkedId: 'src-1' },
      } as never);

    const result = await service.promoteToView(ACTOR, 'src-1');

    expect(result.id).toBe('view-existing');
    // Critically, NO new row was created and the source was NOT re-patched.
    expect(mocks.prisma.savedSearch.create).not.toHaveBeenCalled();
    expect(mocks.prisma.savedSearch.update).not.toHaveBeenCalled();
  });

  it('refuses to promote another user\'s saved row', async () => {
    vi.mocked(mocks.prisma.savedSearch.findUnique).mockResolvedValueOnce({
      id: 'src-1',
      userId: 'someone-else',
      name: 'Theirs',
      query: {},
    } as never);

    await expect(service.promoteToView(ACTOR, 'src-1')).rejects.toThrow(/not your/i);
    expect(mocks.prisma.savedSearch.create).not.toHaveBeenCalled();
  });
});
