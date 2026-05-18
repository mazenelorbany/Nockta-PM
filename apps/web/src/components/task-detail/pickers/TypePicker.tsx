import { Check } from 'lucide-react';
import { cn } from '@nockta/ui';

import { TypeBadge, type TaskType } from '../../task-bits';
import { usePopover } from '../utils';

import { PopoverShell, ValuePill } from './Popover';

/**
 * Task type picker (Epic / Story / Task / Bug / Subtask). Inline ValuePill
 * that opens a small list. Subtask is hidden unless the task already has a
 * parent — converting an Epic into a Subtask without a parent fails the
 * server-side hierarchy check, so we don't surface that option.
 */
export function TypePicker({
  current,
  onChange,
}: {
  current: TaskType;
  onChange: (t: TaskType) => void;
}): JSX.Element {
  const pop = usePopover();
  const options: TaskType[] = ['Epic', 'Story', 'Task', 'Bug', 'Subtask'];
  return (
    <div className="relative inline-block">
      <ValuePill open={pop.open} onClick={pop.toggle} leading={null} muted={false}>
        <TypeBadgeFromString type={current} />
      </ValuePill>
      <PopoverShell open={pop.open} onClose={pop.close} align="left" className="p-1 w-40">
        {options.map((opt) => (
          <button
            key={opt}
            type="button"
            onClick={() => {
              if (opt !== current) onChange(opt);
              pop.close();
            }}
            className={cn(
              'tap w-full flex items-center gap-2 rounded px-2 py-1.5 text-xs text-left hover:bg-muted/60',
              opt === current && 'bg-muted/60',
            )}
          >
            <TypeBadgeFromString type={opt} />
            {opt === current && <Check className="h-3 w-3 ml-auto text-primary" />}
          </button>
        ))}
      </PopoverShell>
    </div>
  );
}

export function TypeBadgeFromString({ type }: { type: TaskType }): JSX.Element {
  return <TypeBadge type={type} showLabel />;
}
