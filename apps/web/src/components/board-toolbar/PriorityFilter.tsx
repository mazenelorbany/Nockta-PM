import { useRef, useState } from 'react';

import { PriorityDot, type Priority } from '../task-bits';

import { FilterChip } from './FilterChip';
import { FilterPopover, PopoverList, PopoverRow } from './FilterPopover';
import { PRIORITIES } from './types';

// =============================================================================
// Priority filter — colored dots + ranks. Cleaner than a four-option dropdown.
// =============================================================================

export function PriorityFilter({
  value,
  onChange,
}: {
  value: Priority | undefined;
  onChange: (v: Priority | undefined) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <FilterChip
        label="Priority"
        active={Boolean(value)}
        onClick={() => setOpen((o) => !o)}
        triggerRef={triggerRef}
      >
        {value && (
          <span className="flex items-center gap-1.5">
            <PriorityDot priority={value} />
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
            <span className="h-2 w-2 rounded-full bg-muted-foreground/40 ring-2 ring-card" />
            <span>All priorities</span>
          </PopoverRow>
          {PRIORITIES.map((p) => (
            <PopoverRow
              key={p}
              selected={value === p}
              onClick={() => {
                onChange(p);
                setOpen(false);
              }}
            >
              <PriorityDot priority={p} />
              <span>{p}</span>
            </PopoverRow>
          ))}
        </PopoverList>
      </FilterPopover>
    </>
  );
}
