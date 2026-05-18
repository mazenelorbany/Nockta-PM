// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';

import { StatStrip } from './StatStrip';

// =============================================================================
// StatStrip — render test for the dashboard "summary tiles" strip.
//
// The component is presentation-only: it receives four scalar counts and lays
// them out into the same four tiles every time. We pin:
//
//   1. All four counts surface in the rendered output (regression for the
//      classic "drop a prop on rename" bug).
//   2. Each label string ('Due today', 'Overdue', 'Blocked', 'In progress')
//      is rendered exactly once — the order of tiles is part of the contract
//      (it matches the visual urgency hierarchy).
//   3. Tone-driven color classes only apply when the count > 0 — zero values
//      use the default neutral tone so the tile doesn't shout at users who
//      have nothing to act on.
//
// Implementation note: we look up tone classes by walking up from the count
// number text node — the component splits each tile into "icon row" (label)
// + "value row" (count) and only the value row carries the tone class.
// =============================================================================

describe('StatStrip', () => {
  it('renders all four count values', () => {
    const { getByText } = render(
      <StatStrip dueToday={3} overdue={1} blocked={0} inProgress={5} />,
    );
    expect(getByText('3')).toBeTruthy();
    expect(getByText('1')).toBeTruthy();
    expect(getByText('0')).toBeTruthy();
    expect(getByText('5')).toBeTruthy();
  });

  it('renders the four label strings exactly once', () => {
    const { getAllByText } = render(
      <StatStrip dueToday={2} overdue={2} blocked={2} inProgress={2} />,
    );
    expect(getAllByText('Due today').length).toBe(1);
    expect(getAllByText('Overdue').length).toBe(1);
    expect(getAllByText('Blocked').length).toBe(1);
    expect(getAllByText('In progress').length).toBe(1);
  });

  it('applies the destructive tone when overdue > 0', () => {
    const { getByText } = render(
      <StatStrip dueToday={0} overdue={4} blocked={0} inProgress={0} />,
    );
    const overdueValue = getByText('4');
    expect(overdueValue.className).toContain('text-status-blocked');
  });

  it('does NOT apply the destructive tone when overdue is 0', () => {
    const { getAllByText } = render(
      <StatStrip dueToday={0} overdue={0} blocked={0} inProgress={0} />,
    );
    // Multiple "0"s — all should be in neutral state, none with the
    // status-blocked class.
    const zeros = getAllByText('0');
    expect(zeros.length).toBe(4);
    for (const zero of zeros) {
      expect(zero.className).not.toContain('text-status-blocked');
      expect(zero.className).not.toContain('text-priority-high');
      expect(zero.className).not.toContain('text-brand');
    }
  });

  it('applies the urgent (brand) tone when dueToday > 0', () => {
    const { getByText } = render(
      <StatStrip dueToday={2} overdue={0} blocked={0} inProgress={0} />,
    );
    expect(getByText('2').className).toContain('text-brand');
  });

  it('applies the warning tone when blocked > 0', () => {
    const { getByText } = render(
      <StatStrip dueToday={0} overdue={0} blocked={3} inProgress={0} />,
    );
    expect(getByText('3').className).toContain('text-priority-high');
  });

  it('does not tone the inProgress tile even when > 0 (it is neutral by design)', () => {
    const { getByText } = render(
      <StatStrip dueToday={0} overdue={0} blocked={0} inProgress={7} />,
    );
    const inProgress = getByText('7');
    expect(inProgress.className).not.toContain('text-status-blocked');
    expect(inProgress.className).not.toContain('text-priority-high');
    expect(inProgress.className).not.toContain('text-brand');
  });
});
