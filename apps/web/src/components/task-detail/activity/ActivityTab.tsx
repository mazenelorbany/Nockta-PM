import { cn } from '@nockta/ui';

export function ActivityTab({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex-1 px-4 py-2.5 text-xs font-medium transition-colors border-b-2',
        active
          ? 'text-foreground border-primary'
          : 'text-muted-foreground border-transparent hover:text-foreground hover:bg-muted/30'
      )}
    >
      {label}
    </button>
  );
}
