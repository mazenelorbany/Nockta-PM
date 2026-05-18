import type { Task } from './types';

export function DateChip({
  task: _task,
  field,
  onSet,
}: {
  task: Task;
  field: 'startDate' | 'dueDate';
  onSet: (iso: string | null) => void;
}): JSX.Element {
  return (
    <label className="text-[10px] text-muted-foreground hover:text-foreground cursor-pointer">
      + {field === 'startDate' ? 'start' : 'due'}
      <input
        type="date"
        className="sr-only"
        onChange={(e) => {
          if (e.target.value) onSet(new Date(e.target.value).toISOString());
        }}
      />
    </label>
  );
}
