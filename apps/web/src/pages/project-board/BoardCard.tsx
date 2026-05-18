import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { CheckCircle2, Clock } from 'lucide-react';
import { useRef, useState } from 'react';
import { cn } from '@nockta/ui';

import {
  AtRiskBadge,
  AvatarCircle,
  BlockedBadge,
  DueDateChip,
  PriorityDot,
  StatusPill,
  TypeBadge,
} from '../../components/task-bits';
import { isHorizontalDominant } from '../../hooks/useSwipeGesture';

import type { CustomFieldValue, Task } from './types';

/**
 * Renders up to 2 custom-field chips on a board card. Sorted by `position`
 * so the user-defined order is respected. Skips fields whose value is empty.
 */
function CustomFieldChips({ values }: { values: CustomFieldValue[] }): JSX.Element | null {
  const visible = [...values]
    .sort((a, b) => a.field.position - b.field.position)
    .filter((v) => !isEmptyFieldValue(v))
    .slice(0, 2);
  if (visible.length === 0) return null;
  return (
    <div className="mt-1.5 flex items-center gap-1.5 flex-wrap">
      {visible.map((v) => (
        <span
          key={v.id}
          title={v.field.name}
          className="inline-flex items-center gap-1 rounded bg-secondary/60 px-1.5 py-0.5 text-[10px] text-muted-foreground"
        >
          <span className="font-medium text-foreground/80">{v.field.name}:</span>
          <span>{formatFieldValue(v)}</span>
        </span>
      ))}
    </div>
  );
}

function isEmptyFieldValue(v: CustomFieldValue): boolean {
  const val = v.value;
  if (val === null || val === undefined || val === '') return true;
  if (Array.isArray(val) && val.length === 0) return true;
  return false;
}

function formatFieldValue(v: CustomFieldValue): string {
  const val = v.value;
  switch (v.field.kind) {
    case 'select': {
      const opt = v.field.options.find((o) => o.value === val);
      return opt?.label ?? String(val);
    }
    case 'multiselect': {
      if (!Array.isArray(val)) return '';
      return (val as string[])
        .map((id) => v.field.options.find((o) => o.value === id)?.label ?? id)
        .join(', ');
    }
    case 'checkbox':
      return val ? '✓' : '·';
    case 'date':
      return typeof val === 'string' ? new Date(val).toLocaleDateString() : '';
    case 'number':
      return String(val);
    case 'url':
      try {
        return new URL(String(val)).host;
      } catch {
        return String(val);
      }
    default:
      return String(val).slice(0, 40);
  }
}

export function BoardCard({
  task,
  subtasks,
  selected,
  onToggleSelect,
  onOpen,
  isMobile,
  onSwipeAction,
}: {
  task: Task;
  subtasks: Task[];
  selected: boolean;
  onToggleSelect: () => void;
  onOpen: () => void;
  isMobile: boolean;
  onSwipeAction: (taskId: string, action: 'done' | 'snooze') => void;
}): JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: task.id });
  const style = { transform: CSS.Transform.toString(transform), transition };
  const [subtasksOpen, setSubtasksOpen] = useState(false);
  const subtaskCount = subtasks.length;
  const subtasksDone = subtasks.filter((s) => s.status.toLowerCase() === 'done' || s.status === 'Approved').length;

  // -------------------------------------------------------------------------
  // Swipe-to-complete / snooze — mobile only.
  //
  // The card is draggable both by dnd-kit (for column moves) and by our own
  // pointer handlers (for swipe gestures). We resolve the conflict on the fly:
  // once we've moved >= 5px, we look at the dominant axis. Horizontal motion
  // claims the swipe, vertical hands off to dnd-kit (which itself only kicks
  // in past distance:5 — our PointerSensor activationConstraint).
  //
  // Threshold is 80px in either direction; under that the card snaps back.
  // We track the live offset in state so the card visibly follows the finger
  // and a coloured reveal (green check / amber clock) shows underneath.
  // -------------------------------------------------------------------------
  const swipeStartRef = useRef<{ x: number; y: number; id: number } | null>(null);
  const [swipeDx, setSwipeDx] = useState(0);
  // 'claimed' = our gesture owns this drag; 'released' = handed off to dnd-kit;
  // null = undecided.
  const swipeMode = useRef<'claimed' | 'released' | null>(null);
  const SWIPE_THRESHOLD = 80;
  const SWIPE_REVEAL_TRIGGER = 5;

  const swipeHandlers = isMobile
    ? {
        onPointerDown: (e: React.PointerEvent) => {
          // Ignore clicks on the embedded interactive controls — they need to
          // claim their own pointer events (checkbox, subtask toggle).
          const target = e.target as HTMLElement;
          if (target.closest('input, [role="checkbox"], button[aria-expanded]')) return;
          swipeStartRef.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
          swipeMode.current = null;
          setSwipeDx(0);
        },
        onPointerMove: (e: React.PointerEvent) => {
          const start = swipeStartRef.current;
          if (!start || start.id !== e.pointerId) return;
          const dx = e.clientX - start.x;
          const dy = e.clientY - start.y;
          if (swipeMode.current === null) {
            // Decide once movement exceeds the disambiguation threshold.
            if (Math.abs(dx) < SWIPE_REVEAL_TRIGGER && Math.abs(dy) < SWIPE_REVEAL_TRIGGER) return;
            if (isHorizontalDominant({ dx, dy })) {
              swipeMode.current = 'claimed';
              try {
                (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
              } catch {
                // setPointerCapture can throw if the pointer was already
                // captured by dnd-kit; that's fine — we'll just track via
                // pointermove on the document instead.
              }
            } else {
              swipeMode.current = 'released';
              return;
            }
          }
          if (swipeMode.current === 'claimed') {
            // Cap the visual offset so the card doesn't drag off-screen and
            // the user gets clear "this is the threshold" feedback.
            setSwipeDx(Math.max(-160, Math.min(160, dx)));
          }
        },
        onPointerUp: (e: React.PointerEvent) => {
          const start = swipeStartRef.current;
          swipeStartRef.current = null;
          if (!start || start.id !== e.pointerId) {
            setSwipeDx(0);
            swipeMode.current = null;
            return;
          }
          if (swipeMode.current === 'claimed') {
            const dx = e.clientX - start.x;
            if (dx > SWIPE_THRESHOLD) {
              onSwipeAction(task.id, 'done');
            } else if (dx < -SWIPE_THRESHOLD) {
              onSwipeAction(task.id, 'snooze');
            }
          }
          setSwipeDx(0);
          swipeMode.current = null;
        },
        onPointerCancel: () => {
          swipeStartRef.current = null;
          swipeMode.current = null;
          setSwipeDx(0);
        },
      }
    : {};

  // PointerSensor has activationConstraint distance:5, so a plain click never
  // triggers a drag — we can safely put onClick on the card itself.
  const cardTransform = swipeDx
    ? `${CSS.Transform.toString(transform) ?? ''} translateX(${swipeDx}px)`.trim()
    : CSS.Transform.toString(transform);

  return (
    <div className="relative" {...swipeHandlers}>
      {/* Swipe reveal — green check on the right (done), amber clock on the
          left (snooze). Only rendered when there's a meaningful swipe in
          progress so it doesn't add to the painted layers in the idle state. */}
      {isMobile && Math.abs(swipeDx) > SWIPE_REVEAL_TRIGGER && (
        <div
          aria-hidden="true"
          className={cn(
            'absolute inset-0 rounded-md flex items-center px-4 text-sm font-medium pointer-events-none',
            swipeDx > 0
              ? 'justify-start bg-status-done/20 text-status-done'
              : 'justify-end bg-amber-500/20 text-amber-600 dark:text-amber-300',
          )}
          data-testid={`swipe-reveal-${task.id}`}
        >
          {swipeDx > 0 ? (
            <span className="inline-flex items-center gap-1.5">
              <CheckCircle2 className="h-4 w-4" />
              {Math.abs(swipeDx) >= SWIPE_THRESHOLD ? 'Mark done' : 'Swipe to complete'}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5">
              {Math.abs(swipeDx) >= SWIPE_THRESHOLD ? 'Snooze 1 day' : 'Swipe to snooze'}
              <Clock className="h-4 w-4" />
            </span>
          )}
        </div>
      )}
    <div
      ref={setNodeRef}
      style={{
        ...style,
        transform: cardTransform,
        transition: swipeDx ? 'none' : transition,
        // While dragging, hide the in-place card — the DragOverlay portal
        // renders the floating copy. Keep the space occupied (opacity 0,
        // pointer-events none) so the column layout doesn't jump.
        opacity: isDragging ? 0 : 1,
        pointerEvents: isDragging ? 'none' : undefined,
      }}
      {...attributes}
      {...listeners}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      role="button"
      tabIndex={0}
      data-dragging={isDragging ? 'true' : 'false'}
      className={cn(
        'board-card group relative rounded-md border bg-card p-3 cursor-pointer shadow-sm',
        selected ? 'border-primary ring-1 ring-primary' : 'border-border hover:border-ring hover:shadow-md',
      )}
    >
      <label
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
        className={cn(
          'absolute top-2 right-2 flex items-center justify-center z-10',
          'transition-opacity',
          selected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-within:opacity-100',
        )}
      >
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggleSelect}
          aria-label={`Select ${task.key}`}
          className="h-4 w-4 rounded border-input accent-primary cursor-pointer"
        />
      </label>

      {/* Top row — type + key (left) + priority dot (right) */}
      <div className="flex items-center justify-between gap-2 pr-6">
        <span className="flex items-center gap-1.5 min-w-0">
          <TypeBadge type={task.type ?? 'Task'} />
          <span className="text-[11px] font-mono text-muted-foreground truncate">{task.key}</span>
        </span>
        <PriorityDot priority={task.priority} />
      </div>

      {/* Title */}
      <div className="text-sm mt-1.5 font-medium leading-snug text-foreground line-clamp-2">
        {task.title}
      </div>

      {/* Chip row — blocked, at-risk, due date */}
      {(task.isBlocked || task.aiRiskReason || task.dueDate) && (
        <div className="flex items-center gap-1.5 mt-2 flex-wrap">
          <BlockedBadge blocked={task.isBlocked} />
          <AtRiskBadge reason={task.aiRiskReason} />
          <DueDateChip dueDate={task.dueDate} done={task.status === 'Done'} />
        </div>
      )}

      {/* Label chips — colored pills below the title so they're visible at a
          glance. Show up to 3; overflow into a "+N" indicator so a heavily
          tagged card doesn't take over the row. */}
      {task.labels && task.labels.length > 0 && (
        <div className="flex items-center gap-1 mt-2 flex-wrap">
          {task.labels.slice(0, 3).map(({ label: l }) => {
            const hex = l.color.startsWith('#') ? l.color : `#${l.color}`;
            return (
              <span
                key={l.id}
                className="inline-flex items-center gap-1 rounded-full px-1.5 py-px text-[10px] font-medium"
                style={{
                  backgroundColor: `${hex}22`,
                  color: hex,
                  border: `1px solid ${hex}44`,
                }}
                title={l.name}
              >
                <span
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ backgroundColor: hex }}
                  aria-hidden="true"
                />
                <span className="truncate max-w-[100px]">{l.name}</span>
              </span>
            );
          })}
          {task.labels.length > 3 && (
            <span className="text-[10px] text-muted-foreground">+{task.labels.length - 3}</span>
          )}
        </div>
      )}

      {/* Custom field chips — show the first two non-empty values so the card
          stays compact. Hover the name to see the full label. */}
      {task.customFieldValues && task.customFieldValues.length > 0 && (
        <CustomFieldChips values={task.customFieldValues} />
      )}

      {/* Bottom row — assignee avatar + subtask toggle */}
      <div className="flex items-center justify-between mt-2.5 pt-2 border-t border-border/60 text-xs text-muted-foreground">
        {task.assignee ? (
          <span className="flex items-center gap-1.5 min-w-0">
            <AvatarCircle user={task.assignee} size={20} />
            <span className="truncate">{task.assignee.name}</span>
          </span>
        ) : (
          <span className="flex items-center gap-1.5 text-muted-foreground/60">
            <AvatarCircle user={null} size={20} />
            Unassigned
          </span>
        )}
        {subtaskCount > 0 && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setSubtasksOpen((o) => !o);
            }}
            onPointerDown={(e) => e.stopPropagation()}
            className="tap inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
            aria-expanded={subtasksOpen}
            aria-label={`${subtasksOpen ? 'Hide' : 'Show'} ${subtaskCount} subtasks`}
          >
            <svg
              viewBox="0 0 16 16"
              fill="currentColor"
              className="h-3 w-3 transition-transform duration-200 ease-out"
              style={{ transform: subtasksOpen ? 'rotate(90deg)' : 'rotate(0deg)' }}
              aria-hidden="true"
            >
              <path d="M6 4l4 4-4 4V4z" />
            </svg>
            {subtasksDone}/{subtaskCount} subtasks
          </button>
        )}
      </div>

      {/* Collapsible subtask list — opt-in, default closed so cards stay short. */}
      {subtaskCount > 0 && subtasksOpen && (
        <ul
          className="mt-2 pt-2 border-t border-border/60 space-y-1 stagger-list"
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {subtasks.map((s) => (
            <li
              key={s.id}
              className="stagger-item flex items-center gap-1.5 text-[11px] text-muted-foreground"
            >
              <TypeBadge type={s.type ?? 'Subtask'} />
              <span className="font-mono text-[10px] shrink-0">{s.key.split('-').pop()}</span>
              <span className="truncate flex-1 text-foreground/90">{s.title}</span>
              <StatusPill status={s.status} className="text-[9px] px-1.5 py-0" />
            </li>
          ))}
        </ul>
      )}
    </div>
    </div>
  );
}
