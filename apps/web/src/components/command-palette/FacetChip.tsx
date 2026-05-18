import { X } from 'lucide-react';

export function FacetChip({
  label,
  onRemove,
}: {
  label: string;
  onRemove: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onRemove}
      className="inline-flex items-center gap-1 rounded-full bg-accent/40 text-foreground border border-border px-2 py-0.5 text-[11px] hover:bg-accent/60 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
      aria-label={`Remove filter ${label}`}
      title="Remove this filter"
    >
      <span>{label}</span>
      <X className="h-2.5 w-2.5 opacity-60" aria-hidden="true" />
    </button>
  );
}
