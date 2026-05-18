import { useDraggable } from '@dnd-kit/core';
import { Clock } from 'lucide-react';
import { cn } from '@nockta/ui';

import {
  AvatarCircle,
  BlockedBadge,
  PriorityDot,
  StatusPill,
  TypeBadge,
} from '../../components/task-bits';

import type { PlannerTask, Side } from './types';

// =============================================================================
// TaskRow — single draggable task. Click anywhere to toggle select; click the
// chevron arrow to perform the primary action (add to sprint / remove from).
// =============================================================================

export function TaskRow({
  task,
  side,
  isSelected,
  onToggleSelect,
  onPrimary,
  primaryIcon,
  primaryLabel,
}: {
  task: PlannerTask;
  side: Side;
  isSelected?: boolean;
  onToggleSelect?: () => void;
  onPrimary?: () => void;
  primaryIcon: React.ReactNode;
  primaryLabel: string;
}): JSX.Element {
  const { setNodeRef, attributes, listeners, transform, isDragging } = useDraggable({
    id: task.id,
    data: { from: side },
  });
  const style = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` }
    : undefined;
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        'group flex items-start gap-2.5 rounded-md border bg-card/60 px-3 py-2 text-xs transition',
        'hover:border-primary/40 hover:bg-card/80',
        isSelected && 'border-primary/60 bg-primary/5',
        isDragging && 'opacity-50',
      )}
    >
      {onToggleSelect && (
        <input
          type="checkbox"
          checked={isSelected ?? false}
          onClick={(e) => e.stopPropagation()}
          onChange={onToggleSelect}
          className={cn(
            'mt-0.5 h-3.5 w-3.5 cursor-pointer',
            isSelected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
          )}
          aria-label={`Select ${task.key}`}
        />
      )}
      <button
        type="button"
        {...listeners}
        {...attributes}
        className="flex-1 text-left cursor-grab active:cursor-grabbing min-w-0"
      >
        <div className="flex items-center gap-2 mb-0.5">
          <span className="font-mono text-[10px] text-muted-foreground">{task.key}</span>
          {task.type && <TypeBadge type={task.type} />}
          <PriorityDot priority={task.priority} />
          <BlockedBadge blocked={task.isBlocked} />
        </div>
        <div className="text-sm font-medium leading-snug line-clamp-2">{task.title}</div>
        <div className="mt-1.5 flex items-center gap-2 flex-wrap">
          <StatusPill status={task.status} />
          {task.labels.slice(0, 3).map((l) => (
            <span
              key={l.id}
              className="rounded px-1.5 py-0.5 text-[10px]"
              style={{ backgroundColor: `#${l.color}22`, color: `#${l.color}` }}
            >
              {l.name}
            </span>
          ))}
          {task.labels.length > 3 && (
            <span className="text-[10px] text-muted-foreground">+{task.labels.length - 3}</span>
          )}
          {task._count && task._count.subtasks > 0 && (
            <span className="text-[10px] text-muted-foreground">
              {task._count.subtasks} subtasks
            </span>
          )}
          {task.estimate !== null && (
            <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
              <Clock className="h-3 w-3" />
              {task.estimate}
            </span>
          )}
          {task.assignee && <AvatarCircle user={task.assignee} size={16} />}
        </div>
      </button>
      {onPrimary && (
        <button
          type="button"
          onClick={onPrimary}
          aria-label={primaryLabel}
          title={primaryLabel}
          className={cn(
            'shrink-0 rounded-md p-1 text-muted-foreground hover:bg-primary/10 hover:text-primary',
            'opacity-0 group-hover:opacity-100 transition-opacity',
          )}
        >
          {primaryIcon}
        </button>
      )}
    </div>
  );
}
