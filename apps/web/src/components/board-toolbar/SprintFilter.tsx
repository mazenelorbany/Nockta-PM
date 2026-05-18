import { useRef, useState } from 'react';
import { cn } from '@nockta/ui';
import { FilterChip } from './FilterChip';
import { FilterPopover, PopoverList, PopoverRow } from './FilterPopover';
import type { Sprint } from './types';

// =============================================================================
// Sprint filter.
// =============================================================================

export function SprintFilter({
  value,
  sprints,
  selectedSprint,
  onChange,
}: {
  value: string | 'backlog' | undefined;
  sprints: Sprint[];
  selectedSprint: Sprint | null;
  onChange: (v: string | 'backlog' | undefined) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <FilterChip
        label="Sprint"
        active={Boolean(value)}
        onClick={() => setOpen((o) => !o)}
        triggerRef={triggerRef}
      >
        {value === 'backlog' ? (
          <span>Backlog</span>
        ) : selectedSprint ? (
          <span className="truncate max-w-[110px]">{selectedSprint.name}</span>
        ) : null}
      </FilterChip>
      <FilterPopover
        open={open}
        onClose={() => setOpen(false)}
        triggerRef={triggerRef}
      >
        <PopoverList>
          <PopoverRow
            selected={!value}
            onClick={() => {
              onChange(undefined);
              setOpen(false);
            }}
          >
            <span>All sprints</span>
          </PopoverRow>
          <PopoverRow
            selected={value === 'backlog'}
            onClick={() => {
              onChange('backlog');
              setOpen(false);
            }}
          >
            <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/60" />
            <span>Backlog (no sprint)</span>
          </PopoverRow>
          {sprints.map((s) => (
            <PopoverRow
              key={s.id}
              selected={value === s.id}
              onClick={() => {
                onChange(s.id);
                setOpen(false);
              }}
            >
              <span
                className={cn(
                  'h-1.5 w-1.5 rounded-full',
                  s.state === 'active' && 'bg-emerald-400',
                  s.state === 'planned' && 'bg-amber-400',
                  s.state === 'completed' && 'bg-muted-foreground/40',
                )}
              />
              <span className="flex-1 truncate">{s.name}</span>
              <span className="text-[10px] text-muted-foreground uppercase tracking-wide">{s.state}</span>
            </PopoverRow>
          ))}
        </PopoverList>
      </FilterPopover>
    </>
  );
}
