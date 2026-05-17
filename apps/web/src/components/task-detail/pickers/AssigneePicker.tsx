import { useState } from 'react';
import { AvatarCircle } from '../../task-bits';
import type { User } from '../types';
import { usePopover } from '../utils';
import { PopoverItem, PopoverList, PopoverShell, ValuePill } from './Popover';

export function AssigneePicker({
  current,
  users,
  onChange,
}: {
  current: User | null;
  users: User[];
  onChange: (id: string | null) => void;
}): JSX.Element {
  const pop = usePopover();
  const [filter, setFilter] = useState('');
  const filtered = users.filter((u) =>
    `${u.name ?? ''} ${u.email}`.toLowerCase().includes(filter.toLowerCase()),
  );
  return (
    <div className="relative inline-block">
      <ValuePill
        open={pop.open}
        onClick={pop.toggle}
        leading={<AvatarCircle user={current} size={18} />}
        muted={!current}
      >
        {current ? (current.name || current.email) : 'Unassigned'}
      </ValuePill>
      <PopoverShell open={pop.open} onClose={pop.close} align="left" className="w-72">
        <div className="p-2 border-b border-border">
          <input
            autoFocus
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Search people"
            className="field text-xs py-1.5"
          />
        </div>
        <PopoverList maxHeight="max-h-64">
          <PopoverItem
            selected={!current}
            onClick={() => {
              if (current) onChange(null);
              pop.close();
            }}
          >
            <AvatarCircle user={null} size={18} />
            <span className="text-muted-foreground">Unassigned</span>
          </PopoverItem>
          {filtered.map((u) => (
            <PopoverItem
              key={u.id}
              selected={u.id === current?.id}
              onClick={() => {
                if (u.id !== current?.id) onChange(u.id);
                pop.close();
              }}
            >
              <AvatarCircle user={u} size={18} />
              <span className="flex-1 min-w-0 truncate text-foreground/90">
                {u.name || u.email}
              </span>
            </PopoverItem>
          ))}
          {filtered.length === 0 && (
            <li className="px-3 py-3 text-xs text-muted-foreground text-center">
              No people match
            </li>
          )}
        </PopoverList>
      </PopoverShell>
    </div>
  );
}
