import { useMemo, useRef, useState } from 'react';
import { FilterChip } from './FilterChip';
import { FilterPopover, PopoverList, PopoverRow } from './FilterPopover';
import type { ToolbarLabel } from './types';

// =============================================================================
// Labels filter — multi-select chip backed by filters.labelIds. Each row shows
// a colored dot keyed off the label's hex color, plus its name and usage count.
// OR semantics: a task matches if it carries any selected label.
// =============================================================================

export function LabelsFilter({
  value,
  labels,
  onChange,
}: {
  value: string[];
  labels: ToolbarLabel[];
  onChange: (ids: string[]) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const triggerRef = useRef<HTMLButtonElement>(null);
  const selectedSet = useMemo(() => new Set(value), [value]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return labels;
    return labels.filter((l) => l.name.toLowerCase().includes(q));
  }, [labels, query]);

  // Chip body summary: single label inline, multiple → "N labels".
  const summary = (() => {
    if (value.length === 0) return null;
    if (value.length === 1) {
      const l = labels.find((x) => x.id === value[0]);
      return l ? (
        <>
          <LabelDot color={l.color} />
          <span className="truncate max-w-[110px]">{l.name}</span>
        </>
      ) : (
        <span>1 label</span>
      );
    }
    return <span>{value.length} labels</span>;
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
        label="Label"
        active={value.length > 0}
        onClick={() => setOpen((o) => !o)}
        triggerRef={triggerRef}
      >
        {summary}
      </FilterChip>
      <FilterPopover
        open={open}
        onClose={() => setOpen(false)}
        triggerRef={triggerRef}
        className="w-64"
      >
        <div className="p-2 border-b border-border">
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search labels…"
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
              No labels match "{query}"
            </li>
          ) : (
            filtered.map((l) => (
              <PopoverRow
                key={l.id}
                selected={selectedSet.has(l.id)}
                onClick={() => toggle(l.id)}
              >
                <LabelDot color={l.color} />
                <span className="flex-1 truncate">{l.name}</span>
                <span className="text-[10px] font-mono text-muted-foreground">{l.count}</span>
              </PopoverRow>
            ))
          )}
        </PopoverList>
      </FilterPopover>
    </>
  );
}

/** Small inline color dot for a label — hex without the leading #. */
function LabelDot({ color }: { color: string }): JSX.Element {
  const hex = color.startsWith('#') ? color : `#${color}`;
  return (
    <span
      className="inline-block h-3 w-3 rounded-full ring-2 ring-card shrink-0"
      style={{ backgroundColor: hex }}
      aria-hidden="true"
    />
  );
}
