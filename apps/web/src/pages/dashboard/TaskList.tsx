import { Link } from 'react-router-dom';

import {
  BlockedBadge, DueDateChip, PriorityDot, StatusPill, TypeBadge,
} from '../../components/task-bits';

import type { MyTask } from './types';

export function TaskList({ tasks }: { tasks: MyTask[] }): JSX.Element {
  return (
    <ul className="space-y-1.5 stagger-list">
      {tasks.map((t) => (
        <li key={t.id} className="stagger-item">
          <Link
            to={
              t.project
                ? `/projects/${t.project.id}/board?task=${t.id}`
                : '#'
            }
            className="tap card-hover flex items-center gap-3 rounded-md border border-border bg-background/40 hover:bg-background hover:border-ring transition-colors px-3 py-2 text-sm group"
          >
            <TypeBadge type={t.type ?? 'Task'} />
            <PriorityDot priority={t.priority} />
            <span className="text-[11px] font-mono text-muted-foreground shrink-0 w-16">
              {t.key}
            </span>
            <span className="flex-1 truncate">{t.title}</span>
            <BlockedBadge blocked={t.isBlocked} />
            <DueDateChip dueDate={t.dueDate} done={t.status === 'Done'} />
            <StatusPill status={t.status} />
          </Link>
        </li>
      ))}
    </ul>
  );
}
