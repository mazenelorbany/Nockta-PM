import { StatusPill } from '../../task-bits';
import { usePopover } from '../utils';

import { PopoverItem, PopoverList, PopoverShell, ValuePill } from './Popover';

export function StatusPicker({
  current,
  options,
  onChange,
}: {
  current: string;
  options: string[];
  onChange: (s: string) => void;
}): JSX.Element {
  const pop = usePopover();
  return (
    <div className="relative inline-block">
      <ValuePill open={pop.open} onClick={pop.toggle} leading={<StatusPill status={current} />} showCaret>
        <span className="sr-only">{current}</span>
      </ValuePill>
      <PopoverShell open={pop.open} onClose={pop.close} align="left">
        <PopoverList>
          {options.map((s) => (
            <PopoverItem
              key={s}
              selected={s === current}
              onClick={() => {
                if (s !== current) onChange(s);
                pop.close();
              }}
            >
              <StatusPill status={s} />
              <span className="text-foreground/90">{s}</span>
            </PopoverItem>
          ))}
        </PopoverList>
      </PopoverShell>
    </div>
  );
}
