import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, Trash2 } from 'lucide-react';
import { cn } from '@nockta/ui';
import type { KeyResult, KeyResultRowCallbacks } from './types';
import { krPercent } from './util';

// =============================================================================
// KeyResultsSortableList — dnd-kit-powered reorderable list. Replaces the
// earlier up/down-arrow swap. Drag handle is a tiny grip-vertical icon that
// reveals on hover; the entire row is also keyboard-sortable via dnd-kit's
// KeyboardSensor (Tab to focus a handle, Space to pick up, arrow keys to
// move, Space again to drop). After a drop we send N position updates for
// the items whose positions changed — the backend orders by `position` asc.
// =============================================================================

export function KeyResultsSortableList({
  keyResults,
  onUpdate,
  onRemove,
}: { keyResults: KeyResult[] } & KeyResultRowCallbacks): JSX.Element {
  // Pointer sensor with a small activation distance so a click on the inline
  // name/value inputs doesn't accidentally start a drag. Keyboard sensor
  // gives full a11y — Tab to handle, Space to pick up, Arrow keys to move.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  function handleDragEnd(event: DragEndEvent): void {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = keyResults.findIndex((kr) => kr.id === active.id);
    const newIndex = keyResults.findIndex((kr) => kr.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;
    const reordered = arrayMove(keyResults, oldIndex, newIndex);
    // Renumber positions starting at 0 along the new order, then send an
    // update for every KR whose position actually changed. Avoids writing
    // N rows when only 2 shifted. For larger lists this is O(N) writes but
    // KR lists are typically 2-5 items so the cost is fine.
    for (let i = 0; i < reordered.length; i++) {
      const kr = reordered[i]!;
      if (kr.position !== i) {
        onUpdate(kr.id, { position: i });
      }
    }
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext
        items={keyResults.map((kr) => kr.id)}
        strategy={verticalListSortingStrategy}
      >
        <ul className="space-y-3">
          {keyResults.map((kr) => (
            <SortableKeyResult
              key={kr.id}
              kr={kr}
              onUpdate={onUpdate}
              onRemove={onRemove}
            />
          ))}
        </ul>
      </SortableContext>
    </DndContext>
  );
}

function SortableKeyResult({
  kr,
  onUpdate,
  onRemove,
}: { kr: KeyResult } & KeyResultRowCallbacks): JSX.Element {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: kr.id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
  };
  const pct = krPercent(kr);

  return (
    <li
      ref={setNodeRef}
      style={style}
      className="group rounded-md border border-border/60 bg-background/40 p-3"
    >
      <div className="flex items-center justify-between gap-2 mb-2">
        {/* Drag handle. `listeners` MUST be on this button only — putting
            them on the row would steal pointerdown from the inline inputs
            and break editing. */}
        <button
          type="button"
          {...attributes}
          {...listeners}
          aria-label="Reorder key result (drag, or use keyboard: Tab → Space → Arrow keys)"
          className="text-muted-foreground/40 hover:text-foreground cursor-grab active:cursor-grabbing opacity-0 group-hover:opacity-100 transition touch-none"
        >
          <GripVertical className="h-4 w-4" />
        </button>
        <input
          defaultValue={kr.name}
          onBlur={(e) => {
            const v = e.target.value.trim();
            if (v && v !== kr.name) onUpdate(kr.id, { name: v });
          }}
          className="flex-1 bg-transparent text-sm font-medium focus:outline-none"
        />
        <button
          type="button"
          onClick={() => {
            if (window.confirm(`Delete "${kr.name}"?`)) onRemove(kr.id);
          }}
          aria-label="Delete key result"
          className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition p-1"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="flex items-center gap-2 text-xs text-muted-foreground mb-2">
        <input
          type="number"
          defaultValue={kr.currentValue}
          onBlur={(e) => {
            const v = Number(e.target.value);
            if (Number.isFinite(v) && v !== kr.currentValue) {
              onUpdate(kr.id, { currentValue: v });
            }
          }}
          className="w-20 rounded-md border border-input bg-background px-2 py-1 text-xs text-foreground font-mono"
        />
        <span>/</span>
        <input
          type="number"
          defaultValue={kr.targetValue}
          onBlur={(e) => {
            const v = Number(e.target.value);
            if (Number.isFinite(v) && v > 0 && v !== kr.targetValue) {
              onUpdate(kr.id, { targetValue: v });
            }
          }}
          className="w-20 rounded-md border border-input bg-background px-2 py-1 text-xs text-foreground font-mono"
        />
        {kr.unit && <span className="text-muted-foreground">{kr.unit}</span>}
        <span className="ml-auto font-medium tabular-nums text-foreground">{pct}%</span>
      </div>
      <div className="h-1.5 rounded-full bg-muted overflow-hidden">
        <div
          className={cn(
            'h-full transition-all',
            pct >= 100 ? 'bg-status-done' : 'bg-brand',
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
    </li>
  );
}
