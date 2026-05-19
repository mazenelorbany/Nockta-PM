import { ChevronDown } from 'lucide-react';
import { cn } from '@nockta/ui';

// =============================================================================
// Filter chip — the trigger button for every filter popover. Visually matches
// the old FilterSelect (border, label eyebrow, value slot) but is a real
// button so it doesn't have the cropped-native-select behavior.
// =============================================================================

export function FilterChip({
  label,
  active,
  onClick,
  children,
  triggerRef,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  triggerRef?: React.RefObject<HTMLButtonElement | null>;
}): JSX.Element {
  return (
    <button
      ref={triggerRef}
      type="button"
      onClick={onClick}
      className={cn(
        'tap relative inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs cursor-pointer transition-colors',
        active
          ? 'border-brand/40 bg-accent text-foreground'
          : 'border-border bg-secondary/40 hover:bg-secondary text-muted-foreground hover:text-foreground',
      )}
    >
      <span className="nockta-eyebrow text-[0.6rem] opacity-60">{label}</span>
      <span className="flex items-center gap-1.5">{children}</span>
      <ChevronDown className="h-3 w-3 opacity-50" />
    </button>
  );
}

export function ToggleChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'tap inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium transition-colors',
        active
          ? 'border-brand/40 bg-accent text-foreground'
          : 'border-border bg-secondary/40 hover:bg-secondary text-muted-foreground hover:text-foreground',
      )}
    >
      {children}
    </button>
  );
}
