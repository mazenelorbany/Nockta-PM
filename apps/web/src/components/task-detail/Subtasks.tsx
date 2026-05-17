import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@nockta/ui';
import { StatusPill, TypeBadge } from '../task-bits';
import { TaskDependencyGraph } from '../TaskDependencyGraph';
import { Section } from './Section';
import type { LinkType, TaskDetail } from './types';

export function SubtasksSection({
  task,
  onOpenTask,
}: {
  task: TaskDetail;
  onOpenTask: (id: string) => void;
}): JSX.Element | null {
  const subtasks = task.subtasks ?? [];
  if (subtasks.length === 0) return null;
  const done = subtasks.filter((s) => s.status === 'Done').length;

  return (
    <Section title={`Subtasks (${done}/${subtasks.length})`}>
      <ul className="space-y-1">
        {subtasks.map((s) => (
          <li key={s.id}>
            <button
              type="button"
              onClick={() => onOpenTask(s.id)}
              className="tap w-full flex items-center justify-between gap-3 rounded-md border border-border bg-background/40 hover:bg-accent/40 hover:border-ring px-3 py-2 text-sm text-left transition-colors"
            >
              <div className="flex items-center gap-2 min-w-0">
                <TypeBadge type={s.type ?? 'Subtask'} />
                <span className="text-[11px] font-mono text-muted-foreground shrink-0">
                  {task.project.key}-{s.keyNumber}
                </span>
                <span className="truncate">{s.title}</span>
              </div>
              <StatusPill status={s.status} />
            </button>
          </li>
        ))}
      </ul>
    </Section>
  );
}

// =============================================================================
// Linked tasks
// =============================================================================

export function LinkedTasksSection({
  task,
  onOpenTask,
}: {
  task: TaskDetail;
  onOpenTask: (id: string) => void;
}): JSX.Element | null {
  const out = task.fromLinks ?? [];
  const inc = task.toLinks ?? [];
  // Local toggle for the dependency-graph SVG. Persisted across drawer re-
  // renders (useState) but NOT across drawer close/open — re-mounting the
  // drawer collapses the graph again, which matches the "expand to inspect"
  // affordance the spec describes.
  const [showGraph, setShowGraph] = useState(false);
  if (out.length === 0 && inc.length === 0) return null;

  return (
    <Section title="Linked tasks">
      <ul className="space-y-1 text-sm">
        {out.map((l) => (
          <li key={l.id} className="flex items-center gap-2">
            <LinkTypePill type={l.type} direction="from" />
            <span className="font-mono text-xs text-muted-foreground">{l.toTaskId.slice(0, 8)}…</span>
          </li>
        ))}
        {inc.map((l) => (
          <li key={l.id} className="flex items-center gap-2">
            <LinkTypePill type={l.type} direction="to" />
            <span className="font-mono text-xs text-muted-foreground">{l.fromTaskId.slice(0, 8)}…</span>
          </li>
        ))}
      </ul>
      <div className="mt-3">
        <button
          type="button"
          onClick={() => setShowGraph((v) => !v)}
          className="tap inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          aria-expanded={showGraph}
        >
          <ChevronDown
            className={cn(
              'h-3 w-3 transition-transform',
              showGraph ? 'rotate-0' : '-rotate-90',
            )}
          />
          {showGraph ? 'Hide graph' : 'View graph'}
        </button>
        {showGraph && (
          <div className="mt-2">
            <TaskDependencyGraph taskId={task.id} onNodeClick={(id) => onOpenTask(id)} />
          </div>
        )}
      </div>
    </Section>
  );
}

export function LinkTypePill({ type, direction }: { type: LinkType; direction: 'from' | 'to' }): JSX.Element {
  const labels: Record<LinkType, [string, string]> = {
    blocks:    ['blocks', 'blocked by'],
    related:   ['related to', 'related to'],
    duplicate: ['duplicate of', 'duplicated by'],
  };
  return (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-medium bg-secondary text-secondary-foreground">
      {labels[type][direction === 'from' ? 0 : 1]}
    </span>
  );
}
