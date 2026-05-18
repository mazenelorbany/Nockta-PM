import { cn } from '@nockta/ui';

import {
  AvatarCircle,
  BlockedBadge,
  PriorityDot,
  StatusPill,
  TypeBadge,
} from '../../components/task-bits';

import { DateChip } from './DateChip';
import type { DragState, Task } from './types';

// Unscheduled lane — tasks missing one or both dates. Each row is draggable
// onto the gantt grid below to schedule it (the parent's pointerdown handler
// initializes a `schedule` drag).
export function UnscheduledLane({
  unscheduled,
  drag,
  onStartScheduleDrag,
  onClickRow,
  onSetDate,
}: {
  unscheduled: Task[];
  drag: DragState | null;
  onStartScheduleDrag: (e: React.PointerEvent<HTMLLIElement>, taskId: string) => void;
  onClickRow: (taskId: string) => void;
  onSetDate: (taskId: string, body: Record<string, unknown>) => void;
}): JSX.Element | null {
  if (unscheduled.length === 0) return null;
  return (
    <section className="border-b border-border bg-card/20 px-4 sm:px-6 md:px-8 py-3">
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">
        Needs scheduling ({unscheduled.length})
      </p>
      <ul className="space-y-1">
        {unscheduled.map((t) => (
          <li
            key={t.id}
            className={cn(
              'flex items-center gap-2 text-xs hover:bg-muted/40 rounded px-2 py-1 cursor-grab',
              drag?.taskId === t.id && 'opacity-50 cursor-grabbing',
            )}
            onPointerDown={(e) => onStartScheduleDrag(e, t.id)}
            onPointerUp={() => {
              // If the user clicked without dragging, open the drawer.
              if (drag && drag.taskId === t.id && !drag.moved) {
                onClickRow(t.id);
              }
            }}
            style={{ touchAction: 'none' }}
            title="Drag onto the grid below to schedule this task"
          >
            <span className="font-mono text-[10px] text-muted-foreground w-16">{t.key}</span>
            {t.type && <TypeBadge type={t.type} />}
            <PriorityDot priority={t.priority} />
            <BlockedBadge blocked={t.isBlocked} />
            <span className="flex-1 truncate">{t.title}</span>
            <StatusPill status={t.status} />
            {!t.startDate && (
              <DateChip
                task={t}
                field="startDate"
                onSet={(iso) => onSetDate(t.id, { startDate: iso })}
              />
            )}
            {!t.dueDate && (
              <DateChip
                task={t}
                field="dueDate"
                onSet={(iso) => onSetDate(t.id, { dueDate: iso })}
              />
            )}
            {t.assignee && <AvatarCircle user={t.assignee} size={16} />}
          </li>
        ))}
      </ul>
    </section>
  );
}
