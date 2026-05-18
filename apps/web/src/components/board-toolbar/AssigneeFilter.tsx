import { useMemo, useRef, useState } from 'react';
import { AvatarCircle } from '../task-bits';
import { FilterChip } from './FilterChip';
import { FilterPopover, PopoverList, PopoverRow } from './FilterPopover';
import type { ToolbarUser } from './types';

// =============================================================================
// Assignee filter — rich popover with avatars + per-person task count, plus
// "Unassigned" and "All" rows. Built on top of FilterPopover.
// =============================================================================

export function AssigneeFilter({
  value,
  users,
  unassignedCount,
  selectedUser,
  onChange,
}: {
  value: string | undefined;
  users: Array<ToolbarUser & { count: number }>;
  unassignedCount: number;
  selectedUser: ToolbarUser | null;
  onChange: (v: string | undefined) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const triggerRef = useRef<HTMLButtonElement>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return users;
    return users.filter((u) =>
      `${u.name} ${u.email ?? ''}`.toLowerCase().includes(q),
    );
  }, [users, query]);

  const isActive = Boolean(value);

  return (
    <>
      <FilterChip
        label="Assignee"
        active={isActive}
        onClick={() => setOpen((o) => !o)}
        triggerRef={triggerRef}
      >
        {value === 'unassigned' ? (
          <span className="flex items-center gap-1.5">
            <AvatarCircle user={null} size={16} />
            <span>Unassigned</span>
          </span>
        ) : selectedUser ? (
          <span className="flex items-center gap-1.5">
            <AvatarCircle user={selectedUser} size={16} />
            <span className="truncate max-w-[110px]">{selectedUser.name}</span>
          </span>
        ) : null}
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
            placeholder="Search people…"
            className="w-full h-7 rounded-md bg-secondary/60 px-2 text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring/50"
          />
        </div>
        <PopoverList>
          <PopoverRow
            selected={!value}
            onClick={() => {
              onChange(undefined);
              setOpen(false);
            }}
          >
            <span className="inline-flex items-center justify-center h-4 w-4 rounded-full bg-muted/60 text-[10px] text-muted-foreground">∅</span>
            <span className="flex-1">All assignees</span>
            <span className="text-[10px] text-muted-foreground">{users.length + (unassignedCount > 0 ? 1 : 0)}</span>
          </PopoverRow>

          {unassignedCount > 0 && (
            <PopoverRow
              selected={value === 'unassigned'}
              onClick={() => {
                onChange('unassigned');
                setOpen(false);
              }}
            >
              <AvatarCircle user={null} size={20} />
              <span className="flex-1">Unassigned</span>
              <span className="text-[10px] text-muted-foreground">{unassignedCount}</span>
            </PopoverRow>
          )}

          {filtered.length === 0 && users.length > 0 && (
            <li className="px-3 py-3 text-[11px] text-muted-foreground text-center">
              No people match "{query}"
            </li>
          )}
          {users.length === 0 && (
            <li className="px-3 py-4 text-[11px] text-muted-foreground text-center leading-relaxed">
              No one is assigned to any task in this project yet.
            </li>
          )}

          {filtered.map((u) => (
            <PopoverRow
              key={u.id}
              selected={value === u.id}
              onClick={() => {
                onChange(u.id);
                setOpen(false);
              }}
            >
              <AvatarCircle user={u} size={20} />
              <span className="flex-1 truncate">{u.name}</span>
              <span className="text-[10px] text-muted-foreground">{u.count}</span>
            </PopoverRow>
          ))}
        </PopoverList>
      </FilterPopover>
    </>
  );
}
