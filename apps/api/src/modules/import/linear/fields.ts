// =============================================================================
// linear/fields.ts (Pass D)
//
// Field descriptors for the Linear importer. Re-exports the original
// LINEAR_SOURCE_FIELDS array under the new pluggable name `fields` so callers
// (controller + frontend) can treat every source the same way:
//
//   import { fields as linearFields } from './linear/fields';
//   import { fields as csvFields } from './csv/fields';
//   import { fields as jiraCsvFields } from './jira-csv/fields';
//
// Each entry conforms to ImportSourceField — see adapter.types.ts.
//
// Adding a new mappable Linear column is a one-line append below; the run
// logic already consults the concrete mapping object via stable keys.
// =============================================================================

import type { ImportSourceField } from '../adapter.types';

export const fields: readonly ImportSourceField[] = [
  {
    sourceKey: 'status.triage',
    label: 'Status: Triage',
    requiredFor: 'optional',
    defaultTargetField: 'status',
  },
  {
    sourceKey: 'status.backlog',
    label: 'Status: Backlog',
    requiredFor: 'optional',
    defaultTargetField: 'status',
  },
  {
    sourceKey: 'status.unstarted',
    label: 'Status: Unstarted',
    requiredFor: 'optional',
    defaultTargetField: 'status',
  },
  {
    sourceKey: 'status.started',
    label: 'Status: Started',
    requiredFor: 'optional',
    defaultTargetField: 'status',
  },
  {
    sourceKey: 'status.completed',
    label: 'Status: Completed',
    requiredFor: 'optional',
    defaultTargetField: 'status',
  },
  {
    sourceKey: 'status.canceled',
    label: 'Status: Canceled',
    requiredFor: 'optional',
    defaultTargetField: 'status',
  },
  // Linear-side identifiers carried over verbatim; not user-mappable but
  // listed so the mapper UI can render them as "read-only" in the left rail.
  { sourceKey: 'identifier', label: 'Identifier', requiredFor: 'always' },
  { sourceKey: 'title', label: 'Title', requiredFor: 'always', defaultTargetField: 'title' },
  { sourceKey: 'description', label: 'Description', requiredFor: 'optional', defaultTargetField: 'description' },
  { sourceKey: 'priority', label: 'Priority', requiredFor: 'optional', defaultTargetField: 'priority' },
  { sourceKey: 'assignee.email', label: 'Assignee (email)', requiredFor: 'optional', defaultTargetField: 'assigneeEmail' },
  { sourceKey: 'labels', label: 'Labels', requiredFor: 'optional', defaultTargetField: 'labels' },
  { sourceKey: 'dueDate', label: 'Due date', requiredFor: 'optional', defaultTargetField: 'dueDate' },
] as const;
