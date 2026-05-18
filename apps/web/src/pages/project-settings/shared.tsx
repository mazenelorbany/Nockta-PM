import { cn } from '@nockta/ui';

export function Section({
  id,
  icon,
  title,
  hint,
  danger,
  children,
}: {
  id?: string;
  icon?: React.ReactNode;
  title: string;
  hint?: string;
  /** Adds a subtle red accent — used for the archive panel. */
  danger?: boolean;
  children: React.ReactNode;
}): JSX.Element {
  // scroll-mt accounts for the page header + ProjectTabs strip so anchor
  // navigation doesn't land with the section title hidden under the chrome.
  return (
    <section id={id} className="scroll-mt-32">
      <div className="mb-4 flex items-start gap-3">
        {icon && (
          <span
            className={cn(
              'mt-0.5 inline-flex h-7 w-7 items-center justify-center rounded-md border',
              danger
                ? 'border-destructive/30 bg-destructive/5 text-destructive'
                : 'border-border bg-card/60 text-muted-foreground',
            )}
            aria-hidden="true"
          >
            {icon}
          </span>
        )}
        <div className="min-w-0">
          <h2 className="text-base font-semibold tracking-tight">{title}</h2>
          {hint && <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{hint}</p>}
        </div>
      </div>
      <div className="space-y-3 pl-0 sm:pl-10">{children}</div>
    </section>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div>
      <div className="nockta-eyebrow text-muted-foreground mb-1">{label}</div>
      {children}
      {hint && <div className="text-[10px] text-muted-foreground mt-1">{hint}</div>}
    </div>
  );
}

export function ToggleRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}): JSX.Element {
  return (
    <label className="flex items-start justify-between gap-4 rounded-md border border-border bg-background/40 px-3 py-2.5 cursor-pointer hover:bg-background/70 transition-colors">
      <div>
        <div className="text-sm font-medium">{label}</div>
        {hint && <div className="text-xs text-muted-foreground mt-0.5">{hint}</div>}
      </div>
      <span
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={cn(
          'relative h-5 w-9 rounded-full transition-colors shrink-0 mt-1',
          checked ? 'bg-brand' : 'bg-muted',
        )}
      >
        <span
          className={cn(
            'absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform',
            checked ? 'translate-x-4' : 'translate-x-0.5',
          )}
        />
      </span>
    </label>
  );
}
