import { describe, expect, it } from 'vitest';
import {
  WORKFLOW_STATUSES,
  defaultStatusFor,
  doneStatusesFor,
  isValidStatusFor,
} from './workflow';

// =============================================================================
// Workflow gate — the smallest piece of the task pipeline and the one most
// likely to silently break (someone adds a new status to one preset but
// forgets to update the gate). Tests pin the contract: which presets exist,
// which transitions are accepted, what's terminal.
// =============================================================================

describe('workflow presets', () => {
  it('engineering preset includes the canonical 5 statuses in order', () => {
    expect(WORKFLOW_STATUSES.engineering).toEqual([
      'Todo',
      'In Progress',
      'In Review',
      'Testing',
      'Done',
    ]);
  });

  it('design preset substitutes Approved for Testing', () => {
    expect(WORKFLOW_STATUSES.design).toEqual([
      'Todo',
      'In Progress',
      'In Review',
      'Approved',
      'Done',
    ]);
  });

  it('generic preset is the smallest viable workflow', () => {
    expect(WORKFLOW_STATUSES.generic).toEqual(['Todo', 'In Progress', 'Done']);
  });
});

describe('isValidStatusFor', () => {
  it('accepts a status that exists in the preset', () => {
    expect(isValidStatusFor('engineering', 'In Review')).toBe(true);
    expect(isValidStatusFor('design', 'Approved')).toBe(true);
    expect(isValidStatusFor('generic', 'Todo')).toBe(true);
  });

  it('rejects a status from a different preset', () => {
    // Approved is design-only; engineering should reject it.
    expect(isValidStatusFor('engineering', 'Approved')).toBe(false);
    // Testing is engineering-only; design should reject it.
    expect(isValidStatusFor('design', 'Testing')).toBe(false);
    // Generic has the smallest set — In Review doesn't belong there.
    expect(isValidStatusFor('generic', 'In Review')).toBe(false);
  });

  it('rejects unknown statuses entirely', () => {
    expect(isValidStatusFor('engineering', 'NotAStatus')).toBe(false);
    expect(isValidStatusFor('engineering', '')).toBe(false);
  });

  it('is case-sensitive (status strings are canonical labels, not free-text)', () => {
    expect(isValidStatusFor('engineering', 'todo')).toBe(false);
    expect(isValidStatusFor('engineering', 'TODO')).toBe(false);
  });
});

describe('defaultStatusFor', () => {
  it('always returns the first status of the preset', () => {
    expect(defaultStatusFor('engineering')).toBe('Todo');
    expect(defaultStatusFor('design')).toBe('Todo');
    expect(defaultStatusFor('generic')).toBe('Todo');
  });
});

describe('doneStatusesFor — parent-completion gating', () => {
  it('engineering treats only Done as terminal', () => {
    expect(doneStatusesFor('engineering')).toEqual(['Done']);
  });

  it('design treats both Approved and Done as terminal', () => {
    // This is the subtle one: a design ticket can sit in Approved without
    // hitting Done. Both states block sub-task incompletion checks from
    // re-opening the parent.
    expect(doneStatusesFor('design')).toEqual(['Approved', 'Done']);
  });

  it('generic treats only Done as terminal', () => {
    expect(doneStatusesFor('generic')).toEqual(['Done']);
  });
});
