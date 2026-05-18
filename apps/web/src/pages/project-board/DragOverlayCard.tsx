import {
  AvatarCircle,
  BlockedBadge,
  DueDateChip,
  PriorityDot,
} from '../../components/task-bits';

import type { Priority, Task } from './types';

/**
 * DragOverlayCard — visual-only snapshot of a BoardCard rendered into the
 * dnd-kit DragOverlay portal. No sortable hooks, no swipe handlers, no
 * checkbox; just the look. Mirrors BoardCard's outer chrome (border, padding,
 * shadow) so the floating element matches what the user grabbed.
 *
 * We bump the shadow + add a slight rotate so the card visibly "lifts" off
 * the board the way Jira / Linear do.
 */
export function DragOverlayCard({ task }: { task: Task }): JSX.Element {
  return (
    <div
      className="board-card relative rounded-md border bg-card p-3 shadow-2xl ring-1 ring-primary/20 border-border cursor-grabbing"
      style={{ transform: 'rotate(2deg)', width: 280 }}
    >
      <div className="flex items-start gap-2 mb-2">
        <span className="text-[10px] font-mono text-muted-foreground">{task.key}</span>
        {task.priority && <PriorityDot priority={task.priority as Priority} />}
        {task.isBlocked && <BlockedBadge blocked />}
      </div>
      <div className="text-sm font-medium leading-snug line-clamp-3">{task.title}</div>
      {(task.dueDate || task.assignee) && (
        <div className="mt-2 flex items-center justify-between gap-2">
          {task.dueDate ? <DueDateChip dueDate={task.dueDate} /> : <span />}
          {task.assignee && <AvatarCircle user={task.assignee} size={20} />}
        </div>
      )}
    </div>
  );
}
