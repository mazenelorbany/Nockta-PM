// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';

import { TimeThisWeek } from './TimeThisWeek';

// =============================================================================
// TimeThisWeek — render test for the per-week worklog tile.
//
// The component is a pure-props weekly timer card: total time pill, optional
// target/progress bar, optional streak chip, and a seven-day bar chart that
// always renders Mon→Sun.
//
// What we pin:
//   1. Total time renders as "Hh MMm" (e.g. "2h 05m" — minutes zero-padded).
//   2. The seven weekday labels always render in order, even when byDay is
//      empty.
//   3. With no target, the "No worklog entries yet this week." copy renders
//      for an empty week.
//   4. With a target, the progressbar role surfaces with aria-valuenow
//      reflecting the rounded percent.
//   5. The streak chip renders when streakWeeks > 0 and hides at zero.
//   6. The hit-target message swaps to "You're at goal for the week." when
//      target.hit is true.
// =============================================================================

describe('TimeThisWeek', () => {
  it('renders total time as Hh MMm with zero-padded minutes', () => {
    const { getByText } = render(
      <TimeThisWeek totalSeconds={2 * 3600 + 5 * 60} byDay={[]} target={null} />,
    );
    expect(getByText(/2h 05m/)).toBeTruthy();
  });

  it('always renders all seven weekday labels in Mon→Sun order', () => {
    const { getByText } = render(
      <TimeThisWeek totalSeconds={0} byDay={[]} target={null} />,
    );
    for (const d of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']) {
      expect(getByText(d)).toBeTruthy();
    }
  });

  it('shows the "no worklog entries" copy for an empty week with no target', () => {
    const { getByText } = render(
      <TimeThisWeek totalSeconds={0} byDay={[]} target={null} />,
    );
    expect(getByText(/No worklog entries yet this week/i)).toBeTruthy();
  });

  it('switches to "Logged via timer" copy when seconds > 0 and no target', () => {
    const { getByText } = render(
      <TimeThisWeek totalSeconds={3600} byDay={[]} target={null} />,
    );
    expect(getByText(/Logged via timer/i)).toBeTruthy();
  });

  it('exposes a progressbar role when target is set, with correct aria-valuenow', () => {
    const { getByRole } = render(
      <TimeThisWeek
        totalSeconds={0}
        byDay={[]}
        target={{
          hours: 40,
          secondsLogged: 10 * 3600,
          secondsTarget: 40 * 3600,
          hit: false,
          streakWeeks: 0,
        }}
      />,
    );
    const bar = getByRole('progressbar');
    // 10 / 40 = 25%.
    expect(bar.getAttribute('aria-valuenow')).toBe('25');
    expect(bar.getAttribute('aria-valuemax')).toBe('100');
  });

  it('renders the streak chip when streakWeeks > 0', () => {
    const { getByText } = render(
      <TimeThisWeek
        totalSeconds={3600}
        byDay={[]}
        target={{
          hours: 40,
          secondsLogged: 40 * 3600,
          secondsTarget: 40 * 3600,
          hit: true,
          streakWeeks: 3,
        }}
      />,
    );
    expect(getByText(/3 wk streak/)).toBeTruthy();
  });

  it('hides the streak chip when streakWeeks is 0', () => {
    const { queryByText } = render(
      <TimeThisWeek
        totalSeconds={3600}
        byDay={[]}
        target={{
          hours: 40,
          secondsLogged: 10 * 3600,
          secondsTarget: 40 * 3600,
          hit: false,
          streakWeeks: 0,
        }}
      />,
    );
    expect(queryByText(/wk streak/)).toBeNull();
  });

  it('flips the helper copy to "at goal" when target.hit is true', () => {
    const { getByText } = render(
      <TimeThisWeek
        totalSeconds={40 * 3600}
        byDay={[]}
        target={{
          hours: 40,
          secondsLogged: 40 * 3600,
          secondsTarget: 40 * 3600,
          hit: true,
          streakWeeks: 1,
        }}
      />,
    );
    expect(getByText(/at goal for the week/i)).toBeTruthy();
  });

  it('renders the "/ Yh" trailing target label next to the total when target is set', () => {
    const { getByText } = render(
      <TimeThisWeek
        totalSeconds={5 * 3600}
        byDay={[]}
        target={{
          hours: 40,
          secondsLogged: 5 * 3600,
          secondsTarget: 40 * 3600,
          hit: false,
          streakWeeks: 0,
        }}
      />,
    );
    expect(getByText(/\/ 40h/)).toBeTruthy();
  });
});
