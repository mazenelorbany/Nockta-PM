import { Calendar as CalendarIcon } from 'lucide-react';
import { cn } from '@nockta/ui';
import { isOverdue, usePopover } from '../utils';
import { PopoverShell, ValuePill } from './Popover';

// =============================================================================
// New compact pickers introduced with the modal redesign.
// =============================================================================

/**
 * Combined start+due date picker. Single chip shows "Mar 4 → Mar 8" or just one
 * side if only one is set. Popover has both fields side-by-side.
 */
export function DateRangePicker({
  start,
  due,
  onChange,
}: {
  start: string | null;
  due: string | null;
  onChange: (p: { startDate?: string | null; dueDate?: string | null }) => void;
}): JSX.Element {
  const pop = usePopover();
  const startVal = start ? start.slice(0, 10) : '';
  const dueVal = due ? due.slice(0, 10) : '';
  const overdue = isOverdue(due);

  const display = (() => {
    if (!start && !due) return 'Empty';
    const fmt = (iso: string | null): string => {
      if (!iso) return '—';
      const d = new Date(iso);
      return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    };
    if (start && due) return `${fmt(start)} → ${fmt(due)}`;
    if (start) return `Starts ${fmt(start)}`;
    return `Due ${fmt(due)}`;
  })();

  return (
    <div className="relative inline-block">
      <ValuePill
        open={pop.open}
        onClick={pop.toggle}
        leading={<CalendarIcon className={cn('h-3.5 w-3.5', overdue ? 'text-status-blocked' : 'text-muted-foreground/70')} />}
        muted={!start && !due}
      >
        <span className={cn(overdue && 'text-status-blocked')}>{display}</span>
      </ValuePill>
      <PopoverShell open={pop.open} onClose={pop.close} align="left" className="p-3 w-72">
        <div className="space-y-2">
          <label className="block">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground/80 font-mono">Start date</span>
            <input
              type="date"
              value={startVal}
              onChange={(e) => onChange({ startDate: e.target.value ? new Date(e.target.value).toISOString() : null })}
              className="field mt-1 text-xs py-1.5 w-full"
            />
          </label>
          <label className="block">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground/80 font-mono">Due date</span>
            <input
              type="date"
              value={dueVal}
              onChange={(e) => onChange({ dueDate: e.target.value ? new Date(e.target.value).toISOString() : null })}
              className="field mt-1 text-xs py-1.5 w-full"
            />
          </label>
          {(start || due) && (
            <button
              type="button"
              onClick={() => {
                onChange({ startDate: null, dueDate: null });
                pop.close();
              }}
              className="tap mt-1 w-full text-xs text-muted-foreground hover:text-status-blocked transition-colors"
            >
              Clear both
            </button>
          )}
        </div>
      </PopoverShell>
    </div>
  );
}
