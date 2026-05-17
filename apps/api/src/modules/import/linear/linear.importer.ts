// =============================================================================
// linear/linear.importer.ts (Pass D split)
//
// The thick LinearImportService still lives in `../linear-import.service.ts` —
// this file is the small adapter-descriptor companion that the new mapper UI
// reads to render the source-side of the column → field grid. The split keeps
// the public Adapter contract pluggable without dragging the Linear GraphQL
// machinery through every importer that needs to advertise its source fields.
//
// Frontend flow:
//   1. UI POSTs to /import/adapters; the controller returns one descriptor
//      array per source.
//   2. The mapper UI renders the "Source column" left rail from those
//      descriptors; the right rail is the fixed Nockta-field list.
//   3. The user's overrides flow back into the source service's `mapping`
//      param so the existing run logic doesn't need to know the UI changed.
//
// Adding a new Linear source field is a one-line append below — no controller
// or service changes required, because the run logic already consults the
// concrete mapping object via known keys.
// =============================================================================

import type { ImportSourceFieldDescriptor } from '../adapter.types';

/**
 * Source-side fields the Linear adapter can read. The `key` is what the run
 * logic accepts inside `mapping.statusByType` (or a sibling override map);
 * the `label` is what the UI renders.
 *
 * NB: kept narrow on purpose — only fields whose mapping the user can
 * actually override are listed here. Read-only carried-over fields (e.g.
 * `identifier`, `title`) are not in the mapper UI; they have a fixed
 * destination.
 */
export const LINEAR_SOURCE_FIELDS: readonly ImportSourceFieldDescriptor[] = [
  {
    key: 'status.triage',
    label: 'Status: Triage',
    description: 'Linear state.type=triage — what to map to in Nockta.',
    sample: 'Triage',
    suggestedFieldKey: 'status',
  },
  {
    key: 'status.backlog',
    label: 'Status: Backlog',
    description: 'Linear state.type=backlog.',
    sample: 'Backlog',
    suggestedFieldKey: 'status',
  },
  {
    key: 'status.unstarted',
    label: 'Status: Unstarted',
    description: 'Linear state.type=unstarted.',
    sample: 'Todo',
    suggestedFieldKey: 'status',
  },
  {
    key: 'status.started',
    label: 'Status: Started',
    description: 'Linear state.type=started.',
    sample: 'In Progress',
    suggestedFieldKey: 'status',
  },
  {
    key: 'status.completed',
    label: 'Status: Completed',
    description: 'Linear state.type=completed.',
    sample: 'Done',
    suggestedFieldKey: 'status',
  },
  {
    key: 'status.canceled',
    label: 'Status: Canceled',
    description: 'Linear state.type=canceled.',
    sample: 'Done',
    suggestedFieldKey: 'status',
  },
] as const;

export type LinearSourceFieldDescriptor = (typeof LINEAR_SOURCE_FIELDS)[number];
