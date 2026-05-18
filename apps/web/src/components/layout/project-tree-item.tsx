import { cn } from '@nockta/ui';
import { Link, useParams } from 'react-router-dom';

import type { ProjectSummary } from './types';

// -----------------------------------------------------------------------------
// Project tree item — single row, navigates straight to /projects/:id.
// -----------------------------------------------------------------------------

/**
 * Sidebar project row. Single click → /projects/:id (overview). All the per-
 * page navigation that used to live in a chevron-expand sub-menu (Board, List,
 * Backlog, Timeline, Docs, Automations, Settings) now lives in the
 * ProjectTabs strip at the top of each project page, so it's reachable in
 * one location and reflects which tab the user is on.
 *
 * `expanded`/`onToggle` are accepted but ignored so callers don't break; we
 * can clean those props up in a follow-up.
 */
export function ProjectTreeItem({
  project,
}: {
  project: ProjectSummary;
  expanded?: boolean;
  onToggle?: () => void;
}): JSX.Element {
  const { projectId: activeProjectId } = useParams<{ projectId: string }>();
  const isActive = activeProjectId === project.id;
  const accent = projectAccent(project.key);

  return (
    <Link
      to={`/projects/${project.id}`}
      className={cn(
        'group flex items-center gap-2 px-2 py-1.5 rounded-md text-sm transition-colors',
        isActive
          ? 'bg-accent/70 text-foreground font-medium'
          : 'text-muted-foreground hover:bg-accent/40 hover:text-foreground',
      )}
    >
      <span
        className="shrink-0 h-5 w-5 rounded-md inline-flex items-center justify-center text-[10px] font-mono font-bold tracking-tight"
        style={{
          background: `linear-gradient(135deg, ${accent.from}, ${accent.to})`,
          color: accent.fg,
        }}
        title={project.workflowPreset}
      >
        {project.key.slice(0, 2)}
      </span>
      <span className="truncate flex-1 text-start">{project.name}</span>
    </Link>
  );
}

/**
 * Generates a deterministic gradient + foreground color for a project key.
 * djb2 hash → hue rotated through a curated palette so each project has a
 * unique-but-tasteful badge in the sidebar. Pure function, no state.
 */
export function projectAccent(key: string): { from: string; to: string; fg: string } {
  let h = 5381;
  for (let i = 0; i < key.length; i++) h = ((h << 5) + h + key.charCodeAt(i)) | 0;
  const hue = Math.abs(h) % 360;
  // Use HSL so the from/to are guaranteed-contrasting at the same lightness.
  return {
    from: `hsl(${hue}, 75%, 58%)`,
    to: `hsl(${(hue + 28) % 360}, 70%, 48%)`,
    fg: 'white',
  };
}
