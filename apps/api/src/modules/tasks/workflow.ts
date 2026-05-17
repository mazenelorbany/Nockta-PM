import type { WorkflowPreset } from '@prisma/client';

/** Workflow statuses per preset. Frozen at compile time. */
export const WORKFLOW_STATUSES = {
  engineering: ['Todo', 'In Progress', 'In Review', 'Testing', 'Done'] as const,
  design:      ['Todo', 'In Progress', 'In Review', 'Approved', 'Done'] as const,
  generic:     ['Todo', 'In Progress', 'Done'] as const,
} satisfies Record<WorkflowPreset, readonly string[]>;

export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[WorkflowPreset][number];

export function isValidStatusFor(preset: WorkflowPreset, status: string): boolean {
  return (WORKFLOW_STATUSES[preset] as readonly string[]).includes(status);
}

export function defaultStatusFor(preset: WorkflowPreset): string {
  return WORKFLOW_STATUSES[preset][0];
}

export function doneStatusesFor(preset: WorkflowPreset): readonly string[] {
  // The "terminal" status for parent-completion gating. Engineering/Design/Generic all end in 'Done'.
  if (preset === 'design') return ['Approved', 'Done'];
  return ['Done'];
}
