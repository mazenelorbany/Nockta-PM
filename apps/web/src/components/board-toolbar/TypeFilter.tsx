import { useRef, useState } from 'react';
import { TypeBadge, type TaskType } from '../task-bits';
import { FilterChip } from './FilterChip';
import { FilterPopover, PopoverList, PopoverRow } from './FilterPopover';
import { TYPES } from './types';

// =============================================================================
// Type filter — Jira-style glyphs.
// =============================================================================

export function TypeFilter({
  value,
  onChange,
}: {
  value: TaskType | undefined;
  onChange: (v: TaskType | undefined) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <FilterChip
        label="Type"
        active={Boolean(value)}
        onClick={() => setOpen((o) => !o)}
        triggerRef={triggerRef}
      >
        {value && (
          <span className="flex items-center gap-1.5">
            <TypeBadge type={value} />
            <span>{value}</span>
          </span>
        )}
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
            <span className="h-4 w-4 rounded bg-muted/40" />
            <span>All types</span>
          </PopoverRow>
          {TYPES.map((t) => (
            <PopoverRow
              key={t}
              selected={value === t}
              onClick={() => {
                onChange(t);
                setOpen(false);
              }}
            >
              <TypeBadge type={t} />
              <span>{t}</span>
            </PopoverRow>
          ))}
        </PopoverList>
      </FilterPopover>
    </>
  );
}
