import { cn } from '@nockta/ui';

import type { ExportSchedule, SourceKind } from './types';

// =============================================================================
// Schedules table
// =============================================================================

export function SchedulesTable({
  schedules,
  onToggle,
  onDelete,
  onRun,
}: {
  schedules: ExportSchedule[];
  onToggle: (id: string, enabled: boolean) => void;
  onDelete: (id: string, name: string) => void;
  onRun: (id: string) => void;
}): JSX.Element {
  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="w-full text-xs">
        <thead className="bg-background/40 text-muted-foreground">
          <tr>
            <th className="text-left px-3 py-2 font-medium">Name</th>
            <th className="text-left px-3 py-2 font-medium">Kind</th>
            <th className="text-left px-3 py-2 font-medium">Source</th>
            <th className="text-left px-3 py-2 font-medium">Schedule</th>
            <th className="text-left px-3 py-2 font-medium">Last run</th>
            <th className="text-left px-3 py-2 font-medium">Status</th>
            <th className="text-right px-3 py-2 font-medium">Actions</th>
          </tr>
        </thead>
        <tbody>
          {schedules.map((s) => (
            <tr key={s.id} className="border-t border-border/60">
              <td className="px-3 py-2 font-medium">{s.name}</td>
              <td className="px-3 py-2 uppercase tracking-wider text-[10px]">{s.kind}</td>
              <td className="px-3 py-2">
                <SourceLabel sourceKind={s.sourceKind} sourceId={s.sourceId} />
              </td>
              <td className="px-3 py-2 font-mono text-[11px]">
                {s.scheduleCron ?? <span className="text-muted-foreground italic">one-off</span>}
              </td>
              <td className="px-3 py-2 text-muted-foreground">
                {s.lastRunAt ? new Date(s.lastRunAt).toLocaleString() : '—'}
              </td>
              <td className="px-3 py-2">
                <span
                  className={cn(
                    'text-[10px] uppercase tracking-wider rounded px-1.5 py-0.5',
                    s.enabled
                      ? 'bg-status-done/15 text-status-done'
                      : 'bg-muted text-muted-foreground',
                  )}
                >
                  {s.enabled ? 'enabled' : 'disabled'}
                </span>
              </td>
              <td className="px-3 py-2 text-right space-x-1">
                <button
                  type="button"
                  onClick={() => onRun(s.id)}
                  className="rounded border border-border px-2 py-0.5 text-[11px] hover:bg-accent/40 transition-colors"
                >
                  Run now
                </button>
                <button
                  type="button"
                  onClick={() => onToggle(s.id, !s.enabled)}
                  className="rounded border border-border px-2 py-0.5 text-[11px] hover:bg-accent/40 transition-colors"
                >
                  {s.enabled ? 'Disable' : 'Enable'}
                </button>
                <button
                  type="button"
                  onClick={() => onDelete(s.id, s.name)}
                  className="rounded border border-border px-2 py-0.5 text-[11px] hover:bg-destructive/10 hover:text-destructive hover:border-destructive/30 transition-colors"
                >
                  Delete
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SourceLabel({
  sourceKind,
  sourceId,
}: {
  sourceKind: SourceKind;
  sourceId: string | null;
}): JSX.Element {
  if (sourceKind === 'all_tasks') return <span className="text-muted-foreground">All tasks</span>;
  if (sourceKind === 'saved_view')
    return (
      <span>
        Saved view <code className="font-mono text-[10px] text-muted-foreground">{sourceId?.slice(0, 8)}</code>
      </span>
    );
  return (
    <span>
      Project <code className="font-mono text-[10px] text-muted-foreground">{sourceId?.slice(0, 8)}</code>
    </span>
  );
}
