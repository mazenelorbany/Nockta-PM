import { Plus, Zap } from 'lucide-react';

export function EmptyState({ onCreate }: { onCreate: () => void }): JSX.Element {
  return (
    <div className="rounded-xl border border-dashed border-border bg-card/30 p-12 text-center">
      <Zap className="mx-auto h-8 w-8 text-muted-foreground" />
      <h3 className="mt-3 text-base font-semibold">No automations yet</h3>
      <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
        Set up "when this, do that" rules — auto-assign tasks, post status comments, escalate blockers without lifting a finger.
      </p>
      <button
        type="button"
        onClick={onCreate}
        className="mt-4 inline-flex items-center gap-2 rounded-lg bg-primary px-3.5 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90"
      >
        <Plus className="h-4 w-4" />
        Create your first automation
      </button>
    </div>
  );
}

export function SkeletonList(): JSX.Element {
  return (
    <ul className="space-y-3">
      {[0, 1, 2].map((i) => (
        <li key={i} className="h-24 animate-pulse rounded-xl border border-border bg-card/40" />
      ))}
    </ul>
  );
}
