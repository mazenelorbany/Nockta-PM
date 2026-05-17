import { cn } from '@nockta/ui';
import { usePopover } from '../utils';
import { PopoverItem, PopoverList, PopoverShell, ValuePill } from './Popover';

export function SprintPicker({
  current,
  options,
  onChange,
}: {
  current: { id: string; name: string; state: string } | null;
  options: { id: string; name: string; state: string }[];
  onChange: (id: string | null) => void;
}): JSX.Element {
  const pop = usePopover();
  const sprintLeading = current ? (
    <span
      className={cn(
        'h-1.5 w-1.5 rounded-full',
        current.state === 'active' ? 'bg-brand animate-pulse' : 'bg-muted-foreground/40',
      )}
    />
  ) : (
    <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/30" />
  );
  return (
    <div className="relative inline-block">
      <ValuePill open={pop.open} onClick={pop.toggle} leading={sprintLeading} muted={!current}>
        {current ? current.name : 'Backlog'}
      </ValuePill>
      <PopoverShell open={pop.open} onClose={pop.close} align="left" className="w-64">
        <PopoverList>
          <PopoverItem
            selected={!current}
            onClick={() => {
              if (current) onChange(null);
              pop.close();
            }}
          >
            <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/30" />
            <span className="text-muted-foreground">Backlog</span>
          </PopoverItem>
          {options.map((s) => (
            <PopoverItem
              key={s.id}
              selected={s.id === current?.id}
              onClick={() => {
                if (s.id !== current?.id) onChange(s.id);
                pop.close();
              }}
            >
              <span
                className={cn(
                  'h-1.5 w-1.5 rounded-full',
                  s.state === 'active' ? 'bg-brand' : 'bg-muted-foreground/40',
                )}
              />
              <span className="flex-1 min-w-0 truncate text-foreground/90">{s.name}</span>
              <span className="text-[10px] text-muted-foreground/70 uppercase tracking-wider">
                {s.state}
              </span>
            </PopoverItem>
          ))}
        </PopoverList>
      </PopoverShell>
    </div>
  );
}
