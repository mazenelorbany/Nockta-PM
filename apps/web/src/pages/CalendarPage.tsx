import {
  DndContext, type DragEndEvent, PointerSensor, useDraggable, useDroppable, useSensor, useSensors,
} from '@dnd-kit/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { useSearchParams } from 'react-router-dom';
import { ApiError } from '@nockta/sdk';
import { cn, NocktaMark, QueryErrorState, Skeleton } from '@nockta/ui';

import { TaskDetailDrawer } from '../components/TaskDetailDrawer';
import { PriorityDot, StatusPill, type Priority } from '../components/task-bits';
import { api } from '../lib/api';
import { queryKeys } from '../lib/query-keys';

// =============================================================================
// /calendar — month grid showing tasks with due dates. Drag tasks across days
// to reschedule (PATCH /tasks/:id with new dueDate).
// =============================================================================

interface CalendarTask {
  id: string;
  key: string;
  title: string;
  status: string;
  priority: Priority;
  isBlocked: boolean;
  dueDate: string | null;
  project?: { id: string; key: string; name: string };
}

interface SearchResp {
  items: CalendarTask[];
  nextCursor: string | null;
}

interface Project {
  id: string;
  key: string;
  name: string;
}

export function CalendarPage(): JSX.Element {
  const [searchParams, setSearchParams] = useSearchParams();
  const openTaskId = searchParams.get('task');
  const [cursor, setCursor] = useState<Date>(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const [projectFilter, setProjectFilter] = useState<string>('');
  const queryClient = useQueryClient();

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const projectsQuery = useQuery({
    queryKey: queryKeys.projects(),
    queryFn: () => api.get<Project[]>('/projects'),
  });

  const tasksQuery = useQuery({
    queryKey: ['calendar-tasks', projectFilter],
    queryFn: () => {
      const qs = new URLSearchParams({ limit: '200' });
      if (projectFilter) qs.set('projectId', projectFilter);
      return api.get<SearchResp>(`/search/tasks?${qs.toString()}`);
    },
  });

  // Reschedule mutation — optimistic so the drag feels instant.
  const reschedule = useMutation({
    mutationFn: ({ taskId, dueDate }: { taskId: string; dueDate: string }) =>
      api.patch(`/tasks/${taskId}`, { dueDate }),
    onMutate: async ({ taskId, dueDate }) => {
      await queryClient.cancelQueries({ queryKey: ['calendar-tasks', projectFilter] });
      const previous = queryClient.getQueryData<SearchResp>(['calendar-tasks', projectFilter]);
      queryClient.setQueryData<SearchResp>(['calendar-tasks', projectFilter], (old) =>
        old
          ? {
              ...old,
              items: old.items.map((t) => (t.id === taskId ? { ...t, dueDate } : t)),
            }
          : old,
      );
      return { previous };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.previous) {
        queryClient.setQueryData(['calendar-tasks', projectFilter], ctx.previous);
      }
      toast.error(
        err instanceof ApiError ? err.problem.title || err.message : 'Reschedule failed',
      );
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['calendar-tasks', projectFilter] });
    },
  });

  const tasksWithDates = useMemo(
    () => (tasksQuery.data?.items ?? []).filter((t) => t.dueDate),
    [tasksQuery.data],
  );

  const { weeks, monthLabel } = useMemo(() => buildMonth(cursor), [cursor]);

  const byDate = useMemo(() => {
    const m = new Map<string, CalendarTask[]>();
    for (const t of tasksWithDates) {
      if (!t.dueDate) continue;
      const key = ymd(new Date(t.dueDate));
      const arr = m.get(key) ?? [];
      arr.push(t);
      m.set(key, arr);
    }
    return m;
  }, [tasksWithDates]);

  function openTask(t: CalendarTask): void {
    if (!t.project) return;
    setSearchParams((sp) => {
      sp.set('task', t.id);
      sp.set('project', t.project!.id);
      return sp;
    });
  }
  function closeTask(): void {
    setSearchParams((sp) => {
      sp.delete('task');
      sp.delete('project');
      return sp;
    });
  }

  function onDragEnd(event: DragEndEvent): void {
    const { active, over } = event;
    if (!over) return;
    const overId = String(over.id);
    if (!overId.startsWith('day:')) return;
    const newDay = overId.slice(4);
    const task = tasksWithDates.find((t) => t.id === active.id);
    if (!task || !task.dueDate) return;
    if (ymd(new Date(task.dueDate)) === newDay) return;
    // Preserve the original time-of-day; just swap the date portion.
    const old = new Date(task.dueDate);
    const [y, m, d] = newDay.split('-').map(Number) as [number, number, number];
    old.setFullYear(y);
    old.setMonth(m - 1);
    old.setDate(d);
    reschedule.mutate({ taskId: task.id, dueDate: old.toISOString() });
  }

  return (
    <div className="flex flex-col h-full">
      <header className="relative overflow-hidden border-b border-border gradient-mesh-subtle">
        <div
          className="absolute -right-12 -bottom-16 text-brand/[0.05] pointer-events-none select-none"
          aria-hidden="true"
        >
          <NocktaMark className="h-[240px] w-[240px]" />
        </div>
        <div className="relative px-4 sm:px-6 md:px-8 pt-6 sm:pt-8 pb-6 sm:pb-8 flex items-end justify-between gap-4 sm:gap-6 flex-wrap">
          <div>
            <span className="nockta-eyebrow text-brand">
              {'Schedule'}
            </span>
            <h1
              className="display-heading mt-2 leading-[1.04]"
              style={{ fontSize: 'clamp(1.8rem, 3.4vw, 2.6rem)' }}
            >
              {'Calendar'}
            </h1>
            <p className="mt-2 text-sm text-muted-foreground max-w-xl">
              {'Drop dates onto a month grid. Drag to reschedule.'}
            </p>
          </div>
          <select
            value={projectFilter}
            onChange={(e) => setProjectFilter(e.target.value)}
            className="field text-xs py-2 w-full sm:w-56"
          >
            <option value="">{'All projects'}</option>
            {(projectsQuery.data ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.key} · {p.name}
              </option>
            ))}
          </select>
        </div>
      </header>

      <div className="px-4 sm:px-6 md:px-8 py-3 border-b border-border flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() =>
              setCursor((c) => new Date(c.getFullYear(), c.getMonth() - 1, 1))
            }
            className="rounded-md p-1.5 hover:bg-accent transition-colors"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => {
              const d = new Date();
              setCursor(new Date(d.getFullYear(), d.getMonth(), 1));
            }}
            className="rounded-md border border-border px-3 py-1 text-xs hover:bg-accent transition-colors"
          >
            {'Today'}
          </button>
          <button
            type="button"
            onClick={() =>
              setCursor((c) => new Date(c.getFullYear(), c.getMonth() + 1, 1))
            }
            className="rounded-md p-1.5 hover:bg-accent transition-colors"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
          <h2 className="text-lg font-semibold ml-2">{monthLabel}</h2>
        </div>
        <span className="nockta-eyebrow text-muted-foreground">
          {tasksWithDates.length} with due dates · drag to reschedule
        </span>
      </div>

      {tasksQuery.isError && (
        <div className="px-4 sm:px-6 md:px-8 py-3">
          <QueryErrorState
            title="Couldn't load tasks for this view"
            error={tasksQuery.error}
            onRetry={() => void tasksQuery.refetch()}
            className="rounded-lg border border-destructive/30 bg-destructive/5 py-6"
          />
        </div>
      )}

      <div className="flex-1 overflow-auto p-3 sm:p-4 md:p-6">
        {tasksQuery.isLoading && (
          <div className="min-w-[640px] grid grid-cols-7 gap-px bg-border rounded-lg overflow-hidden mb-4">
            {Array.from({ length: 7 }).map((_, i) => (
              <div key={i} className="bg-card p-2"><Skeleton className="h-3 w-10" /></div>
            ))}
            {Array.from({ length: 35 }).map((_, i) => (
              <div key={i} className="bg-card aspect-square p-2">
                <Skeleton className="h-3 w-6 mb-2" />
                <Skeleton className="h-2 w-full" />
              </div>
            ))}
          </div>
        )}
        <DndContext sensors={sensors} onDragEnd={onDragEnd}>
          <div className="min-w-[640px] grid grid-cols-7 gap-px bg-border rounded-lg overflow-hidden">
            {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
              <div
                key={d}
                className="bg-card px-2 py-1.5 text-[10px] nockta-eyebrow text-muted-foreground text-center"
              >
                {d}
              </div>
            ))}
            {weeks.flat().map((day) => (
              <DayCell
                key={ymd(day.date)}
                day={day}
                tasks={byDate.get(ymd(day.date)) ?? []}
                onOpenTask={openTask}
              />
            ))}
          </div>
        </DndContext>
      </div>

      {openTaskId && <TaskDetailDrawer taskId={openTaskId} onClose={closeTask} />}
    </div>
  );
}

function DayCell({
  day,
  tasks,
  onOpenTask,
}: {
  day: DayInfo;
  tasks: CalendarTask[];
  onOpenTask: (t: CalendarTask) => void;
}): JSX.Element {
  const id = `day:${ymd(day.date)}`;
  const { setNodeRef, isOver } = useDroppable({ id });
  const isToday = ymd(day.date) === ymd(new Date());

  return (
    <div
      ref={setNodeRef}
      className={cn(
        'bg-card min-h-[110px] p-1.5 flex flex-col gap-1 transition-colors',
        !day.inMonth && 'opacity-40',
        isOver && 'bg-brand/10 ring-2 ring-brand/30 ring-inset',
      )}
    >
      <div
        className={cn(
          'text-xs font-medium',
          isToday
            ? 'inline-flex items-center justify-center w-5 h-5 rounded-full bg-brand text-brand-foreground'
            : 'text-muted-foreground',
        )}
      >
        {day.date.getDate()}
      </div>
      <div className="flex-1 space-y-0.5 overflow-hidden">
        {tasks.slice(0, 3).map((t) => (
          <DraggableTaskPill key={t.id} task={t} onClick={() => onOpenTask(t)} />
        ))}
        {tasks.length > 3 && (
          <div className="text-[10px] text-muted-foreground px-1">+{tasks.length - 3} more</div>
        )}
      </div>
    </div>
  );
}

function DraggableTaskPill({
  task,
  onClick,
}: {
  task: CalendarTask;
  onClick: () => void;
}): JSX.Element {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: task.id,
  });
  const style = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` }
    : undefined;
  return (
    <button
      ref={setNodeRef}
      type="button"
      {...attributes}
      {...listeners}
      style={style}
      onClick={onClick}
      className={cn(
        'w-full text-left rounded px-1.5 py-0.5 text-[11px] flex items-center gap-1 bg-accent/40 hover:bg-accent transition-colors min-w-0 cursor-grab',
        isDragging && 'opacity-50 cursor-grabbing',
      )}
    >
      <PriorityDot priority={task.priority} className="!h-1.5 !w-1.5 shrink-0" />
      <span className="truncate">{task.title}</span>
    </button>
  );
}

// -----------------------------------------------------------------------------
// Date helpers
// -----------------------------------------------------------------------------

interface DayInfo {
  date: Date;
  inMonth: boolean;
}

function buildMonth(firstOfMonth: Date): { weeks: DayInfo[][]; monthLabel: string } {
  const year = firstOfMonth.getFullYear();
  const month = firstOfMonth.getMonth();
  const firstWeekday = (firstOfMonth.getDay() + 6) % 7;
  const start = new Date(year, month, 1 - firstWeekday);

  const weeks: DayInfo[][] = [];
  for (let w = 0; w < 6; w++) {
    const row: DayInfo[] = [];
    for (let d = 0; d < 7; d++) {
      const day = new Date(start);
      day.setDate(start.getDate() + w * 7 + d);
      row.push({ date: day, inMonth: day.getMonth() === month });
    }
    weeks.push(row);
  }

  const monthLabel = firstOfMonth.toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
  });
  return { weeks, monthLabel };
}

function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export { StatusPill };
