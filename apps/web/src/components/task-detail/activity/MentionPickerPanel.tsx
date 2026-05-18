import type { UserListItem } from './types';

// =============================================================================
// MentionPickerPanel — minimal @mention typeahead. Includes a synthetic
// "here" option at the top that inserts the literal `@here` marker the
// server-side comments service expands to a watchers fan-out.
// =============================================================================

export function MentionPickerPanel({
  users,
  loading,
  onPick,
  onClose,
}: {
  users: UserListItem[];
  loading: boolean;
  onPick: (item: { kind: 'here' } | { kind: 'user'; user: UserListItem }) => void;
  onClose: () => void;
}): JSX.Element {
  return (
    <div
      className="absolute z-20 top-full left-0 mt-1 w-64 rounded-md border border-border bg-card shadow-md p-1"
      onMouseLeave={onClose}
    >
      <ul className="max-h-64 overflow-auto">
        {/* @here pinned at the top — corresponds to the server-side @here
            expansion that notifies every watcher of the task. */}
        <li>
          <button
            type="button"
            onClick={() => onPick({ kind: 'here' })}
            className="w-full text-left rounded-sm px-2 py-1.5 text-xs hover:bg-accent flex items-center gap-2"
          >
            <span className="rounded-full bg-brand text-brand-foreground px-1.5 py-0.5 text-[10px] font-semibold">@here</span>
            <span className="text-muted-foreground">Notify everyone watching this task</span>
          </button>
        </li>
        <li className="my-1 mx-2 h-px bg-border" />
        {loading ? (
          <li className="px-2 py-1.5 text-xs text-muted-foreground">Loading…</li>
        ) : users.length === 0 ? (
          <li className="px-2 py-1.5 text-xs text-muted-foreground">No users.</li>
        ) : (
          users.slice(0, 25).map((u) => (
            <li key={u.id}>
              <button
                type="button"
                onClick={() => onPick({ kind: 'user', user: u })}
                className="w-full text-left rounded-sm px-2 py-1.5 text-xs hover:bg-accent flex items-center gap-2"
              >
                <span className="truncate">{u.name}</span>
                <span className="ml-auto truncate text-muted-foreground text-[10px]">{u.email}</span>
              </button>
            </li>
          ))
        )}
      </ul>
    </div>
  );
}
