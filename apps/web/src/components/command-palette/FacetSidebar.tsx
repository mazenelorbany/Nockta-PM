import { FacetGroup } from './FacetGroup';
import type { FacetSelection, FacetsResponse } from './facets';

/* -----------------------------------------------------------------------------
 * Facet sidebar — multi-select checkboxes grouped by dimension. Each
 * dimension shows up to N entries (server returns 200 max); the UI cap is
 * tighter so the panel doesn't dominate. Counts come from the server's
 * groupBy aggregates over the SAME filtered set the results list uses.
 * -------------------------------------------------------------------------- */

export function FacetSidebar({
  facets,
  selection,
  onToggle,
  loading,
}: {
  facets: FacetsResponse | null;
  selection: FacetSelection;
  onToggle: (dim: keyof FacetSelection, value: string) => void;
  loading: boolean;
}): JSX.Element {
  if (loading && !facets) {
    return <div className="text-muted-foreground">Loading facets…</div>;
  }
  if (!facets) {
    return <div className="text-muted-foreground">Type a query to see facets.</div>;
  }
  return (
    <div className="space-y-4">
      <FacetGroup
        title="Status"
        entries={facets.byStatus.map((s) => ({ value: s.status, label: s.status, count: s.count }))}
        selected={selection.statuses}
        onToggle={(v) => onToggle('statuses', v)}
      />
      <FacetGroup
        title="Priority"
        entries={facets.byPriority.map((p) => ({ value: p.priority, label: p.priority, count: p.count }))}
        selected={selection.priorities}
        onToggle={(v) => onToggle('priorities', v)}
      />
      <FacetGroup
        title="Type"
        entries={facets.byType.map((t) => ({ value: t.type, label: t.type, count: t.count }))}
        selected={selection.types}
        onToggle={(v) => onToggle('types', v)}
      />
      <FacetGroup
        title="Project"
        entries={facets.byProject.map((p) => ({ value: p.projectId, label: p.name, count: p.count }))}
        selected={selection.projectIds}
        onToggle={(v) => onToggle('projectIds', v)}
      />
      <FacetGroup
        title="Assignee"
        entries={facets.byAssignee.map((a) => ({ value: a.userId, label: a.name, count: a.count }))}
        selected={selection.assigneeUserIds}
        onToggle={(v) => onToggle('assigneeUserIds', v)}
      />
      <FacetGroup
        title="Label"
        entries={facets.byLabel.map((l) => ({ value: l.labelId, label: l.name, count: l.count }))}
        selected={selection.labelIds}
        onToggle={(v) => onToggle('labelIds', v)}
      />
      <FacetGroup
        title="Sprint"
        entries={facets.bySprint.map((s) => ({ value: s.sprintId, label: s.name, count: s.count }))}
        selected={selection.sprintIds}
        onToggle={(v) => onToggle('sprintIds', v)}
      />
    </div>
  );
}
