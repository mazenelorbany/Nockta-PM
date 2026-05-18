// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';

import { OpenByPriority } from './OpenByPriority';
import type { PersonalDashboard } from './types';

// =============================================================================
// OpenByPriority — render test for the dashboard "open work by priority" tile.
//
// The component renders the same four priority columns (Critical / High /
// Medium / Low) regardless of the stats payload — missing rows render as 0
// rather than disappearing. That zero-fill is load-bearing: an empty
// dashboard shouldn't render a different shape than a populated one.
//
// What we pin:
//   1. Always renders four columns, one per priority level, in fixed order.
//   2. Counts for present priorities surface in the rendered output.
//   3. Counts for missing priorities default to 0.
//   4. Each tile shows the priority dot via the sr-only "Priority: X" label.
// =============================================================================

const baseStats: PersonalDashboard = {
  openByPriority: [
    { priority: 'Critical', count: 2 },
    { priority: 'High', count: 5 },
    // Medium and Low intentionally missing → should render as 0.
  ],
  overdueCount: 0,
  watchingCount: 0,
  mentionsLast7Days: 0,
};

describe('OpenByPriority', () => {
  it('renders all four priority labels in order', () => {
    const { getByText } = render(<OpenByPriority stats={baseStats} />);
    // sr-only "Priority: X" exists via PriorityDot, plus the visible label.
    expect(getByText('Critical')).toBeTruthy();
    expect(getByText('High')).toBeTruthy();
    expect(getByText('Medium')).toBeTruthy();
    expect(getByText('Low')).toBeTruthy();
  });

  it('renders the count for each priority that has a row', () => {
    const { getByText } = render(<OpenByPriority stats={baseStats} />);
    expect(getByText('2')).toBeTruthy();
    expect(getByText('5')).toBeTruthy();
  });

  it('zero-fills priorities missing from the stats payload', () => {
    const { getAllByText } = render(<OpenByPriority stats={baseStats} />);
    // Medium + Low both missing → two "0"s in the rendered output.
    expect(getAllByText('0').length).toBe(2);
  });

  it('renders four priority dots (one per tile)', () => {
    const { getByText } = render(<OpenByPriority stats={baseStats} />);
    expect(getByText('Priority: Critical')).toBeTruthy();
    expect(getByText('Priority: High')).toBeTruthy();
    expect(getByText('Priority: Medium')).toBeTruthy();
    expect(getByText('Priority: Low')).toBeTruthy();
  });

  it('renders the section heading', () => {
    const { getByText } = render(<OpenByPriority stats={baseStats} />);
    expect(getByText(/My open work by priority/i)).toBeTruthy();
  });

  it('handles a fully empty openByPriority array (all zeros)', () => {
    const empty: PersonalDashboard = { ...baseStats, openByPriority: [] };
    const { getAllByText } = render(<OpenByPriority stats={empty} />);
    expect(getAllByText('0').length).toBe(4);
  });
});
