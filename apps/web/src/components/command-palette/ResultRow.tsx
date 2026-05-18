import { cn } from '@nockta/ui';

export function ResultRow({
  active,
  onMouseEnter,
  onClick,
  icon,
  kicker,
  label,
  hint,
  trailing,
}: {
  active: boolean;
  onMouseEnter: () => void;
  onClick: () => void;
  icon: React.ReactNode;
  kicker?: string | undefined;
  label: string;
  hint?: string | undefined;
  trailing?: React.ReactNode;
}): JSX.Element {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        onMouseEnter={onMouseEnter}
        data-no-press
        className={cn(
          'relative w-full text-left px-4 py-2 flex items-center gap-3 transition-colors duration-100',
          active ? 'bg-brand/12 text-foreground' : 'hover:bg-accent/40',
        )}
      >
        {/* Brand-colored left bar on the active row */}
        <span
          className={cn(
            'absolute left-0 top-1/2 -translate-y-1/2 h-6 w-[2px] rounded-r-full bg-brand transition-opacity duration-150',
            active ? 'opacity-100' : 'opacity-0',
          )}
        />
        {icon}
        {kicker && (
          <span className="text-[11px] font-mono text-muted-foreground shrink-0 w-16">
            {kicker}
          </span>
        )}
        <span className="flex-1 min-w-0">
          <span className="text-sm truncate block">{label}</span>
          {hint && (
            <span className="text-[11px] text-muted-foreground truncate block">{hint}</span>
          )}
        </span>
        {trailing}
      </button>
    </li>
  );
}
