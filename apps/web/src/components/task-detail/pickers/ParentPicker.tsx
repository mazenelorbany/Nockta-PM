import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../../lib/api';
import type { TaskType } from '../../task-bits';
import { usePopover } from '../utils';
import { PopoverShell, ValuePill } from './Popover';

/**
 * Parent task picker. Shows the current parent's key + title, or "No parent".
 * Click opens a search-as-you-type list of project tasks (excluding self).
 */
export function ParentPicker({
  taskId,
  projectId,
  current,
  onChange,
}: {
  taskId: string;
  projectId: string;
  current: { id: string; key?: string; title?: string; keyNumber?: number; type?: TaskType } | null;
  onChange: (id: string | null) => void;
}): JSX.Element {
  const pop = usePopover();
  const [query, setQuery] = useState('');
  const candidatesQuery = useQuery({
    queryKey: ['tasks', 'project', projectId, 'parent-picker'],
    queryFn: () =>
      api.get<Array<{ id: string; key?: string; keyNumber: number; title: string; type?: TaskType }>>(
        `/tasks/project/${projectId}`,
      ),
    enabled: pop.open,
  });
  const candidates = (candidatesQuery.data ?? [])
    .filter((t) => t.id !== taskId)
    .filter((t) =>
      query.trim() === ''
        ? true
        : `${t.key ?? `#${t.keyNumber}`} ${t.title}`.toLowerCase().includes(query.toLowerCase()),
    )
    .slice(0, 20);

  const display = current
    ? `${current.key ?? `#${current.keyNumber ?? '?'}`} · ${current.title ?? ''}`.slice(0, 40)
    : 'No parent';

  return (
    <div className="relative inline-block max-w-full">
      <ValuePill open={pop.open} onClick={pop.toggle} leading={null} muted={!current}>
        <span className="truncate">{display}</span>
      </ValuePill>
      <PopoverShell open={pop.open} onClose={pop.close} align="left" className="p-2 w-80">
        <input
          autoFocus
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search tasks…"
          className="field text-xs py-1.5 w-full"
        />
        <ul className="mt-2 max-h-60 overflow-y-auto">
          {current && (
            <li>
              <button
                type="button"
                onClick={() => {
                  onChange(null);
                  pop.close();
                }}
                className="tap w-full text-left px-2 py-1.5 text-xs text-muted-foreground hover:bg-muted/60 rounded"
              >
                — Clear parent —
              </button>
            </li>
          )}
          {candidates.map((t) => (
            <li key={t.id}>
              <button
                type="button"
                onClick={() => {
                  onChange(t.id);
                  pop.close();
                }}
                className="tap w-full flex items-center gap-2 rounded px-2 py-1.5 text-xs text-left hover:bg-muted/60"
              >
                <span className="font-mono text-[10px] text-muted-foreground shrink-0">
                  {t.key ?? `#${t.keyNumber}`}
                </span>
                <span className="truncate">{t.title}</span>
              </button>
            </li>
          ))}
          {candidates.length === 0 && (
            <li className="px-2 py-3 text-center text-xs text-muted-foreground">
              No matching tasks
            </li>
          )}
        </ul>
      </PopoverShell>
    </div>
  );
}
