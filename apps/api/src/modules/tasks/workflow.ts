import type { WorkflowPreset } from '@prisma/client';

/** Workflow statuses per preset. Frozen at compile time. */
export const WORKFLOW_STATUSES = {
  engineering: ['Todo', 'In Progress', 'In Review', 'Testing', 'Done'] as const,
  design:      ['Todo', 'In Progress', 'In Review', 'Approved', 'Done'] as const,
  generic:     ['Todo', 'In Progress', 'Done'] as const,
} satisfies Record<WorkflowPreset, readonly string[]>;

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

/**
 * Default allowed (from → to) transition edges per workflow preset. Mirrors
 * the backfill in migration 0028; kept here in TypeScript so the project-
 * creation path can seed the same edges for new projects without re-running
 * SQL, and so the "Reset to defaults" admin action has a single source of
 * truth.
 *
 * Shape is linear-with-reopen:
 *   • Each step forward + the reverse step is allowed (so an accidental
 *     "In Progress" can be moved back to Todo).
 *   • The terminal Done can be reopened to the immediately preceding
 *     status AND back to In Progress, since reopening a closed item to
 *     "needs more work" is the common case.
 *
 * Notably the graph does NOT include Todo → Done — this is the constraint
 * the feature was built for. Admins who want that edge can author it
 * explicitly from the settings UI.
 */
export function defaultTransitionsFor(
  preset: WorkflowPreset,
): ReadonlyArray<readonly [from: string, to: string]> {
  if (preset === 'engineering') {
    return [
      ['Todo', 'In Progress'],
      ['In Progress', 'Todo'],
      ['In Progress', 'In Review'],
      ['In Review', 'In Progress'],
      ['In Review', 'Testing'],
      ['Testing', 'In Review'],
      ['Testing', 'Done'],
      ['Done', 'Testing'],
      ['Done', 'In Progress'],
    ];
  }
  if (preset === 'design') {
    return [
      ['Todo', 'In Progress'],
      ['In Progress', 'Todo'],
      ['In Progress', 'In Review'],
      ['In Review', 'In Progress'],
      ['In Review', 'Approved'],
      ['Approved', 'In Review'],
      ['Approved', 'Done'],
      ['Done', 'Approved'],
      ['Done', 'In Progress'],
    ];
  }
  // generic
  return [
    ['Todo', 'In Progress'],
    ['In Progress', 'Todo'],
    ['In Progress', 'Done'],
    ['Done', 'In Progress'],
  ];
}

/** Stable string key for a (from, to) edge — used as a Set member. */
export function transitionKey(from: string, to: string): string {
  return `${from}→${to}`;
}
