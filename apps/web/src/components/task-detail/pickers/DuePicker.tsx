import { Calendar as CalendarIcon } from 'lucide-react';
import { cn } from '@nockta/ui';

import { formatDueDisplay, isOverdue, usePopover } from '../utils';

import { PopoverShell, ValuePill } from './Popover';

export function DuePicker({
  current,
  onChange,
}: {
  current: string | null;
  onChange: (iso: string | null) => void;
}): JSX.Element {
  const pop = usePopover();
  const value = current ? current.slice(0, 10) : '';
  const display = formatDueDisplay(current);
  const overdue = isOverdue(current);
  const leading = (
    <CalendarIcon
      className={cn(
        'h-3.5 w-3.5',
        overdue ? 'text-status-blocked' : 'text-muted-foreground/70',
      )}
    />
  );
  return (
    <div className="relative inline-block">
      <ValuePill open={pop.open} onClick={pop.toggle} leading={leading} muted={!current}>
        <span className={cn(overdue && 'text-status-blocked')}>{display}</span>
      </ValuePill>
      <PopoverShell open={pop.open} onClose={pop.close} align="left" className="p-3 w-60">
        <label className="text-[10px] uppercase tracking-wider text-muted-foreground/80 font-mono">
          Due date
        </label>
        <input
          type="date"
          autoFocus
          value={value}
          onChange={(e) => {
            const v = e.target.value;
            onChange(v ? new Date(v).toISOString() : null);
          }}
          className="field mt-2 text-xs py-1.5"
        />
        {current && (
          <button
            type="button"
            onClick={() => {
              onChange(null);
              pop.close();
            }}
            className="tap mt-3 w-full text-xs text-muted-foreground hover:text-status-blocked transition-colors"
          >
            Clear due date
          </button>
        )}
      </PopoverShell>
    </div>
  );
}
