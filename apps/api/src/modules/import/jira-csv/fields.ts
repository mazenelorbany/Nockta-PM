// =============================================================================
// jira-csv/fields.ts (Pass D)
//
// Field descriptors for the Jira CSV importer. Mirrors the shape of every
// other adapter's `fields` export so the controller can fan them out via
// one consistent endpoint:
//
//   import { fields as jiraCsvFields } from './jira-csv/fields';
//
// Jira's export uses stable column names ("Summary", "Issue Type", "Labels",
// …) so the descriptors are hard-coded here rather than inferred at parse
// time. Multi-value columns (Labels, Components, Sprint) come back as
// duplicate headers and are collapsed into a single key by the parser.
// =============================================================================

import type { ImportSourceField } from '../adapter.types';

export const fields: readonly ImportSourceField[] = [
  {
    sourceKey: 'Issue key',
    label: 'Issue key',
    requiredFor: 'always',
  },
  {
    sourceKey: 'Summary',
    label: 'Summary',
    requiredFor: 'always',
    defaultTargetField: 'title',
  },
  {
    sourceKey: 'Description',
    label: 'Description',
    requiredFor: 'optional',
    defaultTargetField: 'description',
  },
  {
    sourceKey: 'Status',
    label: 'Status',
    requiredFor: 'optional',
    defaultTargetField: 'status',
  },
  {
    sourceKey: 'Priority',
    label: 'Priority',
    requiredFor: 'optional',
    defaultTargetField: 'priority',
  },
  {
    sourceKey: 'Issue Type',
    label: 'Issue Type',
    requiredFor: 'optional',
    defaultTargetField: 'type',
  },
  {
    sourceKey: 'Assignee',
    label: 'Assignee (display name)',
    requiredFor: 'optional',
  },
  {
    sourceKey: 'Assignee Email',
    label: 'Assignee email',
    requiredFor: 'optional',
    defaultTargetField: 'assigneeEmail',
  },
  {
    sourceKey: 'Reporter',
    label: 'Reporter',
    requiredFor: 'optional',
  },
  {
    sourceKey: 'Created',
    label: 'Created',
    requiredFor: 'optional',
  },
  {
    sourceKey: 'Updated',
    label: 'Updated',
    requiredFor: 'optional',
  },
  {
    sourceKey: 'Due date',
    label: 'Due date',
    requiredFor: 'optional',
    defaultTargetField: 'dueDate',
  },
  {
    sourceKey: 'Labels',
    label: 'Labels (may repeat)',
    requiredFor: 'optional',
    defaultTargetField: 'labels',
  },
] as const;
