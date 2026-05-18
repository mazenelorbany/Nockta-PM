import { Target } from 'lucide-react';

export function EmptyState({ onCreate }: { onCreate: () => void }): JSX.Element {
  return (
    <div className="rounded-lg border border-dashed border-border bg-card/30 p-12 text-center">
      <Target className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
      <h2 className="text-lg font-medium">No goals yet</h2>
      <p className="text-sm text-muted-foreground mt-1 max-w-md mx-auto">
        Goals capture what you're trying to achieve. Link tasks to them and the bar moves
        automatically as work gets done.
      </p>
      <button
        type="button"
        onClick={onCreate}
        className="mt-5 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 transition-opacity"
      >
        Create your first goal
      </button>
    </div>
  );
}
