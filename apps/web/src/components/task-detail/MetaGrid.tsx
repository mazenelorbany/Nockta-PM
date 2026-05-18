import { useQuery } from '@tanstack/react-query';
import {
  Calendar as CalendarIcon,
  Clock,
  CircleDot,
  Flag,
  Hash,
  Layers,
  Link2 as Link2Icon,
  Tag as TagIcon,
  Timer,
  User as UserIcon,
} from 'lucide-react';

import { api } from '../../lib/api';
import { AvatarCircle, type Priority, type TaskType } from '../task-bits';

import { PRESET_STATUSES } from './constants';
import { LabelsPicker } from './Labels';
import { AssigneePicker } from './pickers/AssigneePicker';
import { DateRangePicker } from './pickers/DateRangePicker';
import { EstimatePill } from './pickers/EstimatePill';
import { ParentPicker } from './pickers/ParentPicker';
import { AiWhyChip, PriorityPicker } from './pickers/PriorityPicker';
import { ReportersPicker } from './pickers/ReportersPicker';
import { SprintPicker } from './pickers/SprintPicker';
import { StatusPicker } from './pickers/StatusPicker';
import { TimeTrackedCompact } from './TimeTracking';
import { TypePicker } from './pickers/TypePicker';
import type { TaskDetail, User } from './types';
import { formatRelative } from './utils';

export function MetaGrid({
  task,
  users,
  onStatusChange,
  onPatch,
}: {
  task: TaskDetail;
  users: User[];
  onStatusChange: (s: string) => void;
  onPatch: (p: {
    type?: TaskType;
    priority?: Priority;
    assigneeUserId?: string | null;
    reporterUserId?: string;
    startDate?: string | null;
    dueDate?: string | null;
    estimate?: number | null;
    sprintId?: string | null;
    parentTaskId?: string | null;
  }) => void;
}): JSX.Element {
  const statuses = PRESET_STATUSES[task.project.workflowPreset];

  const sprintsQuery = useQuery({
    queryKey: ['sprints', task.projectId],
    queryFn: () => api.get<{ id: string; name: string; state: string }[]>(
      `/projects/${task.projectId}/sprints`,
    ),
  });
  const reportersQuery = useQuery({
    queryKey: ['reporters', task.id],
    queryFn: () => api.get<{ user: User; addedAt: string }[]>(`/tasks/${task.id}/reporters`),
  });

  const sprints = sprintsQuery.data ?? [];
  const assignee = users.find((u) => u.id === task.assigneeUserId) ?? null;
  const reporter = users.find((u) => u.id === task.reporterUserId) ?? null;
  const sprint = sprints.find((s) => s.id === task.sprintId) ?? null;
  const coReporters = reportersQuery.data ?? [];

  return (
    <div className="rounded-lg border border-border/70 bg-background/40 overflow-hidden">
      {/* Two-column compact meta grid — ClickUp-style. On narrow viewports it
          collapses to a single column. */}
      <div className="grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-border/60">
        {/* Left column */}
        <div className="divide-y divide-border/60">
          <RailRow icon={<CircleDot className="h-3.5 w-3.5 text-muted-foreground/70" />} label="Status">
            <StatusPicker current={task.status} options={statuses} onChange={onStatusChange} />
          </RailRow>
          <RailRow icon={<CalendarIcon className="h-3.5 w-3.5 text-muted-foreground/70" />} label="Dates">
            <DateRangePicker
              start={task.startDate ?? null}
              due={task.dueDate ?? null}
              onChange={(p) => onPatch(p)}
            />
          </RailRow>
          <RailRow icon={<Hash className="h-3.5 w-3.5 text-muted-foreground/70" />} label="Type">
            <TypePicker current={task.type ?? 'Task'} onChange={(t) => onPatch({ type: t })} />
          </RailRow>
          <RailRow icon={<Clock className="h-3.5 w-3.5 text-muted-foreground/70" />} label="Estimate">
            <EstimatePill current={task.estimate ?? null} onChange={(v) => onPatch({ estimate: v })} />
          </RailRow>
          <RailRow icon={<UserIcon className="h-3.5 w-3.5 text-muted-foreground/70" />} label="Reporters">
            <ReportersPicker
              taskId={task.id}
              primary={reporter}
              coReporters={coReporters.map((c) => c.user)}
              users={users}
              onChangePrimary={(id) => onPatch({ reporterUserId: id })}
            />
          </RailRow>
          <RailRow icon={<TagIcon className="h-3.5 w-3.5 text-muted-foreground/70" />} label="Labels">
            <LabelsPicker taskId={task.id} projectId={task.projectId} />
          </RailRow>
        </div>
        {/* Right column */}
        <div className="divide-y divide-border/60">
          <RailRow icon={<UserIcon className="h-3.5 w-3.5 text-muted-foreground/70" />} label="Assignee">
            <AssigneePicker
              current={assignee}
              users={users}
              onChange={(id) => onPatch({ assigneeUserId: id })}
            />
          </RailRow>
          <RailRow icon={<Flag className="h-3.5 w-3.5 text-muted-foreground/70" />} label="Priority">
            <div className="flex items-center gap-1.5 w-full">
              <PriorityPicker current={task.priority} onChange={(p) => onPatch({ priority: p })} />
              {/* AI rationale tooltip — only renders when the priority was
                  set by the auto-prioritization processor. Title attribute
                  is enough for an accessible hover-tooltip; if it grows
                  long, swap for a popover (deferred). */}
              {task.aiPriorityReason && (
                <AiWhyChip
                  reason={task.aiPriorityReason}
                  factors={task.aiPriorityFactors}
                  triageExplanation={task.aiTriageExplanation}
                />
              )}
            </div>
          </RailRow>
          <RailRow icon={<Layers className="h-3.5 w-3.5 text-muted-foreground/70" />} label="Sprint">
            <SprintPicker
              current={sprint}
              options={sprints}
              onChange={(id) => onPatch({ sprintId: id })}
            />
          </RailRow>
          <RailRow icon={<Timer className="h-3.5 w-3.5 text-muted-foreground/70" />} label="Time tracked">
            <TimeTrackedCompact taskId={task.id} estimateHours={task.estimate ?? null} />
          </RailRow>
          <RailRow icon={<Link2Icon className="h-3.5 w-3.5 text-muted-foreground/70" />} label="Parent">
            <ParentPicker
              taskId={task.id}
              projectId={task.projectId}
              current={task.parent ?? null}
              onChange={(id) => onPatch({ parentTaskId: id })}
            />
          </RailRow>
        </div>
      </div>
    </div>
  );
}

/* -----------------------------------------------------------------------------
 * Field rail — replaces the old <MetaRow> grid pattern. Single-column rows
 * with hairline dividers; the value-pill on the right is the entire affordance.
 * Hover the row, not the value, to invite editing without flashing chrome.
 * -------------------------------------------------------------------------- */

export function RailRow({
  icon,
  label,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="field-cell flex items-center gap-3 px-3 py-2 min-h-[40px]">
      <span className="flex items-center gap-2 w-24 shrink-0 text-xs text-muted-foreground">
        {icon}
        {label}
      </span>
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  );
}

export function ReporterRow({ task, users }: { task: TaskDetail; users: User[] }): JSX.Element {
  const reporter = users.find((u) => u.id === task.reporterUserId);
  return (
    <div className="flex items-center justify-between gap-4 text-xs text-muted-foreground border-t border-border pt-3">
      <div className="flex items-center gap-2">
        <span className="nockta-eyebrow">Reported by</span>
        <span className="flex items-center gap-1.5 text-foreground">
          <AvatarCircle user={reporter ?? null} size={18} />
          {reporter?.name ?? reporter?.email ?? 'Unknown'}
        </span>
      </div>
      <div className="flex items-center gap-4">
        <span><span className="nockta-eyebrow">Created</span> · {new Date(task.createdAt).toLocaleDateString()}</span>
        <span><span className="nockta-eyebrow">Updated</span> · {formatRelative(task.updatedAt)}</span>
      </div>
    </div>
  );
}
