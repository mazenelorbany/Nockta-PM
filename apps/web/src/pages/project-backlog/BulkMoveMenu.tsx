import { Inbox, MoreHorizontal, Target } from 'lucide-react';
import { useState } from 'react';
import { cn } from '@nockta/ui';

import type { ContainerId, Sprint } from './types';

// =============================================================================
// BulkMoveMenu — "Move N selected to…" dropdown.
// =============================================================================

export function BulkMoveMenu({
  count,
  sprints,
  onMove,
  onClear,
}: {
  count: number;
  sprints: Sprint[];
  onMove: (to: ContainerId) => void;
  onClear: () => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 transition"
      >
        Move {count} selected
        <MoreHorizontal className="h-3.5 w-3.5" />
      </button>
      {open && (
        <>
          <button type="button" aria-label="Close" onClick={() => setOpen(false)} className="fixed inset-0 z-30 cursor-default bg-transparent" />
          <div className="absolute right-0 top-full z-40 mt-1 w-56 rounded-lg border border-border bg-popover shadow-xl">
            <header className="border-b border-border px-3 py-2 text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
              Move to…
            </header>
            <ul className="max-h-60 overflow-y-auto py-1">
              {sprints.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => { onMove(s.id); setOpen(false); }}
                    className="w-full px-3 py-1.5 text-left text-sm hover:bg-muted/60 flex items-center gap-2"
                  >
                    <Target className={cn('h-3.5 w-3.5', s.state === 'active' ? 'text-primary' : 'text-muted-foreground')} />
                    <span className="truncate">{s.name}</span>
                    <span className="ml-auto text-[10px] text-muted-foreground capitalize">{s.state}</span>
                  </button>
                </li>
              ))}
              <li className="border-t border-border mt-1 pt-1">
                <button
                  type="button"
                  onClick={() => { onMove('backlog'); setOpen(false); }}
                  className="w-full px-3 py-1.5 text-left text-sm hover:bg-muted/60 flex items-center gap-2"
                >
                  <Inbox className="h-3.5 w-3.5 text-muted-foreground" />
                  Backlog
                </button>
              </li>
            </ul>
            <footer className="border-t border-border p-1">
              <button
                type="button"
                onClick={() => { onClear(); setOpen(false); }}
                className="w-full px-3 py-1.5 text-left text-xs text-muted-foreground hover:bg-muted/60 rounded"
              >
                Clear selection
              </button>
            </footer>
          </div>
        </>
      )}
    </div>
  );
}
