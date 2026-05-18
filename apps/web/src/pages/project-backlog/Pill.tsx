import { cn } from '@nockta/ui';

export function Pill({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}): JSX.Element {
  const isActive = value !== '';
  const current = options.find((o) => o.value === value);
  return (
    <label
      className={cn(
        'relative inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs cursor-pointer transition-colors',
        isActive
          ? 'border-brand/40 bg-accent text-foreground'
          : 'border-border bg-secondary/40 hover:bg-secondary text-muted-foreground hover:text-foreground',
      )}
    >
      <span className="nockta-eyebrow text-[0.6rem] opacity-60">{label}</span>
      {isActive && <span className="truncate max-w-[120px]">{current?.label}</span>}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="absolute inset-0 opacity-0 cursor-pointer"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </label>
  );
}
