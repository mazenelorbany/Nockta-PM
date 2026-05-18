import { cn } from '@nockta/ui';

export function FacetGroup({
  title,
  entries,
  selected,
  onToggle,
}: {
  title: string;
  entries: { value: string; label: string; count: number }[];
  selected: Set<string>;
  onToggle: (value: string) => void;
}): JSX.Element | null {
  if (entries.length === 0) return null;
  return (
    <div>
      <div className="nockta-eyebrow text-muted-foreground/70 mb-1.5">{title}</div>
      <ul className="space-y-0.5">
        {entries.slice(0, 12).map((e) => {
          const isOn = selected.has(e.value);
          return (
            <li key={e.value}>
              <label
                className={cn(
                  'flex items-center gap-2 cursor-pointer rounded px-1.5 py-0.5 hover:bg-accent/40 transition-colors',
                  isOn && 'bg-accent/30',
                )}
              >
                <input
                  type="checkbox"
                  checked={isOn}
                  onChange={() => onToggle(e.value)}
                  className="h-3 w-3 accent-brand"
                />
                <span className="flex-1 truncate text-foreground/90">{e.label}</span>
                <span className="text-muted-foreground tabular-nums text-[10px]">{e.count}</span>
              </label>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
