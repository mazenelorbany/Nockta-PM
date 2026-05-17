import { useEffect, useRef, useState } from 'react';
import { ValuePill } from './Popover';

export function EstimatePill({
  current,
  onChange,
}: {
  current: number | null;
  onChange: (v: number | null) => void;
}): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string>(current?.toString() ?? '');
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);
  useEffect(() => {
    setDraft(current?.toString() ?? '');
  }, [current]);

  function commit(): void {
    const trimmed = draft.trim();
    if (trimmed === '') {
      if (current !== null) onChange(null);
    } else {
      const n = Number(trimmed);
      if (Number.isFinite(n) && n >= 0 && n !== current) onChange(n);
    }
    setEditing(false);
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        type="number"
        min={0}
        step={1}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          }
          if (e.key === 'Escape') {
            setDraft(current?.toString() ?? '');
            setEditing(false);
          }
        }}
        className="field text-xs py-1 w-24"
        placeholder="—"
      />
    );
  }
  return (
    <ValuePill
      onClick={() => setEditing(true)}
      leading={null}
      muted={current === null}
      showCaret={false}
    >
      {current === null ? 'Add estimate' : `${current} ${current === 1 ? 'unit' : 'units'}`}
    </ValuePill>
  );
}
