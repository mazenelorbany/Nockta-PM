import { cn } from '@nockta/ui';

// =============================================================================
// Task display primitives — the small components used by board cards, list
// rows, drawer headers, and filter chips. ClickUp uses these everywhere, so
// centralizing them keeps the visual language consistent across views.
// =============================================================================

export type Priority = 'Low' | 'Medium' | 'High' | 'Critical';
export type TaskType = 'Epic' | 'Story' | 'Task' | 'Bug' | 'Subtask';

/**
 * Type badge — Jira-style colored glyph + label. Used on every card / row /
 * drawer header so the hierarchy is immediately legible.
 *
 *   Epic    — purple lightning (large body of work)
 *   Story   — green bookmark (user-facing feature)
 *   Task    — blue check (engineering work item)
 *   Bug     — red bug (defect)
 *   Subtask — gray fork (sub-item)
 */
export function TypeBadge({
  type,
  size = 'sm',
  showLabel = false,
  className,
}: {
  type: TaskType;
  size?: 'xs' | 'sm';
  /** Show the type name next to the glyph. Off by default to save space on cards. */
  showLabel?: boolean;
  className?: string;
}): JSX.Element {
  const { color, bg, icon, label } = TYPE_META[type];
  const dim = size === 'xs' ? 'h-3.5 w-3.5' : 'h-4 w-4';
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded shrink-0',
        showLabel ? 'px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide' : 'p-0.5',
        bg,
        color,
        className,
      )}
      title={label}
      aria-label={label}
    >
      <svg viewBox="0 0 16 16" fill="currentColor" className={dim} aria-hidden="true">
        {icon}
      </svg>
      {showLabel && <span>{label}</span>}
    </span>
  );
}

const TYPE_META: Record<TaskType, { color: string; bg: string; icon: JSX.Element; label: string }> = {
  Epic: {
    color: 'text-[#8B5CF6]',
    bg: 'bg-[#8B5CF6]/15',
    label: 'Epic',
    icon: <path d="M9 1 3 9h4l-1 6 6-8H8l1-6z" />,
  },
  Story: {
    color: 'text-[#36B37E]',
    bg: 'bg-[#36B37E]/15',
    label: 'Story',
    icon: <path d="M3 2v12l5-3 5 3V2H3z" />,
  },
  Task: {
    color: 'text-[#0052CC]',
    bg: 'bg-[#0052CC]/15',
    label: 'Task',
    icon: <path d="M2 2h12v12H2V2zm3 6 2 2 4-4-1-1-3 3-1-1-1 1z" fillRule="evenodd" />,
  },
  Bug: {
    color: 'text-[#E5493A]',
    bg: 'bg-[#E5493A]/15',
    label: 'Bug',
    icon: <path d="M8 1a3 3 0 0 0-3 3H3v2h2v2H1v2h4v.7A4 4 0 0 0 8 15a4 4 0 0 0 3-2.3V12h4v-2h-4V8h2V6h-2V4h-2a3 3 0 0 0-3-3z" />,
  },
  Subtask: {
    color: 'text-[#6B778C]',
    bg: 'bg-[#6B778C]/15',
    label: 'Subtask',
    icon: <path d="M3 2h6v4h2v3a3 3 0 0 1-3 3H6v3H4v-5h4a1 1 0 0 0 1-1V7H3V2z" />,
  },
};

interface User {
  id: string;
  name?: string;
  email?: string;
  avatarUrl?: string | null;
}

/**
 * Status pill — colored chip, white text, slightly rounded.
 * Color maps to the design-token status palette (see styles.css).
 */
export function StatusPill({
  status,
  className,
}: {
  status: string;
  className?: string;
}): JSX.Element {
  const tone = statusTone(status);
  return (
    <span
      className={cn(
        'inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-semibold uppercase tracking-wide whitespace-nowrap',
        tone,
        className,
      )}
    >
      {status}
    </span>
  );
}

function statusTone(status: string): string {
  const s = status.toLowerCase();
  if (s === 'todo')              return 'bg-status-todo/15 text-status-todo';
  if (s === 'in progress')       return 'bg-status-in-progress/20 text-status-in-progress';
  if (s === 'in review')         return 'bg-status-in-review/20 text-status-in-review';
  if (s === 'testing')           return 'bg-status-testing/20 text-status-testing';
  if (s === 'approved')          return 'bg-status-done/20 text-status-done';
  if (s === 'done')              return 'bg-status-done/20 text-status-done';
  return 'bg-muted text-muted-foreground';
}

/**
 * Priority dot — single colored circle. Hover/tooltip would show the label;
 * for now just the dot + sr-only text. Tighter than the previous text pill,
 * matches ClickUp's compact priority indicator.
 */
export function PriorityDot({
  priority,
  className,
}: {
  priority: Priority;
  className?: string;
}): JSX.Element {
  return (
    <span className={cn('inline-flex items-center', className)} title={`Priority: ${priority}`}>
      <span
        className={cn(
          'h-2.5 w-2.5 rounded-full ring-2 ring-card',
          priority === 'Critical' && 'bg-priority-critical',
          priority === 'High'     && 'bg-priority-high',
          priority === 'Medium'   && 'bg-priority-medium',
          priority === 'Low'      && 'bg-priority-low',
        )}
        aria-hidden="true"
      />
      <span className="sr-only">Priority: {priority}</span>
    </span>
  );
}

/**
 * Avatar circle — initial-based fallback, deterministic background color
 * derived from the user id (so the same person always gets the same color).
 */
export function AvatarCircle({
  user,
  size = 24,
  className,
}: {
  user?: User | null;
  size?: number;
  className?: string;
}): JSX.Element {
  if (!user) {
    return (
      <span
        className={cn(
          'inline-flex items-center justify-center rounded-full bg-muted text-muted-foreground border border-dashed border-border',
          className,
        )}
        style={{ width: size, height: size, fontSize: size * 0.42 }}
        title="Unassigned"
      >
        ?
      </span>
    );
  }
  const name = user.name || user.email || '?';
  const initial = name.trim().charAt(0).toUpperCase();
  return (
    <span
      className={cn(
        'inline-flex items-center justify-center rounded-full font-semibold text-white shrink-0',
        className,
      )}
      style={{
        width: size,
        height: size,
        fontSize: size * 0.42,
        backgroundColor: avatarColor(user.id || name),
      }}
      title={name}
    >
      {initial}
    </span>
  );
}

/** Deterministic HSL color picker — same id always returns the same color. */
function avatarColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  // Keep saturation/lightness in a band that's readable on dark + light text.
  return `hsl(${Math.abs(h) % 360}, 62%, 52%)`;
}

/**
 * Due date chip — renders the date relative to now. Red if overdue, amber
 * if due within 48h, muted otherwise.
 */
export function DueDateChip({
  dueDate,
  done = false,
  className,
}: {
  dueDate: string | Date | null | undefined;
  done?: boolean;
  className?: string;
}): JSX.Element | null {
  if (!dueDate) return null;
  const d = typeof dueDate === 'string' ? new Date(dueDate) : dueDate;
  const now = new Date();
  const diffMs = d.getTime() - now.getTime();
  const days = Math.round(diffMs / 86_400_000);

  let label: string;
  if (days < -1) label = `${-days}d overdue`;
  else if (days === -1) label = 'yesterday';
  else if (days === 0) label = 'today';
  else if (days === 1) label = 'tomorrow';
  else if (days < 7) label = `${days}d`;
  else label = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

  const overdue = !done && diffMs < 0;
  const soon = !done && !overdue && days <= 2;

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium whitespace-nowrap',
        done && 'bg-muted text-muted-foreground line-through',
        overdue && 'bg-status-blocked/20 text-status-blocked',
        soon && 'bg-priority-high/20 text-priority-high',
        !done && !overdue && !soon && 'bg-muted text-muted-foreground',
        className,
      )}
      title={d.toLocaleString()}
    >
      <svg className="h-2.5 w-2.5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M8 2v3M16 2v3M3.5 9h17M5 6h14a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      </svg>
      {label}
    </span>
  );
}

/**
 * Blocked badge — small red chip, only renders if the task is blocked.
 */
export function BlockedBadge({ blocked, className }: { blocked: boolean; className?: string }): JSX.Element | null {
  if (!blocked) return null;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide bg-status-blocked/20 text-status-blocked',
        className,
      )}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-status-blocked" aria-hidden="true" />
      Blocked
    </span>
  );
}

/**
 * At-risk badge — surfaced when the AI blocker-prediction cron flagged the task.
 * Hover/title shows the predicted reason. Doesn't render when no prediction.
 */
export function AtRiskBadge({
  reason,
  className,
}: {
  reason: string | null | undefined;
  className?: string;
}): JSX.Element | null {
  if (!reason) return null;
  return (
    <span
      title={reason}
      className={cn(
        'inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide bg-priority-high/15 text-priority-high',
        className,
      )}
    >
      <span aria-hidden="true">⚠</span>
      At risk
    </span>
  );
}
