import { useQuery } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { api } from '../../lib/api';
import { FilterChip } from './FilterChip';
import { FilterPopover, PopoverList, PopoverRow } from './FilterPopover';
import type { CustomFieldDef } from './types';

// =============================================================================
// Custom-field filters — surfaces project-defined select/multiselect/checkbox
// fields so the toolbar can narrow by anything the project defines.
// =============================================================================

export function CustomFieldFilters({
  projectId,
  value,
  onChange,
}: {
  projectId: string;
  value: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
}): JSX.Element | null {
  const fieldsQuery = useQuery({
    queryKey: ['custom-fields', projectId],
    queryFn: () => api.get<CustomFieldDef[]>(`/projects/${projectId}/custom-fields`),
    enabled: Boolean(projectId),
  });
  const filterable = (fieldsQuery.data ?? []).filter((f) =>
    ['select', 'multiselect', 'checkbox'].includes(f.kind),
  );
  if (filterable.length === 0) return null;
  return (
    <>
      {filterable.map((f) => (
        <CustomFieldFilter
          key={f.id}
          field={f}
          value={value[f.id] ?? ''}
          onChange={(v) => {
            const next = { ...value };
            if (v) next[f.id] = v;
            else delete next[f.id];
            onChange(next);
          }}
        />
      ))}
    </>
  );
}

function CustomFieldFilter({
  field,
  value,
  onChange,
}: {
  field: CustomFieldDef;
  value: string;
  onChange: (v: string) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const options =
    field.kind === 'checkbox'
      ? [
          { value: 'true', label: 'Yes' },
          { value: 'false', label: 'No' },
        ]
      : field.options;
  const selectedLabel = options.find((o) => o.value === value)?.label;
  return (
    <>
      <FilterChip
        label={field.name}
        active={Boolean(value)}
        onClick={() => setOpen((o) => !o)}
        triggerRef={triggerRef}
      >
        {selectedLabel && <span className="truncate max-w-[110px]">{selectedLabel}</span>}
      </FilterChip>
      <FilterPopover
        open={open}
        onClose={() => setOpen(false)}
        triggerRef={triggerRef}
      >
        <PopoverList>
          <PopoverRow
            selected={!value}
            onClick={() => {
              onChange('');
              setOpen(false);
            }}
          >
            <span>{field.kind === 'checkbox' ? 'Any' : `All ${field.name.toLowerCase()}`}</span>
          </PopoverRow>
          {options.map((o) => (
            <PopoverRow
              key={o.value}
              selected={value === o.value}
              onClick={() => {
                onChange(o.value);
                setOpen(false);
              }}
            >
              <span>{o.label}</span>
            </PopoverRow>
          ))}
        </PopoverList>
      </FilterPopover>
    </>
  );
}
