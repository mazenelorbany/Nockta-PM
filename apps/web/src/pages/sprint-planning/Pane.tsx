import { useDroppable } from '@dnd-kit/core';
import { Plus } from 'lucide-react';
import { Link } from 'react-router-dom';
import { cn } from '@nockta/ui';

// =============================================================================
// Pane — a droppable column with header + scrollable list.
// =============================================================================

export function Pane({
  id,
  title,
  icon,
  count,
  empty,
  highlight,
  summary,
  onCreateHref,
  children,
}: {
  id: string;
  title: string;
  icon: React.ReactNode;
  count: number;
  empty: string;
  highlight?: boolean;
  summary?: React.ReactNode;
  onCreateHref?: string;
  children: React.ReactNode;
}): JSX.Element {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <section
      ref={setNodeRef}
      className={cn(
        'flex flex-col min-h-0 transition-colors',
        (highlight || isOver) && 'bg-primary/5'
      )}
    >
      <header className="px-5 py-3 border-b border-border bg-card/40 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          {icon}
          <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
          <span className="text-[11px] text-muted-foreground">{count}</span>
        </div>
        {onCreateHref && (
          <Link
            to={onCreateHref}
            className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
          >
            <Plus className="h-3 w-3" /> New
          </Link>
        )}
      </header>
      {summary && <div className="px-5 py-2 border-b border-border bg-card/20">{summary}</div>}
      <div className="flex-1 overflow-y-auto p-3 space-y-1.5">
        {count === 0 ? (
          <p className="text-center text-xs text-muted-foreground py-12 px-4">{empty}</p>
        ) : (
          children
        )}
      </div>
    </section>
  );
}
