import { useMemo, useRef, useState } from 'react';

import { FilterChip } from './FilterChip';
import { FilterPopover, PopoverList, PopoverRow } from './FilterPopover';
import type { ToolbarProject } from './types';

// =============================================================================
// Projects filter — multi-select popover with project gradient badges. Backs
// filters.projectIds on workspace-scope boards (e.g. /board). Selecting more
// than one project ORs them; selecting zero means "no project filter" which
// the parent interprets as "everything the caller passed in".
// =============================================================================

export function ProjectsFilter({
  value,
  projects,
  onChange,
}: {
  value: string[];
  projects: ToolbarProject[];
  onChange: (ids: string[]) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const triggerRef = useRef<HTMLButtonElement>(null);
  const selectedSet = useMemo(() => new Set(value), [value]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return projects;
    return projects.filter(
      (p) => p.name.toLowerCase().includes(q) || p.key.toLowerCase().includes(q),
    );
  }, [projects, query]);

  // Compact summary in the chip body. Show the single project's key when only
  // one is selected; otherwise show "N projects".
  const summary = (() => {
    if (value.length === 0) return null;
    if (value.length === 1) {
      const p = projects.find((x) => x.id === value[0]);
      return p ? p.key : '1 project';
    }
    return `${value.length} projects`;
  })();

  function toggle(id: string): void {
    if (selectedSet.has(id)) {
      onChange(value.filter((x) => x !== id));
    } else {
      onChange([...value, id]);
    }
  }

  return (
    <>
      <FilterChip
        label="Project"
        active={value.length > 0}
        onClick={() => setOpen((o) => !o)}
        triggerRef={triggerRef}
      >
        {summary && <span className="truncate max-w-[110px]">{summary}</span>}
      </FilterChip>
      <FilterPopover
        open={open}
        onClose={() => setOpen(false)}
        triggerRef={triggerRef}
        className="w-72"
      >
        <div className="p-2 border-b border-border">
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search projects…"
            className="w-full h-7 rounded-md bg-secondary/60 px-2 text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring/50"
          />
        </div>
        <PopoverList>
          {value.length > 0 && (
            <PopoverRow onClick={() => onChange([])}>
              <span className="inline-flex items-center justify-center h-4 w-4 rounded-full bg-muted/60 text-[10px] text-muted-foreground">∅</span>
              <span className="flex-1">Clear selection</span>
            </PopoverRow>
          )}
          {filtered.length === 0 ? (
            <li className="px-3 py-3 text-[11px] text-muted-foreground text-center">
              No projects match "{query}"
            </li>
          ) : (
            filtered.map((p) => {
              const checked = selectedSet.has(p.id);
              return (
                <PopoverRow
                  key={p.id}
                  selected={checked}
                  onClick={() => toggle(p.id)}
                >
                  <ProjectBadge projectKey={p.key} size={20} />
                  <span className="flex-1 truncate">{p.name}</span>
                  <span className="text-[10px] font-mono text-muted-foreground">{p.key}</span>
                </PopoverRow>
              );
            })
          )}
        </PopoverList>
      </FilterPopover>
    </>
  );
}

/**
 * Small inline project badge — deterministic gradient seeded by the project
 * key, mirrors the one used in the sidebar so the same project reads the same
 * everywhere in the UI.
 */
function ProjectBadge({ projectKey, size = 22 }: { projectKey: string; size?: number }): JSX.Element {
  let h = 5381;
  for (let i = 0; i < projectKey.length; i++) h = ((h << 5) + h + projectKey.charCodeAt(i)) | 0;
  const hue = Math.abs(h) % 360;
  return (
    <span
      className="inline-flex items-center justify-center rounded-md font-mono font-bold tracking-tight text-white shrink-0"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.4,
        background: `linear-gradient(135deg, hsl(${hue}, 75%, 58%), hsl(${(hue + 28) % 360}, 70%, 48%))`,
      }}
    >
      {projectKey.slice(0, 2)}
    </span>
  );
}
