// -----------------------------------------------------------------------------
// Facets — return shape from /search/tasks/facets. Kept in lock-step with
// SearchService.facets server-side.
// -----------------------------------------------------------------------------

export interface FacetsResponse {
  byStatus: { status: string; count: number }[];
  byPriority: { priority: string; count: number }[];
  byType: { type: string; count: number }[];
  byProject: { projectId: string; name: string; count: number }[];
  byAssignee: { userId: string; name: string; count: number }[];
  bySprint: { sprintId: string; name: string; count: number }[];
  byLabel: { labelId: string; name: string; count: number }[];
}

/**
 * Multi-select facet state — one Set of selected values per dimension. We
 * keep them as plain Sets in component state (not URL state) because the
 * Cmd+K panel is a transient surface; tearing it down resets the picks.
 */
export interface FacetSelection {
  statuses: Set<string>;
  priorities: Set<string>;
  types: Set<string>;
  projectIds: Set<string>;
  assigneeUserIds: Set<string>;
  labelIds: Set<string>;
  sprintIds: Set<string>;
}

/**
 * Stable string representation of the facet picks for use as a React Query
 * cache key. Sets aren't structurally comparable, so we sort each dim's
 * values and concatenate.
 */
export function serializeFacets(s: FacetSelection): string {
  const join = (set: Set<string>) => Array.from(set).sort().join(',');
  return [
    `s:${join(s.statuses)}`,
    `p:${join(s.priorities)}`,
    `t:${join(s.types)}`,
    `pj:${join(s.projectIds)}`,
    `as:${join(s.assigneeUserIds)}`,
    `lb:${join(s.labelIds)}`,
    `sp:${join(s.sprintIds)}`,
  ].join('|');
}

export function emptyFacetSelection(): FacetSelection {
  return {
    statuses: new Set(),
    priorities: new Set(),
    types: new Set(),
    projectIds: new Set(),
    assigneeUserIds: new Set(),
    labelIds: new Set(),
    sprintIds: new Set(),
  };
}

export function facetSelectionIsEmpty(s: FacetSelection): boolean {
  return (
    s.statuses.size === 0 &&
    s.priorities.size === 0 &&
    s.types.size === 0 &&
    s.projectIds.size === 0 &&
    s.assigneeUserIds.size === 0 &&
    s.labelIds.size === 0 &&
    s.sprintIds.size === 0
  );
}

export function appendFacetParams(params: URLSearchParams, selection: FacetSelection): void {
  const join = (s: Set<string>) => Array.from(s).join(',');
  if (selection.statuses.size > 0) params.set('statuses', join(selection.statuses));
  if (selection.priorities.size > 0) params.set('priorities', join(selection.priorities));
  if (selection.types.size > 0) params.set('types', join(selection.types));
  if (selection.projectIds.size > 0) params.set('projectIds', join(selection.projectIds));
  if (selection.assigneeUserIds.size > 0)
    params.set('assigneeUserIds', join(selection.assigneeUserIds));
  if (selection.labelIds.size > 0) params.set('labelIds', join(selection.labelIds));
  if (selection.sprintIds.size > 0) params.set('sprintIds', join(selection.sprintIds));
}
