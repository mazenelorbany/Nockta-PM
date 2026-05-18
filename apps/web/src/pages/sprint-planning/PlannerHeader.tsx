import { ArrowLeft, ArrowRight, Play } from 'lucide-react';
import { Link } from 'react-router-dom';

import type { Project, Sprint } from './types';

export function PlannerHeader({
  project,
  sprint,
  projectId,
  sprintId,
  canModify,
  sprintTasksCount,
  startSprintPending,
  onStartSprint,
}: {
  project: Project;
  sprint: Sprint;
  projectId: string;
  sprintId: string;
  canModify: boolean;
  sprintTasksCount: number;
  startSprintPending: boolean;
  onStartSprint: () => void;
}): JSX.Element {
  return (
    <header className="px-4 sm:px-6 md:px-8 py-4 sm:py-5 border-b border-border">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <Link
            to={`/projects/${projectId}/backlog`}
            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors mb-1"
          >
            <ArrowLeft className="h-3 w-3" />
            {project.key} · Backlog
          </Link>
          <h1 className="text-xl font-semibold tracking-tight">
            Plan: <span className="text-foreground">{sprint.name}</span>
          </h1>
          <p className="mt-1 text-xs text-muted-foreground">
            Drag tasks from the backlog into the sprint, or click to toggle. Estimates roll up
            live on the right.
            {sprint.startDate || sprint.endDate ? (
              <>
                {' '}
                <span className="ml-1">
                  {sprint.startDate ? new Date(sprint.startDate).toLocaleDateString() : '—'}
                  {' → '}
                  {sprint.endDate ? new Date(sprint.endDate).toLocaleDateString() : '—'}
                </span>
              </>
            ) : null}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {sprint.state === 'planned' && canModify && (
            <button
              type="button"
              onClick={() => {
                if (window.confirm(`Start "${sprint.name}"? Only one sprint can be active per project.`)) {
                  onStartSprint();
                }
              }}
              disabled={startSprintPending || sprintTasksCount === 0}
              className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50 transition"
              title={sprintTasksCount === 0 ? 'Add at least one task before starting' : 'Start sprint'}
            >
              <Play className="h-3.5 w-3.5" />
              Start sprint
            </button>
          )}
          {sprint.state === 'active' && (
            <Link
              to={`/projects/${projectId}/board?sprint=${sprintId}`}
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-2 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground transition"
            >
              Open board
              <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          )}
        </div>
      </div>
    </header>
  );
}
