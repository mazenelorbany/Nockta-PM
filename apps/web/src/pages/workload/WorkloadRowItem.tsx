import { cn } from '@nockta/ui';

import { AvatarCircle } from '../../components/task-bits';

import { Sparkline } from './Sparkline';
import type { WorkloadRow } from './types';

export function WorkloadRowItem({
  row,
  maxLoad,
  onOpen,
}: {
  row: WorkloadRow;
  maxLoad: number;
  onOpen: () => void;
}): JSX.Element {
  const widthPct = (row.loadScore / maxLoad) * 100;
  // Stacked bar — split widthPct across priorities proportional to their counts.
  const total = row.total || 1;
  const segments: { key: keyof WorkloadRow['byPriority']; color: string }[] = [
    { key: 'Critical', color: 'bg-priority-critical' },
    { key: 'High', color: 'bg-priority-high' },
    { key: 'Medium', color: 'bg-priority-medium' },
    { key: 'Low', color: 'bg-priority-low' },
  ];

  return (
    <li
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      className="cv-comment grid grid-cols-[200px_1fr_220px] gap-4 items-center rounded-lg border border-border bg-card/40 px-4 py-3 cursor-pointer hover:bg-card/70 hover:border-brand/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 transition-colors"
    >
      <div className="flex items-center gap-2 min-w-0">
        {row.user ? (
          <>
            <AvatarCircle user={row.user} size={26} />
            <div className="min-w-0">
              <p className="text-sm font-medium truncate">{row.user.name}</p>
              <p className="text-[10px] text-muted-foreground truncate">{row.user.email}</p>
            </div>
          </>
        ) : (
          <span className="text-sm text-muted-foreground">Unknown</span>
        )}
      </div>

      <div>
        <div className="h-3 rounded-full bg-secondary/50 overflow-hidden flex">
          {segments.map((s) => {
            const count = row.byPriority[s.key];
            if (count === 0) return null;
            const pct = (count / total) * widthPct;
            return (
              <div
                key={s.key}
                className={cn(s.color)}
                style={{ width: `${pct}%` }}
                title={`${s.key}: ${count}`}
              />
            );
          })}
        </div>
        <div className="mt-1 flex items-center gap-2 text-[10px] text-muted-foreground">
          {segments.map((s) => row.byPriority[s.key] > 0 && (
            <span key={s.key} className="inline-flex items-center gap-1">
              <span className={cn('h-1.5 w-1.5 rounded-full', s.color)} />
              {s.key} {row.byPriority[s.key]}
            </span>
          ))}
        </div>
      </div>

      <div className="flex items-center justify-end gap-3">
        <Sparkline series={row.series ?? [row.total]} />
        <div className="text-right text-xs">
          <p className="font-semibold tabular-nums">{row.total} open</p>
          <p className="text-muted-foreground tabular-nums">{row.points} pts · load {row.loadScore}</p>
        </div>
      </div>
    </li>
  );
}
