import { describe, expect, it } from 'vitest';

import {
  appendFacetParams,
  emptyFacetSelection,
  facetSelectionIsEmpty,
  serializeFacets,
  type FacetSelection,
} from './facets';

// =============================================================================
// facets.ts — selection-state helpers for the Cmd+K facet sidebar. These are
// the keys we pass to React Query and to the search URL, so a stable
// serialization is load-bearing: any non-determinism leaks into the cache
// key and we'd refetch on every keystroke.
// =============================================================================

function select(partial: Partial<Record<keyof FacetSelection, string[]>>): FacetSelection {
  const s = emptyFacetSelection();
  if (partial.statuses) s.statuses = new Set(partial.statuses);
  if (partial.priorities) s.priorities = new Set(partial.priorities);
  if (partial.types) s.types = new Set(partial.types);
  if (partial.projectIds) s.projectIds = new Set(partial.projectIds);
  if (partial.assigneeUserIds) s.assigneeUserIds = new Set(partial.assigneeUserIds);
  if (partial.labelIds) s.labelIds = new Set(partial.labelIds);
  if (partial.sprintIds) s.sprintIds = new Set(partial.sprintIds);
  return s;
}

describe('emptyFacetSelection', () => {
  it('returns all-empty Sets', () => {
    const s = emptyFacetSelection();
    expect(facetSelectionIsEmpty(s)).toBe(true);
    expect(s.statuses.size).toBe(0);
    expect(s.labelIds.size).toBe(0);
  });
});

describe('facetSelectionIsEmpty', () => {
  it('is true only when EVERY dim is empty', () => {
    expect(facetSelectionIsEmpty(emptyFacetSelection())).toBe(true);
    expect(facetSelectionIsEmpty(select({ statuses: ['open'] }))).toBe(false);
    expect(facetSelectionIsEmpty(select({ priorities: ['p1'] }))).toBe(false);
    expect(facetSelectionIsEmpty(select({ labelIds: ['l1'] }))).toBe(false);
  });
});

describe('serializeFacets — order-independent cache key', () => {
  it('emits the canonical empty key', () => {
    expect(serializeFacets(emptyFacetSelection())).toBe('s:|p:|t:|pj:|as:|lb:|sp:');
  });

  it('sorts values within each dimension so insert order does not matter', () => {
    const a = select({ statuses: ['b', 'a', 'c'] });
    const b = select({ statuses: ['c', 'a', 'b'] });
    expect(serializeFacets(a)).toBe(serializeFacets(b));
    // And the actual key shows them sorted.
    expect(serializeFacets(a)).toContain('s:a,b,c');
  });

  it('preserves dimension order — status, priority, type, project, assignee, label, sprint', () => {
    const s = select({
      statuses: ['Open'],
      priorities: ['High'],
      types: ['Bug'],
      projectIds: ['proj-1'],
      assigneeUserIds: ['u-1'],
      labelIds: ['lab-1'],
      sprintIds: ['spr-1'],
    });
    expect(serializeFacets(s)).toBe(
      's:Open|p:High|t:Bug|pj:proj-1|as:u-1|lb:lab-1|sp:spr-1',
    );
  });
});

describe('appendFacetParams', () => {
  it('skips empty dimensions entirely (so the URL stays short)', () => {
    const params = new URLSearchParams();
    appendFacetParams(params, emptyFacetSelection());
    expect(params.toString()).toBe('');
  });

  it('joins non-empty Sets with commas and only writes the populated dims', () => {
    const params = new URLSearchParams();
    appendFacetParams(
      params,
      select({ statuses: ['open', 'in-progress'], labelIds: ['l1'] }),
    );
    // Order between dims is whatever URLSearchParams gives us; check pairs.
    expect(params.get('statuses')?.split(',').sort()).toEqual(['in-progress', 'open']);
    expect(params.get('labelIds')).toBe('l1');
    expect(params.has('priorities')).toBe(false);
    expect(params.has('types')).toBe(false);
  });

  it('uses the API-expected param names (statuses, priorities, projectIds, assigneeUserIds, ...)', () => {
    const params = new URLSearchParams();
    appendFacetParams(
      params,
      select({
        priorities: ['High'],
        types: ['Bug'],
        projectIds: ['p1'],
        assigneeUserIds: ['u1'],
        sprintIds: ['s1'],
      }),
    );
    expect([...params.keys()].sort()).toEqual([
      'assigneeUserIds',
      'priorities',
      'projectIds',
      'sprintIds',
      'types',
    ]);
  });
});
