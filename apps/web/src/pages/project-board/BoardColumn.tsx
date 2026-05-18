import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { useRef } from 'react';
import { StatusPill } from '../../components/task-bits';
import {
  ESTIMATED_CARD_HEIGHT,
  useVirtualizer,
  VIRTUALIZE_THRESHOLD,
} from '../../lib/virtualizer';
import { BoardCard } from './BoardCard';
import type { Task } from './types';

export function BoardColumn({
  status,
  tasks,
  subtasksByParent,
  selectedIds,
  onToggleSelect,
  onAdd,
  onOpen,
  isMobile,
  onSwipeAction,
  canEdit,
}: {
  status: string;
  tasks: Task[];
  subtasksByParent: Map<string, Task[]>;
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  onAdd: () => void;
  onOpen: (id: string) => void;
  isMobile: boolean;
  onSwipeAction: (taskId: string, action: 'done' | 'snooze') => void;
  canEdit: boolean;
}): JSX.Element {
  // Register the column body as a drop target so dropping anywhere in the
  // column (not just onto a task) triggers a status change. Without this,
  // @dnd-kit only sees the per-task Sortable drops.
  const { setNodeRef, isOver } = useDroppable({ id: `col:${status}` });

  // Virtualization — only kicks in when there are more than 50 cards in a
  // single column. Below the threshold the cost of the offset / total-size
  // math isn't worth it (and breaks the auto-stagger of the entry animation).
  // The scroll container is the column body itself (`scrollRef`).
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const shouldVirtualize = tasks.length > VIRTUALIZE_THRESHOLD;
  const virtualizer = useVirtualizer({
    count: shouldVirtualize ? tasks.length : 0,
    estimateSize: () => ESTIMATED_CARD_HEIGHT,
    getScrollElement: () => scrollRef.current,
    overscan: 5,
  });

  // Compose the dnd-kit droppable ref with our local scroll ref so both
  // systems see the same node.
  const composeRef = (node: HTMLDivElement | null): void => {
    setNodeRef(node);
    scrollRef.current = node;
  };

  return (
    <div className="rounded-lg bg-secondary/30 flex flex-col">
      <div className="px-3 py-2.5 flex items-center justify-between border-b border-border">
        <div className="flex items-center gap-2">
          <StatusPill status={status} />
          <span className="text-xs text-muted-foreground font-mono">{tasks.length}</span>
        </div>
        {canEdit && (
          <button
            type="button"
            onClick={onAdd}
            aria-label={`Add task to ${status}`}
            className="tap rounded p-1 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          >
            <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
        )}
      </div>
      <SortableContext items={tasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
        <div
          ref={composeRef}
          className="board-column-body p-2 flex-1 min-h-[200px] rounded-b-lg overflow-y-auto"
          data-status={status}
          data-over={isOver ? 'true' : 'false'}
        >
          {shouldVirtualize ? (
            // Spacer div claims the total list height so the scrollbar reflects
            // the full collection; absolute-positioned cards float inside.
            <div
              style={{ height: virtualizer.getTotalSize(), position: 'relative' }}
              data-virtualized="true"
            >
              {virtualizer.getVirtualItems().map((v) => {
                const t = tasks[v.index];
                if (!t) return null;
                return (
                  <div
                    key={t.id}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      right: 0,
                      transform: `translateY(${v.start}px)`,
                      padding: '0 0 8px 0',
                    }}
                  >
                    <BoardCard
                      task={t}
                      subtasks={subtasksByParent.get(t.id) ?? []}
                      selected={selectedIds.has(t.id)}
                      onToggleSelect={() => onToggleSelect(t.id)}
                      onOpen={() => onOpen(t.id)}
                      isMobile={isMobile}
                      onSwipeAction={onSwipeAction}
                    />
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="space-y-2">
              {tasks.map((t) => (
                <BoardCard
                  key={t.id}
                  task={t}
                  subtasks={subtasksByParent.get(t.id) ?? []}
                  selected={selectedIds.has(t.id)}
                  onToggleSelect={() => onToggleSelect(t.id)}
                  onOpen={() => onOpen(t.id)}
                  isMobile={isMobile}
                  onSwipeAction={onSwipeAction}
                />
              ))}
              <button
                type="button"
                onClick={onAdd}
                className="tap w-full text-left text-xs text-muted-foreground hover:text-foreground hover:bg-accent/50 rounded-md px-2 py-1.5 transition-colors"
              >
                + Add task
              </button>
            </div>
          )}
        </div>
      </SortableContext>
    </div>
  );
}
