import { useEffect, useState } from 'react';

export function TitleField({
  value,
  onSave,
}: {
  value: string;
  onSave: (next: string) => void;
}): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  function commit(): void {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== value) onSave(trimmed);
    else setDraft(value);
    setEditing(false);
  }

  if (editing) {
    return (
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          }
          if (e.key === 'Escape') {
            setDraft(value);
            setEditing(false);
          }
        }}
        maxLength={300}
        className="w-full bg-background border border-input rounded-md px-3 py-2 text-2xl font-bold tracking-tight"
      />
    );
  }

  return (
    <h1
      onClick={() => setEditing(true)}
      className="text-2xl font-bold tracking-tight cursor-text hover:bg-accent/30 rounded-md px-3 py-2 -mx-3 transition-colors"
    >
      {value}
    </h1>
  );
}
