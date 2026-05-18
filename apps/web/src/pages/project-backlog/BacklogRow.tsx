import { useDraggable } from '@dnd-kit/core';
import { Clock, GripVertical } from 'lucide-react';
import { cn } from '@nockta/ui';
import {
  AvatarCircle,
  BlockedBadge,
  PriorityDot,
  StatusPill,
  TypeBadge,
} from '../../components/task-bits';
import type { ContainerId, PlannerTask } from './types';

// =============================================================================
// BacklogRow — compact, single-line draggable task row.
// =============================================================================

export function BacklogRow({
  task,
  from,
  isSelected,
  onToggleSelect,
  onOpen,
}: {
  task: PlannerTask;
  from: ContainerId;
  isSelected: boolean;
  onToggleSelect: () => void;
  onOpen: () => void;
}): JSX.Element {
  const { setNodeRef, attributes, listeners, transform, isDragging } = useDraggable({
    id: task.id,
    data: { from },
  });
  const style = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` }
    : undefined;
  return (
    <div
      ref={setNodeRef}
      style={style}
      {...listeners}
      {...attributes}
      className={cn(
        'group grid grid-cols-[16px_20px_60px_80px_1fr_auto] gap-2 items-center rounded-md px-2 py-1.5 text-xs transition',
        'hover:bg-accent/40 cursor-grab active:cursor-grabbing',
        isSelected && 'bg-primary/5 hover:bg-primary/10',
        isDragging && 'opacity-50',
      )}
    >
      {/* Drag-handle affordance: an explicit grip icon so users know the row
          is draggable. The whole row carries the listeners; this icon is just
          visual signal. */}
      <GripVertical
        className="h-3 w-3 text-muted-foreground/40 opacity-0 group-hover:opacity-100 transition-opacity"
        aria-hidden="true"
      />
      <input
        type="checkbox"
        checked={isSelected}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
        onChange={onToggleSelect}
        className={cn(
          'h-3.5 w-3.5 cursor-pointer',
          isSelected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
        )}
        aria-label={`Select ${task.key}`}
      />
      <span className="font-mono text-[10px] text-muted-foreground truncate">
        {task.key}
      </span>
      <div className="flex items-center gap-1.5 min-w-0">
        {task.type && <TypeBadge type={task.type} />}
        <PriorityDot priority={task.priority} />
        <BlockedBadge blocked={task.isBlocked} />
      </div>
      <button
        type="button"
        onClick={onOpen}
        className="text-sm font-medium truncate text-left hover:underline"
        title={task.title}
      >
        {task.title}
      </button>
      <div className="flex items-center gap-2 justify-end">
        <StatusPill status={task.status} />
        {task.labels.slice(0, 2).map((l) => (
          <span
            key={l.id}
            className="rounded px-1.5 py-0.5 text-[10px]"
            style={{ backgroundColor: `#${l.color}22`, color: `#${l.color}` }}
          >
            {l.name}
          </span>
        ))}
        {task.labels.length > 2 && (
          <span className="text-[10px] text-muted-foreground">+{task.labels.length - 2}</span>
        )}
        {task.estimate !== null && (
          <span className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground tabular-nums">
            <Clock className="h-3 w-3" /> {task.estimate}
          </span>
        )}
        {task.assignee ? (
          <AvatarCircle user={task.assignee} size={20} />
        ) : (
          <span className="h-5 w-5 rounded-full border border-dashed border-border" title="Unassigned" />
        )}
      </div>
    </div>
  );
}
