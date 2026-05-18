import { History, Power, Trash2, Zap } from 'lucide-react';
import { cn } from '@nockta/ui';
import type { Automation, Label } from './types';
import { humanizeAction, humanizeTrigger, timeAgo } from './utils';

// ============================================================================
// AutomationRow
// ============================================================================

export function AutomationRow({
  automation,
  labels,
  userMap,
  onToggle,
  onDelete,
  onShowRuns,
}: {
  automation: Automation;
  labels: Label[];
  userMap: Map<string, string>;
  onToggle: (enabled: boolean) => void;
  onDelete: () => void;
  onShowRuns: () => void;
}): JSX.Element {
  return (
    <li
      className={cn(
        'group relative overflow-hidden rounded-xl border bg-card/60 px-4 sm:px-5 py-4 transition-all hover:border-primary/40',
        !automation.enabled && 'opacity-60'
      )}
    >
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 sm:gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Zap className={cn('h-4 w-4', automation.enabled ? 'text-primary' : 'text-muted-foreground')} />
            <h3 className="truncate text-sm font-semibold">{automation.name}</h3>
            {!automation.enabled && (
              <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase text-muted-foreground">Paused</span>
            )}
          </div>
          {automation.description && (
            <p className="mt-1 text-xs text-muted-foreground">{automation.description}</p>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px]">
            <span className="rounded-md bg-muted/50 px-2 py-1 font-mono uppercase text-muted-foreground">When</span>
            <code className="rounded-md bg-primary/10 px-2 py-1 font-mono text-primary">
              {humanizeTrigger(automation.trigger, automation.triggerConfig, labels, userMap)}
            </code>
            <span className="rounded-md bg-muted/50 px-2 py-1 font-mono uppercase text-muted-foreground">Then</span>
            <code className="rounded-md bg-accent/20 px-2 py-1 font-mono">
              {humanizeAction(automation.action, automation.actionConfig, labels, userMap)}
            </code>
          </div>
          <div className="mt-3 flex items-center gap-4 text-[11px] text-muted-foreground">
            <span>Ran <strong className="text-foreground">{automation.runCount}</strong> {automation.runCount === 1 ? 'time' : 'times'}</span>
            {automation.lastRunAt && (
              <span>Last run {timeAgo(automation.lastRunAt)}</span>
            )}
            <span>by {automation.createdBy.name}</span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={onShowRuns}
            className="rounded-md p-1.5 text-muted-foreground transition hover:bg-muted/60 hover:text-foreground"
            title="Run history"
          >
            <History className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => onToggle(!automation.enabled)}
            className={cn(
              'rounded-md p-1.5 transition',
              automation.enabled
                ? 'text-primary hover:bg-primary/10'
                : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
            )}
            title={automation.enabled ? 'Pause' : 'Resume'}
          >
            <Power className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={onDelete}
            className="rounded-md p-1.5 text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive"
            title="Delete"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </div>
    </li>
  );
}
