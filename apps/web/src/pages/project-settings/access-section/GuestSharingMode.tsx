import { cn } from '@nockta/ui';

export function GuestSharingMode({
  value,
  onChange,
  hasGuests,
}: {
  value: 'internal' | 'client_visible';
  onChange: (v: 'internal' | 'client_visible') => void;
  hasGuests: boolean;
}): JSX.Element {
  // Two clearly-labeled cards rather than a toggle, because the implication
  // ("guests see every task" vs "guests see nothing by default") needs more
  // than a single sentence to land. Card layout keeps the chosen mode
  // visually obvious.
  const opts: {
    value: 'internal' | 'client_visible';
    label: string;
    body: string;
  }[] = [
    {
      value: 'internal',
      label: 'Curated',
      body:
        'Guests only see tasks marked client-visible. Default — picks safer for projects with sensitive internal work alongside client deliverables.',
    },
    {
      value: 'client_visible',
      label: 'Open',
      body:
        'Guests see every task on the project. New tasks default to client-visible. Use this when the whole project IS the client deliverable.',
    },
  ];
  return (
    <div className="rounded-lg border border-border bg-card/40 p-3">
      <div className="flex items-baseline justify-between mb-2">
        <div>
          <div className="text-xs font-semibold tracking-tight">Guest sharing mode</div>
          <p className="text-[11px] text-muted-foreground mt-0.5 leading-relaxed">
            What guests on this project see by default. You can still flip any
            individual task with the visibility toggle in its drawer.
          </p>
        </div>
        {!hasGuests && (
          <span className="text-[10px] text-muted-foreground/60 italic shrink-0 ml-2">
            No guests yet — this setting kicks in when you add one.
          </span>
        )}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {opts.map((opt) => {
          const active = opt.value === value;
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => onChange(opt.value)}
              className={cn(
                'text-left rounded-md border px-3 py-2.5 transition-colors',
                active
                  ? 'border-brand bg-brand/10 ring-1 ring-brand/30'
                  : 'border-border bg-background/40 hover:bg-accent/40 hover:border-foreground/20',
              )}
              aria-pressed={active}
            >
              <div className="flex items-center justify-between mb-1">
                <span
                  className={cn(
                    'text-sm font-semibold',
                    active ? 'text-brand' : 'text-foreground',
                  )}
                >
                  {opt.label}
                </span>
                <span
                  className={cn(
                    'h-3 w-3 rounded-full border',
                    active ? 'border-brand bg-brand' : 'border-border bg-background',
                  )}
                  aria-hidden="true"
                />
              </div>
              <p className="text-[11px] text-muted-foreground leading-relaxed">
                {opt.body}
              </p>
            </button>
          );
        })}
      </div>
    </div>
  );
}
