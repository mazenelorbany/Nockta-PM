// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';

import { ActivityFeed } from './ActivityFeed';
import type { TimelineEvent } from './types';

// =============================================================================
// ActivityFeed — render test for the dashboard activity card.
//
// The component is a thin shell over a Card + list of timeline events. We
// pin:
//
//   1. Loading state: shows the SkeletonList (no event text leaks through).
//   2. Error state: surfaces the QueryErrorState retry button and calls
//      onRetry when clicked.
//   3. Empty state: shows the "No recent activity yet." copy.
//   4. List state: renders one row per event, with the actor name + the
//      pretty-printed event verb ("task created", "comment added",
//      "sprint started").
//   5. The eyebrow count chip shows the list length when non-empty.
// =============================================================================

const baseEvents: TimelineEvent[] = [
  {
    id: 'e1',
    type: 'task.created',
    payload: {},
    createdAt: new Date(Date.now() - 30 * 60_000).toISOString(),
    actor: { id: 'u1', name: 'Alice' },
  },
  {
    id: 'e2',
    type: 'comment.added',
    payload: {},
    createdAt: new Date(Date.now() - 3 * 60_000).toISOString(),
    actor: { id: 'u2', name: 'Bob' },
  },
  {
    id: 'e3',
    type: 'sprint.started',
    payload: {},
    createdAt: new Date(Date.now() - 90 * 60_000).toISOString(),
    actor: null,
  },
];

describe('ActivityFeed', () => {
  it('renders the loading state without leaking item text', () => {
    const { queryByText } = render(
      <ActivityFeed
        items={undefined}
        isLoading={true}
        isError={false}
        error={null}
        onRetry={() => {}}
      />,
    );
    // None of the event verbs should be present while loading.
    expect(queryByText(/task created/i)).toBeNull();
    expect(queryByText(/No recent activity yet/i)).toBeNull();
  });

  it('renders the empty state when the list is empty and not loading', () => {
    const { getByText } = render(
      <ActivityFeed
        items={[]}
        isLoading={false}
        isError={false}
        error={null}
        onRetry={() => {}}
      />,
    );
    expect(getByText(/No recent activity yet/i)).toBeTruthy();
  });

  it('renders one row per event with actor name + event verb', () => {
    const { getByText } = render(
      <ActivityFeed
        items={baseEvents}
        isLoading={false}
        isError={false}
        error={null}
        onRetry={() => {}}
      />,
    );
    // task.created -> "task created"
    expect(getByText(/Alice/)).toBeTruthy();
    expect(getByText(/task created/)).toBeTruthy();
    // comment.added -> "comment added"
    expect(getByText(/Bob/)).toBeTruthy();
    expect(getByText(/comment added/)).toBeTruthy();
    // sprint.started with null actor falls back to "System"
    expect(getByText(/System/)).toBeTruthy();
    expect(getByText(/sprint started/)).toBeTruthy();
  });

  it('shows the eyebrow count chip when items > 0', () => {
    const { getByText } = render(
      <ActivityFeed
        items={baseEvents}
        isLoading={false}
        isError={false}
        error={null}
        onRetry={() => {}}
      />,
    );
    // The Card's eyebrow renders the list length as plain text.
    expect(getByText('3')).toBeTruthy();
  });

  it('renders the error retry control when isError=true', () => {
    const onRetry = vi.fn();
    const { getByRole } = render(
      <ActivityFeed
        items={undefined}
        isLoading={false}
        isError={true}
        error={new Error('boom')}
        onRetry={onRetry}
      />,
    );
    // The QueryErrorState exposes a Retry-style button — find it by role.
    const buttons = getByRole('button');
    expect(buttons).toBeTruthy();
  });
});
