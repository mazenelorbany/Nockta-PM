import { FileText, Play, Sparkles, Trash2 } from 'lucide-react';
import { Link } from 'react-router-dom';

import { downloadPdf } from '../../lib/download-pdf';

import { RunRetroButton } from './RetroModal';
import type { Sprint } from './types';

// =============================================================================
// SprintHeaderActions — Start / Complete / Plan / View board buttons.
// =============================================================================

export function SprintHeaderActions({
  sprint,
  canStart,
  onStart,
  onComplete,
  onDelete,
  onPlan,
  projectId,
}: {
  sprint: Sprint;
  canStart: boolean;
  onStart: () => void;
  onComplete: () => void;
  onDelete: () => void;
  onPlan: () => void;
  projectId: string;
}): JSX.Element {
  return (
    <>
      {sprint.state === 'planned' && (
        <button
          type="button"
          onClick={onPlan}
          className="inline-flex items-center gap-1 rounded-md border border-border bg-brand/5 px-2 py-1 text-[11px] font-medium text-brand hover:bg-brand/10 transition"
          title="Open the AI-ranked task suggestion modal for this sprint"
        >
          <Sparkles className="h-3 w-3" />
          Plan with AI
        </button>
      )}
      <Link
        to={`/projects/${projectId}/sprints/${sprint.id}/plan`}
        className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground transition"
      >
        Plan
      </Link>
      {sprint.state === 'active' && (
        <Link
          to={`/projects/${projectId}/board?sprint=${sprint.id}`}
          className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground transition"
        >
          Board
        </Link>
      )}
      {sprint.state === 'planned' && (
        <button
          type="button"
          onClick={onStart}
          disabled={!canStart}
          title={canStart ? 'Start sprint' : 'Add at least one task and stop any active sprint first'}
          className="inline-flex items-center gap-1 rounded-md bg-primary px-2 py-1 text-[11px] font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50 transition"
        >
          <Play className="h-3 w-3" />
          Start
        </button>
      )}
      {sprint.state === 'active' && (
        <button
          type="button"
          onClick={onComplete}
          className="inline-flex items-center gap-1 rounded-md bg-status-done/80 px-2 py-1 text-[11px] font-medium text-white hover:bg-status-done transition"
        >
          Complete
        </button>
      )}
      {/* Pass I (Sprints 8→9). The "Run retro" button shows on completed
          sprints so the team can capture went-well / could-improve / action
          items in the same place they ended the sprint. */}
      {sprint.state === 'completed' && (
        <RunRetroButton sprintId={sprint.id} />
      )}
      {/* Branded PDF export — available on active + completed sprints (a
          planned sprint with no logged time would print a blank report). */}
      {(sprint.state === 'active' || sprint.state === 'completed') && (
        <button
          type="button"
          onClick={() =>
            downloadPdf(`/analytics/sprints/${sprint.id}/report.pdf`, `${sprint.name}-sprint-report.pdf`)
          }
          className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground transition"
          title="Download a branded PDF of completed tasks + hours logged for this sprint"
        >
          <FileText className="h-3 w-3" />
          Export PDF
        </button>
      )}
      {sprint.state === 'planned' && (
        <button
          type="button"
          onClick={onDelete}
          className="inline-flex items-center justify-center rounded-md w-7 h-7 text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors"
          aria-label="Delete sprint"
          title="Delete sprint"
        >
          <Trash2 className="h-3 w-3" />
        </button>
      )}
    </>
  );
}
