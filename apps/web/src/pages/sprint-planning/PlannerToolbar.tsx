import { ArrowRight, Search, X } from 'lucide-react';

import type { Priority } from '../../components/task-bits';

import { Pill } from './Pill';

export function PlannerToolbar({
  search,
  setSearch,
  assigneeFilter,
  setAssigneeFilter,
  priorityFilter,
  setPriorityFilter,
  assigneeOptions,
  selectedCount,
  onAddSelected,
  addPending,
}: {
  search: string;
  setSearch: (v: string) => void;
  assigneeFilter: string;
  setAssigneeFilter: (v: string) => void;
  priorityFilter: Priority | '';
  setPriorityFilter: (v: Priority | '') => void;
  assigneeOptions: { id: string; name: string }[];
  selectedCount: number;
  onAddSelected: () => void;
  addPending: boolean;
}): JSX.Element {
  return (
    <div className="px-4 sm:px-6 md:px-8 py-3 border-b border-border flex items-center gap-2 flex-wrap">
      <label className="relative flex-1 sm:flex-none">
        <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search tasks…"
          className="h-7 w-full sm:w-64 rounded-md bg-secondary/60 pl-7 pr-2 text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring/50"
        />
      </label>
      <Pill
        label="Assignee"
        value={assigneeFilter}
        onChange={setAssigneeFilter}
        options={[{ value: '', label: 'Anyone' }, ...assigneeOptions.map((u) => ({ value: u.id, label: u.name }))]}
      />
      <Pill
        label="Priority"
        value={priorityFilter}
        onChange={(v) => setPriorityFilter(v as Priority | '')}
        options={[
          { value: '', label: 'All priorities' },
          { value: 'Critical', label: 'Critical' },
          { value: 'High', label: 'High' },
          { value: 'Medium', label: 'Medium' },
          { value: 'Low', label: 'Low' },
        ]}
      />
      {(search || assigneeFilter || priorityFilter) && (
        <button
          type="button"
          onClick={() => {
            setSearch('');
            setAssigneeFilter('');
            setPriorityFilter('');
          }}
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <X className="h-3 w-3" /> Clear
        </button>
      )}
      {selectedCount > 0 && (
        <button
          type="button"
          onClick={onAddSelected}
          disabled={addPending}
          className="ml-auto inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 transition disabled:opacity-50"
        >
          <ArrowRight className="h-3.5 w-3.5" />
          Add {selectedCount} to sprint
        </button>
      )}
    </div>
  );
}
